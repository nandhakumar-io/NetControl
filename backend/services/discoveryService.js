// services/discoveryService.js — Network discovery engine
//
// Methods supported (each independently toggleable per scan):
//   ping     — ICMP ping sweep (uses the OS `ping` binary; no raw sockets /
//              no root requirement, mirrors how statusPoller keeps things
//              simple and portable across Linux/Windows/macOS)
//   snmp     — SNMP v1/v2c sysDescr/sysName/sysObjectID probe
//   lldp_cdp — LLDP-MIB / CISCO-CDP-MIB neighbor table walk over SNMP
//              (requires `snmp` to also be enabled and to succeed for a host)
//   nmap     — TCP port scan (+ optional service/OS detection) via the
//              `nmap` binary, if installed on the server
//
// Every external process is invoked with execFile() and a fixed argument
// array — never a shell string — so there is no command-injection surface
// even though targets are attacker-adjacent (an authenticated admin choosing
// a subnet). Host IPs passed to ping/nmap are always ones *we* generated
// from a validated CIDR, never raw request input.
'use strict';

const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const snmp = require('net-snmp');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { lookupVendor } = require('./discoveryVendors');
const { encrypt, decrypt } = require('./crypto');
const audit = require('./audit');

// ── Tunables ─────────────────────────────────────────────────────────────────
const MAX_HOSTS          = 4096;   // hard cap on addresses in a single scan (~/20)
const PING_CONCURRENCY   = 32;
const PROBE_CONCURRENCY  = 8;      // snmp/lldp/nmap are heavier per-host
const PING_TIMEOUT_MS    = 1200;
const SNMP_TIMEOUT_MS    = 1500;
const NMAP_TIMEOUT_MS    = 45_000;
const MAX_NMAP_HOSTS     = 256;    // only scan ports on up to this many alive hosts per job
const NMAP_TOP_PORTS_MAX = 1000;

// ── Tiny concurrency-limited pool (mirrors the Semaphore in statusPoller.js) ─
class Semaphore {
  constructor(max) { this._max = max; this._cur = 0; this._q = []; }
  acquire() { return new Promise(r => { if (this._cur < this._max) { this._cur++; r(); } else this._q.push(r); }); }
  release() { this._cur--; if (this._q.length && this._cur < this._max) { this._cur++; this._q.shift()(); } }
}

async function mapWithConcurrency(items, limit, worker) {
  const sem = new Semaphore(limit);
  let results = new Array(items.length);
  await Promise.all(items.map(async (item, i) => {
    await sem.acquire();
    try { results[i] = await worker(item, i); }
    finally { sem.release(); }
  }));
  return results;
}

// ── CIDR expansion (IPv4 only) ────────────────────────────────────────────────
function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function intToIp(n) {
  return [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');
}

/**
 * Parse "192.168.1.0/24" or a bare "192.168.1.5" into a bounded list of host
 * IPs. Network/broadcast addresses are skipped for ranges wider than /31.
 * Throws a descriptive error for anything invalid or too large.
 */
function expandCidr(cidr) {
  const value = String(cidr || '').trim();
  const CIDR_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/(\d{1,2}))?$/;
  const m = value.match(CIDR_RE);
  if (!m) throw new Error('Invalid target — use an IPv4 address or CIDR range, e.g. 192.168.1.0/24');

  const base = ipToInt(m[1]);
  if (base === null) throw new Error('Invalid IPv4 address');

  const prefix = m[2] !== undefined ? parseInt(m[2], 10) : 32;
  if (prefix < 0 || prefix > 32) throw new Error('Invalid CIDR prefix (0-32)');

  // Cap the range: /20 = 4096 addresses is the largest we allow per scan.
  if (prefix < 20) throw new Error('Range too large — please use /20 or smaller (max 4096 hosts). Split larger networks into multiple scans.');

  const size = 2 ** (32 - prefix);
  const network = prefix === 32 ? base : (base & (~0 << (32 - prefix))) >>> 0;
  const hosts = [];

  if (prefix >= 31 || size <= 2) {
    for (let i = 0; i < size; i++) hosts.push(intToIp((network + i) >>> 0));
  } else {
    // Skip network (.0) and broadcast (.255-equivalent) addresses
    for (let i = 1; i < size - 1; i++) hosts.push(intToIp((network + i) >>> 0));
  }

  if (hosts.length > MAX_HOSTS) throw new Error(`Range too large (${hosts.length} hosts, max ${MAX_HOSTS})`);
  return hosts;
}

