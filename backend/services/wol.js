// services/wol.js — Wake-on-LAN magic packet sender
const wol = require('wol');

/**
 * Send a WoL magic packet to the given MAC address.
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

module.exports = { wake };