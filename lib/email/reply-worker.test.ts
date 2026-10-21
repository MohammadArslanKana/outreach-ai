import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@/lib/db/shared";
import type { Tables } from "@/types/database.types";
import type { ReplyMessage } from "./reply-provider";

// Batch: reply content persistence. Every function reply-worker.ts imports
// from "@/lib/db" must be present here (vi.mock replaces the whole module),
// same convention as lib/warmup/warmup-worker.test.ts.
const {
  claimMailboxesForReplySyncMock,
  getCampaignLeadByCampaignAndLeadMock,
  getEmailEventByProviderMessageIdMock,
  getEmailReplyByEventIdMock,
  getLeadByIdMock,
  getSentEventForOwnerMock,
  listActiveCampaignLeadsForMailboxMock,
  listLeadIdsByEmailMock,
  recordEmailEventMock,
  recordEmailReplyMock,
  releaseMailboxReplySyncLockMock,
  updateCampaignLeadMock,
  updateLeadMock,
  updateMailboxSyncCursorMock,
  getReplyProviderMock,
  captureErrorMock,
  getLatestJobRunSummaryMock,
} = vi.hoisted(() => ({
  getLatestJobRunSummaryMock: vi.fn(),
  getSentEventForOwnerMock: vi.fn(),
  claimMailboxesForReplySyncMock: vi.fn(),
  getCampaignLeadByCampaignAndLeadMock: vi.fn(),
  getEmailEventByProviderMessageIdMock: vi.fn(),
  getEmailReplyByEventIdMock: vi.fn(),
  getLeadByIdMock: vi.fn(),
  listActiveCampaignLeadsForMailboxMock: vi.fn(),
  listLeadIdsByEmailMock: vi.fn(),
  recordEmailEventMock: vi.fn(),
  recordEmailReplyMock: vi.fn(),
  releaseMailboxReplySyncLockMock: vi.fn(),
  updateCampaignLeadMock: vi.fn(),
  updateLeadMock: vi.fn(),
  updateMailboxSyncCursorMock: vi.fn(),
  getReplyProviderMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  claimMailboxesForReplySync: claimMailboxesForReplySyncMock,
  getCampaignLeadByCampaignAndLead: getCampaignLeadByCampaignAndLeadMock,
  getEmailEventByProviderMessageId: getEmailEventByProviderMessageIdMock,
  getEmailReplyByEventId: getEmailReplyByEventIdMock,
  getLatestJobRunSummary: getLatestJobRunSummaryMock,
  getLeadById: getLeadByIdMock,
  getSentEventForOwner: getSentEventForOwnerMock,
  listActiveCampaignLeadsForMailbox: listActiveCampaignLeadsForMailboxMock,
  listLeadIdsByEmail: listLeadIdsByEmailMock,
  recordEmailEvent: recordEmailEventMock,
  recordEmailReply: recordEmailReplyMock,
  releaseMailboxReplySyncLock: releaseMailboxReplySyncLockMock,
  updateCampaignLead: updateCampaignLeadMock,
  updateLead: updateLeadMock,
  updateMailboxSyncCursor: updateMailboxSyncCursorMock,
}));

vi.mock("./get-reply-provider", () => ({
  getReplyProvider: getReplyProviderMock,
}));

vi.mock("@/lib/monitoring/error-tracking", () => ({
  captureError: captureErrorMock,
}));

import { runReplySyncWorker } from "./reply-worker";

const supabaseStub = {} as unknown as Client;