// ── ICMP ping sweep ───────────────────────────────────────────────────────────
function pingOnce(ip) {
  return new Promise((resolve) => {
    const isWin = os.platform() === 'win32';
    // -c/-n: one packet.  -W/-w: per-reply timeout (ms on Windows, s on *nix).
    const args = isWin
      ? ['-n', '1', '-w', String(PING_TIMEOUT_MS), ip]
      : ['-c', '1', '-W', String(Math.ceil(PING_TIMEOUT_MS / 1000)), ip];

    const start = Date.now();
    execFile('ping', args, { timeout: PING_TIMEOUT_MS + 1000 }, (err, stdout) => {
      const rtt = Date.now() - start;
      if (err) return resolve({ alive: false, rtt: null });
      // execFile resolves without error on non-zero exit for `ping` on some
      // platforms when host is unreachable but the binary itself ran fine —
      // double check the output actually shows a reply.
      const ok = isWin
        ? /Reply from/i.test(stdout) && !/Destination host unreachable/i.test(stdout)
        : /\d+ (bytes|received)/i.test(stdout) && !/100% packet loss/i.test(stdout) && !/0 (packets )?received/i.test(stdout);
      resolve({ alive: ok, rtt: ok ? rtt : null });
    });
  });
}

// ── ARP table lookup (best-effort — only works for hosts on a local subnet) ──
function lookupArpTable() {
  return new Promise((resolve) => {
    if (os.platform() === 'linux' && fs.existsSync('/proc/net/arp')) {
      try {
        const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
        const map = {};
        for (const line of lines) {
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 4 && cols[3] && cols[3] !== '00:00:00:00:00:00') {
            map[cols[0]] = cols[3].toUpperCase();
          }
        }
        return resolve(map);
      } catch { /* fall through to `arp -a` */ }
    }
    const isWin = os.platform() === 'win32';
    execFile('arp', ['-a'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      const re = isWin
        ? /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F-]{17})/g
        : /\(?(\d{1,3}(?:\.\d{1,3}){3})\)?\s+.*?(?:at|ether)\s+([0-9a-fA-F:]{17})/g;
      let mm;
      while ((mm = re.exec(stdout)) !== null) {
        map[mm[1]] = mm[2].toUpperCase().replace(/-/g, ':');
      }
      resolve(map);
    });
  });
}

// ── SNMP sysinfo probe ────────────────────────────────────────────────────────
const OID = {
  sysDescr:     '1.3.6.1.2.1.1.1.0',
  sysObjectID:  '1.3.6.1.2.1.1.2.0',
  sysUpTime:    '1.3.6.1.2.1.1.3.0',
  sysName:      '1.3.6.1.2.1.1.5.0',
  lldpRemSysName:  '1.0.8802.1.1.2.1.4.1.1.9',
  lldpRemPortDesc: '1.0.8802.1.1.2.1.4.1.1.8',
  cdpCacheDeviceId: '1.3.6.1.4.1.9.9.23.1.2.1.1.6',
  cdpCacheDevicePort: '1.3.6.1.4.1.9.9.23.1.2.1.1.7',
  cdpCachePlatform:   '1.3.6.1.4.1.9.9.23.1.2.1.1.8',
};

function openSnmpSession(ip, community) {
  return snmp.createSession(ip, community, {
    port: 161,
    retries: 0,
    timeout: SNMP_TIMEOUT_MS,
    version: snmp.Version2c,
  });
}

