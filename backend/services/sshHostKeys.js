// services/sshHostKeys.js — trust-on-first-use (TOFU) SSH host key pinning
//
// SECURITY FIX: every SSH connection in this app previously used
// `hostVerifier: () => true`, unconditionally accepting whatever host key
// the far end presented. That's the equivalent of a human always typing
// "yes" at the "authenticity of host X can't be established" prompt, every
// single time, with no memory of the answer — which means a
// man-in-the-middle anywhere between this server and a managed device (ARP
// spoofing on the LAN, a compromised switch/router, DNS hijack pointing the
// hostname at an attacker) can intercept SSH traffic — including the
// device's password/key credentials on connect, and every command's
// output — completely silently, with no way for an operator to ever notice.
//
// This implements the same trust model any SSH client's known_hosts file
// does: the first time we successfully connect to a device, we record the
// host key's fingerprint (devices.ssh_host_key_fingerprint). Every
// subsequent connection compares the presented key against that pinned
// fingerprint and REJECTS the connection if it differs — the same failure
// mode as a real SSH client's "REMOTE HOST IDENTIFICATION HAS CHANGED!"
// warning, instead of silently trusting whatever shows up.
//
// A changed fingerprint isn't always an attack (device reimage, OS
// reinstall, replaced hardware all legitimately rotate the host key) — but
// it should never be silently accepted. An admin can clear the pinned
// fingerprint (see devices.js PATCH endpoint) after confirming the change
// is expected, which re-arms TOFU for that device.
'use strict';
const crypto = require('crypto');
const { execute } = require('../db');

/**
 * Returns an ssh2 `hostVerifier` function bound to a specific device.
 * On first connect (no fingerprint stored yet), pins whatever key is
 * presented and allows the connection. On every subsequent connect,
 * compares against the pinned fingerprint and refuses on mismatch.
 *
 * ssh2 calls the verifier synchronously with the raw host key bytes and
 * expects a boolean back (or invokes the provided callback if the function
 * declares a second parameter — we use the sync form here since the
 * decision only needs an in-memory comparison; persisting a NEW pin on
 * first-connect is fired off async and doesn't block the handshake).
 */
function tofuVerifier(device) {
  return (hostKey) => {
    const fingerprint = crypto.createHash('sha256').update(hostKey).digest('base64');
    const pinned = device.ssh_host_key_fingerprint;

    if (!pinned) {
      // First time connecting to this device — trust and pin.
      execute(
        'UPDATE devices SET ssh_host_key_fingerprint = ? WHERE id = ? AND ssh_host_key_fingerprint IS NULL',
        [fingerprint, device.id]
      ).catch(e => console.error(`[SSH TOFU] Failed to pin host key for device ${device.id}:`, e.message));
      return true;
    }

    if (pinned !== fingerprint) {
      console.error(
        `[SSH TOFU] HOST KEY MISMATCH for device ${device.name || device.id} (${device.ip_address}) — ` +
        `expected ${pinned}, got ${fingerprint}. Refusing connection. If this device was legitimately ` +
        `reimaged/replaced, clear its pinned host key and reconnect to re-pin.`
      );
      return false;
    }

    return true;
  };
}

module.exports = { tofuVerifier };