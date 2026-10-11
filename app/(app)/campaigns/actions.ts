"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import type { Client } from "@/lib/db/shared";
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaignLeadsWithTimezones,
  updateCampaign,
  updateCampaignLead,
} from "@/lib/db";
import { campaignSchema, type CampaignInput } from "@/lib/validations/campaigns";
import { resolveLeadSendingWindow, resolveSendingWindow, recomputeNextSendAt } from "@/lib/email/scheduling";
import type { SendingWindow } from "@/lib/validations/sending-window";
import { assertWithinCampaignLimit, assertWithinDailySendLimit, PlanLimitError } from "@/lib/billing/limits";
import type { ActionResult } from "@/lib/action-result";

// Server Functions are reachable directly via POST regardless of which UI
// calls them, so re-validate here even though the client form (react-hook-
// form + the same zod schema) already validated this input.

// A plan limit is an expected outcome the user can act on (lower the limit or
// upgrade), so it's returned rather than thrown — see lib/action-result.ts.
export async function createCampaignAction(input: CampaignInput): Promise<ActionResult<{ id: string }>> {
  const parsed = campaignSchema.parse(input);
  const user = await requireUser();
  const supabase = await createClient();

  try {
    await assertWithinCampaignLimit(supabase, user.id, user.email);
    await assertWithinDailySendLimit(supabase, user.id, user.email, parsed.dailyLimit);
  } catch (error) {
    if (error instanceof PlanLimitError) return { ok: false, error: error.message };
    throw error;
  }

  const campaign = await createCampaign(supabase, {
    user_id: user.id,
    name: parsed.name,
    daily_limit: parsed.dailyLimit,
    default_mailbox_id: parsed.defaultMailboxId ? parsed.defaultMailboxId : null,
    sending_window: parsed.sendingWindow,
    ...(parsed.status ? { status: parsed.status } : {}),
  });

  revalidatePath("/campaigns");
  return { ok: true, data: { id: campaign.id } };
}

// Re-snaps every still-queued campaign_lead's next_send_at into the newly
// saved sending window — see lib/email/scheduling.ts's recomputeNextSendAt
// for the actual (DST-safe, reused, not reimplemented) math. Scoped to
// exactly the rows a schedule edit can legitimately affect:
//   - status = 'active': the only status still waiting on a future send.
//     'completed'/'failed'/'bounced'/'unsubscribed'/'replied'/'needs_review'/
//     'cancelled' rows are terminal or already flagged for manual handling —
//     touching them here would be the "modify already-sent/terminal records"
//     this batch explicitly must not do.
//   - next_send_at is not null: a lead with no next_send_at has nothing
//     queued to re-snap.
// Each lead is re-snapped into its own window — the new days and hours in the
// lead's timezone when it has a valid one (resolveLeadSendingWindow).
// Never touches mailbox_id, current_step_id, or status — only next_send_at —
// so mailbox-per-lead stickiness, follow-up sequencing, and every other
// per-lead field are untouched, and no new row is ever inserted (no
// duplicate queue entries possible). Runs regardless of the campaign's own
// status (draft/active/paused): a paused campaign's queued leads still get
// their next_send_at kept valid for whenever it resumes, but pausing itself
// is untouched and claim_due_sends() still only ever claims for
// campaigns.status = 'active', so this never causes an unwanted send.
async function rescheduleQueuedCampaignLeads(supabase: Client, campaignId: string, newWindow: SendingWindow) {
  const activeLeads = await listCampaignLeadsWithTimezones(supabase, campaignId, { status: "active" });
  const queued = activeLeads.filter((lead) => lead.next_send_at !== null);

  await Promise.all(
    queued.map(async (lead) => {
      const current = new Date(lead.next_send_at!);
      const recomputed = recomputeNextSendAt(current, resolveLeadSendingWindow(newWindow, lead.leadTimezone));
      // Skip the write when nothing actually changes (recomputeNextSendAt is
      // a no-op for a time that's already valid under the new window) —
      // avoids touching every queued row's updated_at on an edit that only
      // changed the campaign name, for example.
      if (recomputed.getTime() === current.getTime()) return;
      await updateCampaignLead(supabase, lead.id, { next_send_at: recomputed.toISOString() });
    }),
  );
}

export async function updateCampaignAction(id: string, input: CampaignInput): Promise<ActionResult> {
  const parsed = campaignSchema.parse(input);
  const user = await requireUser();
  const supabase = await createClient();

  try {
    await assertWithinDailySendLimit(supabase, user.id, user.email, parsed.dailyLimit, id);
  } catch (error) {
    if (error instanceof PlanLimitError) return { ok: false, error: error.message };
    throw error;
  }

  // Read before write so the schedule-recompute below only ever runs when
  // the sending window actually changed — see rescheduleQueuedCampaignLeads.
  const previousCampaign = await getCampaign(supabase, user.id, id);
  const previousWindow = resolveSendingWindow(previousCampaign.sending_window);

  await updateCampaign(supabase, user.id, id, {
    name: parsed.name,
    daily_limit: parsed.dailyLimit,
    default_mailbox_id: parsed.defaultMailboxId ? parsed.defaultMailboxId : null,
    sending_window: parsed.sendingWindow,
    ...(parsed.status ? { status: parsed.status } : {}),
  });

  if (JSON.stringify(previousWindow) !== JSON.stringify(parsed.sendingWindow)) {
    await rescheduleQueuedCampaignLeads(supabase, id, parsed.sendingWindow);
  }

  revalidatePath("/campaigns");
  revalidatePath(`/campaigns/${id}`);
  return { ok: true, data: undefined };
}

export async function deleteCampaignAction(id: string) {
  const user = await requireUser();
  const supabase = await createClient();

  await deleteCampaign(supabase, user.id, id);

  revalidatePath("/campaigns");
}
