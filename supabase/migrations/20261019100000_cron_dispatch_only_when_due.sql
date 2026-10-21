-- Only call the app from pg_cron when a job has work to do.
--
-- Every pg_cron job POSTs to a Vercel function (private.invoke_cron_endpoint),
-- whether or not there is anything to process: about 2,400 calls a day with
-- no traffic at all (send-emails every minute, sync-replies every 2 minutes,
-- verify-leads every 10, warmup-cycle every 15). Each call boots the Node
-- runtime, authenticates, queries Postgres, writes a job_runs row and pings
-- a heartbeat, and sync-replies also logs in to every IMAP mailbox. On the
-- Hobby plan that alone used ~90% of the monthly Fluid Active CPU allowance.
--
-- This changes three things:
--
-- 1. A gate, private.invoke_cron_endpoint_when_due(path, keepalive_minute),
--    replaces the direct dispatcher call in the four frequent jobs. It asks
--    the database whether the job has work, using the same predicate the
--    worker claims with, and only then calls invoke_cron_endpoint. Checking
--    here costs one query inside Postgres instead of one function call on
--    Vercel.
--
-- 2. A keepalive: at one fixed minute per hour each gated job is called even
--    with no work, so its Healthchecks heartbeat still proves the scheduler,
--    Vault secrets and route are alive. The Healthchecks period for these
--    four checks must be raised to 1 hour (plus grace) when this ships, or
--    they will alert. Keepalive minutes are staggered and each one is a
--    minute the job is actually scheduled at:
--      send-emails   every minute    keepalive :00
--      sync-replies  every 10 min    keepalive :20
--      verify-leads  :03, :13, ...   keepalive :33
--      warmup-cycle  :07, :22, ...   keepalive :07
--
-- 3. Reply sync only logs in to mailboxes that can receive a reply or a
--    bounce that matters: a mailbox with a sequence in progress, or one that
--    sent a campaign email in the last 14 days. Every other connected
--    mailbox (warmup-only, or idle) is swept once every 6 hours so late
--    replies still reach the inbox. Nothing is lost by skipping a mailbox:
--    the IMAP UID cursor (mailboxes.imap_last_uid) means the next sync picks
--    up everything that arrived since the last one. Warmup keeps its own
--    IMAP cursor and polling (warmup_profiles.imap_last_uid), so it is not
--    affected. sync-replies also moves from every 2 to every 10 minutes:
--    follow-up steps are days apart, so a reply found within 10 minutes still
--    stops the sequence long before its next step.
--
-- The deliverability check (hourly) and the three daily jobs are unchanged.

-- 1. Reply-sync candidates ------------------------------------------------------

-- When this mailbox was last claimed for reply sync, used for the 6-hour
-- sweep of mailboxes that are otherwise skipped. Null = never claimed, so
-- every existing mailbox is synced once on the first run after deploy.
alter table public.mailboxes
  add column reply_sync_claimed_at timestamptz;

comment on column public.mailboxes.reply_sync_claimed_at is 'When claim_mailboxes_for_reply_sync() last claimed this mailbox. Drives the periodic sweep of mailboxes with no active sequence and no recent campaign sends.';

-- The mailboxes the next reply-sync run should process. Shared by the claim
-- below and the pg_cron gate, so the gate can never skip a run the worker
-- would have had work in.
create or replace function public.mailboxes_due_for_reply_sync()
returns table (id uuid)
language sql
stable
set search_path = ''
as $$
  select m.id
  from public.mailboxes m
  where m.status = 'active'
    and m.imap_enabled = true
    and (m.reply_sync_locked_until is null or m.reply_sync_locked_until < now())
    and (
      exists (
        select 1 from public.campaign_leads cl
        where cl.mailbox_id = m.id and cl.status = 'active'
      )
      or exists (
        select 1 from public.email_events e
        where e.mailbox_id = m.id
          and e.event_type = 'sent'
          and e.created_at >= now() - interval '14 days'
      )
      or m.reply_sync_claimed_at is null
      or m.reply_sync_claimed_at < now() - interval '6 hours'
    )
$$;

comment on function public.mailboxes_due_for_reply_sync() is 'Mailboxes the next reply-sync run should process: active, IMAP enabled, not leased, and either with a sequence in progress, a campaign send in the last 14 days, or not claimed for 6 hours.';

revoke execute on function public.mailboxes_due_for_reply_sync() from public, anon, authenticated;
grant execute on function public.mailboxes_due_for_reply_sync() to service_role;

-- Same claim as 20260814100000 (lease, SKIP LOCKED), now limited to the
-- candidates above and stamping reply_sync_claimed_at. create or replace
-- keeps the function owner and ACL.
create or replace function public.claim_mailboxes_for_reply_sync()
returns setof public.mailboxes
language plpgsql
as $$
begin
  return query
  with candidates as (
    select m.id
    from public.mailboxes m
    where m.id in (select d.id from public.mailboxes_due_for_reply_sync() d)
      and m.status = 'active'
      and m.imap_enabled = true
      and (m.reply_sync_locked_until is null or m.reply_sync_locked_until < now())
    for update skip locked
  )
  update public.mailboxes
  set reply_sync_locked_until = now() + interval '10 minutes',
      reply_sync_claimed_at = now()
  where id in (select id from candidates)
  returning *;
end;
$$;

-- 2. The gate -------------------------------------------------------------------

-- SECURITY INVOKER with an empty search_path, like invoke_cron_endpoint: the
-- only caller is pg_cron, running as postgres. Unknown paths are rejected
-- here before any lookup; invoke_cron_endpoint keeps its own allowlist too.
create or replace function private.invoke_cron_endpoint_when_due(p_path text, p_keepalive_minute integer)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_has_work boolean;
begin
  if p_keepalive_minute is null or p_keepalive_minute not between 0 and 59 then
    raise exception 'invoke_cron_endpoint_when_due: keepalive minute % is out of range', p_keepalive_minute
      using errcode = '22023';
  end if;

  case p_path
    when '/api/cron/send-emails' then
      v_has_work := exists (select 1 from public.claimable_due_sends());
    when '/api/cron/sync-replies' then
      v_has_work := exists (select 1 from public.mailboxes_due_for_reply_sync());
    when '/api/cron/verify-leads' then
      -- Same predicate as claim_due_verifications().
      v_has_work := exists (
        select 1 from public.leads l
        where l.verification_status = 'pending'
          and (l.verification_locked_until is null or l.verification_locked_until < now())
      );
    when '/api/cron/warmup-cycle' then
      -- Same predicate as claim_due_warmup_sends().
      v_has_work := exists (
        select 1
        from public.warmup_profiles wp
        join public.mailboxes m on m.id = wp.mailbox_id
        where wp.status = 'enabled'
          and wp.stage in ('starting', 'warming', 'healthy', 'cooling')
          and m.status = 'active'
          and (wp.locked_until is null or wp.locked_until < now())
          and (
            (wp.next_send_at is null or wp.next_send_at <= now())
            or exists (
              select 1 from public.warmup_messages wm
              where wm.to_mailbox_id = wp.mailbox_id
                and wm.reply_decision = 'pending'
                and wm.reply_due_at <= now()
            )
          )
      );
    else
      raise exception 'invoke_cron_endpoint_when_due: path % is not gated', p_path
        using errcode = '42501';
  end case;

  if not v_has_work and extract(minute from now())::integer <> p_keepalive_minute then
    return null;
  end if;

  return private.invoke_cron_endpoint(p_path);
end;
$$;

comment on function private.invoke_cron_endpoint_when_due(text, integer) is 'pg_cron gate: calls private.invoke_cron_endpoint(p_path) only when the job has work (same predicate as its claim function), or at p_keepalive_minute each hour so heartbeats keep proving the scheduler is alive. Returns the pg_net request id, or null when nothing was dispatched.';

revoke all on function private.invoke_cron_endpoint_when_due(text, integer) from public, anon, authenticated, service_role;

-- 3. Reschedule the four frequent jobs through the gate ----------------------------

-- cron.schedule() upserts by job name, so each call replaces that job.
select cron.schedule(
  'send-emails',
  '* * * * *',
  $$select private.invoke_cron_endpoint_when_due('/api/cron/send-emails', 0)$$
);

select cron.schedule(
  'sync-replies',
  '*/10 * * * *',
  $$select private.invoke_cron_endpoint_when_due('/api/cron/sync-replies', 20)$$
);

select cron.schedule(
  'verify-leads',
  '3-59/10 * * * *',
  $$select private.invoke_cron_endpoint_when_due('/api/cron/verify-leads', 33)$$
);

select cron.schedule(
  'warmup-cycle',
  '7,22,37,52 * * * *',
  $$select private.invoke_cron_endpoint_when_due('/api/cron/warmup-cycle', 7)$$
);
