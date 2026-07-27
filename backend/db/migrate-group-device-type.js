// db/migrate-group-device-type.js — groups.device_type, so the topology
// map can render a site's hub node as whatever it actually is (router,
// switch, firewall, access point, server) instead of hardcoding "Site
// Router" for every group. Defaults every existing group to 'router' to
// preserve current behavior for anyone who hasn't set this yet — nothing
// changes visually until an admin explicitly picks a different type.
'use strict';
const path  = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Keep this list in sync with the DEVICE_TYPES map in routes/groups.js and
// the picker options in frontend/src/pages/GroupsPage.jsx's GroupFormModal.
const DEVICE_TYPES = ['router', 'switch', 'firewall', 'access_point', 'server', 'other'];

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

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, column]
  );
  return r.length > 0;
}

async function migrateGroupDeviceType() {
  const conn = await getConn();
  try {
    console.log('Running group device-type migration...');
    if (!(await columnExists(conn, 'groups', 'device_type'))) {
      await conn.query(
        `ALTER TABLE \`groups\`
         ADD COLUMN device_type ENUM(${DEVICE_TYPES.map(t => `'${t}'`).join(',')})
           NOT NULL DEFAULT 'router'
           AFTER description`
      );
      console.log('  + groups.device_type (defaults existing rows to "router")');
    }
    console.log('✅ Group device-type migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateGroupDeviceType().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateGroupDeviceType, DEVICE_TYPES };