// services/agentRelease.js — the "one file the server hands out" for agent
// self-update. Deliberately NOT a tarball: the agent ships as a single
// script (agent/netcontrol-agent.js) plus a package.json only needed for
// its systeminformation dependency — the dependency itself doesn't change
// on every release, so shipping just the updated script is enough for the
// vast majority of updates and skips the entire tar/zlib complexity a full
// package re-install would need. If a future release ever needs a new npm
// dependency, that's a manual `--install` re-run, same as today.
'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const RELEASE_DIR  = path.resolve(process.env.AGENT_RELEASE_DIR || path.resolve(__dirname, '..', '..', 'data', 'agent-release'));
const SCRIPT_PATH  = path.join(RELEASE_DIR, 'netcontrol-agent.js');
const MANIFEST_PATH = path.join(RELEASE_DIR, 'release.json');

fs.mkdirSync(RELEASE_DIR, { recursive: true });

// Seed the release directory from the copy of the agent shipped in this
// repo (agent/netcontrol-agent.js) the first time the server starts and
// finds no release configured yet — so a fresh install already has a
// valid, matching release instead of agents getting "no update info"
// errors until an admin manually uploads one.
function seedIfEmpty() {
  if (fs.existsSync(MANIFEST_PATH)) return;
  try {
    const shippedScript = path.resolve(__dirname, '..', '..', 'agent', 'netcontrol-agent.js');
    const shippedPkg     = path.resolve(__dirname, '..', '..', 'agent', 'package.json');
    if (!fs.existsSync(shippedScript)) return; // nothing to seed from — fine, GET / just 404s until an admin uploads one
    const content = fs.readFileSync(shippedScript);
    const version = fs.existsSync(shippedPkg)
      ? (JSON.parse(fs.readFileSync(shippedPkg, 'utf8')).version || '0.0.0')
      : '0.0.0';
    fs.writeFileSync(SCRIPT_PATH, content);
    writeManifest({ version, notes: 'Initial release (seeded from repo)', sha256: sha256(content), uploaded_by: null });
    console.log(`[AgentRelease] Seeded initial release v${version} from agent/netcontrol-agent.js`);
  } catch (e) {
    console.warn('[AgentRelease] Seed skipped:', e.message);
  }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function writeManifest({ version, notes, sha256: hash, uploaded_by }) {
  const manifest = { version, notes: notes || '', sha256: hash, uploaded_by: uploaded_by || null, uploaded_at: Math.floor(Date.now() / 1000) };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

function getManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null; // no release configured yet
  }
}

function getScriptBuffer() {
  try {
    return fs.readFileSync(SCRIPT_PATH);
  } catch {
    return null;
  }
}

function saveRelease(buffer, { version, notes, uploaded_by }) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('version must be in x.y.z form (semver, no pre-release tags)');
  }
  fs.writeFileSync(SCRIPT_PATH, buffer);
  return writeManifest({ version, notes, sha256: sha256(buffer), uploaded_by });
}

// Numeric x.y.z comparison — good enough for this closed ecosystem (we
// control both the agent and the server release format), not worth pulling
// in the `semver` package for.
function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// What routes/metrics.js calls on every agent check-in — cheap (in-memory
// manifest read is effectively free; only re-touches disk if the file
// changed, which is rare/admin-driven).
function isUpdateAvailable(reportedVersion) {
  const manifest = getManifest();
  if (!manifest) return { update_available: false, latest_version: null };
  const available = !reportedVersion || compareVersions(manifest.version, reportedVersion) > 0;
  return { update_available: available, latest_version: manifest.version };
}

seedIfEmpty();

module.exports = { getManifest, getScriptBuffer, saveRelease, compareVersions, isUpdateAvailable, RELEASE_DIR };