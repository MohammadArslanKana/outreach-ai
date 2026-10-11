"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { BarChart3Icon, MailPlusIcon, PencilIcon, PlugZapIcon, Trash2Icon, UnplugIcon } from "lucide-react";

import type { Tables } from "@/types/database.types";
import type { MailboxSafe } from "@/lib/db";
import {
  deleteMailboxAction,
  disconnectGmailMailboxAction,
  disconnectOutlookMailboxAction,
} from "@/app/(app)/mailboxes/actions";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { MailboxForm } from "./mailbox-form";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "success" | "outline"> = {
  active: "success",
  paused: "secondary",
  error: "destructive",
  disconnected: "outline",
};

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

function providerLabel(emailProvider: string) {
  return PROVIDER_LABEL[emailProvider] ?? "SMTP";
}

export function MailboxList({
  mailboxes,
  domains,
  googleOauthConfigured,
  microsoftOauthConfigured,
}: {
  mailboxes: MailboxSafe[];
  domains: Tables<"domains">[];
  googleOauthConfigured: boolean;
  microsoftOauthConfigured: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<MailboxSafe | null>(null);
  const [deleting, setDeleting] = useState<MailboxSafe | null>(null);
  const [isDeleting, startDeleteTransition] = useTransition();
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [isDisconnecting, startDisconnectTransition] = useTransition();

  function handleDelete() {
    if (!deleting) return;
    const target = deleting;
    startDeleteTransition(async () => {
      try {
        await deleteMailboxAction(target.id);
        toast.success("Mailbox removed.");
        setDeleting(null);
      } catch {
        toast.error("Couldn't remove the mailbox. Try again.");
      }
    });
  }

  function handleDisconnectGmail(mailboxId: string) {
    setDisconnectingId(mailboxId);
    startDisconnectTransition(async () => {
      try {
        await disconnectGmailMailboxAction(mailboxId);
        toast.success("Google account disconnected.");
      } catch {
        toast.error("Couldn't disconnect this mailbox. Try again.");
      } finally {
        setDisconnectingId(null);
      }
    });
  }

  function handleDisconnectOutlook(mailboxId: string) {
    setDisconnectingId(mailboxId);
    startDisconnectTransition(async () => {
      try {
        await disconnectOutlookMailboxAction(mailboxId);
        toast.success("Microsoft account disconnected.");
      } catch {
        toast.error("Couldn't disconnect this mailbox. Try again.");
      } finally {
        setDisconnectingId(null);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <CardTitle>Connected mailboxes</CardTitle>
          <CardDescription>SMTP, Gmail, and Microsoft 365/Outlook accounts you can send campaigns from.</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Plain <a>, not next/link: these are Route Handlers that set an
              OAuth state cookie and redirect off-site, and <Link> would
              prefetch them on every visit to this page. */}
          {googleOauthConfigured && (
            <Button variant="outline" size="sm" asChild>
              <a href="/api/oauth/google/start">
                <PlugZapIcon />
                Connect Google Workspace
              </a>
            </Button>
          )}
          {microsoftOauthConfigured && (
            <Button variant="outline" size="sm" asChild>
              <a href="/api/oauth/microsoft/start">
                <PlugZapIcon />
                Connect Microsoft 365
              </a>
            </Button>
          )}
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <MailPlusIcon />
                Add mailbox
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Connect a mailbox</DialogTitle>
                <DialogDescription>Add the SMTP credentials for the account you&apos;ll send from.</DialogDescription>
              </DialogHeader>
              <MailboxForm mode="create" domains={domains} onSuccess={() => setAddOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent>
        {mailboxes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm font-medium">No mailboxes connected yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Add a sending account to start launching campaigns.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {mailboxes.map((mailbox) => (
              <li key={mailbox.id} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{mailbox.display_name || mailbox.email}</p>
                    <Badge variant={mailbox.email_provider === "smtp" ? "outline" : "default"}>
                      {providerLabel(mailbox.email_provider)}
                    </Badge>
                    <Badge variant={STATUS_VARIANT[mailbox.status] ?? "outline"}>{statusLabel(mailbox.status)}</Badge>
                    <Badge variant={mailbox.imap_enabled ? "secondary" : "outline"}>
                      {mailbox.imap_enabled ? "Reply tracking on" : "Reply tracking off"}
                    </Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {mailbox.email} · {mailbox.smtp_host}:{mailbox.smtp_port} · {mailbox.daily_limit}/day
                    {mailbox.warmup_enabled && " · Warmup on"}
                    {" · Added "}
                    {new Date(mailbox.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" aria-label={`View analytics for ${mailbox.email}`} asChild>
                    <Link href={`/mailboxes/${mailbox.id}/analytics`}>
                      <BarChart3Icon className="size-4" />
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${mailbox.email}`}
                    onClick={() => setEditing(mailbox)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  {mailbox.email_provider === "gmail" && mailbox.status !== "disconnected" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Disconnect ${mailbox.email}`}
                      disabled={isDisconnecting && disconnectingId === mailbox.id}
                      onClick={() => handleDisconnectGmail(mailbox.id)}
                    >
                      <UnplugIcon className="size-4" />
                    </Button>
                  )}
                  {mailbox.email_provider === "outlook" && mailbox.status !== "disconnected" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Disconnect ${mailbox.email}`}
                      disabled={isDisconnecting && disconnectingId === mailbox.id}
                      onClick={() => handleDisconnectOutlook(mailbox.id)}
                    >
                      <UnplugIcon className="size-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${mailbox.email}`}
                    onClick={() => setDeleting(mailbox)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit mailbox</DialogTitle>
            <DialogDescription>Update the SMTP credentials for this sending account.</DialogDescription>
          </DialogHeader>
          {editing && (
            <MailboxForm mode="edit" mailbox={editing} domains={domains} onSuccess={() => setEditing(null)} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove mailbox?</DialogTitle>
            <DialogDescription>
              This removes {deleting?.email} permanently. Campaigns sending from it will need a new mailbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Removing…" : "Remove mailbox"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
