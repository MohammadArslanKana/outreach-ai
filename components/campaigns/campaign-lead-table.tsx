"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { MoreVerticalIcon, SendIcon, Trash2Icon, UserMinusIcon } from "lucide-react";

import type { MailboxSafe } from "@/lib/db";
import type { Tables } from "@/types/database.types";
import { CAMPAIGN_LEAD_STATUSES } from "@/lib/validations/campaign-leads";
import { classifyErrorCategory, ERROR_CATEGORY_LABELS } from "@/lib/analytics/error-category";
import { formatLocalTime, isValidIanaTimezone } from "@/lib/timezones";
import {
  deleteLeadPermanentlyAction,
  removeCampaignLeadAction,
  resolveSendAttemptAction,
  sendNowAction,
  updateCampaignLeadAction,
} from "@/app/(app)/campaigns/[campaignId]/actions";
import { unwrapActionResult } from "@/lib/action-result";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EnrollDialog } from "./enroll-dialog";

type Suppression = Tables<"suppressions">;

type CampaignLead = Tables<"campaign_leads">;
type Lead = Tables<"leads">;
type LeadList = Tables<"lead_lists">;
type SequenceStep = Tables<"sequence_steps">;

const USE_DEFAULT = "default";
const ALL_STATUSES = "all";

// "needs_review"/"failed" only ever come from the send worker (never set
// via the status Select below, which still only offers CAMPAIGN_LEAD_STATUSES)
// so this just needs to render them legibly, not drive any behavior.
function statusLabel(status: string) {
  return status
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function leadDisplay(lead: Lead | undefined) {
  if (!lead) return "Unknown lead";
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  return name || lead.email;
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatDateTime(value: string | null) {
  if (!value) return null;
  return dateTimeFormatter.format(new Date(value));
}

export function CampaignLeadTable({
  campaignId,
  campaignStatus,
  campaignLeads,
  leads,
  availableLeads,
  leadLists,
  leadSegments,
  mailboxes,
  steps,
  suppressions,
}: {
  campaignId: string;
  campaignStatus: string;
  campaignLeads: CampaignLead[];
  leads: Lead[];
  availableLeads: Lead[];
  leadLists: LeadList[];
  leadSegments: Tables<"lead_segments">[];
  mailboxes: MailboxSafe[];
  steps: SequenceStep[];
  suppressions: Suppression[];
}) {
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  // steps is already ordered by step_order (see listSequenceSteps), so
  // position in this array is the 1-based step number shown elsewhere
  // (SequenceStepsPanel's "Step 1"/"Step 2" labels) — no re-sorting or new
  // query needed to resolve current_step_id to a human-readable position.
  const stepPositionById = new Map(steps.map((step, index) => [step.id, index + 1]));
  // Keyed by email, not lead id: suppressions are campaign-independent and
  // survive a lead's own record being deleted (see
  // deleteLeadPermanentlyAction) — a campaign_lead can show "active" while
  // its address is globally suppressed from a bounce/unsubscribe on a
  // different campaign, which campaign_leads.status alone can't express.
  const suppressionReasonByEmail = new Map(suppressions.map((s) => [s.email, s.reason]));

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<CampaignLead | null>(null);
  const [isRemoving, startRemoveTransition] = useTransition();
  const [deletingLead, setDeletingLead] = useState<CampaignLead | null>(null);
  const [isDeletingLead, startDeleteLeadTransition] = useTransition();
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [isBulkRemoving, startBulkRemoveTransition] = useTransition();
  const [, startUpdateTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [isResolving, startResolveTransition] = useTransition();
  const [sendingNowId, setSendingNowId] = useState<string | null>(null);
  const [isSendingNow, startSendNowTransition] = useTransition();

  const filteredLeads = campaignLeads.filter((row) => {
    if (statusFilter !== ALL_STATUSES && row.status !== statusFilter) return false;
    if (search.trim()) {
      const lead = leadById.get(row.lead_id);
      const haystack = `${leadDisplay(lead)} ${lead?.email ?? ""}`.toLowerCase();
      if (!haystack.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  });

  const visibleIds = new Set(filteredLeads.map((row) => row.id));
  const selectedIds = [...selected].filter((id) => visibleIds.has(id));
  const allSelected = filteredLeads.length > 0 && selectedIds.length === filteredLeads.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleIds));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleStatusChange(row: CampaignLead, status: string) {
    startUpdateTransition(async () => {
      try {
        await updateCampaignLeadAction(campaignId, row.id, {
          mailboxId: row.mailbox_id ?? "",
          status: status as (typeof CAMPAIGN_LEAD_STATUSES)[number],
        });
      } catch {
        toast.error("Couldn't update this lead's status.");
      }
    });
  }

  function handleMailboxChange(row: CampaignLead, mailboxId: string) {
    startUpdateTransition(async () => {
      try {
        await updateCampaignLeadAction(campaignId, row.id, {
          mailboxId: mailboxId === USE_DEFAULT ? "" : mailboxId,
          status: row.status as (typeof CAMPAIGN_LEAD_STATUSES)[number],
        });
      } catch {
        toast.error("Couldn't update the mailbox for this lead.");
      }
    });
  }

  function handleResolve(row: CampaignLead, action: "retry" | "dismiss") {
    setResolvingId(row.id);
    startResolveTransition(async () => {
      try {
        unwrapActionResult(await resolveSendAttemptAction(campaignId, row.id, action));
        toast.success(action === "retry" ? "Lead queued for retry." : "Marked as resolved.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't resolve this lead.");
      } finally {
        setResolvingId(null);
      }
    });
  }

  // Only pulls this lead's next_send_at forward — every existing safety
  // check (mailbox limits/cooldowns, suppression, idempotency, pause state)
  // still applies at the next claim, unchanged. See sendNowAction's own
  // comment for the full reasoning.
  function handleSendNow(row: CampaignLead) {
    setSendingNowId(row.id);
    startSendNowTransition(async () => {
      try {
        unwrapActionResult(await sendNowAction(campaignId, row.id));
        toast.success("Queued to send as soon as possible, subject to your mailbox limits.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't send this lead now.");
      } finally {
        setSendingNowId(null);
      }
    });
  }

  function handleRemove() {
    if (!removing) return;
    const target = removing;
    startRemoveTransition(async () => {
      try {
        await removeCampaignLeadAction(campaignId, target.id);
        toast.success("Lead removed from campaign.");
        setRemoving(null);
      } catch {
        toast.error("Couldn't remove this lead from the campaign.");
      }
    });
  }

  function handleDeleteLead() {
    if (!deletingLead) return;
    const target = deletingLead;
    startDeleteLeadTransition(async () => {
      try {
        await deleteLeadPermanentlyAction(campaignId, target.lead_id);
        toast.success("Lead permanently deleted.");
        setDeletingLead(null);
      } catch {
        toast.error("Couldn't delete this lead.");
      }
    });
  }

  function handleBulkRemove() {
    const ids = selectedIds;
    if (ids.length === 0) return;
    startBulkRemoveTransition(async () => {
      try {
        await Promise.all(ids.map((id) => removeCampaignLeadAction(campaignId, id)));
        toast.success(`${ids.length} lead${ids.length === 1 ? "" : "s"} removed from campaign.`);
        setSelected(new Set());
        setBulkRemoveOpen(false);
      } catch {
        toast.error("Couldn't remove the selected leads.");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <CardTitle>Enrolled leads</CardTitle>
          <CardDescription>
            {campaignLeads.length} lead{campaignLeads.length === 1 ? "" : "s"} in this campaign.
          </CardDescription>
        </div>
        <EnrollDialog
          campaignId={campaignId}
          availableLeads={availableLeads}
          leadLists={leadLists}
          leadSegments={leadSegments}
          mailboxes={mailboxes}
          suppressionReasonByEmail={suppressionReasonByEmail}
        />
      </CardHeader>

      <CardContent>
        {campaignLeads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm font-medium">No leads enrolled yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Enroll a lead or an entire list to get started.</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email"
                aria-label="Search enrolled leads"
                className="sm:flex-1"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-48" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
                  {CAMPAIGN_LEAD_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedIds.length > 0 && (
              <div className="mb-3 flex items-center justify-between gap-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <span className="font-medium">{selectedIds.length} selected</span>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setBulkRemoveOpen(true)}>
                    <Trash2Icon />
                    Remove selected
                  </Button>
                </div>
              </div>
            )}

            {filteredLeads.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <p className="text-sm font-medium">No leads match your search</p>
                <p className="mt-1 text-sm text-muted-foreground">Try a different name, email, or status filter.</p>
              </div>
            ) : (
              <div className="overflow-x-auto" style={{ contain: "layout" }}>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="w-8 py-2 pr-2">
                        <input
                          type="checkbox"
                          className="size-4 rounded-sm border-input accent-primary"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = selectedIds.length > 0 && !allSelected;
                          }}
                          onChange={toggleAll}
                          aria-label="Select all enrolled leads"
                        />
                      </th>
                      <th className="py-2 pr-4 font-medium">Lead</th>
                      <th className="py-2 pr-4 font-medium">Mailbox</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Schedule</th>
                      <th className="py-2 pl-4 text-right font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredLeads.map((row) => {
                      const lead = leadById.get(row.lead_id);

                      return (
                        <tr key={row.id} className={selected.has(row.id) ? "bg-muted/30" : undefined}>
                          <td className="py-3 pr-2">
                            <input
                              type="checkbox"
                              className="size-4 rounded-sm border-input accent-primary"
                              checked={selected.has(row.id)}
                              onChange={() => toggleOne(row.id)}
                              aria-label={`Select ${leadDisplay(lead)}`}
                            />
                          </td>
                          <td className="max-w-48 truncate py-3 pr-4">
                            {lead ? (
                              <Link href={`/leads/${lead.id}`} className="block truncate font-medium hover:underline">
                                {leadDisplay(lead)}
                              </Link>
                            ) : (
                              <p className="truncate font-medium">{leadDisplay(lead)}</p>
                            )}
                            {lead && <p className="truncate text-xs text-muted-foreground">{lead.email}</p>}
                            {lead && suppressionReasonByEmail.has(lead.email) && (
                              <Badge variant="destructive" className="mt-1">
                                Suppressed: {statusLabel(suppressionReasonByEmail.get(lead.email)!)}
                              </Badge>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            <Select
                              value={row.mailbox_id ?? USE_DEFAULT}
                              onValueChange={(value) => handleMailboxChange(row, value)}
                            >
                              <SelectTrigger size="sm" className="w-full min-w-40">
                                <SelectValue placeholder="Campaign default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={USE_DEFAULT}>Campaign default</SelectItem>
                                {mailboxes.map((mailbox) => (
                                  <SelectItem key={mailbox.id} value={mailbox.id}>
                                    {mailbox.display_name || mailbox.email}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="py-3 pr-4">
                            <Select value={row.status} onValueChange={(value) => handleStatusChange(row, value)}>
                              <SelectTrigger size="sm" className="w-full min-w-32">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CAMPAIGN_LEAD_STATUSES.map((status) => (
                                  <SelectItem key={status} value={status}>
                                    {statusLabel(status)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="max-w-56 py-3 pr-4 align-top">
                            <div className="space-y-1">
                              {(row.status === "needs_review" || row.status === "failed") && (
                                <div className="flex flex-wrap items-center gap-1">
                                  <Badge variant="destructive">{statusLabel(row.status)}</Badge>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    disabled={isResolving && resolvingId === row.id}
                                    onClick={() => handleResolve(row, "retry")}
                                  >
                                    Retry
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    disabled={isResolving && resolvingId === row.id}
                                    onClick={() => handleResolve(row, "dismiss")}
                                  >
                                    Dismiss
                                  </Button>
                                </div>
                              )}
                              {row.status === "replied" && <Badge variant="secondary">Replied</Badge>}
                              {row.current_step_id && stepPositionById.has(row.current_step_id) && (
                                <p className="text-xs text-muted-foreground">
                                  Step {stepPositionById.get(row.current_step_id)}
                                </p>
                              )}
                              {row.next_send_at && (
                                <p className="text-xs text-muted-foreground">
                                  Next send {formatDateTime(row.next_send_at)}
                                  {lead?.timezone && isValidIanaTimezone(lead.timezone) && (
                                    <> · lead&apos;s time {formatLocalTime(lead.timezone, new Date(row.next_send_at))}</>
                                  )}
                                </p>
                              )}
                              {row.locked_until && new Date(row.locked_until) > new Date() ? (
                                <Badge variant="secondary">Sending…</Badge>
                              ) : (
                                campaignStatus === "active" &&
                                row.status === "active" &&
                                row.current_step_id &&
                                row.mailbox_id && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    disabled={isSendingNow && sendingNowId === row.id}
                                    onClick={() => handleSendNow(row)}
                                  >
                                    <SendIcon className="size-3" />
                                    {isSendingNow && sendingNowId === row.id ? "Queuing…" : "Send now"}
                                  </Button>
                                )
                              )}
                              {row.last_error && (
                                <p className="truncate text-xs text-destructive" title={row.last_error}>
                                  Failed to send ({ERROR_CATEGORY_LABELS[classifyErrorCategory(row.last_error)]})
                                </p>
                              )}
                              {!row.current_step_id && !row.next_send_at && !row.last_error && (
                                <p className="text-xs text-muted-foreground">Not scheduled</p>
                              )}
                            </div>
                          </td>
                          <td className="py-3 pl-4">
                            <div className="flex items-center justify-end">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label={`Actions for ${leadDisplay(lead)}`}>
                                    <MoreVerticalIcon className="size-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onSelect={() => setRemoving(row)}>
                                    <UserMinusIcon />
                                    Remove from campaign
                                  </DropdownMenuItem>
                                  <DropdownMenuItem variant="destructive" onSelect={() => setDeletingLead(row)}>
                                    <Trash2Icon />
                                    Delete lead permanently
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from campaign?</DialogTitle>
            <DialogDescription>
              This removes {leadDisplay(removing ? leadById.get(removing.lead_id) : undefined)} from this campaign.
              The lead itself isn&apos;t deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={isRemoving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemove} disabled={isRemoving}>
              {isRemoving ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deletingLead !== null} onOpenChange={(open) => !open && setDeletingLead(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete this lead?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              {leadDisplay(deletingLead ? leadById.get(deletingLead.lead_id) : undefined)} and removes them from
              every campaign, not just this one. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingLead(null)} disabled={isDeletingLead}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteLead} disabled={isDeletingLead}>
              {isDeletingLead ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkRemoveOpen} onOpenChange={setBulkRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {selectedIds.length} leads?</DialogTitle>
            <DialogDescription>
              This removes the selected leads from this campaign. The leads themselves aren&apos;t deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkRemoveOpen(false)} disabled={isBulkRemoving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleBulkRemove} disabled={isBulkRemoving}>
              {isBulkRemoving ? "Removing…" : `Remove ${selectedIds.length} leads`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
