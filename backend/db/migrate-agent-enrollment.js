// db/migrate-agent-enrollment.js — per-org agent enrollment tokens.
//
// THE BUG THIS FIXES: POST /api/metrics/register (see routes/metrics.js) was
// gated by a single global AGENT_REGISTRATION_SECRET env var shared by the
// whole install, with no way for the request to say which org a new device
// belongs to. Every newly-registered agent device was INSERTed with
// org_id = NULL. Every other device route (GET /api/devices, the approval
// endpoint, etc.) filters `WHERE org_id = ?` per the multi-tenant migration
// — so those devices were permanently invisible on the Devices page and its
// approval queue. Meanwhile POST /api/metrics (the actual metrics ingest)
// authenticates purely by agent_key_hash, which was set correctly and has
// no org filter at all, so metrics kept flowing into the dashboard/
// monitoring pages for a device nobody could see or approve.
//
// Fix: each organization gets its own enrollment token. Agents (or the
// install script that provisions them) are given their org's token instead
// of one shared secret, and POST /api/metrics/register resolves org_id from
// that token before creating the device row. See routes/metrics.js and
// routes/orgs.js (GET/POST .../enrollment-token) for the other half of this.
'use strict';
const path   = require('path');
const crypto = require('crypto');
const mysql  = require('mysql2/promise');
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

async function colExists(conn, table, col) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, col]
  );
  return r.length > 0;
}

function genToken() {
  return 'nce_' + crypto.randomBytes(24).toString('hex'); // "netcontrol enrollment"
}

async function migrateAgentEnrollment() {
  const conn = await getConn();
  try {
    console.log('Running agent enrollment token migration...');

    if (!(await colExists(conn, 'organizations', 'agent_enrollment_token'))) {
      await conn.query(
        'ALTER TABLE organizations ADD COLUMN agent_enrollment_token CHAR(52) DEFAULT NULL, ADD UNIQUE INDEX idx_org_enroll_token (agent_enrollment_token)'
      );
      console.log('  + organizations.agent_enrollment_token');
    }

    // Backfill: every org that doesn't have a token yet gets a freshly
    // generated one so agent enrollment works immediately after upgrade.
    const [orgs] = await conn.query('SELECT id FROM organizations WHERE agent_enrollment_token IS NULL');
    for (const org of orgs) {
      let token, collided;
      do {
        token = genToken();
        const [existing] = await conn.query('SELECT 1 FROM organizations WHERE agent_enrollment_token = ?', [token]);
        collided = existing.length > 0;
      } while (collided);
      await conn.query('UPDATE organizations SET agent_enrollment_token = ? WHERE id = ?', [token, org.id]);
    }
    if (orgs.length) console.log(`  + generated enrollment tokens for ${orgs.length} organization(s)`);

    // Any device that already slipped through with org_id NULL (the actual
    // bug this migration exists to fix) — assign it to whichever single
    // org already owns its group, if unambiguous, otherwise to the first/
    // default organization so it at least becomes visible again rather
    // than silently orphaned. Admins can move it afterward if it landed in
    // the wrong tenant.
    const [orphans] = await conn.query('SELECT id, group_id FROM devices WHERE org_id IS NULL');
    if (orphans.length) {
      const [defaultOrgRows] = await conn.query('SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1');
      const defaultOrgId = defaultOrgRows[0]?.id || null;
      for (const d of orphans) {
        let orgId = defaultOrgId;
        if (d.group_id) {
          const [g] = await conn.query('SELECT org_id FROM `groups` WHERE id = ?', [d.group_id]);
          if (g[0]?.org_id) orgId = g[0].org_id;
        }
        if (orgId) await conn.query('UPDATE devices SET org_id = ? WHERE id = ?', [orgId, d.id]);
      }
      console.log(`  + recovered ${orphans.length} orphaned (org_id IS NULL) device(s) — please verify they landed in the right organization`);
    }

    console.log('✅ Agent enrollment token migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateAgentEnrollment().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateAgentEnrollment };