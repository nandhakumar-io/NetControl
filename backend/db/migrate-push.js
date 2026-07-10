// db/migrate-push.js — Web Push subscriptions + alert snooze support
//
// Backs the mobile-friendly alert triage feature:
//  - push_subscriptions: one row per browser/device endpoint a user has
//    opted into push on (a user can have several — phone + laptop, etc).
//    Standard PushSubscription shape (endpoint + p256dh/auth keys) so it
//    drops straight into the `web-push` npm library used by
//    services/webPush.js.
//  - alert_triggered_log.snoozed_until: lets a one-tap "Snooze 1h" action
//    from a push notification suppress re-notification/escalation for that
//    specific breach without fully acknowledging it (see routes/alerts.js
//    POST /triggered/:id/snooze and the escalation check in evaluateAlerts).
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
    multipleStatements: true,
    timezone: '+00:00',
  });
}

async function migratePushTables() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id           CHAR(36)      NOT NULL PRIMARY KEY,
        user_id      CHAR(36)      NOT NULL,
        endpoint     VARCHAR(1000) NOT NULL,
        p256dh       VARCHAR(255)  NOT NULL,
        auth         VARCHAR(255)  NOT NULL,
        user_agent   VARCHAR(255)  DEFAULT NULL,
        created_at   INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        last_used_at INT UNSIGNED  DEFAULT NULL,
        UNIQUE KEY uq_push_endpoint (endpoint(500)),
        INDEX idx_push_user (user_id),
        CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      SET @s1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_triggered_log' AND COLUMN_NAME = 'snoozed_until');
      SET @sqls1 = IF(@s1 = 0, 'ALTER TABLE alert_triggered_log ADD COLUMN snoozed_until INT UNSIGNED DEFAULT NULL', 'SELECT 1');
      PREPARE stmts1 FROM @sqls1; EXECUTE stmts1; DEALLOCATE PREPARE stmts1;

      SET @s2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_triggered_log' AND COLUMN_NAME = 'snoozed_by');
      SET @sqls2 = IF(@s2 = 0, 'ALTER TABLE alert_triggered_log ADD COLUMN snoozed_by CHAR(36) DEFAULT NULL', 'SELECT 1');
      PREPARE stmts2 FROM @sqls2; EXECUTE stmts2; DEALLOCATE PREPARE stmts2;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migratePushTables };

if (require.main === module) {
  migratePushTables()
    .then(() => { console.log('✅ push_subscriptions + snooze columns ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}
