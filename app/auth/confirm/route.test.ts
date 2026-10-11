import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifyOtp = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { verifyOtp } })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}

import { GET } from "./route";

const INVALID_LINK = `/login?error=${encodeURIComponent("This link is invalid or has expired.")}`;

async function redirectTarget(query: string): Promise<string> {
  try {
    await GET(new NextRequest(`https://polimatiq.test/auth/confirm${query}`));
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  verifyOtp.mockReset();
});

describe("/auth/confirm", () => {
  it("verifies a signup link and lands on the dashboard", async () => {
    verifyOtp.mockResolvedValue({ error: null });

    expect(await redirectTarget("?token_hash=abc&type=signup&next=/dashboard")).toBe("/dashboard");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "abc" });
  });

  it("sends a password-recovery link to the reset page", async () => {
    verifyOtp.mockResolvedValue({ error: null });

    expect(await redirectTarget("?token_hash=abc&type=recovery&next=/reset-password")).toBe("/reset-password");
  });

  it("shows a generic message for an expired or already-used link, without the provider's error", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Email link is invalid or has expired", code: "otp_expired" } });

    expect(await redirectTarget("?token_hash=used&type=signup&next=/dashboard")).toBe(INVALID_LINK);
  });

  it("rejects a link with no token without calling Supabase", async () => {
    expect(await redirectTarget("?type=signup")).toBe(INVALID_LINK);
    expect(await redirectTarget("?token_hash=abc")).toBe(INVALID_LINK);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example"])(
    "never redirects off-site after a valid link (next=%s)",
    async (next) => {
      verifyOtp.mockResolvedValue({ error: null });

      expect(await redirectTarget(`?token_hash=abc&type=signup&next=${encodeURIComponent(next)}`)).toBe("/dashboard");
    },
  );
});
