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

const REDIS_URL = process.env.REDIS_URL || '';

let publisher = null;
let subscriber = null;
const local = new EventEmitter();
local.setMaxListeners(50);

if (REDIS_URL) {
  const Redis = require('ioredis');
  publisher  = new Redis(REDIS_URL, { lazyConnect: false });
  subscriber = new Redis(REDIS_URL, { lazyConnect: false });

  publisher.on('error',  e => console.error('[Bus] publisher error:', e.message));
  subscriber.on('error', e => console.error('[Bus] subscriber error:', e.message));

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
  if (publisher) {
    publisher.publish(channel, JSON.stringify(payload)).catch(e =>
      console.error('[Bus] publish failed:', e.message));
  } else {
    // Local fallback: still go through the emitter so subscribers get it
    // asynchronously, same as the Redis path would deliver it.
    setImmediate(() => local.emit(channel, payload));
  }
}

function subscribe(channel, handler) {
  local.on(channel, handler);
  if (subscriber && !subscribedChannels.has(channel)) {
    subscribedChannels.add(channel);
    subscriber.subscribe(channel).catch(e =>
      console.error('[Bus] subscribe failed:', e.message));
  }
}

module.exports = { publish, subscribe };