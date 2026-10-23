// Runs every minute (pg_cron → pg_net). Ingests the published launch data,
// records what changed, and sends due reminders and change alerts.
import { DATA_URL, SITE_URL, getState, getVapidKeys, json, safeEqual, setState, sql } from '../_shared/store.ts';
import { detectEvents, dueReminders, formatMessage, sanitizePrefs, wantsEvent } from '../_shared/rules.js';
import { sendPush } from '../_shared/webpush.js';

const MAX_PER_SUB_PER_RUN = 6;

type Launch = Record<string, any> & { id: string; net: string; status: string };

async function ingest(now: number) {
  const etag = await getState<string>('etag');
  const res = await fetch(DATA_URL, { headers: etag ? { 'If-None-Match': etag } : {} });
  if (res.status === 304) return { changed: false, events: 0 };
  if (!res.ok) throw new Error(`launches.json HTTP ${res.status}`);
  const data = await res.json();
  const launches: Launch[] = data.launches ?? [];

  const rows = await sql`select id, snapshot from launches`;
  const prev = new Map(rows.map((r) => [r.id as string, r.snapshot as Launch]));
  const firstIngest = rows.length === 0; // never alert about the initial load

  let events = 0;
  for (const l of launches) {
    if (!firstIngest) {
      for (const e of detectEvents(prev.get(l.id) ?? null, l, now)) {
        await sql`insert into launch_events (launch_id, kind, payload) values (${l.id}, ${e.kind}, ${sql.json(e)})`;
        events++;
      }
    }
    await sql`insert into launches (id, snapshot, net, status, updated_at)
              values (${l.id}, ${sql.json(l as never)}, ${l.net}, ${l.status}, now())
              on conflict (id) do update set snapshot = excluded.snapshot, net = excluded.net,
                status = excluded.status, updated_at = now()`;
  }
  const ids = launches.map((l) => l.id);
  await sql`delete from launches where net < now() - interval '3 days' and not (id = any(${ids}))`;
  const newTag = res.headers.get('etag');
  if (newTag) await setState('etag', newTag);
  return { changed: true, events, launches: launches.length, firstIngest };
}

async function deliver(sub: any, key: string | null, msg: object, ctx: { keys: any }) {
  if (key) {
    const claimed = await sql`insert into deliveries (subscription_id, dedupe_key) values (${sub.id}, ${key})
                              on conflict do nothing returning 1`;
    if (!claimed.length) return 'dup';
  }
  const result = await sendPush(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    msg,
    { keys: ctx.keys, subject: SITE_URL, ttl: 3600 },
  );
  if (result.gone) {
    await sql`delete from push_subscriptions where id = ${sub.id}`;
    return 'gone';
  }
  if (!result.ok) {
    console.error('push failed', result.status, result.error);
    if (key) await sql`delete from deliveries where subscription_id = ${sub.id} and dedupe_key = ${key}`; // retry next run
    await sql`update push_subscriptions set fail_count = fail_count + 1 where id = ${sub.id}`;
    // e.g. Apple's 400 BadDeviceToken never recovers; stop retrying after a while.
    await sql`delete from push_subscriptions where id = ${sub.id} and fail_count >= 30`;
    return 'failed';
  }
  await sql`update push_subscriptions set last_ok_at = now(), fail_count = 0 where id = ${sub.id}`;
  return 'sent';
}

async function dispatch(now: number) {
  const subs = await sql`select * from push_subscriptions`;
  if (!subs.length) return { subscribers: 0, sent: 0 };
  const keys = await getVapidKeys();
  const upcoming = (await sql`select snapshot from launches where net between now() - interval '1 hour' and now() + interval '25 hours'`)
    .map((r) => r.snapshot as Launch);
  const events = await sql`select e.id, e.kind, e.payload, e.created_at, l.snapshot from launch_events e join launches l on l.id = e.launch_id
                           where e.created_at > now() - interval '3 hours' order by e.id`;

  const tally: Record<string, number> = { sent: 0, failed: 0, gone: 0, dup: 0 };
  for (const sub of subs) {
    const prefs = sanitizePrefs(sub.prefs);
    const todo: { key: string; msg: object }[] = [];
    for (const e of events) {
      if (new Date(e.created_at) < new Date(sub.created_at)) continue; // nothing from before they subscribed
      if (wantsEvent({ ...e.payload, kind: e.kind }, e.snapshot, prefs)) {
        todo.push({ key: `e:${e.id}`, msg: formatMessage(e.kind, e.snapshot, { tz: sub.tz, event: e.payload }) });
      }
    }
    for (const l of upcoming) {
      for (const r of dueReminders(l, prefs, now)) {
        todo.push({ key: r.key, msg: formatMessage('reminder', l, { tz: sub.tz, lead: r.lead }) });
      }
    }
    for (const t of todo.slice(0, MAX_PER_SUB_PER_RUN)) {
      const outcome = await deliver(sub, t.key, t.msg, { keys });
      tally[outcome]++;
      if (outcome === 'gone') break;
    }
  }
  return { subscribers: subs.length, ...tally };
}

/** Send one of each alert type for the next launch, so formatting can be checked on a phone. */
async function simulate() {
  const subs = await sql`select * from push_subscriptions`;
  const [row] = await sql`select snapshot from launches where net > now() order by net limit 1`;
  if (!row || !subs.length) return { simulated: 0 };
  const l = row.snapshot as Launch;
  const keys = await getVapidKeys();
  const prevNet = new Date(Date.parse(l.net) - 45 * 60000).toISOString();
  const samples: [string, Record<string, unknown>][] = [
    ['reminder', { lead: 10 }],
    ['delay', { event: { net: l.net, prevNet } }],
    ['webcast', {}],
    ['result', { event: { status: 'Success' } }],
  ];
  let sent = 0;
  for (const sub of subs) {
    for (const [i, [kind, opts]] of samples.entries()) {
      // Distinct tags so the four samples don't replace each other on the phone.
      const msg = { ...formatMessage(kind, l, { tz: sub.tz, ...opts }), tag: `sim-${i}` };
      if ((await deliver(sub, null, msg, { keys })) === 'sent') sent++;
    }
  }
  return { simulated: sent };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const secret = await getState<string>('dispatch_secret');
  if (!secret || !safeEqual(req.headers.get('x-dispatch-secret') ?? '', secret)) return json({ error: 'forbidden' }, 403);
  const body = await req.json().catch(() => ({}));
  const now = Date.now();
  try {
    if (body.simulate) return json(await simulate());
    const ingested = await ingest(now).catch((e) => ({ error: String(e) }));
    const sent = await dispatch(now);
    await sql`delete from deliveries where sent_at < now() - interval '30 days'`;
    await sql`delete from launch_events where created_at < now() - interval '7 days'`;
    const result = { ingested, ...sent };
    if ((sent as any).sent || (ingested as any).events || (ingested as any).error) console.log(JSON.stringify(result));
    return json(result);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
