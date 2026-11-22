'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { pool, configured, postgres } = require('./accounts-db');
const scrypt = promisify(crypto.scrypt);
const SESSION_SECONDS = 30 * 24 * 60 * 60;

let ready;
function initialize() {
  if (!pool) return Promise.reject(new Error('DATABASE_NOT_CONFIGURED'));
  if (!ready) ready = migrate().catch(error => { ready = null; throw error; });
  return ready;
}
async function migrate() {
  if (postgres) {
    const fs = require('node:fs');
    const path = require('node:path');
    await pool.query(fs.readFileSync(path.join(__dirname, 'sql', 'postgres.sql'), 'utf8'));
    return;
  }
  const definitions = [
    `CREATE TABLE IF NOT EXISTS game_profiles (
      account_id CHAR(36) PRIMARY KEY,
      avatar TEXT NOT NULL,
      bio VARCHAR(120) NOT NULL,
      settings TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS game_accounts (
      id CHAR(36) PRIMARY KEY,
      username VARCHAR(24) NOT NULL UNIQUE,
      display_name VARCHAR(32) NOT NULL,
      password_hash VARCHAR(192) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS game_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      account_id CHAR(36) NOT NULL,
      expires_at BIGINT NOT NULL,
      INDEX session_account (account_id),
      INDEX session_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS game_matches (
      id CHAR(36) PRIMARY KEY,
      mode VARCHAR(12) NOT NULL,
      winner INT NOT NULL,
      duration_seconds INT NOT NULL,
      finished_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS game_match_players (
      match_id CHAR(36) NOT NULL,
      slot INT NOT NULL,
      account_id CHAR(36),
      player_name VARCHAR(32) NOT NULL,
      PRIMARY KEY (match_id, slot),
      INDEX player_history (account_id, match_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];
  for (const sql of definitions) await pool.query(sql);
}
function publicUser(row) {
  let settings={};try{settings=JSON.parse(row.settings||'{}');}catch{}
  return { id: row.id, username: row.username, name: row.display_name,avatar:row.avatar||'compass:mint',bio:row.bio||'',createdAt:row.created_at,settings };
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function sessionToken(req) {
  return (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('windward_session='))?.slice(17);
}
async function identify(req) {
  const token = sessionToken(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token) || !pool) return null;
  await initialize();
  const [rows] = await pool.execute(
    'SELECT a.id, a.username, a.display_name, a.created_at, p.avatar, p.bio, p.settings FROM game_sessions s JOIN game_accounts a ON a.id=s.account_id LEFT JOIN game_profiles p ON p.account_id=a.id WHERE s.token_hash=? AND s.expires_at>?',
    [tokenHash(token), Date.now()]
  );
  return rows[0] ? publicUser(rows[0]) : null;
}
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return salt + ':' + key.toString('hex');
}
async function verifyPassword(password, stored) {
  const salt = stored?.split(':')[0] || '00000000000000000000000000000000';
  const computed = await hashPassword(password, salt);
  const expected = Buffer.from(stored || salt + ':' + '0'.repeat(128));
  const actual = Buffer.from(computed);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
async function createSession(user, req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const previous = sessionToken(req);
  await pool.execute('INSERT INTO game_sessions (token_hash,account_id,expires_at) VALUES (?,?,?)', [
    tokenHash(token), user.id, Date.now() + SESSION_SECONDS * 1000
  ]);
  if (previous && /^[a-f0-9]{64}$/.test(previous)) {
    await pool.execute('DELETE FROM game_sessions WHERE token_hash=?', [tokenHash(previous)]);
  }
  await pool.execute('DELETE FROM game_sessions WHERE expires_at<?', [Date.now()]);
  const secure = process.env.RENDER || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `windward_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`);
}
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readJson(req,limit=4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('資料過長。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('請輸入正確資料。'), { status: 400 }); }
}
const attempts = new Map();
function checkRate(req) {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.expires < now) attempts.delete(key);
  // Render provides the client IP through its proxy. Direct local servers use the socket address.
  const ip = process.env.RENDER
    ? req.headers['x-forwarded-for']?.split(',').at(-1)?.trim() || req.socket.remoteAddress
    : req.socket.remoteAddress;
  const entry = attempts.get(ip) || { count: 0, expires: now + 60000 };
  if (++entry.count > 12 || attempts.size > 10000) {
    throw Object.assign(new Error('操作太頻繁，請稍後再試。'), { status: 429 });
  }
  attempts.set(ip, entry);
}
async function history(userId) {
  const [rows] = await pool.execute(
    `SELECT m.id,m.mode,m.winner,m.duration_seconds,m.finished_at,p.slot,
      opponent.player_name AS opponent
      FROM game_match_players p JOIN game_matches m ON p.match_id=m.id
      JOIN game_match_players opponent ON opponent.match_id=m.id AND opponent.slot<>p.slot
      WHERE p.account_id=? ORDER BY m.finished_at DESC,m.id DESC LIMIT 50`, [userId]
  );
  const [totals] = await pool.execute(
    `SELECT COUNT(*) AS played,
      COALESCE(SUM(CASE WHEN m.winner=p.slot THEN 1 ELSE 0 END),0) AS wins,
      COALESCE(SUM(CASE WHEN m.winner>=0 AND m.winner<>p.slot THEN 1 ELSE 0 END),0) AS losses,
      COALESCE(SUM(CASE WHEN m.winner=-1 THEN 1 ELSE 0 END),0) AS draws
      FROM game_match_players p JOIN game_matches m ON p.match_id=m.id WHERE p.account_id=?`, [userId]
  );
  return {
    totals: Object.fromEntries(Object.entries(totals[0]).map(([key, value]) => [key, Number(value)])),
    matches: rows.map(row => ({
      id: row.id, mode: row.mode, opponent: row.opponent,
      result: row.winner < 0 ? 'draw' : row.winner === row.slot ? 'win' : 'loss',
      duration: row.duration_seconds, finishedAt: Number(row.finished_at)
    }))
  };
}
async function handle(req, res, pathname) {
  if (!pathname.startsWith('/api/')) return false;
  try {
    if (req.method === 'GET' && pathname === '/api/account') {
      if (configured) await initialize();
      const user = await identify(req);
      sendJson(res, 200, { user, available: configured });
      return true;
    }
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '請從遊戲頁面操作。' }); return true; }
    if (pathname === '/api/history' && req.method === 'GET') {
      const user = await identify(req);
      if (!user) { sendJson(res, 401, { error: '請先登入查看戰績。' }); return true; }
      sendJson(res, 200, await history(user.id));
      return true;
    }
    if (req.method !== 'POST') { sendJson(res, 404, { error: '找不到這個功能。' }); return true; }
    if (pathname === '/api/profile') {
      const user=await identify(req);
      if(!user){sendJson(res,401,{error:'請先登入再儲存個人資訊。'});return true;}
      checkRate(req);
      const input=await readJson(req,70000);
      const name=typeof input?.name==='string'?input.name.trim():'';
      const bio=typeof input?.bio==='string'?input.bio.trim():'';
      const avatar=input?.avatar;
      const preset=typeof avatar==='string'&&/^(compass|sword|shield|crown|leaf|anchor):(mint|blue|rose|gold|violet)$/.test(avatar);
      const uploaded=typeof avatar==='string'&&avatar.length<=60000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar);
      const settings=input?.settings;
      if(!name||name.length>16||/[<>\x00-\x1f]/.test(name)||bio.length>120||/[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(bio)||(!preset&&!uploaded)||!settings||
        typeof settings.reduceMotion!=='boolean'||typeof settings.showIncome!=='boolean'||![.7,1,1.4].includes(settings.cameraSpeed)||![.75,1,1.25].includes(settings.startZoom)){
        sendJson(res,400,{error:'請確認名稱、頭像及設定格式；名稱最多16字，自介最多120字。'});return true;
      }
      const normalized={reduceMotion:settings.reduceMotion,showIncome:settings.showIncome,cameraSpeed:settings.cameraSpeed,startZoom:settings.startZoom};
      const conn=await pool.getConnection();
      try{
        await conn.beginTransaction();
        await conn.execute('UPDATE game_accounts SET display_name=? WHERE id=?',[name,user.id]);
        const sql=postgres?'INSERT INTO game_profiles (account_id,avatar,bio,settings) VALUES (?,?,?,?) ON CONFLICT (account_id) DO UPDATE SET avatar=EXCLUDED.avatar,bio=EXCLUDED.bio,settings=EXCLUDED.settings':'INSERT INTO game_profiles (account_id,avatar,bio,settings) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE avatar=VALUES(avatar),bio=VALUES(bio),settings=VALUES(settings)';
        await conn.execute(sql,[user.id,avatar,bio,JSON.stringify(normalized)]);
        await conn.commit();
      }catch(error){await conn.rollback();throw error;}finally{conn.release();}
      sendJson(res,200,{user:{...user,name,bio,avatar,settings:normalized}});return true;
    }
    if (pathname === '/api/logout') {
      const token = sessionToken(req);
      if (token && pool) {
        await initialize();
        await pool.execute('DELETE FROM game_sessions WHERE token_hash=?', [tokenHash(token)]);
      }
      const secure = process.env.RENDER || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `windward_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (!['/api/login', '/api/register'].includes(pathname)) { sendJson(res, 404, { error: '找不到這個功能。' }); return true; }
    checkRate(req);
    await initialize();
    const input = await readJson(req);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      sendJson(res, 400, { error: '請輸入正確資料。' });
      return true;
    }
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = input.password;
    if (!/^[a-z0-9_]{3,24}$/.test(username) || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      sendJson(res, 400, { error: '帳號需為 3–24 位英數或底線，密碼需為 8–128 位。' });
      return true;
    }
    let user;
    if (pathname === '/api/register') {
      const name = typeof input.name === 'string' ? input.name.trim().replace(/[<>\x00-\x1f]/g, '').slice(0, 16) : username;
      const id = crypto.randomUUID();
      const passwordHash = await hashPassword(password);
      try {
        await pool.execute('INSERT INTO game_accounts (id,username,display_name,password_hash) VALUES (?,?,?,?)', [
          id, username, name || username, passwordHash
        ]);
      } catch (error) {
        if (!['ER_DUP_ENTRY', '23505'].includes(error.code)) throw error;
        sendJson(res, 409, { error: '這個帳號已有人使用。' });
        return true;
      }
      user = { id, username, name: name || username };
    } else {
      const [rows] = await pool.execute('SELECT a.*, p.avatar, p.bio, p.settings FROM game_accounts a LEFT JOIN game_profiles p ON p.account_id=a.id WHERE a.username=?', [username]);
      const valid = await verifyPassword(password, rows[0]?.password_hash);
      if (!rows[0] || !valid) { sendJson(res, 401, { error: '帳號或密碼錯誤。' }); return true; }
      user = publicUser(rows[0]);
    }
    await createSession(user, req, res);
    sendJson(res, 200, { user, available: true });
  } catch (error) {
    if (error.status) sendJson(res, error.status, { error: error.message });
    else {
      const reason=error.code || (error.message==='DATABASE_NOT_CONFIGURED'?'DATABASE_NOT_CONFIGURED':'database error');
      console.error('Account request failed:', reason);
      sendJson(res, 503, { error: configured ? '帳號服務暫時無法連線，請稍後重試。' : '帳號資料庫尚未連接，可先以訪客開始遊戲。' });
    }
  }
  return true;
}
async function recordMatch(match) {
  if (!configured || !match.players.some(player => player.id)) return;
  await initialize();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [insert] = await connection.execute(
      postgres
        ? 'INSERT INTO game_matches (id,mode,winner,duration_seconds,finished_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
        : 'INSERT IGNORE INTO game_matches (id,mode,winner,duration_seconds,finished_at) VALUES (?,?,?,?,?)',
      [match.id, match.mode, match.winner, Math.floor(match.duration), match.finishedAt]
    );
    if (insert.affectedRows) {
      for (let slot = 0; slot < match.players.length; slot++) {
        const player = match.players[slot];
        await connection.execute('INSERT INTO game_match_players (match_id,slot,account_id,player_name) VALUES (?,?,?,?)', [
          match.id, slot, player.id || null, player.name
        ]);
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
module.exports = { handle, identify, sameOrigin, initialize, configured, recordMatch, pool, hashPassword, verifyPassword };