/** Try each candidate community string until one responds. */
function snmpProbe(ip, communities) {
  return new Promise((resolve) => {
    const tryNext = (idx) => {
      if (idx >= communities.length) return resolve(null);
      const community = communities[idx];
      const session = openSnmpSession(ip, community);
      const oids = [OID.sysDescr, OID.sysObjectID, OID.sysName];

      const finish = (result) => { try { session.close(); } catch {} resolve(result); };

      session.get(oids, (error, varbinds) => {
        if (error) { finish(null); return tryNext(idx + 1); }
        const bad = varbinds.some(vb => snmp.isVarbindError(vb));
        if (bad) { session.close(); return tryNext(idx + 1); }
        const val = (i) => varbinds[i] && varbinds[i].value != null ? varbinds[i].value.toString() : null;
        finish({
          community,
          sysDescr:    val(0),
          sysObjectID: val(1),
          sysName:     val(2),
        });
      });
    };
    tryNext(0);
  });
}

/** Walk LLDP-MIB and CISCO-CDP-MIB neighbor tables. Requires a working community string. */
function snmpNeighbors(ip, community) {
  return new Promise((resolve) => {
    const session = openSnmpSession(ip, community);
    const neighbors = [];
    let pending = 2;
    const maybeDone = () => { if (--pending <= 0) { try { session.close(); } catch {} resolve(neighbors); } };

    const lldpNames = {};
    session.walk(OID.lldpRemSysName, 20,
      (varbinds) => varbinds.forEach(vb => {
        if (!snmp.isVarbindError(vb)) lldpNames[vb.oid] = vb.value.toString();
      }),
      () => {
        for (const [oid, name] of Object.entries(lldpNames)) {
          neighbors.push({ protocol: 'lldp', name, port: null, source_oid: oid });
        }
        maybeDone();
      }
    );

    const cdpIds = {};
    const cdpPlatforms = {};
    session.walk(OID.cdpCacheDeviceId, 20,
      (varbinds) => varbinds.forEach(vb => { if (!snmp.isVarbindError(vb)) cdpIds[vb.oid] = vb.value.toString(); }),
      () => {
        session.walk(OID.cdpCachePlatform, 20,
          (varbinds) => varbinds.forEach(vb => { if (!snmp.isVarbindError(vb)) cdpPlatforms[vb.oid] = vb.value.toString(); }),
          () => {
            for (const [oid, deviceId] of Object.entries(cdpIds)) {
              neighbors.push({ protocol: 'cdp', name: deviceId, platform: cdpPlatforms[oid] || null, source_oid: oid });
            }
            maybeDone();
          }
        );
      }
    );
  });
}

// ── OS guess from SNMP sysDescr (cheap heuristic) ─────────────────────────────
function guessOsFromSysDescr(sysDescr) {
  if (!sysDescr) return null;
  const s = sysDescr.toLowerCase();
  if (s.includes('windows')) return 'Windows';
  if (s.includes('linux')) return 'Linux';
  if (s.includes('ios-xe') || s.includes('ios software') || s.includes('cisco ios')) return 'Cisco IOS';
  if (s.includes('junos')) return 'Juniper JunOS';
  if (s.includes('routeros') || s.includes('mikrotik')) return 'MikroTik RouterOS';
  if (s.includes('freebsd')) return 'FreeBSD';
  if (s.includes('vxworks')) return 'VxWorks';
  return null;
}

// ── nmap wrapper ───────────────────────────────────────────────────────────────
let _nmapAvailable = null;
function isNmapAvailable() {
  if (_nmapAvailable !== null) return Promise.resolve(_nmapAvailable);
  return new Promise((resolve) => {
    execFile('nmap', ['--version'], { timeout: 5000 }, (err) => {
      _nmapAvailable = !err;
      resolve(_nmapAvailable);
    });
  });
}

const fastXml = (() => { try { return require('fast-xml-parser'); } catch { return null; } })();

/**
 * Scan a single host with nmap. `opts` is a small whitelist of booleans/ints
 * only — never raw flag strings from the client — so there is no way to
 * smuggle extra nmap flags through this feature.
 */
