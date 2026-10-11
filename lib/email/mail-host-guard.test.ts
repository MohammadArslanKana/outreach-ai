import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tables } from "@/types/database.types";

const lookup = vi.fn();
vi.mock("dns/promises", () => ({ lookup: (...args: unknown[]) => lookup(...args) }));
vi.mock("@/lib/crypto/smtp-secret", () => ({ decryptSmtpPassword: () => "decrypted-password" }));

const createTransport = vi.fn();
vi.mock("nodemailer", () => ({ default: { createTransport: (...args: unknown[]) => createTransport(...args) } }));
const imapFlowMock = vi.fn();
vi.mock("imapflow", () => ({
  ImapFlow: function (...args: unknown[]) {
    return imapFlowMock(...args);
  },
}));

import { EmailSendError } from "./provider";
import { assertPublicMailHost, isBlockedAddress, MAIL_HOST_NOT_ALLOWED_MESSAGE, MailHostNotAllowedError } from "./mail-host-guard";
import { SmtpEmailProvider, verifySmtpConnection } from "./providers/smtp";
import { ImapReplyChecker } from "./reply-providers/imap";

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockResolvedValue([{ address: "203.0.114.10", family: 4 }]);
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "203.0.114.10", "2a00:1450:4001:80e::200e"])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("assertPublicMailHost", () => {
  it.each([
    "localhost",
    "localhost.",
    "mail.localhost",
    "127.0.0.1",
    "[::1]",
    "169.254.169.254",
    " ",
    // Alternate IPv4 spellings glibc resolves to an address
    "2130706433",
    "127.1",
    "0x7f000001",
    "0177.0.0.1",
    "0x7f.0.0.1",
    // IPv4-compatible / -mapped IPv6
    "::7f00:1",
    "::ffff:7f00:1",
    "[::ffff:169.254.169.254]",
  ])(
    "rejects %s without a DNS lookup",
    async (host) => {
      await expect(assertPublicMailHost(host)).rejects.toBeInstanceOf(MailHostNotAllowedError);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("rejects a name that resolves to a private address", async () => {
    lookup.mockResolvedValue([
      { address: "203.0.114.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    await expect(assertPublicMailHost("internal.attacker.example")).rejects.toThrow(MAIL_HOST_NOT_ALLOWED_MESSAGE);
  });

  it("allows a name that resolves only to public addresses", async () => {
    await expect(assertPublicMailHost("smtp.hostinger.com")).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("smtp.hostinger.com", { all: true, verbatim: true });
  });

  it("leaves an unresolvable name for the connection attempt to report", async () => {
    lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));

    await expect(assertPublicMailHost("no-such-host.example")).resolves.toBeUndefined();
  });
});

function makeMailbox(overrides: Partial<Tables<"mailboxes">> = {}): Tables<"mailboxes"> {
  return {
    email: "sender@example.com",
    email_provider: "smtp",
    reply_provider: "imap",
    smtp_host: "127.0.0.1",
    smtp_port: 587,
    smtp_username: "sender@example.com",
    encrypted_smtp_password: "encrypted",
    imap_host: "10.0.0.5",
    imap_port: 993,
    imap_username: "sender@example.com",
    encrypted_imap_password: "encrypted",
    ...overrides,
  } as Tables<"mailboxes">;
}

describe("manual SMTP/IMAP mailboxes", () => {
  it("never opens an SMTP connection to a blocked host, and fails the send as a mailbox problem", async () => {
    const send = new SmtpEmailProvider(makeMailbox()).send({
      from: { email: "sender@example.com" },
      to: { email: "lead@example.com" },
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    await expect(send).rejects.toBeInstanceOf(EmailSendError);
    await expect(send).rejects.toMatchObject({ outcome: "failed", mailboxIssue: true, message: MAIL_HOST_NOT_ALLOWED_MESSAGE });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("rejects a blocked host in the connection test before connecting", async () => {
    await expect(verifySmtpConnection(makeMailbox({ smtp_host: "169.254.169.254" }))).rejects.toThrow(
      MAIL_HOST_NOT_ALLOWED_MESSAGE,
    );
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("never opens an IMAP connection to a blocked host", async () => {
    await expect(new ImapReplyChecker(makeMailbox()).fetchNewMessages()).rejects.toThrow(MAIL_HOST_NOT_ALLOWED_MESSAGE);
    expect(imapFlowMock).not.toHaveBeenCalled();
  });

  it("still connects to a public SMTP host", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@example.com>" });
    createTransport.mockReturnValue({ sendMail });

    await new SmtpEmailProvider(makeMailbox({ smtp_host: "smtp.hostinger.com" })).send({
      from: { email: "sender@example.com" },
      to: { email: "lead@example.com" },
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.hostinger.com", port: 587 }));
    expect(sendMail).toHaveBeenCalledOnce();
  });
});
