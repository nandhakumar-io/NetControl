// services/mailer.js — Optional SMTP email delivery
//
// Every other notification channel in this app (Slack/Teams/generic
// webhooks, Telegram) is configured per-destination in the DB; email is
// different because it needs one shared SMTP relay, not a per-recipient
// endpoint. So this follows the same "gracefully absent" pattern already
// used for Google OAuth (services/auth.js googleEnabled()) — if SMTP_HOST
// isn't set, mailerEnabled() is false and callers skip email entirely
// rather than erroring, so the digest feature works with just a webhook
// and zero email setup, and email becomes available the moment SMTP_* env
// vars are added.
'use strict';
require('dotenv').config();

let _transporter = null;

function mailerEnabled() {
  return !!process.env.SMTP_HOST;
}

function getTransporter() {
  if (!mailerEnabled()) return null;
  if (_transporter) return _transporter;

  const nodemailer = require('nodemailer');
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true', // true for 465, false for 587/STARTTLS
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _transporter;
}

// Sends to a comma-separated recipient list. Returns { sent, reason } rather
// than throwing, so callers (the digest scheduler, SLA report scheduler)
// can record the outcome on their own row without the whole run failing
// just because mail bounced. `attachments` is passed straight through to
// nodemailer's own format (array of { filename, content }) — used by
// services/scheduledJobs.js's SLA report schedule to attach the generated PDF.
async function sendMail({ to, subject, text, html, attachments }) {
  if (!mailerEnabled()) return { sent: false, reason: 'SMTP is not configured (SMTP_HOST unset)' };
  const recipients = String(to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'No recipients' };

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'netcontrol@localhost',
      to: recipients.join(', '),
      subject,
      text,
      html,
      attachments,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = { mailerEnabled, sendMail };