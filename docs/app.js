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

  document.addEventListener('click', async (e) => {
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

  showTab(store.get(TAB_KEY) === 'subscribe' ? 'subscribe' : 'launches');
  load().then(openFromHash);
  setInterval(tick, 1000);
  setInterval(renderUpdated, 30000);
  setInterval(load, REFRESH_MS);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
