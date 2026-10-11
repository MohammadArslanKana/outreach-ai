"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import type { Client } from "@/lib/db/shared";
import type { Tables } from "@/types/database.types";
import {
  addCampaignMailbox,
  addLeadsToCampaign,
  addLeadToCampaign,
  cancelActiveCampaignLeads,
  createAttachment,
  createSequenceStep,
  deleteAttachments,
  deleteLead,
  deleteSequenceStep,
  getAttachment,
  getCampaign,
  getCampaignLead,
  getLead,
  getLeadSegment,
  getOrCreateDefaultSequence,
  getSendAttempt,
  getSequence,
  getSequenceStep,
  getSuppressedEmails,
  getUserOrganization,
  linkAttachmentsToStep,
  listCampaignLeads,
  listCampaignLeadsWithTimezones,
  listCampaignMailboxes,
  listDomains,
  listLeads,
  listLeadsMatchingRules,
  listMailboxes,
  listOwnedAttachmentsByIds,
  listSequences,
  listSequenceSteps,
  removeCampaignLead,
  removeCampaignMailbox,
  requestSendNow,
  resolveSendAttemptManually,
  swapSequenceStepOrder,
  updateCampaign,
  updateCampaignLead,
  updateSequenceStep,
} from "@/lib/db";
import { computeNextSchedule, resolveLeadSendingWindow } from "@/lib/email/scheduling";
import { checkCampaignReadiness, resolveLeadMailboxId, resolvePoolMailboxId } from "@/lib/campaigns/readiness";
import {
  ATTACHMENTS_BUCKET,
  MAX_ATTACHMENTS_PER_STEP,
  MAX_TOTAL_ATTACHMENT_BYTES_PER_STEP,
  buildAttachmentStoragePath,
  formatBytes,
  sanitizeAttachmentFileName,
  validateAttachmentBytes,
} from "@/lib/email/attachment-validation";
import { campaignLeadSchema, type CampaignLeadInput } from "@/lib/validations/campaign-leads";
import { leadSegmentRulesSchema } from "@/lib/validations/lead-segments";
import { sequenceStepSchema, type SequenceStepInput } from "@/lib/validations/sequence-steps";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit/check-rate-limit";
import type { ActionResult } from "@/lib/action-result";

// Server Functions are reachable directly via POST regardless of which UI
// calls them. campaign_leads has no user_id column — ownership flows through
// campaign_id — so getCampaign(userId, campaignId) doubles as the ownership
// check: it throws if this campaign isn't the caller's before any mutation
// touches campaign_leads.

// Marks a message this file has already deliberately written for the user
// (a business-rule/validation failure, e.g. "Only a running campaign can be
// paused.") — never wraps a raw DB/PostgREST error, which unwrap() (see
// lib/db/shared.ts) throws as a plain Error/PostgrestError instead. Client
// components in this campaign's UI (enroll-dialog.tsx, campaign-lead-table.tsx,
// campaign-execution-controls.tsx, campaign-review-step.tsx) show the message
// directly via toast — see runUserFacing below for how an unclassified error
// is kept from reaching them.
class UserFacingError extends Error {}

const UNEXPECTED_ERROR_MESSAGE = "Something went wrong. Try again.";

// Wraps the exported actions below that a client component displays an
// error message from. The failure is returned as a value rather than
// rethrown: Next.js redacts a thrown Server Function error's message in
// production builds (see lib/action-result.ts), which hid every one of these
// messages behind a generic error. Only errors this file has explicitly
// classified as safe (UserFacingError, RateLimitError — both purpose-written,
// no DB/infrastructure detail) keep their message; anything else (a raw
// PostgrestError from unwrap(), an unexpected bug) is logged in full here —
// server-side only — and replaced with one generic message.
async function runUserFacing<T>(action: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await action() };
  } catch (error) {
    if (error instanceof UserFacingError || error instanceof RateLimitError) {
      return { ok: false, error: error.message };
    }
    console.error("[campaigns] unexpected error", error);
    return { ok: false, error: UNEXPECTED_ERROR_MESSAGE };
  }
}

// Computes and persists the first scheduled send for a freshly-enrolled
// campaign_lead — reuses computeNextSchedule (lib/email/scheduling.ts) for
// the actual math and updateCampaignLead (lib/db/campaign-leads.ts) for the
// write, so this is orchestration only, not a second scheduling algorithm.
// Only acts when the campaign is already active and has at least one
// sequence step; otherwise the lead stays exactly as inserted ('pending',
// no current_step_id/next_send_at) until something schedules it later. The
// first send lands in the lead's own window (resolveLeadSendingWindow): the
// campaign's hours in the lead's timezone, or the campaign's timezone when
// the lead has none.
async function scheduleOnEnrollment(
  supabase: Client,
  campaign: Tables<"campaigns">,
  campaignLead: Tables<"campaign_leads">,
  steps: Tables<"sequence_steps">[],
  leadTimezone: string | null,
) {
  if (campaign.status !== "active" || steps.length === 0) return;

  const schedule = computeNextSchedule({
    steps,
    currentStepId: null,
    from: new Date(campaignLead.enrolled_at),
    sendingWindow: resolveLeadSendingWindow(campaign.sending_window, leadTimezone),
  });

  await updateCampaignLead(supabase, campaignLead.id, {
    current_step_id: schedule.nextStepId,
    next_send_at: schedule.nextSendAt ? schedule.nextSendAt.toISOString() : null,
    status: schedule.completed ? "completed" : "active",
  });
}

// Loads the campaign's one implicit sequence and its steps, for scheduling
// newly-enrolled leads. Returns an empty array if no sequence/steps exist
// yet — scheduleOnEnrollment treats that as "nothing to schedule."
async function loadSequenceSteps(supabase: Client, campaignId: string) {
  const sequences = await listSequences(supabase, campaignId);
  const sequence = sequences[0];
  return sequence ? listSequenceSteps(supabase, sequence.id) : Promise.resolve([]);
}

// Defense in depth alongside RLS (campaign_leads_update_own/_delete_own's
// policy and check_campaign_lead_owner() both already re-derive ownership
// from the row's real campaign_id — see
// 20260728100070_campaign_leads.sql) — this is the app-level mirror of that
// check, closing the gap where getCampaign(userId, campaignId) verifies the
// caller owns *a* campaign but never that the mutated campaignLeadId
// belongs to *that* campaign. campaign_leads has campaign_id directly, so
// this is a plain equality check on a row already fetched, not another
// query.
function assertCampaignLeadInCampaign(campaignLead: Tables<"campaign_leads">, campaignId: string) {
  if (campaignLead.campaign_id !== campaignId) {
    throw new UserFacingError("This lead does not belong to this campaign.");
  }
}

// Same defense-in-depth reasoning as assertCampaignLeadInCampaign, one hop
// further: sequence_steps has no campaign_id column of its own, only
// sequence_id, so closing this requires one extra lookup (the sequence's
// own campaign_id) rather than a plain equality check on an already-fetched
// row.
async function assertSequenceInCampaign(supabase: Client, sequenceId: string, campaignId: string) {
  const sequence = await getSequence(supabase, sequenceId);
  if (sequence.campaign_id !== campaignId) {
    throw new UserFacingError("This step does not belong to this campaign.");
  }
}

// Validated draft -> active transition. Unlike the raw status field on
// CampaignForm/updateCampaignAction, this is the only path that (a) checks
// the campaign is actually ready to send and (b) schedules every lead
// enrolled while the campaign was still draft — scheduleOnEnrollment above
// only ever acts on leads enrolled after the campaign is already active, so
// without this, leads enrolled during setup would stay unscheduled forever.
export async function launchCampaignAction(campaignId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    if (campaign.status !== "draft") {
      throw new UserFacingError("This campaign has already been launched.");
    }

    const organization = await getUserOrganization(supabase, user);
    await checkRateLimit("campaign:launch", organization.id);

    const steps = await loadSequenceSteps(supabase, campaignId);
    const leads = await listCampaignLeadsWithTimezones(supabase, campaignId);
    const mailboxes = await listMailboxes(supabase, user.id);
    const domains = await listDomains(supabase, user.id);
    const campaignMailboxes = await listCampaignMailboxes(supabase, campaignId);

    // Same check the campaign detail/wizard UI runs to show readiness ahead
    // of the click (see lib/campaigns/readiness.ts) — re-run here because
    // Server Functions are reachable directly via POST regardless of what the
    // UI already validated. Only `errors` block the launch; `warnings` (no
    // sending domain, mailbox limits) are advisory and don't stop it — see
    // that module for why.
    const readiness = checkCampaignReadiness({
      campaign,
      campaignLeads: leads,
      sequenceStepCount: steps.length,
      mailboxes,
      domainCount: (domains ?? []).length,
      campaignMailboxes,
    });
    if (!readiness.ready) {
      throw new UserFacingError(readiness.errors.join(" "));
    }

    const activatedCampaign = { ...campaign, status: "active" as const };
    await updateCampaign(supabase, user.id, campaignId, { status: "active" });

    // Batch 8: this pass's own rotation cursor — starts at 0 for leads
    // needing backfill in this launch, independent of enrollLeadAction/
    // enrollLeadListAction's own "existing enrolled count" cursors (this is
    // a distinct, later event: a one-time cleanup sweep at launch, not a
    // fresh enrollment). Only increments for leads that actually get
    // backfilled below.
    let poolBackfillIndex = 0;

    for (const lead of leads) {
      if (lead.status !== "pending") continue;

      // Leads enrolled while the campaign was still draft (the wizard's Leads
      // step runs before its Mailbox step) can have mailbox_id null even
      // though campaign.default_mailbox_id now resolves them — enrollLeadAction/
      // enrollLeadListAction only ever resolve the default at the moment of
      // enrollment, they never retroactively backfill it. claim_due_sends()
      // requires mailbox_id is not null, so without this a "resolvable" lead
      // would silently never be picked up by the send worker.
      let scheduledLead: Tables<"campaign_leads"> = lead;
      if (!lead.mailbox_id) {
        const resolvedMailboxId = resolvePoolMailboxId(campaignMailboxes, poolBackfillIndex) ?? resolveLeadMailboxId(lead, campaign);
        poolBackfillIndex += 1;
        scheduledLead = await updateCampaignLead(supabase, lead.id, {
          mailbox_id: resolvedMailboxId,
        });
      }

      await scheduleOnEnrollment(supabase, activatedCampaign, scheduledLead, steps, lead.leadTimezone);
    }

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${campaignId}`);
  });
}

// --- Execution controls (Phase 2E) -----------------------------------------
// Pause/resume/stop, alongside the launch action above. All three are thin:
// claim_due_sends() already only ever selects campaigns.status = 'active'
// (see 20260730100020_claim_due_sends.sql), so pausing/stopping needs no
// change to campaign_leads to take effect immediately — new claims simply
// stop. Resuming needs no change either: already-scheduled leads
// (status = 'active', next_send_at set) start being claimed again as soon
// as the campaign is active.

export async function pauseCampaignAction(campaignId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    if (campaign.status !== "active") {
      throw new UserFacingError("Only a running campaign can be paused.");
    }

    // Also drops any pending Send Now for this campaign, in the same
    // transaction (campaigns_clear_send_now_on_inactive trigger).
    await updateCampaign(supabase, user.id, campaignId, { status: "paused" });

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${campaignId}`);
  });
}

export async function resumeCampaignAction(campaignId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    if (campaign.status !== "paused") {
      throw new UserFacingError("Only a paused campaign can be resumed.");
    }

    await updateCampaign(supabase, user.id, campaignId, { status: "active" });

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${campaignId}`);
  });
}

// Stopping is terminal (unlike pausing): every lead still waiting in the
// pipeline is cancelled rather than left scheduled, so nothing resumes
// sending if the campaign's status is ever changed back to 'active' through
// the raw status editor on CampaignForm. Reuses the 'cancelled' status
// added in Phase 2D specifically for "deliberately stopped, not completed
// or failed" — see 20260804100000_sending_limits.sql.
export async function stopCampaignAction(campaignId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    if (campaign.status !== "active" && campaign.status !== "paused") {
      throw new UserFacingError("Only a running or paused campaign can be stopped.");
    }

    await cancelActiveCampaignLeads(supabase, campaignId);
    await updateCampaign(supabase, user.id, campaignId, { status: "completed" });

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${campaignId}`);
  });
}

// Re-enrolling a suppressed (bounced/unsubscribed) address won't actually
// send anything — claim_due_sends() and send-worker.ts's own suppression
// re-check both already block it — but silently allowing the enrollment
// anyway is confusing UX for something that looks like a deliberate
// re-engagement attempt. Require an explicit confirmSuppressed=true from the
// UI (see EnrollDialog's warning + checkbox) rather than gating only in the
// client, since Server Functions must re-check independently of the caller.
export async function enrollLeadAction(
  campaignId: string,
  leadId: string,
  mailboxId?: string,
  confirmSuppressed = false,
) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    const organization = await getUserOrganization(supabase, user);
    await checkRateLimit("campaign:enroll", organization.id);

    const lead = await getLead(supabase, user.id, leadId);
    if (!confirmSuppressed) {
      const suppressed = await getSuppressedEmails(supabase, user.id, [lead.email]);
      const reason = suppressed.get(lead.email);
      if (reason) {
        throw new UserFacingError(`This lead is suppressed (${reason}). Confirm to enroll anyway.`);
      }
    }

    // Batch 8: explicit override wins outright; otherwise round-robin across
    // the configured pool (using this campaign's current enrolled-lead count
    // as the rotation index — see resolvePoolMailboxId), falling back to
    // campaign.default_mailbox_id when there's no pool. The pool is only
    // fetched/counted when there's no explicit override, so an existing
    // campaign with no pool configured pays no extra query cost.
    let effectiveMailboxId = mailboxId ? mailboxId : null;
    if (!effectiveMailboxId) {
      const pool = await listCampaignMailboxes(supabase, campaignId);
      if (pool.length > 0) {
        const enrollmentIndex = (await listCampaignLeads(supabase, campaignId)).length;
        effectiveMailboxId = resolvePoolMailboxId(pool, enrollmentIndex);
      }
      effectiveMailboxId ??= campaign.default_mailbox_id;
    }

    const campaignLead = await addLeadToCampaign(supabase, {
      campaign_id: campaignId,
      lead_id: leadId,
      mailbox_id: effectiveMailboxId,
    });

    const steps = await loadSequenceSteps(supabase, campaignId);
    await scheduleOnEnrollment(supabase, campaign, campaignLead, steps, lead.timezone);

    revalidatePath(`/campaigns/${campaignId}`);
  });
}