function nmapScanHost(ip, opts = {}) {
  return new Promise((resolve) => {
    const args = ['-oX', '-', '--host-timeout', '20s'];

    if (opts.topPorts && Number.isInteger(opts.topPorts) && opts.topPorts > 0) {
      args.push('--top-ports', String(Math.min(opts.topPorts, NMAP_TOP_PORTS_MAX)));
    } else if (opts.ports && /^[0-9,\-]{1,100}$/.test(opts.ports)) {
      args.push('-p', opts.ports);
    } else {
      args.push('--top-ports', '100');
    }

    if (opts.serviceDetection) args.push('-sV');
    if (opts.osDetection) args.push('-O');
    args.push(ip);

    execFile('nmap', args, { timeout: NMAP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout || !fastXml) return resolve({ ports: [], osGuess: null });
      try {
        const parser = new fastXml.XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const doc = parser.parse(stdout);
        const host = doc?.nmaprun?.host;
        if (!host) return resolve({ ports: [], osGuess: null });

        let portList = host.ports?.port || [];
        if (!Array.isArray(portList)) portList = [portList];
        const ports = portList
          .filter(p => p.state?.['@_state'] === 'open')
          .map(p => ({
            port: parseInt(p['@_portid'], 10),
            proto: p['@_protocol'],
            service: p.service?.['@_name'] || null,
            product: p.service?.['@_product'] || null,
          }));

        let osGuess = null;
        const osMatch = host.os?.osmatch;
        const first = Array.isArray(osMatch) ? osMatch[0] : osMatch;
        if (first?.['@_name']) osGuess = first['@_name'];

        resolve({ ports, osGuess });
      } catch {
        resolve({ ports: [], osGuess: null });
      }
    });
  });
}

// ── Scan orchestrator ─────────────────────────────────────────────────────────

async function getScan(scanId) {
  return queryOne('SELECT * FROM discovery_scans WHERE id = ?', [scanId]);
}

async function isCancelled(scanId) {
  const row = await queryOne('SELECT cancel_requested FROM discovery_scans WHERE id = ?', [scanId]);
  return !row || !!row.cancel_requested;
}

