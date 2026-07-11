// routes/audit.js
const express = require('express');
const { getPool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const syslogForwarder = require('../services/syslogForwarder');

const router = express.Router();
router.use(requireAuth);

// Shared query-building logic reused by both the list endpoint and the
// export endpoint so the exported file always matches whatever filters
// are currently applied on screen.
function buildAuditQuery(req) {
  const where  = [];
  const params = [];

  // SECURITY FIX: audit_log has carried an org_id column since the
  // multi-tenant migration, but this route never filtered by it — any user
  // with the view_audit permission bit (including a global 'admin', who in
  // an MSP deployment may only be meant to administer their own client org)
  // could see and export every OTHER tenant's audit trail: usernames, IPs,
  // and full command text from routes/actions.js's exec endpoint. req.orgId
  // is set by requireOrgContext, which also verifies the caller is actually
  // a member of that org (rejecting an arbitrary X-Org-Id) before we ever
  // get here — see middleware/tenant.js.
  where.push('org_id = ?');
  params.push(req.orgId);

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
router.get('/', requirePermission(128), requireOrgContext, async (req, res) => {
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

    // syslog_synced is added by a separate migration (db/migrate-syslog.js)
    // that may not have been run yet on every environment — don't let a
    // missing column take down the whole audit log page, just report 0 synced.
    let synced = 0;
    try {
      const [syncedRow] = await pool.execute(`SELECT COUNT(*) as c FROM audit_log ${whereClause}${whereClause ? ' AND' : ' WHERE'} syslog_synced = 1`, params);
      synced = syncedRow[0]?.c || 0;
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        console.warn('[audit] syslog_synced column missing — run `npm run migrate` in backend/. Skipping sync tally.');
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

// Shared row->body renderer used by both the interactive export route and
// the unattended scheduled-export job (services/scheduledJobs.js).
function renderAuditRows(rows, format) {
  const cols = ['timestamp', 'username', 'action', 'target_name', 'target_type', 'ip_source', 'result', 'details'];
  if (format === 'csv') {
    const header = cols.join(',');
    const lines = rows.map(r => cols.map(c => csvEscape(c === 'timestamp' ? new Date((r[c] || 0) * 1000).toISOString() : r[c])).join(','));
    return [header, ...lines].join('\n');
  }
  return rows.map(r =>
    `[${new Date((r.timestamp || 0) * 1000).toISOString()}] ${r.username || 'system'} — ${r.action}` +
    (r.target_name ? ` — ${r.target_name}` : '') +
    ` — ${r.result}` +
    (r.ip_source ? ` — from ${r.ip_source}` : '') +
    (r.details ? ` — ${r.details}` : '')
  ).join('\n');
}

// Filters-object version of buildAuditQuery, for callers without a real
// Express `req` (i.e. a cron-triggered scheduled export).
function buildAuditQueryFromFilters(filters = {}) {
  const where  = [];
  const params = [];
  if (filters.action) { where.push('action = ?'); params.push(filters.action); }
  if (filters.result) { where.push('result = ?'); params.push(filters.result); }
  if (filters.search) {
    where.push('(username LIKE ? OR target_name LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.from) { where.push('timestamp >= ?'); params.push(parseInt(filters.from)); }
  if (filters.to)   { where.push('timestamp <= ?'); params.push(parseInt(filters.to)); }
  return { whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// Runs a full export (query + render) from a plain filters object. Used
// directly by the scheduled log-export job.
async function generateAuditExport(filters, format) {
  const { whereClause, params } = buildAuditQueryFromFilters(filters);
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT 10000`,
    params
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    body: renderAuditRows(rows, format),
    contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
    filename: `netcontrol-audit-log-${stamp}.${format}`,
    rowCount: rows.length,
  };
}

// GET /api/audit/export?format=csv|txt — honors the same filters as the list view
router.get('/export', requirePermission(128), requireOrgContext, async (req, res) => {
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
    const body = renderAuditRows(rows, format);

    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Device status change timeline & compare-snapshots ───────────────────────
// Backed by device_status_history, which services/statusPoller.js writes to
// every time a device's status actually flips (not every poll tick).

// GET /api/audit/device-changes?from=&to=&device_id=&page=&limit=
// Chronological feed of transitions ("proxmox2 went offline at ..."), plus
// up/down tallies for the selected window — the "what changed" timeline.
router.get('/device-changes', requirePermission(128), async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const where  = [];
    const params = [];
    if (req.query.device_id) { where.push('device_id = ?'); params.push(req.query.device_id); }
    if (req.query.from)      { where.push('timestamp >= ?'); params.push(parseInt(req.query.from)); }
    if (req.query.to)        { where.push('timestamp <= ?'); params.push(parseInt(req.query.to)); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const pool = getPool();
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM device_status_history ${whereClause}`,
      params
    );
    const [rows] = await pool.execute(
      `SELECT * FROM device_status_history ${whereClause} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ c: wentOnline }]] = await pool.execute(
      `SELECT COUNT(*) as c FROM device_status_history ${whereClause}${whereClause ? ' AND' : ' WHERE'} new_status = 'online'`,
      params
    );
    const [[{ c: wentOffline }]] = await pool.execute(
      `SELECT COUNT(*) as c FROM device_status_history ${whereClause}${whereClause ? ' AND' : ' WHERE'} new_status = 'offline'`,
      params
    );

    res.json({ total, page, limit, changes: rows, tallies: { wentOnline, wentOffline } });
  } catch (e) {
    console.error('[audit] GET /device-changes failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/device-compare?a=<epoch>&b=<epoch>
// Reconstructs what every device's status *was* at two points in time (the
// latest history row at-or-before each timestamp, falling back to 'unknown'
// if a device predates any recorded history) and diffs them — "what changed
// between these two moments", independent of the live/current status.
router.get('/device-compare', requirePermission(128), async (req, res) => {
  try {
    const a = parseInt(req.query.a);
    const b = parseInt(req.query.b);
    if (!a || !b) return res.status(400).json({ error: 'Both ?a= and ?b= epoch-second timestamps are required' });

    const pool = getPool();
    const statusAt = async (ts) => {
      const [rows] = await pool.execute(
        `SELECT d.id, d.name, d.os_type, d.group_id,
                COALESCE(
                  (SELECT h.new_status FROM device_status_history h
                     WHERE h.device_id = d.id AND h.timestamp <= ?
                     ORDER BY h.timestamp DESC LIMIT 1),
                  'unknown'
                ) AS status
         FROM devices d`,
        [ts]
      );
      return rows;
    };

    const [snapA, snapB] = await Promise.all([statusAt(a), statusAt(b)]);
    const mapA = new Map(snapA.map(d => [d.id, d]));

    const wentOnline  = [];
    const wentOffline = [];
    const otherChange = [];
    const unchanged    = [];

    for (const db of snapB) {
      const da = mapA.get(db.id);
      const before = da?.status || 'unknown';
      const after  = db.status;
      if (before === after) { unchanged.push(db); continue; }
      if (after === 'online' && before !== 'online')  wentOnline.push({ ...db, before });
      else if (before === 'online' && after !== 'online') wentOffline.push({ ...db, before });
      else otherChange.push({ ...db, before });
    }

    res.json({
      a, b,
      totalDevices: snapB.length,
      wentOnline, wentOffline, otherChange,
      unchangedCount: unchanged.length,
    });
  } catch (e) {
    console.error('[audit] GET /device-compare failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Syslog forwarding settings (admin-only to view/edit; status is readable
//    by anyone so the badge can render for non-admins) ──────────────────────
router.get('/syslog/status', async (req, res) => {
  try {
    const cfg = await syslogForwarder.getConfig();
    res.json({ enabled: cfg.enabled, host: cfg.host, protocol: cfg.protocol, runtime: syslogForwarder.getStats() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/syslog/config', requireRole('admin'), async (req, res) => {
  try {
    const cfg = await syslogForwarder.getConfig(true);
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/syslog/config', requireRole('admin'), async (req, res) => {
  try {
    const cfg = await syslogForwarder.setConfig(req.body || {}, req.user.id);
    res.json(cfg);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/syslog/test', requireRole('admin'), async (req, res) => {
  try {
    const result = await syslogForwarder.testConnection();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Raw-rows version of generateAuditExport, for the scheduled log-export job
// when its target is "syslog" instead of a file — no rendering, just the
// rows so each one can become its own syslog message.
async function queryAuditRows(filters) {
  const { whereClause, params } = buildAuditQueryFromFilters(filters);
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT 10000`,
    params
  );
  return rows;
}

// Router stays the default export (server.js does `require('./routes/audit')`
// directly), with the export-generation helpers attached as properties —
// Router is a function object, so this is safe and needs no caller changes.
module.exports = router;
module.exports.generateAuditExport = generateAuditExport;
module.exports.queryAuditRows = queryAuditRows;