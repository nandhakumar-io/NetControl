// db/migrate-agent-update-request.js — lets an admin queue an immediate
// agent self-update from the Devices page instead of waiting for the
// agent's own AUTO_UPDATE poll/cooldown cycle (see routes/devices.js's
// POST /bulk-agent-update and the agent's checkForUpdate()).
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

async function migrateAgentUpdateRequest() {
  const conn = await getConn();
  try {
    console.log('Running agent update request migration...');
    if (!(await colExists(conn, 'devices', 'agent_update_requested_at'))) {
      await conn.query('ALTER TABLE devices ADD COLUMN agent_update_requested_at BIGINT DEFAULT NULL');
      console.log('  + devices.agent_update_requested_at');
    }
    console.log('✅ Agent update request migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateAgentUpdateRequest().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateAgentUpdateRequest };