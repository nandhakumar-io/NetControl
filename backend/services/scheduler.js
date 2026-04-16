// services/scheduler.js
const cron = require('node-cron');
const { query, execute } = require('../db');
const { decrypt } = require('./crypto');
const audit = require('./audit');

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
  const schedules = await query('SELECT * FROM schedules WHERE enabled = 1');
  let registered = 0;
  for (const s of schedules) {
    if (registerSchedule(s)) registered++;
  }
  console.log(`✅ Scheduler: loaded ${registered} active schedules`);
}

module.exports = { registerSchedule, unregisterSchedule, loadAllSchedules, executeScheduledAction };

