// services/uaParse.js — tiny, dependency-free User-Agent summarizer.
//
// Only used for human-readable display (session list, "new sign-in"
// notifications) — never for anything security-sensitive. Deliberately not
// a full UA-parsing library: just enough to turn a raw UA string into
// "Chrome on Windows" style text without adding a new dependency for what
// is ultimately a cosmetic string.
'use strict';

function parseUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return { browser: 'an unknown browser', os: 'an unknown device' };

  let browser = 'an unknown browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/CriOS\//.test(ua)) browser = 'Chrome'; // Chrome on iOS
  else if (/FxiOS\//.test(ua)) browser = 'Firefox'; // Firefox on iOS
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari';

  let os = 'an unknown device';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';

  return { browser, os };
}

/** "Chrome on Windows" / "an unknown browser on an unknown device" */
function describeUserAgent(ua) {
  const { browser, os } = parseUserAgent(ua);
  return `${browser} on ${os}`;
}

module.exports = { parseUserAgent, describeUserAgent };