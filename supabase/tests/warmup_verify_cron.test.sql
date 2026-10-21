-- Tests for the pg_cron warmup-cycle and verify-leads jobs and the dispatcher
-- allowlist they need (supabase/migrations/20260929100000_warmup_verify_pg_cron.sql).
-- Run against the LOCAL stack only: `supabase test db`.
--
-- Same approach as send_emails_cron.test.sql and sync_replies_cron.test.sql:
-- everything runs in one transaction that is rolled back. The sentinel Vault
-- secrets and the pg_net requests they produce are never committed, so
-- pg_net's background worker (which only sees committed queue rows) never
-- sends anything, and no real secret is ever read.

set client_min_messages = warning;

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

-- pg_cron jobs ----------------------------------------------------------------
select is((select count(*)::int from cron.job where jobname = 'warmup-cycle'), 1, 'exactly one warmup-cycle job');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'warmup-cycle'),
  row('7,22,37,52 * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/warmup-cycle', 7)$$, 'postgres', true)::text,
  'warmup-cycle runs at :07/:22/:37/:52 as postgres through the work gate');
select is((select count(*)::int from cron.job where command like '%/api/cron/warmup-cycle%'), 1,
  'no other cron job also triggers warmup-cycle');
select is((select count(*)::int from cron.job where jobname = 'verify-leads'), 1, 'exactly one verify-leads job');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'verify-leads'),
  row('3-59/10 * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/verify-leads', 33)$$, 'postgres', true)::text,
  'verify-leads runs every 10 minutes from :03 as postgres through the work gate');
select is((select count(*)::int from cron.job where command like '%/api/cron/verify-leads%'), 1,
  'no other cron job also triggers verify-leads');
select is((select count(*)::int from cron.job where jobname = 'send-emails'), 1, 'send-emails is still exactly one job');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'send-emails'),
  row('* * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/send-emails', 0)$$, 'postgres', true)::text,
  'send-emails runs every minute as postgres through the work gate (20261019100000)');
select is((select count(*)::int from cron.job where jobname = 'sync-replies'), 1, 'sync-replies is still exactly one job');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'sync-replies'),
  row('*/10 * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/sync-replies', 20)$$, 'postgres', true)::text,
  'sync-replies runs every 10 minutes through the work gate (20261019100000)');
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

-- Calling it for either newly allowed path as each API role is refused.
create temp table call_results (role_name text, path text, outcome text);
grant insert on call_results to anon, authenticated, service_role;
do $$
declare r text; p text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    foreach p in array array['/api/cron/warmup-cycle', '/api/cron/verify-leads'] loop
      execute format('set local role %I', r);
      begin
        perform private.invoke_cron_endpoint(p);
        insert into call_results values (r, p, 'called');
      exception when insufficient_privilege then
        insert into call_results values (r, p, 'denied');
      end;
      reset role;
    end loop;
  end loop;
end $$;
select is((select array_agg(distinct outcome) from call_results), array['denied'],
  'anon, authenticated and service_role are all denied for both /api/cron/warmup-cycle and /api/cron/verify-leads');

-- Allowlist -------------------------------------------------------------------
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/not-a-cron-job')$$, '42501', null,
  'an unrelated cron route is still rejected');
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/deliverability-health-check-all')$$, '42501', null,
  'a path sharing a later-allowed route prefix but not explicitly allowed is rejected');
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/warmup-cycle/../send-emails')$$, '42501', null,
  'a path that merely starts with the new allowed warmup route is rejected');
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/verify-leads-all')$$, '42501', null,
  'a path sharing the verify-leads prefix but not explicitly allowed is rejected');
select throws_ok($$select private.invoke_cron_endpoint(null)$$, '42501', null, 'a null path is still rejected');

-- Secrets unavailable (local/dev): still the logged no-op ------------------------
delete from vault.secrets where name in ('cron_app_url', 'cron_secret');
create temp table queue_before as select coalesce(max(id), 0) as max_id from net.http_request_queue;
select is(private.invoke_cron_endpoint('/api/cron/warmup-cycle'), null,
  'without the Vault secrets, warmup-cycle is a no-op returning null');
select is(private.invoke_cron_endpoint('/api/cron/verify-leads'), null,
  '...and so is verify-leads');
select is((select count(*)::int from net.http_request_queue where id > (select max_id from queue_before)), 0,
  '...and no HTTP request is queued');

-- Secrets available: the same request shape for every allowed route -------------
do $$ begin perform vault.create_secret('https://sentinel-app.invalid/', 'cron_app_url'); end $$;
do $$ begin perform vault.create_secret('sentinel-cron-secret-9b4f17', 'cron_secret'); end $$;
create temp table dispatched as
  select 'warmup' as route, private.invoke_cron_endpoint('/api/cron/warmup-cycle') as request_id
  union all
  select 'verify', private.invoke_cron_endpoint('/api/cron/verify-leads')
  union all
  select 'send', private.invoke_cron_endpoint('/api/cron/send-emails')
  union all
  select 'sync', private.invoke_cron_endpoint('/api/cron/sync-replies');
select isnt((select request_id from dispatched where route = 'warmup'), null,
  'with both secrets, warmup-cycle queues a request and returns its id');
select is((select url from net.http_request_queue where id = (select request_id from dispatched where route = 'warmup')),
  'https://sentinel-app.invalid/api/cron/warmup-cycle', 'the request targets cron_app_url + /api/cron/warmup-cycle');
select is((select method::text from net.http_request_queue where id = (select request_id from dispatched where route = 'warmup')), 'POST',
  'the warmup-cycle request is a POST');
select is((select headers ->> 'Authorization' from net.http_request_queue where id = (select request_id from dispatched where route = 'warmup')),
  'Bearer sentinel-cron-secret-9b4f17', 'the warmup-cycle request carries the Vault cron_secret as a bearer token');
select is((select timeout_milliseconds from net.http_request_queue where id = (select request_id from dispatched where route = 'warmup')), 240000,
  'the warmup-cycle request uses the same 4-minute timeout');
select isnt((select request_id from dispatched where route = 'verify'), null,
  'with both secrets, verify-leads queues a request and returns its id');
select is((select url from net.http_request_queue where id = (select request_id from dispatched where route = 'verify')),
  'https://sentinel-app.invalid/api/cron/verify-leads', 'the request targets cron_app_url + /api/cron/verify-leads');
select is((select method::text from net.http_request_queue where id = (select request_id from dispatched where route = 'verify')), 'POST',
  'the verify-leads request is a POST');
select is((select headers ->> 'Authorization' from net.http_request_queue where id = (select request_id from dispatched where route = 'verify')),
  'Bearer sentinel-cron-secret-9b4f17', 'the verify-leads request carries the Vault cron_secret as a bearer token');
select is((select timeout_milliseconds from net.http_request_queue where id = (select request_id from dispatched where route = 'verify')), 240000,
  'the verify-leads request uses the same 4-minute timeout');
select isnt((select request_id from dispatched where route = 'send'), null,
  'send-emails is still allowed and still queues a request');
select isnt((select request_id from dispatched where route = 'sync'), null,
  'sync-replies is still allowed and still queues a request');
select ok(not exists (select 1 from cron.job_run_details where command ilike '%sentinel%' or command ilike '%bearer%'),
  'no recorded cron run contains the secret or a bearer token');

select * from finish();
rollback;
