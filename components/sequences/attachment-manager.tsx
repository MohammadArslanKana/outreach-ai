"use client";

import { useRef, useState, useTransition } from "react";
import { FileTextIcon, ImageIcon, PaperclipIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import {
  MAX_ATTACHMENTS_PER_STEP,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES_PER_STEP,
  formatBytes,
  sniffAttachmentMimeType,
  type SupportedAttachmentMimeType,
} from "@/lib/email/attachment-validation";
import { removeAttachmentAction, uploadAttachmentAction } from "@/app/(app)/campaigns/[campaignId]/actions";
import { ActionError, unwrapActionResult } from "@/lib/action-result";
import { Button } from "@/components/ui/button";

export interface AttachmentSummary {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

const ACCEPT_ATTRIBUTE = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";

function AttachmentIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === "application/pdf") return <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />;
  return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
}

// Quick client-side pre-check on just the file's first few bytes — purely a
// fast, friendly failure before spending a round trip; it is not the real
// security boundary. uploadAttachmentAction re-sniffs the entire file
// server-side regardless (lib/email/attachment-validation.ts) and never
// trusts this result.
async function quickClientSniff(file: File): Promise<SupportedAttachmentMimeType | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return sniffAttachmentMimeType(head);
}

// Attachment picker + list for the sequence step composer
// (sequence-step-form.tsx). Files upload immediately on selection (each
// becomes its own email_attachments row, unlinked until the step is saved —
// see uploadAttachmentAction); this component only tracks which attachment
// ids are currently attached to the step being edited, as a plain id list —
// never file bytes, never embedded into the step's body/subject.
export function AttachmentManager({
  attachments,
  onChange,
  onUploaded,
  disabled,
}: {
  attachments: AttachmentSummary[];
  onChange: (next: AttachmentSummary[]) => void;
  // Notifies the parent when a brand-new attachment is uploaded (not when an
  // existing/already-linked one is simply present) — the parent uses this to
  // track which ids need discardUnlinkedAttachmentsAction cleanup if the
  // composer is closed without saving. See SequenceStepForm.
  onUploaded?: (id: string) => void;
  disabled?: boolean;
}) {
  const [isUploading, startUploadTransition] = useTransition();
  const [isRemoving, startRemoveTransition] = useTransition();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  const atCountLimit = attachments.length >= MAX_ATTACHMENTS_PER_STEP;

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file after an error
    if (!file) return;

    if (atCountLimit) {
      toast.error(`A step can have at most ${MAX_ATTACHMENTS_PER_STEP} attachments.`);
      return;
    }
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      toast.error(`"${file.name}" is too large. Files must be ${formatBytes(MAX_ATTACHMENT_SIZE_BYTES)} or smaller.`);
      return;
    }
    if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES_PER_STEP) {
      toast.error(`Adding "${file.name}" would put this step's attachments over the ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES_PER_STEP)} total limit.`);
      return;
    }

    startUploadTransition(async () => {
      const sniffed = await quickClientSniff(file);
      if (!sniffed) {
        toast.error(`"${file.name}" isn't a supported file type. Attach a PDF, PNG, JPG, or WEBP file.`);
        return;
      }

      try {
        const formData = new FormData();
        formData.append("file", file);
        const uploaded = unwrapActionResult(await uploadAttachmentAction(formData));
        onChange([...attachments, uploaded]);
        onUploaded?.(uploaded.id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't upload this file. Try again.");
      }
    });
  }

  function handleRemove(attachmentId: string) {
    setRemovingId(attachmentId);
    startRemoveTransition(async () => {
      try {
        unwrapActionResult(await removeAttachmentAction(attachmentId));
        onChange(attachments.filter((attachment) => attachment.id !== attachmentId));
      } catch (error) {
        toast.error(error instanceof ActionError ? error.message : "Couldn't remove this attachment. Try again.");
      } finally {
        setRemovingId(null);
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Attachments {attachments.length > 0 && `(${attachments.length}/${MAX_ATTACHMENTS_PER_STEP})`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled || isUploading || atCountLimit}
          onClick={() => inputRef.current?.click()}
        >
          <PaperclipIcon />
          {isUploading ? "Uploading…" : "Attach file"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {attachments.length > 0 && (
        <ul className="space-y-1">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2">
                <AttachmentIcon mimeType={attachment.mimeType} />
                <span className="truncate font-medium text-foreground">{attachment.fileName}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.sizeBytes)}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`Remove ${attachment.fileName}`}
                disabled={isRemoving && removingId === attachment.id}
                onClick={() => handleRemove(attachment.id)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        PDF, PNG, JPG, or WEBP. Up to {formatBytes(MAX_ATTACHMENT_SIZE_BYTES)} each,{" "}
        {formatBytes(MAX_TOTAL_ATTACHMENT_BYTES_PER_STEP)} total, {MAX_ATTACHMENTS_PER_STEP} files per step.
      </p>
    </div>
  );
}
