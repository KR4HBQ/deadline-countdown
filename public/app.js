/* Deadline Countdown: shared logic for index.html and admin.html.
   No dependencies, no build step. Exposes window.Countdown. */
(function () {
  'use strict';
  const DAY = 86400000;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const now = new Date();
  // Whole days since 1970-01-01, in UTC, so daylight saving never shifts a count
  const TODAY = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY;

  const toDay = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3]) / DAY : null;
  };
  const toISO = d => new Date(d * DAY).toISOString().slice(0, 10);
  const fmt = d => new Date(d * DAY).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fmtShort = d => new Date(d * DAY).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const weekday = d => ((d % 7) + 11) % 7; // day 0 (1970-01-01) was a Thursday
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const DEFAULT_CONFIG = {
    title: 'Deadline Countdown',
    countdowns: [],
    holidays: [],
    nonWorkingDays: [0, 6],
    countToday: false,
    countTargetDate: true,
    logo: '',
    adminPasswordHash: '',
    adminPasswordSalt: ''
  };

  // A custom logo is stored inside the config as an image data URL (empty = the built-in icon)
  const LOGO_RE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
  const LOGO_MAX = 400000; // characters, about 300 KB of image
  const validLogo = s => typeof s === 'string' && s.length <= LOGO_MAX && LOGO_RE.test(s);

  // Shows the custom logo (or the default) in the header and as the browser tab icon
  function applyLogo(cfg, img) {
    const src = cfg.logo || 'favicon.svg';
    if (img) img.src = src;
    document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(l => {
      if (!l.dataset.orig) l.dataset.orig = l.getAttribute('href');
      l.href = cfg.logo || l.dataset.orig;
      if (l.rel === 'icon') { if (cfg.logo) l.removeAttribute('type'); else if (l.dataset.orig.endsWith('.svg')) l.type = 'image/svg+xml'; }
    });
  }

  // Fill in anything missing or malformed so the pages never crash on a hand-edited config
  function normalizeConfig(c) {
    c = c && typeof c === 'object' ? c : {};
    const out = Object.assign({}, DEFAULT_CONFIG);
    if (typeof c.title === 'string') out.title = c.title;
    if (Array.isArray(c.countdowns)) out.countdowns = c.countdowns
      .filter(t => t && typeof t === 'object')
      .map(t => ({ name: String(t.name ?? ''), date: toDay(t.date) !== null ? t.date : '' }));
    if (Array.isArray(c.holidays)) out.holidays = c.holidays
      .filter(h => h && toDay(h.date) !== null)
      .map(h => ({ date: h.date, name: String(h.name ?? '') || 'Holiday' }));
    if (Array.isArray(c.nonWorkingDays)) out.nonWorkingDays = c.nonWorkingDays.filter(n => Number.isInteger(n) && n >= 0 && n < 7);
    out.countToday = !!c.countToday;
    out.countTargetDate = c.countTargetDate !== false;
    out.logo = validLogo(c.logo) ? c.logo : '';
    if (typeof c.adminPasswordHash === 'string') out.adminPasswordHash = c.adminPasswordHash;
    if (typeof c.adminPasswordSalt === 'string') out.adminPasswordSalt = c.adminPasswordSalt;
    return out;
  }

  // Holiday text box <-> array. Accepts "2026-12-25 Name" or "12/25/2026, Name"; # lines are comments.
  function parseHolidayText(text) {
    const list = [], bad = [];
    String(text).split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      let m, d = null, rest = '';
      if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})[\s,;\t]*(.*)$/.exec(line))) { d = Date.UTC(+m[1], m[2] - 1, +m[3]); rest = m[4]; }
      else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[\s,;\t]*(.*)$/.exec(line))) { let y = +m[3]; if (y < 100) y += 2000; d = Date.UTC(y, m[1] - 1, +m[2]); rest = m[4]; }
      if (d === null || isNaN(d)) { bad.push(i + 1); return; }
      list.push({ date: toISO(d / DAY), name: rest.replace(/^["']|["']$/g, '').trim() || 'Holiday' });
    });
    list.sort((a, b) => a.date.localeCompare(b.date));
    return { list, bad };
  }
  const holidaysToText = list => list.map(h => `${h.date} ${h.name}`).join('\n');

  function countdown(targetISO, cfg, holMap) {
    const target = toDay(targetISO);
    if (target === null) return null;
    const cal = target - TODAY;
    const dir = cal >= 0 ? 1 : -1;
    let biz = 0; const hit = [];
    const start = cfg.countToday ? TODAY : TODAY + dir;
    const end = cfg.countTargetDate ? target : target - dir;
    if ((end - start) * dir >= 0) {
      for (let d = start; dir > 0 ? d <= end : d >= end; d += dir) {
        if (cfg.nonWorkingDays.includes(weekday(d))) continue;
        if (holMap.has(d)) { hit.push([d, holMap.get(d)]); continue; }
        biz++;
      }
    }
    return { target, cal, biz, hit };
  }

  const holidayMap = cfg => new Map(cfg.holidays.map(h => [toDay(h.date), h.name]));

  // Upcoming first (soonest at the top), then past ones (most recent first), then undated
  function sortForDisplay(list) {
    return list.slice().sort((a, b) => {
      const da = toDay(a.date), db = toDay(b.date);
      if (da === null || db === null) return (da === null) - (db === null);
      const pa = da < TODAY, pb = db < TODAY;
      if (pa !== pb) return pa - pb;
      return pa ? db - da : da - db;
    });
  }

  // Read-only card, used by the main page and the admin preview
  function cardHTML(t, cfg, holMap) {
    const r = countdown(t.date, cfg, holMap);
    const name = esc(t.name || 'Untitled');
    if (!r) return `<article class="card"><h2 class="cardname">${name}</h2><div class="meta">No date set</div></article>`;
    const past = r.cal < 0;
    const status = r.cal === 0 ? 'Today' : past ? `${-r.cal} day${r.cal === -1 ? '' : 's'} ago` : `${(r.cal / 7).toFixed(1)} weeks away`;
    const warn = holMap.has(r.target) ? ' · <span class="warn">falls on a holiday</span>'
      : cfg.nonWorkingDays.includes(weekday(r.target)) ? ' · <span class="warn">falls on a non-working day</span>' : '';
    const hol = r.hit.length
      ? `<details class="holtw"><summary><span class="tw" aria-hidden="true"></span>${r.hit.length} holiday${r.hit.length > 1 ? 's' : ''} excluded</summary><div class="chips">${r.hit.map(([d, n]) => `<span class="chip" title="${esc(fmt(d))}">${esc(fmtShort(d))} · ${esc(n)}</span>`).join('')}</div></details>`
      : '<div>No holidays in range</div>';
    return `<article class="card${past ? ' past' : ''}">
      <div style="display:grid;gap:2px"><h2 class="cardname">${name}</h2><div class="carddate">${esc(fmt(r.target))}${warn}</div></div>
      <div class="nums">
        <div class="num"><b>${Math.abs(r.cal)}</b><span>calendar days${past ? ' ago' : ''}</span></div>
        <div class="num biz"><b>${r.biz}</b><span>business days${past ? ' ago' : ''}</span></div>
      </div>
      <span class="status">${status}</span>
      <div class="meta">${hol}</div>
    </article>`;
  }

  // Renders cards and keeps each card's holiday twisty open/closed across re-renders
  function renderCards(container, cfg) {
    const openNames = new Set([...container.querySelectorAll('details.holtw[open]')].map(d => d.closest('.card').dataset.key));
    const holMap = holidayMap(cfg);
    const list = sortForDisplay(cfg.countdowns);
    container.innerHTML = list.map(t => cardHTML(t, cfg, holMap)).join('');
    [...container.children].forEach((card, i) => {
      const key = list[i].name + '|' + list[i].date;
      card.dataset.key = key;
      if (openNames.has(key)) { const d = card.querySelector('details'); if (d) d.open = true; }
    });
    return list.length;
  }

  // Auto / Light / Dark switch, remembered per browser
  function initTheme(seg) {
    const apply = t => {
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
      else document.documentElement.removeAttribute('data-theme');
      seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.t === t)));
    };
    let t = 'auto';
    try { t = localStorage.getItem('countdown-theme') || 'auto'; } catch (e) {}
    apply(t);
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      apply(b.dataset.t);
      try { localStorage.setItem('countdown-theme', b.dataset.t); } catch (e) {}
    }));
  }

  async function hashPassword(password, salt) {
    if (!window.crypto || !crypto.subtle) throw new Error('no-crypto');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + password));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const newSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

  window.Countdown = {
    DAY, DOW, TODAY, toDay, toISO, fmt, esc, DEFAULT_CONFIG, normalizeConfig,
    parseHolidayText, holidaysToText, countdown, holidayMap, sortForDisplay,
    renderCards, initTheme, hashPassword, newSalt, applyLogo, validLogo, LOGO_MAX
  };
})();
