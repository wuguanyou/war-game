'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { PGlite } = require('@electric-sql/pglite');

test('PostgreSQL account lifecycle, private schema and atomic match history', async () => {
  const engine = await PGlite.create();
  let poolOptions;
  let acquired = 0;
  let released = 0;
  const query = async (sql, values) => {
    if (values === undefined && sql.includes(';')) {
      await engine.exec(sql);
      return { fields: [], rowCount: 0 };
    }
    const result = await engine.query(sql, values);
    return { rows: result.rows, fields: result.fields, rowCount: result.affectedRows };
  };
  class Pool {
    constructor(options) { poolOptions = options; }
    on() {}
    query(sql, values) { return query(sql, values); }
    async connect() {
      acquired++;
      return { query, release() { released++; } };
    }
    async end() {}
  }
  const root = path.resolve(__dirname, '..');
  const fakeProcess = { env: { DATABASE_URL: 'postgres://test:test@db.example/game?sslmode=require', PG_SSL_CA: 'test-ca' } };
  function load(file, extraRequire) {
    const module = { exports: {} };
    const run = vm.runInNewContext('(function(require,module,exports,__dirname){' + fs.readFileSync(path.join(root, file), 'utf8') + '\n})', {
      process: fakeProcess, Buffer, URL, console
    });
    run(name => extraRequire?.(name) || require(name), module, module.exports, root);
    return module.exports;
  }
  const database = load('accounts-db.js', name => name === 'pg' ? { Pool } : null);
  const accounts = load('accounts.js', name => name === './accounts-db' ? database : null);
  async function api(url, body, cookie) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', headers: { host: 'game.test', origin: 'http://game.test', cookie }, socket: { remoteAddress: 'test' } });
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await accounts.handle(req, res, url);
    return res;
  }
  try {
    assert.equal(database.postgres, true);
    assert.equal(poolOptions.ssl.rejectUnauthorized, true);
    assert.equal(poolOptions.ssl.ca, 'test-ca');
    assert(!poolOptions.connectionString.includes('sslmode'));
    assert.equal((await api('/api/account')).body.available, true);
    assert.equal((await engine.query("SELECT to_regclass('public.game_accounts') AS name")).rows[0].name, null);
    const password = 'test-password-only';
    const registration = await api('/api/register', { username: 'player_one', password, name: "島嶼 O'Reilly" });
    assert.equal(registration.status, 200);
    const user = registration.body.user;
    const cookie = registration.headers['Set-Cookie'].split(';')[0];
    assert(registration.headers['Set-Cookie'].includes('HttpOnly'));
    assert.equal((await api('/api/register', { username: 'player_one', password })).status, 409);
    assert.equal((await api('/api/login', { username: 'player_one', password: 'wrong-password' })).status, 401);
    assert.equal((await api('/api/login', { username: 'player_one', password })).status, 200);
    assert.equal((await api('/api/account', undefined, cookie)).body.user.name, "島嶼 O'Reilly");
    assert.equal((await api('/api/history', undefined, cookie)).body.totals.played, 0);
    const profile={name:'海風領航員',bio:'守護群島',avatar:'anchor:blue',settings:{reduceMotion:true,showIncome:false,cameraSpeed:1.4,startZoom:1.25}};
    assert.equal((await api('/api/profile',profile)).status,401);
    assert.equal((await api('/api/profile',{...profile,avatar:'javascript:alert(1)'},cookie)).status,400);
    assert.equal((await api('/api/profile',{...profile,name:'<script>'},cookie)).status,400);
    assert.equal((await api('/api/profile',{...profile,settings:{...profile.settings,cameraSpeed:999}},cookie)).status,400);
    const saved=await api('/api/profile',profile,cookie);assert.equal(saved.status,200);
    const persisted=(await api('/api/account',undefined,cookie)).body.user;
    assert.equal(persisted.name,profile.name);assert.equal(persisted.avatar,profile.avatar);assert.equal(persisted.bio,profile.bio);
    assert.deepEqual(persisted.settings,profile.settings);assert.equal(persisted.username,'player_one');assert.ok(persisted.createdAt);
    const second=await api('/api/register',{username:'player_two',password,name:'另一位指揮官'});
    assert.equal(second.status,200);
    const secondCookie=second.headers['Set-Cookie'].split(';')[0];
    assert.equal((await api('/api/account',undefined,secondCookie)).body.user.avatar,'compass:mint');
    assert.equal((await engine.query("SELECT to_regclass('public.game_profiles') AS name")).rows[0].name,null);
    assert.equal((await api('/api/profile',{...profile,name:'另一名領航員',id:user.id},secondCookie)).status,200);
    assert.equal((await api('/api/account',undefined,cookie)).body.user.name,profile.name);
    const avatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=';
    assert.equal((await api('/api/profile',{...profile,avatar},cookie)).status,200);
    assert.equal((await api('/api/account',undefined,cookie)).body.user.avatar,avatar);
    assert.equal((await api('/api/profile',{...profile,avatar:'x'.repeat(71000)},cookie)).status,413);
    for (const winner of [0, 1, -1]) {
      const match = { id: crypto.randomUUID(), mode: 'ai', winner, duration: 125.9, finishedAt: Date.now(), players: [{ id: user.id, name: user.name }, { id: null, name: '對手' }] };
      await accounts.recordMatch(match);
      await accounts.recordMatch(match);
    }
    const history = (await api('/api/history', undefined, cookie)).body;
    assert.deepEqual(history.totals, { played: 3, wins: 1, losses: 1, draws: 1 });
    assert.equal(history.matches.length, 3);
    assert(history.matches.every(m => m.duration === 125 && m.opponent === '對手'));
    const brokenId = crypto.randomUUID();
    await assert.rejects(accounts.recordMatch({ id: brokenId, mode: 'pvp', winner: 0, duration: 10, finishedAt: Date.now(), players: [{ id: user.id, name: user.name }, { id: null, name: null }] }));
    assert.equal((await engine.query('SELECT COUNT(*)::int AS n FROM windward.game_matches WHERE id=$1', [brokenId])).rows[0].n, 0);
    assert.equal((await engine.query('SELECT COUNT(*)::int AS n FROM windward.game_match_players WHERE match_id=$1', [brokenId])).rows[0].n, 0);
    assert.equal(acquired, released);
    assert.equal((await api('/api/logout', {}, cookie)).status, 200);
    assert.equal((await api('/api/history', undefined, cookie)).status, 401);
  } finally { await engine.close(); }
});
