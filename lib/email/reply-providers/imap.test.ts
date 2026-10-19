import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tables } from "@/types/database.types";

// Batch: reply content persistence. Mocks every external boundary
// ImapReplyChecker touches — the real IMAP socket (imapflow) and MIME
// parser (mailparser) — so these tests exercise only the field-extraction
// logic in imap.ts itself, same reasoning as the rest of this repo's worker
// tests mocking "@/lib/db" rather than hitting a real database.
const { imapFlowMock, simpleParserMock, decryptSmtpPasswordMock } = vi.hoisted(() => ({
  imapFlowMock: vi.fn(),
  simpleParserMock: vi.fn(),
  decryptSmtpPasswordMock: vi.fn(),
}));

vi.mock("imapflow", () => ({
  ImapFlow: imapFlowMock,
}));

vi.mock("mailparser", () => ({
  simpleParser: simpleParserMock,
}));

vi.mock("@/lib/crypto/smtp-secret", () => ({
  decryptSmtpPassword: decryptSmtpPasswordMock,
}));

import { ImapReplyChecker } from "./imap";

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

function makeImapClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    mailbox: { uidValidity: 100, uidNext: 3 },
    fetch: vi.fn().mockReturnValue([{ uid: 2, source: Buffer.from("raw mime") }]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptSmtpPasswordMock.mockReturnValue("plaintext-password");
});

describe("ImapReplyChecker.fetchNewMessages", () => {
  it("populates to/bodyText/bodyHtml/receivedAt from the already-parsed mailparser result", async () => {
    const client = makeImapClient();
    imapFlowMock.mockImplementation(function () {
      return client;
    });
    simpleParserMock.mockResolvedValue({
      messageId: "<reply-1@example.com>",
      headers: new Map(),
      attachments: [],
      inReplyTo: undefined,
      references: undefined,
      from: { value: [{ name: "Lead Name", address: "lead@example.com" }] },
      to: { value: [{ name: "Sales", address: "sales@example.com" }] },
      subject: "Re: following up",
      text: "Sounds good, let's talk.",
      html: "<p>Sounds good, let's talk.</p>",
      date: new Date("2026-09-20T10:00:00.000Z"),
    });

    const result = await new ImapReplyChecker(makeMailbox()).fetchNewMessages();

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      messageId: "reply-1@example.com",
      inReplyTo: null,
      references: [],
      from: { name: "Lead Name", email: "lead@example.com" },
      to: [{ name: "Sales", email: "sales@example.com" }],
      subject: "Re: following up",
      bodyText: "Sounds good, let's talk.",
      bodyHtml: "<p>Sounds good, let's talk.</p>",
      receivedAt: "2026-09-20T10:00:00.000Z",
      uid: 2,
      deliveryReport: null,
    });
    // Exactly one fetch call — no second round-trip for body content, since
    // { source: true } on the existing fetch already returns the full raw
    // MIME message that simpleParser parses in-memory.
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes a missing body/subject/to to null/empty rather than throwing", async () => {
    const client = makeImapClient();
    imapFlowMock.mockImplementation(function () {
      return client;
    });
    simpleParserMock.mockResolvedValue({
      messageId: "<reply-2@example.com>",
      headers: new Map(),
      attachments: [],
      inReplyTo: undefined,
      references: undefined,
      from: { value: [{ name: undefined, address: "lead@example.com" }] },
      to: undefined,
      subject: undefined,
      text: undefined,
      html: false,
      date: undefined,
    });

    const result = await new ImapReplyChecker(makeMailbox()).fetchNewMessages();

    expect(result.messages).toHaveLength(1);
    const [message] = result.messages;
    expect(message.to).toEqual([]);
    expect(message.subject).toBeNull();
    expect(message.bodyText).toBeNull();
    expect(message.bodyHtml).toBeNull();
    expect(typeof message.receivedAt).toBe("string");
  });

  it("drops a To-header entry with no address rather than throwing", async () => {
    const client = makeImapClient();
    imapFlowMock.mockImplementation(function () {
      return client;
    });
    simpleParserMock.mockResolvedValue({
      messageId: "<reply-3@example.com>",
      headers: new Map(),
      attachments: [],
      from: { value: [{ name: "Lead", address: "lead@example.com" }] },
      to: { value: [{ name: "Bad", address: undefined }] },
      subject: "No body",
      text: undefined,
      html: false,
    });

    const result = await new ImapReplyChecker(makeMailbox()).fetchNewMessages();

    expect(result.messages[0].to).toEqual([]);
  });
});

