// db/migrate-seb-binding.js — devices.seb_match_key
//
// SEB connection tokens change every exam session, so they can't be stored.
// What IS stable is an identifier SEB Server reports for the client (machine
// name, fixed client address, ...). seb_match_key stores that value per device:
// when set, services/sebServer.js matches this device ONLY on it (explicit
// binding beats the IP/hostname heuristics, no silent fallback).
'use strict';
const path  = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function getConn() {
  return mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'netcontrol',
    timezone: '+00:00',
  });
}

async function migrateSebBinding() {
  const conn = await getConn();
  try {
    console.log('Running SEB binding migration...');
    const [c] = await conn.query(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devices' AND COLUMN_NAME='seb_match_key' LIMIT 1`);
    if (!c.length) {
      await conn.query(`ALTER TABLE devices ADD COLUMN seb_match_key VARCHAR(255) DEFAULT NULL`);
      console.log('  + devices.seb_match_key');
    }
    const [i] = await conn.query(
      `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devices' AND INDEX_NAME='idx_devices_seb_match_key' LIMIT 1`);
    if (!i.length) {
      await conn.query(`ALTER TABLE devices ADD INDEX idx_devices_seb_match_key (seb_match_key)`);
      console.log('  + idx_devices_seb_match_key');
    }
    console.log('✅ SEB binding migration complete.');
  } finally { await conn.end(); }
}

module.exports = { migrateSebBinding };

if (require.main === module) {
  migrateSebBinding().then(() => process.exit(0)).catch(err => { console.error('Migration failed:', err); process.exit(1); });
}