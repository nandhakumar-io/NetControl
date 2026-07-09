// services/slaReportService.js — Uptime/SLA math + PDF rendering.
//
// Uptime is derived from device_status_history (see services/statusPoller.js,
// which is the only writer of that table — one row per genuine online/
// offline transition, never per poll-tick). For a device and a [from, to)
// window:
//   1. Find the status the device was in immediately before `from` (the
//      most recent history row at or before `from`, or fall back to the
//      device's own created_at if it didn't exist yet at `from`).
//   2. Walk every transition inside the window in order, accumulating
//      seconds spent in each status.
//   3. Whatever status was last active carries through to `to` (or "now"
//      if `to` is in the future) since no further transition happened.
// "Uptime" counts 'online' seconds. Everything else (offline, unknown,
// needs_approval) counts as downtime — a device pending approval was, from
// the client's point of view, not delivering service either.
'use strict';

const fs   = require('fs');
const path = require('path');
const { query, queryOne, execute } = require('../db');

const REPORTS_DIR = path.resolve(process.env.SLA_REPORTS_DIR || path.resolve(__dirname, '..', 'sla-reports'));
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ── Per-device uptime for a window ───────────────────────────────────────────
async function computeDeviceUptime(device, fromSec, toSec) {
  const effectiveFrom = Math.max(fromSec, device.created_at || 0);
  if (effectiveFrom >= toSec) {
    // Device didn't exist yet for any part of this window.
    return { deviceId: device.id, name: device.name, uptimePct: null, uptimeSec: 0, downtimeSec: 0, windowSec: 0, incidents: 0, note: 'Not yet registered during this period' };
  }

  // Status immediately before the window starts.
  const priorRow = await queryOne(
    `SELECT new_status FROM device_status_history
      WHERE device_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1`,
    [device.id, effectiveFrom]
  );
  let currentStatus = priorRow ? priorRow.new_status : 'online'; // optimistic default: assume up until proven otherwise
  let cursor = effectiveFrom;

  const transitions = await query(
    `SELECT old_status, new_status, timestamp FROM device_status_history
      WHERE device_id = ? AND timestamp > ? AND timestamp < ? ORDER BY timestamp ASC`,
    [device.id, effectiveFrom, toSec]
  );

  let upSec = 0, downSec = 0, incidents = 0;
  for (const t of transitions) {
    const dur = t.timestamp - cursor;
    if (dur > 0) {
      if (currentStatus === 'online') upSec += dur; else downSec += dur;
    }
    if (currentStatus === 'online' && t.new_status !== 'online') incidents++;
    currentStatus = t.new_status;
    cursor = t.timestamp;
  }
  // Tail segment from the last transition (or window start) to `to`.
  const tailDur = toSec - cursor;
  if (tailDur > 0) {
    if (currentStatus === 'online') upSec += tailDur; else downSec += tailDur;
  }

  const windowSec = upSec + downSec;
  const uptimePct = windowSec > 0 ? (upSec / windowSec) * 100 : null;

  return {
    deviceId: device.id, name: device.name,
    uptimePct: uptimePct === null ? null : Math.round(uptimePct * 1000) / 1000,
    uptimeSec: upSec, downtimeSec: downSec, windowSec, incidents,
  };
}

// ── Build the full report dataset for an org/group/device scope ────────────
// scope: { type: 'org'|'group'|'device', id?: string }
async function buildReportData(orgId, { scope = 'org', scopeId = null, from, to }) {
  if (!from || !to || to <= from) throw new Error('Invalid period: `to` must be after `from`');

  let devices;
  if (scope === 'device') {
    devices = await query('SELECT id, name, ip_address, os_type, created_at FROM devices WHERE id = ? AND org_id = ?', [scopeId, orgId]);
    if (!devices.length) throw new Error('Device not found');
  } else if (scope === 'group') {
    devices = await query('SELECT id, name, ip_address, os_type, created_at FROM devices WHERE group_id = ? AND org_id = ? ORDER BY name', [scopeId, orgId]);
  } else {
    devices = await query('SELECT id, name, ip_address, os_type, created_at FROM devices WHERE org_id = ? ORDER BY name', [orgId]);
  }

  const perDevice = [];
  for (const d of devices) {
    perDevice.push(await computeDeviceUptime(d, from, to));
  }

  const withData = perDevice.filter(d => d.uptimePct !== null);
  const avgUptimePct = withData.length
    ? Math.round((withData.reduce((a, d) => a + d.uptimePct, 0) / withData.length) * 1000) / 1000
    : null;

  let scopeName = 'All devices';
  if (scope === 'group' && scopeId) {
    const g = await queryOne('SELECT name FROM `groups` WHERE id = ? AND org_id = ?', [scopeId, orgId]);
    scopeName = g ? g.name : 'Unknown group';
  } else if (scope === 'device' && scopeId) {
    scopeName = perDevice[0]?.name || 'Unknown device';
  }

  return {
    orgId, scope, scopeId, scopeName,
    periodStart: from, periodEnd: to,
    devices: perDevice, deviceCount: perDevice.length, avgUptimePct,
  };
}

