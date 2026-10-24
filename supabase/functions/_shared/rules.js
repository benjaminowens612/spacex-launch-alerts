// Notification rules shared by the Edge Functions (Deno) and the Node tests.
// Works on "snapshots": the launch objects published in docs/data/launches.json.

export const DONE = new Set(['Success', 'Failure', 'Partial Failure']);
export const REMINDER_LEADS = [1440, 60, 10, 1]; // minutes before liftoff
export const DEFAULT_PREFS = { reminders: [1440, 60, 10], filter: 'all', changes: true, webcast: true, results: true };
const CHANGE_KINDS = new Set(['delay', 'scrub', 'earlier', 'hold', 'resumed', 'time-set']);
const EVENT_HORIZON_MS = 14 * 24 * 3600 * 1000;
const MIN = 60 * 1000;
const RESULT_WINDOW_MS = 3 * 60 * MIN; // results only within 3h of liftoff
const WEBCAST_WINDOW_MS = 20 * MIN; // "webcast live" only until shortly after liftoff
export const EVENT_MAX_AGE_MS = 30 * MIN; // dispatch never sends change alerts older than this

// Same feeds as scripts/build.mjs FEEDS (kept in sync by test/push.test.mjs).
const hasAny = (l, cats) => l.categories.some((c) => cats.includes(c));
export const FILTERS = {
  all: () => true,
  'no-starlink': (l) => !(l.categories.length === 1 && l.categories[0] === 'starlink'),
  notable: (l) => hasAny(l, ['starship', 'crewed', 'falcon-heavy']),
  starship: (l) => hasAny(l, ['starship']),
  crewed: (l) => hasAny(l, ['crewed']),
  starlink: (l) => hasAny(l, ['starlink']),
};

export function matchesFilter(launch, filter = 'all') {
  return (FILTERS[filter] ?? FILTERS.all)(launch);
}

/** Coerce untrusted prefs from the client into a known-good shape. */
export function sanitizePrefs(input = {}) {
  const reminders = Array.isArray(input.reminders)
    ? REMINDER_LEADS.filter((m) => input.reminders.map(Number).includes(m))
    : DEFAULT_PREFS.reminders;
  return {
    reminders,
    filter: Object.hasOwn(FILTERS, input.filter) ? input.filter : DEFAULT_PREFS.filter,
    changes: input.changes === undefined ? DEFAULT_PREFS.changes : Boolean(input.changes),
    webcast: input.webcast === undefined ? DEFAULT_PREFS.webcast : Boolean(input.webcast),
    results: input.results === undefined ? DEFAULT_PREFS.results : Boolean(input.results),
  };
}

/**
 * Compare two snapshots of the same launch and return what changed that is
 * worth a notification. `prev` is null for a launch seen for the first time.
 */
export function detectEvents(prev, next, now = Date.now()) {
  if (!prev || !next) return [];
  const net = Date.parse(next.net);
  if (net > now + EVENT_HORIZON_MS || net < now - 24 * 3600 * 1000) return [];
  const base = { prevNet: prev.net, net: next.net, prevStatus: prev.status, status: next.status };
  const events = [];

  // Stale data can arrive late (e.g. a delayed refresh): never alert about
  // something that's already over.
  if (!DONE.has(prev.status) && DONE.has(next.status)) {
    return now <= net + RESULT_WINDOW_MS ? [{ kind: 'result', ...base }] : [];
  }
  if (!prev.webcastLive && next.webcastLive && now <= net + WEBCAST_WINDOW_MS) events.push({ kind: 'webcast', ...base });
  // Once liftoff time has passed or the rocket is flying, schedule changes are moot.
  if (next.status === 'In Flight' || now > net) return events;
  if (next.status === 'Hold' && prev.status !== 'Hold') events.push({ kind: 'hold', ...base });
  if (prev.status === 'Hold' && next.status === 'Go') events.push({ kind: 'resumed', ...base });

  if (prev.precision !== 'exact' && next.precision === 'exact') {
    events.push({ kind: 'time-set', ...base });
  } else if (prev.precision === 'exact' && next.precision === 'exact' && !DONE.has(next.status)) {
    const delta = net - Date.parse(prev.net);
    if (delta >= 12 * 60 * MIN) events.push({ kind: 'scrub', ...base });
    else if (delta >= 5 * MIN) events.push({ kind: 'delay', ...base });
    else if (delta <= -5 * MIN) events.push({ kind: 'earlier', ...base });
  }
  return events;
}

