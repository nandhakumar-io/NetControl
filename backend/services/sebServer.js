// services/sebServer.js — thin client for the SEB Server 2.2 admin API.
//
// Only the three endpoints confirmed from the SEB Server source are used:
//   GET  {prefix}/monitoring/{examId}/fullpage
//   GET  {prefix}/monitoring/{examId}/{connectionToken}
//   POST {prefix}/monitoring/{examId}/instruction
//
// Everything deployment-specific is env-driven (see .env.example, "SEB Server"):
// base URL, API prefix, auth mode, and how the instruction body is encoded.
// Response parsing is deliberately tolerant — the monitoring payload's exact
// per-connection field names are NOT assumed beyond `tk` (connection token);
// the /api/seb/exams/:examId/connections preview endpoint shows what this
// module actually recognised so a mismatch is visible instead of silent.
'use strict';

const TERMINAL_STATUSES = new Set(['CLOSED', 'DISABLED']);
const KNOWN_STATUSES = new Set([
  'UNDEFINED', 'CONNECTION_REQUESTED', 'AUTHENTICATED', 'ACTIVE', 'CLOSED', 'DISABLED',
]);

class SebError extends Error {
  constructor(message, { status = null, code = 'SEB_ERROR' } = {}) {
    super(message);
    this.name = 'SebError';
    this.status = status;
    this.code = code;
  }
}

function cfg() {
  const prefixRaw = process.env.SEB_API_PREFIX ?? '/admin-api/v1';
  const prefix = prefixRaw ? '/' + prefixRaw.replace(/^\/+|\/+$/g, '') : '';
  return {
    baseUrl:      (process.env.SEB_SERVER_URL || '').replace(/\/+$/, ''),
    prefix,
    authMode:     (process.env.SEB_AUTH_MODE || (process.env.SEB_STATIC_TOKEN ? 'static' : 'password')).toLowerCase(),
    tokenPath:    process.env.SEB_TOKEN_PATH || '/oauth/token',
    clientId:     process.env.SEB_CLIENT_ID || '',
    clientSecret: process.env.SEB_CLIENT_SECRET || '',
    username:     process.env.SEB_USERNAME || '',
    password:     process.env.SEB_PASSWORD || '',
    staticToken:  process.env.SEB_STATIC_TOKEN || '',
    encoding:     (process.env.SEB_INSTRUCTION_ENCODING || 'json').toLowerCase(), // json | form
    timeoutMs:    parseInt(process.env.SEB_HTTP_TIMEOUT_MS) || 10000,
  };
}

function isConfigured() {
  const c = cfg();
  if (!c.baseUrl) return false;
  if (c.authMode === 'static') return !!c.staticToken;
  if (c.authMode === 'client_credentials') return !!(c.clientId && c.clientSecret);
  return !!(c.clientId && c.clientSecret && c.username && c.password); // password grant
}

// ── OAuth2 token cache ───────────────────────────────────────────────────────
let _token = null; // { value, expiresAt }

async function fetchJson(url, opts, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    throw new SebError(
      timedOut ? `SEB Server did not respond within ${Math.round(timeoutMs / 1000)}s`
               : `SEB Server unreachable: ${e.cause?.code || e.message}`,
      { code: timedOut ? 'SEB_TIMEOUT' : 'SEB_UNREACHABLE' }
    );
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { res, data };
}

