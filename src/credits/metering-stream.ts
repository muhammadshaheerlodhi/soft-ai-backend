import type { Logger } from "../logger.js";
import { AiProviderError, type AiProvider, type AiUsage } from "../ai/provider.js";
import { estimateInputTokens } from "../ai/token-estimate.js";
import { AiTimeoutError, type MeteredCall, type MeteringOptions } from "./metering.js";
import type { CreditStore } from "./store.js";

/**
 * Streaming version of "hold -> call -> charge" (see metering.ts), used for
 * chat replies that appear word by word.
 *
 *   open()  : price the worst case and HOLD credits. Not enough -> throws
 *             InsufficientCreditsError before anything is sent or saved.
 *   run()   : stream the reply, passing each piece to onDelta, then CHARGE.
 *
 * Who pays when a reply does not finish normally:
 *   - the USER stops it / closes the chat -> charge for what was produced
 *     (Google bills us for it; the user chose to stop). Outcome "stopped".
 *   - Google fails or times out           -> charge NOTHING (not the
 *     customer's fault). The hold is released and an error is thrown.
 *   - Google returns an empty reply       -> charge nothing, error.
 */

export interface StreamOutcome {
  status: "complete" | "stopped";
  text: string;
  model: string;
  usage: AiUsage;
  /** Credits charged, e.g. "0.3120". null if charging failed (customer not charged). */
  charged: string | null;
  usageEstimated: boolean;
  reservationId: string;
}

export interface MeteredStream {
  reservationId: string;
  run(onDelta: (text: string) => void | Promise<void>, userSignal: AbortSignal): Promise<StreamOutcome>;
  /** Give the hold back without calling the AI (e.g. saving the message failed). */
  cancel(): Promise<void>;
}

const MIN_HOLD = "0.0001";
const BYTES_PER_TOKEN = 3;

export function createStreamMeter(deps: {
  store: CreditStore;
  provider: AiProvider;
  logger: Logger;
  options: MeteringOptions;
}) {
  const { store, provider, logger, options } = deps;
  const settleAttempts = options.settleAttempts ?? 3;
  const settleDelay = options.settleRetryDelayMs ?? 200;
  const holdTtlSeconds = Math.min(3600, Math.ceil(options.timeoutMs / 1000) + 120);

  return {
    async open(call: MeteredCall): Promise<MeteredStream> {
      const { request } = call;
      const estimatedInput = estimateInputTokens(request.system, request.messages);
      let holdAmount = await store.computeCost(request.model, estimatedInput, request.maxOutputTokens);
      if (/^0+(\.0+)?$/.test(holdAmount)) holdAmount = MIN_HOLD;
      const reservationId = await store.reserve(call.organizationId, call.userId, holdAmount, holdTtlSeconds);
      let finished = false;

      return {
        reservationId,

        async cancel() {
          if (finished) return;
          finished = true;
          await releaseQuietly(reservationId);
        },

        async run(onDelta, userSignal) {
          if (finished) throw new Error("stream already used");
          finished = true;

          const controller = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort(new AiTimeoutError());
          }, options.timeoutMs);
          const onUserAbort = () => controller.abort(new Error("stopped by user"));
          if (userSignal.aborted) onUserAbort();
          else userSignal.addEventListener("abort", onUserAbort, { once: true });

          let text = "";
          let lastUsage: AiUsage | null = null;
          let model = request.model;
          let userStopped = false;

          try {
            for await (const event of provider.stream({ ...request, signal: controller.signal })) {
              if (controller.signal.aborted) break;
              if (event.type === "usage") {
                lastUsage = event.usage;
                model = event.model;
                continue;
              }
              text += event.text;
              try {
                await onDelta(event.text);
              } catch {
                // Could not deliver to the browser (connection gone): treat as the user stopping.
                controller.abort(new Error("client disconnected"));
              }
            }
            if (controller.signal.aborted && !timedOut) userStopped = true;
          } catch (err) {
            if (timedOut) {
              await releaseQuietly(reservationId);
              throw new AiTimeoutError();
            }
            if (controller.signal.aborted) {
              userStopped = true; // aborted by the user while the provider was mid-request
            } else {
              await releaseQuietly(reservationId);
              throw err instanceof AiProviderError ? err : new AiProviderError("AI request failed", { cause: err });
            }
          } finally {
            clearTimeout(timer);
            userSignal.removeEventListener("abort", onUserAbort);
          }

          if (timedOut) {
            await releaseQuietly(reservationId);
            throw new AiTimeoutError();
          }
          if (!userStopped && text.trim() === "") {
            await releaseQuietly(reservationId);
            throw new AiProviderError("AI returned an empty reply");
          }

          // Usage: provider totals if we got them; otherwise a high estimate (flagged).
          const usageEstimated = lastUsage === null;
          const usage: AiUsage = lastUsage ?? {
            inputTokens: estimatedInput,
            outputTokens: Math.min(request.maxOutputTokens, Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN)),
          };

          const reference = {
            ...call.reference,
            provider: provider.name,
            model: request.model,
            provider_model: model,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            usage_estimated: usageEstimated,
            stopped_by_user: userStopped,
          };

          let charged: string | null = null;
          for (let attempt = 1; attempt <= settleAttempts && charged === null; attempt++) {
            try {
              const cost = await store.computeCost(request.model, usage.inputTokens, usage.outputTokens);
              await store.settle(reservationId, cost, reference);
              charged = cost;
            } catch (err) {
              logger.warn({ err, attempt }, "credit charge attempt failed");
              if (attempt < settleAttempts) await new Promise((r) => setTimeout(r, settleDelay * attempt));
            }
          }
          if (charged === null) {
            logger.error({ reservationId, reference }, "credit charge failed after retries; hold will expire uncharged");
          }

          return {
            status: userStopped ? "stopped" : "complete",
            text,
            model,
            usage,
            charged,
            usageEstimated,
            reservationId,
          };
        },
      };
    },
  };

  async function releaseQuietly(reservationId: string) {
    try {
      await store.release(reservationId);
    } catch (err) {
      logger.warn({ err, reservationId }, "could not release credit hold; it will expire");
    }
  }
}

export type StreamMeter = ReturnType<typeof createStreamMeter>;