function makeMailbox(overrides: Partial<Tables<"mailboxes">> = {}): Tables<"mailboxes"> {
  return {
    id: "mailbox-1",
    user_id: "user-1",
    domain_id: null,
    email: "sales@example.com",
    display_name: null,
    email_provider: "smtp",
    smtp_host: "smtp.example.com",
    smtp_port: 587,
    smtp_username: "sales@example.com",
    encrypted_smtp_password: "cipher-smtp",
    encrypted_google_refresh_token: null,
    encrypted_microsoft_refresh_token: null,
    daily_limit: 100,
    hourly_limit: 20,
    cooldown_minutes: 5,
    warmup_enabled: false,
    status: "active",
    reply_provider: "imap",
    imap_enabled: true,
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_username: "sales@example.com",
    encrypted_imap_password: "cipher-imap",
    imap_uid_validity: 100,
    imap_last_uid: 0,
    reply_sync_claimed_at: null,
    reply_sync_locked_until: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeReplyMessage(overrides: Partial<ReplyMessage> = {}): ReplyMessage {
  return {
    messageId: "reply-1@example.com",
    inReplyTo: "sent-1@example.com",
    references: ["sent-1@example.com"],
    from: { name: "Lead Name", email: "lead@example.com" },
    to: [{ name: "Sales", email: "sales@example.com" }],
    subject: "Re: following up",
    bodyText: "Sounds good, let's talk.",
    bodyHtml: "<p>Sounds good, let's talk.</p>",
    receivedAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

function makeEmailEvent(overrides: Partial<Tables<"email_events">> = {}): Tables<"email_events"> {
  return {
    id: "event-1",
    campaign_id: "campaign-1",
    lead_id: "lead-1",
    mailbox_id: "mailbox-1",
    event_type: "replied",
    provider_message_id: "reply-1@example.com",
    metadata: {},
    created_at: "2026-09-20T10:00:01.000Z",
    updated_at: "2026-09-20T10:00:01.000Z",
    ...overrides,
  };
}

function makeLead(overrides: Partial<Tables<"leads">> = {}): Tables<"leads"> {
  return {
    id: "lead-1",
    user_id: "user-1",
    list_id: null,
    email: "lead@example.com",
    first_name: null,
    last_name: null,
    company: null,
    title: null,
    phone: null,
    linkedin: null,
    website: null,
    city: null,
    country: null,
    timezone: null,
    status: "contacted",
    custom_fields: {},
    verification_status: "unknown",
    verification_detail: null,
    verification_risk_score: null,
    verification_locked_until: null,
    verified_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fetchResultWith(messages: ReplyMessage[]) {
  return { messages, cursor: { uidValidity: 100, lastUid: 5 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimMailboxesForReplySyncMock.mockResolvedValue([makeMailbox()]);
  updateMailboxSyncCursorMock.mockResolvedValue(undefined);
  releaseMailboxReplySyncLockMock.mockResolvedValue(undefined);
  recordEmailReplyMock.mockResolvedValue({ id: "persisted-reply-1" });
  updateCampaignLeadMock.mockResolvedValue(undefined);
  updateLeadMock.mockResolvedValue(undefined);
  getLeadByIdMock.mockResolvedValue(makeLead());
  getEmailReplyByEventIdMock.mockResolvedValue(null);
  getLatestJobRunSummaryMock.mockResolvedValue(null);
  // M4: header matching goes through the owner-scoped lookup. The sent
  // email "sent-1@example.com" belongs to user-1, the default mailbox's
  // owner; the database filter is mirrored by returning it only for them.
  getSentEventForOwnerMock.mockImplementation(async (_s: Client, id: string, userId: string) =>
    id === "sent-1@example.com" && userId === "user-1"
      ? makeEmailEvent({ id: "sent-event-1", event_type: "sent", provider_message_id: id })
      : null,
  );
});

describe("runReplySyncWorker — matched reply persists content", () => {
  it("persists subject/from/to/body/receivedAt alongside the matched email_events row", async () => {
    const message = makeReplyMessage();
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });

    // First call is the idempotency pre-check (by inbound messageId) — not
    // yet recorded. Second call is matchReply's header lookup (by
    // inReplyTo) — matches a prior 'sent' event.
    getEmailEventByProviderMessageIdMock.mockImplementation(
      async (_supabase: Client, id: string, eventType: string) => {
        if (eventType === "replied") return null;
        if (eventType === "sent" && id === "sent-1@example.com") {
          return makeEmailEvent({ id: "sent-event-1", event_type: "sent", provider_message_id: "sent-1@example.com" });
        }
        return null;
      },
    );
    getCampaignLeadByCampaignAndLeadMock.mockResolvedValue({ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" });
    const insertedEvent = makeEmailEvent();
    recordEmailEventMock.mockResolvedValue(insertedEvent);

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toEqual({ mailboxesChecked: 1, messagesFetched: 1, matched: 1, unmatched: 0, alreadyRecorded: 0, bounced: 0, failed: 0, mailboxesFailed: 0, failedMailboxIds: [] });
    expect(recordEmailReplyMock).toHaveBeenCalledTimes(1);
    expect(recordEmailReplyMock).toHaveBeenCalledWith(supabaseStub, {
      email_event_id: insertedEvent.id,
      campaign_id: insertedEvent.campaign_id,
      lead_id: insertedEvent.lead_id,
      mailbox_id: insertedEvent.mailbox_id,
      subject: "Re: following up",
      from_email: "lead@example.com",
      from_name: "Lead Name",
      to_emails: ["sales@example.com"],
      body_text: "Sounds good, let's talk.",
      body_html: "<p>Sounds good, let's talk.</p>",
      received_at: "2026-09-20T10:00:00.000Z",
    });
    // Existing behavior preserved: campaign_leads/leads status still flip.
    expect(updateCampaignLeadMock).toHaveBeenCalledWith(supabaseStub, "campaign-lead-1", {
      status: "replied",
      current_step_id: null,
      next_send_at: null,
    });
    expect(updateLeadMock).toHaveBeenCalledWith(supabaseStub, "user-1", "lead-1", { status: "replied" });
  });

  it("persists null body/subject/empty to-list without throwing when the message has none", async () => {
    const message = makeReplyMessage({ subject: null, bodyText: null, bodyHtml: null, to: [] });
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });
    getEmailEventByProviderMessageIdMock.mockImplementation(async (_s: Client, id: string, eventType: string) => {
      if (eventType === "replied") return null;
      if (eventType === "sent" && id === "sent-1@example.com") return makeEmailEvent({ id: "sent-event-1", event_type: "sent" });
      return null;
    });
    getCampaignLeadByCampaignAndLeadMock.mockResolvedValue({ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" });
    recordEmailEventMock.mockResolvedValue(makeEmailEvent());

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary.matched).toBe(1);
    expect(recordEmailReplyMock).toHaveBeenCalledWith(
      supabaseStub,
      expect.objectContaining({ subject: null, body_text: null, body_html: null, to_emails: [] }),
    );
  });
});

describe("runReplySyncWorker — duplicate inbound Message-ID", () => {
  it("does not call recordEmailEvent or duplicate the persisted reply when already recorded", async () => {
    const message = makeReplyMessage();
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });
    const existingEvent = makeEmailEvent();
    getEmailEventByProviderMessageIdMock.mockResolvedValue(existingEvent);
    getEmailReplyByEventIdMock.mockResolvedValue({ id: "persisted-reply-1" }); // already persisted

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toEqual({ mailboxesChecked: 1, messagesFetched: 1, matched: 0, unmatched: 0, alreadyRecorded: 1, bounced: 0, failed: 0, mailboxesFailed: 0, failedMailboxIds: [] });
    expect(recordEmailEventMock).not.toHaveBeenCalled();
    expect(recordEmailReplyMock).not.toHaveBeenCalled();
  });

  it("backfills the missing email_replies row exactly once when the event was recorded but content wasn't persisted", async () => {
    const message = makeReplyMessage();
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });
    const existingEvent = makeEmailEvent();
    getEmailEventByProviderMessageIdMock.mockResolvedValue(existingEvent);
    getEmailReplyByEventIdMock.mockResolvedValue(null); // never persisted (e.g. a prior crash)

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary.alreadyRecorded).toBe(1);
    expect(recordEmailEventMock).not.toHaveBeenCalled();
    expect(recordEmailReplyMock).toHaveBeenCalledTimes(1);
    expect(recordEmailReplyMock).toHaveBeenCalledWith(supabaseStub, expect.objectContaining({ email_event_id: existingEvent.id }));
  });

  it("on a concurrent-insert race (unique violation), backfills from the winning row without a second email_replies row", async () => {
    const message = makeReplyMessage();
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });

    getCampaignLeadByCampaignAndLeadMock.mockResolvedValue({ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" });
    const winningEvent = makeEmailEvent();

    let preCheckCalls = 0;
    getEmailEventByProviderMessageIdMock.mockImplementation(async (_s: Client, id: string, eventType: string) => {
      if (eventType === "sent" && id === "sent-1@example.com") return makeEmailEvent({ id: "sent-event-1", event_type: "sent" });
      if (eventType === "replied") {
        preCheckCalls += 1;
        // First call (pre-check): not yet visible. Second call (after the
        // unique violation below): the concurrent run's winning row.
        return preCheckCalls === 1 ? null : winningEvent;
      }
      return null;
    });

    const uniqueViolation = Object.assign(new Error("duplicate key value"), { code: "23505" });
    recordEmailEventMock.mockRejectedValue(uniqueViolation);
    getEmailReplyByEventIdMock.mockResolvedValue(null);

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toEqual({ mailboxesChecked: 1, messagesFetched: 1, matched: 0, unmatched: 0, alreadyRecorded: 1, bounced: 0, failed: 0, mailboxesFailed: 0, failedMailboxIds: [] });
    expect(recordEmailReplyMock).toHaveBeenCalledTimes(1);
    expect(recordEmailReplyMock).toHaveBeenCalledWith(supabaseStub, expect.objectContaining({ email_event_id: winningEvent.id }));
    // The losing side must never flip campaign_leads/leads itself — only
    // whichever run's insert actually won does that.
    expect(updateCampaignLeadMock).not.toHaveBeenCalled();
  });

  // M4: replaces "re-throws a non-unique-violation error from
  // recordEmailEvent" — such an error is still never treated as a duplicate,
  // but it now fails only this message (retried next sync), not the run.
  it("does not treat a non-unique-violation error as a duplicate: the message fails and is retried, the run completes", async () => {
    const message = makeReplyMessage({ uid: 7 });
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });
    getEmailEventByProviderMessageIdMock.mockResolvedValue(null);
    getCampaignLeadByCampaignAndLeadMock.mockResolvedValue({ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" });
    recordEmailEventMock.mockRejectedValue(new Error("connection reset"));

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toEqual({ mailboxesChecked: 1, messagesFetched: 1, matched: 0, unmatched: 0, alreadyRecorded: 0, bounced: 0, failed: 1, mailboxesFailed: 0, failedMailboxIds: [] });
    expect(recordEmailReplyMock).not.toHaveBeenCalled();
    expect(updateCampaignLeadMock).not.toHaveBeenCalled();
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-1", { uidValidity: 100, lastUid: 6 });
  });
});

describe("runReplySyncWorker — existing matching behavior is unchanged", () => {
  it("prefers a header match (In-Reply-To) over the address fallback", async () => {
    const message = makeReplyMessage();
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });
    getEmailEventByProviderMessageIdMock.mockImplementation(async (_s: Client, id: string, eventType: string) => {
      if (eventType === "replied") return null;
      if (eventType === "sent" && id === "sent-1@example.com") return makeEmailEvent({ id: "sent-event-1", event_type: "sent" });
      return null;
    });
    getCampaignLeadByCampaignAndLeadMock.mockResolvedValue({ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" });
    recordEmailEventMock.mockResolvedValue(makeEmailEvent());

    await runReplySyncWorker(supabaseStub);

    // Header match found — the address-fallback lookups must never run.
    expect(listLeadIdsByEmailMock).not.toHaveBeenCalled();
    expect(listActiveCampaignLeadsForMailboxMock).not.toHaveBeenCalled();
  });

  it("falls back to a from-address match only when no header match exists, and only if unambiguous", async () => {
    const message = makeReplyMessage({ inReplyTo: null, references: [] });
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });
    getEmailEventByProviderMessageIdMock.mockResolvedValue(null);
    listLeadIdsByEmailMock.mockResolvedValue(["lead-1"]);
    listActiveCampaignLeadsForMailboxMock.mockResolvedValue([{ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" }]);
    recordEmailEventMock.mockResolvedValue(makeEmailEvent());

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary.matched).toBe(1);
    expect(recordEmailEventMock).toHaveBeenCalledWith(
      supabaseStub,
      expect.objectContaining({ metadata: expect.objectContaining({ matchedVia: "address-fallback" }) }),
    );
  });

  it("never guesses: an ambiguous from-address match (2+ candidates) stays unmatched", async () => {
    const message = makeReplyMessage({ inReplyTo: null, references: [] });
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([message])) });
    getEmailEventByProviderMessageIdMock.mockResolvedValue(null);
    listLeadIdsByEmailMock.mockResolvedValue(["lead-1", "lead-2"]);
    listActiveCampaignLeadsForMailboxMock.mockResolvedValue([
      { id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" },
      { id: "campaign-lead-2", campaign_id: "campaign-2", lead_id: "lead-2" },
    ]);

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toEqual({ mailboxesChecked: 1, messagesFetched: 1, matched: 0, unmatched: 1, alreadyRecorded: 0, bounced: 0, failed: 0, mailboxesFailed: 0, failedMailboxIds: [] });
    expect(recordEmailEventMock).not.toHaveBeenCalled();
    expect(recordEmailReplyMock).not.toHaveBeenCalled();
  });
});

