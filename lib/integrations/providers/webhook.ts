import { assertPublicMailHost, MailHostNotAllowedError } from "@/lib/email/mail-host-guard";
import { IntegrationDeliveryError, type IntegrationDeliveryResult, type IntegrationPayload, type IntegrationProvider } from "../provider";

// Bounds how long a single delivery attempt can hang — a slow/unreachable
// destination must not block the digest worker from moving on to the next
// organization's integration.
const REQUEST_TIMEOUT_MS = 10_000;

export interface WebhookIntegrationConfig {
  url: string;
}

// The only real (non-placeholder) provider in this milestone — a generic
// webhook needs no vendor SDK or credentials beyond a URL, unlike
// DnsProvider/ReputationProvider, which have no real data source to plug
// into yet. Posts the digest as JSON; the receiving endpoint decides what
// to do with it.
export class WebhookIntegrationProvider implements IntegrationProvider {
  constructor(private readonly config: WebhookIntegrationConfig) {}

  async send(payload: IntegrationPayload): Promise<IntegrationDeliveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      // lib/validations/integrations.ts rejects private hostnames typed
      // literally; this also catches a name that resolves to one. Redirects
      // aren't followed, so a public URL can't bounce the POST to an
      // internal address either — a 3xx is reported as a failed delivery.
      await assertPublicMailHost(new URL(this.config.url).hostname);
      response = await fetch(this.config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof MailHostNotAllowedError) {
        throw new IntegrationDeliveryError("The webhook URL points to a private address, which isn't allowed.", "failed");
      }
      // Network error, DNS failure, or the abort above — all transient
      // from this destination's perspective, not a reason to stop trying
      // on the next scheduled run.
      const message = error instanceof Error ? error.message : "Unknown network error.";
      throw new IntegrationDeliveryError(message, "retry");
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return { delivered: true };
    }

    // 5xx is the destination's own transient failure; 4xx means the
    // configuration itself (URL, expected auth) is wrong and won't
    // self-heal by retrying, though the worker still tries again next run
    // since there's no separate backoff/suppression path for integrations.
    const outcome = response.status >= 500 ? "retry" : "failed";
    throw new IntegrationDeliveryError(`Webhook responded with status ${response.status}.`, outcome);
  }
}
