// routes/runbooks.js — reusable auto-remediation scripts ("runbooks") that
// alert rules can trigger automatically (e.g. "restart nginx", "clear ARP
// cache", "flush DNS", "kill runaway process"). This is what upgrades
// NetControl from "tells you something's wrong" to "fixes common problems
// itself and tells you what it did."
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { decrypt } = require('../services/crypto');
const { runRunbookById } = require('../services/runbookRunner');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

// Its own permission bit — deliberately NOT the same as
// manage_process_policies (4096). Runbooks let an alert automatically run
// arbitrary shell/PowerShell commands on a device, unattended; that's a
// meaningfully bigger blast radius than process-policy management, so
// granting one should never silently grant the other.
const requireManageRunbooks = requirePermission(32768);

// SECURITY: org_id is filtered in the query itself, not just checked after
// the fact — see middleware/tenant.js's verifyDeviceOrgAccess() comment for
// why relying on a call-site check alone is the pattern that caused the
// cross-tenant device access bug in actions.js/sshProxy.js/webTerminal.js.
// A device belonging to another org now simply doesn't come back as a row.
async function loadDevice(id, orgId) {
  const d = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [id, orgId]);
  if (!d) return null;
  return {
    ...d,
    _ssh_password:   decrypt(d.ssh_password),
    _ssh_key:        decrypt(d.ssh_key),
    _winrm_password: decrypt(d.winrm_password),
  };
}

// ── GET /api/runbooks ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT r.*, u.username AS created_by_name
         FROM runbook_actions r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.org_id = ? ORDER BY r.name`,
      [req.orgId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/runbooks ────────────────────────────────────────────────────
router.post('/', requireManageRunbooks, async (req, res) => {
  try {
    const { name, description = null, os_type = 'any', command, timeout_sec = 30, require_approval = false } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!command?.trim()) return res.status(400).json({ error: 'command is required' });
    if (!['linux', 'windows', 'any'].includes(os_type)) return res.status(400).json({ error: 'invalid os_type' });

    const id = uuidv4();
    await execute(
      `INSERT INTO runbook_actions (id, org_id, name, description, os_type, command, timeout_sec, require_approval, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())`,
      [id, req.orgId, name.trim(), description, os_type, command, Math.min(timeout_sec, 300), require_approval ? 1 : 0, req.user.id]
    );
    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'create_runbook', targetType: 'runbook_action', targetId: id,
      targetName: name, ipSource: req.realIp || req.ip, result: 'success' });
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/runbooks/:id ─────────────────────────────────────────────────
router.put('/:id', requireManageRunbooks, async (req, res) => {
  try {
    const existing = await queryOne('SELECT * FROM runbook_actions WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!existing) return res.status(404).json({ error: 'Runbook not found' });

    const {
      name = existing.name, description = existing.description,
      os_type = existing.os_type, command = existing.command,
      timeout_sec = existing.timeout_sec,
      require_approval = existing.require_approval,
    } = req.body;

    await execute(
      `UPDATE runbook_actions SET name=?, description=?, os_type=?, command=?, timeout_sec=?, require_approval=? WHERE id=? AND org_id=?`,
      [name, description, os_type, command, Math.min(timeout_sec, 300), require_approval ? 1 : 0, req.params.id, req.orgId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/runbooks/:id ──────────────────────────────────────────────
router.delete('/:id', requireManageRunbooks, async (req, res) => {
  try {
    await execute('DELETE FROM runbook_actions WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/runbooks/:id/test — run it once against a specific device
//    right now, so an admin can validate a new runbook before wiring it
//    into an alert rule ──────────────────────────────────────────────────
router.post('/:id/test', requireManageRunbooks, async (req, res) => {
  try {
    const runbook = await queryOne('SELECT * FROM runbook_actions WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!runbook) return res.status(404).json({ error: 'Runbook not found' });

    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const device = await loadDevice(deviceId, req.orgId);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const outcome = await runRunbookById(runbook.id, device, { triggeredBy: `manual test by ${req.user.username}` });

    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'test_runbook', targetType: 'device', targetId: deviceId,
      targetName: device.name, ipSource: req.realIp || req.ip,
      result: outcome.result === 'success' ? 'success' : 'failure',
      details: `Runbook "${runbook.name}": ${outcome.output}` });

    res.json(outcome);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/runbooks/:id/history — recent run log for this runbook ──────
router.get('/:id/history', async (req, res) => {
  try {
    const rows = await query(
      `SELECT rl.*, d.name AS device_name
         FROM runbook_run_log rl JOIN devices d ON d.id = rl.device_id
        WHERE rl.runbook_id = ? AND d.org_id = ?
        ORDER BY rl.ran_at DESC LIMIT 100`,
      [req.params.id, req.orgId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;