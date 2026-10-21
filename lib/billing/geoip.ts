import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { Reader, type CountryResponse } from "mmdb-lib";

// Country lookup for self-hosted deployments, where there is no Vercel edge
// to tell us the visitor's country. Reads a local MaxMind GeoLite2-Country
// database (.mmdb); see docs/self-hosting.md for installing and updating it.
// Any failure (no path configured, file missing or corrupt, address not in
// the database) is a null country, which lib/billing/region.ts treats as
// international.

export const GEOIP_DB_PATH_ENV = "GEOIP_COUNTRY_DB_PATH";

// The database is replaced on disk by its updater (geoipupdate writes a new
// file and renames it into place), so the loaded copy is re-checked against
// the file's mtime at most this often instead of requiring a restart. A
// failed re-check is retried on the next one.
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

// MaxMind's GeoLite EULA requires replacing old data within 30 days of a new
// release, and GeoLite2-Country is rebuilt twice a week — a database older
// than this means its updater has stopped.
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface LoadedDatabase {
  path: string;
  mtimeMs: number | null;
  reader: Reader<CountryResponse> | null;
  checkedAt: number;
}

let loaded: LoadedDatabase | null = null;
let reportedMissingPath = false;
let staleWarnedAt: number | null = null;

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function loadDatabase(path: string, now: number): LoadedDatabase {
  const previous = loaded?.path === path ? loaded : null;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (previous?.reader && previous.mtimeMs === mtimeMs) {
      return { ...previous, checkedAt: now };
    }
    return { path, mtimeMs, reader: new Reader<CountryResponse>(readFileSync(path)), checkedAt: now };
  } catch (error) {
    // A broken replacement (truncated copy, file briefly missing) must not
    // take down a database that was working: keep serving the last good one.
    // Its old mtime is kept too, so the next re-check tries the file again.
    if (previous?.reader) {
      console.error("[geoip] reloading country database failed, still using the previously loaded one:", path, errorMessage(error));
      return { ...previous, checkedAt: now };
    }
    console.error("[geoip] country database unavailable:", path, errorMessage(error));
    return { path, mtimeMs: null, reader: null, checkedAt: now };
  }
}

function warnIfStale(reader: Reader<CountryResponse>, now: number) {
  const builtAt = reader.metadata.buildEpoch.getTime();
  if (Number.isNaN(builtAt) || now - builtAt <= STALE_AFTER_MS) return;
  if (staleWarnedAt !== null && now - staleWarnedAt < STALE_WARNING_INTERVAL_MS) return;

  staleWarnedAt = now;
  const ageDays = Math.floor((now - builtAt) / (24 * 60 * 60 * 1000));
  console.warn(
    `[geoip] country database is ${ageDays} days old (built ${new Date(builtAt).toISOString()}) — its updater is not running; see docs/self-hosting.md.`,
  );
}

function getReader(): Reader<CountryResponse> | null {
  const path = process.env[GEOIP_DB_PATH_ENV];
  if (!path) {
    // Off Vercel in production, no database means every visitor — Indian
    // ones included — silently falls back to international. Say so once.
    if (!reportedMissingPath && process.env.NODE_ENV === "production" && process.env.VERCEL !== "1") {
      reportedMissingPath = true;
      console.error(
        `[geoip] ${GEOIP_DB_PATH_ENV} is not set: every visitor is billed as international (USD). See docs/self-hosting.md.`,
      );
    }
    return null;
  }

  const now = Date.now();
  if (!loaded || loaded.path !== path || now - loaded.checkedAt >= RECHECK_INTERVAL_MS) {
    loaded = loadDatabase(path, now);
    if (loaded.reader) warnIfStale(loaded.reader, now);
  }
  return loaded.reader;
}

// IPv4-mapped IPv6 (::ffff:203.0.113.7) is looked up as plain IPv4, since
// that's how the address is actually routed and how every database keys it.
function normalizeIp(ip: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  const candidate = mapped ? mapped[1] : ip;
  return isIP(candidate) === 0 ? null : candidate;
}

// The ISO 3166-1 alpha-2 country the database places `ip` in, or null.
export function lookupCountryByIp(ip: string): string | null {
  const address = normalizeIp(ip);
  if (address === null) return null;

  const reader = getReader();
  if (!reader) return null;

  try {
    return reader.get(address)?.country?.iso_code ?? null;
  } catch (error) {
    console.error("[geoip] lookup failed:", errorMessage(error));
    return null;
  }
}

// Test-only: forget the loaded database and logged warnings so the next
// lookup starts fresh.
export function resetGeoipCacheForTests(): void {
  loaded = null;
  reportedMissingPath = false;
  staleWarnedAt = null;
}
