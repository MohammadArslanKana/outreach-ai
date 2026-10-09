// Expected failures from a Server Function (a plan limit, an invalid state
// transition, a rate limit) are returned as values, never thrown. Next.js
// production builds replace a thrown error's message with an opaque digest
// before it reaches the browser, so a thrown "Upgrade to add more" arrives as
// a generic error — see node_modules/next/dist/docs/01-app/01-getting-started/
// 10-error-handling.md ("model expected errors as return values").
//
// Same { ok, error } shape the mailbox test-connection actions already return.
export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

// Thrown only on the client by unwrapActionResult, so its message is never
// redacted. Lets a component keep its existing try/catch and tell a
// purpose-written server message apart from anything unexpected.
export class ActionError extends Error {}

export function unwrapActionResult<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new ActionError(result.error);
  }
  return result.data;
}
