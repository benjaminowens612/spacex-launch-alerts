import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calendar, escapeText, fold } from '../scripts/ics.mjs';
import { buildLaunchList } from '../scripts/normalize.mjs';
import { build } from '../scripts/build.mjs';
import { makeSource } from './fixtures/ll2.mjs';

const NOW = new Date('2026-10-23T12:00:00Z');
const SITE = 'https://example.github.io/spacex-launch-alerts/';
const list = buildLaunchList(makeSource(NOW), NOW);

const unfold = (ics) => ics.replace(/\r\n /g, '');
const events = (ics) => unfold(ics).split('BEGIN:VEVENT').slice(1);
const eventFor = (ics, mission) => events(ics).find((e) => e.includes(mission));

test('escapes text per RFC 5545', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
});

test('folds long lines at 75 octets without splitting UTF-8', () => {
  const line = 'SUMMARY:' + '🚀'.repeat(40);
  const folded = fold(line);
  for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75, part);
  assert.equal(folded.replace(/\r\n /g, ''), line);
  assert.ok(!folded.includes('�'));
});

test('calendar is CRLF-terminated and every line ≤ 75 octets', () => {
  const ics = calendar(list, { name: 'SpaceX Launches', siteUrl: SITE });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'bare LF found');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT15M/);
  assert.match(ics, /X-WR-CALNAME:SpaceX Launches/);
});

test('exact-time launch: timed event with T-1h and T-10m alerts', () => {
  const ev = eventFor(calendar(list, { siteUrl: SITE }), 'Starlink Group 10-12');
  assert.match(ev, /UID:a1b2c3d4-0001-4000-8000-000000000001@spacex-launch-alerts/);
  assert.match(ev, /DTSTART:20261023T171700Z/);
  assert.match(ev, /DTEND:20261023T211700Z/); // 4h window
  assert.match(ev, /TRIGGER:-PT60M/);
  assert.match(ev, /TRIGGER:-PT10M/);
  assert.match(ev, /SUMMARY:🚀 Falcon 9 · Starlink Group 10-12/);
  assert.match(ev, /URL:https:\/\/x.com\/SpaceX/);
  assert.match(ev, /Watch live: https:\/\/x.com\/SpaceX/);
});

test('instantaneous window gets a 30 minute block', () => {
  const ev = eventFor(calendar(list), 'Crew-12');
  assert.match(ev, /DTSTART:20261024T210000Z/);
  assert.match(ev, /DTEND:20261024T213000Z/);
});

test('day-precision launch: all-day event, no alerts', () => {
  const ev = eventFor(calendar(list), 'Flight 12');
  assert.match(ev, /DTSTART;VALUE=DATE:20261101/);
  assert.match(ev, /DTEND;VALUE=DATE:20261102/);
  assert.ok(!ev.includes('VALARM'));
  assert.match(ev, /SUMMARY:🚀 \[TBD\] Starship · Flight 12/);
  assert.match(ev, /STATUS:TENTATIVE/);
});

test('month-precision launch is left out of calendars', () => {
  assert.equal(eventFor(calendar(list), 'USSF-75'), undefined);
});

test('completed launch shows result and has no alerts', () => {
  const ev = eventFor(calendar(list), 'Starlink Group 10-9');
  assert.match(ev, /SUMMARY:✅ Falcon 9 · Starlink Group 10-9/);
  assert.ok(!ev.includes('VALARM'));
});

test('a later LL2 update bumps SEQUENCE so iOS replaces the event', () => {
  const seq = (ics) => Number(/SEQUENCE:(\d+)/.exec(ics)[1]);
  const l = list[1];
  const a = calendar([l]);
  const b = calendar([{ ...l, updated: new Date(Date.parse(l.updated) + 60000).toISOString() }]);
  assert.ok(seq(b) > seq(a));
});

test('output is deterministic (no churn between identical builds)', () => {
  assert.equal(calendar(list, { siteUrl: SITE }), calendar(list, { siteUrl: SITE }));
});

test('build writes json, all feeds, and single-launch files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sla-'));
  const out = await build({ source: makeSource(NOW), now: NOW, outDir: dir, siteUrl: SITE });
  const json = JSON.parse(await readFile(join(dir, 'data', 'launches.json'), 'utf8'));
  assert.equal(json.launches.length, out.launches.length);
  assert.deepEqual(json.feeds.map((f) => f.id), ['all', 'no-starlink', 'notable', 'starship', 'crewed', 'starlink']);

  const feed = async (id) => readFile(join(dir, 'cal', `${id}.ics`), 'utf8');
  assert.ok((await feed('no-starlink')).includes('Crew-12'));
  assert.ok(!(await feed('no-starlink')).includes('Starlink Group'));
  const notable = await feed('notable');
  assert.ok(notable.includes('Crew-12') && notable.includes('Flight 12'));
  assert.ok(!notable.includes('Transporter'));
  assert.ok(!(await feed('starlink')).includes('Crew-12'));

  const singles = await readdir(join(dir, 'cal', 'one'));
  assert.ok(singles.includes('a1b2c3d4-0002-4000-8000-000000000002.ics'));
  assert.ok(!singles.includes('a1b2c3d4-0005-4000-8000-000000000005.ics'), 'no file for month-precision launch');
});