// Same cap for every bulk enrollment source (a list or a segment's matches).
const BULK_ENROLLMENT_LIMIT = 10000;

// The shared tail of list and segment enrollment, once the caller has
// checked campaign ownership, the rate limit, and resolved which leads to
// enroll: suppression confirmation, then addLeadsToCampaign (which skips
// leads already enrolled) and first-send scheduling.
async function enrollLeadRows(
  supabase: Client,
  userId: string,
  campaign: Tables<"campaigns">,
  leadRows: Tables<"leads">[],
  source: "list" | "segment",
  mailboxId: string | undefined,
  confirmSuppressed: boolean,
) {
  // Batch 8: explicit override wins outright for every lead in this batch;
  // otherwise round-robin across the configured pool, falling back to
  // campaign.default_mailbox_id per lead when there's no pool — see
  // addLeadsToCampaign's resolver contract and resolvePoolMailboxId.
  const pool = mailboxId ? [] : await listCampaignMailboxes(supabase, campaign.id);
  const resolveMailboxId = (enrollmentIndex: number): string | null =>
    mailboxId ? mailboxId : (resolvePoolMailboxId(pool, enrollmentIndex) ?? campaign.default_mailbox_id);

  if (!confirmSuppressed) {
    const suppressed = await getSuppressedEmails(
      supabase,
      userId,
      leadRows.map((lead) => lead.email),
    );
    const suppressedCount = leadRows.filter((lead) => suppressed.has(lead.email)).length;
    if (suppressedCount > 0) {
      throw new UserFacingError(
        `${suppressedCount} lead${suppressedCount === 1 ? "" : "s"} in this ${source} ${suppressedCount === 1 ? "is" : "are"} suppressed (bounced/unsubscribed). Confirm to enroll anyway.`,
      );
    }
  }

  const leadIds = leadRows.map((lead) => lead.id);
  const result = await addLeadsToCampaign(supabase, campaign.id, leadIds, resolveMailboxId);

  const steps = await loadSequenceSteps(supabase, campaign.id);
  const timezoneByLeadId = new Map(leadRows.map((lead) => [lead.id, lead.timezone]));
  for (const campaignLead of result.rows) {
    await scheduleOnEnrollment(supabase, campaign, campaignLead, steps, timezoneByLeadId.get(campaignLead.lead_id) ?? null);
  }

  revalidatePath(`/campaigns/${campaign.id}`);
  return { inserted: result.inserted, skipped: result.skipped };
}

export async function enrollLeadListAction(
  campaignId: string,
  listId: string,
  mailboxId?: string,
  confirmSuppressed = false,
) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    const organization = await getUserOrganization(supabase, user);
    await checkRateLimit("campaign:enroll", organization.id);

    const leads = await listLeads(supabase, user.id, { listId, limit: BULK_ENROLLMENT_LIMIT });
    return enrollLeadRows(supabase, user.id, campaign, leads ?? [], "list", mailboxId, confirmSuppressed);
  });
}

// A snapshot: enrolls the leads matching the segment's rules right now.
// Nothing links the campaign to the segment afterwards, so leads that match
// later are never auto-enrolled. The segment is loaded scoped to the caller
// (plus RLS), and its stored rules are re-validated before they're used.
export async function enrollLeadSegmentAction(
  campaignId: string,
  segmentId: string,
  mailboxId?: string,
  confirmSuppressed = false,
) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    const organization = await getUserOrganization(supabase, user);
    await checkRateLimit("campaign:enroll", organization.id);

    const segment = await getLeadSegment(supabase, user.id, segmentId);
    const rules = leadSegmentRulesSchema.safeParse(segment.rules);
    if (!rules.success) {
      throw new UserFacingError("This segment's rules are no longer valid. Edit the segment and try again.");
    }

    const leads = await listLeadsMatchingRules(supabase, user.id, rules.data, { limit: BULK_ENROLLMENT_LIMIT });
    return enrollLeadRows(supabase, user.id, campaign, leads ?? [], "segment", mailboxId, confirmSuppressed);
  });
}

