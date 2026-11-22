'use strict';
const fs = require('node:fs');
const path = require('node:path');
const configPath = path.join(__dirname, '..', '.env.mysql.json');
if (!fs.existsSync(configPath)) {
  console.error('Run npm run setup:mysql first.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
  if (typeof config[key] !== 'string') throw new Error('Invalid local MySQL configuration');
  process.env[key] = config[key];
}
require('../server');