// ── PDF rendering ────────────────────────────────────────────────────────────
function fmtDate(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0 && m === 0) return '<1m';
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
function slaBand(pct) {
  if (pct === null) return { label: 'No data', color: '#888888' };
  if (pct >= 99.9) return { label: 'Excellent', color: '#1a7f37' };
  if (pct >= 99.0) return { label: 'Good', color: '#2f6feb' };
  if (pct >= 95.0) return { label: 'At risk', color: '#b45309' };
  return { label: 'Breach', color: '#c0392b' };
}

async function renderPdf(reportData, orgName) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // ── Header ──
  doc.fontSize(20).fillColor('#111827').text('Uptime / SLA Report', { align: 'left' });
  doc.moveDown(0.2);
  doc.fontSize(11).fillColor('#4b5563').text(orgName || 'NetControl');
  doc.fontSize(10).fillColor('#6b7280').text(
    `Scope: ${reportData.scopeName}   |   Period: ${fmtDate(reportData.periodStart)} to ${fmtDate(reportData.periodEnd)}`
  );
  doc.moveDown(1);

  // ── Summary band ──
  const band = slaBand(reportData.avgUptimePct);
  doc.fontSize(13).fillColor('#111827').text('Summary', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor('#111827').text(`Devices covered: ${reportData.deviceCount}`);
  doc.fontSize(11).fillColor(band.color).text(
    `Average uptime: ${reportData.avgUptimePct !== null ? reportData.avgUptimePct.toFixed(3) + '%' : 'n/a'}  (${band.label})`
  );
  doc.moveDown(1);

  // ── Per-device table ──
  doc.fontSize(13).fillColor('#111827').text('Per-device breakdown', { underline: true });
  doc.moveDown(0.4);

  const colX = { name: 50, uptime: 260, downtime: 340, incidents: 430, status: 490 };
  const rowH = 18;
  function drawHeader(y) {
    doc.fontSize(9).fillColor('#6b7280');
    doc.text('Device', colX.name, y);
    doc.text('Uptime %', colX.uptime, y);
    doc.text('Downtime', colX.downtime, y);
    doc.text('Incidents', colX.incidents, y);
    doc.text('SLA', colX.status, y);
    doc.moveTo(50, y + 14).lineTo(545, y + 14).strokeColor('#e5e7eb').stroke();
  }

  let y = doc.y;
  drawHeader(y);
  y += 20;

  for (const d of reportData.devices) {
    if (y > 760) { doc.addPage(); y = 50; drawHeader(y); y += 20; }
    const b = slaBand(d.uptimePct);
    doc.fontSize(9).fillColor('#111827');
    doc.text(d.name, colX.name, y, { width: 200, ellipsis: true });
    doc.text(d.uptimePct !== null ? d.uptimePct.toFixed(3) + '%' : 'n/a', colX.uptime, y);
    doc.text(fmtDuration(d.downtimeSec), colX.downtime, y);
    doc.text(String(d.incidents), colX.incidents, y);
    doc.fillColor(b.color).text(b.label, colX.status, y);
    y += rowH;
  }

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#9ca3af').text(
    `Generated by NetControl on ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC. ` +
    `Uptime is measured from monitored status transitions and may not reflect brief gaps shorter than the polling interval.`,
    50, doc.page.height - 70, { width: 495 }
  );

  doc.end();
  return done;
}

async function generateReport({ orgId, orgName, scope, scopeId, from, to, userId, username }) {
  const { v4: uuidv4 } = require('uuid');
  const reportData = await buildReportData(orgId, { scope, scopeId, from, to });
  const pdfBuffer = await renderPdf(reportData, orgName);

  const id = uuidv4();
  const safeScope = (reportData.scopeName || 'report').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'report';
  const fileName = `sla-${safeScope}-${fmtDate(from)}_${fmtDate(to)}-${id.slice(0, 8)}.pdf`;
  const filePath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(filePath, pdfBuffer);

  await execute(
    `INSERT INTO sla_reports
       (id, org_id, scope_type, scope_id, scope_name, period_start, period_end,
        device_count, avg_uptime_pct, file_name, generated_by, generated_by_name, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, orgId, scope, scopeId || null, reportData.scopeName, from, to,
     reportData.deviceCount, reportData.avgUptimePct, fileName,
     userId || null, username || 'system', Math.floor(Date.now() / 1000)]
  );

  return { id, fileName, filePath, reportData };
}

function reportFilePath(fileName) {
  const p = path.resolve(REPORTS_DIR, fileName);
  if (p !== REPORTS_DIR && !p.startsWith(REPORTS_DIR + path.sep)) {
    throw new Error('Invalid report file path');
  }
  return p;
}

module.exports = {
  REPORTS_DIR,
  computeDeviceUptime,
  buildReportData,
  renderPdf,
  generateReport,
  reportFilePath,
};