// Batch 8: mailbox pool membership toggles for the wizard's multi-select
// (components/campaigns/mailbox-assignment-step.tsx). getCampaign(userId,
// campaignId) is the ownership check, same reasoning as every other
// mutation in this file — the DB-level ownership trigger on
// campaign_mailboxes (20260918120000_campaign_mailboxes.sql) is
// defense-in-depth, not a substitute for it. No readiness/scheduling
// side effects here: the pool only affects assignment at enrollment time
// (enrollLeadAction/enrollLeadListAction) and at launch-time backfill
// (launchCampaignAction) — adding/removing a pool mailbox never rewrites
// any already-enrolled lead's mailbox_id (see the migration's own
// on-delete-cascade comment for why removal is safe by construction).
export async function addCampaignMailboxAction(campaignId: string, mailboxId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    await getCampaign(supabase, user.id, campaignId);
    await addCampaignMailbox(supabase, campaignId, mailboxId);

    revalidatePath(`/campaigns/${campaignId}`);
  });
}

export async function removeCampaignMailboxAction(campaignId: string, mailboxId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    await getCampaign(supabase, user.id, campaignId);
    await removeCampaignMailbox(supabase, campaignId, mailboxId);

    revalidatePath(`/campaigns/${campaignId}`);
  });
}

export async function updateCampaignLeadAction(
  campaignId: string,
  campaignLeadId: string,
  input: CampaignLeadInput,
) {
  const parsed = campaignLeadSchema.parse(input);
  const user = await requireUser();
  const supabase = await createClient();

  await getCampaign(supabase, user.id, campaignId);
  const campaignLead = await getCampaignLead(supabase, campaignLeadId);
  assertCampaignLeadInCampaign(campaignLead, campaignId);

  await updateCampaignLead(supabase, campaignLeadId, {
    mailbox_id: parsed.mailboxId ? parsed.mailboxId : null,
    status: parsed.status,
  });

  revalidatePath(`/campaigns/${campaignId}`);
}

export async function removeCampaignLeadAction(campaignId: string, campaignLeadId: string) {
  const user = await requireUser();
  const supabase = await createClient();

  await getCampaign(supabase, user.id, campaignId);
  const campaignLead = await getCampaignLead(supabase, campaignLeadId);
  assertCampaignLeadInCampaign(campaignLead, campaignId);

  await removeCampaignLead(supabase, campaignLeadId);

  revalidatePath(`/campaigns/${campaignId}`);
}

// Permanently deletes the lead itself, not just this enrollment — every
// campaign_leads/email_events/send_attempts row referencing it is removed
// via "on delete cascade" (see the leads/campaign_leads/email_events/
// send_attempts migrations), so this can't leave orphaned rows behind.
// Deliberately global: a lead deleted from inside one campaign's view is
// gone from every campaign, matching what "permanently delete" implies.
// The lead's suppressions row (keyed by email, not lead_id) is untouched —
// suppression must survive the lead record so the address stays blocked if
// it's ever re-imported.
export async function deleteLeadPermanentlyAction(campaignId: string, leadId: string) {
  const user = await requireUser();
  const supabase = await createClient();

  await getCampaign(supabase, user.id, campaignId);

  await deleteLead(supabase, user.id, leadId);

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/leads");
  revalidatePath("/dashboard");
}

// Same ownership pattern as the campaign_leads actions above: sequence_steps
// has no campaign_id column, so getCampaign(userId, campaignId) is the
// explicit ownership check, backed by RLS on sequences/sequence_steps.

export async function createSequenceStepAction(campaignId: string, input: SequenceStepInput) {
  const parsed = sequenceStepSchema.parse(input);
  const user = await requireUser();
  const supabase = await createClient();

  await getCampaign(supabase, user.id, campaignId);
  const sequence = await getOrCreateDefaultSequence(supabase, campaignId);
  const steps = await listSequenceSteps(supabase, sequence.id);
  const nextOrder = steps.length > 0 ? Math.max(...steps.map((step) => step.step_order)) + 1 : 0;

  // Returns the new step's id (Batch 3) so the composer can link any
  // just-uploaded attachments to it right after — a brand-new step has no
  // id until this insert completes, and attachments are uploaded before
  // Save is even clicked (see linkAttachmentsToStepAction).
  const step = await createSequenceStep(supabase, {
    sequence_id: sequence.id,
    day_delay: parsed.dayDelay,
    subject: parsed.subject || null,
    body: parsed.body || null,
    step_order: nextOrder,
  });

  revalidatePath(`/campaigns/${campaignId}`);

  return { id: step.id };
}

