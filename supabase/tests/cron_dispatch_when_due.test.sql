-- Tests for the pg_cron work gate and the narrowed reply-sync claim
-- (supabase/migrations/20261019100000_cron_dispatch_only_when_due.sql).
-- Run against the LOCAL stack only: `supabase test db`.
--
-- Same approach as sync_replies_cron.test.sql: one transaction, rolled back.
-- Sentinel Vault secrets and the pg_net requests they queue are never
-- committed, so nothing is ever sent.
--
-- now() is fixed for the whole transaction, so "the keepalive minute" is
-- simply extract(minute from now()) and "any other minute" is 30 past it.
--
-- The gate checks for work across ALL users, so every scenario starts from a
-- database where nothing is due (asserted first) and adds only its own rows.

set client_min_messages = warning;

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(36);

create temp table t_min as select
  extract(minute from now())::integer as keepalive,
  ((extract(minute from now())::integer + 30) % 60) as other;
grant select on t_min to anon, authenticated, service_role;

-- Fixtures: one user, one org, one IMAP mailbox, one paused campaign -----------
create temp table fx (name text primary key, id uuid not null);
grant select on fx to anon, authenticated, service_role;

do $$
declare
  v_user uuid := gen_random_uuid();
  v_org uuid;
  v_mailbox uuid;
  v_campaign uuid;
begin
  insert into auth.users (id, email) values (v_user, 'gate@cron-gate-test.invalid');
  insert into public.organizations (name, owner_user_id) values ('Gate test', v_user) returning id into v_org;
  insert into public.organization_members (organization_id, user_id) values (v_org, v_user) on conflict do nothing;
  insert into public.mailboxes (user_id, email, smtp_host, smtp_username, encrypted_smtp_password,
      hourly_limit, daily_limit, cooldown_minutes, status, imap_enabled, reply_sync_claimed_at)
    values (v_user, 'box@cron-gate-test.invalid', 'smtp.cron-gate-test.invalid', 'box', 'x',
      50, 50, 0, 'active', true, now() - interval '1 hour')
    returning id into v_mailbox;
  insert into public.campaigns (user_id, name, status, daily_limit)
    values (v_user, 'Gate test', 'paused', 50) returning id into v_campaign;
  insert into fx values ('user', v_user), ('org', v_org), ('mailbox', v_mailbox), ('campaign', v_campaign);
end $$;

-- Nothing else in this database may be due, or the "no work" cases are meaningless.
select ok(not exists (select 1 from public.claimable_due_sends()), 'precondition: no claimable sends');
select ok(not exists (select 1 from public.leads where verification_status = 'pending'), 'precondition: no pending verifications');
select ok(not exists (select 1 from public.warmup_profiles where status = 'enabled'), 'precondition: no enabled warmup profiles');
select ok(not exists (select 1 from public.mailboxes_due_for_reply_sync()), 'precondition: no mailbox due for reply sync');

do $$ begin perform vault.create_secret('https://sentinel-app.invalid/', 'cron_app_url'); end $$;
do $$ begin perform vault.create_secret('sentinel-cron-secret-9a41c7', 'cron_secret'); end $$;
create temp table queue_before as select coalesce(max(id), 0) as max_id from net.http_request_queue;

-- No work, not the keepalive minute: nothing is dispatched ------------------------
select is(private.invoke_cron_endpoint_when_due('/api/cron/send-emails', (select other from t_min)), null,
  'send-emails with no work outside its keepalive minute dispatches nothing');
select is(private.invoke_cron_endpoint_when_due('/api/cron/sync-replies', (select other from t_min)), null,
  'sync-replies with no work outside its keepalive minute dispatches nothing');
select is(private.invoke_cron_endpoint_when_due('/api/cron/verify-leads', (select other from t_min)), null,
  'verify-leads with no work outside its keepalive minute dispatches nothing');
select is(private.invoke_cron_endpoint_when_due('/api/cron/warmup-cycle', (select other from t_min)), null,
  'warmup-cycle with no work outside its keepalive minute dispatches nothing');
select is((select count(*)::int from net.http_request_queue where id > (select max_id from queue_before)), 0,
  '...and no HTTP request is queued');

-- No work, keepalive minute: dispatched, so the heartbeat still fires ----------------
create temp table keepalive as
  select private.invoke_cron_endpoint_when_due('/api/cron/send-emails', (select keepalive from t_min)) as request_id;
select isnt((select request_id from keepalive), null, 'at its keepalive minute send-emails is dispatched with no work');
select is((select url from net.http_request_queue where id = (select request_id from keepalive)),
  'https://sentinel-app.invalid/api/cron/send-emails', '...through the normal dispatcher, to the send-emails route');
select is((select headers ->> 'Authorization' from net.http_request_queue where id = (select request_id from keepalive)),
  'Bearer sentinel-cron-secret-9a41c7', '...with the Vault bearer token');

-- send-emails: a due lead in an active campaign is work -----------------------------
do $$
declare v_lead uuid;
begin
  insert into public.leads (user_id, email) values ((select id from fx where name = 'user'), 'due@cron-gate-test.invalid')
    returning id into v_lead;
  insert into public.campaign_leads (campaign_id, lead_id, mailbox_id, status, next_send_at)
    values ((select id from fx where name = 'campaign'), v_lead, (select id from fx where name = 'mailbox'), 'active',
      now() - interval '1 minute');
end $$;
select is(private.invoke_cron_endpoint_when_due('/api/cron/send-emails', (select other from t_min)), null,
  'a due lead in a PAUSED campaign is not work (claimable_due_sends would not claim it)');
update public.campaigns set status = 'active' where id = (select id from fx where name = 'campaign');
select isnt(private.invoke_cron_endpoint_when_due('/api/cron/send-emails', (select other from t_min)), null,
  'a due lead in an active campaign dispatches send-emails at any minute');
update public.mailboxes set status = 'paused' where id = (select id from fx where name = 'mailbox');
select is(private.invoke_cron_endpoint_when_due('/api/cron/send-emails', (select other from t_min)), null,
  'the same lead on a paused mailbox is not work');
update public.mailboxes set status = 'active' where id = (select id from fx where name = 'mailbox');

-- sync-replies: which mailboxes are due ----------------------------------------------
select ok(exists (select 1 from public.mailboxes_due_for_reply_sync() where id = (select id from fx where name = 'mailbox')),
  'a mailbox with an active campaign lead is due for reply sync');
update public.campaign_leads set status = 'completed'
  where mailbox_id = (select id from fx where name = 'mailbox');
select ok(not exists (select 1 from public.mailboxes_due_for_reply_sync()),
  'with no active sequence, no recent send and a recent claim, the mailbox is skipped');
select is(private.invoke_cron_endpoint_when_due('/api/cron/sync-replies', (select other from t_min)), null,
  '...and sync-replies is not dispatched');

insert into public.email_events (campaign_id, lead_id, mailbox_id, event_type, created_at)
  select (select id from fx where name = 'campaign'), l.id, (select id from fx where name = 'mailbox'), 'sent', now() - interval '20 days'
  from public.leads l where l.email = 'due@cron-gate-test.invalid';
select ok(not exists (select 1 from public.mailboxes_due_for_reply_sync()),
  'a campaign send 20 days ago does not make the mailbox due');
update public.email_events set created_at = now() - interval '3 days'
  where mailbox_id = (select id from fx where name = 'mailbox') and event_type = 'sent';
select ok(exists (select 1 from public.mailboxes_due_for_reply_sync() where id = (select id from fx where name = 'mailbox')),
  'a campaign send 3 days ago makes the mailbox due');
select isnt(private.invoke_cron_endpoint_when_due('/api/cron/sync-replies', (select other from t_min)), null,
  '...and sync-replies is dispatched');
delete from public.email_events where mailbox_id = (select id from fx where name = 'mailbox');

update public.mailboxes set reply_sync_claimed_at = now() - interval '7 hours' where id = (select id from fx where name = 'mailbox');
select ok(exists (select 1 from public.mailboxes_due_for_reply_sync() where id = (select id from fx where name = 'mailbox')),
  'an idle mailbox not claimed for over 6 hours is due (the periodic sweep)');
update public.mailboxes set reply_sync_claimed_at = null where id = (select id from fx where name = 'mailbox');
select ok(exists (select 1 from public.mailboxes_due_for_reply_sync() where id = (select id from fx where name = 'mailbox')),
  'a mailbox never claimed is due');
update public.mailboxes set imap_enabled = false where id = (select id from fx where name = 'mailbox');
select ok(not exists (select 1 from public.mailboxes_due_for_reply_sync()), 'a mailbox without IMAP is never due');
update public.mailboxes set imap_enabled = true, reply_sync_locked_until = now() + interval '5 minutes'
  where id = (select id from fx where name = 'mailbox');
select ok(not exists (select 1 from public.mailboxes_due_for_reply_sync()), 'a leased mailbox is not due');
update public.mailboxes set reply_sync_locked_until = null where id = (select id from fx where name = 'mailbox');

-- The claim uses the same candidates and stamps reply_sync_claimed_at.
set local role service_role;
create temp table claimed as select id, reply_sync_claimed_at, reply_sync_locked_until from public.claim_mailboxes_for_reply_sync();
reset role;
select is((select array_agg(id) from claimed), array[(select id from fx where name = 'mailbox')],
  'claim_mailboxes_for_reply_sync claims the due mailbox (as service_role)');
select is((select reply_sync_claimed_at from claimed), now(), '...and stamps reply_sync_claimed_at');
select ok((select reply_sync_locked_until > now() from claimed), '...and still leases it');
update public.mailboxes set reply_sync_locked_until = null where id = (select id from fx where name = 'mailbox');
set local role service_role;
select is((select count(*)::int from public.claim_mailboxes_for_reply_sync()), 0,
  'claimed a moment ago with nothing active, the mailbox is not claimed again');
reset role;

-- verify-leads ---------------------------------------------------------------------
update public.leads set verification_status = 'pending' where email = 'due@cron-gate-test.invalid';
select isnt(private.invoke_cron_endpoint_when_due('/api/cron/verify-leads', (select other from t_min)), null,
  'a pending verification dispatches verify-leads');
update public.leads set verification_locked_until = now() + interval '5 minutes' where email = 'due@cron-gate-test.invalid';
select is(private.invoke_cron_endpoint_when_due('/api/cron/verify-leads', (select other from t_min)), null,
  'a pending verification that is already claimed is not work');

-- warmup-cycle ----------------------------------------------------------------------
insert into public.warmup_profiles (organization_id, mailbox_id, status, stage, next_send_at)
  values ((select id from fx where name = 'org'), (select id from fx where name = 'mailbox'), 'enabled', 'warming',
    now() + interval '1 hour');
select is(private.invoke_cron_endpoint_when_due('/api/cron/warmup-cycle', (select other from t_min)), null,
  'a warmup profile whose next send is in the future is not work');
update public.warmup_profiles set next_send_at = now() - interval '1 minute' where mailbox_id = (select id from fx where name = 'mailbox');
select isnt(private.invoke_cron_endpoint_when_due('/api/cron/warmup-cycle', (select other from t_min)), null,
  'a due warmup profile dispatches warmup-cycle');

-- Input checks and privileges -------------------------------------------------------
select throws_ok($$select private.invoke_cron_endpoint_when_due('/api/cron/analytics-rollup', 0)$$, '42501', null,
  'an ungated route is rejected by the gate');
select throws_ok($$select private.invoke_cron_endpoint_when_due('/api/cron/send-emails', 60)$$, '22023', null,
  'a keepalive minute outside 0-59 is rejected');
select ok(not has_function_privilege('anon', 'private.invoke_cron_endpoint_when_due(text, integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.invoke_cron_endpoint_when_due(text, integer)', 'execute')
  and not has_function_privilege('service_role', 'private.invoke_cron_endpoint_when_due(text, integer)', 'execute')
  and not has_function_privilege('anon', 'public.mailboxes_due_for_reply_sync()', 'execute')
  and not has_function_privilege('authenticated', 'public.mailboxes_due_for_reply_sync()', 'execute'),
  'API roles cannot execute the gate, and anon/authenticated cannot list reply-sync candidates');

select * from finish();
rollback;
