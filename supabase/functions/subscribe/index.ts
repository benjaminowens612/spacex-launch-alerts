// Public endpoint the LaunchView app calls to turn notifications on/off,
// update preferences, and send itself a test push.
import { SITE_URL, getVapidKeys, json, sha256Hex, sql } from '../_shared/store.ts';
import { formatMessage, sanitizePrefs } from '../_shared/rules.js';
import { applicationServerKey, sendPush } from '../_shared/webpush.js';

const ORIGINS = new Set(['https://benjaminowens612.github.io', 'http://localhost:8080', 'http://localhost:8081']);
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_BODY = 8 * 1024;

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.has(origin) ? origin : 'https://benjaminowens612.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    Vary: 'Origin',
  };
}

function validEndpoint(endpoint: unknown) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname)) && String(endpoint).length < 1024;
  } catch {
    return false;
  }
}

function validTz(tz: unknown) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return String(tz).slice(0, 64);
  } catch {
    return 'UTC';
  }
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      if (url.searchParams.has('ping')) {
        await sql`select 1`; // keeps the free project "active"
        return json({ ok: true }, 200, h);
      }
      const keys = await getVapidKeys();
      return json({ publicKey: applicationServerKey(keys.publicKey) }, 200, { ...h, 'Cache-Control': 'max-age=3600' });
    }
    if (req.method !== 'POST') return json({ error: 'method' }, 405, h);

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413, h);
    const body = JSON.parse(raw);
    const sub = body.subscription ?? {};
    if (!validEndpoint(sub.endpoint)) return json({ error: 'bad endpoint' }, 400, h);
    if (typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 200) return json({ error: 'bad token' }, 400, h);
    const tokenHash = await sha256Hex(body.token);

    if (body.action === 'save') {
      const p256dh = String(sub.keys?.p256dh ?? '');
      const auth = String(sub.keys?.auth ?? '');
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return json({ error: 'bad keys' }, 400, h);
      const prefs = sanitizePrefs(body.prefs);
      // Holding the endpoint and its keys proves this is the same browser, so a
      // reinstall (new device token) may take the row over.
      const [row] = await sql`insert into push_subscriptions (endpoint, p256dh, auth, token_hash, prefs, tz)
        values (${sub.endpoint}, ${p256dh}, ${auth}, ${tokenHash}, ${sql.json(prefs)}, ${validTz(body.tz)})
        on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, token_hash = excluded.token_hash,
          prefs = excluded.prefs, tz = excluded.tz, updated_at = now()
        returning id`;
      return json({ ok: true, id: row.id, prefs }, 200, h);
    }

    const [row] = await sql`select * from push_subscriptions where endpoint = ${sub.endpoint} and token_hash = ${tokenHash}`;
    if (!row) return json({ error: 'not found' }, 404, h);

    if (body.action === 'delete') {
      await sql`delete from push_subscriptions where id = ${row.id}`;
      return json({ ok: true }, 200, h);
    }

    if (body.action === 'test') {
      if (row.last_test_at && Date.now() - Date.parse(row.last_test_at) < 60_000) return json({ error: 'wait a minute' }, 429, h);
      await sql`update push_subscriptions set last_test_at = now() where id = ${row.id}`;
      const result = await sendPush(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        formatMessage('test', { id: 'test', mission: 'LaunchView', vehicle: '' }),
        { keys: await getVapidKeys(), subject: SITE_URL, ttl: 300 },
      );
      if (result.gone) await sql`delete from push_subscriptions where id = ${row.id}`;
      return json({ ok: result.ok, status: result.status, error: result.error || undefined }, result.ok ? 200 : 502, h);
    }

    return json({ error: 'unknown action' }, 400, h);
  } catch (e) {
    console.error(e);
    return json({ error: 'server error' }, 500, h);
  }
});
