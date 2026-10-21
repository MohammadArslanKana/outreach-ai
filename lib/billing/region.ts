import { headers } from "next/headers";
import { trustedClientIp } from "@/lib/rate-limit/get-client-ip";
import { ROUTE_CURRENCY, type Currency } from "./currency";
import { lookupCountryByIp } from "./geoip";

// The one place Polimatiq decides which billing region a visitor is in.
// The marketing pricing section, the billing page, and the Razorpay checkout
// action all call getBillingRegion() rather than each reading a signal of
// their own, so the disclosed charge and the actual payment can never
// disagree about a request.
//
// The region decides the PAYMENT currency only: India pays INR, everyone
// else pays USD, both through Razorpay. The DISPLAY currency is always USD
// for everyone (an Indian visitor additionally sees the INR charge) — see
// lib/billing/offerings.ts, which also decides whether a given plan can
// actually be bought in that payment currency. Unknown always means
// international: an unresolvable visitor must never be routed into the INR
// path by default.

export type BillingRegion = "india" | "international";

// Set by Vercel's edge from the requester's IP: a two-letter ISO 3166-1 code.
// Browser language, Accept-Language, timezone, and anything the client sends
// are deliberately never consulted.
export const COUNTRY_HEADER = "x-vercel-ip-country";

function asCountryCode(value: string | null): string | null {
  return value !== null && /^[A-Z]{2}$/.test(value) ? value : null;
}

// On Vercel, the country comes from Vercel's own header. Anywhere else that
// header (and every other country header) is simply whatever the client
// sent, so it is ignored; the country comes instead from looking up the
// client IP that the trusted proxy recorded (see trustedClientIp) in a local
// GeoIP database (see lib/billing/geoip.ts). With no database configured —
// local dev, tests — that lookup is always null, i.e. international.
export function countryFromHeaders(
  requestHeaders: Pick<Headers, "get">,
  onVercel: boolean = process.env.VERCEL === "1",
  lookupCountry: (ip: string) => string | null = lookupCountryByIp,
): string | null {
  if (onVercel) return asCountryCode(requestHeaders.get(COUNTRY_HEADER));

  const ip = trustedClientIp(requestHeaders);
  return ip === null ? null : asCountryCode(lookupCountry(ip));
}

export function billingRegionForCountry(country: string | null): BillingRegion {
  return country === "IN" ? "india" : "international";
}

export function currencyForRegion(region: BillingRegion): Currency {
  return region === "india" ? ROUTE_CURRENCY.razorpay_india : ROUTE_CURRENCY.international;
}

export async function getBillingRegion(): Promise<BillingRegion> {
  return billingRegionForCountry(countryFromHeaders(await headers()));
}
