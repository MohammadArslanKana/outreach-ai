"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import type { Tables } from "@/types/database.types";
import type { MailboxSafe } from "@/lib/db";
import type { SendingWindow } from "@/lib/validations/sending-window";
import { updateCampaignAction } from "@/app/(app)/campaigns/actions";
import { addCampaignMailboxAction, removeCampaignMailboxAction } from "@/app/(app)/campaigns/[campaignId]/actions";
import { ActionError, unwrapActionResult } from "@/lib/action-result";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Campaign = Tables<"campaigns">;
type CampaignMailbox = Tables<"campaign_mailboxes">;

// updateCampaignAction takes the full campaign shape (campaignSchema has no
// partial-update variant — see lib/validations/campaigns.ts), so this only
// changes defaultMailboxId while resubmitting every other field unchanged,
// the same way CampaignForm's edit mode already does. sendingWindow is
// passed in already-resolved (computed server-side in page.tsx) rather than
// calling resolveSendingWindow here, so lib/email/scheduling.ts (and luxon)
// never needs to enter the client bundle.
export function MailboxAssignmentStep({
  campaign,
  mailboxes,
  campaignMailboxes,
  sendingWindow,
  onAssigned,
}: {
  campaign: Campaign;
  mailboxes: MailboxSafe[];
  campaignMailboxes: CampaignMailbox[];
  sendingWindow: SendingWindow;
  onAssigned: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [isPoolPending, startPoolTransition] = useTransition();

  function handleChange(mailboxId: string) {
    startTransition(async () => {
      try {
        unwrapActionResult(
          await updateCampaignAction(campaign.id, {
            name: campaign.name,
            dailyLimit: campaign.daily_limit,
            defaultMailboxId: mailboxId,
            sendingWindow,
            status: campaign.status as "draft" | "active" | "paused" | "completed",
          }),
        );
        toast.success("Mailbox assigned.");
        onAssigned();
      } catch (error) {
        toast.error(error instanceof ActionError ? error.message : "Couldn't assign the mailbox. Try again.");
      }
    });
  }

  // Batch 8: pool membership toggle — checking a mailbox adds it to
  // campaign_mailboxes, unchecking removes it. Leads already enrolled are
  // never rewritten by either action (see addCampaignMailboxAction/
  // removeCampaignMailboxAction's own comments) — this only affects future
  // round-robin assignment.
  const poolMailboxIds = new Set(campaignMailboxes.map((entry) => entry.mailbox_id));

  function togglePoolMailbox(mailboxId: string, inPool: boolean) {
    startPoolTransition(async () => {
      try {
        unwrapActionResult(
          inPool
            ? await removeCampaignMailboxAction(campaign.id, mailboxId)
            : await addCampaignMailboxAction(campaign.id, mailboxId),
        );
        onAssigned();
      } catch (error) {
        toast.error(error instanceof ActionError ? error.message : "Couldn't update the mailbox pool. Try again.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assign a sending mailbox</CardTitle>
        <CardDescription>
          Leads without an individual override send from the mailbox pool below when one is configured, or from this
          default mailbox otherwise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mailboxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mailboxes connected yet. <Button variant="link" className="h-auto p-0" asChild>
              <a href="/mailboxes">Connect one first</a>
            </Button>
            .
          </p>
        ) : (
          <Select
            value={campaign.default_mailbox_id ?? undefined}
            onValueChange={handleChange}
            disabled={isPending}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue placeholder="Choose a mailbox" />
            </SelectTrigger>
            <SelectContent>
              {mailboxes.map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  {mailbox.display_name || mailbox.email}
                  {mailbox.status !== "active" ? ` (${mailbox.status})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardContent>

      {mailboxes.length > 0 && (
        <CardContent className="space-y-3 border-t border-border pt-4">
          <div>
            <p className="text-sm font-medium">Mailbox pool (optional)</p>
            <p className="text-sm text-muted-foreground">
              Enrolling leads without an explicit mailbox spreads them round-robin across the mailboxes checked
              below, instead of always using the single mailbox above.
            </p>
          </div>
          <ul className="space-y-2">
            {mailboxes.map((mailbox) => {
              const inPool = poolMailboxIds.has(mailbox.id);
              return (
                <li key={mailbox.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`pool-${mailbox.id}`}
                    className="size-4 rounded-sm border-input accent-primary"
                    checked={inPool}
                    disabled={isPoolPending}
                    onChange={() => togglePoolMailbox(mailbox.id, inPool)}
                  />
                  <label htmlFor={`pool-${mailbox.id}`} className="text-sm">
                    {mailbox.display_name || mailbox.email}
                    {mailbox.status !== "active" ? ` (${mailbox.status})` : ""}
                  </label>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