async function getAccessToken(force = false) {
  const c = cfg();
  if (c.authMode === 'static') return c.staticToken;
  if (!force && _token && _token.expiresAt > Date.now() + 15000) return _token.value;

  const form = new URLSearchParams();
  if (c.authMode === 'client_credentials') {
    form.set('grant_type', 'client_credentials');
  } else {
    form.set('grant_type', 'password');
    form.set('username', c.username);
    form.set('password', c.password);
  }
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const { res, data } = await fetchJson(`${c.baseUrl}${c.tokenPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  }, c.timeoutMs);

  if (!res.ok || !data?.access_token) {
    throw new SebError(
      `SEB Server authentication failed (HTTP ${res.status})${data?.error_description ? `: ${data.error_description}` : ''}`,
      { status: res.status, code: 'SEB_AUTH' }
    );
  }
  _token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 300) * 1000 };
  return _token.value;
}

async function request(method, path, { json, form } = {}, _retried = false) {
  const c = cfg();
  if (!isConfigured()) throw new SebError('SEB Server integration is not configured (see SEB_* env vars)', { code: 'SEB_NOT_CONFIGURED' });

  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; }

  const { res, data } = await fetchJson(`${c.baseUrl}${c.prefix}${path}`, { method, headers, body }, c.timeoutMs);

  if (res.status === 401 && !_retried && c.authMode !== 'static') {
    _token = null;
    await getAccessToken(true);
    return request(method, path, { json, form }, true);
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.messages?.[0]?.systemMessage || data.message || data.error)) || `HTTP ${res.status}`;
    throw new SebError(`SEB Server ${method} ${path} failed: ${msg}`, { status: res.status, code: res.status === 404 ? 'SEB_NOT_FOUND' : 'SEB_HTTP' });
  }
  return data;
}

// ── Tolerant response parsing ────────────────────────────────────────────────
function flatStrings(obj, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 1) return out;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatStrings(v, depth + 1, out);
  }
  return out;
}

function normalizeConnection(c) {
  if (!c || typeof c !== 'object') return null;
  const token = c.tk ?? c.connectionToken ?? c.connection_token ?? null;
  if (!token) return null;
  const values = flatStrings(c);
  let status = String(c.st ?? c.cs ?? c.status ?? c.connectionStatus ?? '').toUpperCase();
  if (!KNOWN_STATUSES.has(status)) {
    status = values.map(v => v.toUpperCase()).find(v => KNOWN_STATUSES.has(v)) || 'UNKNOWN';
  }
  return { token: String(token), status, values, raw: c };
}

function extractConnections(payload) {
  const cons = payload?.monitoringConnectionData?.cons
            ?? payload?.cons
            ?? [];
  return (Array.isArray(cons) ? cons : []).map(normalizeConnection).filter(Boolean);
}

async function getMonitoring(examId) {
  const data = await request('GET', `/monitoring/${encodeURIComponent(examId)}/fullpage`);
  return extractConnections(data);
}

async function getConnection(examId, connectionToken) {
  const data = await request('GET', `/monitoring/${encodeURIComponent(examId)}/${encodeURIComponent(connectionToken)}`);
  // Accept either a bare connection object or one wrapped in a container.
  const direct = normalizeConnection(data);
  if (direct) return direct;
  for (const v of Object.values(data || {})) {
    const n = normalizeConnection(v);
    if (n) return n;
  }
  return null;
}

async function registerQuit(examId, connectionToken) {
  const instruction = { examId: String(examId), connectionToken, type: 'SEB_QUIT', attributes: {} };
  const c = cfg();
  if (c.encoding === 'form') {
    return request('POST', `/monitoring/${encodeURIComponent(examId)}/instruction`, {
      form: { examId: instruction.examId, connectionToken, type: 'SEB_QUIT', attributes: '' },
    });
  }
  return request('POST', `/monitoring/${encodeURIComponent(examId)}/instruction`, { json: instruction });
}

// ── Matching NetControl devices to SEB connections ───────────────────────────
// Strong match: any recognised connection field equals the device IP.
// Weak match: any field equals the device hostname / name (case-insensitive).
const STATUS_RANK = { ACTIVE: 0, AUTHENTICATED: 1, CONNECTION_REQUESTED: 2, UNDEFINED: 3, UNKNOWN: 4, CLOSED: 5, DISABLED: 6 };

function bestByStatus(list) {
  return list.slice().sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))[0];
}

// Returns { con, by } where by is 'binding' | 'binding_miss' | 'ip' | 'hostname' | null.
// A device with an explicit seb_match_key is matched ONLY on it — no silent
// fallback to IP/hostname, so a stale binding is reported instead of quitting
// whatever else happens to share the address.
function matchConnectionDetailed(device, connections) {
  const key = (device.seb_match_key || '').trim().toLowerCase();
  if (key) {
    const hits = connections.filter(c => c.values.some(v => v.toLowerCase() === key));
    return hits.length ? { con: bestByStatus(hits), by: 'binding' } : { con: null, by: 'binding_miss' };
  }
  const ip = (device.ip_address || '').trim();
  const names = [device.hostname, device.name].filter(Boolean).map(n => String(n).trim().toLowerCase());
  const byIp = ip ? connections.filter(c => c.values.some(v => v === ip || v.startsWith(`${ip}:`) || v === `/${ip}`)) : [];
  if (byIp.length) return { con: bestByStatus(byIp), by: 'ip' };
  const byName = names.length ? connections.filter(c => c.values.some(v => names.includes(v.toLowerCase()))) : [];
  if (byName.length) return { con: bestByStatus(byName), by: 'hostname' };
  return { con: null, by: null };
}

function matchConnection(device, connections) {
  return matchConnectionDetailed(device, connections).con;
}

function isTerminal(status) { return TERMINAL_STATUSES.has(status); }

module.exports = {
  SebError, isConfigured, getMonitoring, getConnection, registerQuit,
  matchConnection, matchConnectionDetailed, isTerminal, TERMINAL_STATUSES,
  // exposed for the config endpoint (never includes secrets)
  publicConfig: () => { const c = cfg(); return { serverUrl: c.baseUrl, apiPrefix: c.prefix, authMode: c.authMode, instructionEncoding: c.encoding }; },
};