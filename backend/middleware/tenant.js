// middleware/tenant.js — resolves which organization (client) the current
// request is scoped to, for MSP-style multi-tenant use.
//
// Model: a user can be a member of multiple orgs (org_members), each with
// its own org_role. Exactly one org is "active" at a time per user
// (users.active_org_id) — that's what the frontend's "switch client"
// dropdown changes via POST /api/orgs/:id/switch. Every tenant-scoped route
// (devices, groups, schedules, alert rules, runbooks, audit log) filters by
// req.orgId, set here.
//
// Admins of the underlying NetControl instance (env ADMIN-seeded user) can
// optionally impersonate any org via `X-Org-Id` header for support/debugging
// without switching their own active org — but ONLY if they're actually a
// member of that org, so this can't be used to hop into a client's data
// without being granted access first.
const { queryOne } = require('../db');

async function requireOrgContext(req, res, next) {
  try {
    const headerOrgId = req.headers['x-org-id'];
    const orgId = headerOrgId || req.user?.activeOrgId;

    if (!orgId) {
      return res.status(400).json({
        error: 'No active organization selected.',
        code: 'NO_ACTIVE_ORG',
      });
    }

    const membership = await queryOne(
      'SELECT org_role FROM org_members WHERE org_id = ? AND user_id = ?',
      [orgId, req.user.id]
    );
    if (!membership) {
      return res.status(403).json({
        error: 'You are not a member of this organization.',
        code: 'NOT_ORG_MEMBER',
      });
    }

    const org = await queryOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (org.suspended) {
      return res.status(403).json({ error: 'This organization is suspended.', code: 'ORG_SUSPENDED' });
    }

    req.orgId = orgId;
    req.orgRole = membership.org_role; // per-org role, distinct from global req.user.role
    req.org = org;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * Middleware factory: restrict to specific per-org roles (admin/operator/viewer
 * within THIS org, not the user's global role). Global instance-admins still
 * pass everything via requireRole('admin') elsewhere; this is for
 * org-scoped actions like inviting members or deleting the org.
 */
function requireOrgRole(...roles) {
  return (req, res, next) => {
    if (!req.orgRole) return res.status(400).json({ error: 'No organization context' });
    if (req.user.role === 'admin') return next(); // instance admins bypass org-role checks
    if (!roles.includes(req.orgRole)) {
      return res.status(403).json({ error: 'Insufficient organization permissions', required: roles });
    }
    next();
  };
}

/**
 * SECURITY FIX (cross-tenant device access): resolves the org the current
 * request is acting in — same rule as requireOrgContext (X-Org-Id header if
 * present and the user is a member, else the user's active_org_id) — and
 * confirms the target device actually belongs to that org before any
 * power-action / exec / live-terminal code runs.
 *
 * This closes a gap where routes/actions.js, services/sshProxy.js, and
 * services/webTerminal.js checked `user_group_access` (an operator's group
 * grant) but never checked `devices.org_id` at all. Because global
 * `users.role` ('admin'/'operator'/'viewer') is an *instance-wide* role,
 * independent of per-org membership (`org_members.org_role`), any user who
 * is a global 'admin' — including someone who is only meant to be an admin
 * of their OWN client org in an MSP deployment — could wake/shutdown/
 * restart/run arbitrary commands on, or open a live shell into, ANY
 * device belonging to ANY other tenant, just by knowing/guessing its UUID.
 * Non-admin operators were bounded only by `user_group_access`, which is
 * also never cross-checked against org membership, so a stale or
 * mis-scoped group grant is a second way into another tenant's devices.
 *
 * Call this with the device row (must include org_id) after loading it,
 * before doing anything else with it. Throws with `.status` set so route
 * handlers can respond correctly.
 */
async function verifyDeviceOrgAccess(req, device) {
  if (!device) return; // 404 handling stays the caller's responsibility

  const headerOrgId = req.headers?.['x-org-id'];
  const orgId = headerOrgId || req.user?.activeOrgId;

  if (!orgId) {
    const err = new Error('No active organization selected.');
    err.status = 400; err.code = 'NO_ACTIVE_ORG';
    throw err;
  }

  const membership = await queryOne(
    'SELECT org_role FROM org_members WHERE org_id = ? AND user_id = ?',
    [orgId, req.user.id]
  );
  if (!membership) {
    const err = new Error('You are not a member of this organization.');
    err.status = 403; err.code = 'NOT_ORG_MEMBER';
    throw err;
  }

  // Pre-multi-tenant devices created before the org migration ran can have
  // a NULL org_id. Treat that as "belongs to no org you can reach" rather
  // than silently allowing it — an operator's fix is to assign the device
  // to an org, not to have every tenant implicitly see it.
  if (device.org_id !== orgId) {
    const err = new Error('Access denied to this device.');
    err.status = 403; err.code = 'DEVICE_WRONG_ORG';
    throw err;
  }

  req.orgId = orgId;
  req.orgRole = membership.org_role;
}

module.exports = { requireOrgContext, requireOrgRole, verifyDeviceOrgAccess };