describe("runReplySyncWorker — mailbox lease/error isolation preserved", () => {
  it("releases the lease and continues past a mailbox whose provider fetch throws", async () => {
    const failingMailbox = makeMailbox({ id: "mailbox-failing" });
    const okMailbox = makeMailbox({ id: "mailbox-ok" });
    claimMailboxesForReplySyncMock.mockResolvedValue([failingMailbox, okMailbox]);

    getReplyProviderMock.mockImplementation((mailbox: Tables<"mailboxes">) => ({
      fetchNewMessages:
        mailbox.id === "mailbox-failing"
          ? vi.fn().mockRejectedValue(new Error("IMAP auth failed"))
          : vi.fn().mockResolvedValue(fetchResultWith([])),
    }));

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary.mailboxesChecked).toBe(2);
    expect(releaseMailboxReplySyncLockMock).toHaveBeenCalledWith(supabaseStub, "mailbox-failing");
    expect(captureErrorMock).toHaveBeenCalledWith(expect.objectContaining({ job: "sync-replies" }));
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-ok", expect.anything());
  });
});

// Mailbox-level failures are counted (so the route can mark the run
// degraded) and alerted once per failing streak, not every run.
describe("runReplySyncWorker — mailbox failure counting and alert deduplication", () => {
  class FakeOAuthError extends Error {
    constructor(
      message: string,
      public readonly outcome: string,
    ) {
      super(message);
      this.name = "GoogleOAuthError";
    }
  }

  function failMailbox(id: string, error: unknown = new FakeOAuthError("Bad Request", "invalid_grant")) {
    getReplyProviderMock.mockImplementation((mailbox: Tables<"mailboxes">) => ({
      fetchNewMessages:
        mailbox.id === id ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(fetchResultWith([])),
    }));
  }

  beforeEach(() => {
    claimMailboxesForReplySyncMock.mockResolvedValue([
      makeMailbox({ id: "mailbox-failing" }),
      makeMailbox({ id: "mailbox-ok" }),
    ]);
  });

  it("counts the failed mailbox and still syncs the others", async () => {
    failMailbox("mailbox-failing");

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toMatchObject({ mailboxesChecked: 2, mailboxesFailed: 1, failedMailboxIds: ["mailbox-failing"], failed: 0 });
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-ok", expect.anything());
    expect(releaseMailboxReplySyncLockMock).toHaveBeenCalledWith(supabaseStub, "mailbox-failing");
  });

  it("alerts once with the error class and outcome when a mailbox starts failing", async () => {
    getLatestJobRunSummaryMock.mockResolvedValue({ mailboxesFailed: 0, failedMailboxIds: [] });
    failMailbox("mailbox-failing");

    await runReplySyncWorker(supabaseStub);

    expect(getLatestJobRunSummaryMock).toHaveBeenCalledWith(supabaseStub, "sync-replies");
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith({
      job: "sync-replies",
      message: "Bad Request",
      context: { mailboxId: "mailbox-failing", errorClass: "GoogleOAuthError", outcome: "invalid_grant" },
    });
  });

  it("doesn't alert again while the same mailbox keeps failing, but still counts it", async () => {
    getLatestJobRunSummaryMock.mockResolvedValue({ mailboxesFailed: 1, failedMailboxIds: ["mailbox-failing"] });
    failMailbox("mailbox-failing");

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toMatchObject({ mailboxesFailed: 1, failedMailboxIds: ["mailbox-failing"] });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("alerts once when a previously failing mailbox syncs again", async () => {
    getLatestJobRunSummaryMock.mockResolvedValue({ mailboxesFailed: 1, failedMailboxIds: ["mailbox-failing"] });
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([])) });

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toMatchObject({ mailboxesFailed: 0, failedMailboxIds: [] });
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith({
      job: "sync-replies",
      message: "Mailbox reply sync recovered — it synced successfully again.",
      context: { mailboxId: "mailbox-failing" },
    });
  });

  it("still alerts when the previous run's failures can't be read", async () => {
    getLatestJobRunSummaryMock.mockRejectedValue(new Error("db unavailable"));
    failMailbox("mailbox-failing", new Error("IMAP auth failed"));

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary.mailboxesFailed).toBe(1);
    expect(captureErrorMock).toHaveBeenCalledWith({
      job: "sync-replies",
      message: "IMAP auth failed",
      context: { mailboxId: "mailbox-failing", errorClass: "Error" },
    });
  });
});

