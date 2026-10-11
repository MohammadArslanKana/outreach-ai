import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("dns/promises", () => ({ lookup: (...args: unknown[]) => lookup(...args) }));

import { IntegrationDeliveryError } from "../provider";
import { WebhookIntegrationProvider } from "./webhook";

const PAYLOAD = {
  organizationId: "org-1",
  organizationName: "Acme",
  generatedAt: "2026-08-05T00:00:00.000Z",
  overview: { sentCount: 10, replyRate: 5, bounceRate: 1 },
  insights: [],
};

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "203.0.114.10", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebhookIntegrationProvider", () => {
  it("posts the payload as JSON and returns delivered:true on a 2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new WebhookIntegrationProvider({ url: "https://example.com/hook" });
    const result = await provider.send(PAYLOAD);

    expect(result).toEqual({ delivered: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PAYLOAD),
        redirect: "manual",
      }),
    );
  });

  it("classifies a network error as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const provider = new WebhookIntegrationProvider({ url: "https://example.com/hook" });
    await expect(provider.send(PAYLOAD)).rejects.toMatchObject({ outcome: "retry" });
  });

  it("classifies a 5xx response as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    const provider = new WebhookIntegrationProvider({ url: "https://example.com/hook" });
    await expect(provider.send(PAYLOAD)).rejects.toBeInstanceOf(IntegrationDeliveryError);
    await expect(provider.send(PAYLOAD)).rejects.toMatchObject({ outcome: "retry" });
  });

  it("classifies a 4xx response as failed, not retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const provider = new WebhookIntegrationProvider({ url: "https://example.com/hook" });
    await expect(provider.send(PAYLOAD)).rejects.toMatchObject({ outcome: "failed" });
  });

  it("refuses a hostname that resolves to a private address, without sending", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new WebhookIntegrationProvider({ url: "https://internal.attacker.example/hook" });
    await expect(provider.send(PAYLOAD)).rejects.toMatchObject({
      outcome: "failed",
      message: "The webhook URL points to a private address, which isn't allowed.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a redirect as a failed delivery instead of following it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })),
    );

    const provider = new WebhookIntegrationProvider({ url: "https://example.com/hook" });
    await expect(provider.send(PAYLOAD)).rejects.toMatchObject({ outcome: "failed" });
  });
});
