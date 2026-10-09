import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same "mock the seam" approach as app/(app)/billing/actions.test.ts and
// app/(app)/campaigns/actions.test.ts — only the DB/auth/rate-limit boundary
// is mocked. This file's other exports (createSequenceStepAction, the
// attachment actions, etc.) are never invoked here, so their own unused
// lib/db imports resolving to `undefined` in this mock is harmless.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/supabase/auth", () => ({
  requireUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db", () => ({
  getCampaign: vi.fn(),
  getCampaignLead: vi.fn(),
  getLead: vi.fn(),
  updateCampaignLead: vi.fn(),
  getUserOrganization: vi.fn(),
  // Batch 8: enrollLeadAction/enrollLeadListAction's dependencies.
  getSuppressedEmails: vi.fn(),
  listCampaignMailboxes: vi.fn(),
  listCampaignLeads: vi.fn(),
  listCampaignLeadsWithTimezones: vi.fn(),
  addLeadToCampaign: vi.fn(),
  addLeadsToCampaign: vi.fn(),
  listLeads: vi.fn(),
  listSequences: vi.fn(),
  listSequenceSteps: vi.fn(),
  // Batch 8: launchCampaignAction's dependencies, and the mailbox pool
  // membership actions.
  listMailboxes: vi.fn(),
  listDomains: vi.fn(),
  updateCampaign: vi.fn(),
  addCampaignMailbox: vi.fn(),
  removeCampaignMailbox: vi.fn(),
  // Batch B: Send Now's atomic RPC wrapper.
  requestSendNow: vi.fn(),
  // Batch D: segment enrollment.
  getLeadSegment: vi.fn(),
  listLeadsMatchingRules: vi.fn(),
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

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/auth";
import {
  addCampaignMailbox,
  addLeadsToCampaign,
  addLeadToCampaign,
  getCampaign,
  getCampaignLead,
  getLead,
  getLeadSegment,
  getSuppressedEmails,
  getUserOrganization,
  listCampaignLeads,
  listCampaignLeadsWithTimezones,
  listCampaignMailboxes,
  listDomains,
  listLeads,
  listLeadsMatchingRules,
  listMailboxes,
  listSequences,
  listSequenceSteps,
  removeCampaignMailbox,
  requestSendNow,
  updateCampaign,
  updateCampaignLead,
} from "@/lib/db";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit/check-rate-limit";
import {
  addCampaignMailboxAction,
  enrollLeadAction,
  enrollLeadListAction,
  enrollLeadSegmentAction,
  launchCampaignAction,
  pauseCampaignAction,
  removeCampaignMailboxAction,
  resumeCampaignAction,
  sendNowAction,
  stopCampaignAction,
} from "./actions";
import type { Tables } from "@/types/database.types";

const mockRequireUser = vi.mocked(requireUser);
const mockGetCampaign = vi.mocked(getCampaign);
const mockGetCampaignLead = vi.mocked(getCampaignLead);
const mockUpdateCampaignLead = vi.mocked(updateCampaignLead);
const mockGetUserOrganization = vi.mocked(getUserOrganization);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetSuppressedEmails = vi.mocked(getSuppressedEmails);
const mockListCampaignMailboxes = vi.mocked(listCampaignMailboxes);
const mockListCampaignLeads = vi.mocked(listCampaignLeads);
const mockListCampaignLeadsWithTimezones = vi.mocked(listCampaignLeadsWithTimezones);
const mockGetLead = vi.mocked(getLead);
const mockAddLeadToCampaign = vi.mocked(addLeadToCampaign);
const mockAddLeadsToCampaign = vi.mocked(addLeadsToCampaign);
const mockListLeads = vi.mocked(listLeads);
const mockListSequences = vi.mocked(listSequences);
const mockListSequenceSteps = vi.mocked(listSequenceSteps);
const mockListMailboxes = vi.mocked(listMailboxes);
const mockListDomains = vi.mocked(listDomains);
const mockUpdateCampaign = vi.mocked(updateCampaign);
const mockAddCampaignMailbox = vi.mocked(addCampaignMailbox);
const mockRemoveCampaignMailbox = vi.mocked(removeCampaignMailbox);
const mockRevalidatePath = vi.mocked(revalidatePath);
const mockRequestSendNow = vi.mocked(requestSendNow);
const mockGetLeadSegment = vi.mocked(getLeadSegment);
const mockListLeadsMatchingRules = vi.mocked(listLeadsMatchingRules);

// Expected failures come back as a value (see lib/action-result.ts) rather
// than a thrown error, whose message Next.js redacts in production builds.
function failure(message: string | RegExp) {
  return { ok: false, error: typeof message === "string" ? message : expect.stringMatching(message) };
}

const USER ={ id: "user-1", email: "owner@example.com" };
const ORGANIZATION = { id: "org-1" };

function makeCampaign(overrides: Partial<Tables<"campaigns">> = {}): Tables<"campaigns"> {
  return {
    id: "campaign-1",
    user_id: "user-1",
    name: "Q3 outbound",
    status: "active",
    sending_window: {},
    daily_limit: 50,
    default_mailbox_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCampaignLead(overrides: Partial<Tables<"campaign_leads">> = {}): Tables<"campaign_leads"> {
  return {
    id: "cl-1",
    campaign_id: "campaign-1",
    lead_id: "lead-1",
    mailbox_id: "mailbox-1",
    current_step_id: "step-1",
    status: "active",
    next_send_at: "2026-09-20T09:00:00.000Z",
    send_now_step_id: null,
    locked_until: null,
    last_error: null,
    enrolled_at: "2026-09-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

// Batch 8: launchCampaignAction fixtures — a minimal active mailbox
// (id/display_name/email/status/daily_limit/hourly_limit is all
// checkCampaignReadiness reads, see lib/campaigns/readiness.ts) and a
// single-step sequence, just enough for readiness to pass and for
// scheduleOnEnrollment's real (unmocked) computeNextSchedule to run without
// throwing.
function makeMailbox(overrides: Partial<{ id: string; display_name: string; email: string; status: string; daily_limit: number; hourly_limit: number }> = {}) {
  return {
    id: "mailbox-1",
    display_name: "Sales",
    email: "sales@example.com",
    status: "active",
    daily_limit: 50,
    hourly_limit: 10,
    ...overrides,
  };
}

function makeSequenceStep(overrides: Partial<Tables<"sequence_steps">> = {}): Tables<"sequence_steps"> {
  return {
    id: "step-1",
    sequence_id: "seq-1",
    step_order: 0,
    day_delay: 0,
    subject: "Hi {{firstName}}",
    body: "Body",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
  mockRequireUser.mockResolvedValue(USER as never);
  mockGetUserOrganization.mockResolvedValue(ORGANIZATION as never);
  mockCheckRateLimit.mockResolvedValue(undefined);
  mockGetCampaign.mockResolvedValue(makeCampaign() as never);
  mockGetCampaignLead.mockResolvedValue(makeCampaignLead() as never);
  mockUpdateCampaignLead.mockResolvedValue(makeCampaignLead() as never);
  // Batch 8 defaults: no suppression, no pool, no existing leads, no
  // sequence — enrollLeadAction/enrollLeadListAction's tests below override
  // only what each scenario needs.
  mockGetSuppressedEmails.mockResolvedValue(new Map());
  mockListCampaignMailboxes.mockResolvedValue([]);
  mockListCampaignLeads.mockResolvedValue([]);
  mockListCampaignLeadsWithTimezones.mockResolvedValue([]);
  mockGetLead.mockResolvedValue({ id: "lead-1", email: "lead-1@example.com", timezone: null } as never);
  mockAddLeadToCampaign.mockResolvedValue(makeCampaignLead() as never);
  mockAddLeadsToCampaign.mockResolvedValue({ inserted: 0, skipped: 0, rows: [] });
  mockListLeads.mockResolvedValue([]);
  mockListSequences.mockResolvedValue([]);
  mockListSequenceSteps.mockResolvedValue([]);
  // launchCampaignAction/addCampaignMailboxAction/removeCampaignMailboxAction
  // defaults — the launchCampaignAction describe block below overrides these
  // per scenario.
  mockListMailboxes.mockResolvedValue([]);
  mockListDomains.mockResolvedValue([]);
  mockUpdateCampaign.mockResolvedValue(makeCampaign({ status: "active" }) as never);
  mockAddCampaignMailbox.mockResolvedValue({
    id: "cm-1",
    campaign_id: "campaign-1",
    mailbox_id: "mailbox-1",
    created_at: "2026-01-01T00:00:00Z",
  } as never);
  mockRemoveCampaignMailbox.mockResolvedValue(undefined as never);
  mockRequestSendNow.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sendNowAction", () => {
  it("records an explicit Send Now for an eligible, active, queued lead through request_send_now", async () => {
    await sendNowAction("campaign-1", "cl-1");

    expect(mockRequestSendNow).toHaveBeenCalledTimes(1);
    expect(mockRequestSendNow).toHaveBeenCalledWith(expect.anything(), "cl-1");
  });

  it("never writes the lead row directly — only the atomic RPC may set the bypass", async () => {
    await sendNowAction("campaign-1", "cl-1");

    expect(mockUpdateCampaignLead).not.toHaveBeenCalled();
  });

  it("is idempotent — calling it twice in a row is safe and never duplicates a queue entry", async () => {
    await sendNowAction("campaign-1", "cl-1");
    await sendNowAction("campaign-1", "cl-1");

    // Two calls, each an update of the same single row inside
    // request_send_now — never an insert, so no second queue entry.
    expect(mockRequestSendNow).toHaveBeenCalledTimes(2);
    for (const call of mockRequestSendNow.mock.calls) {
      expect(call[1]).toBe("cl-1");
    }
  });

  it("preserves the lead's assigned mailbox (never reassigns mailbox_id)", async () => {
    mockGetCampaignLead.mockResolvedValue(makeCampaignLead({ mailbox_id: "mailbox-sticky" }) as never);

    await sendNowAction("campaign-1", "cl-1");

    // request_send_now takes only the lead id and writes only next_send_at
    // and send_now_step_id (see its migration).
    expect(mockRequestSendNow.mock.calls[0]).toHaveLength(2);
    expect(mockUpdateCampaignLead).not.toHaveBeenCalled();
  });

  it("surfaces a refusal from request_send_now (e.g. the worker claimed the lead first)", async () => {
    mockRequestSendNow.mockResolvedValue(false);

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/already being sent or is no longer eligible/i));
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects when the campaign is paused (respects pause protection)", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "paused" }) as never);

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/active campaign/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });

  it("rejects when the campaign is a draft", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "draft" }) as never);

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/active campaign/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });

  it("rejects when the campaign is completed", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "completed" }) as never);

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/active campaign/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });

  it("rejects a lead that isn't active (e.g. bounced/unsubscribed/completed/needs_review)", async () => {
    for (const status of ["bounced", "unsubscribed", "completed", "needs_review", "failed", "cancelled", "pending"]) {
      mockRequestSendNow.mockClear();
      mockGetCampaignLead.mockResolvedValue(makeCampaignLead({ status }) as never);

      expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/isn't currently active/i));
      expect(mockRequestSendNow).not.toHaveBeenCalled();
    }
  });

  it("rejects a lead with no pending step", async () => {
    mockGetCampaignLead.mockResolvedValue(makeCampaignLead({ current_step_id: null }) as never);

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/no pending step/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });

  it("rejects a lead with no assigned mailbox", async () => {
    mockGetCampaignLead.mockResolvedValue(makeCampaignLead({ mailbox_id: null }) as never);

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/no assigned mailbox/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });

  it("rejects a lead that's currently locked by an in-flight send", async () => {
    mockGetCampaignLead.mockResolvedValue(
      makeCampaignLead({ locked_until: "2026-09-18T12:05:00.000Z" }) as never, // 5 min in the future
    );

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/already being sent/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });

  it("allows a lead whose lock has already expired", async () => {
    mockGetCampaignLead.mockResolvedValue(
      makeCampaignLead({ locked_until: "2026-09-18T11:00:00.000Z" }) as never, // 1 hour in the past
    );

    await sendNowAction("campaign-1", "cl-1");

    expect(mockRequestSendNow).toHaveBeenCalledTimes(1);
  });

  it("rejects a campaign_lead that belongs to a different campaign", async () => {
    mockGetCampaignLead.mockResolvedValue(makeCampaignLead({ campaign_id: "some-other-campaign" }) as never);

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/does not belong/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });

  it("checks the campaign:send_now rate limit scope", async () => {
    await sendNowAction("campaign-1", "cl-1");
    expect(mockCheckRateLimit).toHaveBeenCalledWith("campaign:send_now", "org-1");
  });

  it("propagates a rate-limit rejection without touching the lead", async () => {
    const { RateLimitError } = await import("@/lib/rate-limit/check-rate-limit");
    mockCheckRateLimit.mockRejectedValue(new RateLimitError(60));

    expect(await sendNowAction("campaign-1", "cl-1")).toEqual(failure(/too many attempts/i));
    expect(mockRequestSendNow).not.toHaveBeenCalled();
  });
});

