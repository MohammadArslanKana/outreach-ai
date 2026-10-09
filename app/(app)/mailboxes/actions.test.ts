import { beforeEach, describe, expect, it, vi } from "vitest";

// Same "mock the seam" approach as app/(app)/campaigns/[campaignId]/actions.test.ts
// — only the DB/auth/crypto boundary is mocked. Covers updateMailboxAction's
// OAuth handling: a Gmail/Outlook mailbox's connection fields and
// reply_provider stay as the OAuth connection set them.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1", email: "owner@example.test" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/db", () => ({
  createMailbox: vi.fn(),
  deleteMailbox: vi.fn(),
  getMailbox: vi.fn(),
  getMailboxImapCredential: vi.fn(),
  getMailboxSmtpCredential: vi.fn(),
  getUserOrganization: vi.fn(async () => ({ id: "org-1" })),
  recordAuditEvent: vi.fn(),
  updateMailbox: vi.fn(async (_supabase: unknown, _userId: string, id: string) => ({ id, email: "sender@example.test" })),
}));
vi.mock("@/lib/crypto/smtp-secret", () => ({ encryptSmtpPassword: (plain: string) => `enc(${plain})` }));
vi.mock("@/lib/billing/limits", () => ({
  assertWithinMailboxLimit: vi.fn(),
  PlanLimitError: class PlanLimitError extends Error {},
}));
vi.mock("@/lib/rate-limit/check-rate-limit", () => ({ checkRateLimit: vi.fn(), RateLimitError: class extends Error {} }));

import { createMailbox, getMailbox, getMailboxImapCredential, recordAuditEvent, updateMailbox } from "@/lib/db";
import { assertWithinMailboxLimit, PlanLimitError } from "@/lib/billing/limits";
import type { MailboxInput } from "@/lib/validations/mailboxes";
import { createMailboxAction, updateMailboxAction } from "./actions";

// What mailbox-form.tsx submits when editing: the row's existing values
// carried through, with only the status changed.
const formInput: MailboxInput = {
  email: "sender@example.test",
  displayName: "Sender",
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  smtpUsername: "sender@example.test",
  smtpPassword: "",
  dailyLimit: 50,
  hourlyLimit: 10,
  cooldownMinutes: 0,
  warmupEnabled: false,
  domainId: "",
  status: "active",
  imapEnabled: true,
  imapHost: "imap.gmail.com",
  imapPort: 993,
  imapUsername: "sender@example.test",
  imapPassword: "",
};

function updatedValues() {
  expect(updateMailbox).toHaveBeenCalledTimes(1);
  return vi.mocked(updateMailbox).mock.calls[0][3];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Returned rather than thrown: a thrown Server Function error's message is
// redacted in production — see lib/action-result.ts.
describe("createMailboxAction — plan limit", () => {
  it("returns the mailbox-limit message and connects nothing", async () => {
    const message = "Your account has no active subscription. The current limit allows up to 1 mailbox. Upgrade to add more.";
    vi.mocked(assertWithinMailboxLimit).mockRejectedValueOnce(new PlanLimitError(message));

    const result = await createMailboxAction({ ...formInput, smtpPassword: "app-password", imapEnabled: false });

    expect(result).toEqual({ ok: false, error: message });
    expect(createMailbox).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("updateMailboxAction — OAuth mailboxes", () => {
  it.each(["gmail", "outlook"])("editing a %s mailbox's status keeps its OAuth reply provider and connection", async (provider) => {
    vi.mocked(getMailbox).mockResolvedValue({ id: "mailbox-1", email_provider: provider } as Awaited<ReturnType<typeof getMailbox>>);

    await updateMailboxAction("mailbox-1", formInput);

    const values = updatedValues();
    expect(values).toMatchObject({ status: "active", daily_limit: 50, hourly_limit: 10, display_name: "Sender" });
    for (const fixed of ["reply_provider", "email", "smtp_host", "smtp_port", "smtp_username", "imap_enabled", "imap_host", "imap_port", "imap_username", "encrypted_smtp_password", "encrypted_imap_password"]) {
      expect(values).not.toHaveProperty(fixed);
    }
    // An OAuth mailbox never stores an IMAP password, so the manual-IMAP
    // password requirement must not block the edit.
    expect(getMailboxImapCredential).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("ignores manual credential fields sent for an OAuth mailbox", async () => {
    vi.mocked(getMailbox).mockResolvedValue({ id: "mailbox-1", email_provider: "gmail" } as Awaited<ReturnType<typeof getMailbox>>);

    await updateMailboxAction("mailbox-1", { ...formInput, smtpPassword: "typed", imapPassword: "typed" });

    expect(updatedValues()).not.toHaveProperty("encrypted_smtp_password");
    expect(updatedValues()).not.toHaveProperty("encrypted_imap_password");
  });
});

describe("updateMailboxAction — manual SMTP/IMAP mailboxes (unchanged)", () => {
  beforeEach(() => {
    vi.mocked(getMailbox).mockResolvedValue({ id: "mailbox-2", email_provider: "smtp" } as Awaited<ReturnType<typeof getMailbox>>);
  });

  const smtpInput: MailboxInput = { ...formInput, smtpHost: "smtp.example.test", imapHost: "imap.example.test" };

  it("writes the full connection with reply_provider 'imap'", async () => {
    vi.mocked(getMailboxImapCredential).mockResolvedValue({ encrypted_imap_password: "stored" });

    await updateMailboxAction("mailbox-2", smtpInput);

    expect(updatedValues()).toMatchObject({
      email: "sender@example.test",
      smtp_host: "smtp.example.test",
      smtp_port: 587,
      reply_provider: "imap",
      imap_enabled: true,
      imap_host: "imap.example.test",
      status: "active",
    });
  });

  it("still requires an IMAP password when reply tracking is on and none is stored", async () => {
    vi.mocked(getMailboxImapCredential).mockResolvedValue({ encrypted_imap_password: null });

    await expect(updateMailboxAction("mailbox-2", smtpInput)).rejects.toThrow("Enter the IMAP password to enable reply tracking.");
    expect(updateMailbox).not.toHaveBeenCalled();
  });

  it("still encrypts and audits a changed SMTP password", async () => {
    vi.mocked(getMailboxImapCredential).mockResolvedValue({ encrypted_imap_password: "stored" });

    await updateMailboxAction("mailbox-2", { ...smtpInput, smtpPassword: "new-secret" });

    expect(updatedValues()).toMatchObject({ encrypted_smtp_password: "enc(new-secret)" });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });
});
