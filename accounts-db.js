'use strict';

const postgres = !!process.env.DATABASE_URL;
const configured = postgres || !!(process.env.MYSQL_HOST && process.env.MYSQL_DATABASE && process.env.MYSQL_USER);
let pool = null;

if (postgres) {
  const { Pool } = require('pg');
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  // Keep certificate verification under our control; URL SSL options override pg's ssl object.
  const sslDisabled = process.env.PG_SSL === 'false' || url.searchParams.get('sslmode') === 'disable';
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const nativePool = new Pool({
    connectionString: url.toString(), max: 4, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000, statement_timeout: 15000,
    ssl: sslDisabled ? false : {
      rejectUnauthorized: true,
      ...(process.env.PG_SSL_CA ? { ca: process.env.PG_SSL_CA.replace(/\\n/g, '\n') } : {})
    }
  });
  nativePool.on('error', error => console.error('PostgreSQL idle connection error:', error.code || 'connection error'));
  // All callers use fixed internal SQL. User values are passed separately as parameters.
  function postgresSql(sql) {
    let parameter = 0;
    return sql.replace(/(?<![\w.])game_(accounts|sessions|matches|match_players|profiles)\b/g, 'windward.$&')
      .replace(/\?/g, () => '$' + (++parameter));
  }
  function wrap(client, release) {
    async function execute(sql, values) {
      const result = await client.query(postgresSql(sql), values);
      return [result.fields?.length ? result.rows : { affectedRows: result.rowCount }];
    }
    return {
      execute, query: execute,
      beginTransaction: () => client.query('BEGIN'),
      commit: () => client.query('COMMIT'),
      rollback: () => client.query('ROLLBACK'),
      ...(release ? { release } : {})
    };
  }
  pool = {
    ...wrap(nativePool),
    async getConnection() {
      const client = await nativePool.connect();
      return wrap(client, () => client.release());
    },
    end: () => nativePool.end()
  };
} else if (configured) {
  pool = require('mysql2/promise').createPool({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, connectionLimit: 4, connectTimeout: 10000,
    charset: 'utf8mb4', timezone: 'Z',
    ssl: process.env.MYSQL_SSL === 'true' ? {
      rejectUnauthorized: true,
      ...(process.env.MYSQL_SSL_CA ? { ca: process.env.MYSQL_SSL_CA.replace(/\\n/g, '\n') } : {})
    } : undefined
  });
}

module.exports = { pool, configured, postgres };