export async function updateSequenceStepAction(campaignId: string, stepId: string, input: SequenceStepInput) {
  const parsed = sequenceStepSchema.parse(input);
  const user = await requireUser();
  const supabase = await createClient();

  await getCampaign(supabase, user.id, campaignId);
  const step = await getSequenceStep(supabase, stepId);
  await assertSequenceInCampaign(supabase, step.sequence_id, campaignId);

  await updateSequenceStep(supabase, stepId, {
    day_delay: parsed.dayDelay,
    subject: parsed.subject || null,
    body: parsed.body || null,
  });

  revalidatePath(`/campaigns/${campaignId}`);
}

export async function deleteSequenceStepAction(campaignId: string, stepId: string) {
  const user = await requireUser();
  const supabase = await createClient();

  await getCampaign(supabase, user.id, campaignId);
  const step = await getSequenceStep(supabase, stepId);
  await assertSequenceInCampaign(supabase, step.sequence_id, campaignId);

  await deleteSequenceStep(supabase, stepId);

  revalidatePath(`/campaigns/${campaignId}`);
}

export async function moveSequenceStepAction(
  campaignId: string,
  sequenceId: string,
  stepId: string,
  direction: "up" | "down",
) {
  const user = await requireUser();
  const supabase = await createClient();

  await getCampaign(supabase, user.id, campaignId);
  await assertSequenceInCampaign(supabase, sequenceId, campaignId);

  const steps = await listSequenceSteps(supabase, sequenceId);
  const index = steps.findIndex((step) => step.id === stepId);
  if (index === -1) return;

  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= steps.length) return;

  await swapSequenceStepOrder(supabase, sequenceId, steps[index].id, steps[targetIndex].id);

  revalidatePath(`/campaigns/${campaignId}`);
}

// Manual crash recovery for a lead the send worker couldn't resolve on its
// own (needs_review) or gave up on (failed) — the function
// send_attempts.sql's RLS policy comment named but never implemented. Runs
// on the user-scoped client throughout (RLS is the real ownership boundary
// on both campaign_leads and send_attempts, same as every other action in
// this file), never the admin client.
export async function resolveSendAttemptAction(
  campaignId: string,
  campaignLeadId: string,
  action: "retry" | "dismiss",
) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    await getCampaign(supabase, user.id, campaignId);
    const organization = await getUserOrganization(supabase, user);
    await checkRateLimit("campaign:resolve_send_attempt", organization.id);

    const campaignLead = await getCampaignLead(supabase, campaignLeadId);
    assertCampaignLeadInCampaign(campaignLead, campaignId);
    if (campaignLead.status !== "needs_review" && campaignLead.status !== "failed") {
      throw new UserFacingError("This lead isn't awaiting review.");
    }
    if (!campaignLead.current_step_id) {
      throw new UserFacingError("This lead has no send attempt to resolve.");
    }

    const sendAttempt = await getSendAttempt(supabase, campaignLeadId, campaignLead.current_step_id);
    if (sendAttempt) {
      await resolveSendAttemptManually(
        supabase,
        sendAttempt.id,
        action === "retry" ? "Manually reset for retry." : "Manually dismissed.",
      );
    }

    if (action === "retry") {
      // Hand back to the existing pipeline rather than resending here directly
      // — claim_due_sends() re-checks mailbox status and suppression at claim
      // time, so this doesn't need to duplicate those checks.
      await updateCampaignLead(supabase, campaignLeadId, {
        status: "active",
        next_send_at: new Date().toISOString(),
        locked_until: null,
      });
    } else {
      await updateCampaignLead(supabase, campaignLeadId, { status: "failed" });
    }

    revalidatePath(`/campaigns/${campaignId}`);
  });
}

