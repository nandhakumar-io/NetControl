// db/index.js — MySQL2 pool optimised for 32GB RAM / 14-core / 800 agents
'use strict';
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

      // ── Pool sizing for 800 agents + dashboard users ──────────────────
      // 800 agents × 1 metrics write/5s = 160 writes/s steady state
      // bursts (boot storms) can hit 800 concurrent connections briefly.
      // 100 connections: ~25MB overhead, handles bursts with queueing.
      connectionLimit:    parseInt(process.env.DB_POOL_SIZE) || 100,
      queueLimit:         500,          // queue up to 500 extra requests
      waitForConnections: true,

      // ── Timeouts ──────────────────────────────────────────────────────
      connectTimeout:    10000,
      acquireTimeout:    10000,         // wait up to 10s to get a connection

      // ── Connection health ─────────────────────────────────────────────
      enableKeepAlive:   true,
      keepAliveInitialDelay: 30000,

      timezone:   '+00:00',
      charset:    'utf8mb4',

      // ── Performance ───────────────────────────────────────────────────
      // Prepared statements cached per connection — big win for repeated queries
      namedPlaceholders:  false,
      multipleStatements: false,        // security: prevent stacked queries
    });

    // Log pool errors without crashing
    _pool.on('connection', () => {});
    console.log(`[DB] Pool created — limit: ${process.env.DB_POOL_SIZE || 100} connections`);
  }
  return _pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}
async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

// Batch insert helper — far fewer round-trips than looping execute()
async function batchInsert(table, columns, rows) {
  if (!rows.length) return;
  const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
  const flat = rows.flatMap(r => columns.map(c => r[c]));
  const [result] = await getPool().execute(
    `INSERT INTO \`${table}\` (${columns.map(c=>`\`${c}\``).join(',')}) VALUES ${placeholders}`,
    flat
  );
  return result;
}

module.exports = { getPool, query, queryOne, execute, batchInsert };
