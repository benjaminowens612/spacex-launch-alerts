import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationServerKey, b64urlDecode, b64urlEncode, encryptPayload, generateVapidKeys, _internal,
} from '../supabase/functions/_shared/webpush.js';
import {
  DEFAULT_PREFS, detectEvents, dueReminders, formatMessage, matchesFilter, sanitizePrefs, wantsEvent,
} from '../supabase/functions/_shared/rules.js';
import { FEEDS } from '../scripts/build.mjs';
import { buildLaunchList } from '../scripts/normalize.mjs';
import { makeSource } from './fixtures/ll2.mjs';

const { subtle } = globalThis.crypto;
const enc = new TextEncoder();

// ---------- web push crypto ----------

async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, new Uint8Array([...info, 1]))).slice(0, len);
}

/** Play the browser: make a subscription and decrypt what the server sends (RFC 8291). */
async function makeBrowser() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const subscription = { endpoint: 'https://web.push.apple.com/QAbc123', keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } };
  async function decrypt(body) {
    const salt = body.slice(0, 16);
    const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const cipher = body.slice(21 + idlen);
    const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, pair.privateKey, 256));
    const ikm = await hkdf(auth, ecdh, new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
    const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
    const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
    assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
    return { text: new TextDecoder().decode(plain.slice(0, -1)), rs, idlen };
  }
  return { subscription, decrypt };
}

test('payload encrypts per RFC 8291 and the browser can decrypt it', async () => {
  const browser = await makeBrowser();
  const payload = JSON.stringify({ title: 'T-10 min · Crew-12', body: 'Falcon 9 · LC-39A · Liftoff 4:12 PM 🚀' });
  const body = await encryptPayload(browser.subscription, payload);
  const out = await browser.decrypt(body);
  assert.equal(out.text, payload);
  assert.equal(out.rs, 4096);
  assert.equal(out.idlen, 65);
  assert.ok(body.length < 4096, 'fits in one record');
});

test('each push uses a fresh salt and server key', async () => {
  const browser = await makeBrowser();
  const a = await encryptPayload(browser.subscription, 'x');
  const b = await encryptPayload(browser.subscription, 'x');
  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16));
  assert.notDeepEqual(a.slice(21, 86), b.slice(21, 86));
});

test('VAPID header carries a valid ES256 JWT for the push service origin', async () => {
  const keys = await generateVapidKeys();
  const now = Date.UTC(2026, 9, 23, 12);
  const header = await _internal.vapidAuthHeader('https://web.push.apple.com/QAbc/def', keys, 'https://example.github.io/app/', now);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://example.github.io/app/');
  assert.equal(claims.exp, now / 1000 + 12 * 3600);
  assert.equal(m[4], applicationServerKey(keys.publicKey));
  assert.equal(b64urlDecode(m[4]).length, 65);
  const pub = await subtle.importKey('jwk', keys.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(m[3]), enc.encode(`${m[1]}.${m[2]}`));
  assert.ok(ok, 'signature verifies');
});

// ---------- rules ----------

const NOW = Date.parse('2026-10-23T12:00:00Z');
const MIN = 60000;
const launch = (over = {}) => ({
  id: 'L1', mission: 'Crew-12', vehicle: 'Falcon 9', categories: ['crewed'], status: 'Go', precision: 'exact',
  net: new Date(NOW + 2 * 3600 * 1000).toISOString(), webcast: 'https://youtu.be/x', webcastLive: false,
  padShort: 'LC-39A', site: 'Kennedy Space Center', ...over,
});

test('reminders fire inside their window and not outside it', () => {
  const l = launch({ net: new Date(NOW + 60 * MIN).toISOString() });
  const prefs = sanitizePrefs({ reminders: [1440, 60, 10] });
  assert.deepEqual(dueReminders(l, prefs, NOW).map((r) => r.lead), [60]); // exactly T-60
  assert.deepEqual(dueReminders(l, prefs, NOW + 9 * MIN).map((r) => r.lead), [60]); // within 10 min grace
  assert.deepEqual(dueReminders(l, prefs, NOW + 11 * MIN), []); // grace over, T-10 not yet
  assert.deepEqual(dueReminders(l, prefs, NOW + 50 * MIN).map((r) => r.lead), [10]);
  assert.deepEqual(dueReminders(l, prefs, NOW + 53 * MIN), []); // T-10 grace is 2 min
  assert.deepEqual(dueReminders(l, prefs, NOW - 1 * MIN), []);
});

