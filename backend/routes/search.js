// routes/search.js — GET /api/search?q=... backing the frontend's Cmd+K
// command palette. Fans a single query out across devices, groups,
// runbooks, schedules, and (admin only) users, each capped to a small
// number of results — this is a "jump to" tool, not a reporting endpoint,
// so breadth across categories matters more than exhaustiveness within one.
//
// Every category respects the same permission bits already used by that
// resource's own list route (see middleware/auth.js's bit map), so the
// palette never surfaces something a search on that page itself wouldn't
// have shown — no bypassing RBAC via a shortcut UI.
'use strict';
const express = require('express');
const { query: queryValidator, validationResult } = require('express-validator');
const { query } = require('../db');
const { requireAuth, requirePermission, ROLE_PERMISSIONS } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

const RESULT_LIMIT_PER_CATEGORY = 6;

function hasBit(req, bit) {
  const perms = ROLE_PERMISSIONS[req.user.role] !== undefined
    ? ROLE_PERMISSIONS[req.user.role]
    : (req.user.permissions || 0);
  return (perms & bit) !== 0;
}

router.get('/',
  queryValidator('q').trim().isLength({ min: 1, max: 100 }).withMessage('q is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    // Same '%like%' pattern as the existing per-page filters — this is a
    // "narrow down as you type" tool over a small per-org result set, not
    // full-text search over the whole instance, so a plain LIKE is plenty
    // and keeps this fast without adding a search index/dependency.
    const like = `%${req.query.q}%`;
    const tasks = [];
    const categories = {};

    // ── Devices (bit 1 — view_devices) ─────────────────────────────────────
    // Matches on name/IP as before, plus device_tags — so typing a freeform
    // label like "prod" or "k8s-node" jumps straight to every device
    // carrying it, the same ad-hoc slice the tag filter on the Devices page
    // gives you, just reachable from anywhere via Cmd+K.
    if (hasBit(req, 1)) {
      tasks.push(
        query(
          `SELECT d.id, d.name, d.ip_address, d.status,
                  (SELECT GROUP_CONCAT(dt2.tag ORDER BY dt2.tag SEPARATOR ', ')
                     FROM device_tags dt2 WHERE dt2.device_id = d.id) AS all_tags
             FROM devices d
             LEFT JOIN device_tags dt ON dt.device_id = d.id AND dt.tag LIKE ?
            WHERE d.org_id = ? AND (d.name LIKE ? OR d.ip_address LIKE ? OR dt.tag IS NOT NULL)
            GROUP BY d.id
            ORDER BY d.name LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
          [like, req.orgId, like, like]
        ).then(rows => { categories.devices = rows.map(d => ({
          id: d.id, label: d.name, sublabel: d.all_tags ? `${d.ip_address} · ${d.all_tags}` : d.ip_address, status: d.status,
          type: 'device', path: `/devices?highlight=${d.id}`,
        })); }).catch(() => { categories.devices = []; })
      );
    }

    // ── Groups (bit 8 — view_groups) ────────────────────────────────────────
    if (hasBit(req, 8)) {
      tasks.push(
        query(
          `SELECT id, name FROM \`groups\`
            WHERE org_id = ? AND name LIKE ?
            ORDER BY name LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
          [req.orgId, like]
        ).then(rows => { categories.groups = rows.map(g => ({
          id: g.id, label: g.name, sublabel: 'Group',
          type: 'group', path: `/groups?highlight=${g.id}`,
        })); }).catch(() => { categories.groups = []; })
      );
    }

    // ── Runbooks — no dedicated bit gates the list route itself (any org
    //    member can view runbooks; only creating/editing needs 32768), so
    //    match that same visibility here rather than inventing a stricter
    //    rule the runbooks page itself doesn't enforce. ────────────────────
    tasks.push(
      query(
        `SELECT id, name, os_type FROM runbook_actions
          WHERE org_id = ? AND name LIKE ?
          ORDER BY name LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
        [req.orgId, like]
      ).then(rows => { categories.runbooks = rows.map(r => ({
        id: r.id, label: r.name, sublabel: r.os_type,
        type: 'runbook', path: `/runbooks?highlight=${r.id}`,
      })); }).catch(() => { categories.runbooks = []; })
    );

    // ── Schedules (bit 32 — view_schedules) ─────────────────────────────────
    if (hasBit(req, 32)) {
      tasks.push(
        query(
          `SELECT id, name, action FROM schedules
            WHERE org_id = ? AND name LIKE ?
            ORDER BY name LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
          [req.orgId, like]
        ).then(rows => { categories.schedules = rows.map(s => ({
          id: s.id, label: s.name, sublabel: s.action,
          type: 'schedule', path: `/schedules?highlight=${s.id}`,
        })); }).catch(() => { categories.schedules = []; })
      );
    }

    // ── Alert rules — no dedicated view bit gates the list route itself
    //    (GET /api/alerts/rules only requires org context; only create/edit
    //    needs admin/operator), so match that same visibility here rather
    //    than inventing a stricter rule the alerts page itself doesn't
    //    enforce — gated on bit 1, same as the /alerts route itself. ────────
    if (hasBit(req, 1)) {
      tasks.push(
        query(
          `SELECT id, name, metric, severity FROM alert_rules
            WHERE org_id = ? AND name LIKE ?
            ORDER BY name LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
          [req.orgId, like]
        ).then(rows => { categories.alertRules = rows.map(a => ({
          id: a.id, label: a.name, sublabel: `${a.metric} · ${a.severity}`,
          type: 'alertRule', path: `/alerts?highlight=${a.id}`,
        })); }).catch(() => { categories.alertRules = []; })
      );
    }

    // ── Synthetic checks — same no-extra-bit visibility as its own list
    //    route (GET /api/synthetic-checks needs MANAGE_SYNTHETIC_CHECKS,
    //    so gate on that bit here too). ───────────────────────────────────────
    if (hasBit(req, 65536)) {
      tasks.push(
        query(
          `SELECT sc.id, sc.name, sc.check_type, sc.status, d.name AS device_name
             FROM synthetic_checks sc
             LEFT JOIN devices d ON d.id = sc.device_id
            WHERE sc.org_id = ? AND sc.name LIKE ?
            ORDER BY sc.name LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
          [req.orgId, like]
        ).then(rows => { categories.syntheticChecks = rows.map(c => ({
          id: c.id, label: c.name, sublabel: c.device_name ? `${c.check_type} · ${c.device_name}` : c.check_type,
          type: 'syntheticCheck', path: `/synthetic-checks?highlight=${c.id}`,
        })); }).catch(() => { categories.syntheticChecks = []; })
      );
    }

    // ── Bulk command templates — gated on bit 4, same as the
    //    /bulk-command route itself (RequirePermission bit={4} in App.jsx). ──
    if (hasBit(req, 4)) {
      tasks.push(
        query(
          `SELECT id, name, description FROM bulk_command_templates
            WHERE org_id = ? AND name LIKE ?
            ORDER BY name LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
          [req.orgId, like]
        ).then(rows => { categories.bulkTemplates = rows.map(t => ({
          id: t.id, label: t.name, sublabel: t.description || 'Bulk command template',
          type: 'bulkTemplate', path: `/bulk-command?highlight=${t.id}`,
        })); }).catch(() => { categories.bulkTemplates = []; })
      );
    }

    // ── Users — instance-wide, admin only, matches routes/users.js's own

    //    gating (requireRole('admin')), so this never leaks account names
    //    to non-admins the way the other categories are scoped by org. ─────
    if (req.user.role === 'admin') {
      tasks.push(
        query(
          `SELECT id, username, role FROM users
            WHERE username LIKE ?
            ORDER BY username LIMIT ${RESULT_LIMIT_PER_CATEGORY}`,
          [like]
        ).then(rows => { categories.users = rows.map(u => ({
          id: u.id, label: u.username, sublabel: u.role,
          type: 'user', path: `/users?highlight=${u.id}`,
        })); }).catch(() => { categories.users = []; })
      );
    }

    await Promise.all(tasks);
    res.json({ q: req.query.q, categories });
  }
);

module.exports = router;