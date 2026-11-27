#!/usr/bin/env node
/*
 * Deadline Countdown server.
 * Serves the pages in ./public and lets the admin page save config.js, behind a password.
 * No dependencies: needs Node.js 18 or newer.
 *
 * Environment variables:
 *   ADMIN_PASSWORD  Password for the admin page. Required to edit. Without it the site is read-only.
 *   PORT            Port to listen on (default 8080).
 *   HOST            Address to bind (default 0.0.0.0).
 *   DATA_DIR        Where config.js is stored (default ./data). Mount this as a volume.
 *   SESSION_HOURS   How long an admin sign-in lasts (default 12).
 *   TRUST_PROXY     Set to 1 when behind nginx or another reverse proxy, so the
 *                   client IP and https are read from X-Forwarded-* headers.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.js');
const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_MS = (+(process.env.SESSION_HOURS || 12)) * 3600 * 1000;
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const MAX_BODY = 1024 * 1024; // room for a custom logo inside the config

// Only these files are served; everything else is a 404.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/main.js': ['main.js', 'text/javascript; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/fonts/ibm-plex-sans-latin.woff2': ['fonts/ibm-plex-sans-latin.woff2', 'font/woff2'],
  '/fonts/ibm-plex-mono-500-latin.woff2': ['fonts/ibm-plex-mono-500-latin.woff2', 'font/woff2'],
  '/fonts/ibm-plex-mono-600-latin.woff2': ['fonts/ibm-plex-mono-600-latin.woff2', 'font/woff2'],
  '/fonts/OFL.txt': ['fonts/OFL.txt', 'text/plain; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/favicon.ico': ['favicon-32.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/site.webmanifest': ['site.webmanifest', 'application/manifest+json'],
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- config storage ----------
async function ensureConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { await fsp.access(CONFIG_FILE); }
  catch {
    await fsp.copyFile(path.join(PUBLIC_DIR, 'config.js'), CONFIG_FILE);
    log(`Created ${CONFIG_FILE} from the example config`);
  }
}

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const str = (v, max) => String(v ?? '').slice(0, max);

// Keep only known fields with sane values, so a bad request can't write junk into config.js
function cleanConfig(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.countdowns)) throw new Error('countdowns must be a list');
  if (c.countdowns.length > 500) throw new Error('too many countdowns');
  if (Array.isArray(c.holidays) && c.holidays.length > 2000) throw new Error('too many holidays');
  return {
    title: str(c.title || 'Deadline Countdown', 200),
    countdowns: c.countdowns.filter(t => t && typeof t === 'object')
      .map(t => ({ name: str(t.name, 200), date: isDate(t.date) ? t.date : '' })),
    holidays: (Array.isArray(c.holidays) ? c.holidays : []).filter(h => h && isDate(h.date))
      .map(h => ({ date: h.date, name: str(h.name, 200) || 'Holiday' })),
    nonWorkingDays: [...new Set((Array.isArray(c.nonWorkingDays) ? c.nonWorkingDays : [0, 6])
      .filter(n => Number.isInteger(n) && n >= 0 && n < 7))].sort(),
    countToday: !!c.countToday,
    countTargetDate: c.countTargetDate !== false,
    logo: typeof c.logo === 'string' && c.logo.length <= 400000 &&
      /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(c.logo) ? c.logo : '',
    adminPasswordHash: '',
    adminPasswordSalt: ''
  };
}

function configJS(cfg) {
  // JSON inside a <script>: escape "<" so no value can close the tag
  const json = JSON.stringify(cfg, null, 2).replace(/</g, '\\u003c');
  return '// Deadline Countdown settings. Edit this with admin.html, or by hand.\n' +
    '// Dates are YYYY-MM-DD. nonWorkingDays: 0 = Sunday ... 6 = Saturday.\n' +
    'window.COUNTDOWN_CONFIG = ' + json + ';\n';
}

async function writeConfig(cfg) {
  const tmp = CONFIG_FILE + '.tmp';
  try { await fsp.copyFile(CONFIG_FILE, CONFIG_FILE + '.bak'); } catch {}
  await fsp.writeFile(tmp, configJS(cfg), 'utf8');
  await fsp.rename(tmp, CONFIG_FILE);
}

// ---------- sessions and sign-in ----------
const sessions = new Map(); // token -> expiry time
const failures = new Map(); // ip -> { count, until }
// Overall limit across all IPs, so guesses can't be spread over many (real or faked) addresses
const GLOBAL_MAX_FAILURES = 20;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
let globalFailures = []; // timestamps of recent wrong passwords

// The visitor's IP, used for the wrong-password lockout and the log.
// Behind a proxy, take the address the proxy itself saw, never one the visitor could have written:
//  - Cloudflare (including Cloudflare Tunnel) sets CF-Connecting-IP to the real visitor address.
//  - nginx and most other proxies append the real address as the LAST entry of X-Forwarded-For;
//    earlier entries come from the visitor's own request and can be faked.
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
function clientIP(req) {
  const direct = req.socket.remoteAddress || '?';
  if (!TRUST_PROXY) return direct;
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (IP_RE.test(cf)) return cf;
  const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && IP_RE.test(last) ? last : direct;
}
const isHttps = req => !!req.socket.encrypted || (TRUST_PROXY && /https/i.test(req.headers['x-forwarded-proto'] || ''));

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function getSession(req) {
  const m = /(?:^|;\s*)dc_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return null; }
  return m[1];
}

function sessionCookie(req, token, maxAgeSec) {
  // No Path attribute: the cookie stays scoped to .../api/, which also works when nginx serves this under a sub-path
  return `dc_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, f] of failures) if (f.until < now) failures.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- HTTP helpers ----------
// Content-Security-Policy: the pages may only load scripts, styles, fonts and data from this site.
// Inline scripts and styles are refused, so injected markup can't run code.
// img-src allows data: (custom logos) and blob: (resizing an uploaded logo in the admin page).
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, SECURITY_HEADERS, extra || {}));
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', Object.assign({ 'Cache-Control': 'no-store' }, extra || {}));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Writes must come from this site's own pages (blocks cross-site form posts)
function sameOrigin(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
    return new URL(origin).host === host;
  } catch { return false; }
}

// ---------- routes ----------
async function handleApi(req, res, route) {
  if (route === '/api/session' && req.method === 'GET') {
    return json(res, 200, { mode: 'server', editable: !!PASSWORD, signedIn: !!getSession(req) });
  }

  if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Request blocked: it did not come from this site.' });

  if (route === '/api/login' && req.method === 'POST') {
    if (!PASSWORD) return json(res, 403, { error: 'Editing is turned off. Set the ADMIN_PASSWORD environment variable and restart the server.' });
    const ip = clientIP(req), f = failures.get(ip), now = Date.now();
    if (f && f.count >= 5 && f.until > now) {
      const wait = Math.ceil((f.until - now) / 1000);
      return json(res, 429, { error: `Too many wrong passwords. Try again in ${wait} seconds.` });
    }
    globalFailures = globalFailures.filter(t => t > now - GLOBAL_WINDOW_MS);
    if (globalFailures.length >= GLOBAL_MAX_FAILURES) {
      const wait = Math.ceil((globalFailures[0] + GLOBAL_WINDOW_MS - now) / 60000);
      return json(res, 429, { error: `Too many wrong passwords recently. Sign-in is paused for about ${wait} minute${wait === 1 ? '' : 's'}.` });
    }
    const body = await readBody(req);
    if (!passwordMatches(body.password || '')) {
      const n = (f && f.until > now ? f.count : 0) + 1;
      failures.set(ip, { count: n, until: now + Math.min(15 * 60, 2 ** Math.max(0, n - 4) * 30) * 1000 });
      globalFailures.push(now);
      if (globalFailures.length === GLOBAL_MAX_FAILURES) log(`${GLOBAL_MAX_FAILURES} wrong passwords in 15 minutes: pausing all sign-ins`);
      log(`Failed admin sign-in from ${ip}`);
      return json(res, 401, { error: 'That password is wrong.' });
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    log(`Admin signed in from ${ip}`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, Math.floor(SESSION_MS / 1000)) });
  }

  if (route === '/api/logout' && req.method === 'POST') {
    const t = getSession(req); if (t) sessions.delete(t);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '0'.repeat(64), 0) });
  }

  if (route === '/api/config' && req.method === 'PUT') {
    if (!getSession(req)) return json(res, 401, { error: 'Your sign-in has expired. Sign in again to save.' });
    const body = await readBody(req);
    let cfg;
    try { cfg = cleanConfig(body); } catch (e) { return json(res, 400, { error: 'The settings were not valid: ' + e.message }); }
    await writeConfig(cfg);
    log(`Config saved by ${clientIP(req)}: ${cfg.countdowns.length} countdowns, ${cfg.holidays.length} holidays`);
    return json(res, 200, { ok: true, config: cfg });
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  let route;
  try { route = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return send(res, 400, 'Bad request'); }
  try {
    if (route.startsWith('/api/')) return await handleApi(req, res, route);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', null, { Allow: 'GET, HEAD' });
    if (route === '/healthz') return send(res, 200, 'ok');
    if (route === '/config.js') {
      const data = await fsp.readFile(CONFIG_FILE);
      return send(res, 200, req.method === 'HEAD' ? '' : data, 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    const entry = STATIC[route];
    if (!entry) return send(res, 404, 'Not found');
    const data = await fsp.readFile(path.join(PUBLIC_DIR, entry[0]));
    return send(res, 200, req.method === 'HEAD' ? '' : data, entry[1], { 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.status === 413 ? 'The settings are too large.' : 'The request was not valid JSON.' });
    log('Error:', e);
    return send(res, 500, 'Server error');
  }
});

ensureConfig().then(() => {
  server.listen(PORT, HOST, () => {
    log(`Deadline Countdown on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
    if (!PASSWORD) log('ADMIN_PASSWORD is not set, so the admin page is read-only.');
  });
}).catch(e => { console.error('Could not prepare the data folder:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
