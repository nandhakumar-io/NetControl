// services/geoLocate.js — best-effort, fully offline IP -> city/country
// lookup for human-readable text ("New sign-in from Chrome on Windows,
// Mumbai"). Uses geoip-lite's bundled MaxMind-derived database, so this
// never makes an outbound network call and never blocks a request on a
// third-party service being up — same "cosmetic string, not a security
// control" posture as services/uaParse.js.
//
// Deliberately NOT used for anything access-control related (that's
// services/ipAllowlist.js, which matches CIDRs exactly) — city-level geoip
// is approximate and updated periodically by the library, not something to
// gate auth decisions on.
'use strict';

const geoip = require('geoip-lite');

/** Strip the ::ffff: prefix geoip-lite doesn't understand, same normalisation ipAllowlist.js does. */
function normaliseIP(ip) {
  if (!ip) return null;
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^169\.254\./,
];

/**
 * Returns "City, Country" / "Country" / null. Never throws — geoip-lite's
 * lookup already returns null for unknown/private/reserved IPs, but this
 * also short-circuits obviously-private ranges and ::1/localhost so a
 * dev/LAN login doesn't show a misleading "location".
 */
function describeLocation(ip) {
  try {
    const norm = normaliseIP(ip);
    if (!norm || norm === '::1' || PRIVATE_RANGES.some(re => re.test(norm))) return null;

    const hit = geoip.lookup(norm);
    if (!hit) return null;

    const parts = [hit.city, hit.country].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  } catch {
    return null;
  }
}

module.exports = { describeLocation };