import type { Logger } from "../logger.js";
import { AiProviderError, type AiProvider, type AiRequest, type AiResult } from "../ai/provider.js";
import { estimateInputTokens } from "../ai/token-estimate.js";
import type { CreditStore } from "./store.js";

/**
 * Every paid AI call goes through runMetered(). The order is always:
 *
 *   1. price the WORST case (estimated input + the reply length cap)
 *   2. HOLD that many credits      -> not enough? stop here, the AI is never called
 *   3. call the AI (with a timeout)
 *   4a. success -> CHARGE the real cost from the provider's token counts
 *   4b. failure -> RELEASE the hold, nothing is charged
 *
 * If charging fails because the database is briefly unreachable, we retry a
 * few times. If it still fails, the hold simply expires and the credits go
 * back to the customer: in doubt, the customer is never overcharged. We log it
 * so it can be reconciled.
 */

export class AiTimeoutError extends Error {
  constructor() {
    super("The AI took too long to answer.");
    this.name = "AiTimeoutError";
  }
}

export interface MeteringOptions {
  /** How long we wait for the AI before giving up. */
  timeoutMs: number;
  /** How many attempts to charge the real cost before giving up (customer is not charged). */
  settleAttempts?: number;
  /** Pause between charge attempts (grows each attempt). */
  settleRetryDelayMs?: number;
}

export interface MeteredCall {
  organizationId: string;
  userId: string;
  request: Omit<AiRequest, "signal">;
  /** Extra details stored with the charge (e.g. message id). */
  reference?: Record<string, unknown>;
}

export interface MeteredResult {
  result: AiResult;
  /** Credits charged, e.g. "1.7510". null if charging failed (customer not charged). */
  charged: string | null;
  /** true if the provider did not report token counts and we charged the estimate. */
  usageEstimated: boolean;
  reservationId: string;
}

const MIN_HOLD = "0.0001";

export function createMeteredRunner(deps: {
  store: CreditStore;
  provider: AiProvider;
  logger: Logger;
  options: MeteringOptions;
}) {
  const { store, provider, logger, options } = deps;
  const settleAttempts = options.settleAttempts ?? 3;
  const settleDelay = options.settleRetryDelayMs ?? 200;
  // The hold must outlive the AI call: timeout + 2 minutes of margin (max 1 hour in the database).
  const holdTtlSeconds = Math.min(3600, Math.ceil(options.timeoutMs / 1000) + 120);

  return async function runMetered(call: MeteredCall): Promise<MeteredResult> {
    const { request } = call;
    const log = logger.child({ organizationId: call.organizationId, model: request.model });

    // 1. worst-case price. Throws ModelNotPricedError if an admin has not set a price.
    const estimatedInput = estimateInputTokens(request.system, request.messages);
    let holdAmount = await store.computeCost(request.model, estimatedInput, request.maxOutputTokens);
    if (isZero(holdAmount)) holdAmount = MIN_HOLD; // even a free model respects the zero-credit stop

    // 2. hold. Throws InsufficientCreditsError -> the AI is never called.
    const reservationId = await store.reserve(call.organizationId, call.userId, holdAmount, holdTtlSeconds);

    // 3. call the AI with a hard timeout (even if the provider ignores the abort signal).
    let result: AiResult;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AiTimeoutError());
        }, options.timeoutMs);
      });
      result = await Promise.race([provider.generate({ ...request, signal: controller.signal }), timeout]);
    } catch (err) {
      // 4b. failure: give the hold back, charge nothing.
      await releaseQuietly(reservationId);
      if (err instanceof AiTimeoutError) throw err;
      if (controller.signal.aborted) throw new AiTimeoutError();
      if (err instanceof AiProviderError) throw err;
      throw new AiProviderError("AI request failed", { cause: err });
    } finally {
      clearTimeout(timer);
    }

    // 4a. success: charge the real cost.
    const usageEstimated = result.usage === null;
    const reference = {
      ...call.reference,
      provider: provider.name,
      model: request.model,
      provider_model: result.model,
      input_tokens: result.usage?.inputTokens ?? estimatedInput,
      output_tokens: result.usage?.outputTokens ?? request.maxOutputTokens,
      usage_estimated: usageEstimated,
    };

    const charged = await chargeWithRetry(async () => {
      // Price by the model WE asked for (the provider may report a longer version name).
      const cost = result.usage
        ? await store.computeCost(request.model, result.usage.inputTokens, result.usage.outputTokens)
        : holdAmount; // no token counts reported: charge the (high) estimate, flagged above
      await store.settle(reservationId, cost, reference);
      return cost;
    });

    if (charged === null) {
      log.error({ reservationId, reference }, "credit charge failed after retries; hold will expire uncharged");
    } else if (usageEstimated) {
      log.warn({ reservationId }, "provider did not report token usage; charged the estimate");
    }

    return { result, charged, usageEstimated, reservationId };
  };

  async function chargeWithRetry(charge: () => Promise<string>): Promise<string | null> {
    for (let attempt = 1; attempt <= settleAttempts; attempt++) {
      try {
        return await charge();
      } catch (err) {
        logger.warn({ err, attempt }, "credit charge attempt failed");
        if (attempt < settleAttempts) await sleep(settleDelay * attempt);
      }
    }
    return null;
  }

  async function releaseQuietly(reservationId: string) {
    try {
      await store.release(reservationId);
    } catch (err) {
      // Not fatal: the hold expires by itself and the credits come back.
      logger.warn({ err, reservationId }, "could not release credit hold; it will expire");
    }
  }
}

function isZero(amount: string): boolean {
  return /^0+(\.0+)?$/.test(amount);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
