// db/migrate-ssh-host-keys.js — adds devices.ssh_host_key_fingerprint
//
// SECURITY FIX: every SSH connection in this app (services/ssh.js,
// remoteBrowse.js, sshProxy.js) used `hostVerifier: () => true`, accepting
// ANY host key unconditionally — equivalent to always answering "yes" to
// the "authenticity of host can't be established" prompt, with no way to
// ever notice if it changes. That means a man-in-the-middle anywhere on the
// path to a managed device (ARP spoofing on the LAN, a compromised switch,
// DNS hijack) could intercept SSH credentials and command output silently,
// forever, with no signal to the operator.
//
// Fix: trust-on-first-use (TOFU) host key pinning, the same model any SSH
// client's known_hosts file implements. The first successful connection to
// a device records the server's host key fingerprint here; every
// subsequent connection compares against it and refuses to proceed (rather
// than silently trusting) if it's ever different, surfacing as a clear
// "host key changed" error instead of a silent MITM.
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

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].c > 0;
}

async function migrateSshHostKeys() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'devices', 'ssh_host_key_fingerprint'))) {
      await conn.query(
        `ALTER TABLE devices ADD COLUMN ssh_host_key_fingerprint VARCHAR(128) DEFAULT NULL AFTER ssh_key`
      );
      console.log('[Migrate] Added devices.ssh_host_key_fingerprint');
    } else {
      console.log('[Migrate] devices.ssh_host_key_fingerprint already exists — skipping add');
    }
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateSshHostKeys()
    .then(() => { console.log('[Migrate] ssh_host_key_fingerprint migration complete'); process.exit(0); })
    .catch(e => { console.error('[Migrate] Failed:', e.message); process.exit(1); });
}

module.exports = { migrateSshHostKeys };