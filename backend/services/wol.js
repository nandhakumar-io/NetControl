// services/wol.js — Wake-on-LAN magic packet sender
const os = require('os');
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

// /24s of every IPv4 interface on THIS machine (the NetControl server
// process itself) — used to answer "is the target already on a subnet the
// server can broadcast into directly?" before we bother looking for a
// relay agent. Computed fresh on every call (interfaces can change, and
// this is cheap) rather than cached at module load.
function localSubnets() {
  const out = new Set();
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const s = subnet24(iface.address);
        if (s) out.add(s);
      }
    }
  }
  return out;
}

/**
 * Wake a device. Order of operations, matching how a real WoL relay setup
 * has to behave since broadcast frames never cross a router:
 *   1. Same subnet as the server itself? The server's own broadcast reaches
 *      it directly — send it straight away, no relay needed.
 *   2. Otherwise, is there an online agent (any device with a checked-in
 *      agent) sitting on the TARGET's subnet? Relay the job to it so the
 *      magic packet is broadcast from inside that device's own L2 segment,
 *      exactly as if that agent's machine had initiated the wake itself.
 *   3. No agent there either — fall back to the server's own broadcast as
 *      a last resort (kept for parity with the old behavior; it will only
 *      actually land if some intermediate hop still permits it).
 * @param {{id:string, mac_address:string, ip_address:string, group_id:?string}} device
 * @returns {Promise<{ok:boolean, method:'direct'|'relay', relayAgent?:string}>}
 */
async function wakeSmart(device) {
  if (!device.mac_address) {
    throw new Error('No MAC address configured for this device — cannot send Wake-on-LAN');
  }
  const targetSubnet = subnet24(device.ip_address);

  // Step 1: server and target share a /24 — plain direct broadcast works,
  // skip the relay lookup entirely.
  if (targetSubnet && localSubnets().has(targetSubnet)) {
    await wake(device.mac_address, broadcastFor(device.ip_address));
    return { ok: true, method: 'direct' };
  }

  // Step 2: look for any other agent-equipped device already checked in
  // (online) on the target's subnet, so it can broadcast locally on the
  // target's behalf.
  let relayAgent = null;
  if (targetSubnet) {
    // Prefer another device in the same group that's on the same /24 and
    // currently reporting in via the agent (agent_key_hash set, status
    // online) — that agent is physically on the target's L2 segment and
    // can broadcast locally. Falls back to ANY online agent on that same
    // subnet regardless of group if no same-group candidate exists — group
    // is just a preference (keeps the relay "close" organizationally when
    // possible), not a hard requirement, since what actually matters for
    // an L2 broadcast to reach the target is the subnet, not the group.
    const sameGroupCandidates = device.group_id
      ? await query(
          `SELECT id, name, ip_address FROM devices
           WHERE id != ? AND agent_key_hash IS NOT NULL AND status = 'online'
             AND ip_address LIKE ? AND group_id = ?`,
          [device.id, `${targetSubnet}.%`, device.group_id]
        )
      : [];

    relayAgent = sameGroupCandidates[0] || null;

    if (!relayAgent) {
      const anyCandidates = await query(
        `SELECT id, name, ip_address FROM devices
         WHERE id != ? AND agent_key_hash IS NOT NULL AND status = 'online'
           AND ip_address LIKE ?`,
        [device.id, `${targetSubnet}.%`]
      );
      relayAgent = anyCandidates[0] || null;
    }
  }

  if (relayAgent) {
    // Use the limited broadcast address (255.255.255.255) rather than a
    // guessed subnet broadcast here. The relay agent is physically on the
    // target's L2 segment, so 255.255.255.255 is always valid there and is
    // flooded to the local segment unconditionally by the OS - no ARP
    // lookup, no dependency on guessing the right netmask. A guessed /24
    // broadcast (e.g. "192.168.1.255") is WRONG on any network that isn't
    // a clean /24 - the OS then treats it as a plain unicast destination,
    // tries to ARP-resolve it, gets no reply, and silently drops the
    // packet before it ever becomes a broadcast frame on the wire.
    await wolRelay.enqueueJob(relayAgent.id, {
      mac: device.mac_address,
      broadcastAddr: '255.255.255.255',
      targetDeviceId: device.id,
      targetName: device.name,
    });
    return { ok: true, method: 'relay', relayAgent: relayAgent.name };
  }

  // Step 3: no agent on that subnet either — fall back to the server's own
  // broadcast, which will only actually land if some intermediate network
  // hop still lets it through (kept for parity with the legacy behavior).
  await wake(device.mac_address, broadcastFor(device.ip_address));
  return { ok: true, method: 'direct' };
}

/**
 * Read-only version of wakeSmart()'s routing decision — same subnet/relay
 * lookup, but never sends a packet or queues a relay job. Lets the UI show
 * "Wake-capable via: <agent>" (or "direct" / "no path") per device up front,
 * instead of the operator only finding out a relay path doesn't exist after
 * clicking Wake and getting a fallback "direct" result that silently never
 * reaches the device.
 * @param {{id:string, ip_address:string, group_id:?string}} device
 * @returns {Promise<{method:'direct'|'relay'|'none', relayAgent?:{id:string,name:string}}>}
 */
async function checkEligibility(device) {
  // No MAC at all means wake can never be attempted, regardless of subnet —
  // surface that up front rather than only after a bulk wake fails.
  if (!device.mac_address) return { method: 'none', reason: 'no_mac' };

  const targetSubnet = subnet24(device.ip_address);

  if (targetSubnet && localSubnets().has(targetSubnet)) {
    return { method: 'direct' };
  }

  if (!targetSubnet) return { method: 'none', reason: 'no_ip' };

  const sameGroupCandidates = device.group_id
    ? await query(
        `SELECT id, name FROM devices
         WHERE id != ? AND agent_key_hash IS NOT NULL AND status = 'online'
           AND ip_address LIKE ? AND group_id = ?`,
        [device.id, `${targetSubnet}.%`, device.group_id]
      )
    : [];

  let relayAgent = sameGroupCandidates[0] || null;
  if (!relayAgent) {
    const anyCandidates = await query(
      `SELECT id, name FROM devices
       WHERE id != ? AND agent_key_hash IS NOT NULL AND status = 'online'
         AND ip_address LIKE ?`,
      [device.id, `${targetSubnet}.%`]
    );
    relayAgent = anyCandidates[0] || null;
  }

  return relayAgent ? { method: 'relay', relayAgent } : { method: 'none', reason: 'no_relay' };
}

module.exports = { wake, wakeSmart, checkEligibility };