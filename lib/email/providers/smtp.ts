import nodemailer from "nodemailer";

import { decryptSmtpPassword } from "@/lib/crypto/smtp-secret";
import { GoogleOAuthError, refreshGoogleAccessToken } from "@/lib/email/google-oauth";
import { GMAIL_SMTP_HOST, GMAIL_SMTP_PORT } from "@/lib/email/google-constants";
import { MicrosoftOAuthError, refreshMicrosoftAccessToken } from "@/lib/email/microsoft-oauth";
import { OUTLOOK_SMTP_HOST, OUTLOOK_SMTP_PORT } from "@/lib/email/microsoft-constants";
import { normalizeMessageId } from "@/lib/email/message-id";
import { assertPublicMailHost, MailHostNotAllowedError } from "@/lib/email/mail-host-guard";
import type { Tables } from "@/types/database.types";
import { EmailSendError, type EmailProvider, type OutboundEmailMessage, type SendResult } from "../provider";

// Typed as the full row (not MailboxSafe) so this can only be constructed
// with a mailbox fetched via getMailboxCredentials() — the type system
// enforces that the caller couldn't have obtained this from a user-facing
// read path, since MailboxSafe omits encrypted_smtp_password entirely.
type Mailbox = Tables<"mailboxes">;

function formatAddress(address: { name?: string; email: string }): string {
  return address.name ? `"${address.name}" <${address.email}>` : address.email;
}

// A "bounced" classification permanently suppresses the address across every
// campaign the user runs, so it's reserved for a 5xx that unambiguously blames
// the recipient address itself. Every other 5xx is "failed" — including ones
// that share 550/553/554 with real bounces (quota, relay, auth, DMARC, spam
// policy, SendAsDenied), since those codes are reused by servers for almost
// any permanent rejection. Two signals must agree:
//   1. The rejection happened at RCPT TO. A 5xx at AUTH / MAIL FROM / DATA is
//      about the sender, the connection, or the content, never the address.
//   2. The RFC 3463 enhanced status code (e.g. "5.1.1", carried inside the
//      server's response line — nodemailer doesn't parse it) is an address
//      failure. Only when the server sent no enhanced code at all do we fall
//      back to the reply code plus unambiguous "no such user" wording —
//      and only if the response doesn't mention the sender, since Postfix
//      and Exim run sender checks at RCPT TO too ("Sender address rejected:
//      User unknown", "Sender verify failed"). "mailbox unavailable" is
//      deliberately not enough: it's RFC 5321's default text for any 550,
//      including policy blocks.
// Also the hard-bounce definition for asynchronous bounces (delivery status
// notifications), see lib/email/delivery-report.ts.
export const RECIPIENT_BOUNCE_ENHANCED_CODES = new Set(["5.1.1", "5.1.2", "5.1.3", "5.1.6", "5.1.10", "5.2.1"]);
const RECIPIENT_BOUNCE_FALLBACK_CODES = new Set([550, 551, 553]);
const RECIPIENT_BOUNCE_TEXT_PATTERN = /user unknown|no such user|does not exist|recipient not found|invalid recipient/i;
const SENDER_WORDING_PATTERN = /sender|from address|from:|mail from|sending address/i;
// Only the code directly after the reply code, optionally "#"-prefixed (an
// older Exchange style) — never a code quoted later in the text.
const ENHANCED_STATUS_PATTERN = /^\d{3}[ -]#?([245]\.\d{1,3}\.\d{1,3})(?!\.?\d)/;

function parseEnhancedStatusCode(response: unknown): string | null {
  if (typeof response !== "string") return null;
  return response.trim().match(ENHANCED_STATUS_PATTERN)?.[1] ?? null;
}

function isRecipientBounce(err: { responseCode: number; command?: string; response?: string }): boolean {
  if (err.command !== "RCPT TO") return false;

  const enhancedCode = parseEnhancedStatusCode(err.response);
  if (enhancedCode) return RECIPIENT_BOUNCE_ENHANCED_CODES.has(enhancedCode);

  const response = err.response ?? "";
  return (
    RECIPIENT_BOUNCE_FALLBACK_CODES.has(err.responseCode) &&
    RECIPIENT_BOUNCE_TEXT_PATTERN.test(response) &&
    !SENDER_WORDING_PATTERN.test(response)
  );
}

