// db/migrate-alert-rule-tag-scope.js
//
// Adds alert_rules.tag — a third, independent way to scope a rule, alongside
// the existing device_id (one device) and group_id (one structural group).
// Tags (device_tags table, see migrate-alert-templates-and-tags.js) are
// freeform and cross-cutting — a device can carry several, regardless of
// which group it's structurally in — so "every device tagged prod" doesn't
// fit either existing column and needs its own.
//
// Same mutual-exclusivity rule as device_id/group_id: a rule sets exactly
// one of device_id / group_id / tag, or none for a fully global rule.
// Dynamic like group_id — tagging a device later automatically brings it
// under any rule already scoped to that tag, no rule edit needed.
//
// Safe to run repeatedly — checks for existence first.
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

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, column]
  );
  return r.length > 0;
}

async function tableExists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [table]
  );
  return r.length > 0;
}

async function migrateAlertRuleTagScope() {
  const conn = await getConn();
  try {
    if (!(await tableExists(conn, 'alert_rules'))) {
      console.log('  ⚠  alert_rules table not found — skipping');
      return;
    }
    if (!(await columnExists(conn, 'alert_rules', 'tag'))) {
      await conn.query(`ALTER TABLE alert_rules ADD COLUMN tag VARCHAR(50) DEFAULT NULL AFTER group_id`);
      await conn.query(`ALTER TABLE alert_rules ADD INDEX idx_alertrules_tag (tag)`);
      console.log('  + alert_rules.tag');
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateAlertRuleTagScope };

if (require.main === module) {
  migrateAlertRuleTagScope()
    .then(() => { console.log('✅ alert_rules.tag ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}