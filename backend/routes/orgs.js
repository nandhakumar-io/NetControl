// routes/orgs.js — MSP "clients" (organizations/tenants).
//
// Lets a sysadmin who manages multiple customers see only one client's
// devices/alerts/schedules at a time (the "switch client" dropdown), while
// keeping every client's data completely isolated from the others.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute, getPool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireOrgContext, requireOrgRole } = require('../middleware/tenant');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'org';
}

// ── GET /api/orgs — every org this user belongs to, plus which is active ────
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT o.id, o.name, o.slug, o.plan, o.device_limit, o.suspended, m.org_role
         FROM organizations o
         JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = ?
        ORDER BY o.name`,
      [req.user.id]
    );
    res.json({ orgs: rows, active_org_id: req.user.activeOrgId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/orgs — create a new client org (any authenticated user can
//    spin up a new client; they become its org admin) ───────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, device_limit = 25, plan = 'trial' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const id = uuidv4();
    let slug = slugify(name);
    const clash = await queryOne('SELECT id FROM organizations WHERE slug = ?', [slug]);
    if (clash) slug = `${slug}-${id.slice(0, 6)}`;

    await execute(
      `INSERT INTO organizations (id, name, slug, plan, device_limit, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())`,
      [id, name.trim(), slug, plan, device_limit, req.user.id]
    );
    await execute(
      `INSERT INTO org_members (id, org_id, user_id, org_role, created_at) VALUES (?, ?, ?, 'admin', UNIX_TIMESTAMP())`,
      [uuidv4(), id, req.user.id]
    );

    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'create_org', targetType: 'organization', targetId: id,
      targetName: name, ipSource: req.realIp || req.ip, result: 'success' });

    res.status(201).json({ id, slug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/orgs/:id/switch — change which org is "active" for this user
//    (this is what the client-switcher dropdown calls) ──────────────────────
router.post('/:id/switch', async (req, res) => {
  try {
    const membership = await queryOne(
      'SELECT org_role FROM org_members WHERE org_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!membership) return res.status(403).json({ error: 'Not a member of this organization' });

    await execute('UPDATE users SET active_org_id = ? WHERE id = ?', [req.params.id, req.user.id]);
    const org = await queryOne('SELECT id, name, slug, plan FROM organizations WHERE id = ?', [req.params.id]);
    res.json({ ok: true, active_org: org, org_role: membership.org_role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orgs/:id/usage — device count vs. plan limit (billing/limits) ──
router.get('/:id/usage', requireOrgContext, async (req, res) => {
  try {
    if (req.orgId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    // req.org (from requireOrgContext) reflects the caller's own resolved
    // org; for the global-admin bypass path that can be a different org
    // than req.params.id, so re-fetch the actual target rather than
    // reporting the wrong org's plan/device_limit.
    const org = req.orgId === req.params.id ? req.org : await queryOne('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const [{ device_count }] = await query('SELECT COUNT(*) AS device_count FROM devices WHERE org_id = ?', [req.params.id]);
    res.json({
      device_count,
      device_limit: org.device_limit,
      plan: org.plan,
      over_limit: device_count > org.device_limit,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orgs/:id/members ────────────────────────────────────────────────
router.get('/:id/members', requireOrgContext, async (req, res) => {
  try {
    // SECURITY FIX: requireOrgContext only validates membership of req.orgId
    // (resolved from the X-Org-Id header or the caller's OWN active org) —
    // it never checks that req.orgId actually matches req.params.id. Every
    // route below queried by req.params.id directly, so a user who is a
    // member of ANY org (even a free trial org they made themselves) could
    // list the member roster of ANY OTHER org just by putting that org's id
    // in the URL; requireOrgContext's membership check would pass against
    // their own org while the query ran against the target org. Same rule
    // already used correctly by GET /:id/usage below.
    if (req.orgId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const rows = await query(
      `SELECT u.id, u.username, m.org_role, m.created_at
         FROM org_members m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? ORDER BY u.username`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/orgs/:id/members — invite an existing NetControl user into
//    this client org with a given org-scoped role ──────────────────────────
router.post('/:id/members', requireOrgContext, requireOrgRole('admin'), async (req, res) => {
  try {
    // SECURITY FIX (critical — cross-tenant privilege escalation): same gap
    // as GET /:id/members above, but far worse here. requireOrgRole('admin')
    // checks req.orgRole, which was derived from req.orgId (the caller's OWN
    // org via X-Org-Id/active_org_id) — NOT from req.params.id. An admin of
    // their own throwaway/trial org could call this with :id set to ANY
    // other org's UUID and a body naming themselves, and requireOrgRole
    // would happily pass (they're admin — of their own org), while the
    // INSERT below ran against the target org, granting them 'admin' there.
    // That's a full cross-tenant takeover of any org whose UUID is known.
    if (req.orgId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { username, org_role = 'operator' } = req.body;
    if (!['admin', 'operator', 'viewer'].includes(org_role)) {
      return res.status(400).json({ error: 'invalid org_role' });
    }
    const user = await queryOne('SELECT id FROM users WHERE username = ?', [username]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await execute(
      `INSERT INTO org_members (id, org_id, user_id, org_role, created_at) VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())
       ON DUPLICATE KEY UPDATE org_role = VALUES(org_role)`,
      [uuidv4(), req.params.id, user.id, org_role]
    );
    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'add_org_member', targetType: 'organization', targetId: req.params.id,
      targetName: username, ipSource: req.realIp || req.ip, result: 'success' });
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/orgs/:id/members/:userId ─────────────────────────────────────
router.delete('/:id/members/:userId', requireOrgContext, requireOrgRole('admin'), async (req, res) => {
  try {
    // SECURITY FIX: same class of bug as the routes above — verify the
    // target org in the URL actually matches the org membership/role that
    // was checked, so an admin of one org can't remove members from another.
    if (req.orgId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    await execute('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [req.params.id, req.params.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/orgs/:id — rename / change plan / device limit ─────────────────
router.put('/:id', requireOrgContext, requireOrgRole('admin'), async (req, res) => {
  try {
    // SECURITY FIX: same class of bug — without this, an admin of one org
    // could rename, replan, or change the device_limit of any other org by
    // id, since requireOrgRole('admin') only reflects the caller's own org.
    if (req.orgId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    // req.org (from requireOrgContext) reflects the CALLER's resolved org,
    // which only equals the target org when the check above passed via
    // req.orgId matching. For the global-admin bypass path they can differ,
    // so re-fetch the actual target explicitly rather than defaulting
    // possibly-omitted fields from the wrong org's row.
    const existing = req.orgId === req.params.id ? req.org : await queryOne('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Organization not found' });
    const { name = existing.name, plan = existing.plan, device_limit = existing.device_limit } = req.body;
    await execute('UPDATE organizations SET name = ?, plan = ?, device_limit = ? WHERE id = ?',
      [name, plan, device_limit, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/orgs/:id — instance-admin only, hard delete (cascades) ──────
// BUG FIX: this used to ONLY delete the `organizations` row. The comment
// above always claimed "(cascades)", but nothing actually did — org_id was
// added to devices/groups/schedules/etc. as a plain `ALTER TABLE ADD COLUMN`
// (see migrate-orgs.js), with no FK constraint, unlike org_members which
// has a real `ON DELETE CASCADE` FK. So deleting an org left every group,
// device, schedule, backup, etc. that belonged to it sitting in the DB with
// a now-dangling org_id — invisible to every org-scoped query (so they
// looked "gone" from the UI) but still fully present and still enforcing
// their constraints, e.g. groups.name's UNIQUE index (see groups table
// migration) blocking a NEW org from ever creating a group with the same
// name, and orphaned group_id references on devices making bulk-imported
// devices land in a group nothing could ever list again.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const orgId = req.params.id;
  const conn = await getPool().getConnection();
  try {
    const [existing] = await conn.execute('SELECT id FROM organizations WHERE id = ?', [orgId]);
    if (!existing.length) { conn.release(); return res.status(404).json({ error: 'Organization not found' }); }

    await conn.beginTransaction();

    // Every table that got an org_id column per migrate-orgs.js. Some are
    // conditional on optional features being installed, so check presence
    // first rather than assuming they all exist.
    const ORG_SCOPED_TABLES = [
      'schedules', 'discovery_scans', 'process_policies',
      'backup_schedules', 'log_export_schedules', 'backups',
      'backup_destinations', 'alert_rules', 'audit_log',
      'devices', 'groups',
    ];
    const [tableRows] = await conn.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
      [ORG_SCOPED_TABLES]
    );
    const present = new Set(tableRows.map(r => r.TABLE_NAME));

    for (const table of ORG_SCOPED_TABLES) {
      if (present.has(table)) {
        await conn.execute(`DELETE FROM \`${table}\` WHERE org_id = ?`, [orgId]);
      }
    }

    await conn.execute('DELETE FROM organizations WHERE id = ?', [orgId]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ── GET /api/orgs/:id/enrollment-token — the token this org's agents use
//    with POST /api/metrics/register (x-enrollment-token header) so newly
//    installed agents land in the right tenant. See
//    db/migrate-agent-enrollment.js for why this exists. ────────────────────
router.get('/:id/enrollment-token', requireOrgContext, requireOrgRole('admin'), async (req, res) => {
  try {
    // SECURITY FIX: same class of bug — without this, an admin of one org
    // could read the agent-enrollment token of any other org and use it to
    // enroll rogue agents into that org's device pool.
    if (req.orgId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const org = await queryOne('SELECT agent_enrollment_token FROM organizations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ enrollment_token: org.agent_enrollment_token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/orgs/:id/enrollment-token/regenerate — invalidate the old
//    token and issue a new one. Existing agents keep working (their own
//    per-device api_key from registration isn't affected) — only *new*
//    enrollments need the updated token. ────────────────────────────────────
router.post('/:id/enrollment-token/regenerate', requireOrgContext, requireOrgRole('admin'), async (req, res) => {
  try {
    // SECURITY FIX: same class of bug — without this, an admin of one org
    // could invalidate and replace another org's enrollment token, breaking
    // that org's agent enrollment (a denial-of-service against a tenant
    // that isn't even the caller's own).
    if (req.orgId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const crypto = require('crypto');
    let token, collided;
    do {
      token = 'nce_' + crypto.randomBytes(24).toString('hex');
      collided = !!(await queryOne('SELECT 1 FROM organizations WHERE agent_enrollment_token = ?', [token]));
    } while (collided);

    await execute('UPDATE organizations SET agent_enrollment_token = ? WHERE id = ?', [token, req.params.id]);

    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'regenerate_enrollment_token', targetType: 'organization', targetId: req.params.id,
      targetName: req.orgId === req.params.id ? req.org.name : req.params.id, ipSource: req.realIp || req.ip, result: 'success' });

    res.json({ enrollment_token: token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;