// Nodemailer's own defaults are generous (2min connect / 30s greeting /
// 10min socket) — fine in isolation, but a single unreachable/hung mailbox
// would otherwise block send-worker.ts for minutes per email with no upper
// bound, and leave the mailbox form's "Test connection" button spinning far
// past its own 10s Promise.race (see TEST_CONNECTION_TIMEOUT_MS in
// app/(app)/mailboxes/actions.ts). Bounding all three here, at the one spot
// both send() and verifySmtpConnection() build their transport, keeps both
// paths predictable without touching either caller (E4).
const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
};

// Nodemailer surfaces every connect/greeting/socket timeout as `code:
// "ETIMEDOUT"` with an internal message ("Connection timeout" / "Greeting
// never received" / "Timeout") that means nothing to an end user — replace
// it with one clear message before it reaches classifySmtpError below or
// verifySmtpConnection()'s plain throw.
function friendlySmtpTimeoutMessage(error: unknown): string | null {
  const err = error as { code?: string };
  if (err?.code === "ETIMEDOUT") {
    return "Couldn't reach the mail server in time. Check the host and port, then try again.";
  }
  return null;
}

// A 5xx at AUTH (nodemailer's command is "AUTH PLAIN", "AUTH LOGIN", …) is
// the server rejecting this mailbox's credentials; a 5xx at MAIL FROM, whose
// only argument is our own sender address, is the server refusing this
// sender/account (not owned, blocked, over quota). Neither can be about the
// recipient or the content, and neither clears up on retry — except 552 at
// MAIL FROM, which answers the SIZE parameter, i.e. this one message.
//
// RCPT TO and DATA rejections mix recipient-side and content policy with
// sender problems, so they stay lead-level unless the response itself names
// the sender as the problem — a failure that would repeat for every lead this
// mailbox sends to (left lead-level, each one permanently fails a lead):
//   - an RFC 7372 sender-authentication status (SPF 5.7.23/5.7.24, reverse
//     DNS 5.7.25, DMARC/multiple checks 5.7.26, null-MX sender 5.7.27);
//   - wording that only describes the sending account: Microsoft's
//     SendAsDenied and OutboundSpamException, relaying denied for this
//     login, an unverified sending address, or the sender address/domain
//     rejected.
// Only reached after isRecipientBounce, so a recipient bounce stays one.
// General "spam policy" or "access denied" rejections stay lead-level: they
// don't say whether the sender, the recipient or the content was refused.
const SENDER_AUTHENTICATION_ENHANCED_CODES = new Set(["5.7.23", "5.7.24", "5.7.25", "5.7.26", "5.7.27"]);
const SENDER_REJECTION_TEXT_PATTERN =
  /\bSendAsDenied\b|\bOutboundSpamException\b|\brelay(?:ing)?(?: access)? (?:denied|not permitted)\b|\bemail address is not verified\b|\bsender (?:address |domain )?(?:rejected|invalid|does not exist|verify failed)\b/i;

function isMailboxRejection(responseCode: number, command: string | undefined, response: string | undefined): boolean {
  if (command?.startsWith("AUTH")) return true;
  if (command === "MAIL FROM") return responseCode !== 552;
  if (command !== "RCPT TO" && command !== "DATA") return false;

  const enhancedCode = parseEnhancedStatusCode(response);
  if (enhancedCode && SENDER_AUTHENTICATION_ENHANCED_CODES.has(enhancedCode)) return true;
  return SENDER_REJECTION_TEXT_PATTERN.test(response ?? "");
}

// OAuth refresh failures in the EmailSendError shape: a transient token
// endpoint failure stays "retry"; invalid_grant (the provider revoked or
// expired the refresh token) is a mailboxIssue — only reconnecting fixes it.
// Any other terminal token-endpoint failure is "failed" without it.
function oauthRefreshError(error: GoogleOAuthError | MicrosoftOAuthError): EmailSendError {
  if (error.outcome === "retry") return new EmailSendError(error.message, "retry");
  return new EmailSendError(error.message, "failed", error.outcome === "invalid_grant");
}

