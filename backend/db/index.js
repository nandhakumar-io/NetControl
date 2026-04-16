// db/index.js — MySQL2 connection pool singleton
const mysql = require('mysql2/promise');
require('dotenv').config();

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = mysql.createPool({
      host:               process.env.DB_HOST     || 'localhost',
      port:               parseInt(process.env.DB_PORT) || 3306,
      user:               process.env.DB_USER     || 'netcontrol',
      password:           process.env.DB_PASSWORD,
      database:           process.env.DB_NAME     || 'netcontrol',
      waitForConnections: true,
      connectionLimit:    10,
      queueLimit:         0,
      timezone:           '+00:00',       // always store UTC
      charset:            'utf8mb4',
    });
  }
  return _pool;
}

/**
 * Convenience wrapper — run a query and return all rows.
 * Usage: const rows = await query('SELECT * FROM devices WHERE id = ?', [id]);
 */
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/**
 * Run a query and return only the first row (or null).
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Run an INSERT / UPDATE / DELETE and return the ResultSetHeader.
 */
async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

module.exports = { getPool, query, queryOne, execute };


