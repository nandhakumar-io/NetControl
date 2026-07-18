// db/migrate-audit-chain.js — tamper-evident hash chaining for audit_log.
//
// Each row's `hash` is a SHA-256 of its own fields concatenated with the
// *previous* row's hash (`prev_hash`) in the same chain. Altering or
// deleting any historical row breaks that row's hash AND every hash after
// it — so a verification pass (routes/audit.js's new GET /verify) can
// prove the log hasn't been tampered with, which is the whole point for
// compliance purposes (SOC2/ISO auditors specifically ask "how do you know
// this log wasn't edited after the fact").
//
// Chained per "scope" rather than one single global chain — org_id when
// present, or the literal string 'system' for org-less entries (a failed
// login for a username that doesn't exist, etc. — see services/audit.js's
// comment on why those stay org_id NULL). Per-scope chains mean an MSP's
// clients each get their own independently-verifiable chain, and mean
// inserts for different orgs never contend with each other.
//
// audit_log_chain_state holds exactly one row per scope: the hash and seq
// of that scope's most recent entry. services/audit.js locks that row
// (SELECT ... FOR UPDATE inside a transaction) before computing the next
// hash, so concurrent inserts from different cluster workers for the SAME
// scope serialize correctly instead of both reading the same "previous"
// hash and forking the chain.
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

async function colExists(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
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

async function migrateAuditChain() {
  const conn = await getConn();
  try {
    console.log('Running audit-chain migration...');

    if (!(await tableExists(conn, 'audit_log'))) {
      console.log('  ⚠  audit_log table not found — skipping');
      return;
    }

    // `seq` gives a strict, gap-free-per-scope insertion order to chain
    // against — `timestamp` alone isn't safe (two rows can share the same
    // second) and `id` is a random UUID with no ordering meaning.
    if (!(await colExists(conn, 'audit_log', 'seq'))) {
      await conn.query(`ALTER TABLE audit_log ADD COLUMN seq BIGINT UNSIGNED AUTO_INCREMENT UNIQUE`);
      console.log('  + audit_log.seq');
    }
    if (!(await colExists(conn, 'audit_log', 'prev_hash'))) {
      await conn.query(`ALTER TABLE audit_log ADD COLUMN prev_hash CHAR(64) DEFAULT NULL`);
      console.log('  + audit_log.prev_hash');
    }
    if (!(await colExists(conn, 'audit_log', 'hash'))) {
      await conn.query(`ALTER TABLE audit_log ADD COLUMN hash CHAR(64) DEFAULT NULL`);
      console.log('  + audit_log.hash');
    }

    if (!(await tableExists(conn, 'audit_log_chain_state'))) {
      await conn.query(`
        CREATE TABLE audit_log_chain_state (
          scope     VARCHAR(64) NOT NULL PRIMARY KEY,
          last_hash CHAR(64)    NOT NULL,
          last_seq  BIGINT UNSIGNED NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + audit_log_chain_state table');
    }

    // Rows written before this migration have hash/prev_hash = NULL —
    // they predate the tamper-evidence feature entirely and are left
    // alone rather than retroactively hashed (a retroactive hash would
    // create a false sense of having verified history that was never
    // actually protected). The verification endpoint treats the first
    // hashed row per scope as that scope's genesis, whatever its prev_hash.

    console.log('✅ Audit-chain migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateAuditChain().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateAuditChain };