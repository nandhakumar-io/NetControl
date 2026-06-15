#!/usr/bin/env node
// db/migrate-bruteforce.js — Brute-force IP ban tables
// Run: node db/migrate-bruteforce.js
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'netcontrol',
    timezone: '+00:00',
  });
  console.log('Running brute-force migration…\n');

  // ip_bans — active and historical bans
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ip_bans (
      id           CHAR(36)     NOT NULL PRIMARY KEY,
      ip           VARCHAR(50)  NOT NULL,
      reason       VARCHAR(500) NOT NULL,
      attempts     INT UNSIGNED NOT NULL DEFAULT 0,
      duration_sec INT UNSIGNED NOT NULL DEFAULT 300,
      created_at   INT UNSIGNED NOT NULL,
      expires_at   INT UNSIGNED NOT NULL,
      lifted_at    INT UNSIGNED DEFAULT NULL,
      lifted_by    CHAR(36)     DEFAULT NULL,
      INDEX idx_bans_ip      (ip),
      INDEX idx_bans_expires (expires_at),
      INDEX idx_bans_active  (expires_at, lifted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('  ✓ table ip_bans');

  // ip_ban_log — raw attempt log (for audit / admin view)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ip_ban_log (
      id           CHAR(36)     NOT NULL PRIMARY KEY,
      ip           VARCHAR(50)  NOT NULL,
      username     VARCHAR(100) DEFAULT NULL,
      attempted_at INT UNSIGNED NOT NULL,
      INDEX idx_banlog_ip   (ip),
      INDEX idx_banlog_time (attempted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('  ✓ table ip_ban_log');

  console.log('\n✅ Brute-force migration complete.\n');
  await conn.end();
}

run().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
