// services/webPush.js — Web Push delivery for mobile-friendly alert triage
//
// Uses VAPID (no third-party push provider/account needed — this is the
// standards-based Push API every modern mobile browser, including installed
// PWAs on Android/iOS 16.4+, supports natively). Keys are generated once
// and stored in .env; see ensureVapidKeys() below for the bootstrap path.
//
// A user can have multiple subscriptions (phone, laptop, tablet — each
// browser install gets its own PushSubscription). sendToUser() fans out to
// all of them and quietly drops any that the push service reports as gone
// (410 Gone / 404) so a stale subscription from a reinstalled browser
// doesn't accumulate forever or spam an error log on every alert.
'use strict';
const webpush = require('web-push');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');

let configured = false;

function ensureVapidKeys() {
  if (configured) return true;
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.warn(
      '[webPush] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled.\n' +
      '          Generate a pair with:  node -e "console.log(require(\'web-push\').generateVAPIDKeys())"\n' +
      '          then set both plus VAPID_SUBJECT (mailto:admin@yourdomain) in .env'
    );
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    pub,
    priv
  );
  configured = true;
  return true;
}

function isEnabled() { return ensureVapidKeys(); }
function publicKey() { return process.env.VAPID_PUBLIC_KEY || null; }

// ── Subscription management ─────────────────────────────────────────────────
async function saveSubscription(userId, subscription, userAgent) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Invalid push subscription payload');
  }
  const existing = await queryOne('SELECT id FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  if (existing) {
    await execute(
      'UPDATE push_subscriptions SET user_id=?, p256dh=?, auth=?, user_agent=?, last_used_at=? WHERE id=?',
      [userId, keys.p256dh, keys.auth, userAgent || null, Math.floor(Date.now() / 1000), existing.id]
    );
    return existing.id;
  }
  const id = uuidv4();
  await execute(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, endpoint, keys.p256dh, keys.auth, userAgent || null, Math.floor(Date.now() / 1000)]
  );
  return id;
}

async function removeSubscription(userId, endpoint) {
  await execute('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]);
}

async function listForUser(userId) {
  return query('SELECT id, endpoint, user_agent, created_at, last_used_at FROM push_subscriptions WHERE user_id = ?', [userId]);
}

// ── Sending ────────────────────────────────────────────────────────────────
// `payload` becomes the JSON the service worker receives in its 'push'
// event — see frontend/public/sw.js. Keep it small; push payloads are
// capped (~4KB) by most browsers.
async function sendToUser(userId, payload) {
  if (!ensureVapidKeys()) return { sent: 0, skipped: 'not_configured' };
  const subs = await query('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  if (!subs.length) return { sent: 0, skipped: 'no_subscriptions' };

  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
      sent++;
      execute('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?',
        [Math.floor(Date.now() / 1000), sub.id]).catch(() => {});
    } catch (err) {
      // 404/410 = the push service says this endpoint is gone for good
      // (user uninstalled the PWA, cleared site data, browser reset, etc.)
      // — clean it up so we stop trying and stop cluttering logs.
      if (err.statusCode === 404 || err.statusCode === 410) {
        execute('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]).catch(() => {});
      } else {
        console.warn('[webPush] delivery failed:', err.statusCode, err.message);
      }
    }
  }));
  return { sent, total: subs.length };
}

async function sendToUsers(userIds, payload) {
  const results = await Promise.all([...new Set(userIds)].map(uid => sendToUser(uid, payload)));
  return { sent: results.reduce((s, r) => s + (r.sent || 0), 0) };
}

module.exports = {
  isEnabled, publicKey,
  saveSubscription, removeSubscription, listForUser,
  sendToUser, sendToUsers,
};