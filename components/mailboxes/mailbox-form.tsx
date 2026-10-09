"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import type { Tables } from "@/types/database.types";
import type { MailboxSafe } from "@/lib/db";
import { mailboxSchema, type MailboxInput } from "@/lib/validations/mailboxes";
import {
  createMailboxAction,
  testImapConnectionAction,
  testSmtpConnectionAction,
  updateMailboxAction,
} from "@/app/(app)/mailboxes/actions";
import { ActionError, unwrapActionResult } from "@/lib/action-result";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const NO_DOMAIN = "none";

type MailboxFormProps =
  | { mode: "create"; mailbox?: undefined; domains: Tables<"domains">[]; onSuccess: () => void }
  | { mode: "edit"; mailbox: MailboxSafe; domains: Tables<"domains">[]; onSuccess: () => void };

export function MailboxForm({ mode, mailbox, domains, onSuccess }: MailboxFormProps) {
  const [isPending, startTransition] = useTransition();
  const [isTesting, startTestTransition] = useTransition();
  // Separate from isTesting/startTestTransition above (which is IMAP-only)
  // so the SMTP and IMAP "Test connection" buttons can run independently
  // rather than disabling each other.
  const [isTestingSmtp, startTestSmtpTransition] = useTransition();
  // A Gmail-connected mailbox has no SMTP/IMAP credentials to edit — the
  // email, host/port/username, and reply-tracking config were all set from
  // Google's OAuth response at connect time (see
  // app/api/oauth/google/callback/route.ts) and stay fixed. Every other
  // field (display name, limits, domain, status, warmup) is provider-
  // agnostic and reuses the exact same updateMailboxAction/mailboxSchema
  // path a manual mailbox does — defaultValues below already carries the
  // Gmail row's existing smtp/imap values through unchanged since this
  // component simply never renders a field for them in this mode.
  const isGmailEdit = mode === "edit" && mailbox.email_provider === "gmail";
  // Same reasoning as isGmailEdit, for an Outlook-connected mailbox. Kept as
  // a separate flag (not folded into isGmailEdit) so Gmail's own condition
  // is untouched; isOAuthEdit below is the shared "hide manual fields" gate
  // both flow into.
  const isOutlookEdit = mode === "edit" && mailbox.email_provider === "outlook";
  const isOAuthEdit = isGmailEdit || isOutlookEdit;

  const form = useForm<MailboxInput>({
    resolver: zodResolver(mailboxSchema),
    defaultValues:
      mode === "edit"
        ? {
            email: mailbox.email,
            displayName: mailbox.display_name ?? "",
            smtpHost: mailbox.smtp_host,
            smtpPort: mailbox.smtp_port,
            smtpUsername: mailbox.smtp_username,
            smtpPassword: "",
            dailyLimit: mailbox.daily_limit,
            hourlyLimit: mailbox.hourly_limit,
            cooldownMinutes: mailbox.cooldown_minutes,
            warmupEnabled: mailbox.warmup_enabled,
            domainId: mailbox.domain_id ?? "",
            status: mailbox.status as MailboxInput["status"],
            imapEnabled: mailbox.imap_enabled,
            imapHost: mailbox.imap_host ?? "",
            imapPort: mailbox.imap_port,
            imapUsername: mailbox.imap_username ?? "",
            imapPassword: "",
          }
        : {
            email: "",
            displayName: "",
            smtpHost: "",
            smtpPort: 587,
            smtpUsername: "",
            smtpPassword: "",
            dailyLimit: 50,
            hourlyLimit: 10,
            cooldownMinutes: 0,
            warmupEnabled: false,
            domainId: "",
            imapEnabled: false,
            imapHost: "",
            imapPort: 993,
            imapUsername: "",
            imapPassword: "",
          },
  });

  const imapEnabled = useWatch({ control: form.control, name: "imapEnabled" });

  function onTestConnection() {
    const { imapHost, imapPort, imapUsername, imapPassword } = form.getValues();
    startTestTransition(async () => {
      const result = await testImapConnectionAction({
        mailboxId: mode === "edit" ? mailbox.id : undefined,
        imapHost: imapHost ?? "",
        imapPort,
        imapUsername: imapUsername ?? "",
        imapPassword: imapPassword ?? "",
      });
      if (result.ok) {
        toast.success("Connected — reply tracking can reach this inbox.");
      } else {
        toast.error(result.error);
      }
    });
  }

  function onTestSmtpConnection() {
    const { smtpHost, smtpPort, smtpUsername, smtpPassword } = form.getValues();
    startTestSmtpTransition(async () => {
      const result = await testSmtpConnectionAction({
        mailboxId: mode === "edit" ? mailbox.id : undefined,
        smtpHost: smtpHost ?? "",
        smtpPort,
        smtpUsername: smtpUsername ?? "",
        smtpPassword: smtpPassword ?? "",
      });
      if (result.ok) {
        toast.success("Connected — this mailbox can send campaigns.");
      } else {
        toast.error(result.error);
      }
    });
  }

  function onSubmit(values: MailboxInput) {
    startTransition(async () => {
      try {
        if (mode === "create") {
          unwrapActionResult(await createMailboxAction(values));
          toast.success("Mailbox connected.");
        } else {
          await updateMailboxAction(mailbox.id, values);
          toast.success("Mailbox updated.");
        }
        onSuccess();
      } catch (error) {
        toast.error(
          error instanceof ActionError
            ? error.message
            : mode === "create"
              ? "Couldn't connect the mailbox. Try again."
              : "Couldn't update the mailbox. Try again.",
        );
      }
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {isOAuthEdit ? (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{mailbox.email}</p>
            </FormItem>
          ) : (
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input placeholder="jane@yourdomain.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name="displayName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <FormControl>
                  <Input placeholder="Jane Cooper" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {isOAuthEdit && (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Connected via {isGmailEdit ? "Google Workspace" : "Microsoft 365"} — sending and reply tracking use this{" "}
            {isGmailEdit ? "Google" : "Microsoft"} account&apos;s own credentials, refreshed automatically. Disconnect
            it from the mailbox list to remove access.
          </p>
        )}

        {!isOAuthEdit && (
          <>
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <FormField
                control={form.control}
                name="smtpHost"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>SMTP host</FormLabel>
                    <FormControl>
                      <Input placeholder="smtp.yourdomain.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="smtpPort"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
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
            </div>

            <FormField
              control={form.control}
              name="smtpUsername"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>SMTP username</FormLabel>
                  <FormControl>
                    <Input placeholder="jane@yourdomain.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="smtpPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    SMTP password
                    {mode === "edit" && (
                      <span className="font-normal text-muted-foreground"> (leave blank to keep current)</span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" required={mode === "create"} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="button" variant="outline" size="sm" disabled={isTestingSmtp} onClick={onTestSmtpConnection}>
              {isTestingSmtp ? "Testing…" : "Test connection"}
            </Button>
          </>
        )}

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
            name="domainId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Domain</FormLabel>
                <Select
                  value={field.value || NO_DOMAIN}
                  onValueChange={(value) => field.onChange(value === NO_DOMAIN ? "" : value)}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No domain" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_DOMAIN}>No domain</SelectItem>
                    {domains.map((domain) => (
                      <SelectItem key={domain.id} value={domain.id}>
                        {domain.domain}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="hourlyLimit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Hourly send limit</FormLabel>
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
            name="cooldownMinutes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cooldown between sends (minutes)</FormLabel>
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
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <p className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          Mailbox warmup can be configured after connecting your mailbox, from the{" "}
          <Link href="/warmup" className="font-medium text-foreground hover:underline">
            Warmup
          </Link>{" "}
          page.
        </p>

        {!isOAuthEdit && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <FormField
            control={form.control}
            name="imapEnabled"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between">
                <div>
                  <FormLabel className="cursor-pointer">Enable reply tracking</FormLabel>
                  <p className="text-sm text-muted-foreground">Poll this inbox over IMAP to detect replies.</p>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          {imapEnabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
                <FormField
                  control={form.control}
                  name="imapHost"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>IMAP host</FormLabel>
                      <FormControl>
                        <Input placeholder="imap.yourdomain.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="imapPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Port</FormLabel>
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
              </div>

              <FormField
                control={form.control}
                name="imapUsername"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>IMAP username</FormLabel>
                    <FormControl>
                      <Input placeholder="jane@yourdomain.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="imapPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      IMAP password
                      {mode === "edit" && (
                        <span className="font-normal text-muted-foreground"> (leave blank to keep current)</span>
                      )}
                    </FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type="button" variant="outline" size="sm" disabled={isTesting} onClick={onTestConnection}>
                {isTesting ? "Testing…" : "Test connection"}
              </Button>
            </>
          )}
        </div>
        )}

        <DialogFooter>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : mode === "create" ? "Connect mailbox" : "Save changes"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
