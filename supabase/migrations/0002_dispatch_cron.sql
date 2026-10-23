-- Run the dispatch Edge Function every minute. The shared secret is read from
-- app_state at run time, so it never appears in the job definition.
select cron.schedule(
  'launchview-dispatch',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://dzlbxtbdymrusxzdroya.supabase.co/functions/v1/dispatch',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', (select value #>> '{}' from public.app_state where key = 'dispatch_secret')
    ),
    timeout_milliseconds := 55000
  );
  $$
);
