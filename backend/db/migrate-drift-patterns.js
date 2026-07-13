// db/migrate-drift-patterns.js — Known-bad pattern matching for config drift
//
// Builds on the compliance_snapshots/baselines system in migrate-compliance.js.
// That system already detects *that* something changed (drift) and reports it
// at a flat 'warning' severity. This adds the ability to say *which* changes
// actually matter: a rule like "a firewall DROP/REJECT rule was removed" or
// "sshd stopped running" should page someone immediately, while "a package
// version bumped" shouldn't. Real orgs drown in low-signal compliance emails
// otherwise and stop reading them — which is worse than not having the
// feature at all.
//
// Patterns are matched against the added/removed line sets already computed
// by complianceService.diffList()/diffFiles() for each snapshot's diff — no
// new collection logic needed, just a rule layer on top of data already
// gathered every check.
'use strict';
const path  = require('path');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
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

async function migrateDriftPatterns() {
  const conn = await getConn();
  try {
    // org_id NULL = a built-in/global pattern, visible to and matched for
    // every org (seeded below). org_id set = an org-specific pattern an
    // admin added themselves, same NULL-means-global convention already
    // used elsewhere (e.g. webhooks with no org scoping historically).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS compliance_drift_patterns (
        id                    CHAR(36)     NOT NULL PRIMARY KEY,
        org_id                CHAR(36)     DEFAULT NULL,
        label                 VARCHAR(150) NOT NULL,
        category              ENUM('packages','services','firewall_rules','files') NOT NULL,
        match_type            ENUM('added','removed') NOT NULL COMMENT 'whether the pattern is checked against newly-added or newly-removed lines',
        pattern               VARCHAR(500) NOT NULL COMMENT 'JS RegExp source, case-insensitive',
        severity              ENUM('critical','warning') NOT NULL DEFAULT 'critical',
        auto_revert_runbook_id CHAR(36)    DEFAULT NULL COMMENT 'if set and severity=critical, this runbook is auto-triggered against the drifted device the same way alerts.js auto-runs runbooks for alert rules',
        enabled               TINYINT(1)   NOT NULL DEFAULT 1,
        created_by            CHAR(36)     DEFAULT NULL,
        created_at            INT UNSIGNED NOT NULL,
        INDEX idx_drift_patterns_org (org_id),
        INDEX idx_drift_patterns_category (category),
        CONSTRAINT fk_drift_patterns_runbook FOREIGN KEY (auto_revert_runbook_id)
          REFERENCES runbook_actions(id) ON DELETE SET NULL,
        CONSTRAINT fk_drift_patterns_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Records exactly what fired on a given snapshot — separate from
    // compliance_snapshots.diff (the raw data) so the UI can show "this
    // drift matched 2 known-bad patterns" without re-running the regex
    // match against history every page load, and so a later change to a
    // pattern's severity/enabled state doesn't silently rewrite past events.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS compliance_drift_matches (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        snapshot_id   CHAR(36)     NOT NULL,
        pattern_id    CHAR(36)     DEFAULT NULL COMMENT 'NULL if the pattern was later deleted',
        pattern_label VARCHAR(150) NOT NULL COMMENT 'copied at match time so deleting the pattern later does not blank out history',
        category      VARCHAR(20)  NOT NULL,
        match_type    VARCHAR(10)  NOT NULL,
        matched_line  VARCHAR(500) NOT NULL,
        severity      VARCHAR(10)  NOT NULL,
        auto_reverted TINYINT(1)   NOT NULL DEFAULT 0,
        revert_result TEXT         DEFAULT NULL,
        created_at    INT UNSIGNED NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES compliance_snapshots(id) ON DELETE CASCADE,
        INDEX idx_drift_matches_snapshot (snapshot_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Seed a handful of sensible, generic defaults (global — org_id NULL) so
    // the feature does something useful out of the box instead of shipping
    // as an empty table nobody knows to populate. Idempotent: only insert if
    // the table is completely empty, so re-running migrate.js never
    // resurrects a default an admin deliberately deleted or disabled.
    const [[{ c }]] = await conn.query(`SELECT COUNT(*) AS c FROM compliance_drift_patterns`);
    if (c === 0) {
      const now = Math.floor(Date.now() / 1000);
      const defaults = [
        ['Firewall DROP/REJECT rule removed', 'firewall_rules', 'removed', '\\b(DROP|REJECT)\\b', 'critical'],
        ['Broad allow-all firewall rule added', 'firewall_rules', 'added', '(0\\.0\\.0\\.0/0.*ACCEPT|ACCEPT.*0\\.0\\.0\\.0/0)', 'critical'],
        ['SSH daemon stopped', 'services', 'removed', '^sshd?(\\.service)?$', 'critical'],
        ['Intrusion/brute-force protection stopped', 'services', 'removed', '^(fail2ban|auditd)(\\.service)?$', 'critical'],
        ['Logging service stopped', 'services', 'removed', '^(rsyslog|syslog-ng)(\\.service)?$', 'warning'],
      ];
      for (const [label, category, match_type, pattern, severity] of defaults) {
        await conn.query(
          `INSERT INTO compliance_drift_patterns
             (id, org_id, label, category, match_type, pattern, severity, enabled, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?)`,
          [uuidv4(), label, category, match_type, pattern, severity, now]
        );
      }
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateDriftPatterns };

if (require.main === module) {
  migrateDriftPatterns()
    .then(() => { console.log('✅ compliance_drift_patterns ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}