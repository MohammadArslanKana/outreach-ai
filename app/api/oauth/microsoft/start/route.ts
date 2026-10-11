import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/supabase/auth";
import { buildMicrosoftAuthUrl } from "@/lib/email/microsoft-oauth";

// Route Handler, not a Server Function — this needs to redirect the
// top-level browser to Microsoft's own domain. Mirrors
// app/api/oauth/google/start/route.ts exactly.

export const STATE_COOKIE_NAME = "microsoft_oauth_state";
const STATE_COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes — just long enough for the round trip to Microsoft and back

// app/(app)/layout.tsx already gates the /mailboxes page this link starts
// from, but Route Handlers are reachable directly, so this re-checks
// independently. A signed-out visitor is sent to sign in, not shown a 500.
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // A random, unguessable value stored in a cookie only this browser can
  // read back (httpOnly) and only over this flow's short lifetime — the
  // standard OAuth "state cookie" CSRF defense, identical to the Google
  // flow's.
  const state = randomBytes(24).toString("base64url");

  // buildMicrosoftAuthUrl() throws a plain Error if
  // MICROSOFT_OAUTH_CLIENT_ID/SECRET aren't configured in this environment
  // (see lib/email/microsoft-oauth.ts's getClientCredentials()).
  // mailbox-list.tsx already hides the "Connect Microsoft 365" button in
  // that case, but this route is reachable directly regardless of the UI —
  // fail the same friendly way app/api/oauth/google/callback/route.ts does
  // for its own errors, instead of an unhandled 500.
  let authUrl: string;
  try {
    authUrl = buildMicrosoftAuthUrl(state);
  } catch {
    const url = new URL("/mailboxes", request.url);
    url.searchParams.set("error", "Microsoft 365 connection isn't set up yet. Try again later.");
    return NextResponse.redirect(url);
  }

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
    path: "/api/oauth/microsoft",
  });
  return response;
}