describe("pauseCampaignAction", () => {
  // Pending Send Now requests are cleared by the database in the same
  // transaction as the status change (campaigns_clear_send_now_on_inactive,
  // covered in supabase/tests/send_now.test.sql), not by this action.
  it("pauses through the status update only", async () => {
    await pauseCampaignAction("campaign-1");

    expect(mockUpdateCampaign).toHaveBeenCalledWith(expect.anything(), "user-1", "campaign-1", { status: "paused" });
    expect(mockUpdateCampaignLead).not.toHaveBeenCalled();
  });

  it("rejects a campaign that isn't running", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "paused" }) as never);

    expect(await pauseCampaignAction("campaign-1")).toEqual(failure(/only a running campaign/i));
    expect(mockUpdateCampaign).not.toHaveBeenCalled();
  });
});

// Regression: these used to be thrown, which Next.js production builds reduce
// to an opaque digest — the user saw a generic error instead of the reason.
describe("user-facing errors are returned as values", () => {
  it("returns each state-transition message verbatim for a draft campaign", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "draft" }) as never);

    expect(await pauseCampaignAction("campaign-1")).toEqual(failure("Only a running campaign can be paused."));
    expect(await resumeCampaignAction("campaign-1")).toEqual(failure("Only a paused campaign can be resumed."));
    expect(await stopCampaignAction("campaign-1")).toEqual(failure("Only a running or paused campaign can be stopped."));
    expect(mockUpdateCampaign).not.toHaveBeenCalled();
  });

  it("returns a generic message for an unexpected failure, never the internal detail, and logs it server-side", async () => {
    const internal = new Error('permission denied for table campaigns (SQLSTATE 42501) at /var/task/.next/server/chunk.js:1:2');
    mockGetCampaign.mockRejectedValue(internal);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pauseCampaignAction("campaign-1");

    expect(result).toEqual({ ok: false, error: "Something went wrong. Try again." });
    expect(JSON.stringify(result)).not.toMatch(/permission|SQLSTATE|\/var\/task/);
    expect(consoleError).toHaveBeenCalledWith("[campaigns] unexpected error", internal);
    consoleError.mockRestore();
  });

  it("returns ok with no error on success", async () => {
    expect(await pauseCampaignAction("campaign-1")).toEqual({ ok: true, data: undefined });
  });
});

