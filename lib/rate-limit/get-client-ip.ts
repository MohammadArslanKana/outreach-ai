import { headers } from "next/headers";

// The client IP as seen by the one trusted proxy in front of the app: the
// RIGHT-most x-forwarded-for entry, the one that proxy wrote. Every entry to
// its left was supplied by the client (or by hops nobody vouches for) and
// can be anything, so the left-most entry is never used.
//
// Trusted proxies, per deployment target:
// - Vercel overwrites x-forwarded-for with the client's address, so there is
//   exactly one entry.
// - Self-hosted (docs/self-hosting.md) puts Caddy in front, configured with
//   `header_up X-Forwarded-For {remote_host}` so it replaces whatever the
//   client sent with the TCP peer address, and the app listens only on
//   127.0.0.1 so nothing can reach it without going through Caddy. Next.js
//   itself only fills this header in when it is absent.
//
// Adding another proxy hop in front (a CDN, a load balancer) breaks this
// assumption — the right-most entry would then be that hop's address.
export function trustedClientIp(requestHeaders: Pick<Headers, "get">): string | null {
  const forwardedFor = requestHeaders.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const last = forwardedFor.split(",").at(-1)?.trim();
  return last ? last : null;
}

// Best-effort client IP for the unauthenticated rate-limit scopes
// (auth:sign_in/sign_up/forgot_password) — there's no session yet, so no
// user/organization id to key on. The "unknown" fallback only matters for
// local/direct testing, where every such request shares one bucket rather
// than being unlimited.
export async function getClientIp(): Promise<string> {
  return trustedClientIp(await headers()) ?? "unknown";
}
