import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked at the module boundary this Server Function actually imports
// through — same "mock the seam, not the implementation" approach the rest
// of this codebase's tests use. requireUser/createClient are what let this
// run outside a real request (next/headers' cookies() otherwise throws
// outside one); getUserOrganization/getSubscriptionV2/getRazorpayClient are
// mocked so each test can assert exactly what cancelRazorpaySubscriptionAction
// does with a given subscriptions_v2 state, without a real database or a
// real Razorpay account.
// The real billing-region resolver (lib/billing/region.ts) runs; only the
// request headers it reads are mocked, so these tests exercise the same
// country decision production makes.
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));
vi.mock("@/lib/supabase/auth", () => ({
  requireUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db", () => ({
  getUserOrganization: vi.fn(),
}));
vi.mock("@/lib/db/billing-v2", () => ({
  getSubscriptionV2: vi.fn(),
  claimBillingCheckout: vi.fn(),
  attachBillingCheckoutSubscription: vi.fn(),
  releaseBillingCheckout: vi.fn(),
}));
vi.mock("@/lib/billing/subscription-view", () => ({
  getActiveSubscriptionView: vi.fn(),
}));
vi.mock("@/lib/billing/razorpay", () => ({
  getRazorpayClient: vi.fn(),
  totalCountForInterval: vi.fn(),
}));
vi.mock("@/lib/rate-limit/check-rate-limit", () => ({
  checkRateLimit: vi.fn(),
  RateLimitError: class RateLimitError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
      super(`Too many attempts. Try again in ${retryAfterSeconds}s.`);
      this.name = "RateLimitError";
    }
  },
}));

import { headers } from "next/headers";
import { requireUser } from "@/lib/supabase/auth";
import { getUserOrganization } from "@/lib/db";
import {
  attachBillingCheckoutSubscription,
  claimBillingCheckout,
  getSubscriptionV2,
  releaseBillingCheckout,
} from "@/lib/db/billing-v2";
import { getRazorpayClient } from "@/lib/billing/razorpay";
import { getPlanOffering } from "@/lib/billing/offerings";
import { getActiveSubscriptionView } from "@/lib/billing/subscription-view";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit/check-rate-limit";
import {
  cancelRazorpaySubscriptionAction,
  createRazorpaySubscriptionAction,
  getRazorpayCheckoutStatusAction,
} from "./razorpay-actions";

const mockRequireUser = vi.mocked(requireUser);
const mockGetUserOrganization = vi.mocked(getUserOrganization);
const mockGetSubscriptionV2 = vi.mocked(getSubscriptionV2);
const mockGetRazorpayClient = vi.mocked(getRazorpayClient);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetActiveSubscriptionView = vi.mocked(getActiveSubscriptionView);
const mockHeaders = vi.mocked(headers);
const mockClaim = vi.mocked(claimBillingCheckout);
const mockAttach = vi.mocked(attachBillingCheckoutSubscription);
const mockRelease = vi.mocked(releaseBillingCheckout);

// The private claim token a fresh claim returns. Distinctive so any leak into
// a log line, an error or the response is easy to detect.
const CLAIM_TOKEN = "tok_9f2c6b1e7d4a83c05e1f6a2b9d7c4e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c9d";
const CLAIM = { checkoutId: "checkout-1", claimToken: CLAIM_TOKEN };

// The real offering resolver (lib/billing/offerings.ts) runs; Razorpay plan
// ids come from these env vars, the way production configures them.
const INR_STARTER_1M = "plan_test_starter_1m";
const USD_STARTER_1M = "plan_test_starter_1m_usd";

// A request as Vercel's edge would present it.
function requestFrom(values: Record<string, string>) {
  mockHeaders.mockResolvedValue(new Headers(values) as never);
}

const USER = { id: "user-1", email: "owner@example.com" };
const ORGANIZATION = { id: "org-1" };

function mockCancel(impl: (...args: unknown[]) => unknown) {
  const cancel = vi.fn(impl);
  mockGetRazorpayClient.mockReturnValue({
    subscriptions: { cancel },
  } as unknown as ReturnType<typeof getRazorpayClient>);
  return cancel;
}

function mockCreate(impl: (...args: unknown[]) => unknown) {
  const create = vi.fn(impl);
  mockGetRazorpayClient.mockReturnValue({
    subscriptions: { create },
  } as unknown as ReturnType<typeof getRazorpayClient>);
  return create;
}

const CHECKOUT_INPUT = { planId: "starter", interval: "1_month" } as const;

function razorpaySubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-row-1",
    organization_id: ORGANIZATION.id,
    provider: "razorpay",
    provider_subscription_id: "sub_real_razorpay_id",
    normalized_status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Unauthenticated is the default per requireUser's own contract (throws
  // when there's no session) — every test that needs a signed-in user
  // opts in explicitly via mockRequireUser.mockResolvedValue(USER).
  mockRequireUser.mockRejectedValue(new Error("Unauthorized: no authenticated user."));
  mockGetUserOrganization.mockResolvedValue(ORGANIZATION as never);
  // Allowed by default — tests exercising the rate-limit block override this
  // with a rejected promise instead.
  mockCheckRateLimit.mockResolvedValue(undefined);
  // A fresh claim unless a test sets up an existing open checkout.
  mockClaim.mockResolvedValue({ outcome: "claimed", ...CLAIM });
  mockAttach.mockResolvedValue(true);
  mockRelease.mockResolvedValue(true);
  // Only the INR Starter 1-month plan is configured unless a test adds more.
  vi.stubEnv("RAZORPAY_PLAN_STARTER_1MONTH", INR_STARTER_1M);
  vi.stubEnv("RAZORPAY_PLAN_STARTER_1MONTH_USD", "");
  // An Indian request on Vercel unless a test says otherwise.
  vi.stubEnv("VERCEL", "1");
  requestFrom({ "x-vercel-ip-country": "IN" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cancelRazorpaySubscriptionAction", () => {
  it("cancels a real, active Razorpay subscription for the caller's own organization", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription() as never);
    const cancel = mockCancel(async () => ({ id: "sub_real_razorpay_id", status: "cancelled" }));

    await expect(cancelRazorpaySubscriptionAction()).resolves.toEqual({ ok: true, data: undefined });

    // Correct subscription id, and cancelAtCycleEnd=false (immediate) —
    // never the scheduled-cancellation variant this app doesn't support
    // (see the action's own comment on why).
    expect(cancel).toHaveBeenCalledWith("sub_real_razorpay_id", false);
    // Scoped to the caller's own organization, never a hardcoded/guessed id.
    expect(mockGetSubscriptionV2).toHaveBeenCalledWith(expect.anything(), ORGANIZATION.id);
    // Rate-limited under the shared "manage an existing subscription" scope
    // (billing:manage), keyed on the caller's own organization — same
    // identity pattern every other authenticated action in this codebase
    // uses (see campaign:launch/campaign:enroll).
    expect(mockCheckRateLimit).toHaveBeenCalledWith("billing:manage", ORGANIZATION.id);
  });

  it("blocks cancellation when the org has exceeded the billing:manage rate limit, without calling Razorpay", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockCheckRateLimit.mockRejectedValue(new RateLimitError(300));
    const cancel = mockCancel(async () => ({}));

    expect(await cancelRazorpaySubscriptionAction()).toEqual({ ok: false, error: new RateLimitError(300).message });

    expect(mockGetSubscriptionV2).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before touching the database or Razorpay", async () => {
    // requireUser rejects by default (see beforeEach) — this is the case.
    const cancel = mockCancel(async () => ({}));

    await expect(cancelRazorpaySubscriptionAction()).rejects.toThrow();

    expect(mockGetSubscriptionV2).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the authenticated caller's own organization, never another org's", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    const otherOrg = { id: "org-belonging-to-someone-else" };
    mockGetUserOrganization.mockResolvedValue(otherOrg as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ organization_id: otherOrg.id }) as never);
    mockCancel(async () => ({}));

    await cancelRazorpaySubscriptionAction();

    // getUserOrganization derives the org from the authenticated session
    // alone (see lib/db/organizations.ts) — there is no organization id
    // parameter anywhere on this action for an attacker to substitute, so
    // the only thing to verify is that whatever getUserOrganization
    // resolves is exactly what gets queried, never a different value.
    expect(mockGetSubscriptionV2).toHaveBeenCalledWith(expect.anything(), otherOrg.id);
  });

  it("rejects a free user with no subscriptions_v2 row at all", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(null as never);
    const cancel = mockCancel(async () => ({}));

    expect(await cancelRazorpaySubscriptionAction()).toEqual({ ok: false, error: expect.stringMatching(/no active razorpay subscription/i) });

    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects a subscriber whose current subscription is on a different provider", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ provider: "stripe" }) as never);
    const cancel = mockCancel(async () => ({}));

    expect(await cancelRazorpaySubscriptionAction()).toEqual({ ok: false, error: expect.stringMatching(/no active razorpay subscription/i) });

    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects a duplicate cancellation attempt on an already-cancelled subscription without calling Razorpay again", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ normalized_status: "cancelled" }) as never);
    const cancel = mockCancel(async () => ({}));

    expect(await cancelRazorpaySubscriptionAction()).toEqual({ ok: false, error: expect.stringMatching(/already cancelled or inactive/i) });

    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["expired", "completed", "suspended"])(
    "rejects cancelling a subscription that's already in a terminal '%s' state",
    async (normalizedStatus) => {
      mockRequireUser.mockResolvedValue(USER as never);
      mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ normalized_status: normalizedStatus }) as never);
      const cancel = mockCancel(async () => ({}));

      expect(await cancelRazorpaySubscriptionAction()).toEqual({ ok: false, error: expect.stringMatching(/already cancelled or inactive/i) });

      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("sanitizes a raw Razorpay API failure into a generic message, never leaking it to the caller", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription() as never);
    mockCancel(async () => {
      throw new Error("Razorpay 401: invalid key_secret for account acct_super_secret");
    });

    expect(await cancelRazorpaySubscriptionAction()).toEqual({ ok: false, error: "Couldn't cancel the subscription. Try again shortly or contact support." });
  });
});

describe("createRazorpaySubscriptionAction", () => {
  it("starts a checkout for the caller's own organization, rate-limited under billing:checkout", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(null as never);
    const create = mockCreate(async () => ({ id: "sub_new_razorpay_id" }));

    const result = await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    expect(result).toEqual({ ok: true, data: { subscriptionId: "sub_new_razorpay_id", prefillEmail: USER.email } });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: "plan_test_starter_1m",
        notes: expect.objectContaining({ organization_id: ORGANIZATION.id }),
      }),
    );
    // Rate-limited under the shared "start a new checkout" scope
    // (billing:checkout), keyed on the caller's own organization — checked
    // before the plan-id lookup or any Razorpay API call.
    expect(mockCheckRateLimit).toHaveBeenCalledWith("billing:checkout", ORGANIZATION.id);
  });

  it("blocks starting a checkout when the org has exceeded the billing:checkout rate limit, without calling Razorpay", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockCheckRateLimit.mockRejectedValue(new RateLimitError(300));
    const create = mockCreate(async () => ({}));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: new RateLimitError(300).message });

    expect(mockHeaders).not.toHaveBeenCalled();
    expect(mockGetSubscriptionV2).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a second checkout while a live subscription exists (the state the billing page now shows as 'Plan changes not available yet')", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    const create = mockCreate(() => Promise.resolve({ id: "sub_new" }));

    for (const status of ["pending", "active", "past_due"]) {
      mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ normalized_status: status }) as never);
      expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/already have an active subscription/) });
    }
    expect(create).not.toHaveBeenCalled();
  });
});

// The action is reachable by a direct POST, so it decides region, currency
// and plan on its own, from the server-side country signal only.
describe("createRazorpaySubscriptionAction — server-side region and currency", () => {
  beforeEach(() => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(null);
  });

  it("creates the Razorpay subscription for an Indian request", async () => {
    const create = mockCreate(() => Promise.resolve({ id: "sub_india" }));

    await expect(createRazorpaySubscriptionAction(CHECKOUT_INPUT)).resolves.toEqual({
      ok: true,
      data: { subscriptionId: "sub_india", prefillEmail: USER.email },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["US", { "x-vercel-ip-country": "US" }],
    ["GB", { "x-vercel-ip-country": "GB" }],
    ["missing country", {}],
    ["malformed country", { "x-vercel-ip-country": "india" }],
  ])("treats a %s request as international: no USD plan configured, so it fails closed without touching Razorpay", async (_label, values) => {
    requestFrom(values as Record<string, string>);
    const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/International checkout isn't available yet/) });
    expect(create).not.toHaveBeenCalled();
    expect(mockGetSubscriptionV2).not.toHaveBeenCalled();
  });

  it("never gives a non-Indian request whose browser language/locale looks Indian the INR plan", async () => {
    requestFrom({ "x-vercel-ip-country": "US", "accept-language": "hi-IN,en-IN;q=0.9" });
    const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/International checkout isn't available yet/) });
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores fabricated currency/provider/country fields in a directly POSTed payload", async () => {
    requestFrom({ "x-vercel-ip-country": "US" });
    const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));
    const forged = { ...CHECKOUT_INPUT, currency: "INR", provider: "razorpay", country: "IN", region: "india" };

    expect(await createRazorpaySubscriptionAction(forged as never)).toEqual({ ok: false, error: expect.stringMatching(/International checkout isn't available yet/) });
    expect(create).not.toHaveBeenCalled();
  });

  it("never forwards client-supplied fields to Razorpay for an Indian request", async () => {
    const create = mockCreate(() => Promise.resolve({ id: "sub_india" }));
    const forged = { ...CHECKOUT_INPUT, currency: "USD", provider: "paypal", country: "US", amount: 1 };

    await createRazorpaySubscriptionAction(forged as never);

    const payload = create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toEqual({
      plan_id: "plan_test_starter_1m",
      total_count: undefined,
      customer_notify: true,
      notes: { organization_id: ORGANIZATION.id, internal_plan_id: "starter", billing_interval: "1_month", currency: "INR" },
    });
  });

  it("does not trust a country header when not running on Vercel", async () => {
    vi.stubEnv("VERCEL", "");
    requestFrom({ "x-vercel-ip-country": "IN" });
    const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/International checkout isn't available yet/) });
    expect(create).not.toHaveBeenCalled();
  });

  it("still rejects an unauthenticated caller before resolving the region", async () => {
    mockRequireUser.mockRejectedValue(new Error("Unauthorized: no authenticated user."));

    await expect(createRazorpaySubscriptionAction(CHECKOUT_INPUT)).rejects.toThrow(/Unauthorized/);
    expect(mockHeaders).not.toHaveBeenCalled();
  });

  it("still applies the billing:checkout rate limit before resolving the region", async () => {
    mockCheckRateLimit.mockRejectedValue(new RateLimitError(60));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: new RateLimitError(60).message });
    expect(mockHeaders).not.toHaveBeenCalled();
  });

  it("still blocks a duplicate checkout for an Indian organization with a live subscription", async () => {
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ normalized_status: "active" }) as never);
    const create = mockCreate(() => Promise.resolve({ id: "sub_second" }));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/already have an active subscription/) });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createRazorpaySubscriptionAction — INR/USD plan resolution", () => {
  beforeEach(() => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("international with a configured USD plan: subscribes on the USD plan and notes USD", async () => {
    vi.stubEnv("RAZORPAY_PLAN_STARTER_1MONTH_USD", USD_STARTER_1M);
    requestFrom({ "x-vercel-ip-country": "US" });
    const create = mockCreate(() => Promise.resolve({ id: "sub_usd" }));

    await expect(createRazorpaySubscriptionAction(CHECKOUT_INPUT)).resolves.toEqual({
      ok: true,
      data: { subscriptionId: "sub_usd", prefillEmail: USER.email },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: USD_STARTER_1M,
        notes: { organization_id: ORGANIZATION.id, internal_plan_id: "starter", billing_interval: "1_month", currency: "USD" },
      }),
    );
  });

  it("international without a USD plan: fails closed, never falls back to the configured INR plan, and logs the missing env var", async () => {
    requestFrom({ "x-vercel-ip-country": "DE" });
    const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/International checkout isn't available yet/) });
    expect(create).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("RAZORPAY_PLAN_STARTER_1MONTH_USD is not set"));
  });

  it("a client-supplied currency can't move an international request onto the INR plan", async () => {
    vi.stubEnv("RAZORPAY_PLAN_STARTER_1MONTH_USD", USD_STARTER_1M);
    requestFrom({ "x-vercel-ip-country": "US" });
    const create = mockCreate(() => Promise.resolve({ id: "sub_usd" }));

    await createRazorpaySubscriptionAction({ ...CHECKOUT_INPUT, currency: "INR", amount: 1, planIdOverride: INR_STARTER_1M } as never);

    expect(create.mock.calls[0][0]).toMatchObject({ plan_id: USD_STARTER_1M, notes: { currency: "USD" } });
  });

  it("India Starter 1-month: the $12.00 plan is paid on the INR Razorpay plan, charging ₹1,152", async () => {
    vi.stubEnv("RAZORPAY_PLAN_STARTER_1MONTH_USD", USD_STARTER_1M);
    const create = mockCreate(() => Promise.resolve({ id: "sub_inr" }));

    await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    expect(create.mock.calls[0][0]).toMatchObject({ plan_id: INR_STARTER_1M, notes: { currency: "INR" } });
    expect(mockClaim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ currency: "INR" }));
    // What that INR plan must charge, and what the customer was shown for it.
    expect(getPlanOffering("starter", "1_month", "INR")).toMatchObject({
      razorpayPlanId: INR_STARTER_1M,
      amount: 115_200,
      price: { total: "$12.00" },
      chargedAs: "₹1,152.00",
    });
  });

  it("a client-supplied currency can't move an Indian request onto the USD plan", async () => {
    vi.stubEnv("RAZORPAY_PLAN_STARTER_1MONTH_USD", USD_STARTER_1M);
    const create = mockCreate(() => Promise.resolve({ id: "sub_inr" }));

    await createRazorpaySubscriptionAction({ ...CHECKOUT_INPUT, currency: "USD" } as never);

    expect(create.mock.calls[0][0]).toMatchObject({ plan_id: INR_STARTER_1M, notes: { currency: "INR" } });
  });

  it("India: an unconfigured INR plan fails closed with the existing message", async () => {
    const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));

    expect(await createRazorpaySubscriptionAction({ planId: "growth", interval: "1_month" })).toEqual({ ok: false, error: expect.stringMatching(/This plan isn't available yet/) });
    expect(create).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("RAZORPAY_PLAN_GROWTH_1MONTH is not set"));
  });

  it.each(["6_month", "12_month"] as const)(
    "India: Scale %s isn't sold (over the ₹50,000 per-transaction limit) even with a plan id configured",
    async (interval) => {
      vi.stubEnv(`RAZORPAY_PLAN_SCALE_${interval === "6_month" ? "6" : "12"}MONTH`, "plan_inr_scale_long");
      const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));

      expect(await createRazorpaySubscriptionAction({ planId: "scale", interval })).toEqual({ ok: false, error: expect.stringMatching(/isn't available for payments in India yet/) });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(["6_month", "12_month"] as const)("international: Scale %s is sold once its USD plan is configured", async (interval) => {
    vi.stubEnv(`RAZORPAY_PLAN_SCALE_${interval === "6_month" ? "6" : "12"}MONTH_USD`, "plan_usd_scale_long");
    requestFrom({ "x-vercel-ip-country": "US" });
    const create = mockCreate(() => Promise.resolve({ id: "sub_usd_scale" }));

    await createRazorpaySubscriptionAction({ planId: "scale", interval });

    expect(create.mock.calls[0][0]).toMatchObject({ plan_id: "plan_usd_scale_long", notes: { currency: "USD", internal_plan_id: "scale" } });
  });

  it("refuses the internal unlimited workspace before any rate limit or Razorpay call", async () => {
    mockGetUserOrganization.mockResolvedValue({ id: "7ef89392-80ba-4447-a7b7-ba642ff00a53" } as never);
    const create = mockCreate(() => Promise.resolve({ id: "sub_should_not_exist" }));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/already has unlimited access/) });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createRazorpaySubscriptionAction — concurrent checkout guard", () => {
  beforeEach(() => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(null);
  });

  it("claims the one-per-window billing:checkout_start slot for the organization before creating the subscription", async () => {
    const create = mockCreate(() => Promise.resolve({ id: "sub_first" }));

    await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    expect(mockCheckRateLimit).toHaveBeenCalledWith("billing:checkout_start", ORGANIZATION.id);
    const guardCall = mockCheckRateLimit.mock.invocationCallOrder[mockCheckRateLimit.mock.calls.findIndex((c) => c[0] === "billing:checkout_start")];
    expect(guardCall).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it("refuses a second checkout started inside the window, without creating another subscription", async () => {
    mockCheckRateLimit.mockImplementation(async (scope) => {
      if (scope === "billing:checkout_start") throw new RateLimitError(90);
    });
    const create = mockCreate(() => Promise.resolve({ id: "sub_second" }));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/A checkout was just started for this workspace/) });
    expect(create).not.toHaveBeenCalled();
  });

  it("doesn't use up the window on a request rejected earlier (live subscription, unavailable plan)", async () => {
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ normalized_status: "active" }) as never);
    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/already have an active subscription/) });

    mockGetSubscriptionV2.mockResolvedValue(null);
    expect(await createRazorpaySubscriptionAction({ planId: "pro", interval: "1_month" })).toEqual({ ok: false, error: expect.stringMatching(/isn't available yet/) });

    expect(mockCheckRateLimit).not.toHaveBeenCalledWith("billing:checkout_start", expect.anything());
  });

  it("passes through a non-rate-limit failure of the guard (which fails closed) rather than masking it", async () => {
    mockCheckRateLimit.mockImplementation(async (scope) => {
      if (scope === "billing:checkout_start") throw new Error("db down");
    });
    const create = mockCreate(() => Promise.resolve({ id: "sub_x" }));

    await expect(createRazorpaySubscriptionAction(CHECKOUT_INPUT)).rejects.toThrow("db down");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("billing actions in production builds", () => {
  // Next.js redacts a thrown Server Function message in production, so the
  // customer-facing messages must come back as values (lib/action-result.ts).
  it("returns a curated checkout message as a value instead of throwing it", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ normalized_status: "active" }) as never);

    const result = await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    expect(result).toEqual({
      ok: false,
      error: "You already have an active subscription. Manage it from the Billing page instead.",
    });
  });

  it("still throws an unexpected failure rather than returning its message", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockRejectedValue(new Error("relation subscriptions_v2 does not exist"));

    await expect(createRazorpaySubscriptionAction(CHECKOUT_INPUT)).rejects.toThrow("relation subscriptions_v2 does not exist");
    await expect(cancelRazorpaySubscriptionAction()).rejects.toThrow("relation subscriptions_v2 does not exist");
  });
});

describe("getRazorpayCheckoutStatusAction", () => {
  // Real Razorpay subscription ids are "sub_" + alphanumerics.
  const PAID_SUBSCRIPTION_ID = "sub_Pq8aX2kLm9Zt41";

  function grantingView(overrides: Record<string, unknown> = {}) {
    return { provider: "razorpay", grantsAccess: true, ...overrides } as never;
  }

  it("reports confirmed once the webhook-written row for this exact subscription grants access", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ provider_subscription_id: PAID_SUBSCRIPTION_ID }) as never);
    mockGetActiveSubscriptionView.mockResolvedValue(grantingView());

    await expect(getRazorpayCheckoutStatusAction(PAID_SUBSCRIPTION_ID)).resolves.toEqual({ confirmed: true });
    expect(mockGetSubscriptionV2).toHaveBeenCalledWith(expect.anything(), ORGANIZATION.id);
  });

  it("is not confirmed before the webhook has written anything, even though the client reported success", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(null);
    mockGetActiveSubscriptionView.mockResolvedValue(grantingView({ provider: null, grantsAccess: false }));

    await expect(getRazorpayCheckoutStatusAction(PAID_SUBSCRIPTION_ID)).resolves.toEqual({ confirmed: false });
  });

  it("is not confirmed for a different subscription than the one just paid for", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ provider_subscription_id: "sub_older" }) as never);
    mockGetActiveSubscriptionView.mockResolvedValue(grantingView());

    await expect(getRazorpayCheckoutStatusAction(PAID_SUBSCRIPTION_ID)).resolves.toEqual({ confirmed: false });
  });

  it("is not confirmed when the row exists but doesn't grant access (e.g. halted, or period lapsed)", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(razorpaySubscription({ provider_subscription_id: PAID_SUBSCRIPTION_ID, normalized_status: "suspended" }) as never);
    mockGetActiveSubscriptionView.mockResolvedValue(grantingView({ grantsAccess: false }));

    await expect(getRazorpayCheckoutStatusAction(PAID_SUBSCRIPTION_ID)).resolves.toEqual({ confirmed: false });
  });

  it("rejects an unauthenticated caller before reading anything", async () => {
    await expect(getRazorpayCheckoutStatusAction(PAID_SUBSCRIPTION_ID)).rejects.toThrow(/Unauthorized/);
    expect(mockGetSubscriptionV2).not.toHaveBeenCalled();
  });

  it("rejects a malformed subscription id", async () => {
    mockRequireUser.mockResolvedValue(USER as never);
    await expect(getRazorpayCheckoutStatusAction("not-a-subscription-id")).rejects.toBeTruthy();
    expect(mockGetSubscriptionV2).not.toHaveBeenCalled();
  });
});

describe("createRazorpaySubscriptionAction — durable one-open-checkout claim", () => {
  beforeEach(() => {
    mockRequireUser.mockResolvedValue(USER as never);
    mockGetSubscriptionV2.mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // What Razorpay returns for an open checkout's subscription and its plan:
  // INR Starter 1-month, created by this organization, not yet paid.
  function mockResume(
    subscriptionOverrides: Record<string, unknown> = {},
    planOverrides: Record<string, unknown> = {},
  ) {
    const create = vi.fn(async () => ({ id: "sub_should_not_exist" }));
    const fetchSubscription = vi.fn(async () => ({
      id: "sub_open",
      plan_id: INR_STARTER_1M,
      customer_id: null,
      status: "created",
      notes: { organization_id: ORGANIZATION.id, internal_plan_id: "starter", billing_interval: "1_month", currency: "INR" },
      ...subscriptionOverrides,
    }));
    const fetchPlan = vi.fn(async () => ({
      id: INR_STARTER_1M,
      period: "monthly",
      interval: 1,
      item: { amount: 115_200, currency: "INR" },
      ...planOverrides,
    }));
    mockGetRazorpayClient.mockReturnValue({
      subscriptions: { create, fetch: fetchSubscription },
      plans: { fetch: fetchPlan },
    } as unknown as ReturnType<typeof getRazorpayClient>);
    return { create, fetchSubscription };
  }

  function existingCheckout(providerSubscriptionId: string | null) {
    mockClaim.mockResolvedValue({ outcome: "existing", checkoutId: "checkout-1", providerSubscriptionId });
  }

  it("claims the checkout for the caller's own organization and offering before creating the subscription, then attaches its id", async () => {
    const create = mockCreate(async () => ({ id: "sub_new" }));

    const result = await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    expect(result).toMatchObject({ ok: true, data: { subscriptionId: "sub_new" } });
    expect(mockClaim).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORGANIZATION.id,
      internalPlanId: "starter",
      billingInterval: "1_month",
      currency: "INR",
    });
    expect(mockClaim.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(mockAttach).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(CLAIM), "sub_new");
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("keeps the billing:checkout_start rate limit in front of the claim", async () => {
    mockCreate(async () => ({ id: "sub_new" }));

    await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    const startCall = mockCheckRateLimit.mock.calls.findIndex(([scope]) => scope === "billing:checkout_start");
    expect(startCall).toBeGreaterThanOrEqual(0);
    expect(mockCheckRateLimit.mock.invocationCallOrder[startCall]).toBeLessThan(mockClaim.mock.invocationCallOrder[0]);
  });

  it("never creates a subscription when the claim itself fails (e.g. caller not a member)", async () => {
    const create = mockCreate(async () => ({ id: "sub_new" }));
    mockClaim.mockRejectedValue(new Error("not authorized for this organization"));

    await expect(createRazorpaySubscriptionAction(CHECKOUT_INPUT)).rejects.toThrow();

    expect(create).not.toHaveBeenCalled();
  });

  it("never claims for a request rejected earlier (live subscription, unavailable offering)", async () => {
    mockGetSubscriptionV2.mockResolvedValueOnce(razorpaySubscription({ normalized_status: "active" }) as never);
    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/already have an active subscription/) });

    expect((await createRazorpaySubscriptionAction({ planId: "growth", interval: "1_month" })).ok).toBe(false);

    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("releases the claim when Razorpay explicitly fails to create the subscription, so the org isn't blocked", async () => {
    mockCreate(async () => {
      throw { statusCode: 500, error: { description: "internal razorpay detail" } };
    });

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: "Couldn't start checkout. Try again shortly or contact support." });

    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(CLAIM));
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it("still returns the sanitized error if releasing the claim also fails", async () => {
    mockCreate(async () => {
      throw new Error("razorpay down");
    });
    mockRelease.mockRejectedValue(new Error("db down"));

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: "Couldn't start checkout. Try again shortly or contact support." });
  });

  it("returns the created subscription even if attaching its id fails — it exists at Razorpay, so the claim is kept, not released", async () => {
    mockCreate(async () => ({ id: "sub_new" }));
    mockAttach.mockRejectedValue(new Error("db down"));

    await expect(createRazorpaySubscriptionAction(CHECKOUT_INPUT)).resolves.toEqual({
      ok: true,
      data: { subscriptionId: "sub_new", prefillEmail: USER.email },
    });
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("reuses an open checkout's existing subscription for the same offering instead of creating another", async () => {
    existingCheckout("sub_open");
    const { create, fetchSubscription } = mockResume();

    const result = await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    expect(result).toEqual({ ok: true, data: { subscriptionId: "sub_open", prefillEmail: USER.email } });
    expect(fetchSubscription).toHaveBeenCalledWith("sub_open");
    expect(create).not.toHaveBeenCalled();
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it("never creates a second subscription while another request holds the claim without a provider id yet", async () => {
    existingCheckout(null);
    const { create, fetchSubscription } = mockResume();

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/still being prepared/) });

    expect(create).not.toHaveBeenCalled();
    expect(fetchSubscription).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("rejects a different plan, interval or currency while another checkout is open, without touching Razorpay", async () => {
    mockClaim.mockResolvedValue({ outcome: "conflict" });
    const { create } = mockResume();

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/Another checkout is already in progress/) });

    expect(create).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  const OWN_NOTES = { organization_id: ORGANIZATION.id, internal_plan_id: "starter", billing_interval: "1_month", currency: "INR" };

  it.each([
    ["another organization's subscription", { notes: { ...OWN_NOTES, organization_id: "org-2" } }, {}],
    ["a different plan in its notes", { notes: { ...OWN_NOTES, internal_plan_id: "pro" } }, {}],
    ["a different interval in its notes", { notes: { ...OWN_NOTES, billing_interval: "3_month" } }, {}],
    ["a different currency in its notes", { notes: { ...OWN_NOTES, currency: "USD" } }, {}],
    ["a plan charging the wrong amount", {}, { item: { amount: 1, currency: "INR" } }],
    ["a plan in the wrong currency", {}, { item: { amount: 115_200, currency: "USD" } }],
    ["a plan on the wrong cycle", {}, { period: "yearly" }],
    ["a different subscription than requested", { id: "sub_other" }, {}],
  ])("refuses to reopen an existing subscription with %s, and never creates another", async (_, subscriptionOverrides, planOverrides) => {
    existingCheckout("sub_open");
    const { create } = mockResume(subscriptionOverrides, planOverrides);

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/can't be reopened/) });

    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to reopen a subscription that is no longer payable (already authenticated, active or cancelled)", async () => {
    existingCheckout("sub_open");
    for (const status of ["authenticated", "active", "cancelled"]) {
      const { create } = mockResume({ status });
      expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/can't be reopened/) });
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("sanitizes a failed re-fetch of the existing subscription and never creates another", async () => {
    existingCheckout("sub_open");
    const { create, fetchSubscription } = mockResume();
    fetchSubscription.mockRejectedValue({ statusCode: 502, error: { description: "raw provider detail" } });

    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: "Couldn't start checkout. Try again shortly or contact support." });
    expect(create).not.toHaveBeenCalled();
  });

  it("never attaches to or releases an existing checkout — it has no token for one, in progress or not", async () => {
    existingCheckout(null);
    mockResume();
    expect(await createRazorpaySubscriptionAction(CHECKOUT_INPUT)).toEqual({ ok: false, error: expect.stringMatching(/still being prepared/) });

    existingCheckout("sub_open");
    mockResume();
    await createRazorpaySubscriptionAction(CHECKOUT_INPUT);

    expect(mockAttach).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("never lets the claim token reach a log line, an error or the response, on any path", async () => {
    const logged: unknown[] = [];
    for (const method of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    const outcomes: unknown[] = [];
    const run = async () => {
      try {
        outcomes.push(await createRazorpaySubscriptionAction(CHECKOUT_INPUT));
      } catch (error) {
        outcomes.push(error instanceof Error ? error.message : error);
      }
    };

    // Success.
    mockCreate(async () => ({ id: "sub_new" }));
    await run();
    // Razorpay fails; the release then fails too.
    mockCreate(async () => {
      throw new Error("razorpay down");
    });
    mockRelease.mockRejectedValueOnce(new Error("db down"));
    await run();
    // Attach reports nothing attached, then attach throws.
    mockCreate(async () => ({ id: "sub_new" }));
    mockAttach.mockResolvedValueOnce(false);
    await run();
    mockAttach.mockRejectedValueOnce(new Error("db down"));
    await run();

    expect(logged.length).toBeGreaterThan(0);
    const serialized = JSON.stringify([logged.map((entry) => (entry instanceof Error ? entry.message : entry)), outcomes]);
    expect(serialized).not.toContain(CLAIM_TOKEN);
  });
});
