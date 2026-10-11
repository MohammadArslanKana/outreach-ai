import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AddressObject, SimpleParserOptions } from "mailparser";

import { decryptSmtpPassword } from "@/lib/crypto/smtp-secret";
import { assertPublicMailHost } from "@/lib/email/mail-host-guard";
import { refreshGoogleAccessToken } from "@/lib/email/google-oauth";
import { GMAIL_IMAP_HOST, GMAIL_IMAP_PORT } from "@/lib/email/google-constants";
import { refreshMicrosoftAccessToken } from "@/lib/email/microsoft-oauth";
import { OUTLOOK_IMAP_HOST, OUTLOOK_IMAP_PORT } from "@/lib/email/microsoft-constants";
import { normalizeMessageId } from "@/lib/email/message-id";
import { parseDeliveryReport } from "@/lib/email/delivery-report";
import type { Tables } from "@/types/database.types";
import type { FetchResult, ReplyMessage, ReplyProvider, SyncCursor } from "../reply-provider";

type Mailbox = Tables<"mailboxes">;

// ImapFlow's own defaults are generous (90s connect / 16s greeting / 5min
// socket) — fine in isolation, but a single unreachable/hung mailbox would
// otherwise block reply-worker.ts's sequential per-mailbox loop for minutes
// with no upper bound, the same problem SMTP had before E4
// (lib/email/providers/smtp.ts's SMTP_TIMEOUTS). Mirrors those values here.
const IMAP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
};

// keepDeliveryStatus makes mailparser return a bounce notice's
// message/delivery-status part as its own part (parseDeliveryReport reads it)
// instead of merging it into the text body. It only affects that part type.
// mailparser supports the option, but @types/mailparser doesn't declare it.
const PARSER_OPTIONS: SimpleParserOptions & { keepDeliveryStatus: boolean } = { keepDeliveryStatus: true };

// ImapFlow surfaces every connect/greeting/socket timeout with an internal
// `code` ("CONNECT_TIMEOUT" / "GREETING_TIMEOUT" / "ETIMEOUT") and a message
// that means nothing to an end user — replace it with one clear message,
// mirroring smtp.ts's friendlySmtpTimeoutMessage.
const IMAP_TIMEOUT_CODES = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "ETIMEOUT", "UPGRADE_TIMEOUT"]);

function friendlyImapTimeoutMessage(error: unknown): string | null {
  const err = error as { code?: string };
  if (err?.code && IMAP_TIMEOUT_CODES.has(err.code)) {
    return "Couldn't reach the mail server in time. Check the host and port, then try again.";
  }
  return null;
}

function normalizeReferences(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(/\s+/);
  return list.map((id) => normalizeMessageId(id)).filter((id): id is string => id !== null);
}

// Postgres text columns reject the NUL character, which a malformed inbound
// message can carry — left in, the reply could never be stored and would
// fail every sync. Only NULs are removed; everything else is kept as-is.
function stripNul(value: string | null): string | null {
  return value === null ? null : value.replaceAll("\u0000", "");
}

// Mirrors the existing single-address `from` handling below, generalized to
// a list — mailparser's `to` can be one AddressObject or several (a group
// header), each carrying its own `value` array of individual addresses.
function normalizeAddressList(raw: AddressObject | AddressObject[] | undefined): { name?: string; email: string }[] {
  if (!raw) return [];
  const addressObjects = Array.isArray(raw) ? raw : [raw];
  return addressObjects.flatMap((addressObject) =>
    addressObject.value
      .filter((entry) => Boolean(entry.address))
      .map((entry) => ({ name: entry.name || undefined, email: entry.address! })),
  );
}