async function upsertResult(scanId, ip, data) {
  const now = Math.floor(Date.now() / 1000);
  const existing = await queryOne(
    'SELECT id FROM discovery_results WHERE scan_id = ? AND ip_address = ?', [scanId, ip]
  );
  const payload = {
    mac_address:      data.mac || null,
    hostname:         data.hostname || null,
    vendor:           data.vendor || null,
    os_guess:         data.osGuess || null,
    response_time_ms: data.rtt ?? null,
    open_ports:       JSON.stringify(data.ports || []),
    snmp_sysdescr:    data.sysDescr || null,
    snmp_sysname:     data.sysName || null,
    snmp_sysobjectid: data.sysObjectID || null,
    neighbors:        JSON.stringify(data.neighbors || []),
    discovered_via:   JSON.stringify(data.via || []),
  };
  if (existing) {
    await execute(
      `UPDATE discovery_results SET mac_address=?, hostname=?, vendor=?, os_guess=?, response_time_ms=?,
       open_ports=?, snmp_sysdescr=?, snmp_sysname=?, snmp_sysobjectid=?, neighbors=?, discovered_via=?
       WHERE id = ?`,
      [...Object.values(payload), existing.id]
    );
  } else {
    await execute(
      `INSERT INTO discovery_results
        (id, scan_id, ip_address, mac_address, hostname, vendor, os_guess, response_time_ms,
         open_ports, snmp_sysdescr, snmp_sysname, snmp_sysobjectid, neighbors, discovered_via, discovered_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), scanId, ip, ...Object.values(payload), now]
    );
  }
}

/**
 * Run a discovery scan to completion. Meant to be fired-and-forgotten by the
 * route handler right after creating the `queued` scan row; progress and
 * results are polled by the frontend via GET endpoints.
 *
 * NOTE: this runs in-process in whichever cluster worker received the
 * request (same tradeoff as the SSE bus in server.js) — a scan does not
 * survive a worker restart. Acceptable for an interactive admin tool.
 */
async function runScan(scanId, { userId, username, ipSource } = {}) {
  const scan = await getScan(scanId);
  if (!scan) return;

  const methods = JSON.parse(scan.methods || '[]');
  const doPing    = methods.includes('ping');
  const doSnmp    = methods.includes('snmp');
  const doLldpCdp = methods.includes('lldp_cdp');
  const doNmap    = methods.includes('nmap');

  let communities = ['public'];
  if (scan.snmp_communities) {
    try { communities = JSON.parse(decrypt(scan.snmp_communities)) || communities; } catch { /* keep default */ }
  }
  const nmapOpts = scan.nmap_options ? JSON.parse(scan.nmap_options) : {};

  let hosts;
  try {
    hosts = expandCidr(scan.cidr);
  } catch (e) {
    await execute('UPDATE discovery_scans SET status=?, error=?, finished_at=? WHERE id=?',
      ['failed', e.message, Math.floor(Date.now() / 1000), scanId]);
    return;
  }

  await execute('UPDATE discovery_scans SET status=?, total_hosts=?, started_at=? WHERE id=?',
    ['running', hosts.length, Math.floor(Date.now() / 1000), scanId]);

  const nmapReady = doNmap && await isNmapAvailable();
  const arpTable = await lookupArpTable();

  let scannedCount = 0;
  let aliveCount = 0;
  let nmapUsed = 0;
  let cancelled = false;

  await mapWithConcurrency(hosts, doPing ? PING_CONCURRENCY : PROBE_CONCURRENCY, async (ip) => {
    if (cancelled) return;
    if (scannedCount % 10 === 0 && await isCancelled(scanId)) { cancelled = true; return; }

    const via = [];
    let alive = true;
    let rtt = null;

    if (doPing) {
      const pr = await pingOnce(ip);
      alive = pr.alive;
      rtt = pr.rtt;
      if (alive) via.push('ping');
    }

    // Only spend SNMP/nmap effort on hosts we believe are up (or when ping
    // was never run at all, since some hosts silently drop ICMP).
    if (!alive && doPing) { scannedCount++; return; }

    const mac = arpTable[ip] || null;
    const vendor = lookupVendor(mac);
    let sysDescr = null, sysName = null, sysObjectID = null, community = null;
    let neighbors = [];
    let ports = [];
    let osGuess = null;

    if (doSnmp) {
      const snmpResult = await snmpProbe(ip, communities);
      if (snmpResult) {
        via.push('snmp');
        sysDescr = snmpResult.sysDescr;
        sysName = snmpResult.sysName;
        sysObjectID = snmpResult.sysObjectID;
        community = snmpResult.community;
        osGuess = guessOsFromSysDescr(sysDescr);

        if (doLldpCdp) {
          try {
            neighbors = await snmpNeighbors(ip, community);
            if (neighbors.length) via.push('lldp_cdp');
          } catch { /* best-effort */ }
        }
      }
    }

    if (nmapReady && nmapUsed < MAX_NMAP_HOSTS) {
      nmapUsed++;
      const nmapResult = await nmapScanHost(ip, nmapOpts);
      if (nmapResult.ports.length) via.push('nmap');
      ports = nmapResult.ports;
      if (!osGuess && nmapResult.osGuess) osGuess = nmapResult.osGuess;
    }

    if (via.length > 0 || mac) {
      aliveCount++;
      await upsertResult(scanId, ip, {
        mac, vendor, hostname: sysName, sysDescr, sysName, sysObjectID,
        neighbors, ports, osGuess, rtt, via,
      });
    }

    scannedCount++;
    if (scannedCount % 5 === 0) {
      await execute('UPDATE discovery_scans SET scanned_hosts=?, alive_hosts=? WHERE id=?',
        [scannedCount, aliveCount, scanId]);
    }
  });

  const now = Math.floor(Date.now() / 1000);
  await execute('UPDATE discovery_scans SET status=?, scanned_hosts=?, alive_hosts=?, finished_at=? WHERE id=?',
    [cancelled ? 'cancelled' : 'completed', scannedCount, aliveCount, now, scanId]);

  await audit.log({
    userId, username, ipSource,
    action: cancelled ? 'discovery_scan_cancelled' : 'discovery_scan_completed',
    targetType: 'discovery_scan', targetId: scanId, targetName: scan.name,
    result: 'success',
    details: `${aliveCount}/${hosts.length} hosts responded`,
  });
}

module.exports = {
  expandCidr,
  runScan,
  isNmapAvailable,
  MAX_HOSTS,
  MAX_NMAP_HOSTS,
  NMAP_TOP_PORTS_MAX,
  encrypt, // re-exported for route convenience (communities encryption)
};