// Classifies a thrown nodemailer/SMTP error into retry / bounced / failed —
// see EmailSendError in ../provider.ts for what each means. Connection-level
// failures and SMTP 4xx are transient ("retry"); SMTP 5xx splits into a
// clear recipient-address rejection ("bounced", see isRecipientBounce above)
// or any other permanent failure ("failed"). An error shape we don't
// recognize defaults to "retry" rather than silently treating it as terminal.
// Exported for tests only.
export function classifySmtpError(error: unknown): EmailSendError {
  const err = error as { responseCode?: number; code?: string; message?: string; response?: string; command?: string };
  const message = friendlySmtpTimeoutMessage(error) ?? err.message ?? "SMTP send failed.";

  const transientCodes = new Set(["ECONNECTION", "ETIMEDOUT", "ECONNREFUSED", "ESOCKET", "EDNS", "ETLS"]);
  if (err.code && transientCodes.has(err.code)) {
    return new EmailSendError(message, "retry");
  }

  if (typeof err.responseCode === "number") {
    if (err.responseCode >= 400 && err.responseCode < 500) {
      return new EmailSendError(message, "retry");
    }
    if (err.responseCode >= 500) {
      const bounced = isRecipientBounce({ responseCode: err.responseCode, command: err.command, response: err.response });
      if (bounced) return new EmailSendError(message, "bounced");
      return new EmailSendError(message, "failed", isMailboxRejection(err.responseCode, err.command, err.response));
    }
  }

  return new EmailSendError(message, "retry");
}

// Resolves the connection details nodemailer needs — real SMTP either way,
// just a different auth strategy. A Gmail- or Outlook-connected mailbox
// (email_provider = 'gmail'/'outlook', see the gmail_oauth/microsoft_oauth
// migrations) has no SMTP password to decrypt; each refreshes its own
// stored OAuth refresh token into a short-lived access token instead, fresh
// for every send (never cached), the same "resolve credentials on every
// use" pattern the password path already follows.
async function resolveSmtpConnection(mailbox: Mailbox) {
  if (mailbox.email_provider === "gmail") {
    if (!mailbox.encrypted_google_refresh_token) {
      throw new EmailSendError("This mailbox's Google connection is missing — reconnect it in Settings.", "failed", true);
    }
    const refreshToken = decryptSmtpPassword(mailbox.encrypted_google_refresh_token);
    let accessToken: string;
    try {
      accessToken = await refreshGoogleAccessToken(refreshToken);
    } catch (error) {
      // Translated into the same EmailSendError shape classifySmtpError
      // produces, so send-worker.ts's catch block classifies this exactly
      // like an SMTP-level auth failure — invalid_grant (Google revoked
      // access) maps to "failed" + mailboxIssue the same way a real SMTP
      // 535 auth rejection does, not endlessly retried.
      if (error instanceof GoogleOAuthError) {
        throw oauthRefreshError(error);
      }
      throw error;
    }
    return {
      host: GMAIL_SMTP_HOST,
      port: GMAIL_SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: { type: "OAuth2" as const, user: mailbox.email, accessToken },
    };
  }

  // An Outlook-connected mailbox (email_provider = 'outlook', see the
  // microsoft_oauth migration) follows the exact same shape as the Gmail
  // branch above — smtp.office365.com accepts OAuth2/XOAUTH2 over the same
  // real SMTP protocol, just a different token issuer.
  if (mailbox.email_provider === "outlook") {
    if (!mailbox.encrypted_microsoft_refresh_token) {
      throw new EmailSendError("This mailbox's Microsoft connection is missing — reconnect it in Settings.", "failed", true);
    }
    const refreshToken = decryptSmtpPassword(mailbox.encrypted_microsoft_refresh_token);
    let accessToken: string;
    try {
      accessToken = await refreshMicrosoftAccessToken(refreshToken);
    } catch (error) {
      // Same translation as the Gmail branch: invalid_grant (Microsoft
      // revoked access) maps to "failed" + mailboxIssue the same way a real
      // SMTP 535 auth rejection does, not endlessly retried.
      if (error instanceof MicrosoftOAuthError) {
        throw oauthRefreshError(error);
      }
      throw error;
    }
    return {
      host: OUTLOOK_SMTP_HOST,
      port: OUTLOOK_SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: { type: "OAuth2" as const, user: mailbox.email, accessToken },
    };
  }

  // Only this branch connects to a user-supplied host — see mail-host-guard.ts.
  // A disallowed host is a mailbox configuration problem: "failed" +
  // mailboxIssue, so the send worker stops the mailbox instead of retrying.
  try {
    await assertPublicMailHost(mailbox.smtp_host);
  } catch (error) {
    if (error instanceof MailHostNotAllowedError) throw new EmailSendError(error.message, "failed", true);
    throw error;
  }
  const password = decryptSmtpPassword(mailbox.encrypted_smtp_password ?? "");
  return {
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_port === 465,
    requireTLS: mailbox.smtp_port !== 465,
    auth: { user: mailbox.smtp_username, pass: password },
  };
}