// Batch 8: mailbox resolution order at enrollment — explicit override wins,
// otherwise round-robin across the configured pool, falling back to
// campaign.default_mailbox_id when there's no pool. confirmSuppressed=true
// throughout so these tests never need to exercise the (unrelated)
// suppression-check branch.
describe("enrollLeadAction", () => {
  it("uses the explicit mailbox override, never touching the pool", async () => {
    await enrollLeadAction("campaign-1", "lead-1", "mailbox-explicit", true);

    expect(mockListCampaignMailboxes).not.toHaveBeenCalled();
    expect(mockAddLeadToCampaign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox_id: "mailbox-explicit" }),
    );
  });

  it("round-robins across the pool using the current enrolled-lead count as the index", async () => {
    mockListCampaignMailboxes.mockResolvedValue([
      { id: "cm-1", campaign_id: "campaign-1", mailbox_id: "mailbox-1", created_at: "2026-01-01T00:00:00Z" },
      { id: "cm-2", campaign_id: "campaign-1", mailbox_id: "mailbox-2", created_at: "2026-01-01T00:00:00Z" },
    ] as never);
    mockListCampaignLeads.mockResolvedValue([makeCampaignLead({ id: "existing-1" })] as never);

    await enrollLeadAction("campaign-1", "lead-1", undefined, true);

    // One existing lead -> enrollment index 1 -> pool[1 % 2] = mailbox-2.
    expect(mockAddLeadToCampaign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox_id: "mailbox-2" }),
    );
  });

  it("falls back to campaign.default_mailbox_id when the pool is empty (backward compatible)", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ default_mailbox_id: "mailbox-default" }) as never);
    mockListCampaignMailboxes.mockResolvedValue([]);

    await enrollLeadAction("campaign-1", "lead-1", undefined, true);

    expect(mockAddLeadToCampaign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mailbox_id: "mailbox-default" }),
    );
  });

  it("never queries the existing lead count when there is no pool (no extra cost for existing campaigns)", async () => {
    mockListCampaignMailboxes.mockResolvedValue([]);

    await enrollLeadAction("campaign-1", "lead-1", undefined, true);

    expect(mockListCampaignLeads).not.toHaveBeenCalled();
  });
});

describe("enrollLeadListAction", () => {
  function makeLead(id: string, overrides: Partial<Tables<"leads">> = {}): Tables<"leads"> {
    return {
      id,
      user_id: "user-1",
      email: `${id}@example.com`,
      first_name: null,
      last_name: null,
      company: null,
      title: null,
      city: null,
      country: null,
      linkedin: null,
      phone: null,
      website: null,
      timezone: null,
      status: "new",
      list_id: "list-1",
      custom_fields: null,
      verification_status: "unverified",
      verification_detail: null,
      verification_locked_until: null,
      verification_risk_score: null,
      verified_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("passes a resolver that always returns the explicit override, ignoring the pool", async () => {
    mockListLeads.mockResolvedValue([makeLead("lead-a"), makeLead("lead-b")]);

    await enrollLeadListAction("campaign-1", "list-1", "mailbox-explicit", true);

    expect(mockListCampaignMailboxes).not.toHaveBeenCalled();
    const resolver = mockAddLeadsToCampaign.mock.calls[0][3];
    expect(resolver(0)).toBe("mailbox-explicit");
    expect(resolver(5)).toBe("mailbox-explicit");
  });

  it("passes a resolver that round-robins across the pool when there's no override", async () => {
    mockListLeads.mockResolvedValue([makeLead("lead-a"), makeLead("lead-b"), makeLead("lead-c")]);
    mockListCampaignMailboxes.mockResolvedValue([
      { id: "cm-1", campaign_id: "campaign-1", mailbox_id: "mailbox-1", created_at: "2026-01-01T00:00:00Z" },
      { id: "cm-2", campaign_id: "campaign-1", mailbox_id: "mailbox-2", created_at: "2026-01-01T00:00:00Z" },
    ] as never);

    await enrollLeadListAction("campaign-1", "list-1", undefined, true);

    const resolver = mockAddLeadsToCampaign.mock.calls[0][3];
    expect(resolver(0)).toBe("mailbox-1");
    expect(resolver(1)).toBe("mailbox-2");
    expect(resolver(2)).toBe("mailbox-1"); // wraps around
  });

  it("passes a resolver that falls back to campaign.default_mailbox_id when the pool is empty", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ default_mailbox_id: "mailbox-default" }) as never);
    mockListLeads.mockResolvedValue([makeLead("lead-a")]);
    mockListCampaignMailboxes.mockResolvedValue([]);

    await enrollLeadListAction("campaign-1", "list-1", undefined, true);

    const resolver = mockAddLeadsToCampaign.mock.calls[0][3];
    expect(resolver(0)).toBe("mailbox-default");
  });
});

// Batch D: segment enrollment. Ownership, rate limit, suppression
// confirmation and addLeadsToCampaign are the same path list enrollment
// uses (enrollLeadRows); what's specific is loading the segment scoped to
// the caller, re-validating its stored rules, and snapshotting its matches.
describe("enrollLeadSegmentAction", () => {
  const RULES = [{ field: "status", operator: "is", value: "new" }];

  function makeSegment(overrides: Partial<Tables<"lead_segments">> = {}): Tables<"lead_segments"> {
    return {
      id: "seg-1",
      user_id: "user-1",
      name: "New leads",
      description: null,
      rules: RULES,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  function makeLead(id: string): Tables<"leads"> {
    return {
      id,
      user_id: "user-1",
      email: `${id}@example.com`,
      first_name: null,
      last_name: null,
      company: null,
      title: null,
      city: null,
      country: null,
      linkedin: null,
      phone: null,
      website: null,
      timezone: null,
      status: "new",
      list_id: null,
      custom_fields: {},
      verification_status: "unverified",
      verification_detail: null,
      verification_locked_until: null,
      verification_risk_score: null,
      verified_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  beforeEach(() => {
    mockGetLeadSegment.mockResolvedValue(makeSegment() as never);
    mockListLeadsMatchingRules.mockResolvedValue([makeLead("lead-a"), makeLead("lead-b")] as never);
    mockAddLeadsToCampaign.mockResolvedValue({ inserted: 2, skipped: 0, rows: [] });
  });

  it("enrolls the leads matching the segment right now, scoped to the caller, capped at 10,000", async () => {
    const result = await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true);

    expect(mockGetCampaign).toHaveBeenCalledWith(expect.anything(), "user-1", "campaign-1");
    expect(mockGetLeadSegment).toHaveBeenCalledWith(expect.anything(), "user-1", "seg-1");
    expect(mockListLeadsMatchingRules).toHaveBeenCalledWith(expect.anything(), "user-1", RULES, { limit: 10000 });
    expect(mockAddLeadsToCampaign).toHaveBeenCalledWith(
      expect.anything(),
      "campaign-1",
      ["lead-a", "lead-b"],
      expect.any(Function),
    );
    expect(result).toEqual({ ok: true, data: { inserted: 2, skipped: 0 } });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
  });

  it("is a snapshot: each enrollment takes only the then-current matches, and nothing links the campaign to the segment", async () => {
    await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true);
    mockListLeadsMatchingRules.mockResolvedValue([makeLead("lead-c")] as never);
    await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true);

    expect(mockAddLeadsToCampaign.mock.calls[0][2]).toEqual(["lead-a", "lead-b"]);
    expect(mockAddLeadsToCampaign.mock.calls[1][2]).toEqual(["lead-c"]);
    // No campaign or segment is written to remember the segment.
    expect(mockUpdateCampaign).not.toHaveBeenCalled();
    expect(JSON.stringify(mockAddLeadsToCampaign.mock.calls)).not.toContain("seg-1");
  });

  it("checks the campaign:enroll rate limit before loading the segment", async () => {
    await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true);

    expect(mockCheckRateLimit).toHaveBeenCalledWith("campaign:enroll", "org-1");
    expect(mockCheckRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetLeadSegment.mock.invocationCallOrder[0],
    );
  });

  it("enrolls nothing when rate limited", async () => {
    mockCheckRateLimit.mockRejectedValue(new RateLimitError(60));

    expect(await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true)).toEqual(failure(/too many attempts/i));
    expect(mockGetLeadSegment).not.toHaveBeenCalled();
    expect(mockAddLeadsToCampaign).not.toHaveBeenCalled();
  });

  it("enrolls nothing into a campaign the caller doesn't own", async () => {
    mockGetCampaign.mockRejectedValue(new Error("Expected a row, received none."));

    expect(await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true)).toEqual(failure(/something went wrong/i));
    expect(mockGetLeadSegment).not.toHaveBeenCalled();
    expect(mockAddLeadsToCampaign).not.toHaveBeenCalled();
  });

  it("enrolls nothing from a segment the caller doesn't own", async () => {
    mockGetLeadSegment.mockRejectedValue(new Error("Expected a row, received none."));

    expect(await enrollLeadSegmentAction("campaign-1", "seg-other", undefined, true)).toEqual(failure(/something went wrong/i));
    expect(mockListLeadsMatchingRules).not.toHaveBeenCalled();
    expect(mockAddLeadsToCampaign).not.toHaveBeenCalled();
  });

  it("refuses stored rules that no longer validate, without querying leads", async () => {
    mockGetLeadSegment.mockResolvedValue(
      makeSegment({ rules: [{ field: "custom_fields", operator: "equals", value: "x" }] }) as never,
    );

    expect(await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true)).toEqual(failure(/no longer valid/i));
    expect(mockListLeadsMatchingRules).not.toHaveBeenCalled();
    expect(mockAddLeadsToCampaign).not.toHaveBeenCalled();
  });

  it("requires confirmation when a matching lead is suppressed, and enrolls once confirmed", async () => {
    mockGetSuppressedEmails.mockResolvedValue(new Map([["lead-b@example.com", "unsubscribed"]]) as never);

    expect(await enrollLeadSegmentAction("campaign-1", "seg-1")).toEqual(failure("1 lead in this segment is suppressed (bounced/unsubscribed). Confirm to enroll anyway."));
    expect(mockAddLeadsToCampaign).not.toHaveBeenCalled();

    await enrollLeadSegmentAction("campaign-1", "seg-1", undefined, true);
    expect(mockAddLeadsToCampaign).toHaveBeenCalledTimes(1);
  });

  it("keeps list enrollment's own wording and cap after sharing the enrollment path", async () => {
    mockListLeads.mockResolvedValue([makeLead("lead-a")]);
    mockGetSuppressedEmails.mockResolvedValue(new Map([["lead-a@example.com", "bounced"]]) as never);

    expect(await enrollLeadListAction("campaign-1", "list-1")).toEqual(failure("1 lead in this list is suppressed (bounced/unsubscribed). Confirm to enroll anyway."));
    expect(mockListLeads).toHaveBeenCalledWith(expect.anything(), "user-1", { listId: "list-1", limit: 10000 });
  });
});

