import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/types/database.types";

// Next.js 16 renamed Middleware to Proxy (same file-convention mechanics,
// new file name and export name) — see AGENTS.md and CLAUDE.md.
//
// This refreshes the Supabase auth session cookie on every matched request.
// Server Components can't write cookies, so without this, a session nearing
// expiry would eventually fail to refresh and silently log the user out.
// Route-level redirects (protected routes, auth-page redirects) still live
// in app/(app)/layout.tsx and app/(auth)/layout.tsx — this is session
// upkeep only, not the authorization boundary. See the Next.js Proxy docs:
// optimistic checks here are fine, but real authorization must happen
// close to the data (RLS, Server Function checks), not in Proxy.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Must be called (not just cookies.getAll()) — this is what actually
  // talks to Supabase and rotates the token when it's close to expiry.
  await supabase.auth.getUser();

  return response;
}

// Machine-called API routes are excluded: pg_cron (api/cron), tracking
// pixels and clicks (api/track), provider webhooks (api/webhooks) and the
// uptime monitor (api/health) never carry a user session, so running Proxy
// for them only adds an invocation to every call. api/oauth is kept — its
// callbacks need the user's refreshed session.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/cron|api/track|api/webhooks|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
