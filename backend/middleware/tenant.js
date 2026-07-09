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

module.exports = { requireOrgContext, requireOrgRole };