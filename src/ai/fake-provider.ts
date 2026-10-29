import {
  AiProviderError,
  type AiProvider,
  type AiRequest,
  type AiResult,
  type AiStreamEvent,
  type AiUsage,
} from "./provider.js";

/**
 * A pretend AI used by tests and for local development without a key.
 * Costs nothing, gives the same answer every time, and can be told to be slow,
 * to fail (before or in the middle of a reply), to not report token usage, or
 * to ask for tools first - so every path can be tested. Never allowed in
 * production (see config).
 */
export interface FakeProviderOptions {
  reply?: string;
  usage?: AiUsage | null;
  /** Wait before answering (generate) or between streamed words (stream). */
  delayMs?: number;
  fail?: boolean;
  /** Stream: fail after sending this many words. */
  failAfterWords?: number;
  /**
   * Tool calls to make, one list per round, before the text reply.
   * e.g. [[{ name: "receivables_summary", args: {} }]]
   */
  toolRounds?: { name: string; args: Record<string, unknown> }[][];
  /** Build the final reply from the tool results the fake AI received. */
  replyFromTools?: (results: Record<string, unknown>[]) => string;
}

export class FakeProvider implements AiProvider {
  readonly name = "fake";
  calls = 0;
  /** The last request received (tests check what was sent to the AI). */
  lastRequest: AiRequest | null = null;
  /** Every request received, in order. */
  requests: AiRequest[] = [];

  constructor(private readonly options: FakeProviderOptions = {}) {}

  private usageFor(): AiUsage | null {
    return this.options.usage === undefined ? { inputTokens: 100, outputTokens: 20 } : this.options.usage;
  }

  async generate(request: AiRequest): Promise<AiResult> {
    this.calls += 1;
    this.lastRequest = request;
    this.requests.push(request);
    if (this.options.delayMs) await sleep(this.options.delayMs, request.signal);
    if (this.options.fail) throw new AiProviderError("fake provider failure");
    return { text: this.options.reply ?? "This is a test answer.", model: request.model, usage: this.usageFor() };
  }

  async *stream(request: AiRequest): AsyncIterable<AiStreamEvent> {
    this.calls += 1;
    this.lastRequest = request;
    this.requests.push(request);
    if (this.options.fail) throw new AiProviderError("fake provider failure");

    // Tool rounds: how many tool rounds have already happened in this conversation?
    const roundsDone = request.messages.filter((m) => m.role === "tool_results").length;
    const plannedCalls = this.options.toolRounds?.[roundsDone];
    if (plannedCalls && request.tools?.length && request.toolChoice !== "none") {
      for (const c of plannedCalls) yield { type: "tool_call", id: `call-${roundsDone}-${c.name}`, name: c.name, args: c.args };
      const usage = this.usageFor();
      if (usage) yield { type: "usage", usage, model: request.model };
      yield { type: "turn", raw: { fake: true, calls: plannedCalls } };
      return;
    }

    const results = request.messages.flatMap((m) => (m.role === "tool_results" ? m.results.map((r) => r.response) : []));
    const replyText = this.options.replyFromTools && results.length ? this.options.replyFromTools(results) : (this.options.reply ?? "This is a test answer.");
    const words = replyText.split(/(?<= )/);
    let sent = 0;
    for (const word of words) {
      if (this.options.delayMs) await sleep(this.options.delayMs, request.signal);
      if (request.signal.aborted) throw request.signal.reason ?? new Error("aborted");
      if (this.options.failAfterWords !== undefined && sent >= this.options.failAfterWords) {
        throw new AiProviderError("fake provider failed mid-stream");
      }
      yield { type: "delta", text: word };
      sent += 1;
      // Real providers send running usage totals as they go.
      const usage = this.usageFor();
      if (usage) {
        yield {
          type: "usage",
          model: request.model,
          usage: { inputTokens: usage.inputTokens, outputTokens: Math.ceil((usage.outputTokens * sent) / words.length) },
        };
      }
    }
    yield { type: "turn", raw: { fake: true, text: replyText } };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
