// Minimal RFC 5545 writer tuned for iOS Calendar subscriptions.

const CRLF = '\r\n';
const PRODID = '-//spacex-launch-alerts//EN';
export const UID_DOMAIN = 'spacex-launch-alerts';
export const ALARM_MINUTES = [60, 10];
const DEFAULT_DURATION_MIN = 30;
const MAX_WINDOW_MIN = 6 * 60;

export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold a content line to 75 octets, never splitting a UTF-8 code point. */
export function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = [];
  let cur = '';
  let len = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (len + n > limit) {
      parts.push(cur);
      cur = '';
      len = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    len += n;
  }
  parts.push(cur);
  return parts.join(`${CRLF} `);
}

const pad2 = (n) => String(n).padStart(2, '0');
export function utcStamp(date) {
  const d = new Date(date);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}
const dateOnly = (date) => {
  const d = new Date(date);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
};

/** Seconds since 2020 — monotonic with LL2's last_updated, fits in an int. */
function sequenceOf(updated) {
  const t = Date.parse(updated);
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - Date.UTC(2020, 0, 1)) / 1000)) : 0;
}

const RESULT_ICON = { Success: '✅', Failure: '❌', 'Partial Failure': '⚠️' };

export function eventTitle(l) {
  const icon = RESULT_ICON[l.status] ?? '🚀';
  const prefix = ['TBC', 'TBD', 'Hold'].includes(l.status) ? `[${l.status}] ` : '';
  return `${icon} ${prefix}${l.vehicle} · ${l.mission}`;
}

function describe(l, siteUrl) {
  const fmt = (iso) => new Date(iso).toUTCString().replace(' GMT', ' UTC');
  const lines = [`Status: ${l.statusName}`];
  if (l.precision === 'exact') {
    lines.push(
      l.windowStart && l.windowEnd && l.windowStart !== l.windowEnd
        ? `Window: ${fmt(l.windowStart)} – ${fmt(l.windowEnd)}`
        : `Launch: ${fmt(l.net)} (instantaneous window)`,
    );
  } else if (l.precisionName) {
    lines.push(`Time precision: ${l.precisionName} (exact time not yet announced)`);
  }
  if (l.probability != null) lines.push(`Weather: ${l.probability}% GO`);
  if (l.orbit) lines.push(`Orbit: ${l.orbit}`);
  if (l.pad) lines.push(`Pad: ${[l.pad, l.location].filter(Boolean).join(', ')}`);
  if (l.webcast) lines.push('', `▶ Watch live: ${l.webcast}`);
  if (l.description) lines.push('', l.description);
  if (siteUrl) lines.push('', `Countdown & updates: ${siteUrl}#${l.id}`);
  return lines.join('\n');
}

export function eventLines(l, { siteUrl, alarms = ALARM_MINUTES } = {}) {
  if (l.precision === 'vague') return [];
  const lines = [
    'BEGIN:VEVENT',
    `UID:${l.id}@${UID_DOMAIN}`,
    `DTSTAMP:${utcStamp(l.updated)}`,
    `LAST-MODIFIED:${utcStamp(l.updated)}`,
    `SEQUENCE:${sequenceOf(l.updated)}`,
    `SUMMARY:${escapeText(eventTitle(l))}`,
  ];

  if (l.precision === 'exact') {
    const start = Date.parse(l.net);
    const windowMin = (Date.parse(l.windowEnd) - Date.parse(l.windowStart)) / 60000;
    const durMin = windowMin > 0 && windowMin <= MAX_WINDOW_MIN ? Math.ceil(windowMin) : DEFAULT_DURATION_MIN;
    lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(start + durMin * 60000)}`);
  } else {
    const day = Date.parse(l.net);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(day)}`, `DTEND;VALUE=DATE:${dateOnly(day + 86400000)}`);
  }

  if (l.pad) lines.push(`LOCATION:${escapeText([l.pad, l.location].filter(Boolean).join(', '))}`);
  lines.push(`DESCRIPTION:${escapeText(describe(l, siteUrl))}`);
  const link = l.webcast || (siteUrl ? `${siteUrl}#${l.id}` : null);
  if (link) lines.push(`URL:${link}`);
  lines.push(`CATEGORIES:${l.categories.map(escapeText).join(',')}`);
  lines.push(`STATUS:${['TBD', 'TBC'].includes(l.status) ? 'TENTATIVE' : 'CONFIRMED'}`);
  lines.push('TRANSP:TRANSPARENT'); // don't block "busy" time

  const upcoming = !['Success', 'Failure', 'Partial Failure'].includes(l.status);
  if (l.precision === 'exact' && upcoming) {
    for (const min of alarms) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(`T-${min >= 60 ? `${min / 60}h` : `${min}m`}: ${l.vehicle} · ${l.mission}`)}`,
        `TRIGGER:-PT${min}M`,
        'END:VALARM',
      );
    }
  }
  lines.push('END:VEVENT');
  return lines;
}

export function calendar(launches, { name, description, siteUrl, refresh = true } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`, `NAME:${escapeText(name)}`);
  if (description) lines.push(`X-WR-CALDESC:${escapeText(description)}`);
  if (refresh) lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M');
  if (siteUrl) lines.push(`URL:${siteUrl}`);
  for (const l of launches) lines.push(...eventLines(l, { siteUrl }));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}
