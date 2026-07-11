// services/wol.js — Wake-on-LAN magic packet sender
const wol = require('wol');
const { query } = require('../db');
const wolRelay = require('./wolRelay');

/**
 * Send a WoL magic packet to the given MAC address, broadcasting from
 * wherever THIS process (the NetControl server) happens to be network-wise.
 * Broadcast frames are never routed across subnets, so this only reaches
 * devices on the server's own L2 segment — kept as the direct/legacy path
 * and as the fallback when no relay agent is available (see wakeSmart).
 * @param {string} mac  — e.g. "AA:BB:CC:DD:EE:FF"
 * @param {string} [broadcastAddr] — subnet broadcast, e.g. "192.168.1.255"
 * @returns {Promise<void>}
 */
function wake(mac, broadcastAddr = '255.255.255.255') {
  return new Promise((resolve, reject) => {
    const opts = { address: broadcastAddr, port: 9 };
    wol.wake(mac, opts, (err) => {
      if (err) return reject(new Error(`WoL failed for ${mac}: ${err.message}`));
      resolve();
    });
  });
}

// First 3 octets of an IPv4 address — used as a cheap same-subnet heuristic
// for classic /24 LANs. Good enough to pick a relay candidate; it doesn't
// need to be exact, since a relay agent that guesses wrong just fails to
// wake the target and the operator falls back to the direct path.
function subnet24(ip) {
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip || '');
  return m ? m[1] : null;
}

function broadcastFor(ip) {
  const s = subnet24(ip);
  return s ? `${s}.255` : '255.255.255.255';
}

/**
 * Wake a device, relaying through an online agent on the target's own
 * subnet when one is available (so the broadcast actually reaches the
 * target instead of dying at the server's own router). Falls back to the
 * legacy direct-broadcast path if no suitable relay agent is found — which
 * only actually works if the server itself shares that subnet.
 * @param {{id:string, mac_address:string, ip_address:string, group_id:?string}} device
 * @returns {Promise<{ok:boolean, method:'relay'|'direct', relayAgent?:string}>}
 */
async function wakeSmart(device) {
  const targetSubnet = subnet24(device.ip_address);

  let relayAgent = null;
  if (targetSubnet) {
    // Prefer another device in the same group that's on the same /24 and
    // currently reporting in via the agent (agent_key_hash set, status
    // online) — that agent is physically on the target's L2 segment and
    // can broadcast locally.
    const candidates = await query(
      `SELECT id, name, ip_address FROM devices
       WHERE id != ? AND agent_key_hash IS NOT NULL AND status = 'online'
         AND ip_address LIKE ?`,
      [device.id, `${targetSubnet}.%`]
    );
    relayAgent = candidates[0] || null;
  }

  if (relayAgent) {
    await wolRelay.enqueueJob(relayAgent.id, {
      mac: device.mac_address,
      broadcastAddr: broadcastFor(device.ip_address),
      targetDeviceId: device.id,
      targetName: device.name,
    });
    return { ok: true, method: 'relay', relayAgent: relayAgent.name };
  }

  // No agent on that subnet — fall back to the server's own broadcast,
  // which only reaches the target if the server happens to share the LAN.
  await wake(device.mac_address, broadcastFor(device.ip_address));
  return { ok: true, method: 'direct' };
}

module.exports = { wake, wakeSmart };