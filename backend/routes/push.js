// routes/push.js — Web Push subscription management for mobile alert triage
'use strict';
const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const webPush = require('../services/webPush');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/push/vapid-public-key — public key the frontend needs to call
// pushManager.subscribe(). Not auth-sensitive on its own, but kept behind
// requireAuth for consistency with the rest of this router; the frontend
// already has a token by the time it offers to enable push.
router.get('/vapid-public-key', (req, res) => {
  const key = webPush.publicKey();
  if (!key) return res.status(503).json({ error: 'Push notifications are not configured on this server' });
  res.json({ publicKey: key });
});

// GET /api/push/subscriptions — list this user's registered devices/browsers
router.get('/subscriptions', async (req, res) => {
  try {
    res.json(await webPush.listForUser(req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/push/subscribe — save a browser PushSubscription for the current user
router.post(
  '/subscribe',
  body('subscription').isObject(),
  body('subscription.endpoint').isString().notEmpty(),
  body('subscription.keys.p256dh').isString().notEmpty(),
  body('subscription.keys.auth').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const id = await webPush.saveSubscription(req.user.id, req.body.subscription, req.headers['user-agent']);
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// POST /api/push/unsubscribe — drop a subscription (e.g. user toggled it off)
router.post(
  '/unsubscribe',
  body('endpoint').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      await webPush.removeSubscription(req.user.id, req.body.endpoint);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// POST /api/push/test — sends a harmless test notification to every device
// the current user has subscribed, so they can confirm it actually arrives
// (mobile push delivery has enough moving parts — OS-level notification
// permissions, battery-saver throttling, browser push service reachability —
// that "did it actually work" is worth a one-click check).
router.post('/test', async (req, res) => {
  try {
    const result = await webPush.sendToUser(req.user.id, {
      title: 'NetControl — test notification',
      body: 'Push notifications are working. Critical alerts will look like this.',
      tag: 'nc-test',
      data: { type: 'test', url: '/alerts' },
    });
    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'push_test', targetType: 'user', targetId: req.user.id,
      targetName: req.user.username, ipSource: req.realIp || req.ip, result: 'success' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;