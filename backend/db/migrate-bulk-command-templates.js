// db/migrate-bulk-command-templates.js — reusable "recipe" for the Bulk
// Command console: a saved (name, command, target device list) so a
// recurring one-off op (e.g. "Patch Tuesday reboot — branch office
// switches") can be loaded back with one click instead of re-picking
// devices and retyping the command every time.
//
// This is deliberately distinct from bulk_command_schedules
// (migrate-bulk-command-schedules.js): a schedule runs unattended on a
// cron expression, while a template is just a saved starting point for the
// interactive console — load it, optionally tweak the command or
// selection, confirm with the PIN, and run it like any other one-off.
// Many orgs want both: a template for "run this on demand, on the devices
// I usually target" and a schedule for "run this automatically every
// Tuesday at 2am." A template can also be promoted into a schedule later
// without retyping anything, since they share the same
// (command, device_ids, timeout_sec) shape.
//
// device_ids is a frozen snapshot captured at save time (JSON array), same
// convention as bulk_command_schedules.device_ids — a device removed after
// the template was saved just gets silently dropped/skipped on next use
// rather than the template quietly resizing to whatever the fleet
// currently looks like.
//
// Safe to run repeatedly — every step checks for existence first.
'use strict';
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function getConn() {
  return mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'netcontrol',
    multipleStatements: true,
    timezone: '+00:00',
  });
}

async function tableExists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [table]
  );
  return r.length > 0;
}

async function migrateBulkCommandTemplates() {
  const conn = await getConn();
  try {
    console.log('Running bulk-command-templates migration...');

    if (!(await tableExists(conn, 'bulk_command_templates'))) {
      await conn.query(`
        CREATE TABLE bulk_command_templates (
          id                   CHAR(36)      NOT NULL PRIMARY KEY,
          org_id               CHAR(36)      NOT NULL,
          name                 VARCHAR(100)  NOT NULL,
          description          VARCHAR(255)  DEFAULT NULL,
          command              TEXT          NOT NULL,
          device_ids           LONGTEXT      NOT NULL COMMENT 'JSON array of device UUIDs, snapshotted at save time',
          timeout_sec          SMALLINT UNSIGNED NOT NULL DEFAULT 30,
          use_count            INT UNSIGNED  NOT NULL DEFAULT 0,
          created_by           CHAR(36)      DEFAULT NULL,
          created_by_username  VARCHAR(255)  DEFAULT NULL,
          created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at         DATETIME      DEFAULT NULL,
          UNIQUE KEY uniq_org_name (org_id, name),
          INDEX idx_org_lastused (org_id, last_used_at),
          FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('  + bulk_command_templates');
    }

    console.log('✅ Bulk-command-templates migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateBulkCommandTemplates().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateBulkCommandTemplates };