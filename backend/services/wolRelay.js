// services/wolRelay.js — cross-subnet Wake-on-LAN relay
//
// PROBLEM: WoL magic packets are sent as link-local broadcasts
// (255.255.255.255 or a subnet broadcast like 192.168.1.255). Routers do not
// forward broadcast traffic between subnets, so a packet sent from wherever
// the NetControl SERVER happens to sit only ever reaches devices on that
// same L2 segment. A device on a different site/VLAN/subnet can never be
// woken this way, no matter what broadcast address is used.
//
// FIX: don't send the broadcast from the server. Relay the wake request to
// an already-online NetControl AGENT that lives on the *target's* subnet,
// and have that agent send the local broadcast itself, from inside the
// target's own L2 segment. This reuses the exact "pending job" pattern
// services/webTerminal.js already uses to hand terminal sessions to agents
// across a clustered, multi-worker backend (Redis-backed queue + bus.js
// pub/sub for the long-poll wake-up, falling back to an in-process
// EventEmitter when REDIS_URL isn't set).
'use strict';
const crypto = require('crypto');
const bus    = require('./bus');

const redis = bus.getClient();
const memQueues = new Map(); // relayDeviceId -> job[]  (single-process fallback)

const JOB_TTL_SEC = 60; // a queued job older than this is considered stale

function qKey(relayDeviceId) { return `wol:pending:${relayDeviceId}`; }

/**
 * Queue a wake job for a specific relay agent to execute locally.
 * @param {string} relayDeviceId — the agent device that will send the broadcast
 * @param {object} job — { mac, broadcastAddr, targetDeviceId, targetName }
 */
async function enqueueJob(relayDeviceId, job) {
  const payload = JSON.stringify({ ...job, queuedAt: Date.now() });
  if (redis) {
    await redis.rpush(qKey(relayDeviceId), payload);
    await redis.expire(qKey(relayDeviceId), JOB_TTL_SEC);
  } else {
    if (!memQueues.has(relayDeviceId)) memQueues.set(relayDeviceId, []);
    memQueues.get(relayDeviceId).push(JSON.parse(payload));
  }
  bus.publish(`wol:pending-ready:${relayDeviceId}`, {});
}

async function dequeueJob(relayDeviceId) {
  if (redis) {
    const raw = await redis.lpop(qKey(relayDeviceId));
    if (!raw) return null;
    const job = JSON.parse(raw);
    if (Date.now() - job.queuedAt > JOB_TTL_SEC * 1000) return dequeueJob(relayDeviceId); // stale, skip
    return job;
  }
  const q = memQueues.get(relayDeviceId);
  if (!q || !q.length) return null;
  const job = q.shift();
  if (Date.now() - job.queuedAt > JOB_TTL_SEC * 1000) return dequeueJob(relayDeviceId);
  return job;
}

/**
 * Long-poll wait for the next job destined for this relay agent.
 * Resolves with a job object, or null on timeout (agent should just poll again).
 */
function waitForJob(relayDeviceId, timeoutMs = 25000) {
  return new Promise(async (resolve) => {
    const already = await dequeueJob(relayDeviceId).catch(() => null);
    if (already) return resolve(already);

    let settled = false;
    const finish = async () => {
      if (settled) return;
      const job = await dequeueJob(relayDeviceId).catch(() => null);
      if (!job) return; // spurious wake, keep waiting until timeout
      settled = true;
      clearTimeout(timeout);
      bus.unsubscribe(`wol:pending-ready:${relayDeviceId}`, wrapped);
      resolve(job);
    };

    const wrapped = bus.subscribe(`wol:pending-ready:${relayDeviceId}`, finish);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      bus.unsubscribe(`wol:pending-ready:${relayDeviceId}`, wrapped);
      resolve(null);
    }, timeoutMs);
  });
}

function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

module.exports = { enqueueJob, dequeueJob, waitForJob, hashKey };