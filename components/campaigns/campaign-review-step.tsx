"use client";

import { useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangleIcon, InfoIcon, PaperclipIcon } from "lucide-react";

import type { Tables } from "@/types/database.types";
import type { MailboxSafe } from "@/lib/db";
import type { CampaignReadinessResult } from "@/lib/campaigns/readiness";
import { isOvernightWindow, type SendingWindow } from "@/lib/validations/sending-window";
import { launchCampaignAction } from "@/app/(app)/campaigns/[campaignId]/actions";
import { unwrapActionResult } from "@/lib/action-result";
import { validateSequenceTemplates } from "@/lib/email/validate-template";
import type { MergeTagLead } from "@/lib/email/merge-tags";
import { formatBytes } from "@/lib/email/attachment-validation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TemplateValidationList } from "@/components/sequences/template-validation-list";

type Campaign = Tables<"campaigns">;
type CampaignLead = Tables<"campaign_leads">;
type Lead = Tables<"leads">;
type SequenceStep = Tables<"sequence_steps">;

const DAY_LABEL: Record<string, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

function hourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function delayLabel(dayDelay: number) {
  if (dayDelay === 0) return "Same day";
  return `+${dayDelay} day${dayDelay === 1 ? "" : "s"}`;
}

export function CampaignReviewStep({
  campaign,
  campaignLeads,
  leads,
  mailboxes,
  sequenceSteps,
  attachmentsByStep,
  sendingWindow,
  readiness,
}: {
  campaign: Campaign;
  campaignLeads: CampaignLead[];
  leads: Lead[];
  mailboxes: MailboxSafe[];
  sequenceSteps: SequenceStep[];
  attachmentsByStep: Record<string, Tables<"email_attachments">[]>;
  sendingWindow: SendingWindow;
  readiness: CampaignReadinessResult;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const defaultMailbox = campaign.default_mailbox_id
    ? mailboxes.find((mailbox) => mailbox.id === campaign.default_mailbox_id)
    : undefined;
  const sortedSteps = [...sequenceSteps].sort((a, b) => a.step_order - b.step_order);
  const windowDays = sendingWindow.days.map((day) => DAY_LABEL[day]).join(", ");

  // Non-blocking template quality hints (unsupported/malformed merge tags,
  // and — since this step has the actual enrolled leads' data — tags with
  // no value for some of them). Deliberately separate from `readiness`:
  // this never affects readiness.ready or the launch button below it, only
  // what's shown above it. See lib/email/validate-template.ts (Batch 2).
  const mergeTagLeads: MergeTagLead[] = useMemo(
    () =>
      leads.map((lead) => ({
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email,
        company: lead.company,
        title: lead.title,
        custom_fields: lead.custom_fields as Record<string, unknown> | null,
      })),
    [leads],
  );
  const templateIssues = useMemo(
    () => validateSequenceTemplates(sequenceSteps, mergeTagLeads),
    [sequenceSteps, mergeTagLeads],
  );

  function handleLaunch() {
    startTransition(async () => {
      try {
        unwrapActionResult(await launchCampaignAction(campaign.id));
        toast.success("Campaign launched.");
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't launch the campaign.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review &amp; launch</CardTitle>
        <CardDescription>Double-check everything before this campaign starts sending.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">Leads enrolled</dt>
            <dd className="text-lg font-medium">{campaignLeads.length}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Sending mailbox</dt>
            <dd className="text-lg font-medium">
              {defaultMailbox ? defaultMailbox.display_name || defaultMailbox.email : "Not set"}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Sending window</dt>
            <dd className="text-lg font-medium">
              {windowDays}, {hourLabel(sendingWindow.startHour)}–{hourLabel(sendingWindow.endHour)}
              {isOvernightWindow(sendingWindow) && " (next day)"} ({sendingWindow.timezone})
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                Leads with their own timezone get these hours in their local time.
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Daily limit</dt>
            <dd className="text-lg font-medium">{campaign.daily_limit}/day</dd>
          </div>
        </dl>

        <div>
          <p className="mb-2 text-sm text-muted-foreground">Sequence ({sortedSteps.length} step{sortedSteps.length === 1 ? "" : "s"})</p>
          <ul className="space-y-1">
            {sortedSteps.map((step, index) => {
              const stepAttachments = attachmentsByStep[step.id] ?? [];
              const totalAttachmentBytes = stepAttachments.reduce((sum, a) => sum + a.size_bytes, 0);
              return (
                <li key={step.id} className="flex items-center gap-2 text-sm">
                  <Badge variant="outline">{delayLabel(step.day_delay)}</Badge>
                  <span className="truncate">{step.subject || `Step ${index + 1} (no subject)`}</span>
                  {stepAttachments.length > 0 && (
                    <span
                      className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                      title={stepAttachments.map((a) => a.file_name).join(", ")}
                    >
                      <PaperclipIcon className="size-3.5" />
                      {stepAttachments.length} ({formatBytes(totalAttachmentBytes)})
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {templateIssues.length > 0 && (
          <div>
            <p className="mb-2 text-sm text-muted-foreground">Template checks</p>
            <TemplateValidationList issues={templateIssues} />
          </div>
        )}

        {readiness.errors.length > 0 && (
          <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {readiness.errors.map((error) => (
              <p key={error} className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            ))}
          </div>
        )}
        {readiness.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {readiness.warnings.map((warning) => (
              <p key={warning} className="flex items-start gap-2">
                <InfoIcon className="mt-0.5 size-4 shrink-0" />
                {warning}
              </p>
            ))}
          </div>
        )}

        <Button onClick={handleLaunch} disabled={isPending || !readiness.ready}>
          {isPending ? "Launching…" : "Launch campaign"}
        </Button>
      </CardContent>
    </Card>
  );
}