// M4: header matching is scoped to the mailbox owner. A header naming
// another user's email is simply unmatched — it never reaches
// recordEmailEvent, where the owner trigger would reject it and stall sync.
describe("runReplySyncWorker — header matching is scoped to the mailbox owner", () => {
  function sentEventOwnedBy(owner: string) {
    getSentEventForOwnerMock.mockImplementation(async (_s: Client, id: string, userId: string) =>
      id === "sent-1@example.com" && userId === owner
        ? makeEmailEvent({ id: "sent-event-1", event_type: "sent", provider_message_id: id })
        : null,
    );
  }

  beforeEach(() => {
    getEmailEventByProviderMessageIdMock.mockResolvedValue(null);
    getCampaignLeadByCampaignAndLeadMock.mockResolvedValue({ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" });
    recordEmailEventMock.mockResolvedValue(makeEmailEvent());
    listLeadIdsByEmailMock.mockResolvedValue([]);
  });

  it.each([
    ["In-Reply-To", { inReplyTo: "sent-1@example.com", references: [] }],
    ["References", { inReplyTo: null, references: ["other@example.com", "sent-1@example.com"] }],
  ])("matches a same-owner %s header", async (_label, headers) => {
    sentEventOwnedBy("user-1");
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([makeReplyMessage(headers)])),
    });

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary.matched).toBe(1);
    expect(getSentEventForOwnerMock).toHaveBeenCalledWith(supabaseStub, "sent-1@example.com", "user-1");
    expect(recordEmailEventMock).toHaveBeenCalledWith(
      supabaseStub,
      expect.objectContaining({ mailbox_id: "mailbox-1", metadata: expect.objectContaining({ matchedVia: "header" }) }),
    );
  });

  it.each([
    ["In-Reply-To", { inReplyTo: "sent-1@example.com", references: [] }],
    ["References", { inReplyTo: null, references: ["sent-1@example.com"] }],
  ])("treats a cross-owner %s header as unmatched, with no event inserted and no failure", async (_label, headers) => {
    // The sent email is user-2's; the mailbox being synced is user-1's.
    sentEventOwnedBy("user-2");
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([makeReplyMessage(headers)])),
    });

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toEqual({ mailboxesChecked: 1, messagesFetched: 1, matched: 0, unmatched: 1, alreadyRecorded: 0, bounced: 0, failed: 0, mailboxesFailed: 0, failedMailboxIds: [] });
    expect(getSentEventForOwnerMock).toHaveBeenCalledWith(supabaseStub, "sent-1@example.com", "user-1");
    expect(recordEmailEventMock).not.toHaveBeenCalled();
    expect(recordEmailReplyMock).not.toHaveBeenCalled();
    expect(updateCampaignLeadMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-1", { uidValidity: 100, lastUid: 5 });
  });
});