/** Does this subscriber want this event at all? */
export function wantsEvent(event, launch, prefs) {
  if (!matchesFilter(launch, prefs.filter)) return false;
  if (event.kind === 'webcast') return prefs.webcast;
  if (event.kind === 'result') return prefs.results;
  if (CHANGE_KINDS.has(event.kind)) return prefs.changes;
  return false;
}

function graceFor(lead) {
  if (lead <= 10) return 2 * MIN;
  if (lead <= 60) return 10 * MIN;
  return 30 * MIN;
}

/**
 * Reminders due right now for one launch. Keys include the NET, so when a
 * launch is delayed the reminders re-arm for the new time.
 */
export function dueReminders(launch, prefs, now = Date.now()) {
  if (launch.precision !== 'exact' || DONE.has(launch.status) || launch.status === 'Hold') return [];
  if (!matchesFilter(launch, prefs.filter)) return [];
  const net = Date.parse(launch.net);
  const due = [];
  for (const lead of prefs.reminders) {
    const at = net - lead * MIN;
    if (now >= at && now < at + graceFor(lead) && now < net) {
      due.push({ lead, key: `r:${launch.id}:${lead}:${launch.net}` });
    }
  }
  return due;
}

// ---------- message text ----------

function fmtTime(iso, tz, { day = false } = {}) {
  const opts = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  if (day) opts.weekday = 'short';
  let out;
  try {
    out = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || 'UTC' }).format(new Date(iso));
  } catch {
    out = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(iso));
  }
  return out.replace(/^(\w{3}),/, '$1'); // "Sat, 4:12 PM" → "Sat 4:12 PM"
}

const LEAD_LABEL = { 1440: '24 hours', 60: '1 hour', 10: '10 min', 1: '1 min' };
const where = (l) => [l.padShort, l.site].filter(Boolean).join(', ');

/**
 * Build the notification shown on the phone. `url` is relative to the app
 * (the service worker resolves it against its scope) unless it's a webcast.
 */
export function formatMessage(kind, launch, { tz, lead, event } = {}) {
  const m = launch.mission;
  const tag = `launch-${launch.id}`;
  const detail = `#${launch.id}`;
  const at = (iso, day) => fmtTime(iso, tz, { day });
  const place = where(launch);

  switch (kind) {
    case 'reminder':
      return {
        title: `T-${LEAD_LABEL[lead] ?? `${lead} min`} · ${m}`,
        body: [launch.vehicle, place, `Liftoff ${at(launch.net, lead >= 1440)}`].filter(Boolean).join(' · '),
        url: lead <= 10 && launch.webcast ? launch.webcast : detail,
        tag,
      };
    case 'delay':
      return { title: `Delayed · ${m}`, body: `Now ${at(event.net, true)} (was ${at(event.prevNet, true)})`, url: detail, tag };
    case 'scrub':
      return { title: `Scrubbed · ${m}`, body: `New target ${at(event.net, true)}`, url: detail, tag };
    case 'earlier':
      return { title: `Moved earlier · ${m}`, body: `Now ${at(event.net, true)} (was ${at(event.prevNet, true)})`, url: detail, tag };
    case 'hold':
      return { title: `Hold · ${m}`, body: 'The countdown is holding. Watch for a new time.', url: launch.webcast || detail, tag };
    case 'resumed':
      return { title: `Countdown resumed · ${m}`, body: `Liftoff ${at(event.net, false)}`, url: launch.webcast || detail, tag };
    case 'time-set':
      return { title: `Launch time set · ${m}`, body: `${launch.vehicle} · ${at(event.net, true)}`, url: detail, tag };
    case 'webcast':
      return { title: `Webcast live · ${m}`, body: `Liftoff ${at(launch.net, false)} · Tap to watch`, url: launch.webcast || detail, tag };
    case 'result': {
      const ok = event.status === 'Success';
      const partial = event.status === 'Partial Failure';
      return {
        title: ok ? `Liftoff ✅ · ${m}` : `${partial ? 'Partial failure' : 'Launch failure'} · ${m}`,
        body: ok ? `${launch.vehicle} launch successful` : `${launch.vehicle} · ${event.status}`,
        url: detail,
        tag,
      };
    }
    case 'test':
      return { title: 'LaunchView notifications are on', body: 'You’ll get launch alerts here. Tap to open LaunchView.', url: './', tag: 'test' };
    default:
      return { title: m, body: launch.vehicle, url: detail, tag };
  }
}
