import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEOIP_DB_PATH_ENV, lookupCountryByIp, resetGeoipCacheForTests } from "./geoip";
import { buildCountryMmdb } from "./test-country-mmdb";

const dir = mkdtempSync(join(tmpdir(), "polimatiq-geoip-"));
const dbPath = join(dir, "country.mmdb");

const NETWORKS = {
  "49.36.0.0/16": "IN",
  "8.8.8.0/24": "US",
  "81.2.69.0/24": "GB",
  "2401:4900::/32": "IN",
  "2001:4860::/32": "US",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date("2026-10-21T00:00:00Z");

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

// Writes a database file and stamps its mtime, as an updater replacing it would.
function writeDatabase(contents: Buffer | string, modifiedAt: Date) {
  writeFileSync(dbPath, contents);
  utimesSync(dbPath, modifiedAt, modifiedAt);
}

beforeEach(() => {
  writeFileSync(dbPath, buildCountryMmdb(NETWORKS));
  vi.stubEnv(GEOIP_DB_PATH_ENV, dbPath);
  resetGeoipCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lookupCountryByIp", () => {
  it.each([
    ["49.36.12.34", "IN"],
    ["8.8.8.8", "US"],
    ["81.2.69.160", "GB"],
    ["2401:4900:1c2a::1", "IN"],
    ["2001:4860:4860::8888", "US"],
  ])("finds %s in %s", (ip, country) => {
    expect(lookupCountryByIp(ip)).toBe(country);
  });

  it("looks up an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(lookupCountryByIp("::ffff:49.36.12.34")).toBe("IN");
  });

  it("returns null for an address the database doesn't cover", () => {
    expect(lookupCountryByIp("1.1.1.1")).toBeNull();
  });

  it.each(["", "unknown", "49.36.12", "49.36.12.34:443", "IN", "not an ip", "999.1.1.1"])(
    "returns null for a value that isn't an IP address (%j) without consulting the database",
    (value) => {
      expect(lookupCountryByIp(value)).toBeNull();
    },
  );

  it("returns null and logs when the database file is missing", () => {
    vi.stubEnv(GEOIP_DB_PATH_ENV, join(dir, "does-not-exist.mmdb"));
    expect(lookupCountryByIp("49.36.12.34")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[geoip] country database unavailable:",
      join(dir, "does-not-exist.mmdb"),
      expect.anything(),
    );
  });

  it("returns null and logs when the database file is corrupt", () => {
    writeFileSync(dbPath, "not a maxmind database");
    expect(lookupCountryByIp("49.36.12.34")).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("picks up a replaced database file after the recheck interval, without a restart", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    writeDatabase(buildCountryMmdb(NETWORKS, T0), T0);
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");

    writeDatabase(buildCountryMmdb({ "49.36.0.0/16": "NP" }, at(30 * 60_000)), at(30 * 60_000));

    // Still the loaded copy within the hour...
    vi.setSystemTime(at(59 * 60_000));
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");

    // ...and the new file once the hour has passed.
    vi.setSystemTime(at(HOUR_MS + 1_000));
    expect(lookupCountryByIp("49.36.12.34")).toBe("NP");
  });
});

describe(`missing ${GEOIP_DB_PATH_ENV}`, () => {
  function missingPathErrors() {
    return vi.mocked(console.error).mock.calls.filter(([message]) => String(message).includes(`${GEOIP_DB_PATH_ENV} is not set`));
  }

  it("logs one clear error in production off Vercel, not one per request", () => {
    vi.stubEnv(GEOIP_DB_PATH_ENV, "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");

    for (let i = 0; i < 5; i++) expect(lookupCountryByIp("49.36.12.34")).toBeNull();

    expect(missingPathErrors()).toHaveLength(1);
    expect(missingPathErrors()[0][0]).toMatch(/every visitor is billed as international \(USD\)/);
  });

  it("stays quiet outside production (local dev, tests), where no database is expected", () => {
    vi.stubEnv(GEOIP_DB_PATH_ENV, "");
    vi.stubEnv("NODE_ENV", "development");
    expect(lookupCountryByIp("49.36.12.34")).toBeNull();
    expect(missingPathErrors()).toHaveLength(0);
  });

  it("stays quiet on Vercel, which never uses the database", () => {
    vi.stubEnv(GEOIP_DB_PATH_ENV, "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    expect(lookupCountryByIp("49.36.12.34")).toBeNull();
    expect(missingPathErrors()).toHaveLength(0);
  });
});

describe("a failed reload keeps the last working database", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    writeDatabase(buildCountryMmdb(NETWORKS, T0), T0);
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");
  });

  it("survives a corrupt replacement, logs it, and retries until a good file arrives", () => {
    writeDatabase("truncated download", at(10 * 60_000));

    vi.setSystemTime(at(HOUR_MS + 1_000));
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");
    expect(lookupCountryByIp("8.8.8.8")).toBe("US");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/reloading country database failed, still using the previously loaded one/);

    // Not retried before the next scheduled check...
    vi.setSystemTime(at(2 * HOUR_MS));
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");
    expect(console.error).toHaveBeenCalledTimes(1);

    // ...retried at it (still corrupt, still serving the old copy)...
    vi.setSystemTime(at(2 * HOUR_MS + 2_000));
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");
    expect(console.error).toHaveBeenCalledTimes(2);

    // ...and a later good replacement is picked up.
    writeDatabase(buildCountryMmdb({ "49.36.0.0/16": "NP" }, at(3 * HOUR_MS)), at(3 * HOUR_MS));
    vi.setSystemTime(at(3 * HOUR_MS + 3_000));
    expect(lookupCountryByIp("49.36.12.34")).toBe("NP");
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("survives the file briefly disappearing", () => {
    unlinkSync(dbPath);

    vi.setSystemTime(at(HOUR_MS + 1_000));
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");
    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/still using the previously loaded one/);

    writeDatabase(buildCountryMmdb({ "49.36.0.0/16": "NP" }, at(HOUR_MS + 5_000)), at(HOUR_MS + 5_000));
    vi.setSystemTime(at(2 * HOUR_MS + 2_000));
    expect(lookupCountryByIp("49.36.12.34")).toBe("NP");
  });
});