// --- Send Now (Batch 4) -----------------------------------------------------
// "Send now" for one enrolled lead's next pending step. Deliberately does
// NOT talk to the provider, claim a send_attempt, or otherwise short-circuit
// the real send path: it only pulls this one campaign_lead's next_send_at
// forward to "now," making it eligible for the very next claim_due_sends()
// tick — the exact same queue every scheduled send already goes through —
// and records an explicit Send Now (campaign_leads.send_now_step_id) for the
// lead's current step, the worker's only reason to send outside the sending
// window (see enforceSendingWindow in lib/email/send-worker.ts).
// Every existing safety check downstream is therefore untouched and still
// applies: mailbox daily/hourly/cooldown limits and campaign.status =
// 'active' (claim_due_sends(), see supabase/migrations/20260804100000_sending_limits.sql),
// suppression (processCampaignLead's getSuppression re-check, see
// lib/email/send-worker.ts), and send_attempts idempotency
// (claimSendAttempt). The only thing this bypasses is *waiting for the
// sending window* — which is the entire point of "now" instead of "at the
// next scheduled window," not a safety check — and only once, for this step.
//
// The write goes through request_send_now(), which re-checks ownership and
// eligibility (campaign active, lead active with a step and mailbox, not
// leased by the worker) atomically, so it can't race a worker claim; the
// checks below stay for specific error messages. Only ever writes
// next_send_at and send_now_step_id. Never touches mailbox_id (mailbox-per-
// lead stickiness), status, or current_step_id (follow-up sequencing) — so
// this can't create a duplicate queue entry, move a lead to a different
// mailbox, or skip a step.
export async function sendNowAction(campaignId: string, campaignLeadId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const campaign = await getCampaign(supabase, user.id, campaignId);
    const organization = await getUserOrganization(supabase, user);
    await checkRateLimit("campaign:send_now", organization.id);

    // Paused campaign protection: claim_due_sends() already only ever claims
    // for campaigns.status = 'active', so this alone would make a paused
    // campaign's "Send now" a silent no-op rather than an honest error —
    // reject it up front instead, matching "must not bypass paused campaign
    // protection."
    if (campaign.status !== "active") {
      throw new UserFacingError("Only an active campaign can send now.");
    }

    const campaignLead = await getCampaignLead(supabase, campaignLeadId);
    assertCampaignLeadInCampaign(campaignLead, campaignId);

    if (campaignLead.status !== "active") {
      throw new UserFacingError("This lead isn't currently active in the sequence.");
    }
    if (!campaignLead.current_step_id) {
      throw new UserFacingError("This lead has no pending step to send.");
    }
    if (!campaignLead.mailbox_id) {
      throw new UserFacingError("This lead has no assigned mailbox to send from.");
    }
    // Currently claimed by an in-flight send (claim_due_sends() sets
    // locked_until ~10 minutes out — see that function). Forcing next_send_at
    // now would race the worker that already has this row; reject instead of
    // risking two lanes touching the same lead.
    if (campaignLead.locked_until && new Date(campaignLead.locked_until) > new Date()) {
      throw new UserFacingError("This lead is already being sent — try again in a moment.");
    }

    if (!(await requestSendNow(supabase, campaignLeadId))) {
      throw new UserFacingError("This lead is already being sent or is no longer eligible — refresh and try again.");
    }

    revalidatePath(`/campaigns/${campaignId}`);
  });
}

// --- Attachments (Batch 3) --------------------------------------------------
// PDF/image files a sequence step sends alongside its HTML/plain-text body
// (lib/email/render-email.ts). Metadata lives in email_attachments
// (supabase/migrations/20260917100000_email_attachments.sql); file bytes
// live in the private "attachments" Storage bucket the same migration
// creates. Every action here runs on the session-scoped client — RLS is the
// real ownership boundary on both email_attachments and storage.objects,
// same as every other table in this file — with the same explicit
// app-level checks (ownership, limits) this file already layers on top of
// RLS everywhere else, since a Server Function is reachable directly by
// anyone who can POST to it regardless of what the composer UI already
// validated client-side.

// Uploaded before the owning sequence_step_id is known: a brand-new "Add
// step" dialog has no step id until Save. The returned row is linked to a
// step later, by linkAttachmentsToStepAction, once that step actually
// exists. Never trusts the browser's File.type or declared size — the real
// bytes are sniffed here regardless of what the upload claims (see
// lib/email/attachment-validation.ts's validateAttachmentBytes).
export async function uploadAttachmentAction(formData: FormData) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new UserFacingError("No file was provided.");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const validation = validateAttachmentBytes(bytes);
    if (!validation.ok) {
      throw new UserFacingError(validation.reason);
    }

    const safeName = sanitizeAttachmentFileName(file.name || "attachment");
    const storagePath = buildAttachmentStoragePath(user.id, safeName);

    const { error: uploadError } = await supabase.storage
      .from(ATTACHMENTS_BUCKET)
      .upload(storagePath, bytes, { contentType: validation.mimeType, upsert: false });
    if (uploadError) {
      console.error("[attachments] upload failed", uploadError);
      throw new UserFacingError("Couldn't upload this file. Try again.");
    }

    try {
      const attachment = await createAttachment(supabase, {
        user_id: user.id,
        sequence_step_id: null,
        file_name: safeName,
        mime_type: validation.mimeType,
        size_bytes: bytes.byteLength,
        storage_path: storagePath,
      });
      // Shaped to exactly what the composer renders — never the raw row —
      // per the Server Functions guide's "constrain return values."
      return {
        id: attachment.id,
        fileName: attachment.file_name,
        mimeType: attachment.mime_type,
        sizeBytes: attachment.size_bytes,
      };
    } catch (dbError) {
      // The DB row is the source of truth for "this attachment exists" — if
      // the insert fails, the object just uploaded would otherwise be an
      // orphaned file nothing ever references again. Best-effort: a cleanup
      // failure is only logged, so the real error (the DB failure) is what
      // reaches the caller.
      await supabase.storage
        .from(ATTACHMENTS_BUCKET)
        .remove([storagePath])
        .catch((cleanupError) => console.error("[attachments] rollback cleanup failed", cleanupError));
      throw dbError;
    }
  });
}

