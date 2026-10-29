import Stripe from "stripe";

/**
 * Buying credits with Stripe Checkout (Stripe's own hosted payment page:
 * card details never touch Soft AI or the ERP).
 *
 *   createCheckout()  - a one-time payment page for one credit pack
 *   verifyWebhook()   - checks Stripe's signature on a webhook (forged or
 *                       replayed requests are refused) and returns the event
 *
 * Credits are added ONLY from the verified webhook, never from the browser
 * coming back to the "success" page.
 */

export interface CheckoutRequest {
  organizationId: string;
  userId: string;
  pack: { id: string; name: string; credits: string; priceCents: number; currency: string };
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | null;
}

export interface PaymentEvent {
  id: string;
  type: string;
  session: {
    id: string;
    paymentStatus: string | null;
    amountTotal: number | null;
    currency: string | null;
    paymentIntent: string | null;
    /** Our marker: only sessions Soft AI created are handled. */
    isSoftAiCredits: boolean;
  } | null;
}

export interface PaymentGateway {
  createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }>;
  /** Throws if the signature is missing, wrong or too old. */
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent;
}

export class WebhookSignatureError extends Error {
  constructor(message = "invalid signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export function createStripeGateway(opts: { secretKey?: string; webhookSecret: string }): PaymentGateway {
  // Without a secret key the gateway can still verify webhooks (tests); creating checkouts needs the key.
  const stripe = new Stripe(opts.secretKey ?? "sk_test_unused");

  return {
    async createCheckout(req) {
      if (!opts.secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.pack.currency,
              unit_amount: req.pack.priceCents,
              product_data: { name: `Soft AI - ${req.pack.name}` },
            },
          },
        ],
        client_reference_id: req.organizationId,
        ...(req.customerEmail ? { customer_email: req.customerEmail } : {}),
        // Only for matching and support; the credits come from OUR record of this session.
        metadata: { soft_ai: "credits", organization_id: req.organizationId, user_id: req.userId, pack_id: req.pack.id },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      });
      if (!session.url) throw new Error("Stripe returned no checkout URL");
      return { id: session.id, url: session.url };
    },

    verifyWebhook(rawBody, signature) {
      if (!signature) throw new WebhookSignatureError("missing signature");
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, opts.webhookSecret);
      } catch {
        throw new WebhookSignatureError();
      }
      const obj = event.data.object as Partial<Stripe.Checkout.Session> & { object?: string };
      const isSession = obj.object === "checkout.session";
      return {
        id: event.id,
        type: event.type,
        session: isSession
          ? {
              id: String(obj.id),
              paymentStatus: obj.payment_status ?? null,
              amountTotal: obj.amount_total ?? null,
              currency: obj.currency ?? null,
              paymentIntent: typeof obj.payment_intent === "string" ? obj.payment_intent : (obj.payment_intent?.id ?? null),
              isSoftAiCredits: obj.metadata?.soft_ai === "credits",
            }
          : null,
      };
    },
  };
}
