// db/migrate-agent-canary.js — Canary rollout + rollback for agent self-update.
//
// Today (services/agentRelease.js) there is exactly one manifest and every
// agent that checks in gets told to update to it the instant an admin
// uploads a build — an all-or-nothing push with no way to test on a
// subset first or revert if it goes wrong. This adds:
//   agent_releases        — every uploaded build kept (not just "current"),
//                            so rollback means "point back at an old row"
//                            rather than "hope you still have the file"
//   agent_releases.rollout_percent — 0-100, deterministic per-device
//                            bucketing (hash of device id) decides who's
//                            in the rollout, so the same devices stay in
//                            the canary as the percentage increases rather
//                            than a random re-shuffle each check-in
//   devices.agent_update_health — last known-good/bad signal *after* an
//                            update, so a canary rollout can be paused
//                            automatically instead of just on a timer
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

async function tableExists(conn, name) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [name]
  );
  return r.length > 0;
}

async function colExists(conn, table, col) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, col]
  );
  return r.length > 0;
}

async function migrateAgentCanary() {
  const conn = await getConn();
  try {
    console.log('Running agent canary/rollback migration...');

    if (!(await tableExists(conn, 'agent_releases'))) {
      await conn.query(`
        CREATE TABLE agent_releases (
          id                CHAR(36)     PRIMARY KEY,
          version           VARCHAR(20)  NOT NULL,
          notes             TEXT,
          sha256            CHAR(64)     NOT NULL,
          storage_path      VARCHAR(255) NOT NULL COMMENT 'path under AGENT_RELEASE_DIR, e.g. releases/1.4.0.js',
          rollout_percent   TINYINT UNSIGNED NOT NULL DEFAULT 100
            COMMENT '0-100; what % of devices (by deterministic hash) are told to update to this version',
          status            ENUM('active','paused','rolled_back','superseded') NOT NULL DEFAULT 'active',
          uploaded_by       CHAR(36)     DEFAULT NULL,
          uploaded_at       INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          INDEX idx_releases_status (status),
          CONSTRAINT fk_release_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + agent_releases table created');
    }

    // devices.agent_update_health — set by the poller/check-in path after an
    // agent reports back on the version it just updated to. NULL = no
    // update in flight / nothing to report. This is what lets a canary
    // auto-pause instead of relying on an admin watching a dashboard.
    if (!(await colExists(conn, 'devices', 'agent_update_health'))) {
      await conn.query(`
        ALTER TABLE devices
        ADD COLUMN agent_update_health ENUM('pending','healthy','unhealthy') DEFAULT NULL
          COMMENT 'set after an agent update: healthy if it checked in normally afterward, unhealthy if it went offline or errored within the grace period'
      `);
      console.log('  + devices.agent_update_health');
    }
    if (!(await colExists(conn, 'devices', 'agent_updated_at'))) {
      await conn.query(`
        ALTER TABLE devices
        ADD COLUMN agent_updated_at INT UNSIGNED DEFAULT NULL
          COMMENT 'when this device last accepted a self-update, used to compute the post-update health grace window'
      `);
      console.log('  + devices.agent_updated_at');
    }

    // Backfill: if the old single-manifest release.json/netcontrol-agent.js
    // exists on disk (services/agentRelease.js's old format), migrate it
    // into agent_releases as the initial 100%-rollout row so upgrading an
    // existing install doesn't orphan the currently-deployed version.
    const { getManifest, getScriptBuffer } = (() => {
      try { return require('../services/agentRelease'); } catch { return {}; }
    })();
    if (getManifest) {
      const manifest = getManifest();
      const [existing] = manifest
        ? await conn.query('SELECT 1 FROM agent_releases WHERE version = ? LIMIT 1', [manifest.version])
        : [[]];
      if (manifest && existing.length === 0) {
        const { v4: uuidv4 } = require('uuid');
        await conn.query(
          `INSERT INTO agent_releases (id, version, notes, sha256, storage_path, rollout_percent, status, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?, 100, 'active', ?, ?)`,
          [uuidv4(), manifest.version, manifest.notes || '', manifest.sha256,
           'netcontrol-agent.js', manifest.uploaded_by, manifest.uploaded_at || Math.floor(Date.now() / 1000)]
        );
        console.log(`  + backfilled existing release v${manifest.version} into agent_releases`);
      }
    }

    console.log('Agent canary/rollback migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateAgentCanary().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { migrateAgentCanary };