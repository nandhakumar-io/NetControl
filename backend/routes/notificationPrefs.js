// routes/notificationPrefs.js — self-service in-app/push notification
// preferences (severity threshold per channel + temporary mute).
// Always scoped to req.user.id — there is no admin-on-behalf-of-another-
// user endpoint here, same as routes/push.js's subscription management.
'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const notificationPrefs = require('../services/notificationPrefs');

const router = express.Router();
router.use(requireAuth);

const SEVERITIES = ['info', 'warning', 'critical'];

// GET /api/notification-prefs — this user's current settings (defaults if
// they've never saved any).
router.get('/', async (req, res) => {
  try {
    res.json(await notificationPrefs.getPrefs(req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/notification-prefs — partial update, any subset of fields.
router.put(
  '/',
  [
    body('in_app_enabled').optional().isBoolean(),
    body('in_app_min_severity').optional().isIn(SEVERITIES),
    body('push_enabled').optional().isBoolean(),
    body('push_min_severity').optional().isIn(SEVERITIES),
    // muted_until: null clears the mute; a unix timestamp sets it. Capped
    // to 30 days out so a fat-fingered value doesn't silence someone
    // indefinitely with no obvious way to notice why.
    body('muted_until').optional({ nullable: true }).isInt({ min: 0, max: Math.floor(Date.now() / 1000) + 30 * 86400 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const updated = await notificationPrefs.updatePrefs(req.user.id, req.body);
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// POST /api/notification-prefs/mute — convenience shortcut: mute both
// channels for N minutes (default 60), rather than the caller computing a
// unix timestamp client-side.
router.post(
  '/mute',
  body('minutes').optional().isInt({ min: 1, max: 30 * 24 * 60 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const minutes = req.body.minutes || 60;
      const until = Math.floor(Date.now() / 1000) + minutes * 60;
      const updated = await notificationPrefs.updatePrefs(req.user.id, { muted_until: until });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// POST /api/notification-prefs/unmute
router.post('/unmute', async (req, res) => {
  try {
    const updated = await notificationPrefs.updatePrefs(req.user.id, { muted_until: null });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;