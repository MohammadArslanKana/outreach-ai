"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import type { Tables } from "@/types/database.types";
import { sequenceStepSchema, type SequenceStepInput } from "@/lib/validations/sequence-steps";
import {
  createSequenceStepAction,
  discardUnlinkedAttachmentsAction,
  linkAttachmentsToStepAction,
  updateSequenceStepAction,
} from "@/app/(app)/campaigns/[campaignId]/actions";
import { unwrapActionResult } from "@/lib/action-result";
import { findMalformedTags, findUnsupportedTags } from "@/lib/email/validate-template";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { TemplatePicker } from "./template-picker";
import { MergeTagPicker } from "./merge-tag-picker";
import { TemplateValidationList } from "./template-validation-list";
import { EmailPreviewDialog } from "./email-preview-dialog";
import { AttachmentManager, type AttachmentSummary } from "./attachment-manager";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor";

type SequenceStepFormProps = (
  | { mode: "create"; campaignId: string; step?: undefined; onSuccess?: () => void }
  | { mode: "edit"; campaignId: string; step: Tables<"sequence_steps">; onSuccess?: () => void }
) & { templates: Tables<"templates">[]; existingAttachments?: AttachmentSummary[] };

type ActiveField = "subject" | "body";

export function SequenceStepForm({
  mode,
  campaignId,
  step,
  templates,
  existingAttachments = [],
  onSuccess,
}: SequenceStepFormProps) {
  const [isPending, startTransition] = useTransition();

  // Attachments upload immediately (see AttachmentManager/uploadAttachmentAction)
  // and are only linked to this step on a successful Save — this list is the
  // current set of attachment ids/metadata for the step being edited,
  // starting from whatever was already linked (edit mode) plus anything
  // uploaded during this session.
  const [attachments, setAttachments] = useState<AttachmentSummary[]>(existingAttachments);
  // Ids uploaded during this dialog session that are NOT yet linked to a
  // step — if the dialog closes without a successful save, these are
  // discarded (see the unmount effect below) so an uploaded-then-abandoned
  // file doesn't sit around forever with nothing referencing it. Ids that
  // were already linked when the form opened (existingAttachments) are
  // never in this set, so they're never at risk of this cleanup.
  const uploadedThisSessionRef = useRef<Set<string>>(new Set());

  // Whether the save-and-link sequence below completed. A plain ref write
  // inside the submit handler itself (passed to form.handleSubmit) trips
  // React Compiler's ref-safety check — "may read/write a ref during
  // render" — since the compiler can't prove handleSubmit won't invoke it
  // synchronously. So the submit handler only ever calls the state setter
  // below; a separate effect mirrors that state into this ref, which the
  // unmount-only cleanup effect (further down) reads. Both ref accesses
  // happen inside effects, never inside a function passed to handleSubmit.
  const [saveSucceeded, setSaveSucceeded] = useState(false);
  const saveSucceededRef = useRef(false);
  useEffect(() => {
    saveSucceededRef.current = saveSucceeded;
  }, [saveSucceeded]);

  useEffect(() => {
    return () => {
      if (saveSucceededRef.current) return;
      // uploadedThisSessionRef.current is a long-lived accumulator Set
      // (mutated in place via .add(), never reassigned) — reading it here
      // at cleanup time reflects every upload from this session, not a
      // stale snapshot, so there's nothing to copy into a local variable.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
      const idsToDiscard = [...uploadedThisSessionRef.current];
      if (idsToDiscard.length > 0) {
        void discardUnlinkedAttachmentsAction(idsToDiscard).catch(() => {});
      }
    };
    // Intentionally empty deps — this must run its cleanup exactly once, on
    // unmount (dialog close), not on every re-render.
  }, []);

  const form = useForm<SequenceStepInput>({
    resolver: zodResolver(sequenceStepSchema),
    defaultValues:
      mode === "edit"
        ? {
            dayDelay: step.day_delay,
            subject: step.subject ?? "",
            body: step.body ?? "",
          }
        : {
            dayDelay: 0,
            subject: "",
            body: "",
          },
  });

  // The variable picker inserts into whichever of Subject/Body the user
  // last focused — tracked here rather than guessed, since both fields
  // accept merge tags (a subject line like "Quick question about
  // {{company}}" is a common real pattern, not just the body).
  const [activeField, setActiveField] = useState<ActiveField>("body");
  const subjectEditorRef = useRef<ComposerEditorHandle | null>(null);
  const bodyEditorRef = useRef<ComposerEditorHandle | null>(null);

  const subjectValue = useWatch({ control: form.control, name: "subject" }) ?? "";
  const bodyValue = useWatch({ control: form.control, name: "body" }) ?? "";

  // Live, non-blocking hints as the user types — reuses the canonical
  // renderer via validate-template.ts (Batch 1) rather than re-parsing
  // {{...}} here. Missing-data-across-enrolled-leads isn't checked here (no
  // lead list at this scope) — that's surfaced once, aggregated, in
  // CampaignReviewStep.
  const validationIssues = useMemo(
    () => [...findMalformedTags(subjectValue), ...findMalformedTags(bodyValue), ...findUnsupportedTags(subjectValue, bodyValue)],
    [subjectValue, bodyValue],
  );

  // Inserts a variable chip at the cursor of the last-focused field; the
  // editor's own update then writes the new value into the form.
  function insertMergeTag(tag: string) {
    const editor = activeField === "subject" ? subjectEditorRef.current : bodyEditorRef.current;
    editor?.insertMergeTag(tag);
  }

  function onSubmit(values: SequenceStepInput) {
    startTransition(async () => {
      try {
        const stepId = mode === "create" ? (await createSequenceStepAction(campaignId, values)).id : step.id;
        if (mode === "edit") {
          await updateSequenceStepAction(campaignId, step.id, values);
        }

        // Links whatever's currently attached (existing survivors + this
        // session's uploads) to the now-guaranteed-to-exist step. Removed
        // attachments are already gone (removeAttachmentAction deletes
        // immediately — see AttachmentManager), so `attachments` here is
        // exactly the step's final attachment set, not a diff.
        if (attachments.length > 0) {
          unwrapActionResult(
            await linkAttachmentsToStepAction(
              campaignId,
              stepId,
              attachments.map((attachment) => attachment.id),
            ),
          );
        }
        setSaveSucceeded(true);

        toast.success(mode === "create" ? "Step added." : "Step updated.");
        onSuccess?.();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : mode === "create"
              ? "Couldn't add the step. Try again."
              : "Couldn't update the step. Try again.",
        );
      }
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <TemplatePicker templates={templates} setValue={form.setValue} />

        <FormField
          control={form.control}
          name="dayDelay"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Days after previous step</FormLabel>
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
          name="subject"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Subject</FormLabel>
              <FormControl>
                <ComposerEditor
                  ref={subjectEditorRef}
                  variant="subject"
                  ariaLabel="Subject"
                  placeholder="Quick question about your team"
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  onFocus={() => setActiveField("subject")}
                  disabled={isPending}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="body"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between gap-2">
                <FormLabel>Body</FormLabel>
                <EmailPreviewDialog subject={subjectValue} body={bodyValue} attachments={attachments} />
              </div>
              <FormControl>
                <ComposerEditor
                  ref={bodyEditorRef}
                  variant="body"
                  ariaLabel="Body"
                  placeholder="Hi there, ..."
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  onFocus={() => setActiveField("body")}
                  disabled={isPending}
                  toolbarExtra={<MergeTagPicker onInsert={insertMergeTag} disabled={isPending} />}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                Variables go into whichever field you last clicked, and appear as chips. Select text to make it bold,
                italic or a link. Press Enter for a new paragraph and Shift+Enter for a line break. A web address like
                https://example.com becomes clickable automatically.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />

        <AttachmentManager
          attachments={attachments}
          onChange={setAttachments}
          onUploaded={(id) => uploadedThisSessionRef.current.add(id)}
          disabled={isPending}
        />

        <TemplateValidationList issues={validationIssues} />

        <DialogFooter>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : mode === "create" ? "Add step" : "Save changes"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
