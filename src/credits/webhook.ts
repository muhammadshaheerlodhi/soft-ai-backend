import type { Hono } from "hono";
import type { Sql } from "../db/client.js";
import type { AppEnv } from "../http/types.js";
import { WebhookSignatureError, type PaymentGateway } from "./payments.js";

/**
 * POST /webhooks/stripe - Stripe tells us a credit payment finished.
 * (Public: there is no user login; Stripe's signature is the proof.)
 *
 *   checkout.session.completed (paid) / async_payment_succeeded -> add the credits once
 *   checkout.session.expired / async_payment_failed              -> mark the purchase expired
 *
 * Only sessions Soft AI created are handled; other Stripe events get "ignored".
 * A database problem answers 500, so Stripe retries later; adding credits is
 * idempotent (one ledger entry per checkout), so retries are safe.
 */
export function registerStripeWebhook(app: Hono<AppEnv>, opts: { sql: Sql; payments: PaymentGateway }) {
  app.post("/webhooks/stripe", async (c) => {
    const log = c.get("log");
    const raw = await c.req.text();
    let event;
    try {
      event = opts.payments.verifyWebhook(raw, c.req.header("stripe-signature"));
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        log.warn("stripe webhook with an invalid signature refused");
        return c.json({ error: "invalid signature" }, 400);
      }
      throw err;
    }

    const s = event.session;
    if (!s || !s.isSoftAiCredits) return c.json({ received: true, ignored: true });

    const paidEvent =
      (event.type === "checkout.session.completed" && s.paymentStatus === "paid") ||
      event.type === "checkout.session.async_payment_succeeded";

    if (paidEvent) {
      const [row] = await opts.sql<{ r: { result: string; organization_id?: string } }[]>`
        select soft_ai.complete_credit_purchase(${s.id}, ${s.amountTotal}::int, ${s.currency ?? ""}, ${s.paymentIntent}, ${event.id}) as r`;
      const result = row?.r.result;
      if (result === "unknown_session" || result === "amount_mismatch") {
        log.error({ sessionId: s.id, result }, "stripe credit payment could not be matched - check manually");
      } else {
        log.info({ sessionId: s.id, result, organizationId: row?.r.organization_id }, "credit purchase processed");
      }
      return c.json({ received: true, result });
    }

    if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      await opts.sql`select soft_ai.expire_credit_purchase(${s.id})`;
      return c.json({ received: true, result: "expired" });
    }

    // e.g. completed but the payment method is still processing: wait for the next event.
    return c.json({ received: true, result: "waiting" });
  });
}
