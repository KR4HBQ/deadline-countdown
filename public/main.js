/* Deadline Countdown: main page script. Needs config.js and app.js loaded first. */
(function () {
  const C = window.Countdown;
  C.initTheme(document.getElementById('themeSeg'));
  document.getElementById('todayLbl').textContent = 'Today · ' + C.fmt(C.TODAY);
  if (!window.COUNTDOWN_CONFIG) document.getElementById('loadErr').hidden = false;
  const cfg = C.normalizeConfig(window.COUNTDOWN_CONFIG);
  document.getElementById('title').textContent = cfg.title || 'Deadline Countdown';
  document.title = cfg.title || 'Deadline Countdown';
  C.applyLogo(cfg, document.getElementById('logo'));
  const n = C.renderCards(document.getElementById('cards'), cfg);
  document.getElementById('empty').hidden = n > 0 || !window.COUNTDOWN_CONFIG;
  const off = [1, 2, 3, 4, 5, 6, 0].filter(d => cfg.nonWorkingDays.includes(d)).map(d => C.DOW[d]).join('/') || 'no days';
  document.getElementById('rulesNote').textContent =
    `Business days skip ${off} and ${cfg.holidays.length} holiday${cfg.holidays.length === 1 ? '' : 's'}, counting from ${cfg.countToday ? 'today' : 'tomorrow'} ${cfg.countTargetDate ? 'through' : 'up to'} the target date.`;
})();
