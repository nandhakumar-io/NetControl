// db/migrate-digest.js — Scheduled digest reports (device health + alerts +
// compliance drift + backup status), delivered via the existing webhook
// fanout and/or optional email.
//
// Deliberately reuses infrastructure that already exists rather than adding
// its own delivery mechanism: webhook.fire('digest.weekly', ...) goes through
// the same subscription/severity-gating/retry-logging path every other event
// in this app already uses (see services/webhook.js) — an admin just adds a
// webhook subscribed to 'digest.weekly' the same way they would for
// 'alert.triggered'. Email is the one genuinely new piece of infrastructure
// (see services/mailer.js), and is entirely optional — a schedule with no
// email_recipients set just fires the webhook.
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

async function migrateDigestTables() {
  const conn = await getConn();
  try {
    // ── Schedules ────────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS digest_schedules (
        id                  CHAR(36)      NOT NULL PRIMARY KEY,
        name                VARCHAR(100)  NOT NULL,
        cron_expr           VARCHAR(100)  NOT NULL DEFAULT '0 8 * * 1' COMMENT 'default: Monday 08:00',
        enabled             TINYINT(1)    NOT NULL DEFAULT 1,
        period_days         SMALLINT UNSIGNED NOT NULL DEFAULT 7 COMMENT 'lookback window the digest summarizes',
        email_recipients    TEXT          DEFAULT NULL COMMENT 'comma-separated addresses; NULL/empty = webhook-only',
        created_by          CHAR(36)      DEFAULT NULL,
        created_by_name     VARCHAR(100)  DEFAULT NULL,
        created_at          INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        last_run            INT UNSIGNED  DEFAULT NULL,
        last_status         ENUM('success','failure') DEFAULT NULL,
        last_error          TEXT          DEFAULT NULL,
        consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        INDEX idx_digest_schedules_enabled (enabled),
        CONSTRAINT fk_digest_sched_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // ── History — every compiled digest, so the frontend can show past
    //    reports rather than only "what would today's look like". `summary`
    //    is the full structured data (device/alert/compliance/backup
    //    counts) as JSON, so rendering doesn't need to be redone to review
    //    an old digest. ─────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS digest_log (
        id              CHAR(36)      NOT NULL PRIMARY KEY,
        schedule_id     CHAR(36)      DEFAULT NULL COMMENT 'NULL = ad-hoc/manual run not tied to a saved schedule',
        schedule_name   VARCHAR(100)  DEFAULT NULL,
        period_start    INT UNSIGNED  NOT NULL,
        period_end      INT UNSIGNED  NOT NULL,
        summary         LONGTEXT      NOT NULL COMMENT 'JSON: {devices, alerts, compliance, backups}',
        webhook_sent    TINYINT(1)    NOT NULL DEFAULT 0,
        email_sent      TINYINT(1)    NOT NULL DEFAULT 0,
        email_error     TEXT          DEFAULT NULL,
        generated_at    INT UNSIGNED  NOT NULL,
        INDEX idx_digest_log_schedule (schedule_id),
        INDEX idx_digest_log_time     (generated_at),
        CONSTRAINT fk_digest_log_sched FOREIGN KEY (schedule_id)
          REFERENCES digest_schedules(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migrateDigestTables };

if (require.main === module) {
  migrateDigestTables()
    .then(() => { console.log('✅ digest_schedules + digest_log tables ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}1