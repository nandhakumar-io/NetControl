
// db/migrate-synthetic-checks.js — "Health Checks" (synthetic monitoring)
//
// SyntheticChecksPage.jsx (and its sidebar link) were fully built expecting
// GET/POST/PUT/DELETE /api/synthetic-checks + /:id/run + /:id/results, but
// none of that ever existed server-side — no table, no route, no runner.
// The nav link 404'd and the page (if reached directly) failed every call.
// This adds the two tables the feature needs; routes/syntheticChecks.js and
// services/syntheticCheckRunner.js provide the API and the periodic runner.
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

async function migrateSyntheticChecks() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS synthetic_checks (
        id                   CHAR(36)     PRIMARY KEY,
        org_id               CHAR(36)     DEFAULT NULL,
        device_id            CHAR(36)     NOT NULL,
        name                 VARCHAR(150) NOT NULL,
        check_type           ENUM('http','tcp','ssh_command') NOT NULL,
        config               JSON         NOT NULL,
        interval_seconds     INT UNSIGNED NOT NULL DEFAULT 60,
        timeout_ms           INT UNSIGNED NOT NULL DEFAULT 5000,
        failure_threshold    INT UNSIGNED NOT NULL DEFAULT 2,
        enabled              TINYINT(1)   NOT NULL DEFAULT 1,
        status               ENUM('unknown','healthy','unhealthy') NOT NULL DEFAULT 'unknown',
        consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
        last_run_at          INT UNSIGNED DEFAULT NULL,
        last_message         VARCHAR(500) DEFAULT NULL,
        created_at           INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        INDEX idx_synth_device  (device_id),
        INDEX idx_synth_org     (org_id),
        INDEX idx_synth_enabled (enabled),
        CONSTRAINT fk_synth_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS synthetic_check_results (
        id          CHAR(36)     PRIMARY KEY,
        check_id    CHAR(36)     NOT NULL,
        ts          INT UNSIGNED NOT NULL,
        success     TINYINT(1)   NOT NULL,
        latency_ms  INT UNSIGNED DEFAULT NULL,
        message     VARCHAR(500) DEFAULT NULL,
        INDEX idx_synthresults_check (check_id, ts),
        CONSTRAINT fk_synthresult_check FOREIGN KEY (check_id) REFERENCES synthetic_checks(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migrateSyntheticChecks };

if (require.main === module) {
  migrateSyntheticChecks()
    .then(() => { console.log('✅ synthetic_checks tables ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}