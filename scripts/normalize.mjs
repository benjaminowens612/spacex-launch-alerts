// Turns raw Launch Library 2 launch objects into the small shape the app and
// calendar feeds use.

export const CATEGORIES = [
  { id: 'starlink', label: 'Starlink' },
  { id: 'starship', label: 'Starship' },
  { id: 'crewed', label: 'Crewed' },
  { id: 'falcon-heavy', label: 'Falcon Heavy' },
  { id: 'other', label: 'Other' },
];

const PRECISE = new Set(['second', 'minute', 'hour']);
const DAY_LEVEL = new Set(['morning', 'afternoon', 'day']);
const CREW_NAME = /\bcrew\b|axiom|\bax-\d|polaris|fram2|inspiration4|haven|vast/i;
const CREW_TYPES = new Set(['human exploration', 'tourism']);

/**
 * 'exact'  — time known to the hour or better: timed event with alerts.
 * 'day'    — day known, time not: all-day event, no alerts.
 * 'vague'  — week/month/quarter/year: shown in app, left out of calendars.
 */
export function precisionOf(raw) {
  const p = raw?.net_precision;
  const name = String(p?.name ?? '').toLowerCase();
  if (PRECISE.has(name)) return 'exact';
  if (DAY_LEVEL.has(name)) return 'day';
  if (name) return 'vague';
  // No precision given: trust the time if the launch is confirmed.
  const abbrev = raw?.status?.abbrev;
  return ['Go', 'TBC', 'Hold', 'In Flight', 'Success', 'Failure', 'Partial Failure'].includes(abbrev)
    ? 'exact'
    : 'vague';
}

export function categorize(raw) {
  const config = raw?.rocket?.configuration ?? {};
  const vehicle = `${config.name ?? ''} ${config.full_name ?? ''}`.toLowerCase();
  const name = `${raw?.name ?? ''} ${raw?.mission?.name ?? ''}`;
  const missionType = String(raw?.mission?.type ?? '').toLowerCase();
  const cats = [];
  if (/starlink/i.test(name)) cats.push('starlink');
  if (vehicle.includes('starship')) cats.push('starship');
  if (CREW_TYPES.has(missionType) || CREW_NAME.test(name)) cats.push('crewed');
  if (vehicle.includes('falcon heavy')) cats.push('falcon-heavy');
  if (cats.length === 0) cats.push('other');
  return cats;
}

function pickWebcast(raw) {
  const vids = raw?.vid_urls ?? raw?.vidURLs ?? raw?.mission?.vid_urls ?? [];
  const sorted = [...vids].filter((v) => v?.url).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  return sorted[0]?.url ?? null;
}

function pickImage(raw, large = false) {
  const img = raw?.image;
  if (!img) return null;
  if (typeof img === 'string') return img; // LL2 2.2.0 shape
  return (large ? img.image_url || img.thumbnail_url : img.thumbnail_url || img.image_url) || null;
}

/** "Space Launch Complex 40" → "SLC-40", "Launch Complex 39A" → "LC-39A". */
export function shortPad(name) {
  if (!name || /^unknown/i.test(name.trim())) return null;
  const m = /^(Space )?Launch Complex (\w+)$/i.exec(name.trim());
  if (m) return `${m[1] ? 'SLC' : 'LC'}-${m[2].toUpperCase()}`;
  return name.replace(/^Orbital Launch Mount\b/i, 'OLM').replace(/^Orbital Launch Pad\b/i, 'OLP');
}

/** "Cape Canaveral SFS, FL, USA" → "Cape Canaveral", "SpaceX Starbase, TX, USA" → "Starbase". */
export function shortSite(location) {
  if (!location) return null;
  return location.split(',')[0].replace(/\s+(SFS|SFB|AFS|AFB)$/i, '').replace(/^SpaceX\s+/i, '').trim();
}

/** First-stage recovery: droneship/landing-zone abbrev, "Expended", or null if unknown. */
export function pickLanding(raw) {
  const stage = raw?.rocket?.launcher_stage?.[0];
  const landing = stage?.landing;
  if (!landing) return null;
  const loc = landing.landing_location ?? landing.location;
  if (landing.attempt === false) return { label: 'Expended', name: 'No landing attempt', type: null };
  const label = loc?.abbrev || loc?.name;
  if (!label) return null;
  return { label, name: loc?.name ?? label, type: landing.type?.abbrev ?? null };
}

export function normalize(raw) {
  const config = raw?.rocket?.configuration ?? {};
  const [, missionFromName] = String(raw.name ?? '').split(' | ');
  const status = raw.status ?? {};
  return {
    id: raw.id,
    name: raw.name,
    mission: raw.mission?.name || missionFromName || raw.name,
    vehicle: config.name || 'Falcon 9',
    categories: categorize(raw),
    status: status.abbrev || 'TBD',
    statusName: status.name || status.abbrev || 'To Be Determined',
    net: raw.net,
    precision: precisionOf(raw),
    precisionName: raw.net_precision?.name ?? null,
    windowStart: raw.window_start ?? raw.net,
    windowEnd: raw.window_end ?? raw.net,
    pad: raw.pad?.name ?? null,
    padShort: shortPad(raw.pad?.name),
    location: raw.pad?.location?.name ?? null,
    site: shortSite(raw.pad?.location?.name),
    landing: pickLanding(raw),
    orbit: raw.mission?.orbit?.name ?? null,
    description: raw.mission?.description ?? null,
    probability: raw.probability ?? null,
    webcast: pickWebcast(raw),
    webcastLive: Boolean(raw.webcast_live),
    image: pickImage(raw),
    imageLarge: pickImage(raw, true),
    updated: raw.last_updated ?? raw.net,
  };
}

export const PAST_STATUSES = new Set(['Success', 'Failure', 'Partial Failure']);
const KEEP_PAST_MS = 7 * 24 * 3600 * 1000;

/**
 * Merge upcoming + recent launches into one sorted, de-duplicated list.
 * Completed launches are kept for 7 days so you can see what you missed.
 */
export function buildLaunchList({ upcoming, previous }, now = new Date()) {
  const byId = new Map();
  for (const raw of [...previous, ...upcoming]) {
    if (!raw?.id || !raw?.net) continue;
    byId.set(raw.id, normalize(raw)); // upcoming wins: it's fetched as the fresher record
  }
  const cutoff = now.getTime() - KEEP_PAST_MS;
  return [...byId.values()]
    .filter((l) => Date.parse(l.net) >= cutoff)
    .sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
}
