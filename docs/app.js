(() => {
  'use strict';

  const DATA_URL = 'data/launches.json';
  const REFRESH_MS = 5 * 60 * 1000;
  const DONE = new Set(['Success', 'Failure', 'Partial Failure']);
  const STORE_KEY = 'sla:filter';
  const TAB_KEY = 'sla:tab';
  const STATUS_LABEL = { 'Partial Failure': 'Partial', 'In Flight': 'In flight' };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Keep hyphenated tokens like "15-15" or "CRS-33" from breaking across lines.
  const nobr = (s) => esc(s).split(' ').map((w) => (w.includes('-') ? `<span class="nw">${w}</span>` : w)).join(' ');
  const FEED_LABEL = { all: 'All launches', 'no-starlink': 'No Starlink', notable: 'Notable', starship: 'Starship', crewed: 'Crewed', starlink: 'Starlink' };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  let data = null;
  let filter = store.get(STORE_KEY) || 'all';

  // Paths are relative to wherever the site is hosted (e.g. /spacex-launch-alerts/).
  const baseUrl = new URL('.', location.href);
  const feedHttpUrl = (id) => new URL(`cal/${id}.ics`, baseUrl).href;
  const feedWebcalUrl = (id) => feedHttpUrl(id).replace(/^https?:/, 'webcal:');
  const oneUrl = (id) => new URL(`cal/one/${id}.ics`, baseUrl).href;

  // ---------- time formatting ----------
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const longDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const monFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const dowFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const tzName = (() => {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch { return ''; }
  })();

  function relDay(d) {
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(d) - start(new Date())) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return longDayFmt.format(d);
  }

  function whenText(l) {
    const d = new Date(l.net);
    if (l.precision === 'exact') return `${relDay(d)} · ${timeFmt.format(d)} ${tzName}`.trim();
    if (l.precision === 'day') return `${relDay(d)} · Time TBD`;
    return `NET ${d.toLocaleString(undefined, { month: 'long', year: 'numeric' })}`;
  }

  function splitDuration(ms) {
    const s = Math.floor(Math.abs(ms) / 1000);
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }
  const p2 = (n) => String(n).padStart(2, '0');

  function clockHtml(l) {
    if (l.precision !== 'exact') {
      const label = l.precision === 'day' ? 'Time TBD' : 'Date TBD';
      return `<div class="clock text"><div class="u"><span class="n">${esc(label.toUpperCase())}</span></div></div>`;
    }
    const ms = Date.parse(l.net) - Date.now();
    const { d, h, m, s } = splitDuration(ms);
    const units = d > 0 ? [[d, 'Days'], [h, 'Hrs'], [m, 'Min'], [s, 'Sec']] : [[h, 'Hrs'], [m, 'Min'], [s, 'Sec']];
    const cells = units
      .map(([v, lbl]) => `<div class="u"><span class="n">${p2(v)}</span><span class="l">${lbl}</span></div>`)
      .join('<span class="sep">:</span>');
    return `<div class="clock" role="timer" aria-label="${ms >= 0 ? 'T minus' : 'T plus'} ${d} days ${h} hours ${m} minutes"><span class="t">${ms >= 0 ? 'T−' : 'T+'}</span>${cells}</div>`;
  }

  function shortIn(l) {
    if (l.precision === 'vague' || DONE.has(l.status)) return '';
    const ms = Date.parse(l.net) - Date.now();
    if (ms < 0) return l.precision === 'exact' ? 'Now' : '';
    const { d, h, m } = splitDuration(ms);
    if (d > 0) return `T− ${d}d ${h}h`;
    if (h > 0) return `T− ${h}h ${p2(m)}m`;
    return `T− ${m}m`;
  }

  // ---------- rendering ----------
  const statusCls = (l) => l.status.toLowerCase().replace(/\s+/g, '-');
  const statusTag = (l) => `<span class="st ${esc(statusCls(l))}" title="${esc(l.statusName)}">${esc(STATUS_LABEL[l.status] ?? l.status)}</span>`;
  const catLabel = (id) => data.categories.find((c) => c.id === id)?.label ?? id;
  const matches = (l) => filter === 'all' || l.categories.includes(filter);
  const siteText = (l) => [l.padShort, l.site].filter(Boolean).join(', ');
  const landingText = (l) => l.landing?.label ?? '—';

  function isUpcoming(l) {
    if (DONE.has(l.status)) return false;
    // Keep a launch "upcoming" until an hour past T-0 in case the result is slow to post.
    return Date.parse(l.net) > Date.now() - 3600 * 1000 || l.precision !== 'exact';
  }

  function watchBtn(l, cls = '') {
    if (!l.webcast) return '';
    return l.webcastLive
      ? `<a class="btn solid ${cls}" href="${esc(l.webcast)}" target="_blank" rel="noopener"><span class="dot"></span>Live now</a>`
      : `<a class="btn ${cls}" href="${esc(l.webcast)}" target="_blank" rel="noopener">Watch</a>`;
  }
  function calBtn(l, cls = '') {
    if (l.precision === 'vague' || DONE.has(l.status)) return '';
    return `<a class="btn ${cls}" href="${esc(oneUrl(l.id))}">Add to calendar</a>`;
  }

  function renderHero(next) {
    const el = $('#hero');
    el.style.removeProperty('--hero-img');
    el.classList.remove('has-img');
    if (!next) {
      el.innerHTML = `<div class="hero-inner"><p class="overline">Next launch</p><h1>No launches scheduled</h1></div>`;
      delete el.dataset.id;
      return;
    }
    const img = next.imageLarge || next.image;
    if (img) {
      el.style.setProperty('--hero-img', `url("${img.replace(/"/g, '%22')}")`);
      el.classList.add('has-img');
    }
    const label = filter === 'all' ? 'Next launch' : `Next ${catLabel(filter)} launch`;
    el.innerHTML = `
      <div class="hero-inner">
        <p class="overline"><span>${esc(label)}</span>${statusTag(next)}</p>
        <h1 id="hero-title">${nobr(next.mission)}</h1>
        <p class="meta"><b>${esc(next.vehicle)}</b> · ${esc(siteText(next) || next.location || '')}</p>
        <div id="hero-clock">${clockHtml(next)}</div>
        <p class="when">${esc(whenText(next))}</p>
        ${next.probability != null ? `<p class="sub">Weather ${esc(next.probability)}% go</p>` : ''}
        <div class="actions">${next.webcastLive ? watchBtn(next) : watchBtn(next, 'solid')}${calBtn(next)}</div>
      </div>`;
    el.dataset.id = next.id;
  }

  function dateCell(l) {
    const d = new Date(l.net);
    if (l.precision === 'vague') {
      return `<div class="md"><small>NET </small>${esc(monFmt.format(d))} ${d.getFullYear()}</div><div class="tm">Date TBD</div>`;
    }
    const time = l.precision === 'exact' ? timeFmt.format(d) : 'Time TBD';
    return `<div class="md"><small>${esc(dowFmt.format(d))} </small>${esc(monFmt.format(d))} ${d.getDate()}</div><div class="tm">${esc(time)}</div>`;
  }

  function rowHtml(l) {
    const window = l.precision === 'exact' && l.windowEnd && l.windowEnd !== l.windowStart
      ? `${timeFmt.format(new Date(l.windowStart))} – ${timeFmt.format(new Date(l.windowEnd))}`
      : l.precision === 'exact' ? 'Instantaneous' : null;
    const sub = [l.vehicle, l.padShort, l.landing?.label].filter(Boolean).join(' · ');
    const done = DONE.has(l.status);
    return `
      <details class="row" id="l-${esc(l.id)}" role="row">
        <summary>
          <div class="d" role="cell">${dateCell(l)}</div>
          <div class="m" role="cell"><div class="name">${nobr(l.mission)}</div><div class="sub">${esc(sub)}</div></div>
          <div class="cell wide" role="cell">${esc(l.vehicle)}</div>
          <div class="cell wide" role="cell">${esc(siteText(l) || '—')}</div>
          <div class="cell wide" role="cell">${esc(landingText(l))}</div>
          <div class="st-wrap end" role="cell">${statusTag(l)}<span class="in" data-in="${esc(l.id)}">${esc(shortIn(l))}</span></div>
        </summary>
        <div class="detail">
          <dl>
            <dt>${done ? 'Launched' : 'Launch'}</dt><dd>${esc(whenText(l))}</dd>
            ${window ? `<dt>Window</dt><dd>${esc(window)}</dd>` : ''}
            <dt>Status</dt><dd>${esc(l.statusName)}</dd>
            ${l.pad ? `<dt>Pad</dt><dd>${esc(l.pad)}${l.location ? `, ${esc(l.location)}` : ''}</dd>` : ''}
            ${l.landing ? `<dt>Landing</dt><dd>${esc(l.landing.name)}</dd>` : ''}
            ${l.orbit ? `<dt>Orbit</dt><dd>${esc(l.orbit)}</dd>` : ''}
            ${l.probability != null && !done ? `<dt>Weather</dt><dd>${esc(l.probability)}% go</dd>` : ''}
            <dt>Type</dt><dd>${esc(l.categories.map(catLabel).join(' · '))}</dd>
          </dl>
          ${l.description ? `<p>${esc(l.description)}</p>` : ''}
          <div class="actions">${watchBtn(l, 'sm')}${calBtn(l, 'sm')}</div>
        </div>
      </details>`;
  }

  function renderFilters() {
    const opts = [{ id: 'all', label: 'All' }, ...data.categories];
    $('#filters').innerHTML = opts
      .map((c) => `<button class="filter" data-filter="${esc(c.id)}" aria-pressed="${c.id === filter}">${esc(c.label)}</button>`)
      .join('');
  }

  function renderBoard() {
    const upcoming = data.launches.filter((l) => isUpcoming(l) && matches(l));
    const recent = data.launches.filter((l) => !isUpcoming(l) && matches(l)).reverse();
    renderHero(upcoming[0]);
    $('#upcoming-count').textContent = `${upcoming.length} mission${upcoming.length === 1 ? '' : 's'}`;
    $('#upcoming').innerHTML = upcoming.map(rowHtml).join('') || `<p class="empty">Nothing scheduled</p>`;
    $('#recent').innerHTML = recent.map(rowHtml).join('');
    $('#recent-section').hidden = recent.length === 0;
  }

  function renderFeeds() {
    $('#feeds').innerHTML = data.feeds.map((f) => `
      <li class="feed">
        <div class="name">${esc(FEED_LABEL[f.id] ?? f.name)}${f.id === 'all' ? '<span class="rec">Recommended</span>' : ''}</div>
        <div class="desc">${esc(f.description)} · ${f.count} on calendar</div>
        <button class="copy" data-copy="${esc(feedHttpUrl(f.id))}">Copy link</button>
        <a class="btn sm${f.id === 'all' ? ' solid' : ''}" href="${esc(feedWebcalUrl(f.id))}">Subscribe</a>
      </li>`).join('');
  }

  function renderUpdated() {
    if (!data) return;
    const mins = Math.round((Date.now() - Date.parse(data.generatedAt)) / 60000);
    $('#updated').textContent = mins < 1 ? 'Updated just now' : mins < 60 ? `Updated ${mins} min ago` : `Updated ${Math.round(mins / 60)} h ago`;
  }

  function render() {
    renderFilters();
    renderBoard();
    renderFeeds();
    renderUpdated();
  }

  function tick() {
    if (!data) return;
    const id = $('#hero').dataset.id;
    const next = id && data.launches.find((l) => l.id === id);
    if (next) $('#hero-clock').innerHTML = clockHtml(next);
    document.querySelectorAll('[data-in]').forEach((el) => {
      const l = data.launches.find((x) => x.id === el.dataset.in);
      if (l) el.textContent = shortIn(l);
    });
  }

  // ---------- data ----------
  async function load() {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const fresh = await res.json();
      // Keep any open rows open across background refreshes.
      const open = [...document.querySelectorAll('details.row[open]')].map((d) => d.id);
      data = fresh;
      render();
      open.forEach((id) => { const el = document.getElementById(id); if (el) el.open = true; });
    } catch {
      if (!data) $('#hero').innerHTML = `<div class="hero-inner"><p class="overline">Offline</p><h1>Couldn’t load launches</h1><p class="meta">Check your connection and try again</p></div>`;
    }
  }

  // ---------- interactions ----------
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function showTab(name) {
    for (const t of ['launches', 'subscribe']) {
      $(`#tab-${t}`).setAttribute('aria-selected', String(t === name));
      $(`#view-${t}`).hidden = t !== name;
    }
    store.set(TAB_KEY, name);
  }

  function openFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id || !data) return;
    showTab('launches');
    let el = document.getElementById(`l-${id}`);
    if (!el && filter !== 'all') { filter = 'all'; render(); el = document.getElementById(`l-${id}`); }
    if (!el) return;
    el.open = true;
    el.classList.add('flash');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => el.classList.remove('flash'), 2000);
  }

  // ---------- install ----------
  // iOS has no install API, so the button opens a how-to sheet; Chrome/Android get the real prompt.
  const sheet = $('#install-sheet');
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installPrompt = null;

  function updateInstall() {
    const show = !isStandalone() && (Boolean(installPrompt) || isIOS);
    $('#install-btn').hidden = !show;
    document.querySelectorAll('[data-install]').forEach((el) => { el.hidden = !show; });
  }

  async function install() {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => {});
      installPrompt = null;
      updateInstall();
      return;
    }
    sheet.classList.toggle('safari', isIOSSafari);
    sheet.showModal();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    updateInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    updateInstall();
    toast('LaunchView installed');
  });
  // Tap outside the sheet (on the backdrop) to close it.
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

  // ---------- push notifications ----------
  // Subscriptions live in Supabase; the `dispatch` function sends the pushes.
  const PUSH_FN = 'https://dzlbxtbdymrusxzdroya.supabase.co/functions/v1/subscribe';
  const PUSH_PREFS_KEY = 'lv:push-prefs';
  const PUSH_TOKEN_KEY = 'lv:push-token';
  const LEADS = [[1440, '24 hours'], [60, '1 hour'], [10, '10 min'], [1, '1 min']];
  const EVENT_TOGGLES = [['changes', 'Scrubs, delays & holds'], ['webcast', 'Webcast is live'], ['results', 'Launch results']];
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const PUSH_DEFAULTS = { reminders: [1440, 60, 10], filter: 'all', changes: true, webcast: true, results: true };
  let pushSub = null;
  let pushPrefs = { ...PUSH_DEFAULTS };
  try { Object.assign(pushPrefs, JSON.parse(store.get(PUSH_PREFS_KEY) || '{}')); } catch { /* keep defaults */ }

  function pushToken() {
    let t = store.get(PUSH_TOKEN_KEY);
    if (!t) {
      t = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
      store.set(PUSH_TOKEN_KEY, t);
    }
    return t;
  }

  async function pushApi(action, extra = {}) {
    const res = await fetch(PUSH_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, token: pushToken(), subscription: pushSub.toJSON(), ...extra }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
    return body;
  }

  const savePrefs = () => pushApi('save', { prefs: pushPrefs, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });

  function pushState() {
    if (!pushSupported) return isIOS && !isStandalone() ? 'install' : 'unsupported';
    if (isIOS && !isStandalone()) return 'install';
    if (Notification.permission === 'denied') return 'denied';
    return pushSub ? 'on' : 'off';
  }

  function renderPush(note = '') {
    const el = $('#push');
    const state = pushState();
    $('#push-label').textContent = state === 'on' ? 'On' : '';
    const noteHtml = note ? `<p class="push-note">${esc(note)}</p>` : '';
    if (state === 'install') {
      el.innerHTML = `<p class="lede tight">iPhone only delivers notifications to the <b>installed app</b>. Add LaunchView to your Home Screen, open it from there, and turn notifications on.</p>
        <div class="actions"><button class="btn sm" data-install-open>Show me how</button></div>`;
    } else if (state === 'unsupported') {
      el.innerHTML = `<p class="lede tight">This browser can’t receive web push notifications. Use the calendar backup below.</p>`;
    } else if (state === 'denied') {
      el.innerHTML = `<p class="lede tight">Notifications are blocked for LaunchView. Turn them on in <b>Settings › Notifications › LaunchView</b>, then come back here.</p>`;
    } else if (state === 'off') {
      el.innerHTML = `<p class="lede tight">Reminders at <b>T-24h, T-1h and T-10m</b>, plus scrubs, delays, the webcast going live and the result. You can fine-tune it after.</p>
        <div class="actions"><button class="btn solid" data-push="on">Turn on notifications</button></div>${noteHtml}`;
    } else {
      const chip = (on, attrs, label) => `<button class="pchip" aria-pressed="${on}" ${attrs}>${esc(label)}</button>`;
      el.innerHTML = `
        <div class="pgroup"><p class="plabel">Remind me before liftoff</p>
          <div class="pchips">${LEADS.map(([m, l]) => chip(pushPrefs.reminders.includes(m), `data-lead="${m}"`, l)).join('')}</div></div>
        <div class="pgroup"><p class="plabel">Which launches</p>
          <div class="pchips">${(data?.feeds ?? [{ id: 'all' }]).map((f) => chip(pushPrefs.filter === f.id, `data-pfilter="${esc(f.id)}"`, FEED_LABEL[f.id] ?? f.name)).join('')}</div></div>
        <div class="pgroup">${EVENT_TOGGLES.map(([k, l]) => `
          <button class="pswitch" role="switch" aria-checked="${Boolean(pushPrefs[k])}" data-ptoggle="${k}"><span>${esc(l)}</span><i aria-hidden="true"></i></button>`).join('')}</div>
        <div class="actions"><button class="btn sm" data-push="test">Send test</button><button class="btn sm ghost" data-push="off">Turn off</button></div>${noteHtml}`;
    }
  }

  let saveTimer;
  function prefsChanged() {
    store.set(PUSH_PREFS_KEY, JSON.stringify(pushPrefs));
    renderPush();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePrefs().then(() => toast('Saved')).catch(() => renderPush('Couldn’t save. Check your connection.')), 600);
  }

  async function pushOn() {
    // Must be the first await in the tap handler, or iOS refuses to show the prompt.
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return renderPush(perm === 'denied' ? '' : 'Notifications weren’t allowed.');
    try {
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await (await fetch(PUSH_FN)).json();
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      pushSub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await savePrefs();
      renderPush();
      toast('Notifications on');
    } catch (err) {
      pushSub = null;
      renderPush(`Couldn’t turn on notifications (${err.message}).`);
    }
  }

  async function pushOff() {
    try { await pushApi('delete'); } catch { /* already gone server-side */ }
    await pushSub?.unsubscribe().catch(() => {});
    pushSub = null;
    renderPush();
    toast('Notifications off');
  }

  async function pushTest() {
    try {
      await pushApi('test');
      toast('Test sent');
    } catch (err) {
      renderPush(err.status === 429 ? 'Wait a minute between tests.' : `Test failed (${err.message}).`);
    }
  }

  async function initPush() {
    if (pushSupported && !(isIOS && !isStandalone())) {
      try {
        const reg = await navigator.serviceWorker.ready;
        pushSub = await reg.pushManager.getSubscription();
        // Re-sync now and then so the server has current prefs, time zone and keys.
        if (pushSub && Notification.permission === 'granted') savePrefs().catch(() => {});
      } catch { /* no SW yet */ }
    }
    renderPush();
  }

  function onPushClick(e) {
    const btn = e.target.closest('[data-push],[data-lead],[data-pfilter],[data-ptoggle]');
    if (!btn) return false;
    if (btn.dataset.push === 'on') pushOn();
    else if (btn.dataset.push === 'off') pushOff();
    else if (btn.dataset.push === 'test') pushTest();
    else if (btn.dataset.lead) {
      const m = Number(btn.dataset.lead);
      pushPrefs.reminders = pushPrefs.reminders.includes(m) ? pushPrefs.reminders.filter((x) => x !== m) : [...pushPrefs.reminders, m].sort((a, b) => b - a);
      prefsChanged();
    } else if (btn.dataset.pfilter) {
      pushPrefs.filter = btn.dataset.pfilter;
      prefsChanged();
    } else if (btn.dataset.ptoggle) {
      pushPrefs[btn.dataset.ptoggle] = !pushPrefs[btn.dataset.ptoggle];
      prefsChanged();
    }
    return true;
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-install-open]')) { install(); return; }
    if (e.target.closest('[data-close]')) { sheet.close(); return; }
    if (onPushClick(e)) return;
    const f = e.target.closest('[data-filter]');
    if (f) {
      filter = f.dataset.filter;
      store.set(STORE_KEY, filter);
      renderFilters();
      renderBoard();
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        toast('Link copied');
      } catch {
        prompt('Copy this calendar link:', copy.dataset.copy);
      }
      return;
    }
    const tab = e.target.closest('[role="tab"]');
    if (tab) {
      showTab(tab.id.replace('tab-', ''));
      window.scrollTo({ top: 0 });
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('hashchange', openFromHash);

  updateInstall();
  showTab(store.get(TAB_KEY) === 'subscribe' ? 'subscribe' : 'launches');
  load().then(() => { openFromHash(); initPush(); });
  setInterval(tick, 1000);
  setInterval(renderUpdated, 30000);
  setInterval(load, REFRESH_MS);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
