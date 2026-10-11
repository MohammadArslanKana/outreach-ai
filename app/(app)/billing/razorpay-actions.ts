"use server";

import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/db";
import {
  attachBillingCheckoutSubscription,
  claimBillingCheckout,
  getSubscriptionV2,
  releaseBillingCheckout,
} from "@/lib/db/billing-v2";
import { getPlanOffering, type PlanOffering } from "@/lib/billing/offerings";
import { getRazorpayClient, totalCountForInterval } from "@/lib/billing/razorpay";
import {
  checkoutSubscriptionMismatch,
  toRazorpayPlanEntity,
  toRazorpaySubscriptionEntity,
} from "@/lib/billing/sync-subscription-v2";
import type { BillingInterval, PaidPlanId } from "@/lib/billing/plans";
import type { Currency } from "@/lib/billing/currency";
import { isInternalUnlimitedOrganization } from "@/lib/billing/resolve-plan";
// Checking against non-terminal statuses (not just "any row exists") lets an
// org whose old subscription genuinely ended (cancelled/expired/completed)
// start a fresh checkout instead of being permanently blocked by a stale
// row. Shared with the webhook and the billing page so all three agree on
// what "already has a live subscription" means.
import { NON_TERMINAL_SUBSCRIPTION_STATUSES as NON_TERMINAL_STATUSES } from "@/lib/billing/razorpay-status";
import { getActiveSubscriptionView } from "@/lib/billing/subscription-view";
import { currencyForRegion, getBillingRegion } from "@/lib/billing/region";
import { checkoutSchema, razorpaySubscriptionIdSchema, type CheckoutInput } from "@/lib/validations/billing";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit/check-rate-limit";
import type { ActionResult } from "@/lib/action-result";

// A message written for the customer. The exported actions return these
// (and RateLimitError's) as values: Next.js production builds replace a
// thrown Server Function error's message with an opaque digest, so a thrown
// "Another checkout is already in progress..." would reach the browser as a
// generic error — see lib/action-result.ts. Anything else still throws.
class BillingActionError extends Error {}