// Links a set of already-uploaded attachments (each still owned by the
// caller, verified below) to a saved sequence step. Called right after
// createSequenceStepAction/updateSequenceStepAction succeeds — see
// SequenceStepForm. Re-validates ownership and the count/size limits
// server-side rather than trusting whatever the client already checked:
// this Server Function is reachable directly via POST with any attachment
// ids at all, not just ones the composer UI actually uploaded for this step.
export async function linkAttachmentsToStepAction(campaignId: string, stepId: string, attachmentIds: string[]) {
  return runUserFacing(async () => {
    if (attachmentIds.length === 0) return;

    const user = await requireUser();
    const supabase = await createClient();

    await getCampaign(supabase, user.id, campaignId);
    const step = await getSequenceStep(supabase, stepId);
    await assertSequenceInCampaign(supabase, step.sequence_id, campaignId);

    const owned = await listOwnedAttachmentsByIds(supabase, user.id, attachmentIds);
    if (owned.length !== attachmentIds.length) {
      throw new UserFacingError("One or more attachments could not be found.");
    }
    if (owned.length > MAX_ATTACHMENTS_PER_STEP) {
      throw new UserFacingError(`A step can have at most ${MAX_ATTACHMENTS_PER_STEP} attachments.`);
    }
    const totalBytes = owned.reduce((sum, attachment) => sum + attachment.size_bytes, 0);
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES_PER_STEP) {
      throw new UserFacingError(
        `These attachments total ${formatBytes(totalBytes)}, over the ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES_PER_STEP)} limit per step.`,
      );
    }

    await linkAttachmentsToStep(supabase, user.id, attachmentIds, stepId);

    revalidatePath(`/campaigns/${campaignId}`);
  });
}

// Hard delete — both the storage object and the metadata row. Used for both
// an unlinked (never-saved) attachment and an already-linked one being
// removed from a saved step; ownership scoping is identical either way
// (RLS plus the explicit .eq("user_id", ...) getAttachment/deleteAttachments
// already carry — see lib/db/attachments.ts).
export async function removeAttachmentAction(attachmentId: string) {
  return runUserFacing(async () => {
    const user = await requireUser();
    const supabase = await createClient();

    const attachment = await getAttachment(supabase, user.id, attachmentId);

    const { error: storageError } = await supabase.storage
      .from(ATTACHMENTS_BUCKET)
      .remove([attachment.storage_path]);
    if (storageError) {
      // Logged, not thrown: the DB row is what the UI/send worker actually
      // treat as "this attachment exists" — a now-unreferenced object left
      // behind in a private bucket is a harmless leftover, and strictly
      // better than leaving the DB row (and the UI showing it as attached)
      // when the user explicitly asked to remove it.
      console.error("[attachments] storage removal failed", storageError);
    }

    await deleteAttachments(supabase, user.id, [attachmentId]);

    if (attachment.sequence_step_id) {
      const step = await getSequenceStep(supabase, attachment.sequence_step_id).catch(() => null);
      if (step) {
        const sequence = await getSequence(supabase, step.sequence_id).catch(() => null);
        if (sequence) revalidatePath(`/campaigns/${sequence.campaign_id}`);
      }
    }
  });
}

// Cleanup for the "uploaded a file, then closed the dialog without saving"
// case — see SequenceStepForm's unmount effect. Only ever removes rows that
// are (a) owned by the caller and (b) still unlinked
// (sequence_step_id is null): an id that got linked by a real save that
// raced with this call is left alone, never deleted out from under a saved
// step. Best-effort by design — a client that never calls this (e.g. the
// tab was closed rather than the dialog) simply leaves an unlinked
// attachment behind; see this batch's known limitations.
export async function discardUnlinkedAttachmentsAction(attachmentIds: string[]) {
  if (attachmentIds.length === 0) return;

  const user = await requireUser();
  const supabase = await createClient();

  const owned = await listOwnedAttachmentsByIds(supabase, user.id, attachmentIds);
  const unlinkedIds = owned.filter((attachment) => attachment.sequence_step_id === null).map((a) => a.id);
  if (unlinkedIds.length === 0) return;

  const paths = owned.filter((attachment) => unlinkedIds.includes(attachment.id)).map((a) => a.storage_path);
  await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .remove(paths)
    .catch((error) => console.error("[attachments] discard cleanup failed", error));

  await deleteAttachments(supabase, user.id, unlinkedIds);
}
