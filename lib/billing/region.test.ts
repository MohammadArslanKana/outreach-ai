import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import { GEOIP_DB_PATH_ENV, resetGeoipCacheForTests } from "./geoip";
import {
  billingRegionForCountry,
  countryFromHeaders,
  currencyForRegion,
  getBillingRegion,
} from "./region";
import { buildCountryMmdb } from "./test-country-mmdb";

const mockHeaders = vi.mocked(headers);

function requestHeaders(values: Record<string, string>) {
  return new Headers(values);
}

const INDIAN_IP = "49.36.12.34";
const US_IP = "8.8.8.8";
const GB_IP = "81.2.69.160";
const UNLISTED_IP = "1.1.1.1";

const geoipDir = mkdtempSync(join(tmpdir(), "polimatiq-region-"));
const geoipDbPath = join(geoipDir, "country.mmdb");
writeFileSync(
  geoipDbPath,
  buildCountryMmdb({ "49.36.0.0/16": "IN", "8.8.8.0/24": "US", "81.2.69.0/24": "GB", "2401:4900::/32": "IN" }),
);

// Stand-in for the GeoIP database in countryFromHeaders unit tests.
const fakeLookup = vi.fn((ip: string) => ({ [INDIAN_IP]: "IN", [US_IP]: "US", [GB_IP]: "GB" })[ip] ?? null);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetGeoipCacheForTests();
});

afterAll(() => {
  rmSync(geoipDir, { recursive: true, force: true });
});

describe("billingRegionForCountry", () => {
  it("maps IN to india", () => {
    expect(billingRegionForCountry("IN")).toBe("india");
  });

  it.each(["US", "GB", "DE", "AE", "SG", "NP"])("maps %s to international", (country) => {
    expect(billingRegionForCountry(country)).toBe("international");
  });

  it("maps a missing country to international — unknown never means India", () => {
    expect(billingRegionForCountry(null)).toBe("international");
  });
});

describe("countryFromHeaders", () => {
  it("reads Vercel's country header on Vercel", () => {
    expect(countryFromHeaders(requestHeaders({ "x-vercel-ip-country": "IN" }), true)).toBe("IN");
  });

  it("treats the header as missing when absent", () => {
    expect(countryFromHeaders(requestHeaders({}), true)).toBeNull();
  });

  // (Headers itself trims surrounding whitespace, so " IN" arrives as "IN".)
  it.each(["in", "IND", "I", "", "India", "IN,US", "XX1"])(
    "treats a malformed value (%j) as missing",
    (value) => {
      expect(countryFromHeaders(requestHeaders({ "x-vercel-ip-country": value }), true)).toBeNull();
    },
  );

  it("ignores the header entirely off Vercel, where any client could have set it", () => {
    expect(countryFromHeaders(requestHeaders({ "x-vercel-ip-country": "IN" }), false)).toBeNull();
  });

  it("never falls back to browser language, locale, or timezone signals", () => {
    const h = requestHeaders({
      "accept-language": "hi-IN,en-IN;q=0.9",
      "x-timezone": "Asia/Kolkata",
      "x-country": "IN",
      "cf-ipcountry": "IN",
    });
    expect(countryFromHeaders(h, true)).toBeNull();
  });

  it("on Vercel, uses only Vercel's header — never the forwarded IP or the GeoIP database", () => {
    const h = requestHeaders({ "x-vercel-ip-country": "US", "x-forwarded-for": INDIAN_IP });
    expect(countryFromHeaders(h, true, fakeLookup)).toBe("US");
    expect(fakeLookup).not.toHaveBeenCalled();
  });
});

describe("countryFromHeaders off Vercel (self-hosted behind Caddy)", () => {
  it("looks up the trusted client IP in the GeoIP database", () => {
    expect(countryFromHeaders(requestHeaders({ "x-forwarded-for": INDIAN_IP }), false, fakeLookup)).toBe("IN");
    expect(countryFromHeaders(requestHeaders({ "x-forwarded-for": US_IP }), false, fakeLookup)).toBe("US");
    expect(fakeLookup).toHaveBeenCalledWith(INDIAN_IP);
  });

  it("uses the right-most x-forwarded-for entry, so a client-prepended Indian IP is ignored", () => {
    const h = requestHeaders({ "x-forwarded-for": `${INDIAN_IP}, ${US_IP}` });
    expect(countryFromHeaders(h, false, fakeLookup)).toBe("US");
    expect(fakeLookup).toHaveBeenCalledTimes(1);
    expect(fakeLookup).toHaveBeenCalledWith(US_IP);
  });

  it("ignores client-supplied country headers, even a Vercel-looking one", () => {
    const h = requestHeaders({
      "x-forwarded-for": US_IP,
      "x-vercel-ip-country": "IN",
      "cf-ipcountry": "IN",
      "x-country": "IN",
      "accept-language": "hi-IN,en-IN;q=0.9",
    });
    expect(countryFromHeaders(h, false, fakeLookup)).toBe("US");
  });

  it("ignores client-supplied IP headers other than x-forwarded-for", () => {
    const h = requestHeaders({ "x-real-ip": INDIAN_IP, "cf-connecting-ip": INDIAN_IP, forwarded: `for=${INDIAN_IP}` });
    expect(countryFromHeaders(h, false, fakeLookup)).toBeNull();
    expect(fakeLookup).not.toHaveBeenCalled();
  });

  it("is missing without a forwarded client IP", () => {
    expect(countryFromHeaders(requestHeaders({ "x-vercel-ip-country": "IN" }), false, fakeLookup)).toBeNull();
    expect(fakeLookup).not.toHaveBeenCalled();
  });

  it("is missing when the database has no answer for the IP", () => {
    expect(countryFromHeaders(requestHeaders({ "x-forwarded-for": UNLISTED_IP }), false, fakeLookup)).toBeNull();
  });

  it.each(["in", "IND", "", "India"])("treats a malformed database value (%j) as missing", (value) => {
    expect(countryFromHeaders(requestHeaders({ "x-forwarded-for": US_IP }), false, () => value)).toBeNull();
  });
});

