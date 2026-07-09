// services/bus.js — cross-process event bus
//
// WHY THIS EXISTS:
// server.js runs multiple clustered Node workers, and (with this change)
// polling/scheduling now runs in a completely separate `poller` process.
// Neither can share JS memory. Two things need to cross that boundary:
//   1. Live metric snapshots -> every web worker's SSE clients, regardless
//      of which worker actually received the agent's POST.
//   2. Device status transitions from the poller -> web workers, so GET
//      /api/metrics and dashboards reflect poller-driven changes too.
//
// If REDIS_URL is set, this uses real Redis pub/sub (works across containers/
// processes). If not set (e.g. quick local dev with a single process), it
// falls back to an in-process EventEmitter so nothing breaks — but in that
// mode cross-process delivery obviously doesn't happen, so multi-worker/
// multi-process setups MUST set REDIS_URL.

'use strict';
const { EventEmitter } = require('events');
const crypto = require('crypto');

// Unique per-process id. Used so a worker that both publishes AND applies a
// message locally (see routes/metrics.js) can tell its own message apart
// from the Redis loopback echo of that same message, and skip re-applying
// it a second time.
const PROCESS_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

const REDIS_URL = process.env.REDIS_URL || '';

let publisher = null;
let subscriber = null;
let lastPublisherError = null;
let lastSubscriberError = null;
const local = new EventEmitter();
local.setMaxListeners(50);

if (REDIS_URL) {
  const Redis = require('ioredis');
  publisher  = new Redis(REDIS_URL, { lazyConnect: false });
  subscriber = new Redis(REDIS_URL, { lazyConnect: false });

  publisher.on('error',  e => { lastPublisherError  = e.message; console.error('[Bus] publisher error:', e.message); });
  subscriber.on('error', e => { lastSubscriberError = e.message; console.error('[Bus] subscriber error:', e.message); });
  publisher.on('ready',  () => { lastPublisherError  = null; });
  subscriber.on('ready', () => { lastSubscriberError = null; });

  subscriber.on('message', (channel, raw) => {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    local.emit(channel, payload);
  });

  console.log('[Bus] Using Redis pub/sub at', REDIS_URL.replace(/:[^:@]*@/, ':***@'));
} else {
  console.warn('[Bus] REDIS_URL not set — falling back to in-process bus. ' +
    'Fine for single-process dev only; multi-worker/multi-container setups ' +
    'will NOT share events without Redis.');
}

const subscribedChannels = new Set();

function publish(channel, payload) {
  const wrapped = { ...payload, _origin: PROCESS_ID };
  if (publisher) {
    publisher.publish(channel, JSON.stringify(wrapped)).catch(e =>
      console.error('[Bus] publish failed — Redis unreachable? Cross-worker ' +
        'sync for this event will NOT happen:', e.message));
  } else {
    // Local fallback: still go through the emitter so subscribers get it
    // asynchronously, same as the Redis path would deliver it.
    setImmediate(() => local.emit(channel, wrapped));
  }
}

function subscribe(channel, handler, opts = {}) {
  // skipSelf: true means "I already applied this locally at the point of
  // publish() — only act on it here if it came from ANOTHER process."
  // This matters specifically because publish() no longer guarantees
  // delivery on its own (e.g. Redis down) — callers that need a guarantee
  // (like metrics ingestion) apply state directly and use the bus purely
  // for fanning out to other workers, so a failed publish degrades to
  // "other workers miss this update" instead of "nothing happens at all."
  const wrapped = (payload) => {
    if (opts.skipSelf && payload._origin === PROCESS_ID) return;
    handler(payload);
  };
  local.on(channel, wrapped);
  if (subscriber && !subscribedChannels.has(channel)) {
    subscribedChannels.add(channel);
    subscriber.subscribe(channel).catch(e =>
      console.error('[Bus] subscribe failed:', e.message));
  }
  // Return the wrapped handler so the caller can unsubscribe cleanly later
  // — needed now that some callers (services/webTerminal.js) open one
  // channel per short-lived session rather than a handful of fixed,
  // permanent channels, and must tear each one down or both the local
  // EventEmitter's listener count and the Redis subscription list would
  // grow without bound as sessions come and go.
  return wrapped;
}

// Removes a single handler (the value subscribe() returned) from `channel`.
// Once no local listeners remain for that channel, also unsubscribes from
// Redis so `subscribedChannels`/the actual Redis SUBSCRIBE list don't leak.
function unsubscribe(channel, wrappedHandler) {
  local.removeListener(channel, wrappedHandler);
  if (subscriber && subscribedChannels.has(channel) && local.listenerCount(channel) === 0) {
    subscribedChannels.delete(channel);
    subscriber.unsubscribe(channel).catch(e =>
      console.error('[Bus] unsubscribe failed:', e.message));
  }
}

// Exposes the underlying Redis connection (already open, already managed by
// ioredis) for callers that need ordinary Redis commands — hashes, lists,
// TTLs — alongside pub/sub, instead of opening a second dedicated
// connection per caller. Returns null in the in-process fallback (no
// REDIS_URL), same as everywhere else in this module — callers MUST handle
// that case (see services/webTerminal.js: falls back to a plain in-memory
// Map when this is null, since without Redis you're single-process anyway
// and don't need cross-worker session sharing).
// NOTE: this is the `publisher` connection specifically — `subscriber` is in
// Redis's SUBSCRIBE mode and can't run other commands.
function getClient() {
  return publisher;
}

// ── Health introspection ──────────────────────────────────────────────────────
// Used by GET /api/health/full so "agent shows offline / no metrics" can be
// diagnosed from the app itself instead of grepping container logs. When
// mode is 'in-process-fallback', cross-worker metric/status sync is NOT
// happening at all — every clustered web worker only sees what its own
// process received directly, which is exactly the "agent sends metrics but
// dashboard shows it offline" symptom whenever the browser and the agent's
// most recent POST don't land on the same worker.
function getStatus() {
  if (!REDIS_URL) {
    return { mode: 'in-process-fallback', connected: false, reason: 'REDIS_URL not set' };
  }
  const ready = publisher?.status === 'ready' && subscriber?.status === 'ready';
  return {
    mode: 'redis',
    connected: ready,
    publisherStatus:  publisher?.status  || 'unknown',
    subscriberStatus: subscriber?.status || 'unknown',
    lastPublisherError,
    lastSubscriberError,
  };
}

module.exports = { publish, subscribe, unsubscribe, getClient, PROCESS_ID, getStatus };