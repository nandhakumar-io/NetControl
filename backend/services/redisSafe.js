// services/redisSafe.js — the missing piece that made services/bulkCommand.js
// resilient to a misconfigured/unreachable Redis, now shared so every other
// Redis-backed session store (services/sshProxy.js, services/webTerminal.js)
// gets the same protection instead of each having its own copy — or, as was
// the actual case until now, no copy at all.
//
// The bug this fixes: `const redis = bus.getClient()` returns a real,
// non-null ioredis instance immediately, even if Redis is completely
// unreachable — ioredis connects lazily/retries in the background rather
// than failing fast. So `if (redis) { await redis.hgetall(...) }` looks
// like a safe check but isn't: it only confirms a client object exists, not
// that it can actually talk to anything. A stalled/unreachable Redis (we
// have direct evidence this can happen for extended periods — an 18.8-
// minute poller cycle turned up in production logs) means every one of
// those awaits just hangs, with no timeout and no fallback, freezing
// whatever feature depends on it — a bulk command run, an SSH terminal
// session, a web-relay terminal session — stuck indefinitely instead of
// degrading.
'use strict';

// Whether Redis is not just configured but actually reachable right now.
// bus.js already tracks this continuously (it pings/reconnects on its own)
// — reuse that instead of relying on the client object merely existing.
function redisReady(redis, bus) {
  return !!redis && bus.getStatus().connected === true;
}

// Wraps a Redis call so a slow/hung connection can't stall a caller
// forever — if it doesn't settle within `ms`, the caller's own try/catch
// falls back to an in-memory path for that operation instead of hanging.
function withRedisTimeout(promise, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Redis call timed out')), ms)),
  ]);
}

module.exports = { redisReady, withRedisTimeout };