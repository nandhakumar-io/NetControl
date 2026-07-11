// routes/wolRelay.js — agent-facing endpoints for relayed Wake-on-LAN
'use strict';
const express = require('express');
const { queryOne } = require('../db');
const { agentRelayLimiter } = require('../middleware/rateLimiter');
const { waitForJob, hashKey } = require('../services/wolRelay');
const audit = require('../services/audit');

const router = express.Router();

async function agentAuthMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key' });
  try {
    const device = await queryOne(
      'SELECT id, name FROM devices WHERE agent_key_hash = ?',
      [hashKey(key)]
    );
    if (!device) return res.status(403).json({ error: 'Invalid key' });
    req.agentDevice = device;
    next();
  } catch { res.status(500).json({ error: 'DB error' }); }
}

// GET /api/wol-relay/device/:deviceId/pending — agent long-polls for a wake job
// it should execute locally (i.e. broadcast on its own subnet).
router.get('/device/:deviceId/pending', agentRelayLimiter, agentAuthMiddleware, async (req, res) => {
  const relayDeviceId = req.agentDevice.id;
  const job = await waitForJob(relayDeviceId).catch(() => null);
  res.json({ job });
});

// POST /api/wol-relay/device/:deviceId/result — agent reports whether it
// actually sent the broadcast packet (best-effort; UDP has no delivery ack,
// so this only confirms the agent attempted it, not that the NIC woke up).
router.post('/device/:deviceId/result', agentRelayLimiter, agentAuthMiddleware, async (req, res) => {
  const { targetDeviceId, targetName, ok, error } = req.body || {};
  console.log(
    `[WoL Relay] ${req.agentDevice.name} ${ok ? 'sent' : 'failed to send'} wake packet ` +
    `for ${targetName || targetDeviceId}${error ? ` (${error})` : ''}`
  );
  try {
    await audit.log({
      username: 'system',
      action: 'wake_relayed',
      targetType: 'device',
      targetId: targetDeviceId || null,
      targetName: targetName || null,
      result: ok ? 'success' : 'failure',
      details: `Relayed via agent ${req.agentDevice.name}${error ? `: ${error}` : ''}`,
    });
  } catch {}
  res.json({ ok: true });
});

module.exports = router;