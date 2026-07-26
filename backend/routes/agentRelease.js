// routes/agentRelease.js — the server-side half of agent self-update.
//
// This is deliberately INSTANCE-wide, not org-scoped: the agent binary is
// shared infrastructure (like the server codebase itself), not per-tenant
// data, so there's exactly one "current release" for the whole install
// rather than one per organization.
//
// Audiences:
//   - GET  /                — anyone logged in can see what the current
//                             release is (rollout %, status included now).
//   - GET  /history          — admin view of all uploaded releases, with
//                             per-cohort health counts, for the rollout
//                             %-slider / rollback UI.
//   - GET  /download        — the AGENT itself, authenticated the same way
//                             routes/metrics.js authenticates ingest
//                             (x-api-key -> agent_key_hash), not a user
//                             session. Agents don't have user JWTs.
//   - POST /                — admin-only, uploads a new build. Defaults to
//                             a 10% canary rollout rather than 100% — a
//                             canary is now the deliberate default, not
//                             something you have to remember to dial down.
//   - PATCH /:id/rollout    — admin-only, adjust rollout_percent on the fly.
//   - POST /:id/rollback    — admin-only, revert to a previously superseded
//                             build without re-uploading.
//   - POST /:id/resume      — admin-only, un-pause a canary that auto-paused
//                             (see services/agentRelease.js checkCanaryHealth()).
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

// ── GET /api/agent-release — current active release metadata ──────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const manifest = await release.getManifest();
    if (!manifest) return res.status(404).json({ error: 'No agent release configured yet' });
    res.json(manifest);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/agent-release/history — all uploads, with cohort health ───────
router.get('/history', requireAuth, async (req, res) => {
  try {
    const releases = await release.listReleases(20);
    res.json(releases);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/agent-release/download — the agent fetches its own update ────
// Authenticated by x-api-key, same as routes/metrics.js's agentAuth — the
// agent doesn't have (and shouldn't need) a user login to update itself.
// Serves whichever release is currently 'active' — this is also how
// rollback takes effect: rollbackTo() flips 'active' to a prior row, and
// the very next agent that downloads gets that older build, no separate
// code path needed.
router.get('/download', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' });
  try {
    const crypto = require('crypto');
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const device = await queryOne('SELECT id FROM devices WHERE agent_key_hash = ?', [keyHash]);
    if (!device) return res.status(403).json({ error: 'Invalid API key' });

    const buf = await release.getScriptBuffer();
    const manifest = await release.getManifest();
    if (!buf || !manifest) return res.status(404).json({ error: 'No agent release configured yet' });

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('X-Agent-Version', manifest.version);
    res.setHeader('X-Agent-Sha256', manifest.sha256);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/agent-release — admin uploads a new build ────────────────────
// body (multipart): file=<netcontrol-agent.js>, version=x.y.z, notes=...,
//                    rollout_percent=<0-100, default 10>
router.post('/',
  requireAuth, requireRole('admin'),
  upload.single('file'),
  [
    body('version').matches(/^\d+\.\d+\.\d+$/).withMessage('version must be x.y.z'),
    body('rollout_percent').optional().isInt({ min: 0, max: 100 }).withMessage('rollout_percent must be 0-100'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!req.file) return res.status(400).json({ error: 'file is required (the new netcontrol-agent.js)' });

    const rolloutPercent = req.body.rollout_percent != null ? parseInt(req.body.rollout_percent, 10) : 10;

    try {
      const saved = await release.saveRelease(req.file.buffer, {
        version: req.body.version,
        notes: req.body.notes || '',
        uploadedBy: req.user.id,
        rolloutPercent,
      });

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'agent_release_upload', targetType: 'agent_release', targetId: saved.id,
        targetName: `v${saved.version}`, ipSource: req.realIp || req.ip, result: 'success',
        details: `${saved.notes} (rollout: ${rolloutPercent}%)`,
      });

      res.status(201).json(saved);
    } catch (e) { res.status(400).json({ error: e.message }); }
  }
);

// ── PATCH /api/agent-release/:id/rollout — dial the canary % up or down ────
router.patch('/:id/rollout', requireAuth, requireRole('admin'),
  [ body('rollout_percent').isInt({ min: 0, max: 100 }).withMessage('rollout_percent must be 0-100') ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const pct = parseInt(req.body.rollout_percent, 10);
      await release.setRolloutPercent(req.params.id, pct);
      await audit.log({
        userId: req.user.id, username: req.user.username, action: 'agent_release_rollout_change',
        targetType: 'agent_release', targetId: req.params.id, ipSource: req.realIp || req.ip,
        result: 'success', details: `rollout_percent -> ${pct}`,
      });
      res.json({ ok: true, rollout_percent: pct });
    } catch (e) { res.status(400).json({ error: e.message }); }
  }
);

// ── POST /api/agent-release/:id/rollback — revert to a prior build ────────
router.post('/:id/rollback', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const target = await release.rollbackTo(req.params.id);
    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'agent_release_rollback',
      targetType: 'agent_release', targetId: req.params.id, ipSource: req.realIp || req.ip,
      result: 'success', details: `rolled back to v${target.version}`,
    });
    res.json({ ok: true, version: target.version });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/agent-release/:id/resume — un-pause an auto-paused canary ───
router.post('/:id/resume', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await release.resumeRelease(req.params.id);
    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'agent_release_resume',
      targetType: 'agent_release', targetId: req.params.id, ipSource: req.realIp || req.ip,
      result: 'success',
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;