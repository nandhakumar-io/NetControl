// db/migrate-agent-version.js — tracks which agent build each device is
// running, so the server can tell it "a newer version exists" (see
// services/agentRelease.js + routes/agentRelease.js) and so the Devices
// page can eventually show a per-device "update available" badge.
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

async function colExists(conn, table, col) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, col]
  );
  return r.length > 0;
}

async function migrateAgentVersion() {
  const conn = await getConn();
  try {
    console.log('Running agent version migration...');
    if (!(await colExists(conn, 'devices', 'agent_version'))) {
      await conn.query('ALTER TABLE devices ADD COLUMN agent_version VARCHAR(20) DEFAULT NULL');
      console.log('  + devices.agent_version');
    }
    console.log('✅ Agent version migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateAgentVersion().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateAgentVersion };