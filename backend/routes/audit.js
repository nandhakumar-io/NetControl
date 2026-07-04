// routes/audit.js
const express = require('express');
const { getPool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const snmpForwarder = require('../services/snmpForwarder');

const router = express.Router();
router.use(requireAuth);

// Shared query-building logic reused by both the list endpoint and the
// export endpoint so the exported file always matches whatever filters
// are currently applied on screen.
function buildAuditQuery(req) {
  const where  = [];
  const params = [];

  if (req.user.role !== 'admin') {
    where.push(`(
      user_id = ?
      OR target_id IN (
        SELECT group_id FROM user_group_access WHERE user_id = ?
      )
      OR target_id IN (
        SELECT d.id FROM devices d
        INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ?
      )
    )`);
    params.push(req.user.id, req.user.id, req.user.id);
  }

  if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
  if (req.query.result) { where.push('result = ?'); params.push(req.query.result); }
  if (req.query.search) {
    where.push('(username LIKE ? OR target_name LIKE ?)');
    params.push(`%${req.query.search}%`, `%${req.query.search}%`);
  }
  if (req.query.from) { where.push('timestamp >= ?'); params.push(parseInt(req.query.from)); }
  if (req.query.to)   { where.push('timestamp <= ?'); params.push(parseInt(req.query.to)); }

  return { whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/audit?page=1&limit=25&action=wake&search=admin&result=success
router.get('/', requirePermission(128), async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const { whereClause, params } = buildAuditQuery(req);
    const pool = getPool();

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM audit_log ${whereClause}`,
      params
    );

    const [rows] = await pool.execute(
      `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [successRow]  = await pool.execute(`SELECT COUNT(*) as c FROM audit_log ${whereClause}${whereClause ? ' AND' : ' WHERE'} result = 'success'`, params);
    const [failureRow]  = await pool.execute(`SELECT COUNT(*) as c FROM audit_log ${whereClause}${whereClause ? ' AND' : ' WHERE'} result = 'failure'`, params);
    const [partialRow]  = await pool.execute(`SELECT COUNT(*) as c FROM audit_log ${whereClause}${whereClause ? ' AND' : ' WHERE'} result = 'partial'`, params);

    // snmp_synced is added by a separate migration (db/migrate-snmp.js) that
    // may not have been run yet on every environment — don't let a missing
    // column take down the whole audit log page, just report 0 synced.
    let synced = 0;
    try {
      const [syncedRow] = await pool.execute(`SELECT COUNT(*) as c FROM audit_log ${whereClause}${whereClause ? ' AND' : ' WHERE'} snmp_synced = 1`, params);
      synced = syncedRow[0]?.c || 0;
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        console.warn('[audit] snmp_synced column missing — run `npm run migrate` in backend/. Skipping sync tally.');
      } else {
        throw e;
      }
    }

    res.json({
      total, page, limit, logs: rows,
      tallies: {
        success: successRow[0]?.c || 0,
        failure: failureRow[0]?.c || 0,
        partial: partialRow[0]?.c || 0,
        synced,
      },
    });
  } catch (e) {
    console.error('[audit] GET / failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/export?format=csv|txt — honors the same filters as the list view
router.get('/export', requirePermission(128), async (req, res) => {
  try {
    const format = req.query.format === 'txt' ? 'txt' : 'csv';
    const { whereClause, params } = buildAuditQuery(req);
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT 10000`,
      params
    );

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `netcontrol-audit-log-${stamp}.${format}`;
    const cols = ['timestamp', 'username', 'action', 'target_name', 'target_type', 'ip_source', 'result', 'details'];

    let body;
    if (format === 'csv') {
      const header = cols.join(',');
      const lines = rows.map(r => cols.map(c => csvEscape(c === 'timestamp' ? new Date((r[c] || 0) * 1000).toISOString() : r[c])).join(','));
      body = [header, ...lines].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    } else {
      const lines = rows.map(r =>
        `[${new Date((r.timestamp || 0) * 1000).toISOString()}] ${r.username || 'system'} — ${r.action}` +
        (r.target_name ? ` — ${r.target_name}` : '') +
        ` — ${r.result}` +
        (r.ip_source ? ` — from ${r.ip_source}` : '') +
        (r.details ? ` — ${r.details}` : '')
      );
      body = lines.join('\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SNMP forwarding settings (admin-only to view/edit; status is readable
//    by anyone so the badge can render for non-admins) ──────────────────────
router.get('/snmp/status', async (req, res) => {
  try {
    const cfg = await snmpForwarder.getConfig();
    res.json({ enabled: cfg.enabled, host: cfg.host, runtime: snmpForwarder.getStats() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/snmp/config', requireRole('admin'), async (req, res) => {
  try {
    const cfg = await snmpForwarder.getConfig(true);
    res.json({ ...cfg, communitySet: !!cfg.community, community: undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/snmp/config', requireRole('admin'), async (req, res) => {
  try {
    const cfg = await snmpForwarder.setConfig(req.body || {}, req.user.id);
    res.json({ ...cfg, community: cfg.community ? '••••••••' : '' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/snmp/test', requireRole('admin'), async (req, res) => {
  try {
    const result = await snmpForwarder.testConnection();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;