// Batch 8: launch-time backfill for leads enrolled before any mailbox
// config existed (mailbox_id still null) — round-robins across the pool
// when one is configured, same resolution order as enrollment
// (resolvePoolMailboxId ?? resolveLeadMailboxId), and only ever touches
// leads that actually need it.
describe("launchCampaignAction", () => {
  // updateCampaignLead is reused for two different writes per lead in this
  // action: the mailbox_id backfill, and scheduleOnEnrollment's own
  // current_step_id/next_send_at/status write. Isolate just the backfill
  // writes for assertions below.
  function mailboxBackfillCalls() {
    return mockUpdateCampaignLead.mock.calls
      .filter(([, , values]) => values !== null && typeof values === "object" && "mailbox_id" in values)
      .map(([, id, values]) => [id, (values as { mailbox_id: string | null }).mailbox_id]);
  }

  it("backfills leads with no mailbox round-robin across the pool when default_mailbox_id is null (pool-only campaign)", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "draft", default_mailbox_id: null }) as never);
    mockListCampaignLeadsWithTimezones.mockResolvedValue([
      makeCampaignLead({ id: "lead-1", mailbox_id: null, status: "pending" }),
      makeCampaignLead({ id: "lead-2", mailbox_id: null, status: "pending" }),
      makeCampaignLead({ id: "lead-3", mailbox_id: null, status: "pending" }),
    ] as never);
    mockListCampaignMailboxes.mockResolvedValue([
      { id: "cm-1", campaign_id: "campaign-1", mailbox_id: "mailbox-1", created_at: "2026-01-01T00:00:00Z" },
      { id: "cm-2", campaign_id: "campaign-1", mailbox_id: "mailbox-2", created_at: "2026-01-01T00:00:00Z" },
    ] as never);
    mockListMailboxes.mockResolvedValue([makeMailbox({ id: "mailbox-1" }), makeMailbox({ id: "mailbox-2" })] as never);
    mockListSequences.mockResolvedValue([{ id: "seq-1", campaign_id: "campaign-1", name: "Default", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] as never);
    mockListSequenceSteps.mockResolvedValue([makeSequenceStep()]);

    await launchCampaignAction("campaign-1");

    expect(mockUpdateCampaign).toHaveBeenCalledWith(expect.anything(), "user-1", "campaign-1", { status: "active" });
    expect(mailboxBackfillCalls()).toEqual([
      ["lead-1", "mailbox-1"],
      ["lead-2", "mailbox-2"],
      ["lead-3", "mailbox-1"], // wraps around
    ]);
  });

  it("only backfills leads with no mailbox_id, and the rotation index only counts backfilled leads", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "draft", default_mailbox_id: null }) as never);
    mockListCampaignLeadsWithTimezones.mockResolvedValue([
      makeCampaignLead({ id: "lead-preassigned", mailbox_id: "mailbox-preassigned", status: "pending" }),
      makeCampaignLead({ id: "lead-null-1", mailbox_id: null, status: "pending" }),
      makeCampaignLead({ id: "lead-null-2", mailbox_id: null, status: "pending" }),
    ] as never);
    mockListCampaignMailboxes.mockResolvedValue([
      { id: "cm-1", campaign_id: "campaign-1", mailbox_id: "mailbox-1", created_at: "2026-01-01T00:00:00Z" },
      { id: "cm-2", campaign_id: "campaign-1", mailbox_id: "mailbox-2", created_at: "2026-01-01T00:00:00Z" },
    ] as never);
    mockListMailboxes.mockResolvedValue([
      makeMailbox({ id: "mailbox-preassigned" }),
      makeMailbox({ id: "mailbox-1" }),
      makeMailbox({ id: "mailbox-2" }),
    ] as never);
    mockListSequences.mockResolvedValue([{ id: "seq-1", campaign_id: "campaign-1", name: "Default", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] as never);
    mockListSequenceSteps.mockResolvedValue([makeSequenceStep()]);

    await launchCampaignAction("campaign-1");

    // The already-assigned lead is never touched by the backfill; the two
    // null leads get index 0 and 1 (not 1 and 2 — the preassigned lead
    // doesn't consume a rotation slot).
    expect(mailboxBackfillCalls()).toEqual([
      ["lead-null-1", "mailbox-1"],
      ["lead-null-2", "mailbox-2"],
    ]);
  });

  it("blocks launch when leads are genuinely unresolvable (no pool, no default) and never touches any lead", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ status: "draft", default_mailbox_id: null }) as never);
    mockListCampaignLeadsWithTimezones.mockResolvedValue([
      makeCampaignLead({ id: "lead-1", mailbox_id: null, status: "pending" }),
    ] as never);
    mockListCampaignMailboxes.mockResolvedValue([]);
    mockListMailboxes.mockResolvedValue([]);
    mockListSequences.mockResolvedValue([{ id: "seq-1", campaign_id: "campaign-1", name: "Default", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] as never);
    mockListSequenceSteps.mockResolvedValue([makeSequenceStep()]);

    expect(await launchCampaignAction("campaign-1")).toEqual(failure(/no mailbox assigned/i));

    expect(mockUpdateCampaign).not.toHaveBeenCalled();
    expect(mockUpdateCampaignLead).not.toHaveBeenCalled();
  });
});

