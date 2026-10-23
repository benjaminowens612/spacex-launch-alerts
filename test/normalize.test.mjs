import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchList, categorize, pickWebcast, precisionOf, shortPad, shortSite } from '../scripts/normalize.mjs';
import { makeSource } from './fixtures/ll2.mjs';

const NOW = new Date('2026-10-23T12:00:00Z');
const list = buildLaunchList(makeSource(NOW), NOW);
const byMission = (m) => list.find((l) => l.mission === m);

test('categorizes launches', () => {
  assert.deepEqual(byMission('Starlink Group 10-12').categories, ['starlink']);
  assert.deepEqual(byMission('Crew-12').categories, ['crewed']);
  assert.deepEqual(byMission('Flight 12').categories, ['starship']);
  assert.deepEqual(byMission('USSF-75').categories, ['falcon-heavy']);
  assert.deepEqual(byMission('Transporter-15, Rideshare').categories, ['other']);
});

test('crew detection by name when mission type is missing', () => {
  assert.ok(categorize({ name: 'Falcon 9 Block 5 | Axiom Mission 5', rocket: { configuration: { name: 'Falcon 9' } } }).includes('crewed'));
  assert.ok(!categorize({ name: 'Falcon 9 Block 5 | CRS-33', mission: { type: 'Resupply' } }).includes('crewed'));
});

test('maps net_precision to exact / day / vague', () => {
  assert.equal(byMission('Starlink Group 10-12').precision, 'exact');
  assert.equal(byMission('Transporter-15, Rideshare').precision, 'exact'); // Hour
  assert.equal(byMission('Flight 12').precision, 'day');
  assert.equal(byMission('USSF-75').precision, 'vague');
  assert.equal(precisionOf({ status: { abbrev: 'Go' } }), 'exact');
  assert.equal(precisionOf({ status: { abbrev: 'TBD' } }), 'vague');
});

test('keeps recent past launches for 7 days and sorts by time', () => {
  assert.ok(byMission('Starlink Group 10-9'), 'launch 2 days ago kept');
  assert.equal(byMission('Bandwagon-5'), undefined, 'launch 20 days ago dropped');
  const times = list.map((l) => Date.parse(l.net));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('picks webcast and thumbnail', () => {
  const crew = byMission('Crew-12');
  assert.equal(crew.webcast, 'https://www.youtube.com/watch?v=crew12');
  assert.equal(crew.image, 'https://example.com/thumb.jpg');
  assert.equal(crew.vehicle, 'Falcon 9');
});

test('short pad and site names for the mission board', () => {
  assert.equal(shortPad('Space Launch Complex 40'), 'SLC-40');
  assert.equal(shortPad('Space Launch Complex 4E'), 'SLC-4E');
  assert.equal(shortPad('Launch Complex 39A'), 'LC-39A');
  assert.equal(shortPad('Orbital Launch Mount A'), 'OLM A');
  assert.equal(shortPad('Unknown Pad'), null);
  assert.equal(shortSite('Cape Canaveral SFS, FL, USA'), 'Cape Canaveral');
  assert.equal(shortSite('Vandenberg SFB, CA, USA'), 'Vandenberg');
  assert.equal(shortSite('SpaceX Starbase, TX, USA'), 'Starbase');
  const crew = byMission('Crew-12');
  assert.equal(crew.padShort, 'LC-39A');
  assert.equal(crew.site, 'Kennedy Space Center');
});

test('first-stage landing', () => {
  assert.equal(byMission('Starlink Group 10-12').landing.label, 'ASOG');
  assert.equal(byMission('Crew-12').landing.label, 'LZ-1');
  assert.equal(byMission('USSF-75').landing.label, 'Expended');
  assert.equal(byMission('Flight 12').landing, null);
  assert.equal(byMission('Crew-12').imageLarge, 'https://example.com/full.jpg');
});

test('upcoming record wins over a stale previous duplicate', () => {
  const src = makeSource(NOW);
  const stale = structuredClone(src.upcoming[0]);
  stale.status = { abbrev: 'TBD', name: 'To Be Determined' };
  const merged = buildLaunchList({ upcoming: src.upcoming, previous: [stale] }, NOW);
  assert.equal(merged.find((l) => l.id === stale.id).status, 'Go');
});

test('prefers SpaceX’s official stream on X over higher-ranked third-party streams', () => {
  const pick = (vid_urls) => pickWebcast({ vid_urls });
  const yt3p = { priority: 1, url: 'https://www.youtube.com/watch?v=abc', publisher: { name: 'NASASpaceflight' } };
  const ytSpaceX = { priority: 5, url: 'https://www.youtube.com/watch?v=sx', publisher: { name: 'SpaceX' } };
  const xSpaceX = { priority: 20, url: 'https://x.com/i/broadcasts/1mGPaZgYgLDJN', publisher: { name: 'SpaceX' } };
  const xOther = { priority: 2, url: 'https://x.com/i/broadcasts/zzz', publisher: { name: 'Spaceflight Now' } };
  assert.equal(pick([yt3p, ytSpaceX, xSpaceX]), xSpaceX.url, 'SpaceX on X wins');
  assert.equal(pick([yt3p, xOther, xSpaceX]), xSpaceX.url, 'other publishers on X do not count as official');
  assert.equal(pick([yt3p, ytSpaceX]), ytSpaceX.url, 'then any official SpaceX stream');
  assert.equal(pick([xOther, yt3p]), yt3p.url, 'otherwise LL2 priority order');
  assert.equal(pick([{ priority: 9, url: 'https://x.com/SpaceX' }, yt3p]), 'https://x.com/SpaceX', 'x.com/SpaceX with no publisher counts');
  assert.equal(pick([]), null);
});
