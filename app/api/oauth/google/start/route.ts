import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/supabase/auth";
import { buildGoogleAuthUrl } from "@/lib/email/google-oauth";

// Route Handler, not a Server Function — this needs to redirect the
// top-level browser to Google's own domain, the same "real HTTP endpoint
// for a third-party flow" reasoning app/auth/confirm/route.ts already
// follows for Supabase's email-link callback.

export const STATE_COOKIE_NAME = "google_oauth_state";
const STATE_COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes — just long enough for the round trip to Google and back

// app/(app)/layout.tsx already gates the /mailboxes page this link starts
// from, but Route Handlers are reachable directly, so this re-checks
// independently. A signed-out visitor (an expired session, a bookmarked
// link) is sent to sign in rather than shown a 500.
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // A random, unguessable value stored in a cookie only this browser can
  // read back (httpOnly) and only over this flow's short lifetime — the
  // standard OAuth "state cookie" CSRF defense. No signing/secret needed:
  // an attacker who can't read or set this cookie can't produce a state
  // value that matches it.
  const state = randomBytes(24).toString("base64url");

  // buildGoogleAuthUrl() throws if GOOGLE_OAUTH_CLIENT_ID/SECRET aren't set
  // in this environment; the button is hidden then, but this route is
  // reachable directly — same friendly fallback as the Microsoft route.
  let authUrl: string;
  try {
    authUrl = buildGoogleAuthUrl(state);
  } catch {
    const url = new URL("/mailboxes", request.url);
    url.searchParams.set("error", "Google Workspace connection isn't set up yet. Try again later.");
    return NextResponse.redirect(url);
  }

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
    path: "/api/oauth/google",
  });
  return response;
}
