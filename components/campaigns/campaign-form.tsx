"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import type { MailboxSafe } from "@/lib/db";
import type { Tables } from "@/types/database.types";
import { CAMPAIGN_STATUSES, campaignSchema, type CampaignInput } from "@/lib/validations/campaigns";
import { SENDING_WINDOW_DAYS, type SendingWindow } from "@/lib/validations/sending-window";
import { createCampaignAction, updateCampaignAction } from "@/app/(app)/campaigns/actions";
import { ActionError, unwrapActionResult } from "@/lib/action-result";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SendingWindowEditor } from "./sending-window-editor";

const NO_MAILBOX = "none";

// Days/hours match lib/email/scheduling.ts's DEFAULT_SENDING_WINDOW (all 7
// days, 9-17) — not imported directly, to avoid pulling that module (and
// luxon) into the client bundle for a brand-new campaign that has nothing to
// resolve yet. The *timezone* deliberately does NOT match that constant's
// "UTC": DEFAULT_SENDING_WINDOW's UTC is a legacy-data fallback for
// malformed/empty stored windows (see resolveSendingWindow) and must stay
// stable for existing campaigns, but silently pre-filling a brand-new
// campaign with UTC is exactly the "sends at 5am local time without anyone
// choosing that" bug this batch fixes — so new campaigns start from the
// browser's own detected zone instead, an explicit, visible, correct-by-
// default guess the user can still change before ever saving.
function defaultFormSendingWindow(): SendingWindow {
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // Keep the UTC fallback — an unusual runtime that can't resolve its own
    // timezone shouldn't crash campaign creation.
  }
  return {
    days: [...SENDING_WINDOW_DAYS],
    startHour: 9,
    endHour: 17,
    timezone,
  };
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

type CampaignFormProps =
  | { mode: "create"; campaign?: undefined; sendingWindow?: undefined; mailboxes: MailboxSafe[]; onSuccess?: (id?: string) => void }
  | { mode: "edit"; campaign: Tables<"campaigns">; sendingWindow: SendingWindow; mailboxes: MailboxSafe[]; onSuccess?: (id?: string) => void };

export function CampaignForm({ mode, campaign, sendingWindow, mailboxes, onSuccess }: CampaignFormProps) {
  const [isPending, startTransition] = useTransition();

  const form = useForm<CampaignInput>({
    resolver: zodResolver(campaignSchema),
    defaultValues:
      mode === "edit"
        ? {
            name: campaign.name,
            status: campaign.status as CampaignInput["status"],
            dailyLimit: campaign.daily_limit,
            defaultMailboxId: campaign.default_mailbox_id ?? "",
            sendingWindow,
          }
        : {
            name: "",
            dailyLimit: 50,
            defaultMailboxId: "",
            sendingWindow: defaultFormSendingWindow(),
          },
  });

  function onSubmit(values: CampaignInput) {
    startTransition(async () => {
      try {
        if (mode === "create") {
          const created = unwrapActionResult(await createCampaignAction(values));
          toast.success("Campaign created.");
          onSuccess?.(created.id);
        } else {
          unwrapActionResult(await updateCampaignAction(campaign.id, values));
          toast.success("Campaign updated.");
          onSuccess?.();
        }
      } catch (error) {
        toast.error(
          error instanceof ActionError
            ? error.message
            : mode === "create"
              ? "Couldn't create the campaign. Try again."
              : "Couldn't update the campaign. Try again.",
        );
      }
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Q3 outbound push" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="dailyLimit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Daily send limit</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(e) => field.onChange(e.target.valueAsNumber)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="defaultMailboxId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Default mailbox</FormLabel>
                <Select
                  value={field.value || NO_MAILBOX}
                  onValueChange={(value) => field.onChange(value === NO_MAILBOX ? "" : value)}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No default mailbox" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_MAILBOX}>No default mailbox</SelectItem>
                    {mailboxes.map((mailbox) => (
                      <SelectItem key={mailbox.id} value={mailbox.id}>
                        {mailbox.display_name || mailbox.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {mode === "edit" && (
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {/* draft -> active is meant to happen only through
                        launchCampaignAction (the setup wizard's "Launch
                        campaign" button), which validates the campaign is
                        actually ready to send — this raw Select has no such
                        validation. Filtering the option out here is a UI-level
                        guard against picking it by mistake; it doesn't change
                        what updateCampaignAction itself will accept. */}
                    {CAMPAIGN_STATUSES.filter((status) => campaign.status !== "draft" || status !== "active").map(
                      (status) => (
                        <SelectItem key={status} value={status}>
                          {statusLabel(status)}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                {campaign.status === "draft" && (
                  <p className="text-xs text-muted-foreground">
                    Use the setup wizard&apos;s &ldquo;Launch campaign&rdquo; button to activate.
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className="space-y-1">
          <h3 className="text-sm font-medium">Sending window</h3>
          <p className="text-xs text-muted-foreground">
            Emails for this campaign only send on these days and within this hour range.
          </p>
        </div>
        <SendingWindowEditor control={form.control} />

        <DialogFooter>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : mode === "create" ? "Create campaign" : "Save changes"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
