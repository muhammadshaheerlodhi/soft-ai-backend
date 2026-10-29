import type { Logger } from "../logger.js";
import { AiProviderError, type AiMessage, type AiProvider, type AiUsage } from "../ai/provider.js";
import { estimateInputTokens, estimateTextTokens } from "../ai/token-estimate.js";
import { AiTimeoutError, type MeteredCall, type MeteringOptions } from "./metering.js";
import type { CreditStore } from "./store.js";
import type { ToolCall, ToolResult } from "../tools/execute.js";

/**
 * Streaming version of "hold -> call -> charge" (see metering.ts), used for
 * chat replies that appear word by word, including answers that need company
 * data (tools).
 *
 *   open()  : price the worst case and HOLD credits. Not enough -> throws
 *             InsufficientCreditsError before anything is sent or saved.
 *   run()   : stream the reply, passing each piece to onDelta, then CHARGE.
 *
 * Answers with data take several rounds:
 *   round 1: the AI asks for tools -> we run them (read-only, permission-checked)
 *   round 2: the AI answers with the results (or asks once more)
 *   last round: the AI MUST answer in text (no more tools) - no endless loops.
 * One hold covers all rounds; the real total of all rounds is charged once.
 *
 * Who pays when a reply does not finish normally:
 *   - the USER stops it / closes the chat -> charge for what was produced
 *     (Google bills us for it; the user chose to stop). Outcome "stopped".
 *   - Google fails or times out           -> charge NOTHING (not the
 *     customer's fault). The hold is released and an error is thrown.
 *   - Google returns an empty reply       -> charge nothing, error.
 */

export interface ToolLogEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface StreamOutcome {
  status: "complete" | "stopped";
  text: string;
  model: string;
  /** Total of all rounds. */
  usage: AiUsage;
  /** Credits charged, e.g. "0.3120". null if charging failed (customer not charged). */
  charged: string | null;
  usageEstimated: boolean;
  reservationId: string;
  rounds: number;
  /** Tools the AI used (empty for plain answers). */
  toolCalls: ToolLogEntry[];
}

export interface RunHooks {
  /** Runs the tools the AI asked for. Without it, tool requests are ignored. */
  executeTools?: (calls: ToolCall[]) => Promise<ToolResult[]>;
  /** Called before tools run (e.g. to show "Looking up invoices…"). */
  onToolsStart?: (calls: ToolCall[]) => void | Promise<void>;
}

export interface MeteredStream {
  reservationId: string;
  run(onDelta: (text: string) => void | Promise<void>, userSignal: AbortSignal, hooks?: RunHooks): Promise<StreamOutcome>;
  /** Give the hold back without calling the AI (e.g. saving the message failed). */
  cancel(): Promise<void>;
}

const MIN_HOLD = "0.0001";
/** Room in the hold for tool results added in later rounds (results are capped at ~8,000 chars each). */
const TOOL_RESULTS_TOKENS_PER_ROUND = 9000;
/** The AI may ask for at most this many tools at once. */
const MAX_TOOL_CALLS_PER_ROUND = 4;

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
    async open(call: MeteredCall & { maxRounds?: number }): Promise<MeteredStream> {
      const { request } = call;
      const maxRounds = request.tools?.length ? Math.max(1, Math.min(call.maxRounds ?? 3, 5)) : 1;
      const estimatedInput = estimateInputTokens(request.system, request.messages, request.tools);
      // Worst case over all rounds: every round re-sends the input (+ tool results) and may write a full reply.
      const worstInput = estimatedInput * maxRounds + TOOL_RESULTS_TOKENS_PER_ROUND * (maxRounds - 1);
      const worstOutput = request.maxOutputTokens * maxRounds;
      let holdAmount = await store.computeCost(request.model, worstInput, worstOutput);
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

        async run(onDelta, userSignal, hooks = {}) {
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

          let messages: AiMessage[] = [...request.messages];
          let text = "";
          let model = request.model;
          let userStopped = false;
          let usageEstimated = false;
          let rounds = 0;
          const total: AiUsage = { inputTokens: 0, outputTokens: 0 };
          const toolLog: ToolLogEntry[] = [];

          try {
            for (let round = 1; round <= maxRounds; round++) {
              rounds = round;
              const lastRound = round === maxRounds;
              const roundRequest = {
                ...request,
                messages,
                toolChoice: request.tools?.length ? (lastRound ? ("none" as const) : ("auto" as const)) : undefined,
                signal: controller.signal,
              };
              let roundUsage: AiUsage | null = null;
              let roundText = "";
              let raw: unknown;
              const calls: ToolCall[] = [];

              try {
                for await (const event of provider.stream(roundRequest)) {
                  if (controller.signal.aborted) break;
                  if (event.type === "usage") {
                    roundUsage = event.usage;
                    model = event.model;
                  } else if (event.type === "tool_call") {
                    calls.push({ id: event.id, name: event.name, args: event.args });
                  } else if (event.type === "turn") {
                    raw = event.raw;
                  } else {
                    roundText += event.text;
                    text += event.text;
                    try {
                      await onDelta(event.text);
                    } catch {
                      controller.abort(new Error("client disconnected")); // browser gone = user stopped
                    }
                  }
                }
              } finally {
                // Count this round's tokens even if it ended early.
                if (roundUsage) {
                  total.inputTokens += roundUsage.inputTokens;
                  total.outputTokens += roundUsage.outputTokens;
                } else {
                  usageEstimated = true;
                  total.inputTokens += estimateInputTokens(request.system, messages, request.tools);
                  total.outputTokens += Math.min(request.maxOutputTokens, estimateTextTokens(roundText) + calls.length * 50);
                }
              }

              if (controller.signal.aborted) {
                if (!timedOut) userStopped = true;
                break;
              }
              if (calls.length === 0 || lastRound || !hooks.executeTools) break;

              // The AI asked for company data: run the tools, then let it answer.
              const limited = calls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
              await hooks.onToolsStart?.(limited);
              const results = await hooks.executeTools(limited);
              results.forEach((r, i) => toolLog.push({ name: r.name, args: limited[i]?.args ?? {}, ok: r.ok }));
              messages = [
                ...messages,
                { role: "model_turn", raw },
                { role: "tool_results", results: results.map((r) => ({ id: r.id, name: r.name, response: r.response })) },
              ];
            }
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

          const reference = {
            ...call.reference,
            provider: provider.name,
            model: request.model,
            provider_model: model,
            input_tokens: total.inputTokens,
            output_tokens: total.outputTokens,
            usage_estimated: usageEstimated,
            stopped_by_user: userStopped,
            rounds,
            tools: toolLog.map((t) => t.name),
          };

          let charged: string | null = null;
          for (let attempt = 1; attempt <= settleAttempts && charged === null; attempt++) {
            try {
              const cost = await store.computeCost(request.model, total.inputTokens, total.outputTokens);
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
            usage: total,
            charged,
            usageEstimated,
            reservationId,
            rounds,
            toolCalls: toolLog,
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
