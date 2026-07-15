// routes/savedViews.js — named, reusable filter combos for list pages
// (DevicesPage, AuditPage). Same org-scoped "everyone on the team sees it"
// pattern as bulk_command_history, generalized across pages via a `page`
// discriminator + an opaque JSON `filters` blob — see migrate-saved-views.js
// for the full rationale.
//
// Read-only bar: any authenticated org member can list/use views (it's a
// filter shortcut, not a privileged action). Only create/delete are gated
// — same requireRole('admin','operator') bar the rest of the org's
// shared/team-wide config uses (schedules, runbooks, etc.) — so a viewer
// can't spam the shared list with junk views, but everyone benefits from
// the ones the team maintains.
'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, query: queryValidator, validationResult } = require('express-validator');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

const PAGES = ['devices', 'audit'];

// ── GET /api/saved-views?page=devices — list, most-recently-used first ────────
router.get('/',
  [queryValidator('page').isIn(PAGES)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const rows = await query(
        `SELECT id, page, name, filters, created_by, created_by_username, created_at, last_used_at
         FROM saved_views WHERE org_id = ? AND page = ?
         ORDER BY last_used_at DESC`,
        [req.orgId, req.query.page]
      );
      res.json(rows.map(r => ({ ...r, filters: typeof r.filters === 'string' ? JSON.parse(r.filters) : r.filters })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── POST /api/saved-views — create (or overwrite-by-name) a view ──────────────
router.post('/',
  requireRole('admin', 'operator'),
  [
    body('page').isIn(PAGES),
    body('name').trim().isLength({ min: 1, max: 100 }),
    body('filters').isObject(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { page, name, filters } = req.body;
    try {
      const id = uuidv4();
      await execute(
        `INSERT INTO saved_views (id, org_id, page, name, filters, created_by, created_by_username, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE filters = VALUES(filters), last_used_at = NOW(),
           created_by = VALUES(created_by), created_by_username = VALUES(created_by_username)`,
        [id, req.orgId, page, name, JSON.stringify(filters), req.user.id, req.user.username]
      );
      const row = await queryOne('SELECT id FROM saved_views WHERE org_id = ? AND page = ? AND name = ?', [req.orgId, page, name]);
      res.status(201).json({ id: row.id, page, name, filters });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── PATCH /api/saved-views/:id/use — bump last_used_at (most-used sort) ───────
router.patch('/:id/use', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const result = await execute(
      'UPDATE saved_views SET last_used_at = NOW() WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'View not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/saved-views/:id ────────────────────────────────────────────────
router.delete('/:id', requireRole('admin', 'operator'), [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const result = await execute('DELETE FROM saved_views WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'View not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;