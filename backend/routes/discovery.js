// routes/discovery.js — Network discovery API
// ICMP ping sweep, SNMP discovery, LLDP/CDP neighbor discovery, nmap port/OS
// scan, and MAC-vendor tagging. Gated behind its own permission bit (1024,
// DISCOVER_NETWORK) — admins have it by default, but it's deliberately *not*
// granted to the built-in operator/viewer roles, since network scanning is a
// meaningfully more sensitive capability than day-to-day device management.
'use strict';

const express = require('express');
const { body, param, query: queryValidator, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission, requireActionPin } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { discoveryLimiter } = require('../middleware/rateLimiter');
const discovery = require('../services/discoveryService');
const { encrypt } = require('../services/crypto');
const { lookupVendor } = require('../services/discoveryVendors');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

const DISCOVER_NETWORK = 1024;
const MANAGE_DEVICES    = 2;

function validate(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return true; }
  return false;
}

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

const ALLOWED_METHODS = ['ping', 'snmp', 'lldp_cdp', 'nmap'];

// ── POST /api/discovery/scans — start a new scan ──────────────────────────────
router.post('/scans',
  requirePermission(DISCOVER_NETWORK),
  discoveryLimiter,
  requireActionPin,
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('cidr').trim().notEmpty().isLength({ max: 50 }),
  body('methods').isArray({ min: 1 }).custom(arr => arr.every(m => ALLOWED_METHODS.includes(m)))
    .withMessage(`methods must be a subset of ${ALLOWED_METHODS.join(', ')}`),
  body('snmpCommunities').optional().isArray({ max: 5 }),
  body('snmpCommunities.*').optional().isString().isLength({ max: 100 }),
  body('nmapOptions').optional().isObject(),
  body('nmapOptions.osDetection').optional().isBoolean(),
  body('nmapOptions.serviceDetection').optional().isBoolean(),
  body('nmapOptions.topPorts').optional().isInt({ min: 1, max: discovery.NMAP_TOP_PORTS_MAX }),
  body('nmapOptions.ports').optional().isString().matches(/^[0-9,\-]{1,100}$/),
  async (req, res) => {
    if (validate(req, res)) return;
    const { name, cidr, methods, snmpCommunities, nmapOptions } = req.body;

    // Validate the range up front so we fail fast with a clear message
    // instead of after creating a scan row.
    let hostCount;
    try { hostCount = discovery.expandCidr(cidr).length; }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const communities = (snmpCommunities && snmpCommunities.length) ? snmpCommunities : ['public'];

    try {
      await execute(
        `INSERT INTO discovery_scans
           (id, name, cidr, methods, snmp_communities, nmap_options, status, total_hosts, created_by, created_at, org_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, name, cidr, JSON.stringify(methods),
          methods.includes('snmp') ? encrypt(JSON.stringify(communities)) : null,
          nmapOptions ? JSON.stringify(nmapOptions) : null,
          'queued', hostCount, req.user.id, now, req.orgId,
        ]
      );

      await audit.log({
        userId: req.user.id, username: req.user.username, ipSource: req.realIp,
        action: 'discovery_scan_started', targetType: 'discovery_scan', targetId: id, targetName: name,
        result: 'success', details: `${cidr} (${hostCount} hosts) via ${methods.join(',')}`,
      });

      // Fire-and-forget — progress is polled via GET /scans/:id.
      discovery.runScan(id, { userId: req.user.id, username: req.user.username, ipSource: req.realIp })
        .catch(async (e) => {
          await execute('UPDATE discovery_scans SET status=?, error=? WHERE id=?', ['failed', e.message, id]);
        });

      res.status(201).json({ id, status: 'queued', totalHosts: hostCount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/discovery/scans — list scans ─────────────────────────────────────
router.get('/scans', requirePermission(DISCOVER_NETWORK), async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.id, s.name, s.cidr, s.methods, s.status, s.total_hosts, s.scanned_hosts,
              s.alive_hosts, s.error, s.created_at, s.started_at, s.finished_at, u.username as created_by_name
       FROM discovery_scans s LEFT JOIN users u ON u.id = s.created_by
       WHERE s.org_id = ?
       ORDER BY s.created_at DESC LIMIT 100`,
      [req.orgId]
    );
    res.json(rows.map(r => ({ ...r, methods: safeJson(r.methods, []) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/discovery/scans/:id — status / progress ──────────────────────────
router.get('/scans/:id', requirePermission(DISCOVER_NETWORK), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const scan = await queryOne(
      `SELECT s.*, u.username as created_by_name FROM discovery_scans s
       LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ? AND s.org_id = ?`, [req.params.id, req.orgId]
    );
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    delete scan.snmp_communities; // never expose stored community strings back
    scan.methods = safeJson(scan.methods, []);
    scan.nmap_options = safeJson(scan.nmap_options, null);
    res.json(scan);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/discovery/scans/:id/results — discovered hosts ──────────────────
router.get('/scans/:id/results', requirePermission(DISCOVER_NETWORK), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const scanOwned = await queryOne('SELECT id FROM discovery_scans WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!scanOwned) return res.status(404).json({ error: 'Scan not found' });
    const rows = await query(
      `SELECT * FROM discovery_results WHERE scan_id = ? ORDER BY INET_ATON(ip_address)`,
      [req.params.id]
    );
    res.json(rows.map(r => ({
      ...r,
      open_ports: safeJson(r.open_ports, []),
      neighbors: safeJson(r.neighbors, []),
      discovered_via: safeJson(r.discovered_via, []),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/discovery/scans/:id/cancel ──────────────────────────────────────
router.post('/scans/:id/cancel', requirePermission(DISCOVER_NETWORK), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const scan = await queryOne('SELECT status FROM discovery_scans WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    if (!['queued', 'running'].includes(scan.status)) return res.json({ ok: true, status: scan.status });
    await execute('UPDATE discovery_scans SET cancel_requested = 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/discovery/scans/:id ───────────────────────────────────────────
router.delete('/scans/:id', requirePermission(DISCOVER_NETWORK), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const scan = await queryOne('SELECT status FROM discovery_scans WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    if (scan.status === 'running') return res.status(409).json({ error: 'Cancel the scan before deleting it' });
    await execute('DELETE FROM discovery_scans WHERE id = ?', [req.params.id]); // results cascade
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/discovery/scans/:id/import — add discovered hosts as devices ───
// Body shape:
//   devices: [
//     {
//       resultId:       UUID,           // discovery_results.id
//       name:           string,         // chosen display name
//       group_id:       UUID|null,
//       os_type:        'linux'|'windows',
//       ssh_username:   string|null,    // stored encrypted
//       ssh_password:   string|null,    // stored encrypted
//       winrm_username: string|null,
//       winrm_password: string|null,
//     }, ...
//   ]
router.post('/scans/:id/import',
  requirePermission(DISCOVER_NETWORK), requirePermission(MANAGE_DEVICES),
  param('id').isUUID(),
  body('devices').isArray({ min: 1, max: 500 }),
  body('devices.*.resultId').isUUID(),
  body('devices.*.name').trim().notEmpty().isLength({ max: 100 }),
  body('devices.*.os_type').isIn(['windows', 'linux']),
  body('devices.*.group_id').optional({ nullable: true }).custom(v => !v || /^[0-9a-f-]{36}$/i.test(v)),
  body('devices.*.ssh_username').optional({ nullable: true }).isString().isLength({ max: 100 }),
  body('devices.*.ssh_password').optional({ nullable: true }).isString().isLength({ max: 500 }),
  body('devices.*.winrm_username').optional({ nullable: true }).isString().isLength({ max: 100 }),
  body('devices.*.winrm_password').optional({ nullable: true }).isString().isLength({ max: 500 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const { devices: deviceSpecs } = req.body;
    const { encrypt } = require('../services/crypto');

    try {
      const scanOwned = await queryOne('SELECT id FROM discovery_scans WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!scanOwned) return res.status(404).json({ error: 'Scan not found' });

      const resultIds = deviceSpecs.map(d => d.resultId);
      const placeholders = resultIds.map(() => '?').join(',');
      const dbResults = await query(
        `SELECT * FROM discovery_results WHERE scan_id = ? AND id IN (${placeholders})`,
        [req.params.id, ...resultIds]
      );
      const resultMap = Object.fromEntries(dbResults.map(r => [r.id, r]));

      const imported = [];
      const skipped  = [];

      for (const spec of deviceSpecs) {
        const r = resultMap[spec.resultId];
        if (!r) { skipped.push({ name: spec.name, reason: 'Result not found' }); continue; }
        if (r.imported) { skipped.push({ name: spec.name, reason: 'Already imported' }); continue; }

        // MAC is strongly preferred but not hard-required — some hosts (e.g. remote
        // subnets) won't have one in the ARP table. Warn but allow import.
        if (r.mac_address) {
          const existing = await queryOne('SELECT id FROM devices WHERE mac_address = ? AND org_id = ?', [r.mac_address, req.orgId]);
          if (existing) { skipped.push({ name: spec.name, ip: r.ip_address, reason: 'A device with this MAC already exists' }); continue; }
        }

        const deviceId = uuidv4();
        const now      = Math.floor(Date.now() / 1000);

        // For Windows: mirror winrm creds into ssh fields too (used by SSH terminal fallback)
        const sshUser   = spec.ssh_username   || (spec.os_type === 'windows' ? spec.winrm_username : null) || null;
        const sshPass   = spec.ssh_password   || (spec.os_type === 'windows' ? spec.winrm_password : null) || null;
        const winrmUser = spec.winrm_username || null;
        const winrmPass = spec.winrm_password || null;

        await execute(
          `INSERT INTO devices
             (id, name, ip_address, mac_address, os_type, group_id,
              ssh_username, ssh_password, winrm_username, winrm_password,
              status, last_seen, created_at, org_id)
           VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?,?)`,
          [
            deviceId,
            spec.name.trim(),
            r.ip_address,
            r.mac_address || null,
            spec.os_type,
            spec.group_id || null,
            sshUser,
            sshPass   ? encrypt(sshPass)   : null,
            winrmUser,
            winrmPass ? encrypt(winrmPass) : null,
            'unknown', now, now, req.orgId,
          ]
        );
        await execute('UPDATE discovery_results SET imported = 1, device_id = ? WHERE id = ?', [deviceId, r.id]);
        imported.push({ ip: r.ip_address, name: spec.name, deviceId });
      }

      await audit.log({
        userId: req.user.id, username: req.user.username, ipSource: req.realIp,
        action: 'discovery_import', targetType: 'discovery_scan', targetId: req.params.id,
        result: skipped.length && imported.length ? 'partial' : (imported.length ? 'success' : 'failure'),
        details: `Imported ${imported.length}, skipped ${skipped.length}`,
      });

      res.json({ imported, skipped });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/discovery/nmap-status — is nmap installed on this server? ───────
router.get('/nmap-status', requirePermission(DISCOVER_NETWORK), async (_req, res) => {
  res.json({ available: await discovery.isNmapAvailable() });
});

// ── POST /api/discovery/vendor-lookup — ad-hoc single MAC lookup (UI helper) ─
router.post('/vendor-lookup',
  requirePermission(DISCOVER_NETWORK),
  body('mac').isString().isLength({ max: 20 }),
  async (req, res) => {
    if (validate(req, res)) return;
    res.json({ vendor: lookupVendor(req.body.mac) });
  }
);

module.exports = router;