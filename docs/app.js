(() => {
  'use strict';

  const DATA_URL = 'data/launches.json';
  const REFRESH_MS = 5 * 60 * 1000;
  const DONE = new Set(['Success', 'Failure', 'Partial Failure']);
  const STORE_KEY = 'sla:filter';
  const TAB_KEY = 'sla:tab';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
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
    return dayFmt.format(d);
  }

  function whenText(l) {
    const d = new Date(l.net);
    if (l.precision === 'exact') return `${relDay(d)} · ${timeFmt.format(d)} ${tzName}`.trim();
    if (l.precision === 'day') return `${relDay(d)} · time TBD`;
    return `NET ${monthFmt.format(d)}`;
  }

  function splitDuration(ms) {
    const s = Math.floor(Math.abs(ms) / 1000);
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }
  const p2 = (n) => String(n).padStart(2, '0');

  function countdownHtml(l) {
    if (l.precision !== 'exact') return `<span class="unit" style="margin:0">${esc(l.precision === 'day' ? 'Time not set yet' : 'Date not set yet')}</span>`;
    const ms = Date.parse(l.net) - Date.now();
    const { d, h, m, s } = splitDuration(ms);
    const sign = ms >= 0 ? 'T−' : 'T+';
    const parts = d > 0
      ? `${d}<span class="unit">d</span>${p2(h)}<span class="unit">h</span>${p2(m)}<span class="unit">m</span>`
      : `${p2(h)}:${p2(m)}:${p2(s)}`;
    return `<span class="unit" style="margin-left:0">${sign}</span>${parts}`;
  }

  function shortIn(l) {
    if (l.precision === 'vague') return '';
    const ms = Date.parse(l.net) - Date.now();
    if (DONE.has(l.status)) return '';
    if (ms < 0) return l.precision === 'exact' ? 'now' : '';
    const { d, h, m } = splitDuration(ms);
    if (d > 0) return `in ${d}d ${h}h`;
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${m}m`;
  }

  // ---------- rendering ----------
  const badge = (l) => `<span class="badge ${esc(l.status.toLowerCase().replace(/\s+/g, '-'))}" title="${esc(l.statusName)}">${esc(l.status)}</span>`;
  const catLabel = (id) => data.categories.find((c) => c.id === id)?.label ?? id;
  const matches = (l) => filter === 'all' || l.categories.includes(filter);

  function isUpcoming(l) {
    if (DONE.has(l.status)) return false;
    // Keep a launch "upcoming" until an hour past T-0 in case the result is slow to post.
    return Date.parse(l.net) > Date.now() - 3600 * 1000 || l.precision !== 'exact';
  }

  function watchBtn(l, cls = '') {
    if (!l.webcast) return '';
    return `<a class="btn ${l.webcastLive ? 'live' : cls}" href="${esc(l.webcast)}" target="_blank" rel="noopener">${l.webcastLive ? '● Live now' : '▶ Watch'}</a>`;
  }
  function calBtn(l) {
    if (l.precision === 'vague') return '';
    return `<a class="btn" href="${esc(oneUrl(l.id))}">＋ Add to Calendar</a>`;
  }

  function renderHero(next) {
    const el = $('#hero');
    if (!next) {
      el.innerHTML = `<div class="card hero"><p class="muted">No upcoming launches match this filter.</p></div>`;
      return;
    }
    el.innerHTML = `
      <article class="card hero" aria-labelledby="hero-title">
        <div class="eyebrow">${badge(next)} <span>Next launch</span> · <span>${esc(next.categories.map(catLabel).join(' · '))}</span></div>
        <h2 id="hero-title">${esc(next.mission)}</h2>
        <div class="sub">${esc(next.vehicle)}${next.location ? ` · ${esc(next.location)}` : ''}</div>
        <div class="countdown" id="hero-countdown" aria-live="off">${countdownHtml(next)}</div>
        <div class="when">${esc(whenText(next))}</div>
        ${next.probability != null ? `<div class="tag">Weather ${esc(next.probability)}% go</div>` : ''}
        <div class="actions">${watchBtn(next, 'primary')}${calBtn(next)}</div>
      </article>`;
    el.dataset.id = next.id;
  }

  function itemHtml(l) {
    const d = new Date(l.net);
    const vague = l.precision === 'vague';
    const date = vague
      ? `<div class="mo">NET</div><div class="d" style="font-size:15px">${esc(d.toLocaleString(undefined, { month: 'short' }))}</div><div class="dow">${d.getFullYear()}</div>`
      : `<div class="mo">${esc(d.toLocaleString(undefined, { month: 'short' }))}</div><div class="d">${d.getDate()}</div><div class="dow">${esc(d.toLocaleString(undefined, { weekday: 'short' }))}</div>`;
    const timeLine = l.precision === 'exact' ? timeFmt.format(d) : l.precision === 'day' ? 'Time TBD' : 'Date TBD';
    const window = l.precision === 'exact' && l.windowEnd && l.windowEnd !== l.windowStart
      ? `${timeFmt.format(new Date(l.windowStart))} – ${timeFmt.format(new Date(l.windowEnd))}`
      : l.precision === 'exact' ? 'Instantaneous' : null;
    return `
      <li class="item" id="l-${esc(l.id)}" data-id="${esc(l.id)}">
        <details>
          <summary>
            <div class="date">${date}</div>
            <div class="meta">
              <div class="t">${esc(l.mission)}</div>
              <div class="s">${esc([timeLine, l.vehicle, ...l.categories.map(catLabel).filter((c) => c !== l.vehicle)].join(' · '))}</div>
            </div>
            <div class="right">${badge(l)}<span class="in" data-in="${esc(l.id)}">${esc(shortIn(l))}</span></div>
          </summary>
          <div class="detail">
            <dl>
              <dt>When</dt><dd>${esc(whenText(l))}</dd>
              ${window ? `<dt>Window</dt><dd>${esc(window)}</dd>` : ''}
              <dt>Status</dt><dd>${esc(l.statusName)}</dd>
              ${l.pad ? `<dt>Pad</dt><dd>${esc(l.pad)}${l.location ? `, ${esc(l.location)}` : ''}</dd>` : ''}
              ${l.orbit ? `<dt>Orbit</dt><dd>${esc(l.orbit)}</dd>` : ''}
              ${l.probability != null ? `<dt>Weather</dt><dd>${esc(l.probability)}% go</dd>` : ''}
            </dl>
            ${l.description ? `<p>${esc(l.description)}</p>` : ''}
            <div class="actions">${watchBtn(l)}${DONE.has(l.status) ? '' : calBtn(l)}</div>
          </div>
        </details>
      </li>`;
  }

  function renderChips() {
    const opts = [{ id: 'all', label: 'All' }, ...data.categories];
    $('#chips').innerHTML = opts
      .map((c) => `<button class="chip" data-filter="${esc(c.id)}" aria-pressed="${c.id === filter}">${esc(c.label)}</button>`)
      .join('');
  }

  function renderLists() {
    const upcoming = data.launches.filter((l) => isUpcoming(l) && matches(l));
    const recent = data.launches.filter((l) => !isUpcoming(l) && matches(l)).reverse();
    renderHero(upcoming[0]);
    $('#upcoming').innerHTML = upcoming.slice(1).map(itemHtml).join('') ||
      `<li class="empty">${upcoming.length ? 'Nothing else scheduled yet.' : 'Nothing scheduled.'}</li>`;
    $('#recent').innerHTML = recent.map(itemHtml).join('');
    $('#recent-title').hidden = recent.length === 0;
  }

  function renderFeeds() {
    $('#feeds').innerHTML = data.feeds.map((f) => `
      <li class="card feed${f.id === 'all' ? ' rec' : ''}">
        <div class="name">${esc(f.name)}${f.id === 'all' ? '<span class="rec-tag">Recommended</span>' : ''}</div>
        <div class="desc">${esc(f.description)} · ${f.count} on calendar</div>
        <a class="btn primary go-btn" href="${esc(feedWebcalUrl(f.id))}">Subscribe</a>
        <button class="copy" data-copy="${esc(feedHttpUrl(f.id))}">Copy link</button>
      </li>`).join('');
  }

  function renderUpdated() {
    if (!data) return;
    const mins = Math.round((Date.now() - Date.parse(data.generatedAt)) / 60000);
    $('#updated').textContent = mins < 1 ? 'Updated just now' : mins < 60 ? `Updated ${mins} min ago` : `Updated ${Math.round(mins / 60)} h ago`;
  }

  function render() {
    renderChips();
    renderLists();
    renderFeeds();
    renderUpdated();
  }

  function tick() {
    const id = $('#hero').dataset.id;
    const next = id && data?.launches.find((l) => l.id === id);
    if (next) $('#hero-countdown').innerHTML = countdownHtml(next);
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
      data = await res.json();
      render();
    } catch (err) {
      if (!data) $('#hero').innerHTML = `<div class="card hero"><p>Couldn’t load launches. Check your connection and pull to refresh.</p></div>`;
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
    if ($('#hero').dataset.id === id) return $('#hero').scrollIntoView({ behavior: 'smooth' });
    let el = document.getElementById(`l-${id}`);
    if (!el && filter !== 'all') { filter = 'all'; render(); el = document.getElementById(`l-${id}`); }
    if (!el) return;
    el.querySelector('details').open = true;
    el.classList.add('flash');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => el.classList.remove('flash'), 2000);
  }

  document.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-filter]');
    if (chip) {
      filter = chip.dataset.filter;
      store.set(STORE_KEY, filter);
      renderChips();
      renderLists();
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
    if (tab) showTab(tab.id.replace('tab-', ''));
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
