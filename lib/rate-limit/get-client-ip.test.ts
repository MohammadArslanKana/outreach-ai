import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import { getClientIp, trustedClientIp } from "./get-client-ip";

const mockHeaders = vi.mocked(headers);

afterEach(() => {
  vi.clearAllMocks();
});

describe("trustedClientIp", () => {
  it("reads the single entry Caddy (header_up X-Forwarded-For {remote_host}) or Vercel writes", () => {
    expect(trustedClientIp(new Headers({ "x-forwarded-for": "49.36.12.34" }))).toBe("49.36.12.34");
  });

  it("reads an IPv6 client address", () => {
    expect(trustedClientIp(new Headers({ "x-forwarded-for": "2401:4900:1c2a::1" }))).toBe("2401:4900:1c2a::1");
  });

  it("uses the right-most entry — the one the trusted proxy appended — never a client-supplied one to its left", () => {
    expect(trustedClientIp(new Headers({ "x-forwarded-for": "49.36.12.34, 8.8.8.8" }))).toBe("8.8.8.8");
    expect(trustedClientIp(new Headers({ "x-forwarded-for": "49.36.12.34,49.36.0.1 ,  8.8.8.8 " }))).toBe("8.8.8.8");
  });

  it("ignores other client-controlled IP headers", () => {
    expect(
      trustedClientIp(new Headers({ "x-real-ip": "49.36.12.34", "cf-connecting-ip": "49.36.12.34", forwarded: "for=49.36.12.34" })),
    ).toBeNull();
  });

  it.each(["", " ", "8.8.8.8, ", ","])("treats a missing or empty right-most entry (%j) as no IP", (value) => {
    expect(trustedClientIp(new Headers({ "x-forwarded-for": value }))).toBeNull();
  });
});

describe("getClientIp", () => {
  it("returns the trusted client IP", async () => {
    mockHeaders.mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" }) as never);
    await expect(getClientIp()).resolves.toBe("198.51.100.7");
  });

  it("falls back to one shared 'unknown' bucket without the header", async () => {
    mockHeaders.mockResolvedValue(new Headers() as never);
    await expect(getClientIp()).resolves.toBe("unknown");
  });
});
