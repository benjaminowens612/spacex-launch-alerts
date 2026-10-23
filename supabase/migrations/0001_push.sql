-- LaunchView push notifications: schema.
-- Every table has RLS on and no policies, and table privileges are revoked
-- from the public roles: only the Edge Functions (service role / postgres)
-- can read or write.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Last seen snapshot of each launch (the objects from docs/data/launches.json).
create table public.launches (
  id          text primary key,
  snapshot    jsonb not null,
  net         timestamptz not null,
  status      text not null,
  updated_at  timestamptz not null default now()
);
create index launches_net_idx on public.launches (net);

-- One row per installed app / browser that turned notifications on.
create table public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  token_hash    text not null,            -- sha256 of the device token kept on the phone
  prefs         jsonb not null,
  tz            text not null default 'UTC',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_ok_at    timestamptz,
  last_test_at  timestamptz,
  fail_count    int not null default 0
);

-- Changes detected between data refreshes (delay, scrub, hold, webcast, result…).
create table public.launch_events (
  id          bigint generated always as identity primary key,
  launch_id   text not null,
  kind        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
create index launch_events_created_idx on public.launch_events (created_at);

-- What has been sent to whom; the primary key is the dedupe guarantee.
create table public.deliveries (
  subscription_id  uuid not null references public.push_subscriptions (id) on delete cascade,
  dedupe_key       text not null,
  sent_at          timestamptz not null default now(),
  primary key (subscription_id, dedupe_key)
);
create index deliveries_sent_idx on public.deliveries (sent_at);

-- Small key/value store: ETag of the last fetch, VAPID keys, dispatch secret.
create table public.app_state (
  key    text primary key,
  value  jsonb not null
);

alter table public.launches           enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.launch_events      enable row level security;
alter table public.deliveries         enable row level security;
alter table public.app_state          enable row level security;

revoke all on public.launches, public.push_subscriptions, public.launch_events, public.deliveries, public.app_state
  from anon, authenticated;

-- Shared secret the cron job sends to the dispatch function. Generated here so
-- it never leaves the database / Edge runtime.
insert into public.app_state (key, value)
values ('dispatch_secret', to_jsonb(encode(extensions.gen_random_bytes(32), 'hex')));