describe("currencyForRegion", () => {
  it("India bills in INR", () => {
    expect(currencyForRegion("india")).toBe("INR");
  });

  it("international bills in USD", () => {
    expect(currencyForRegion("international")).toBe("USD");
  });
});

describe("getBillingRegion", () => {
  it("resolves india from Vercel's header on Vercel", async () => {
    vi.stubEnv("VERCEL", "1");
    mockHeaders.mockResolvedValue(requestHeaders({ "x-vercel-ip-country": "IN" }) as never);
    await expect(getBillingRegion()).resolves.toBe("india");
  });

  it.each([
    ["US", { "x-vercel-ip-country": "US" }],
    ["GB", { "x-vercel-ip-country": "GB" }],
    ["missing", {}],
    ["malformed", { "x-vercel-ip-country": "in" }],
  ])("resolves international for %s country", async (_label, values) => {
    vi.stubEnv("VERCEL", "1");
    mockHeaders.mockResolvedValue(requestHeaders(values as Record<string, string>) as never);
    await expect(getBillingRegion()).resolves.toBe("international");
  });

  it("resolves international off Vercel even when an IN header is present", async () => {
    vi.stubEnv("VERCEL", "");
    mockHeaders.mockResolvedValue(requestHeaders({ "x-vercel-ip-country": "IN" }) as never);
    await expect(getBillingRegion()).resolves.toBe("international");
  });

  it("resolves international for an Indian browser language when the country is not IN", async () => {
    vi.stubEnv("VERCEL", "1");
    mockHeaders.mockResolvedValue(
      requestHeaders({ "x-vercel-ip-country": "US", "accept-language": "hi-IN,en-IN" }) as never,
    );
    await expect(getBillingRegion()).resolves.toBe("international");
  });
});

// End to end through the real mmdb reader, the way a Droplet runs it:
// VERCEL unset, GEOIP_COUNTRY_DB_PATH set, Caddy-written x-forwarded-for.
describe("getBillingRegion self-hosted with a GeoIP database", () => {
  async function regionFor(values: Record<string, string>, dbPath: string = geoipDbPath) {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv(GEOIP_DB_PATH_ENV, dbPath);
    mockHeaders.mockResolvedValue(requestHeaders(values) as never);
    return getBillingRegion();
  }

  it.each([
    ["IPv4", INDIAN_IP],
    ["IPv6", "2401:4900:1c2a::1"],
    ["IPv4-mapped IPv6", `::ffff:${INDIAN_IP}`],
  ])("an Indian %s visitor resolves to india and pays INR", async (_label, ip) => {
    const region = await regionFor({ "x-forwarded-for": ip });
    expect(region).toBe("india");
    expect(currencyForRegion(region)).toBe("INR");
  });

  it.each([
    ["US", US_IP],
    ["GB", GB_IP],
  ])("a %s visitor resolves to international and pays USD", async (_label, ip) => {
    const region = await regionFor({ "x-forwarded-for": ip });
    expect(region).toBe("international");
    expect(currencyForRegion(region)).toBe("USD");
  });

  it("a non-Indian visitor can't buy INR pricing by prepending an Indian IP or sending country headers", async () => {
    const region = await regionFor({
      "x-forwarded-for": `${INDIAN_IP}, ${US_IP}`,
      "x-vercel-ip-country": "IN",
      "cf-ipcountry": "IN",
      "x-real-ip": INDIAN_IP,
    });
    expect(region).toBe("international");
  });

  describe("falls back to international (USD) whenever the country can't be established", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it.each([
      ["no forwarded IP", {}],
      ["an empty forwarded IP", { "x-forwarded-for": "" }],
      ["a malformed forwarded IP", { "x-forwarded-for": "not-an-ip" }],
      ["an IP missing from the database", { "x-forwarded-for": UNLISTED_IP }],
    ])("%s", async (_label, values) => {
      await expect(regionFor(values as Record<string, string>)).resolves.toBe("international");
    });

    it("no database configured", async () => {
      await expect(regionFor({ "x-forwarded-for": INDIAN_IP }, "")).resolves.toBe("international");
    });

    it("the database file is missing", async () => {
      await expect(regionFor({ "x-forwarded-for": INDIAN_IP }, join(geoipDir, "missing.mmdb"))).resolves.toBe(
        "international",
      );
    });

    it("the database file is corrupt", async () => {
      const corrupt = join(geoipDir, "corrupt.mmdb");
      writeFileSync(corrupt, "not a maxmind database");
      await expect(regionFor({ "x-forwarded-for": INDIAN_IP }, corrupt)).resolves.toBe("international");
    });
  });

  it("on Vercel the GeoIP database is never consulted, even when configured", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv(GEOIP_DB_PATH_ENV, geoipDbPath);
    mockHeaders.mockResolvedValue(requestHeaders({ "x-vercel-ip-country": "US", "x-forwarded-for": INDIAN_IP }) as never);
    await expect(getBillingRegion()).resolves.toBe("international");
  });
});