describe("stale database detection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  it("doesn't warn about a fresh database", () => {
    vi.setSystemTime(T0);
    writeDatabase(buildCountryMmdb(NETWORKS, at(-29 * DAY_MS)), at(-29 * DAY_MS));
    expect(lookupCountryByIp("49.36.12.34")).toBe("IN");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns about a database older than 30 days — still using it — at most once a day", () => {
    vi.setSystemTime(T0);
    writeDatabase(buildCountryMmdb(NETWORKS, at(-31 * DAY_MS)), at(-31 * DAY_MS));

    for (let i = 0; i < 5; i++) expect(lookupCountryByIp("49.36.12.34")).toBe("IN");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(/country database is 31 days old \(built 2026-09-20T00:00:00\.000Z\)/);

    // Hourly re-checks within the day don't repeat it...
    vi.setSystemTime(at(HOUR_MS + 1_000));
    lookupCountryByIp("49.36.12.34");
    vi.setSystemTime(at(23 * HOUR_MS));
    lookupCountryByIp("49.36.12.34");
    expect(console.warn).toHaveBeenCalledTimes(1);

    // ...but the first re-check a day later does.
    vi.setSystemTime(at(DAY_MS + 1_000));
    lookupCountryByIp("49.36.12.34");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("warns once a loaded database ages past 30 days while the process keeps running", () => {
    vi.setSystemTime(T0);
    writeDatabase(buildCountryMmdb(NETWORKS, at(-29 * DAY_MS)), at(-29 * DAY_MS));
    lookupCountryByIp("49.36.12.34");
    expect(console.warn).not.toHaveBeenCalled();

    vi.setSystemTime(at(2 * DAY_MS));
    lookupCountryByIp("49.36.12.34");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("stops warning once an up-to-date database replaces the stale one", () => {
    vi.setSystemTime(T0);
    writeDatabase(buildCountryMmdb(NETWORKS, at(-40 * DAY_MS)), at(-40 * DAY_MS));
    lookupCountryByIp("49.36.12.34");
    expect(console.warn).toHaveBeenCalledTimes(1);

    writeDatabase(buildCountryMmdb(NETWORKS, at(DAY_MS)), at(DAY_MS));
    vi.setSystemTime(at(2 * DAY_MS));
    lookupCountryByIp("49.36.12.34");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
