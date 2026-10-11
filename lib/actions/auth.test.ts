import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseAuth = {
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: supabaseAuth })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/rate-limit/get-client-ip", () => ({
  getClientIp: vi.fn(async () => "203.0.113.7"),
}));
vi.mock("@/lib/rate-limit/check-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/check-rate-limit")>()),
  checkRateLimit: vi.fn(),
}));

import { checkRateLimit, RateLimitError } from "@/lib/rate-limit/check-rate-limit";
import { forgotPassword, resetPassword, signIn, signOut, signUp } from "./auth";

const mockCheckRateLimit = vi.mocked(checkRateLimit);

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID_SIGNUP = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  password: "Str0ngPassword",
  confirmPassword: "Str0ngPassword",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue(undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://polimatiq.test");
});

describe("signUp", () => {
  it("creates the account with a confirmation link back to /auth/confirm and asks the user to check email", async () => {
    supabaseAuth.signUp.mockResolvedValue({ error: null });

    await expect(signUp(undefined, form(VALID_SIGNUP))).resolves.toEqual({ success: true });
    expect(supabaseAuth.signUp).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "Str0ngPassword",
      options: {
        data: { full_name: "Ada Lovelace" },
        emailRedirectTo: "https://polimatiq.test/auth/confirm?next=/dashboard",
      },
    });
  });

  it("rejects weak or mismatched passwords before calling Supabase", async () => {
    const result = await signUp(undefined, form({ ...VALID_SIGNUP, password: "short", confirmPassword: "other" }));

    expect(result?.fieldErrors?.password).toBeDefined();
    expect(result?.fieldErrors?.confirmPassword).toEqual(["Passwords do not match."]);
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it("is rate limited per client IP", async () => {
    const limited = new RateLimitError(300);
    mockCheckRateLimit.mockRejectedValueOnce(limited);

    await expect(signUp(undefined, form(VALID_SIGNUP))).resolves.toEqual({ error: limited.message });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("auth:sign_up", "203.0.113.7");
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it("reports a provider error (e.g. an address Supabase refuses) on the form", async () => {
    supabaseAuth.signUp.mockResolvedValue({ error: { message: 'Email address "x@example.com" is invalid' } });

    await expect(signUp(undefined, form(VALID_SIGNUP))).resolves.toEqual({
      error: 'Email address "x@example.com" is invalid',
    });
  });
});

describe("signIn", () => {
  it("redirects to the dashboard on success", async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({ error: null });

    await expect(signIn(undefined, form({ email: "ada@example.com", password: "x" }))).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard",
    );
  });

  it("returns Supabase's generic credentials error without revealing whether the account exists", async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });

    await expect(signIn(undefined, form({ email: "ada@example.com", password: "wrong" }))).resolves.toEqual({
      error: "Invalid login credentials",
    });
  });
});

describe("forgotPassword", () => {
  it("reports success for an unknown address so it can't be used to enumerate accounts", async () => {
    supabaseAuth.resetPasswordForEmail.mockResolvedValue({ error: { code: "user_not_found", message: "User not found" } });

    await expect(forgotPassword(undefined, form({ email: "nobody@example.com" }))).resolves.toEqual({ success: true });
    expect(supabaseAuth.resetPasswordForEmail).toHaveBeenCalledWith("nobody@example.com", {
      redirectTo: "https://polimatiq.test/auth/confirm?next=/reset-password",
    });
  });

  it("is rate limited per IP and per email address", async () => {
    supabaseAuth.resetPasswordForEmail.mockResolvedValue({ error: null });

    await forgotPassword(undefined, form({ email: "Ada@Example.com" }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith("auth:forgot_password_ip", "203.0.113.7");
    expect(mockCheckRateLimit).toHaveBeenCalledWith("auth:forgot_password_email", "ada@example.com");
  });
});

describe("resetPassword", () => {
  const VALID = { password: "N3wPassword", confirmPassword: "N3wPassword" };

  it("refuses without the session a recovery link establishes", async () => {
    supabaseAuth.getUser.mockResolvedValue({ data: { user: null } });

    await expect(resetPassword(undefined, form(VALID))).resolves.toEqual({
      error: "This password reset link is invalid or has expired. Request a new one.",
    });
    expect(supabaseAuth.updateUser).not.toHaveBeenCalled();
  });

  it("updates the password and lands on the dashboard", async () => {
    supabaseAuth.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    supabaseAuth.updateUser.mockResolvedValue({ error: null });

    await expect(resetPassword(undefined, form(VALID))).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(supabaseAuth.updateUser).toHaveBeenCalledWith({ password: "N3wPassword" });
  });
});

describe("signOut", () => {
  it("ends the session and returns to /login", async () => {
    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(supabaseAuth.signOut).toHaveBeenCalled();
  });
});