test('T-24h reminder has a 30 minute grace window', () => {
  const l = launch({ net: new Date(NOW + 1440 * MIN).toISOString() });
  const prefs = sanitizePrefs({});
  assert.deepEqual(dueReminders(l, prefs, NOW + 29 * MIN).map((r) => r.lead), [1440]);
  assert.deepEqual(dueReminders(l, prefs, NOW + 31 * MIN), []);
});

test('a delay re-arms reminders under a new key', () => {
  const prefs = sanitizePrefs({});
  const a = dueReminders(launch({ net: new Date(NOW + 10 * MIN).toISOString() }), prefs, NOW)[0];
  const b = dueReminders(launch({ net: new Date(NOW + 70 * MIN).toISOString() }), prefs, NOW + 60 * MIN)[0];
  assert.equal(a.lead, 10);
  assert.equal(b.lead, 10);
  assert.notEqual(a.key, b.key);
});

test('no reminders for holds, completed launches, vague times or filtered-out launches', () => {
  const prefs = sanitizePrefs({});
  const at = (o) => dueReminders(launch({ net: new Date(NOW + 10 * MIN).toISOString(), ...o }), prefs, NOW);
  assert.deepEqual(at({ status: 'Hold' }), []);
  assert.deepEqual(at({ status: 'Success' }), []);
  assert.deepEqual(at({ precision: 'day' }), []);
  assert.deepEqual(dueReminders(launch({ net: new Date(NOW + 10 * MIN).toISOString(), categories: ['starlink'] }), sanitizePrefs({ filter: 'no-starlink' }), NOW), []);
});

test('detects delays, scrubs, earlier times, holds, resumes, time set, webcast and results', () => {
  const p = launch();
  const kinds = (next, prev = p) => detectEvents(prev, next, NOW).map((e) => e.kind);
  const shift = (min) => new Date(Date.parse(p.net) + min * MIN).toISOString();
  assert.deepEqual(kinds(launch({ net: shift(30) })), ['delay']);
  assert.deepEqual(kinds(launch({ net: shift(24 * 60) })), ['scrub']);
  assert.deepEqual(kinds(launch({ net: shift(-20) })), ['earlier']);
  assert.deepEqual(kinds(launch({ net: shift(3) })), [], 'small nudges are ignored');
  assert.deepEqual(kinds(launch({ status: 'Hold' })), ['hold']);
  assert.deepEqual(kinds(launch({ status: 'Go' }), launch({ status: 'Hold' })), ['resumed']);
  assert.deepEqual(kinds(launch(), launch({ precision: 'day' })), ['time-set']);
  assert.deepEqual(kinds(launch({ webcastLive: true })), ['webcast']);
  assert.deepEqual(kinds(launch({ status: 'Success', webcastLive: true })), ['result'], 'result wins');
  assert.deepEqual(kinds(launch()), []);
});

test('no events for first sightings or launches more than 14 days out', () => {
  assert.deepEqual(detectEvents(null, launch(), NOW), []);
  const far = (o) => launch({ net: new Date(NOW + 20 * 24 * 3600 * 1000).toISOString(), ...o });
  assert.deepEqual(detectEvents(far(), far({ status: 'Hold' }), NOW), []);
});

test('event preferences are respected', () => {
  const l = launch();
  const off = sanitizePrefs({ changes: false, webcast: false, results: false });
  for (const kind of ['delay', 'scrub', 'hold', 'webcast', 'result']) assert.equal(wantsEvent({ kind }, l, off), false, kind);
  const on = sanitizePrefs({});
  for (const kind of ['delay', 'scrub', 'hold', 'webcast', 'result']) assert.equal(wantsEvent({ kind }, l, on), true, kind);
  assert.equal(wantsEvent({ kind: 'delay' }, launch({ categories: ['starlink'] }), sanitizePrefs({ filter: 'crewed' })), false);
});

test('prefs from the client are sanitized', () => {
  assert.deepEqual(sanitizePrefs({}), DEFAULT_PREFS);
  const p = sanitizePrefs({ reminders: [10, '60', 999, 1], filter: 'nope', changes: 0, extra: 'x' });
  assert.deepEqual(p, { reminders: [60, 10, 1], filter: 'all', changes: false, webcast: true, results: true });
});