function toActionError(error: unknown): { ok: false; error: string } {
  if (error instanceof BillingActionError || error instanceof RateLimitError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

// Why an offering can't be bought, in words the customer can act on. Which
// env var is missing goes to the server log, never to the client.
function unavailableMessage(offering: PlanOffering): string {
  if (offering.availability === "not_sold") {
    return offering.currency === "INR"
      ? "This billing duration isn't available for payments in India yet. Choose a shorter duration."
      : "This plan isn't available in your region yet.";
  }
  return offering.currency === "USD"
    ? "International checkout isn't available yet. Try again later or contact support."
    : "This plan isn't available yet. Try again shortly or contact support.";
}

const CHECKOUT_IN_PROGRESS_MESSAGE =
  "A checkout for this plan is still being prepared. Try again in a few seconds.";
const CHECKOUT_NOT_RESUMABLE_MESSAGE =
  "The checkout already in progress for this workspace can't be reopened. If you completed payment, it will appear on this page shortly; otherwise you can start a new checkout within 30 minutes.";

// An open checkout already has a Razorpay subscription: hand that same one
// back (the customer closed the payment window and clicked again) instead of
// creating a second. Re-fetched from Razorpay and checked against this exact
// offering with the webhook's own plan check, so only a subscription that is
// still unpaid and still sells what was asked for is ever reopened.
async function resumeCheckoutSubscription(
  providerSubscriptionId: string,
  expected: { organizationId: string; planId: PaidPlanId; interval: BillingInterval; currency: Currency },
): Promise<string> {
  try {
    const razorpay = getRazorpayClient();
    const subscription = toRazorpaySubscriptionEntity(await razorpay.subscriptions.fetch(providerSubscriptionId));
    const plan = toRazorpayPlanEntity(await razorpay.plans.fetch(subscription.plan_id));
    const mismatch = subscription.id === providerSubscriptionId
      ? checkoutSubscriptionMismatch(subscription, plan, expected)
      : "Razorpay returned a different subscription than requested";
    if (mismatch) {
      console.error("[razorpay] open checkout's subscription doesn't match the offering", providerSubscriptionId, mismatch);
      throw new BillingActionError(CHECKOUT_NOT_RESUMABLE_MESSAGE);
    }
    // "created" is the only state checkout.js can still authenticate. Any
    // other means it was already paid (the webhook will confirm it) or ended.
    if (subscription.status !== "created") throw new BillingActionError(CHECKOUT_NOT_RESUMABLE_MESSAGE);
    return subscription.id;
  } catch (error) {
    if (error instanceof BillingActionError && error.message === CHECKOUT_NOT_RESUMABLE_MESSAGE) throw error;
    console.error("[razorpay] failed to re-fetch open checkout's subscription", error);
    throw new BillingActionError("Couldn't start checkout. Try again shortly or contact support.");
  }
}

// Server Functions are reachable directly via POST regardless of which UI
// calls them, so re-validate here even though the client only ever offers
// buttons for the plans/intervals actually configured — same reasoning
// app/(app)/billing/actions.ts's createCheckoutSessionAction already
// documents for its Stripe equivalent.
//
// Deliberately does NOT write billing_customers_v2/subscriptions_v2 — per
// the approved architecture, only the webhook (app/api/webhooks/razorpay/
// route.ts), once Razorpay confirms the authentication transaction, is
// authoritative. This action only creates the provider-side Subscription
// object and hands the client the minimum it needs to open Razorpay
// Checkout. It also does NOT pre-create a Razorpay Customer: Razorpay's
// Create Subscription API has no customer_id parameter at all (confirmed
// via official docs during the Phase 0 design review) — the customer is
// created/linked by Razorpay automatically during checkout.js
// authentication, not by this server action.
export async function createRazorpaySubscriptionAction(
  input: CheckoutInput,
): Promise<ActionResult<{ subscriptionId: string; prefillEmail: string | undefined }>> {
  try {
    return { ok: true, data: await startRazorpayCheckout(input) };
  } catch (error) {
    return toActionError(error);
  }
}

async function startRazorpayCheckout(
  input: CheckoutInput,
): Promise<{ subscriptionId: string; prefillEmail: string | undefined }> {
  const parsed = checkoutSchema.parse(input);
  const user = await requireUser();
  const supabase = await createClient();

  const organization = await getUserOrganization(supabase, user);
  if (isInternalUnlimitedOrganization(organization.id)) {
    throw new BillingActionError("This workspace already has unlimited access.");
  }
  await checkRateLimit("billing:checkout", organization.id);

  // Currency, amount and Razorpay plan are all decided here from the request
  // itself — never from anything the client sends (checkoutSchema only
  // accepts planId/interval and strips any other field, so a posted
  // currency, amount or plan id is ignored). The UI hiding a button isn't
  // enough: this action is reachable by a direct POST.
  const currency = currencyForRegion(await getBillingRegion());
  const offering = getPlanOffering(parsed.planId, parsed.interval, currency);
  if (offering.availability !== "available" || !offering.razorpayPlanId) {
    if (offering.availability === "not_configured") {
      console.error(`[razorpay] checkout unavailable: ${offering.razorpayPlanEnvVar} is not set`);
    }
    throw new BillingActionError(unavailableMessage(offering));
  }

  // Duplicate-checkout guard: block starting a second subscription while a
  // confirmed, non-terminal one already exists. This only ever sees
  // webhook-confirmed rows (subscriptions_v2 is never written from this
  // action); subscriptions_v2's own unique(organization_id) constraint
  // remains the backstop against two *confirmed* rows ever coexisting.
  const existing = await getSubscriptionV2(supabase, organization.id);
  if (existing && NON_TERMINAL_STATUSES.has(existing.normalized_status)) {
    throw new BillingActionError("You already have an active subscription. Manage it from the Billing page instead.");
  }

  // The check above can't see a checkout that's been started but not yet
  // paid and confirmed. This atomic one-per-window guard stops two
  // near-simultaneous checkouts (a double click, two tabs) from both
  // creating a payable subscription. Checked last, so a request rejected
  // above doesn't use up the window.
  try {
    await checkRateLimit("billing:checkout_start", organization.id);
  } catch (error) {
    if (error instanceof RateLimitError) {
      throw new BillingActionError(
        "A checkout was just started for this workspace. Finish it in the payment window that's already open, or try again in a couple of minutes.",
      );
    }
    throw error;
  }

  // The durable guard: at most one open checkout per organization, held in
  // billing_checkouts (see supabase/migrations/20261007100000_billing_checkouts.sql).
  // Claimed BEFORE any Razorpay subscription is created, so a checkout left
  // open longer than the rate-limit window above still can't be joined by a
  // second payable subscription. A new claim carries a private claim token
  // that attach/release require; it stays inside this function (logs below
  // only name the checkout id) and is never part of the response.
  const claim = await claimBillingCheckout(supabase, {
    organizationId: organization.id,
    internalPlanId: parsed.planId,
    billingInterval: parsed.interval,
    currency: offering.currency,
  });
  if (claim.outcome === "conflict") {
    throw new BillingActionError(
      "Another checkout is already in progress for this workspace. Finish it, or wait up to 30 minutes for it to expire, before choosing a different plan or duration.",
    );
  }
  if (claim.outcome === "existing") {
    // No provider id yet: another request holds the claim and is creating
    // the subscription right now (or crashed mid-way — the claim's 30-minute
    // expiry is what eventually frees it). Never create a second one here.
    if (claim.providerSubscriptionId === null) throw new BillingActionError(CHECKOUT_IN_PROGRESS_MESSAGE);
    const subscriptionId = await resumeCheckoutSubscription(claim.providerSubscriptionId, {
      organizationId: organization.id,
      planId: parsed.planId,
      interval: parsed.interval,
      currency: offering.currency,
    });
    return { subscriptionId, prefillEmail: user.email };
  }

  let subscriptionId: string;
  try {
    const subscription = await getRazorpayClient().subscriptions.create({
      plan_id: offering.razorpayPlanId,
      total_count: totalCountForInterval(parsed.interval),
      customer_notify: true,
      // The primary, officially-supported organization-resolution
      // mechanism the webhook reads from — see
      // lib/billing/sync-subscription-v2.ts. internal_plan_id/
      // billing_interval/currency are captured here too (not re-derived
      // from the plan id at webhook time) so a later env var
      // reconfiguration can never retroactively change what an
      // already-created subscription resolves to. The webhook checks them
      // against the Razorpay plan the subscription is actually on.
      notes: {
        organization_id: organization.id,
        internal_plan_id: parsed.planId,
        billing_interval: parsed.interval,
        currency: offering.currency,
      },
    });
    subscriptionId = subscription.id;
  } catch (error) {
    // Sanitized for the client — getRazorpayClient()'s own "not configured"
    // error, or a raw Razorpay API failure, must never reach the browser
    // verbatim. Full detail stays server-side only.
    console.error("[razorpay] failed to create subscription", error);
    // Razorpay reported a failure, so no subscription exists for this claim:
    // release it rather than blocking the organization for the full TTL.
    // (A process crash after Razorpay succeeded never reaches here — that
    // claim stays open with no id until it expires; see the migration.)
    try {
      await releaseBillingCheckout(supabase, claim);
    } catch (releaseError) {
      console.error("[razorpay] failed to release checkout after a failed create", claim.checkoutId, releaseError);
    }
    throw new BillingActionError("Couldn't start checkout. Try again shortly or contact support.");
  }

  // The subscription exists at Razorpay now, so the customer can still pay
  // it even if recording the id fails. Logged, not thrown: the claim then
  // stays open with no id (blocking a second subscription) until it expires,
  // and the webhook still syncs the subscription by its notes.
  try {
    if (!(await attachBillingCheckoutSubscription(supabase, claim, subscriptionId))) {
      console.error("[razorpay] checkout was no longer open to attach its subscription", claim.checkoutId, subscriptionId);
    }
  } catch (error) {
    console.error("[razorpay] failed to attach subscription to checkout", claim.checkoutId, subscriptionId, error);
  }

  return { subscriptionId, prefillEmail: user.email };
}

// Provider-aware counterpart to app/(app)/billing/actions.ts's
// createPortalSessionAction: Razorpay has no hosted customer portal to
// redirect to (unlike Stripe), so "manage subscription" for a Razorpay
// subscriber means cancelling directly through this app instead. Calls
// Razorpay's own subscriptions.cancel API (a real, SDK-documented
// capability — not fabricated) and deliberately does NOT write
// subscriptions_v2 itself: per the same "only the webhook is authoritative"
// architecture createRazorpaySubscriptionAction above already follows, the
// subscription.cancelled event this call triggers is what
// syncSubscriptionFromRazorpay (already wired in app/api/webhooks/razorpay/
// route.ts) uses to update normalized_status — one writer, no drift between
// what this action assumes happened and what actually did.
//
// Always cancels immediately (cancelAtCycleEnd=false), not at period end.
// subscriptions_v2.cancel_at_period_end is hardcoded false for Razorpay
// (see sync-subscription-v2.ts's own comment: Razorpay's Subscription
// entity has no persistent "scheduled cancellation" field to read back, and
// cancel_at_cycle_end=true doesn't fire subscription.cancelled until the
// cycle genuinely ends) — a scheduled cancellation would leave this UI
// silently showing "Active" for up to a full billing period with no way to
// reflect that a cancellation is pending, which is worse than the
// confirmation dialog this pairs with (ManageRazorpaySubscriptionButton)
// being explicit that cancelling takes effect now.
export async function cancelRazorpaySubscriptionAction(): Promise<ActionResult> {
  try {
    await cancelRazorpaySubscription();
    return { ok: true, data: undefined };
  } catch (error) {
    return toActionError(error);
  }
}

async function cancelRazorpaySubscription(): Promise<void> {
  const user = await requireUser();
  const supabase = await createClient();

  const organization = await getUserOrganization(supabase, user);
  await checkRateLimit("billing:manage", organization.id);

  const subscription = await getSubscriptionV2(supabase, organization.id);
  if (!subscription || subscription.provider !== "razorpay") {
    throw new BillingActionError("No active Razorpay subscription found.");
  }
  if (!NON_TERMINAL_STATUSES.has(subscription.normalized_status)) {
    throw new BillingActionError("This subscription is already cancelled or inactive.");
  }

  try {
    await getRazorpayClient().subscriptions.cancel(subscription.provider_subscription_id, false);
  } catch (error) {
    console.error("[razorpay] failed to cancel subscription", error);
    throw new BillingActionError("Couldn't cancel the subscription. Try again shortly or contact support.");
  }
}

// Polled by the checkout button after Razorpay Checkout reports success, so
// the billing page can refresh once the webhook has actually confirmed the
// subscription. Read-only and scoped to the caller's own organization; it
// never grants anything itself — `confirmed` is true only when the
// webhook-written row for this exact subscription grants access.
export async function getRazorpayCheckoutStatusAction(subscriptionId: string): Promise<{ confirmed: boolean }> {
  const parsedSubscriptionId = razorpaySubscriptionIdSchema.parse(subscriptionId);
  const user = await requireUser();
  const supabase = await createClient();

  const organization = await getUserOrganization(supabase, user);
  const [subscription, view] = await Promise.all([
    getSubscriptionV2(supabase, organization.id),
    getActiveSubscriptionView(supabase, organization.id),
  ]);

  const confirmed =
    subscription?.provider === "razorpay" &&
    subscription.provider_subscription_id === parsedSubscriptionId &&
    view.provider === "razorpay" &&
    view.grantsAccess;
  return { confirmed };
}