// The only IMAP/MIME-specific code in the codebase — everything it returns
// is already translated into the provider-agnostic ReplyMessage shape (see
// ../reply-provider.ts). No IMAP type or field crosses out of this file.
// Reuses lib/crypto/smtp-secret.ts as-is for the IMAP password: the
// functions are generic AES-256-GCM string encryption despite the name,
// nothing SMTP-specific inside.
//
// A Gmail- or Outlook-connected mailbox (reply_provider = 'gmail'/'outlook',
// see the gmail_oauth/microsoft_oauth migrations) authenticates the same
// real IMAP connection with a fresh OAuth2 access token instead of a
// password — see resolveImapConnection below. runReplySyncWorker() already
// treats any thrown error as "skip this mailbox for this run"
// (lib/email/reply-worker.ts), so a refresh failure here needs no special
// classification, unlike the send path.
async function resolveImapConnection(mailbox: Mailbox) {
  if (mailbox.reply_provider === "gmail") {
    if (!mailbox.encrypted_google_refresh_token) {
      throw new Error("This mailbox's Google connection is missing — reconnect it in Settings.");
    }
    const refreshToken = decryptSmtpPassword(mailbox.encrypted_google_refresh_token);
    const accessToken = await refreshGoogleAccessToken(refreshToken);
    return { host: GMAIL_IMAP_HOST, port: GMAIL_IMAP_PORT, secure: true, auth: { user: mailbox.email, accessToken } };
  }

  if (mailbox.reply_provider === "outlook") {
    if (!mailbox.encrypted_microsoft_refresh_token) {
      throw new Error("This mailbox's Microsoft connection is missing — reconnect it in Settings.");
    }
    const refreshToken = decryptSmtpPassword(mailbox.encrypted_microsoft_refresh_token);
    const accessToken = await refreshMicrosoftAccessToken(refreshToken);
    return {
      host: OUTLOOK_IMAP_HOST,
      port: OUTLOOK_IMAP_PORT,
      secure: true,
      auth: { user: mailbox.email, accessToken },
    };
  }

  // Only this branch connects to a user-supplied host — see mail-host-guard.ts.
  await assertPublicMailHost(mailbox.imap_host ?? "");
  const password = decryptSmtpPassword(mailbox.encrypted_imap_password ?? "");
  return {
    host: mailbox.imap_host ?? "",
    port: mailbox.imap_port,
    secure: true,
    auth: { user: mailbox.imap_username ?? "", pass: password },
  };
}

export class ImapReplyChecker implements ReplyProvider {
  constructor(private readonly mailbox: Mailbox) {}

  async fetchNewMessages(): Promise<FetchResult> {
    const connection = await resolveImapConnection(this.mailbox);

    const client = new ImapFlow({ ...connection, ...IMAP_TIMEOUTS, logger: false });

    try {
      await client.connect();
      return await this.syncInbox(client);
    } catch (error) {
      const friendlyMessage = friendlyImapTimeoutMessage(error);
      if (friendlyMessage) throw new Error(friendlyMessage);
      throw error;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async syncInbox(client: ImapFlow): Promise<FetchResult> {
    const lock = await client.getMailboxLock("INBOX");
    try {
      if (!client.mailbox) {
        throw new Error("IMAP server did not report mailbox status after selecting INBOX.");
      }

      const currentUidValidity = Number(client.mailbox.uidValidity);
      const highestUid = client.mailbox.uidNext - 1;

      const neverSynced = this.mailbox.imap_last_uid === null || this.mailbox.imap_uid_validity === null;
      const uidValidityChanged = !neverSynced && this.mailbox.imap_uid_validity !== currentUidValidity;

      if (neverSynced || uidValidityChanged) {
        // First sync, or the folder's UIDVALIDITY changed underneath us
        // (e.g. a provider-side mailbox rebuild) — start watching from now,
        // never scan history. See the plan's "first-sync scope" risk note.
        const cursor: SyncCursor = { uidValidity: currentUidValidity, lastUid: Math.max(highestUid, 0) };
        return { messages: [], cursor };
      }

      const fromUid = this.mailbox.imap_last_uid! + 1;
      if (fromUid > highestUid) {
        return { messages: [], cursor: { uidValidity: currentUidValidity, lastUid: highestUid } };
      }

      const messages: ReplyMessage[] = [];
      let sawUid = highestUid;

      for await (const message of client.fetch(`${fromUid}:*`, { uid: true, source: true }, { uid: true })) {
        if (message.uid) sawUid = Math.max(sawUid, message.uid);
        if (!message.source) continue;

        const parsed = await simpleParser(message.source, PARSER_OPTIONS);
        const messageId = normalizeMessageId(parsed.messageId);
        if (!messageId) continue; // no Message-ID — skip, never synthesize one

        const fromAddress = Array.isArray(parsed.from) ? parsed.from[0]?.value?.[0] : parsed.from?.value?.[0];
        if (!fromAddress?.address) continue;

        messages.push({
          messageId,
          inReplyTo: normalizeMessageId(parsed.inReplyTo),
          references: normalizeReferences(parsed.references),
          from: { name: fromAddress.name || undefined, email: fromAddress.address },
          to: normalizeAddressList(parsed.to),
          subject: stripNul(parsed.subject ?? null),
          bodyText: stripNul(parsed.text ?? null),
          bodyHtml: stripNul(parsed.html || null),
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          uid: message.uid,
          deliveryReport: parseDeliveryReport({
            contentType: parsed.headers.get("content-type"),
            parts: parsed.attachments,
          }),
        });
      }

      return { messages, cursor: { uidValidity: currentUidValidity, lastUid: sawUid } };
    } finally {
      lock.release();
    }
  }
}
