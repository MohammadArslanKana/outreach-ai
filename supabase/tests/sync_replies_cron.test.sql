-- Tests for the pg_cron sync-replies job and the dispatcher allowlist it
-- needs (supabase/migrations/20260928130000_sync_replies_pg_cron.sql).
-- Run against the LOCAL stack only: `supabase test db`.
--
-- Same approach as send_emails_cron.test.sql: everything runs in one
-- transaction that is rolled back. The sentinel Vault secrets and the pg_net
-- requests they produce are never committed, so pg_net's background worker
-- (which only sees committed queue rows) never sends anything, and no real
-- secret is ever read.

set client_min_messages = warning;

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(29);

-- pg_cron jobs ----------------------------------------------------------------
select is((select count(*)::int from cron.job where jobname = 'sync-replies'), 1, 'exactly one sync-replies job');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'sync-replies'),
  row('*/10 * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/sync-replies', 20)$$, 'postgres', true)::text,
  'sync-replies runs every 10 minutes as postgres through the work gate (20261019100000)');
select is((select count(*)::int from cron.job where command like '%/api/cron/sync-replies%'), 1,
  'no other cron job also triggers sync-replies');
select is((select count(*)::int from cron.job where jobname = 'send-emails'), 1, 'send-emails is still exactly one job');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'send-emails'),
  row('* * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/send-emails', 0)$$, 'postgres', true)::text,
  'send-emails runs every minute as postgres through the work gate (20261019100000)');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'cron-job-run-details-cleanup'),
  row('17 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$, 'postgres', true)::text,
  'the run-history cleanup job is unchanged');
select ok(not exists (select 1 from cron.job where command ilike '%bearer%' or command ilike '%vault%' or command ilike '%sentinel%'),
  'no cron job command contains a bearer token, a Vault lookup or a secret');

-- Still one dispatcher, with the same security ---------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'invoke_cron_endpoint'), 1,
  'there is still exactly one invoke_cron_endpoint (no second dispatcher or overload)');
select is((select prosecdef from pg_proc where oid = 'private.invoke_cron_endpoint(text)'::regprocedure), false,
  'invoke_cron_endpoint is still SECURITY INVOKER');
select is((select proconfig from pg_proc where oid = 'private.invoke_cron_endpoint(text)'::regprocedure), array['search_path=""'],
  'invoke_cron_endpoint still pins an empty search_path');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'private.invoke_cron_endpoint(text)'::regprocedure and a.grantee = 0),
  'PUBLIC still has no EXECUTE on invoke_cron_endpoint');
select ok(not has_function_privilege('anon', 'private.invoke_cron_endpoint(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.invoke_cron_endpoint(text)', 'execute')
  and not has_function_privilege('service_role', 'private.invoke_cron_endpoint(text)', 'execute'),
  'anon, authenticated and service_role still cannot execute invoke_cron_endpoint');

-- Calling it for the newly allowed path as each API role is refused.
create temp table call_results (role_name text, outcome text);
grant insert on call_results to anon, authenticated, service_role;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    execute format('set local role %I', r);
    begin
      perform private.invoke_cron_endpoint('/api/cron/sync-replies');
      insert into call_results values (r, 'called');
    exception when insufficient_privilege then
      insert into call_results values (r, 'denied');
    end;
    reset role;
  end loop;
end $$;
select is((select array_agg(role_name || ':' || outcome order by role_name) from call_results),
  array['anon:denied', 'authenticated:denied', 'service_role:denied'],
  'anon, authenticated and service_role are all denied when calling it for /api/cron/sync-replies');

-- Allowlist -------------------------------------------------------------------
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/not-a-cron-job')$$, '42501', null,
  'an unrelated cron route is still rejected');
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/sync-replies/../warmup-cycle')$$, '42501', null,
  'a path that merely starts with the new allowed one is rejected');
select throws_ok($$select private.invoke_cron_endpoint(null)$$, '42501', null, 'a null path is still rejected');

-- Secrets unavailable (local/dev): still the logged no-op ------------------------
delete from vault.secrets where name in ('cron_app_url', 'cron_secret');
create temp table queue_before as select coalesce(max(id), 0) as max_id from net.http_request_queue;
select is(private.invoke_cron_endpoint('/api/cron/sync-replies'), null,
  'without the Vault secrets, sync-replies is a no-op returning null');
select is(private.invoke_cron_endpoint('/api/cron/send-emails'), null,
  '...and so is send-emails (both paths are allowed, neither dispatches)');
select is((select count(*)::int from net.http_request_queue where id > (select max_id from queue_before)), 0,
  '...and no HTTP request is queued');

-- Secrets available: the same request shape for both routes ---------------------
do $$ begin perform vault.create_secret('https://sentinel-app.invalid/', 'cron_app_url'); end $$;
do $$ begin perform vault.create_secret('sentinel-cron-secret-5d2e81', 'cron_secret'); end $$;
create temp table dispatched as
  select 'sync' as route, private.invoke_cron_endpoint('/api/cron/sync-replies') as request_id
  union all
  select 'send', private.invoke_cron_endpoint('/api/cron/send-emails');
select isnt((select request_id from dispatched where route = 'sync'), null,
  'with both secrets, sync-replies queues a request and returns its id');
select is((select url from net.http_request_queue where id = (select request_id from dispatched where route = 'sync')),
  'https://sentinel-app.invalid/api/cron/sync-replies', 'the request targets cron_app_url + /api/cron/sync-replies');
select is((select method::text from net.http_request_queue where id = (select request_id from dispatched where route = 'sync')), 'POST',
  'the sync-replies request is a POST');
select is((select headers ->> 'Authorization' from net.http_request_queue where id = (select request_id from dispatched where route = 'sync')),
  'Bearer sentinel-cron-secret-5d2e81', 'the sync-replies request carries the Vault cron_secret as a bearer token');
select is((select timeout_milliseconds from net.http_request_queue where id = (select request_id from dispatched where route = 'sync')), 240000,
  'the sync-replies request uses the same 4-minute timeout');
select isnt((select request_id from dispatched where route = 'send'), null,
  'send-emails is still allowed and still queues a request');
select is((select url from net.http_request_queue where id = (select request_id from dispatched where route = 'send')),
  'https://sentinel-app.invalid/api/cron/send-emails', '...to cron_app_url + /api/cron/send-emails, as before');
select is((select headers ->> 'Authorization' from net.http_request_queue where id = (select request_id from dispatched where route = 'send')),
  'Bearer sentinel-cron-secret-5d2e81', '...with the same Vault cron_secret bearer token');
select ok((select prosrc like '%''cron_app_url''%' and prosrc like '%''cron_secret''%'
    from pg_proc where oid = 'private.invoke_cron_endpoint(text)'::regprocedure),
  'the dispatcher still reads the cron_app_url and cron_secret Vault secrets by name');
select ok(not exists (select 1 from cron.job_run_details where command ilike '%sentinel%' or command ilike '%bearer%'),
  'no recorded cron run contains the secret or a bearer token');

select * from finish();
rollback;