test('push filters match the calendar feeds', () => {
  const list = buildLaunchList(makeSource(new Date(NOW)), new Date(NOW));
  for (const feed of FEEDS) {
    assert.deepEqual(list.filter((l) => matchesFilter(l, feed.id)).map((l) => l.id), list.filter(feed.filter).map((l) => l.id), feed.id);
  }
});

test('messages are formatted in the subscriber’s time zone', () => {
  const l = launch({ net: '2026-10-24T21:12:00Z' });
  const r = formatMessage('reminder', l, { tz: 'America/Chicago', lead: 10 });
  assert.equal(r.title, 'T-10 min · Crew-12');
  assert.equal(r.body, 'Falcon 9 · LC-39A, Kennedy Space Center · Liftoff 4:12 PM CDT');
  assert.equal(r.url, 'https://youtu.be/x', 'T-10 opens the webcast');
  assert.equal(r.tag, 'launch-L1');
  const day = formatMessage('reminder', l, { tz: 'America/New_York', lead: 1440 });
  assert.equal(day.title, 'T-24 hours · Crew-12');
  assert.match(day.body, /Liftoff Sat 5:12 PM EDT$/);
  assert.equal(day.url, '#L1');
  const d = formatMessage('delay', l, { tz: 'America/Chicago', event: { net: '2026-10-24T21:12:00Z', prevNet: '2026-10-23T22:30:00Z' } });
  assert.equal(d.title, 'Delayed · Crew-12');
  assert.equal(d.body, 'Now Sat 4:12 PM CDT (was Fri 5:30 PM CDT)');
  assert.equal(formatMessage('result', l, { event: { status: 'Success' } }).title, 'Liftoff ✅ · Crew-12');
  assert.equal(formatMessage('webcast', l, { tz: 'UTC' }).url, 'https://youtu.be/x');
  assert.match(formatMessage('reminder', l, { tz: 'Not/AZone', lead: 60 }).body, /UTC$/, 'bad tz falls back to UTC');
});

test('never alerts about something already over (late data)', () => {
  // The real case: a 20-minute hold, but the data only arrived 45 min after liftoff.
  const prev = launch({ net: '2026-10-23T22:28:53Z' });
  const next = launch({ net: '2026-10-23T22:48:44Z', status: 'In Flight' });
  const at = Date.parse('2026-10-23T23:33:00Z');
  assert.deepEqual(detectEvents(prev, next, at), [], 'no "delayed" after the fact');
  assert.deepEqual(detectEvents(prev, launch({ net: '2026-10-23T22:48:44Z' }), at), [], 'new time already passed');
  // Same change seen in time is still reported.
  assert.deepEqual(detectEvents(prev, launch({ net: '2026-10-23T22:48:44Z' }), Date.parse('2026-10-23T22:20:00Z')).map((e) => e.kind), ['delay']);
  // Hold seen after liftoff time: ignored.
  assert.deepEqual(detectEvents(prev, launch({ net: prev.net, status: 'Hold' }), Date.parse('2026-10-23T22:40:00Z')), []);
});

test('results only within 3 hours, webcast-live only until 20 min after liftoff', () => {
  const p = launch({ net: '2026-10-23T22:00:00Z' });
  const at = (iso) => Date.parse(iso);
  assert.deepEqual(detectEvents(p, launch({ net: p.net, status: 'Success' }), at('2026-10-24T00:30:00Z')).map((e) => e.kind), ['result']);
  assert.deepEqual(detectEvents(p, launch({ net: p.net, status: 'Success' }), at('2026-10-24T01:30:00Z')), []);
  assert.deepEqual(detectEvents(p, launch({ net: p.net, webcastLive: true }), at('2026-10-23T21:50:00Z')).map((e) => e.kind), ['webcast']);
  assert.deepEqual(detectEvents(p, launch({ net: p.net, webcastLive: true }), at('2026-10-23T22:15:00Z')).map((e) => e.kind), ['webcast'], 'shortly after liftoff is fine');
  assert.deepEqual(detectEvents(p, launch({ net: p.net, webcastLive: true }), at('2026-10-23T22:30:00Z')), []);
});
