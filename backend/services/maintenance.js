// services/maintenance.js — the maintenance_mode flag (routes/devices.js's
// POST /:id/maintenance and /bulk-maintenance) already exists and already
// suppresses webhook alerts for a device (see services/webhook.js) and
// auto-clears on expiry (see services/statusPoller.js's sweep) — but until
// now nothing actually stopped anyone from waking, shutting down,
// restarting, or running commands against a device *while* it's flagged.
// This is the missing enforcement: one shared check, reused by every
// action entry point, so a device stays genuinely hands-off until someone
// explicitly marks it active/healthy again (or its maintenance_until
// expiry passes and the poller clears the flag automatically).
'use strict';

function isUnderMaintenance(device) {
  return !!(device && device.maintenance_mode);
}

// A short, specific reason — shown directly in the UI (single-device 409,
// or as this device's per-row "skipped" reason in a group/bulk run) so it
// reads as "here's why", not a generic permission error.
function maintenanceBlockedReason(device) {
  const note = device && device.maintenance_note ? `: ${device.maintenance_note}` : '';
  return `Under maintenance${note} — mark it active/healthy before running actions on it`;
}

module.exports = { isUnderMaintenance, maintenanceBlockedReason };