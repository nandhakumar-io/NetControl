// services/scheduler.js
const cron = require('node-cron');
const { query, execute } = require('../db');
const { decrypt } = require('./crypto');
const audit = require('./audit');
const webhook = require('./webhook');

const activeTasks = new Map();

function buildDevice(row) {
  return {
    ...row,
    _ssh_password:   decrypt(row.ssh_password),
    _ssh_key:        decrypt(row.ssh_key),
    _winrm_password: decrypt(row.winrm_password),
  };
}

async function executeScheduledAction(schedule) {
  let devices = [];

  if (schedule.target_type === 'device') {
    const rows = await query('SELECT * FROM devices WHERE id = ?', [schedule.target_id]);
    devices = rows;
  } else {
    devices = await query('SELECT * FROM devices WHERE group_id = ?', [schedule.target_id]);
  }

  if (!devices.length) return;

  for (const device of devices) {
    const built = buildDevice(device);
    let result = 'success';
    let details = '';
    try {
      if (schedule.action === 'wake') {
        const { wake } = require('./wol');
        await wake(device.mac_address);
      } else if (schedule.action === 'shutdown') {
        if (device.os_type === 'linux') await require('./ssh').shutdown(built);
        else await require('./winrm').shutdown(built);
      } else if (schedule.action === 'restart') {
        if (device.os_type === 'linux') await require('./ssh').restart(built);
        else await require('./winrm').restart(built);
      }
    } catch (e) {
      result = 'failure';
      details = e.message;
    }

    await audit.log({
      username: 'scheduler',
      action: `scheduled_${schedule.action}`,
      targetType: 'device',
      targetId: device.id,
      targetName: device.name,
      ipSource: 'scheduler',
      result,
      details: details || `Schedule: ${schedule.name}`,
    });

    // Previously this whole schedule engine was silent besides the audit
    // log — no webhook fired, so there was no way to get, say, a Telegram
    // ping when a nightly "restart the build agents" schedule failed on
    // one machine. Fired per-device so a partial failure (5 of 6 devices
    // restarted fine) doesn't get hidden in a single rolled-up message.
    if (result === 'success') {
      webhook.fire('schedule.action_succeeded', {
        schedule: schedule.name, device_id: device.id, device_name: device.name,
        action: schedule.action, severity: 'info',
        message: `Schedule "${schedule.name}" ran ${schedule.action} on ${device.name}`,
      }).catch(() => {});
    } else {
      webhook.fire('schedule.action_failed', {
        schedule: schedule.name, device_id: device.id, device_name: device.name,
        action: schedule.action, error: details, severity: 'warning',
        message: `Schedule "${schedule.name}" failed to ${schedule.action} ${device.name}: ${details}`,
      }).catch(() => {});
    }
  }

  await execute('UPDATE schedules SET last_run = ? WHERE id = ?',
    [Math.floor(Date.now() / 1000), schedule.id]);
}

function registerSchedule(schedule) {
  if (!cron.validate(schedule.cron_expr)) {
    console.warn(`Invalid cron for "${schedule.name}": ${schedule.cron_expr}`);
    return false;
  }

  if (activeTasks.has(schedule.id)) {
    activeTasks.get(schedule.id).stop();
    activeTasks.delete(schedule.id);
  }

  if (!schedule.enabled) return true;

  const task = cron.schedule(schedule.cron_expr, () => {
    executeScheduledAction(schedule).catch(console.error);
  }, { timezone: 'Asia/Kolkata' });

  activeTasks.set(schedule.id, task);
  return true;
}

function unregisterSchedule(scheduleId) {
  if (activeTasks.has(scheduleId)) {
    activeTasks.get(scheduleId).stop();
    activeTasks.delete(scheduleId);
  }
}

async function loadAllSchedules() {
  let schedules;
  try {
    schedules = await query('SELECT * FROM schedules WHERE enabled = 1');
  } catch (e) {
    console.error('[Scheduler] Failed to load schedules — will retry on next call:', e.message);
    return;
  }
  let registered = 0;
  for (const s of schedules) {
    if (registerSchedule(s)) registered++;
  }
  console.log(`✅ Scheduler: loaded ${registered} active schedules`);
}

module.exports = { registerSchedule, unregisterSchedule, loadAllSchedules, executeScheduledAction };