// M4: Postgres text columns reject NUL, so a NUL left in a reply would make
// it impossible to store — and fail that mailbox's sync every run.
describe("ImapReplyChecker.fetchNewMessages — delivery status notifications", () => {
  it("keeps the delivery-status part separate and attaches the parsed report", async () => {
    const client = makeImapClient();
    imapFlowMock.mockImplementation(function () {
      return client;
    });
    simpleParserMock.mockResolvedValue({
      messageId: "<ndr-1@mx.google.com>",
      headers: new Map([["content-type", { value: "multipart/report", params: { "report-type": "delivery-status" } }]]),
      attachments: [
        {
          contentType: "message/delivery-status",
          content: Buffer.from("Reporting-MTA: dns; googlemail.com\r\n\r\nFinal-Recipient: rfc822; dead@prospect.test\r\nAction: failed\r\nStatus: 5.1.1\r\n"),
        },
        { contentType: "message/rfc822", content: Buffer.from("Message-ID: <sent-1@example.com>\r\n\r\nHello") },
      ],
      from: { value: [{ name: "Mail Delivery Subsystem", address: "mailer-daemon@googlemail.com" }] },
      to: { value: [{ address: "sales@example.com" }] },
      subject: "Delivery Status Notification (Failure)",
      text: "Address not found.",
      html: false,
      date: new Date("2026-10-01T05:00:00.000Z"),
    });

    const result = await new ImapReplyChecker(makeMailbox()).fetchNewMessages();

    expect(simpleParserMock).toHaveBeenCalledWith(expect.any(Buffer), { keepDeliveryStatus: true });
    expect(result.messages[0].deliveryReport).toEqual({
      hardBouncedRecipients: ["dead@prospect.test"],
      originalMessageId: "sent-1@example.com",
    });
  });
});

describe("ImapReplyChecker.fetchNewMessages — NUL characters", () => {
  function parsedWith(fields: { subject?: string; text?: string; html?: string | false }) {
    return {
      messageId: "<reply-1@example.com>",
      headers: new Map(),
      attachments: [],
      inReplyTo: undefined,
      references: undefined,
      from: { value: [{ name: "Lead", address: "lead@example.com" }] },
      to: { value: [{ address: "sales@example.com" }] },
      date: new Date("2026-09-20T10:00:00.000Z"),
      ...fields,
    };
  }

  async function fetchOne(fields: { subject?: string; text?: string; html?: string | false }) {
    const client = makeImapClient();
    imapFlowMock.mockImplementation(function () {
      return client;
    });
    simpleParserMock.mockResolvedValue(parsedWith(fields));
    const result = await new ImapReplyChecker(makeMailbox()).fetchNewMessages();
    return result.messages[0];
  }

  it("removes NUL from the subject", async () => {
    expect((await fetchOne({ subject: "Re:\u0000 hello" })).subject).toBe("Re: hello");
  });

  it("removes NUL from the text body", async () => {
    expect((await fetchOne({ text: "hello\u0000world" })).bodyText).toBe("helloworld");
  });

  it("removes NUL from the HTML body without otherwise changing it", async () => {
    expect((await fetchOne({ html: "<p>a\u0000<b>b</b></p>" })).bodyHtml).toBe("<p>a<b>b</b></p>");
  });

  it("removes every NUL, including consecutive ones", async () => {
    expect((await fetchOne({ text: "\u0000a\u0000\u0000b\u0000" })).bodyText).toBe("ab");
  });

  it("leaves normal content, whitespace and other Unicode exactly as parsed", async () => {
    const text = "  Grüße — ok\n\tline 2 ​😀  ";
    const message = await fetchOne({ subject: "Re: Überblick", text, html: "<p>&nbsp;ok</p>" });
    expect(message.subject).toBe("Re: Überblick");
    expect(message.bodyText).toBe(text);
    expect(message.bodyHtml).toBe("<p>&nbsp;ok</p>");
  });

  it("keeps a missing subject/body as null", async () => {
    const message = await fetchOne({ html: false });
    expect(message.subject).toBeNull();
    expect(message.bodyText).toBeNull();
    expect(message.bodyHtml).toBeNull();
  });
});
