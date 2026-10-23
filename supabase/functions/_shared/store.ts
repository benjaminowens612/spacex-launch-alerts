// Database helpers shared by the Edge Functions.
import postgres from 'npm:postgres@3.4.5';
import { generateVapidKeys } from './webpush.js';

export const SITE_URL = 'https://benjaminowens612.github.io/spacex-launch-alerts/';
export const DATA_URL = `${SITE_URL}data/launches.json`;

// Transaction-mode pooler: prepared statements must be off.
export const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });

export async function getState<T = unknown>(key: string): Promise<T | null> {
  const rows = await sql`select value from app_state where key = ${key}`;
  return rows.length ? (rows[0].value as T) : null;
}

export async function setState(key: string, value: unknown) {
  await sql`insert into app_state (key, value) values (${key}, ${sql.json(value as never)})
            on conflict (key) do update set value = excluded.value`;
}

/** VAPID key pair, generated on first use and kept in the database (never leaves the backend). */
export async function getVapidKeys(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  const existing = await getState<{ publicKey: JsonWebKey; privateKey: JsonWebKey }>('vapid');
  if (existing) return existing;
  const fresh = await generateVapidKeys();
  await sql`insert into app_state (key, value) values ('vapid', ${sql.json(fresh as never)}) on conflict (key) do nothing`;
  return (await getState('vapid'))!; // another instance may have won the race
}

/** Constant-time string compare for shared secrets. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
