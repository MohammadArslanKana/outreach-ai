import { describe, expect, it } from "vitest";
import { ActionError, unwrapActionResult } from "./action-result";

describe("unwrapActionResult", () => {
  it("returns the data of a successful result", () => {
    expect(unwrapActionResult({ ok: true, data: { id: "campaign-1" } })).toEqual({ id: "campaign-1" });
  });

  it("throws an ActionError carrying the server's message verbatim", () => {
    const message = "Your account has no active subscription. The current limit allows up to 1 campaign. Upgrade to add more.";

    let caught: unknown;
    try {
      unwrapActionResult({ ok: false, error: message });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ActionError);
    expect((caught as ActionError).message).toBe(message);
  });
});
