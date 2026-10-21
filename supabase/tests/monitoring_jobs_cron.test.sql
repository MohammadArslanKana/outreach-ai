-- Tests for the pg_cron deliverability-health-check, analytics-rollup,
-- retention-cleanup and integrations-digest jobs and the dispatcher allowlist
-- they need (supabase/migrations/20261008100000_monitoring_jobs_pg_cron.sql).
-- Run against the LOCAL stack only: `supabase test db`.
--
-- Same approach as send_emails_cron.test.sql, sync_replies_cron.test.sql and
-- warmup_verify_cron.test.sql: everything runs in one transaction that is
-- rolled back. The sentinel Vault secrets and the pg_net requests they
-- produce are never committed, so pg_net's background worker (which only sees
-- committed queue rows) never sends anything, and no real secret is ever read.

set client_min_messages = warning;

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(56);

create temp table new_jobs (jobname text, schedule text, path text);
insert into new_jobs values
  ('deliverability-health-check', '41 * * * *', '/api/cron/deliverability-health-check'),
  ('analytics-rollup', '5 1 * * *', '/api/cron/analytics-rollup'),
  ('retention-cleanup', '10 2 * * *', '/api/cron/retention-cleanup'),
  ('integrations-digest', '15 8 * * *', '/api/cron/integrations-digest');

-- pg_cron jobs ----------------------------------------------------------------
select is((select count(*)::int from cron.job c where c.jobname = n.jobname), 1, 'exactly one ' || n.jobname || ' job')
from new_jobs n order by n.jobname;

select is(
  (select row(c.schedule, c.command, c.username, c.active)::text from cron.job c where c.jobname = n.jobname),
  row(n.schedule, format('select private.invoke_cron_endpoint(%L)', n.path), 'postgres', true)::text,
  n.jobname || ' runs at "' || n.schedule || '" as postgres with only the dispatcher call for ' || n.path)
from new_jobs n order by n.jobname;

select is((select count(*)::int from cron.job c where c.command like '%' || n.path || '''%'), 1,
  'no other cron job also triggers ' || n.jobname)
from new_jobs n order by n.jobname;

select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'send-emails'),
  row('* * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/send-emails', 0)$$, 'postgres', true)::text,
  'send-emails runs through the work gate (20261019100000)');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'sync-replies'),
  row('*/10 * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/sync-replies', 20)$$, 'postgres', true)::text,
  'sync-replies runs every 10 minutes through the work gate');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'warmup-cycle'),
  row('7,22,37,52 * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/warmup-cycle', 7)$$, 'postgres', true)::text,
  'warmup-cycle runs through the work gate');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'verify-leads'),
  row('3-59/10 * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/verify-leads', 33)$$, 'postgres', true)::text,
  'verify-leads runs through the work gate');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'cron-job-run-details-cleanup'),
  row('17 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$, 'postgres', true)::text,
  'the run-history cleanup job is unchanged');
select is((select count(*)::int from cron.job), 9,
  'nine cron jobs in total: the eight app routes and the run-history cleanup');
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

-- Calling it for any newly allowed path as each API role is refused.
create temp table call_results (role_name text, path text, outcome text);
grant insert on call_results to anon, authenticated, service_role;
grant select on new_jobs to anon, authenticated, service_role;
do $$
declare r text; p text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    for p in select path from new_jobs loop
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
  'anon, authenticated and service_role are all denied for all four newly allowed routes');

-- Allowlist -------------------------------------------------------------------
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/not-a-cron-job')$$, '42501', null,
  'an unrelated cron route is still rejected');
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/analytics-rollup-backfill')$$, '42501', null,
  'a path sharing a newly allowed route prefix but not explicitly allowed is rejected');
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/retention-cleanup/../send-emails')$$, '42501', null,
  'a path that merely starts with a newly allowed route is rejected');
select throws_ok($$select private.invoke_cron_endpoint(null)$$, '42501', null, 'a null path is still rejected');

-- Secrets unavailable (local/dev): still the logged no-op ------------------------
delete from vault.secrets where name in ('cron_app_url', 'cron_secret');
create temp table queue_before as select coalesce(max(id), 0) as max_id from net.http_request_queue;
select is(private.invoke_cron_endpoint(n.path), null, 'without the Vault secrets, ' || n.jobname || ' is a no-op returning null')
from new_jobs n order by n.jobname;
select is((select count(*)::int from net.http_request_queue where id > (select max_id from queue_before)), 0,
  '...and no HTTP request is queued');

-- Secrets available: the same request shape for every newly allowed route ------
do $$ begin perform vault.create_secret('https://sentinel-app.invalid/', 'cron_app_url'); end $$;
do $$ begin perform vault.create_secret('sentinel-cron-secret-5c2e81', 'cron_secret'); end $$;
create temp table dispatched as
  select n.jobname, n.path, private.invoke_cron_endpoint(n.path) as request_id from new_jobs n;

select isnt(d.request_id, null, 'with both secrets, ' || d.jobname || ' queues a request and returns its id')
from dispatched d order by d.jobname;
select is((select q.url from net.http_request_queue q where q.id = d.request_id),
  'https://sentinel-app.invalid' || d.path, 'the ' || d.jobname || ' request targets cron_app_url + ' || d.path)
from dispatched d order by d.jobname;
select is((select q.method::text from net.http_request_queue q where q.id = d.request_id), 'POST',
  'the ' || d.jobname || ' request is a POST')
from dispatched d order by d.jobname;
select is((select q.headers ->> 'Authorization' from net.http_request_queue q where q.id = d.request_id),
  'Bearer sentinel-cron-secret-5c2e81', 'the ' || d.jobname || ' request carries the Vault cron_secret as a bearer token')
from dispatched d order by d.jobname;
select is((select q.timeout_milliseconds from net.http_request_queue q where q.id = d.request_id), 240000,
  'the ' || d.jobname || ' request uses the same 4-minute timeout')
from dispatched d order by d.jobname;

select ok(
  private.invoke_cron_endpoint('/api/cron/send-emails') is not null
  and private.invoke_cron_endpoint('/api/cron/sync-replies') is not null
  and private.invoke_cron_endpoint('/api/cron/warmup-cycle') is not null
  and private.invoke_cron_endpoint('/api/cron/verify-leads') is not null,
  'send-emails, sync-replies, warmup-cycle and verify-leads are still allowed and still queue requests');
select ok(not exists (select 1 from cron.job_run_details where command ilike '%sentinel%' or command ilike '%bearer%'),
  'no recorded cron run contains the secret or a bearer token');

select * from finish();
rollback;
