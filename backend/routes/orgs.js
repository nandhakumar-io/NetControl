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
    const [{ device_count }] = await query('SELECT COUNT(*) AS device_count FROM devices WHERE org_id = ?', [req.params.id]);
    res.json({
      device_count,
      device_limit: req.org.device_limit,
      plan: req.org.plan,
      over_limit: device_count > req.org.device_limit,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/orgs/:id/members ────────────────────────────────────────────────
router.get('/:id/members', requireOrgContext, async (req, res) => {
  try {
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
    await execute('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [req.params.id, req.params.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/orgs/:id — rename / change plan / device limit ─────────────────
router.put('/:id', requireOrgContext, requireOrgRole('admin'), async (req, res) => {
  try {
    const existing = req.org;
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

module.exports = router;