// M4: a failure is contained to its mailbox, and a failing message stops
// that mailbox's cursor just before it instead of being skipped.
describe("runReplySyncWorker — failure isolation and cursor preservation", () => {
  const DB_ERROR = { message: "invalid byte sequence for encoding UTF8", details: "row data", code: "22021" };

  function message(uid: number, overrides: Partial<ReplyMessage> = {}) {
    return makeReplyMessage({ uid, messageId: `reply-${uid}@example.com`, ...overrides });
  }

  function insertedMessageIds(): string[] {
    return recordEmailEventMock.mock.calls.map(([, row]) => (row as { provider_message_id: string }).provider_message_id);
  }

  beforeEach(() => {
    getEmailEventByProviderMessageIdMock.mockResolvedValue(null);
    getCampaignLeadByCampaignAndLeadMock.mockResolvedValue({ id: "campaign-lead-1", campaign_id: "campaign-1", lead_id: "lead-1" });
    recordEmailEventMock.mockImplementation(async (_s: Client, row: { provider_message_id: string }) => {
      if (row.provider_message_id === "reply-103@example.com") throw DB_ERROR;
      return makeEmailEvent({ id: `event-${row.provider_message_id}`, provider_message_id: row.provider_message_id });
    });
  });

  it("101 and 102 succeed, 103 fails, 104 is untouched — the cursor stops at 102 and 103 is retried next run", async () => {
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue({
        messages: [message(101), message(102), message(103), message(104)],
        cursor: { uidValidity: 100, lastUid: 104 },
      }),
    });

    const first = await runReplySyncWorker(supabaseStub);

    expect(insertedMessageIds()).toEqual(["reply-101@example.com", "reply-102@example.com", "reply-103@example.com"]);
    expect(first).toEqual({ mailboxesChecked: 1, messagesFetched: 4, matched: 2, unmatched: 0, alreadyRecorded: 0, bounced: 0, failed: 1, mailboxesFailed: 0, failedMailboxIds: [] });
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledTimes(1);
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-1", { uidValidity: 100, lastUid: 102 });

    // Next run: the provider fetches from 103 again, and this time it works.
    vi.clearAllMocks();
    claimMailboxesForReplySyncMock.mockResolvedValue([makeMailbox({ imap_last_uid: 102 })]);
    recordEmailEventMock.mockImplementation(async (_s: Client, row: { provider_message_id: string }) =>
      makeEmailEvent({ id: `event-${row.provider_message_id}`, provider_message_id: row.provider_message_id }),
    );
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue({ messages: [message(103), message(104)], cursor: { uidValidity: 100, lastUid: 104 } }),
    });

    const second = await runReplySyncWorker(supabaseStub);

    expect(insertedMessageIds()).toEqual(["reply-103@example.com", "reply-104@example.com"]);
    expect(second).toMatchObject({ matched: 2, failed: 0 });
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-1", { uidValidity: 100, lastUid: 104 });
  });

  it("processes messages in UID order even if the provider returns them out of order", async () => {
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue({
        messages: [message(104), message(101), message(103), message(102)],
        cursor: { uidValidity: 100, lastUid: 104 },
      }),
    });

    await runReplySyncWorker(supabaseStub);

    expect(insertedMessageIds()).toEqual(["reply-101@example.com", "reply-102@example.com", "reply-103@example.com"]);
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-1", { uidValidity: 100, lastUid: 102 });
  });

  it("alerts once with the mailbox, UID, Message-ID and real error — never the message content", async () => {
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue({ messages: [message(103)], cursor: { uidValidity: 100, lastUid: 103 } }),
    });

    await runReplySyncWorker(supabaseStub);

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const alert = captureErrorMock.mock.calls[0][0];
    expect(alert).toEqual({
      job: "sync-replies",
      message: "A reply couldn't be processed — the mailbox's sync stops before it and retries next run: invalid byte sequence for encoding UTF8",
      context: { mailboxId: "mailbox-1", uid: 103, messageId: "reply-103@example.com" },
    });
    expect(JSON.stringify(alert)).not.toContain("Sounds good");
    expect(JSON.stringify(alert)).not.toContain("row data");
  });

  it("one mailbox failing never stops the next: its cursor is held, its lease released, the other syncs normally", async () => {
    claimMailboxesForReplySyncMock.mockResolvedValue([makeMailbox({ id: "mailbox-a" }), makeMailbox({ id: "mailbox-b" })]);
    getReplyProviderMock.mockImplementation((mailbox: Tables<"mailboxes">) => ({
      fetchNewMessages: vi.fn().mockResolvedValue(
        mailbox.id === "mailbox-a"
          ? { messages: [message(103)], cursor: { uidValidity: 100, lastUid: 103 } }
          : { messages: [message(201)], cursor: { uidValidity: 100, lastUid: 201 } },
      ),
    }));

    const summary = await runReplySyncWorker(supabaseStub);

    // A message-level failure isn't a mailbox failure — the mailbox itself synced.
    expect(summary).toEqual({
      mailboxesChecked: 2,
      messagesFetched: 2,
      matched: 1,
      unmatched: 0,
      alreadyRecorded: 0,
      bounced: 0,
      failed: 1,
      mailboxesFailed: 0,
      failedMailboxIds: [],
    });
    // updateMailboxSyncCursor also clears the mailbox's lease (reply_sync_locked_until).
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-a", { uidValidity: 100, lastUid: 102 });
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-b", { uidValidity: 100, lastUid: 201 });
  });

  it("without a UID to stop at, leaves the cursor where it was and just releases the lease", async () => {
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([makeReplyMessage({ messageId: "reply-103@example.com" })])),
    });

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary.failed).toBe(1);
    expect(updateMailboxSyncCursorMock).not.toHaveBeenCalled();
    expect(releaseMailboxReplySyncLockMock).toHaveBeenCalledWith(supabaseStub, "mailbox-1");
  });

  it("a failed cursor save is alerted, releases the lease, and doesn't stop the next mailbox", async () => {
    claimMailboxesForReplySyncMock.mockResolvedValue([makeMailbox({ id: "mailbox-a" }), makeMailbox({ id: "mailbox-b" })]);
    getReplyProviderMock.mockReturnValue({ fetchNewMessages: vi.fn().mockResolvedValue(fetchResultWith([])) });
    updateMailboxSyncCursorMock.mockImplementation(async (_s: Client, id: string) => {
      if (id === "mailbox-a") throw DB_ERROR;
    });

    await expect(runReplySyncWorker(supabaseStub)).resolves.toMatchObject({
      mailboxesChecked: 2,
      mailboxesFailed: 1,
      failedMailboxIds: ["mailbox-a"],
    });

    expect(releaseMailboxReplySyncLockMock).toHaveBeenCalledWith(supabaseStub, "mailbox-a");
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-b", { uidValidity: 100, lastUid: 5 });
    expect(captureErrorMock).toHaveBeenCalledWith({
      job: "sync-replies",
      message: "Could not save reply-sync progress for a mailbox: invalid byte sequence for encoding UTF8",
      context: { mailboxId: "mailbox-a", errorClass: "object" },
    });
  });

  it("a duplicate (already-recorded) message stays idempotent and doesn't count as a failure", async () => {
    getEmailEventByProviderMessageIdMock.mockResolvedValue(makeEmailEvent({ provider_message_id: "reply-101@example.com" }));
    getEmailReplyByEventIdMock.mockResolvedValue({ id: "persisted-reply-1" });
    getReplyProviderMock.mockReturnValue({
      fetchNewMessages: vi.fn().mockResolvedValue({ messages: [message(101)], cursor: { uidValidity: 100, lastUid: 101 } }),
    });

    const summary = await runReplySyncWorker(supabaseStub);

    expect(summary).toMatchObject({ alreadyRecorded: 1, failed: 0 });
    expect(recordEmailEventMock).not.toHaveBeenCalled();
    expect(recordEmailReplyMock).not.toHaveBeenCalled();
    expect(updateMailboxSyncCursorMock).toHaveBeenCalledWith(supabaseStub, "mailbox-1", { uidValidity: 100, lastUid: 101 });
  });
});
