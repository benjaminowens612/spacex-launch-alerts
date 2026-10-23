-- Keep pg_net out of the public schema (security advisor 0014).
drop extension if exists pg_net;
create extension pg_net with schema extensions;
