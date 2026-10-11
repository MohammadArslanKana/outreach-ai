import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { createMailbox, getMailboxByUserAndEmail, getUserOrganization, recordAuditEvent, updateMailbox } from "@/lib/db";
import { assertWithinMailboxLimit, PlanLimitError } from "@/lib/billing/limits";
import { encryptSmtpPassword } from "@/lib/crypto/smtp-secret";
import { exchangeCodeForTokens, getGoogleUserInfo, GoogleOAuthError } from "@/lib/email/google-oauth";
import { GMAIL_IMAP_HOST, GMAIL_IMAP_PORT, GMAIL_SMTP_HOST, GMAIL_SMTP_PORT } from "@/lib/email/google-constants";
import { STATE_COOKIE_NAME } from "../start/route";

// Defaults a brand-new Gmail mailbox gets, matching mailbox-form.tsx's own
// create-mode defaults exactly — a Gmail connection isn't a special tier,
// it starts under the same sending limits any new mailbox does.
const DEFAULT_DAILY_LIMIT = 50;
const DEFAULT_HOURLY_LIMIT = 10;
const DEFAULT_COOLDOWN_MINUTES = 0;

function redirectWithError(request: NextRequest, message: string) {
  const url = new URL("/mailboxes", request.url);
  url.searchParams.set("error", message);
  const response = NextResponse.redirect(url);
  response.cookies.delete(STATE_COOKIE_NAME);
  return response;
}

function isValidState(cookieValue: string | undefined, stateParam: string | null): boolean {
  if (!cookieValue || !stateParam) return false;
  const expected = Buffer.from(cookieValue);
  const provided = Buffer.from(stateParam);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// Route Handler, not a Server Function — the third-party callback target
// Google redirects to, same reasoning as app/auth/confirm/route.ts and
// ../start/route.ts.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const googleError = searchParams.get("error");
  if (googleError) {
    return redirectWithError(request, "Google sign-in was cancelled or denied.");
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const stateCookie = request.cookies.get(STATE_COOKIE_NAME)?.value;

  if (!code || !isValidState(stateCookie, state)) {
    return redirectWithError(request, "This connection request is invalid or expired. Try connecting again.");
  }

  // Re-checked independently of the /mailboxes page's own auth guard —
  // Route Handlers are reachable directly, and this one is never allowed to
  // trust anything from Google's response for identity (Google only proves
  // which Google account consented, never which outreach-ai user started
  // this flow).
  const user = await getUser();
  if (!user) {
    // The session ended during the round trip to the provider — send the
    // user to sign in again instead of failing with a 500.
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "Your session expired. Sign in and connect the mailbox again.");
    const response = NextResponse.redirect(url);
    response.cookies.delete(STATE_COOKIE_NAME);
    return response;
  }
  const supabase = await createClient();

  try {
    const tokens = await exchangeCodeForTokens(code);
    const googleUser = await getGoogleUserInfo(tokens.accessToken);

    const existing = await getMailboxByUserAndEmail(supabase, user.id, googleUser.email);
    const encryptedRefreshToken = encryptSmtpPassword(tokens.refreshToken);

    let mailbox;
    if (existing) {
      // Reconnect: only touch the OAuth-specific fields and bring the
      // mailbox back to 'active' — daily/hourly limits, cooldown, domain,
      // and warmup settings the user already configured are left alone.
      mailbox = await updateMailbox(supabase, user.id, existing.id, {
        email_provider: "gmail",
        reply_provider: "gmail",
        imap_enabled: true,
        encrypted_google_refresh_token: encryptedRefreshToken,
        status: "active",
      });
    } else {
      await assertWithinMailboxLimit(supabase, user.id, user.email);
      mailbox = await createMailbox(supabase, {
        user_id: user.id,
        domain_id: null,
        email: googleUser.email,
        email_provider: "gmail",
        reply_provider: "gmail",
        imap_enabled: true,
        smtp_host: GMAIL_SMTP_HOST,
        smtp_port: GMAIL_SMTP_PORT,
        smtp_username: googleUser.email,
        encrypted_smtp_password: null,
        imap_host: GMAIL_IMAP_HOST,
        imap_port: GMAIL_IMAP_PORT,
        imap_username: googleUser.email,
        encrypted_google_refresh_token: encryptedRefreshToken,
        daily_limit: DEFAULT_DAILY_LIMIT,
        hourly_limit: DEFAULT_HOURLY_LIMIT,
        cooldown_minutes: DEFAULT_COOLDOWN_MINUTES,
        warmup_enabled: false,
        status: "active",
      });
    }

    const organization = await getUserOrganization(supabase, user);
    await recordAuditEvent(supabase, {
      organization_id: organization.id,
      actor_user_id: user.id,
      action: "mailbox_connected",
      target_type: "mailbox",
      target_id: mailbox.id,
      metadata: { email: mailbox.email, provider: "gmail" },
    });
  } catch (error) {
    // Only errors this route already knows are safe to show — Google's own
    // public OAuth error text (GoogleOAuthError) and a plan-limit message
    // (PlanLimitError) — reach the user with their real message. Anything
    // else (a raw DB/PostgREST error from createMailbox/updateMailbox/
    // getUserOrganization/recordAuditEvent, or an unexpected bug) is logged
    // in full here, server-side only, and replaced with a generic message
    // before it can reach the redirect URL.
    if (error instanceof GoogleOAuthError || error instanceof PlanLimitError) {
      return redirectWithError(request, error.message);
    }
    console.error("[oauth/google/callback] unexpected error", error);
    return redirectWithError(request, "Couldn't connect this Gmail account. Try again.");
  }

  const response = NextResponse.redirect(new URL("/mailboxes?connected=gmail", request.url));
  response.cookies.delete(STATE_COOKIE_NAME);
  return response;
}
