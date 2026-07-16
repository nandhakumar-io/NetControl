// routes/agentRelease.js — the server-side half of agent self-update.
//
// This is deliberately INSTANCE-wide, not org-scoped: the agent binary is
// shared infrastructure (like the server codebase itself), not per-tenant
// data, so there's exactly one "current release" for the whole install
// rather than one per organization.
//
// Three audiences:
//   - GET  /                — anyone logged in can see what the current
//                             release is (a future Devices-page badge, or
//                             just an admin checking before rolling agents).
//   - GET  /download        — the AGENT itself, authenticated the same way
//                             routes/metrics.js authenticates ingest
//                             (x-api-key -> agent_key_hash), not a user
//                             session. Agents don't have user JWTs.
//   - POST /                — admin-only, uploads a new build.
'use strict';
const express = require('express');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const { queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const release = require('../services/agentRelease');
const audit = require('../services/audit');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // the agent is a single JS file — 10MB is already generous
});

// ── GET /api/agent-release — current release metadata ─────────────────────
router.get('/', requireAuth, (req, res) => {
  const manifest = release.getManifest();
  if (!manifest) return res.status(404).json({ error: 'No agent release configured yet' });
  res.json(manifest);
});

// ── GET /api/agent-release/download — the agent fetches its own update ────
// Authenticated by x-api-key, same as routes/metrics.js's agentAuth — the
// agent doesn't have (and shouldn't need) a user login to update itself.
router.get('/download', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' });
  try {
    const crypto = require('crypto');
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const device = await queryOne('SELECT id FROM devices WHERE agent_key_hash = ?', [keyHash]);
    if (!device) return res.status(403).json({ error: 'Invalid API key' });

    const buf = release.getScriptBuffer();
    const manifest = release.getManifest();
    if (!buf || !manifest) return res.status(404).json({ error: 'No agent release configured yet' });

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('X-Agent-Version', manifest.version);
    res.setHeader('X-Agent-Sha256', manifest.sha256);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/agent-release — admin uploads a new build ────────────────────
// body (multipart): file=<netcontrol-agent.js>, version=x.y.z, notes=...
router.post('/',
  requireAuth, requireRole('admin'),
  upload.single('file'),
  [ body('version').matches(/^\d+\.\d+\.\d+$/).withMessage('version must be x.y.z') ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!req.file) return res.status(400).json({ error: 'file is required (the new netcontrol-agent.js)' });

    try {
      const manifest = release.saveRelease(req.file.buffer, {
        version: req.body.version,
        notes: req.body.notes || '',
        uploaded_by: req.user.id,
      });

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'agent_release_upload', targetType: 'agent_release', targetId: manifest.version,
        targetName: `v${manifest.version}`, ipSource: req.realIp || req.ip, result: 'success',
        details: manifest.notes,
      });

      res.status(201).json(manifest);
    } catch (e) { res.status(400).json({ error: e.message }); }
  }
);

module.exports = router;