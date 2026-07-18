// db/migrate-notification-prefs.js — Per-user notification preferences.
//
// Previously every admin got every in-app notification (alert_notifications)
// and every mobile push (services/webPush.js) for every triggered alert /
// capacity warning, with no way to opt down. This adds a per-user severity
// threshold + channel on/off + a "mute for N hours" snooze, checked by
// services/notificationPrefs.js before routes/alerts.js's notifyAdmins()
// and services/capacityForecast.js fan out.
//
// Deliberately does NOT touch services/webhook.js — webhooks (Slack/Teams/
// Telegram/generic) are org-level integration channels an admin configures
// once for the whole team, not a personal notification setting. This is
// about the two channels that are inherently personal: the in-app bell and
// this user's own phone/browser push subscriptions.
//
// Safe to run repeatedly — CREATE TABLE IF NOT EXISTS.
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

async function migrateNotificationPrefs() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_notification_prefs (
        user_id             CHAR(36)     NOT NULL PRIMARY KEY,
        in_app_enabled      TINYINT(1)   NOT NULL DEFAULT 1,
        in_app_min_severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
        push_enabled        TINYINT(1)   NOT NULL DEFAULT 1,
        push_min_severity   ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
        muted_until         INT UNSIGNED DEFAULT NULL COMMENT 'both channels suppressed until this unix ts ("mute for 2h" etc)',
        updated_at          INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        CONSTRAINT fk_notif_prefs_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migrateNotificationPrefs };

if (require.main === module) {
  migrateNotificationPrefs()
    .then(() => { console.log('✅ user_notification_prefs table ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}