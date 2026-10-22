import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/auth", () => ({
  getUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  createMailbox: vi.fn(),
  getMailboxByUserAndEmail: vi.fn(),
  getUserOrganization: vi.fn(),
  recordAuditEvent: vi.fn(),
  updateMailbox: vi.fn(),
}));
vi.mock("@/lib/email/google-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/google-oauth")>()),
  buildGoogleAuthUrl: vi.fn((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  exchangeCodeForTokens: vi.fn(),
}));
vi.mock("@/lib/email/microsoft-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/microsoft-oauth")>()),
  buildMicrosoftAuthUrl: vi.fn((state: string) => `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${state}`),
  exchangeCodeForTokens: vi.fn(),
}));

import { getUser } from "@/lib/supabase/auth";
import { exchangeCodeForTokens as exchangeGoogleCode } from "@/lib/email/google-oauth";
import { buildGoogleAuthUrl } from "@/lib/email/google-oauth";
import { buildMicrosoftAuthUrl, exchangeCodeForTokens as exchangeMicrosoftCode } from "@/lib/email/microsoft-oauth";
import { GET as googleStart, STATE_COOKIE_NAME as GOOGLE_STATE_COOKIE } from "./google/start/route";
import { GET as googleCallback } from "./google/callback/route";
import { GET as microsoftStart, STATE_COOKIE_NAME as MICROSOFT_STATE_COOKIE } from "./microsoft/start/route";
import { GET as microsoftCallback } from "./microsoft/callback/route";

const mockGetUser = vi.mocked(getUser);
const BASE = "https://polimatiq.test";

function request(path: string, cookies: Record<string, string> = {}) {
  const req = new NextRequest(`${BASE}${path}`);
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  { provider: "google", start: googleStart, providerHost: "accounts.google.com", cookie: GOOGLE_STATE_COOKIE },
  { provider: "microsoft", start: microsoftStart, providerHost: "login.microsoftonline.com", cookie: MICROSOFT_STATE_COOKIE },
])("/api/oauth/$provider/start", ({ provider, start, providerHost, cookie }) => {
  it("redirects a signed-out visitor to /login instead of failing", async () => {
    mockGetUser.mockResolvedValue(null);

    const response = await start(request(`/api/oauth/${provider}/start`));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(response.cookies.get(cookie)).toBeUndefined();
  });

  it("redirects a signed-in user to the provider with a state cookie", async () => {
    mockGetUser.mockResolvedValue({ id: "user-1", email: "a@example.com" } as User);

    const response = await start(request(`/api/oauth/${provider}/start`));

    const location = new URL(response.headers.get("location")!);
    expect(location.host).toBe(providerHost);
    const state = response.cookies.get(cookie)?.value;
    expect(state).toBeTruthy();
    expect(location.searchParams.get("state")).toBe(state);
  });
});

describe("/api/oauth/google/start without Google credentials", () => {
  it("sends a signed-in user back to /mailboxes with a friendly error instead of a 500", async () => {
    mockGetUser.mockResolvedValue({ id: "user-1", email: "a@example.com" } as User);
    vi.mocked(buildGoogleAuthUrl).mockImplementationOnce(() => {
      throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set");
    });

    const response = await googleStart(request("/api/oauth/google/start"));

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/mailboxes");
    expect(location.searchParams.get("error")).toBe("Google Workspace connection isn't set up yet. Try again later.");
    expect(response.cookies.get(GOOGLE_STATE_COOKIE)).toBeUndefined();
  });
});

describe("/api/oauth/microsoft/start without Microsoft credentials", () => {
  it("sends a signed-in user back to /mailboxes with a friendly error", async () => {
    mockGetUser.mockResolvedValue({ id: "user-1", email: "a@example.com" } as User);
    vi.mocked(buildMicrosoftAuthUrl).mockImplementationOnce(() => {
      throw new Error("MICROSOFT_OAUTH_CLIENT_ID is not set");
    });

    const response = await microsoftStart(request("/api/oauth/microsoft/start"));

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/mailboxes");
    expect(location.searchParams.get("error")).toBe("Microsoft 365 connection isn't set up yet. Try again later.");
  });
});

describe.each([
  { provider: "google", callback: googleCallback, cookie: GOOGLE_STATE_COOKIE, exchange: exchangeGoogleCode },
  { provider: "microsoft", callback: microsoftCallback, cookie: MICROSOFT_STATE_COOKIE, exchange: exchangeMicrosoftCode },
])("/api/oauth/$provider/callback", ({ provider, callback, cookie, exchange }) => {
  it("sends a user whose session expired mid-flow to /login without touching the provider", async () => {
    mockGetUser.mockResolvedValue(null);

    const response = await callback(
      request(`/api/oauth/${provider}/callback?code=auth-code&state=matching-state`, { [cookie]: "matching-state" }),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("Your session expired. Sign in and connect the mailbox again.");
    // The one-time state cookie is cleared so a retry starts a fresh flow.
    expect(response.cookies.get(cookie)?.value).toBe("");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects a missing state cookie", async () => {
    const response = await callback(
      request(
        `/api/oauth/${provider}/callback?code=auth-code&state=matching-state`,
      ),
    );

    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(307);
    expect(location.pathname).toBe("/mailboxes");
    expect(location.searchParams.get("error")).toBe(
      "This connection request is invalid or expired. Try connecting again.",
    );
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects a missing authorization code", async () => {
    const response = await callback(
      request(
        `/api/oauth/${provider}/callback?state=matching-state`,
        { [cookie]: "matching-state" },
      ),
    );

    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(307);
    expect(location.pathname).toBe("/mailboxes");
    expect(location.searchParams.get("error")).toBe(
      "This connection request is invalid or expired. Try connecting again.",
    );
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it("handles provider cancellation without exchanging tokens", async () => {
    const response = await callback(
      request(
        `/api/oauth/${provider}/callback?error=access_denied`,
        { [cookie]: "matching-state" },
      ),
    );

    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(307);
    expect(location.pathname).toBe("/mailboxes");

    expect(location.searchParams.get("error")).toBe(
      provider === "google"
        ? "Google sign-in was cancelled or denied."
        : "Microsoft sign-in was cancelled or denied.",
    );

    expect(exchange).not.toHaveBeenCalled();
    expect(response.cookies.get(cookie)?.value).toBe("");
  }); 
   });
