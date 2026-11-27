/* Deadline Countdown: admin page script. Needs config.js and app.js loaded first. */
(function () {
  const C = window.Countdown;
  const $ = id => document.getElementById(id);
  C.initTheme($('themeSeg'));

  let published = C.normalizeConfig(window.COUNTDOWN_CONFIG);
  C.applyLogo(published, $('logo'));
  // "server" when running under server.js (saves directly), "static" on any plain web host (download a new config.js)
  let mode = 'static', serverEditable = false;
  const api = (p, opts) => fetch('api/' + p, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts));
  const DRAFT_KEY = 'countdown-admin-draft', AUTH_KEY = 'countdown-admin-auth';
  let cfg, holText;

  // ---------- draft ----------
  function loadDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) {}
    if (d && d.cfg) { cfg = C.normalizeConfig(d.cfg); holText = typeof d.holText === 'string' ? d.holText : C.holidaysToText(cfg.holidays); }
    else { cfg = structuredClone(published); holText = C.holidaysToText(cfg.holidays); }
  }
  const same = (a, b) => JSON.stringify(C.normalizeConfig(a)) === JSON.stringify(C.normalizeConfig(b));
  function saveDraft() {
    try {
      if (same(cfg, published)) localStorage.removeItem(DRAFT_KEY);
      else localStorage.setItem(DRAFT_KEY, JSON.stringify({ cfg, holText }));
    } catch (e) {}
    updateBanner();
  }

  // ---------- sign in ----------
  const hasPassword = () => !!published.adminPasswordHash;
  function showLogin() {
    $('editor').hidden = true; $('loginForm').hidden = false;
    if (mode === 'server') {
      $('loginTitle').textContent = 'Sign in';
      $('pw2Field').hidden = true;
      $('pw1Label').textContent = 'Password';
      $('pw1').autocomplete = 'current-password';
      $('loginBtn').textContent = 'Sign in';
      $('loginHelp').textContent = serverEditable
        ? 'Enter the admin password to edit the countdowns.'
        : 'Editing is turned off on this server. Set the ADMIN_PASSWORD environment variable and restart it.';
      $('pw1').disabled = $('loginBtn').disabled = !serverEditable;
      $('pw1').focus();
      return;
    }
    const setup = !hasPassword();
    $('loginTitle').textContent = setup ? 'Set an admin password' : 'Sign in';
    $('loginHelp').textContent = setup
      ? 'No admin password is set yet. Choose one; it takes effect once you publish the new config.js.'
      : 'Enter the admin password to edit the countdowns.';
    $('pw1Label').textContent = setup ? 'New password' : 'Password';
    $('pw1').autocomplete = setup ? 'new-password' : 'current-password';
    $('pw2Field').hidden = !setup;
    $('loginBtn').textContent = setup ? 'Set password' : 'Sign in';
    $('pw1').focus();
  }
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('loginErr'); err.textContent = '';
    const pw = $('pw1').value;
    if (mode === 'server') {
      try {
        const r = await api('login', { method: 'POST', body: JSON.stringify({ password: pw }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { err.textContent = j.error || `Sign-in failed (${r.status}).`; $('pw1').select(); return; }
        loadDraft(); openEditor();
      } catch (x) { err.textContent = "Couldn't reach the server. Check your connection and try again."; }
      return;
    }
    try {
      if (!hasPassword()) {
        if (pw.length < 6) { err.textContent = 'Use at least 6 characters.'; return; }
        if (pw !== $('pw2').value) { err.textContent = "The two passwords don't match."; return; }
        loadDraft();
        cfg.adminPasswordSalt = C.newSalt();
        cfg.adminPasswordHash = await C.hashPassword(pw, cfg.adminPasswordSalt);
        saveDraft();
        try { sessionStorage.setItem(AUTH_KEY, 'setup'); } catch (e2) {}
        openEditor();
        return;
      }
      $('loginBtn').disabled = true; // PBKDF2 takes a moment
      const ok = await C.verifyPassword(pw, published.adminPasswordSalt, published.adminPasswordHash).finally(() => { $('loginBtn').disabled = false; });
      if (!ok) { err.textContent = 'That password is wrong.'; $('pw1').select(); return; }
      try { sessionStorage.setItem(AUTH_KEY, published.adminPasswordHash); } catch (e2) {}
      loadDraft(); openEditor();
    } catch (x) {
      err.textContent = "This browser can't check passwords on this page. Open the admin page over https (GitHub Pages does this) or from your own computer.";
    }
  });
  $('signOutBtn').addEventListener('click', async () => {
    if (mode === 'server') { try { await api('logout', { method: 'POST', body: '{}' }); } catch (e) {} }
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
    $('pw1').value = ''; $('pw2').value = ''; showLogin();
  });

  $('saveBtn').addEventListener('click', async () => {
    const btn = $('saveBtn'), msg = $('pubMsg');
    btn.disabled = true; msg.textContent = 'Saving…';
    try {
      const r = await api('config', { method: 'PUT', body: JSON.stringify(C.normalizeConfig(cfg)) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { msg.textContent = ''; showLogin(); $('loginErr').textContent = j.error || 'Sign in again to save. Your changes are kept.'; return; }
      if (!r.ok) { msg.textContent = j.error || `Saving failed (${r.status}). Your changes are kept here; try again.`; return; }
      published = C.normalizeConfig(j.config);
      cfg = structuredClone(published);
      saveDraft();
      msg.textContent = `Saved at ${new Date().toLocaleTimeString()}. The main page shows it on its next load.`;
    } catch (e) {
      msg.textContent = "Couldn't reach the server, so nothing was saved. Your changes are kept here; try again.";
    } finally { btn.disabled = false; updateBanner(); }
  });

  // ---------- editor ----------
  function openEditor() {
    $('loginForm').hidden = true; $('editor').hidden = false;
    $('pw1').value = ''; $('pw2').value = '';
    fillOptions(); buildRows(); refresh();
  }

  function showLogo() {
    C.applyLogo(cfg, $('logo'));
    $('logoPrev').src = cfg.logo || 'favicon.svg';
    $('logoReset').disabled = !cfg.logo;
  }

  // Turn an uploaded image into a small data URL stored in the config
  function readAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  async function logoFromFile(file) {
    if (file.type === 'image/svg+xml') {
      if (file.size > 150000) throw new Error('That SVG is too large. Use one under 150 KB.');
      return readAsDataURL(file);
    }
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Use a PNG, JPG, GIF, WebP or SVG image.');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That image couldn't be read.")); i.src = url; });
      const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      let data = cv.toDataURL('image/png');
      if (data.length > C.LOGO_MAX) data = cv.toDataURL('image/webp', 0.85);
      if (data.length > C.LOGO_MAX) throw new Error('That image is still too large after shrinking. Try a simpler one.');
      return data;
    } finally { URL.revokeObjectURL(url); }
  }
  $('logoBtn').addEventListener('click', () => $('logoFile').click());
  $('logoFile').addEventListener('change', async () => {
    const f = $('logoFile').files[0]; $('logoFile').value = '';
    if (!f) return;
    try {
      const data = await logoFromFile(f);
      if (!C.validLogo(data)) throw new Error('That file type isn’t supported.');
      cfg.logo = data; saveDraft(); showLogo();
      $('logoMsg').textContent = `Logo set from ${f.name}. ${mode === 'server' ? 'Save' : 'Publish'} to put it on the main page.`;
    } catch (e) { $('logoMsg').textContent = e.message; }
  });
  $('logoReset').addEventListener('click', () => {
    cfg.logo = ''; saveDraft(); showLogo();
    $('logoMsg').textContent = 'Back to the default icon.';
  });

  function fillOptions() {
    $('titleIn').value = cfg.title;
    showLogo();
    $('hol').value = holText;
    $('incToday').checked = cfg.countToday;
    $('incEnd').checked = cfg.countTargetDate;
    const w = $('wkdays'); w.innerHTML = '';
    [1, 2, 3, 4, 5, 6, 0].forEach(d => {
      const l = document.createElement('label');
      l.innerHTML = `<input type="checkbox" id="wd${d}"> ${C.DOW[d]}`;
      const cb = l.querySelector('input'); cb.checked = cfg.nonWorkingDays.includes(d);
      cb.addEventListener('change', () => {
        cfg.nonWorkingDays = cb.checked ? [...cfg.nonWorkingDays, d].sort() : cfg.nonWorkingDays.filter(x => x !== d);
        saveDraft(); refresh();
      });
      w.appendChild(l);
    });
  }
  $('titleIn').addEventListener('input', () => { cfg.title = $('titleIn').value; saveDraft(); });
  $('incToday').addEventListener('change', () => { cfg.countToday = $('incToday').checked; saveDraft(); refresh(); });
  $('incEnd').addEventListener('change', () => { cfg.countTargetDate = $('incEnd').checked; saveDraft(); refresh(); });
  $('hol').addEventListener('input', () => {
    holText = $('hol').value;
    cfg.holidays = C.parseHolidayText(holText).list;
    saveDraft(); refresh();
  });

  function buildRows() {
    const rows = $('rows'); rows.innerHTML = '';
    cfg.countdowns.forEach((t, i) => {
      const r = document.createElement('div');
      const d = C.toDay(t.date);
      r.className = 'row' + (d !== null && d < C.TODAY ? ' past' : '');
      r.innerHTML = `<input type="text" class="plain" id="cn${i}" aria-label="Countdown ${i + 1} name" placeholder="Name this countdown">
        <input type="date" id="cd${i}" aria-label="Countdown ${i + 1} date">
        <button type="button" class="rm" aria-label="Remove countdown ${i + 1}" title="Remove">×</button>`;
      const n = r.querySelector('#cn' + i), dt = r.querySelector('#cd' + i);
      n.value = t.name; dt.value = t.date;
      n.addEventListener('input', () => { t.name = n.value; saveDraft(); refresh(); });
      dt.addEventListener('input', () => { t.date = dt.value; r.classList.toggle('past', C.toDay(dt.value) !== null && C.toDay(dt.value) < C.TODAY); saveDraft(); refresh(); });
      r.querySelector('.rm').addEventListener('click', () => {
        const prev = structuredClone(cfg.countdowns);
        cfg.countdowns.splice(i, 1);
        afterListChange(`Removed “${t.name || 'Untitled'}”`, prev);
      });
      rows.appendChild(r);
    });
    $('cdCount').textContent = `${cfg.countdowns.length} total`;
  }

  function afterListChange(msg, prev) {
    saveDraft(); buildRows(); refresh();
    if (msg) showUndo(msg, () => { cfg.countdowns = prev; saveDraft(); buildRows(); refresh(); });
  }

  $('addBtn').addEventListener('click', () => {
    cfg.countdowns.push({ name: '', date: C.toISO(C.TODAY + 30) });
    afterListChange();
    $('cn' + (cfg.countdowns.length - 1)).focus();
  });
  $('sortBtn').addEventListener('click', () => {
    cfg.countdowns.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    afterListChange();
  });
  $('clearPast').addEventListener('click', () => {
    const prev = structuredClone(cfg.countdowns);
    cfg.countdowns = cfg.countdowns.filter(t => { const d = C.toDay(t.date); return d === null || d >= C.TODAY; });
    const n = prev.length - cfg.countdowns.length;
    if (!n) { $('pubMsg').textContent = 'There are no past countdowns to remove.'; return; }
    afterListChange(`Removed ${n} past countdown${n > 1 ? 's' : ''}`, prev);
  });

  function refresh() {
    const { list, bad } = C.parseHolidayText(holText);
    $('parsed').innerHTML = `${list.length} holiday${list.length === 1 ? '' : 's'} recognised` +
      (bad.length ? ` · <span class="err">couldn't read line${bad.length > 1 ? 's' : ''} ${bad.join(', ')}</span>` : '');
    C.renderCards($('preview'), cfg);
  }

  // ---------- publish ----------
  function configText() {
    const out = C.normalizeConfig(cfg);
    return '// Deadline Countdown settings. Edit this with admin.html, or by hand.\n' +
      '// Dates are YYYY-MM-DD. nonWorkingDays: 0 = Sunday ... 6 = Saturday.\n' +
      'window.COUNTDOWN_CONFIG = ' + JSON.stringify(out, null, 2) + ';\n';
  }
  function updateBanner() {
    const dirty = !same(cfg, published);
    $('banner').classList.toggle('clean', !dirty);
    if (mode === 'server') {
      $('bannerTitle').textContent = dirty ? 'You have unsaved changes' : 'All changes saved';
      $('bannerNote').textContent = dirty ? 'Save to put them live on the main page.' : 'The main page is showing these settings.';
      $('saveBtn').disabled = !dirty;
    } else {
      $('bannerTitle').textContent = dirty ? 'You have unpublished changes' : 'Everything matches the published config.js';
      $('bannerNote').textContent = dirty
        ? 'Download config.js and upload it to your site to publish them.'
        : 'Changes you make here stay a draft until you upload a new config.js.';
    }
    $('discardBtn').disabled = !dirty;
  }

  // Inside a Claude artifact, plain downloads are blocked; use its save dialog. Elsewhere this does nothing.
  let hostSaver = null;
  try { window.claude?.use?.('downloads')?.then(d => { hostSaver = d; }, () => {}); } catch (e) {}

  $('dlBtn').addEventListener('click', () => {
    const text = configText();
    if (hostSaver) {
      hostSaver.save({ filename: 'config.js', data: text }).then(
        () => { $('pubMsg').textContent = 'Saved config.js. Upload it to your site to publish.'; },
        () => { $('pubMsg').textContent = "Saving a file isn't available here. Use Copy config.js instead."; });
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'config.js';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    $('pubMsg').textContent = 'Your browser is saving config.js. Once it is in your downloads, upload it to your site. If no file appears, use Copy config.js.';
  });
  $('copyBtn').addEventListener('click', () => {
    const text = configText(), fb = $('copyFallback');
    navigator.clipboard.writeText(text).then(
      () => { fb.hidden = true; $('pubMsg').textContent = 'Copied. Paste it over the contents of config.js on your site.'; },
      () => { fb.hidden = false; fb.value = text; fb.select(); $('pubMsg').textContent = 'Your browser blocked copying. The text is selected below; press Ctrl+C.'; });
  });
  $('discardBtn').addEventListener('click', () => {
    const prev = { cfg: structuredClone(cfg), holText };
    cfg = structuredClone(published); holText = C.holidaysToText(cfg.holidays);
    saveDraft(); fillOptions(); buildRows(); refresh();
    showUndo('Changes discarded', () => { cfg = prev.cfg; holText = prev.holText; saveDraft(); fillOptions(); buildRows(); refresh(); });
  });

  $('pwBtn').addEventListener('click', async () => {
    const a = $('newPw').value, b = $('newPw2').value, msg = $('pwMsg');
    if (a.length < 6) { msg.textContent = 'Use at least 6 characters.'; return; }
    if (a !== b) { msg.textContent = "The two passwords don't match."; return; }
    try {
      cfg.adminPasswordSalt = C.newSalt();
      cfg.adminPasswordHash = await C.hashPassword(a, cfg.adminPasswordSalt);
    } catch (e) { msg.textContent = "This browser can't set passwords on this page. Open it over https."; return; }
    $('newPw').value = $('newPw2').value = '';
    saveDraft();
    msg.textContent = 'Password changed in your draft. It takes effect once you publish the new config.js.';
  });

  // ---------- undo toast ----------
  let undoFn = null, toastTimer;
  function showUndo(text, fn) {
    undoFn = fn; $('toastMsg').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; undoFn = null; }, 8000);
  }
  $('undoBtn').addEventListener('click', () => { if (undoFn) undoFn(); undoFn = null; $('toast').hidden = true; });

  // ---------- start ----------
  (async () => {
    // Running under server.js? It answers api/session; a plain static host doesn't.
    try {
      const r = await fetch('api/session', { credentials: 'same-origin', cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j && j.mode === 'server') { mode = 'server'; serverEditable = !!j.editable; }
      if (mode === 'server') {
        $('saveBtn').hidden = false;
        $('dlBtn').hidden = $('copyBtn').hidden = true;
        $('pwPanel').hidden = $('staticSteps').hidden = true;
        if (j.signedIn) { loadDraft(); openEditor(); return; }
        showLogin(); return;
      }
    } catch (e) { /* static hosting or opened from disk */ }
    let auth = null;
    try { auth = sessionStorage.getItem(AUTH_KEY); } catch (e) {}
    if (auth && (auth === published.adminPasswordHash || (auth === 'setup' && !hasPassword()))) { loadDraft(); openEditor(); }
    else showLogin();
  })();
})();