// RFC 2369 List-Unsubscribe plus RFC 8058 List-Unsubscribe-Post: mailbox
// providers that support one-click unsubscribe POST
// "List-Unsubscribe=One-Click" straight to the URL (handled by
// app/unsubscribe/[token]/one-click/route.ts) instead of opening it.
function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// Sends exactly one email over SMTP using a single mailbox's credentials.
// No retries, no batching, no connection reuse across calls — a fresh
// transport per send, matching the "send one message" scope of this class.
export class SmtpEmailProvider implements EmailProvider {
  constructor(private readonly mailbox: Mailbox) {}

  async send(message: OutboundEmailMessage): Promise<SendResult> {
    const connection = await resolveSmtpConnection(this.mailbox);
    const transporter = nodemailer.createTransport({ ...connection, ...SMTP_TIMEOUTS });

    try {
      const info = await transporter.sendMail({
        from: formatAddress(message.from),
        to: formatAddress(message.to),
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo,
        // Optional threading headers — nodemailer passes both straight
        // through to the outgoing MIME headers. Undefined for every
        // existing caller (campaign sends never set these), so this is a
        // no-op for the send path that already works.
        inReplyTo: message.inReplyTo,
        references: message.references?.join(" "),
        // nodemailer accepts this exact {filename, content, contentType}
        // shape natively — no transformation needed. undefined for every
        // caller that doesn't set it (unchanged behavior for warmup/reply
        // sends, which never do).
        attachments: message.attachments,
        headers: message.listUnsubscribeUrl ? listUnsubscribeHeaders(message.listUnsubscribeUrl) : undefined,
      });

      return { providerMessageId: normalizeMessageId(info.messageId) ?? info.messageId };
    } catch (error) {
      throw classifySmtpError(error);
    }
  }
}

// Verifies the connection/EHLO/AUTH handshake without sending a message —
// nodemailer's transporter.verify() does the same negotiation send() does up
// through authentication, then closes, never issuing MAIL FROM/RCPT TO/DATA.
// Used only by testSmtpConnectionAction (see app/(app)/mailboxes/actions.ts)
// for the mailbox form's "Test connection" button; send() above is
// completely unaffected — this is purely additive and reuses
// resolveSmtpConnection exactly as send() does, so it exercises the same
// Gmail/Outlook/manual auth branches a real send would.
export async function verifySmtpConnection(mailbox: Mailbox): Promise<void> {
  const connection = await resolveSmtpConnection(mailbox);
  const transporter = nodemailer.createTransport({ ...connection, ...SMTP_TIMEOUTS });
  try {
    await transporter.verify();
  } catch (error) {
    const friendlyMessage = friendlySmtpTimeoutMessage(error);
    if (friendlyMessage) throw new Error(friendlyMessage);
    throw error;
  }
}
