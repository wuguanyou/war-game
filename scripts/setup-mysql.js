'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const configPath = path.join(__dirname, '..', '.env.mysql.json');

async function main() {
  const repair = process.argv.includes('--repair');
  if (!repair && fs.existsSync(configPath)) throw Object.assign(new Error(), { code: 'CONFIG_ALREADY_EXISTS' });
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
  }
  const admin = JSON.parse(input.replace(/^\uFEFF/, ''));
  const config = {
    MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '3306', MYSQL_DATABASE: 'windward_game',
    MYSQL_USER: 'windward_' + crypto.randomBytes(6).toString('hex'),
    MYSQL_PASSWORD: crypto.randomBytes(32).toString('base64url')
  };
  const connection = await mysql.createConnection({
    host: config.MYSQL_HOST, port: 3306, user: admin.user, password: admin.password, connectTimeout: 10000
  });
  admin.password = '';
  input = '';
  try {
    await connection.query('CREATE DATABASE IF NOT EXISTS `windward_game` CHARACTER SET utf8mb4');
    // Only local connections; the game never receives administrator credentials.
    await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [config.MYSQL_USER, 'localhost', config.MYSQL_PASSWORD]);
    await connection.query('GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON `windward_game`.* TO ?@?', [config.MYSQL_USER, 'localhost']);
  } finally { await connection.end(); }
  Object.assign(process.env, config);
  const accounts = require('../accounts');
  try { await accounts.initialize(); }
  finally { await accounts.pool.end(); }
  const serialized = JSON.stringify(config, null, 2) + '\n';
  if (repair) {
    const temporary = configPath + '.tmp-' + crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    try {
      if (fs.existsSync(configPath)) fs.copyFileSync(configPath, configPath + '.backup-' + Date.now());
      fs.renameSync(temporary, configPath);
    } finally { fs.rmSync(temporary, { force: true }); }
  } else {
    fs.writeFileSync(configPath, serialized, { flag: 'wx', mode: 0o600 });
  }
  console.log('MySQL ready: game database, dedicated local user and account/history tables verified.');
  console.log('Start the local game: npm run start:local');
}
main().catch(error => {
  console.error('MySQL setup failed:', error.code || 'SETUP_ERROR');
  if (error.code === 'ER_ACCESS_DENIED_ERROR') console.error('Check the MySQL administrator username and password.');
  if (error.code === 'CONFIG_ALREADY_EXISTS') console.error('Local configuration already exists. Run npm run start:local.');
  process.exitCode = 1;
});
