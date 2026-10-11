"use client";

import { useState } from "react";
import { CheckIcon } from "lucide-react";

import {
  BILLING_INTERVALS,
  PAID_PLAN_IDS,
  PLANS,
  UNLIMITED,
  type BillingInterval,
  type PaidPlanId,
} from "@/lib/billing/plans";
import { discountPercentForInterval } from "@/lib/billing/pricing";
import type { PlanOfferingGrid, PlanOfferingView } from "@/lib/billing/offerings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckoutButton } from "./checkout-button";
import { RazorpayCheckoutButton } from "./razorpay-checkout-button";

function limitLine(label: string, value: number) {
  return value === UNLIMITED ? `Unlimited ${label}` : `${value.toLocaleString()} ${label}`;
}

const INTERVAL_LABEL: Record<BillingInterval, string> = {
  "1_month": "1 month",
  "3_month": "3 months",
  "6_month": "6 months",
  "12_month": "12 months",
};

function DisabledAction({ label, note }: { label: string; note: string }) {
  return (
    <>
      {/* Wraps rather than overflowing the narrow plan cards — these labels
          are longer than the regular checkout button's. */}
      <Button variant="outline" className="h-auto min-h-9 w-full whitespace-normal py-2 text-center" disabled>
        {label}
      </Button>
      <p className="text-center text-xs text-muted-foreground">{note}</p>
    </>
  );
}

// What a plan card offers for one offering when nothing above (current
// plan, internal workspace, existing subscription) takes precedence.
export function OfferingAction({ offering }: { offering: PlanOfferingView }) {
  const { planId, interval, currency, availability } = offering;

  if (availability === "available") {
    return (
      <>
        <p className="text-center text-xs text-muted-foreground">
          {currency === "INR"
            ? "Billed in INR via Razorpay (UPI, cards, netbanking)"
            : "Billed in USD via Razorpay (international cards)"}
        </p>
        <RazorpayCheckoutButton planId={planId} interval={interval}>
          Upgrade
        </RazorpayCheckoutButton>
        {offering.requiresRecurringAuthentication && (
          <p className="text-center text-xs text-muted-foreground">
            Each renewal is over ₹15,000, so under RBI rules your bank will ask you to approve it (for example
            with an OTP). Renewals aren&apos;t automatic until you do.
          </p>
        )}
      </>
    );
  }

  if (availability === "not_sold") {
    return currency === "INR" ? (
      <DisabledAction
        label="Not available in India yet"
        note="Payments over ₹50,000 can't be processed yet. Choose a shorter duration."
      />
    ) : (
      <DisabledAction label="Not available in your region" note="This duration can't be purchased in your region yet." />
    );
  }

  // not_configured: no Razorpay plan exists for this offering yet.
  if (currency === "USD") {
    return (
      <DisabledAction
        label="International checkout coming soon"
        note="Paid plans for customers outside India aren't available yet."
      />
    );
  }
  // Stays wired to Stripe so it starts working again unmodified if
  // STRIPE_PRICE_<PLAN>_<INTERVAL> is ever set; until then it's a disabled
  // "Coming soon".
  const priceId = PLANS[planId].priceIds[interval];
  return (
    <CheckoutButton planId={planId} interval={interval} disabled={!priceId}>
      {priceId ? "Upgrade" : "Coming soon"}
    </CheckoutButton>
  );
}

export function PlanList({
  currentPlanId,
  offerings,
  planChangeBlocked,
  internalUnlimited,
}: {
  // null when the organization has no paid plan of its own — including the
  // internal unlimited workspace, which isn't on any sellable plan.
  currentPlanId: PaidPlanId | null;
  // Resolved on the server (app/(app)/billing/page.tsx) for this request's
  // payment currency by lib/billing/offerings.ts — this component only
  // renders them, it never works out a region, currency or price itself.
  // Prices are always USD; an INR payment shows its charge via chargedAs.
  offerings: PlanOfferingGrid;
  // The organization already has a live Razorpay subscription, and starting
  // another is rejected server-side (plan changes aren't supported yet) —
  // so no other plan is offered as a purchasable "Upgrade".
  planChangeBlocked: boolean;
  // The internal workspace already has unlimited access; nothing is offered
  // for purchase (the checkout action refuses it too).
  internalUnlimited: boolean;
}) {
  const [interval, setInterval] = useState<BillingInterval>("1_month");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Billing duration">
        {BILLING_INTERVALS.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={interval === option ? "default" : "outline"}
            onClick={() => setInterval(option)}
            aria-pressed={interval === option}
          >
            {INTERVAL_LABEL[option]}
            {discountPercentForInterval(option) > 0 && (
              <span className="ml-1 text-xs opacity-80">-{discountPercentForInterval(option)}%</span>
            )}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PAID_PLAN_IDS.map((planId) => {
          const plan = PLANS[planId];
          const offering = offerings[planId][interval];
          const isCurrent = currentPlanId === planId;

          return (
            <Card key={planId} className={isCurrent ? "border-primary/40" : undefined}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{plan.name}</CardTitle>
                  {isCurrent && <Badge>Current plan</Badge>}
                </div>
                <div className="mt-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight">{offering.price.total}</span>
                    <span className="text-sm text-muted-foreground">/ {INTERVAL_LABEL[interval]}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="line-through">{offering.price.regular}</span>
                    <span>launch price</span>
                    {offering.discountPercent > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        Save {offering.discountPercent}%
                      </Badge>
                    )}
                  </div>
                  {offering.chargedAs && (
                    <p className="mt-1 text-xs text-muted-foreground">Charged as {offering.chargedAs} via Razorpay</p>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {[
                    limitLine("mailboxes", plan.limits.mailboxes),
                    limitLine("leads", plan.limits.leads),
                    limitLine("emails / month", plan.limits.emailsPerMonth),
                    limitLine("campaigns", plan.limits.campaigns),
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-2">
                      <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                      {line}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter className="flex flex-col gap-2">
                {isCurrent ? (
                  <Button variant="outline" className="w-full" disabled>
                    Current plan
                  </Button>
                ) : internalUnlimited ? (
                  <Button variant="outline" className="w-full" disabled>
                    Included in Unlimited
                  </Button>
                ) : planChangeBlocked ? (
                  <DisabledAction
                    label="Plan changes not available yet"
                    note="You already have a subscription. Switching plans isn't supported yet."
                  />
                ) : (
                  <OfferingAction offering={offering} />
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
