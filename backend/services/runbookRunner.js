// services/runbookRunner.js — executes a stored "runbook action" (a
// reusable remediation command, e.g. "sudo systemctl restart nginx" or
// "arp -d *") against a device, and logs the outcome.
//
// This is the piece that turns alerting into actual auto-remediation:
// alert_rules.runbook_action_ids references rows in runbook_actions, and
// when a rule breaches (see routes/alerts.js -> performAlertActions),
// each referenced runbook is run here against the affected device.
'use strict';
const { queryOne, execute } = require('../db');
const { v4: uuidv4 } = require('uuid');
const ssh = require('./ssh');
const winrm = require('./winrm');

const MAX_TIMEOUT_SEC = 300; // hard ceiling regardless of what's configured

function withTimeout(promise, seconds, label) {
  const ms = Math.min(seconds || 30, MAX_TIMEOUT_SEC) * 1000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${seconds}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs a single runbook action against a device (device object must already
 * have decrypted _ssh_password/_ssh_key/_winrm_password fields — see
 * routes/actions.js loadDevice()).
 *
 * Returns { result: 'success'|'failure', output }
 */
async function runRunbook(runbook, device) {
  if (runbook.os_type !== 'any' && runbook.os_type !== device.os_type) {
    return { result: 'failure', output: `Runbook is for ${runbook.os_type}, device is ${device.os_type} — skipped` };
  }
  try {
    const exec = device.os_type === 'linux' ? ssh.execCommand : winrm.execCommand;
    const output = await withTimeout(
      exec(device, runbook.command),
      runbook.timeout_sec,
      `Runbook "${runbook.name}"`
    );
    return { result: 'success', output: typeof output === 'string' ? output.slice(0, 4000) : JSON.stringify(output).slice(0, 4000) };
  } catch (e) {
    return { result: 'failure', output: e.message };
  }
}

/**
 * Runs a runbook by id against a device, logs the attempt to
 * runbook_run_log, and returns the outcome. `triggeredBy` is a free-text
 * label ('alert rule: High CPU', a username, etc.) for the audit trail.
 */
async function runRunbookById(runbookId, device, { triggeredBy = 'system', ruleId = null } = {}) {
  const runbook = await queryOne('SELECT * FROM runbook_actions WHERE id = ?', [runbookId]);
  if (!runbook) return { result: 'failure', output: 'Runbook not found' };

  const outcome = await runRunbook(runbook, device);

  await execute(
    `INSERT INTO runbook_run_log (id, runbook_id, device_id, rule_id, triggered_by, result, output, ran_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())`,
    [uuidv4(), runbookId, device.id, ruleId, triggeredBy, outcome.result, outcome.output]
  ).catch(() => {});

  return { ...outcome, runbookName: runbook.name };
}

module.exports = { runRunbook, runRunbookById };