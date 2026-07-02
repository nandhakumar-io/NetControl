// db/migrate-discovery.js — Network discovery tables (scans + results)
// Uses its own plain mysql2 connection so it can be called from migrate.js
// without spinning up the full 100-connection pool. Mirrors migrate-security.js.
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

async function migrateDiscoveryTables() {
  const conn = await getConn();
  try {
    // ── Scan jobs ────────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS discovery_scans (
        id              CHAR(36)     NOT NULL PRIMARY KEY,
        name            VARCHAR(100) NOT NULL,
        cidr            VARCHAR(50)  NOT NULL COMMENT 'Target range, e.g. 192.168.1.0/24',
        methods         TEXT         NOT NULL COMMENT 'JSON array: ping|snmp|nmap|lldp_cdp',
        snmp_communities TEXT        DEFAULT NULL COMMENT 'Encrypted JSON array of community strings',
        nmap_options    TEXT         DEFAULT NULL COMMENT 'JSON: {ports, osDetection, serviceDetection}',
        status          VARCHAR(20)  NOT NULL DEFAULT 'queued' COMMENT 'queued|running|completed|cancelled|failed',
        total_hosts     INT UNSIGNED NOT NULL DEFAULT 0,
        scanned_hosts   INT UNSIGNED NOT NULL DEFAULT 0,
        alive_hosts     INT UNSIGNED NOT NULL DEFAULT 0,
        error           TEXT         DEFAULT NULL,
        cancel_requested TINYINT(1)  NOT NULL DEFAULT 0,
        created_by      CHAR(36)     DEFAULT NULL,
        created_at      INT UNSIGNED NOT NULL,
        started_at      INT UNSIGNED DEFAULT NULL,
        finished_at     INT UNSIGNED DEFAULT NULL,
        INDEX idx_dscan_status (status),
        INDEX idx_dscan_created (created_at),
        CONSTRAINT fk_dscan_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Discovered hosts ─────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS discovery_results (
        id                CHAR(36)     NOT NULL PRIMARY KEY,
        scan_id           CHAR(36)     NOT NULL,
        ip_address        VARCHAR(45)  NOT NULL,
        mac_address       VARCHAR(17)  DEFAULT NULL,
        hostname          VARCHAR(255) DEFAULT NULL,
        vendor            VARCHAR(150) DEFAULT NULL COMMENT 'MAC OUI vendor match',
        os_guess          VARCHAR(100) DEFAULT NULL,
        response_time_ms  SMALLINT UNSIGNED DEFAULT NULL,
        open_ports        TEXT         DEFAULT NULL COMMENT 'JSON array [{port,proto,service}]',
        snmp_sysdescr     TEXT         DEFAULT NULL,
        snmp_sysname      VARCHAR(255) DEFAULT NULL,
        snmp_sysobjectid  VARCHAR(255) DEFAULT NULL,
        neighbors         TEXT         DEFAULT NULL COMMENT 'JSON array of LLDP/CDP neighbor entries',
        discovered_via    TEXT         NOT NULL COMMENT 'JSON array: which methods found this host',
        imported          TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 once added to devices table',
        device_id         CHAR(36)     DEFAULT NULL COMMENT 'Set once imported',
        discovered_at     INT UNSIGNED NOT NULL,
        UNIQUE KEY uq_dres_scan_ip (scan_id, ip_address),
        INDEX idx_dres_scan (scan_id),
        INDEX idx_dres_mac  (mac_address),
        CONSTRAINT fk_dres_scan FOREIGN KEY (scan_id) REFERENCES discovery_scans(id) ON DELETE CASCADE,
        CONSTRAINT fk_dres_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('[DB] ✅ Discovery tables (discovery_scans, discovery_results) ready');
  } finally {
    try { await conn.end(); } catch {}
  }
}

module.exports = { migrateDiscoveryTables };