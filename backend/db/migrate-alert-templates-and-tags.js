// db/migrate-alert-templates-and-tags.js
//
// Two independent additions, bundled in one migration since both are small:
//
// 1. alert_rules.group_id — rules could previously only target ONE specific
//    device or be fully global (device_id IS NULL = every device in the
//    org). There was no middle ground, which is exactly what "enable this
//    rule for a whole group" (the rule-template one-click flow) needs.
//    Dynamic on purpose: a device added to the group later is automatically
//    covered, no re-enabling needed.
//
// 2. alert_rules.min_duration_sec — rules notified on the very first
//    breached poll. Some conditions (offline, sustained CPU) are only
//    interesting once they've persisted — a single 2-second CPU spike
//    shouldn't page anyone. NULL/0 preserves the old immediate-notify
//    behavior exactly; routes/alerts.js's evaluator only changes behavior
//    when a rule explicitly sets this.
//
// 3. device_tags — freeform ad-hoc labels (prod, needs-review, k8s-node)
//    independent of the structural group hierarchy, so people can slice the
//    fleet without moving devices between groups. Used by devices.js's
//    filtering, and surfaced in the Bulk Command / Backup device pickers.
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

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, column]
  );
  return r.length > 0;
}

async function addColumnIfMissing(conn, table, column, ddlFragment) {
  if (await columnExists(conn, table, column)) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddlFragment}`);
  console.log(`  + ${table}.${column}`);
}

async function migrateAlertTemplatesAndTags() {
  const conn = await getConn();
  try {
    console.log('Running alert-templates-and-tags migration...');

    if (await tableExists(conn, 'alert_rules')) {
      await addColumnIfMissing(
        conn, 'alert_rules', 'group_id',
        'group_id CHAR(36) DEFAULT NULL, ADD INDEX idx_alertrules_group (group_id)'
      );
      await addColumnIfMissing(
        conn, 'alert_rules', 'min_duration_sec',
        'min_duration_sec INT UNSIGNED DEFAULT 0'
      );
      // FK added separately (rather than inline on the ADD COLUMN above) so
      // a pre-existing group_id value from some other partial upgrade path
      // never blocks the column itself from being added.
      const [fkRows] = await conn.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='alert_rules' AND CONSTRAINT_NAME='fk_alertrule_group'`
      );
      if (!fkRows.length && await tableExists(conn, 'groups')) {
        try {
          await conn.query(
            `ALTER TABLE alert_rules ADD CONSTRAINT fk_alertrule_group
               FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE SET NULL`
          );
          console.log('  + fk_alertrule_group');
        } catch (e) {
          console.warn('  ⚠  fk_alertrule_group skipped:', e.message);
        }
      }
    } else {
      console.log('  ⚠  alert_rules table not found — skipping (run after the base migration)');
    }

    if (!(await tableExists(conn, 'device_tags'))) {
      await conn.query(`
        CREATE TABLE device_tags (
          id          CHAR(36)     NOT NULL PRIMARY KEY,
          device_id   CHAR(36)     NOT NULL,
          org_id      CHAR(36)     DEFAULT NULL,
          tag         VARCHAR(50)  NOT NULL,
          created_at  INT UNSIGNED NOT NULL,
          UNIQUE KEY uniq_device_tag (device_id, tag),
          INDEX idx_device_tags_org_tag (org_id, tag),
          CONSTRAINT fk_device_tags_device FOREIGN KEY (device_id)
            REFERENCES devices(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + device_tags table');
    }

    console.log('✅ Alert-templates-and-tags migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateAlertTemplatesAndTags().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateAlertTemplatesAndTags };