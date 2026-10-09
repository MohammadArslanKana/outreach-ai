import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/db", () => ({
  createLead: vi.fn(),
  updateLead: vi.fn(),
  setLeadsTimezone: vi.fn(),
}));
vi.mock("@/lib/billing/limits", () => ({
  assertWithinLeadLimit: vi.fn(),
  PlanLimitError: class PlanLimitError extends Error {},
}));
vi.mock("@/lib/verification/verify", () => ({ verifyLead: vi.fn() }));
vi.mock("@/lib/rate-limit/check-rate-limit", () => ({ checkRateLimit: vi.fn() }));

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/auth";
import { createLead, setLeadsTimezone, updateLead } from "@/lib/db";
import { assertWithinLeadLimit, PlanLimitError } from "@/lib/billing/limits";
import { createLeadAction, setLeadsTimezoneAction, updateLeadAction } from "./actions";

const mockRequireUser = vi.mocked(requireUser);
const mockCreateLead = vi.mocked(createLead);
const mockUpdateLead = vi.mocked(updateLead);
const mockSetLeadsTimezone = vi.mocked(setLeadsTimezone);

const LEAD_A = "11111111-1111-4111-8111-111111111111";
const LEAD_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: "user-1", email: "owner@example.com" } as never);
  mockCreateLead.mockResolvedValue({ id: "lead-1" } as never);
  mockUpdateLead.mockResolvedValue({ id: "lead-1" } as never);
  mockSetLeadsTimezone.mockResolvedValue(undefined);
});

describe("lead create/edit timezone", () => {
  it("stores a valid timezone on create", async () => {
    await createLeadAction({ email: "jane@acme.com", timezone: "America/New_York" });

    expect(mockCreateLead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timezone: "America/New_York" }));
  });

  it("stores 'Use campaign timezone' (empty) as null", async () => {
    await updateLeadAction("lead-1", { email: "jane@acme.com", timezone: "" });

    expect(mockUpdateLead).toHaveBeenCalledWith(expect.anything(), "user-1", "lead-1", expect.objectContaining({ timezone: null }));
  });

  it("leaves the timezone untouched when the caller doesn't send one", async () => {
    await updateLeadAction("lead-1", { email: "jane@acme.com" });

    expect(mockUpdateLead.mock.calls[0][3]).not.toHaveProperty("timezone");
  });

  it("rejects an invalid timezone without writing anything", async () => {
    await expect(updateLeadAction("lead-1", { email: "jane@acme.com", timezone: "Mars/Olympus_Mons" })).rejects.toThrow();
    await expect(createLeadAction({ email: "jane@acme.com", timezone: "Mars/Olympus_Mons" })).rejects.toThrow();

    expect(mockUpdateLead).not.toHaveBeenCalled();
    expect(mockCreateLead).not.toHaveBeenCalled();
  });
});

// Returned rather than thrown: a thrown Server Function error's message is
// redacted in production — see lib/action-result.ts.
describe("createLeadAction — plan limit", () => {
  const LEAD_LIMIT = "Your account has no active subscription. The current limit allows up to 200 leads. Upgrade to add more.";

  it("returns the lead-limit message and creates nothing", async () => {
    vi.mocked(assertWithinLeadLimit).mockRejectedValueOnce(new PlanLimitError(LEAD_LIMIT));

    const result = await createLeadAction({ email: "jane@acme.com" });

    expect(result).toEqual({ ok: false, error: LEAD_LIMIT });
    expect(mockCreateLead).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns ok when the lead is created", async () => {
    expect(await createLeadAction({ email: "jane@acme.com" })).toEqual({ ok: true, data: undefined });
  });
});

describe("setLeadsTimezoneAction (bulk)", () => {
  it("sets a timezone on the selected leads, scoped to the signed-in user", async () => {
    await setLeadsTimezoneAction({ ids: [LEAD_A, LEAD_B], timezone: "Europe/Berlin" });

    expect(mockSetLeadsTimezone).toHaveBeenCalledWith(expect.anything(), "user-1", [LEAD_A, LEAD_B], "Europe/Berlin");
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
  });

  it("clears the timezone ('Use campaign timezone') with null", async () => {
    await setLeadsTimezoneAction({ ids: [LEAD_A], timezone: null });

    expect(mockSetLeadsTimezone).toHaveBeenCalledWith(expect.anything(), "user-1", [LEAD_A], null);
  });

  it.each([
    ["an invalid timezone", { ids: [LEAD_A], timezone: "Not/A_Zone" }],
    ["no selected leads", { ids: [], timezone: null }],
    ["a malformed lead id", { ids: ["lead-1"], timezone: null }],
  ])("rejects %s without writing anything", async (_label, input) => {
    await expect(setLeadsTimezoneAction(input)).rejects.toThrow();
    expect(mockSetLeadsTimezone).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    mockRequireUser.mockRejectedValue(new Error("Not signed in"));

    await expect(setLeadsTimezoneAction({ ids: [LEAD_A], timezone: null })).rejects.toThrow("Not signed in");
    expect(mockSetLeadsTimezone).not.toHaveBeenCalled();
  });
});