// Batch 8: mailbox pool membership toggles — both re-check ownership via
// getCampaign before mutating campaign_mailboxes (the DB-level ownership
// trigger is defense-in-depth, not a substitute — see actions.ts's own
// comment), and revalidate the campaign detail path on success.
describe("addCampaignMailboxAction", () => {
  it("checks campaign ownership, adds the mailbox, and revalidates the campaign path", async () => {
    await addCampaignMailboxAction("campaign-1", "mailbox-1");

    expect(mockGetCampaign).toHaveBeenCalledWith(expect.anything(), "user-1", "campaign-1");
    expect(mockAddCampaignMailbox).toHaveBeenCalledWith(expect.anything(), "campaign-1", "mailbox-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
  });

  it("never adds the mailbox when the ownership check fails", async () => {
    mockGetCampaign.mockRejectedValue(new Error("not found"));

    expect(await addCampaignMailboxAction("campaign-1", "mailbox-1")).toEqual(failure("Something went wrong. Try again."));

    expect(mockAddCampaignMailbox).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("removeCampaignMailboxAction", () => {
  it("checks campaign ownership, removes the mailbox, and revalidates the campaign path", async () => {
    await removeCampaignMailboxAction("campaign-1", "mailbox-1");

    expect(mockGetCampaign).toHaveBeenCalledWith(expect.anything(), "user-1", "campaign-1");
    expect(mockRemoveCampaignMailbox).toHaveBeenCalledWith(expect.anything(), "campaign-1", "mailbox-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
  });

  it("never removes the mailbox when the ownership check fails", async () => {
    mockGetCampaign.mockRejectedValue(new Error("not found"));

    expect(await removeCampaignMailboxAction("campaign-1", "mailbox-1")).toEqual(failure("Something went wrong. Try again."));

    expect(mockRemoveCampaignMailbox).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

// Batch G: a lead's explicit timezone moves its first send into the
// campaign's hours in the lead's local time; a lead without one (or with an
// invalid one) schedules exactly as before, in the campaign's timezone.
describe("per-lead timezone scheduling", () => {
  // Mon-Fri 09:00-17:00 UTC. Enrolled Tue 2026-09-01 00:00 UTC with a
  // same-day first step:
  //   UTC (campaign)        -> Tue 09:00 UTC  = 2026-09-01T09:00Z
  //   America/New_York (-4) -> Mon 20:00 local, next is Tue 09:00 EDT = 13:00Z
  //   Asia/Tokyo (+9)       -> Tue 09:00 local, already open = 00:00Z
  const WINDOW = { days: ["mon", "tue", "wed", "thu", "fri"], startHour: 9, endHour: 17, timezone: "UTC" };
  const CAMPAIGN_TZ_SEND = "2026-09-01T09:00:00.000Z";
  const NEW_YORK_SEND = "2026-09-01T13:00:00.000Z";
  const TOKYO_SEND = "2026-09-01T00:00:00.000Z";

  function scheduledAt(campaignLeadId: string) {
    const call = mockUpdateCampaignLead.mock.calls.find(
      ([, id, values]) => id === campaignLeadId && typeof values === "object" && values !== null && "next_send_at" in values,
    );
    return (call?.[2] as { next_send_at?: string | null } | undefined)?.next_send_at;
  }

  function useOneStepSequence() {
    mockListSequences.mockResolvedValue([
      { id: "seq-1", campaign_id: "campaign-1", name: "Default", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ] as never);
    mockListSequenceSteps.mockResolvedValue([makeSequenceStep()]);
  }

  const pendingLead = (id: string, leadId = "lead-1") =>
    makeCampaignLead({ id, lead_id: leadId, status: "pending", current_step_id: null, next_send_at: null });

  describe("enrollLeadAction", () => {
    beforeEach(() => {
      mockGetCampaign.mockResolvedValue(makeCampaign({ sending_window: WINDOW, default_mailbox_id: "mailbox-1" }) as never);
      mockAddLeadToCampaign.mockResolvedValue(pendingLead("cl-1") as never);
      useOneStepSequence();
    });

    it.each([
      ["no timezone (unchanged behavior)", null, CAMPAIGN_TZ_SEND],
      ["an invalid timezone", "Mars/Olympus_Mons", CAMPAIGN_TZ_SEND],
      ["a timezone behind the campaign's", "America/New_York", NEW_YORK_SEND],
      ["a timezone ahead of the campaign's", "Asia/Tokyo", TOKYO_SEND],
    ])("schedules the first send for a lead with %s", async (_label, timezone, expected) => {
      mockGetLead.mockResolvedValue({ id: "lead-1", email: "lead-1@example.com", timezone } as never);

      await enrollLeadAction("campaign-1", "lead-1", undefined, true);

      expect(scheduledAt("cl-1")).toBe(expected);
    });
  });

  it("enrollLeadListAction schedules each lead in its own timezone", async () => {
    mockGetCampaign.mockResolvedValue(makeCampaign({ sending_window: WINDOW, default_mailbox_id: "mailbox-1" }) as never);
    useOneStepSequence();
    mockListLeads.mockResolvedValue([
      { id: "lead-utc", email: "utc@example.com", timezone: null },
      { id: "lead-ny", email: "ny@example.com", timezone: "America/New_York" },
      { id: "lead-tokyo", email: "tokyo@example.com", timezone: "Asia/Tokyo" },
    ] as never);
    mockAddLeadsToCampaign.mockResolvedValue({
      inserted: 3,
      skipped: 0,
      rows: [pendingLead("cl-utc", "lead-utc"), pendingLead("cl-ny", "lead-ny"), pendingLead("cl-tokyo", "lead-tokyo")],
    });

    await enrollLeadListAction("campaign-1", "list-1", undefined, true);

    expect(scheduledAt("cl-utc")).toBe(CAMPAIGN_TZ_SEND);
    expect(scheduledAt("cl-ny")).toBe(NEW_YORK_SEND);
    expect(scheduledAt("cl-tokyo")).toBe(TOKYO_SEND);
  });

  it("launchCampaignAction schedules every pending lead in its own timezone", async () => {
    mockGetCampaign.mockResolvedValue(
      makeCampaign({ status: "draft", sending_window: WINDOW, default_mailbox_id: "mailbox-1" }) as never,
    );
    mockListMailboxes.mockResolvedValue([makeMailbox()] as never);
    useOneStepSequence();
    mockListCampaignLeadsWithTimezones.mockResolvedValue([
      { ...pendingLead("cl-utc"), mailbox_id: "mailbox-1", leadTimezone: null },
      { ...pendingLead("cl-ny"), mailbox_id: "mailbox-1", leadTimezone: "America/New_York" },
      { ...pendingLead("cl-bad"), mailbox_id: "mailbox-1", leadTimezone: "Not/A_Zone" },
    ]);

    await launchCampaignAction("campaign-1");

    expect(scheduledAt("cl-utc")).toBe(CAMPAIGN_TZ_SEND);
    expect(scheduledAt("cl-ny")).toBe(NEW_YORK_SEND);
    expect(scheduledAt("cl-bad")).toBe(CAMPAIGN_TZ_SEND);
  });
});
