-- Tests for the pg_cron send-emails dispatcher
-- (supabase/migrations/20260926120000_send_emails_pg_cron.sql).
-- Run against the LOCAL stack only: `supabase test db`.
--
-- Everything runs in one transaction that is rolled back. The sentinel
-- Vault secrets and the pg_net request they produce are never committed,
-- so pg_net's background worker (which only sees committed queue rows)
-- never sends anything, and no real secret is ever read.

set client_min_messages = warning;

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(30);

-- Extensions --------------------------------------------------------------------
select ok(exists (select 1 from pg_extension where extname = 'pg_cron'), 'pg_cron is installed');
select ok(exists (select 1 from pg_extension where extname = 'pg_net'), 'pg_net is installed');

-- Function security -----------------------------------------------------------
select has_function('private', 'invoke_cron_endpoint', array['text'], 'private.invoke_cron_endpoint(text) exists');
select is((select prosecdef from pg_proc where oid = 'private.invoke_cron_endpoint(text)'::regprocedure), false,
  'invoke_cron_endpoint is SECURITY INVOKER');
select is((select proconfig from pg_proc where oid = 'private.invoke_cron_endpoint(text)'::regprocedure), array['search_path=""'],
  'invoke_cron_endpoint pins an empty search_path');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'private.invoke_cron_endpoint(text)'::regprocedure and a.grantee = 0),
  'PUBLIC has no EXECUTE on invoke_cron_endpoint');
select ok(not has_function_privilege('anon', 'private.invoke_cron_endpoint(text)', 'execute'), 'anon cannot execute invoke_cron_endpoint');
select ok(not has_function_privilege('authenticated', 'private.invoke_cron_endpoint(text)', 'execute'), 'authenticated cannot execute invoke_cron_endpoint');
select ok(not has_function_privilege('service_role', 'private.invoke_cron_endpoint(text)', 'execute'), 'service_role cannot execute invoke_cron_endpoint');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon has no usage on schema private');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated has no usage on schema private');
select ok(not has_schema_privilege('service_role', 'private', 'usage'), 'service_role has no usage on schema private');

-- Actually calling it as each API role is refused.
create temp table call_results (role_name text, outcome text);
grant insert on call_results to anon, authenticated, service_role;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    execute format('set local role %I', r);
    begin
      perform private.invoke_cron_endpoint('/api/cron/send-emails');
      insert into call_results values (r, 'called');
    exception when insufficient_privilege then
      insert into call_results values (r, 'denied');
    end;
    reset role;
  end loop;
end $$;
select is((select array_agg(role_name || ':' || outcome order by role_name) from call_results),
  array['anon:denied', 'authenticated:denied', 'service_role:denied'],
  'anon, authenticated and service_role are all denied when calling it');

-- Allowlist -------------------------------------------------------------------
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/not-a-cron-job')$$, '42501', null,
  'another cron route is rejected');
select throws_ok($$select private.invoke_cron_endpoint('/api/cron/send-emails/../sync-replies')$$, '42501', null,
  'a path that merely starts with the allowed one is rejected');
select throws_ok($$select private.invoke_cron_endpoint(null)$$, '42501', null, 'a null path is rejected');

-- Secrets unavailable (local/dev) -----------------------------------------------
delete from vault.secrets where name in ('cron_app_url', 'cron_secret');
create temp table queue_before as select coalesce(max(id), 0) as max_id from net.http_request_queue;
select is(private.invoke_cron_endpoint('/api/cron/send-emails'), null,
  'without the Vault secrets it is a no-op returning null');
select is((select count(*)::int from net.http_request_queue where id > (select max_id from queue_before)), 0,
  '...and queues no HTTP request');
do $$ begin perform vault.create_secret('https://sentinel-app.invalid/', 'cron_app_url'); end $$;
select is(private.invoke_cron_endpoint('/api/cron/send-emails'), null,
  'with only one of the two secrets it is still a no-op');

-- Secrets available: the request it queues ------------------------------------
do $$ begin perform vault.create_secret('sentinel-cron-secret-7f3a9c', 'cron_secret'); end $$;
create temp table dispatched as select private.invoke_cron_endpoint('/api/cron/send-emails') as request_id;
select isnt((select request_id from dispatched), null, 'with both secrets it queues a request and returns its id');
select is((select url from net.http_request_queue where id = (select request_id from dispatched)),
  'https://sentinel-app.invalid/api/cron/send-emails', 'the request targets cron_app_url + the allowlisted path (trailing slash handled)');
select is((select method::text from net.http_request_queue where id = (select request_id from dispatched)), 'POST',
  'the request is a POST');
select is((select headers ->> 'Authorization' from net.http_request_queue where id = (select request_id from dispatched)),
  'Bearer sentinel-cron-secret-7f3a9c', 'the request carries the Vault cron_secret as a bearer token');
select is((select timeout_milliseconds from net.http_request_queue where id = (select request_id from dispatched)), 240000,
  'the request timeout matches the send worker''s 4-minute budget, not pg_net''s 5s default');

-- pg_cron jobs ----------------------------------------------------------------
select is((select count(*)::int from cron.job where jobname = 'send-emails'), 1, 'exactly one send-emails job');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'send-emails'),
  row('* * * * *', $$select private.invoke_cron_endpoint_when_due('/api/cron/send-emails', 0)$$, 'postgres', true)::text,
  'send-emails runs every minute as postgres with only the gated dispatcher call as its command');
select is(
  (select row(schedule, command, username, active)::text from cron.job where jobname = 'cron-job-run-details-cleanup'),
  row('17 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$, 'postgres', true)::text,
  'the run-history cleanup runs daily and keeps a week');
select ok(not exists (select 1 from cron.job where command ilike '%sentinel%' or command ilike '%bearer%' or command ilike '%vault%'),
  'no cron job command contains the secret, a bearer token or a Vault lookup');
select ok(not exists (select 1 from cron.job_run_details where command ilike '%sentinel%' or command ilike '%bearer%'),
  'no recorded cron run contains the secret or a bearer token');
select lives_ok($$delete from cron.job_run_details where end_time < now() - interval '7 days'$$,
  'the cleanup job''s command runs as postgres');

select * from finish();
rollback;
