// public/sw.js — NetControl service worker
//
// Scope is just push notifications for now (no offline caching — this is a
// live monitoring dashboard, stale cached data would be actively misleading).
//
// Flow for the mobile-friendly alert triage feature:
//   1. 'push' event arrives with a small JSON payload (see services/webPush.js
//      on the backend) — title/body/severity/actions/data.logId.
//   2. showNotification() renders it with up to two action buttons:
//      Acknowledge / Snooze 1h (only present when the payload includes a
//      logId — i.e. it's a real open incident, not a plain heads-up).
//   3. 'notificationclick' — a plain tap (no action button) just opens/
//      focuses the app on /alerts. Tapping an action button opens/focuses
//      the app with a query string the app resolves on load
//      (?ack=<logId> or ?snooze=<logId>&minutes=60) via the already
//      logged-in session's token in localStorage — no separate auth needed
//      inside the service worker itself, and it works identically whether
//      the app was already open, backgrounded, or fully closed.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'NetControl', body: event.data.text() }; }

  const {
    title = 'NetControl',
    body = '',
    tag = 'nc-notification',
    requireInteraction = false,
    data = {},
    actions = [],
  } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data,
      actions: actions.slice(0, 2), // most platforms cap at 2 anyway
      vibrate: data.severity === 'critical' ? [200, 100, 200, 100, 200] : [150],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  let url = data.url || '/alerts';

  if (event.action === 'ack' && data.logId) {
    url = `/alerts?ack=${encodeURIComponent(data.logId)}`;
  } else if (event.action === 'snooze' && data.logId) {
    url = `/alerts?snooze=${encodeURIComponent(data.logId)}&minutes=60`;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        // Reuse an already-open tab when possible — navigate it and focus,
        // rather than piling up new tabs every time an alert fires.
        if ('focus' in client) {
          client.postMessage({ type: 'nc-push-action', url });
          client.navigate ? client.navigate(url).then(c => c.focus()) : client.focus();
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});