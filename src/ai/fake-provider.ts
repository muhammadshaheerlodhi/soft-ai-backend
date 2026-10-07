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
 * to fail (before or in the middle of a reply), or to not report token usage,
 * so every path can be tested. Never allowed in production (see config).
 */
export interface FakeProviderOptions {
  reply?: string;
  usage?: AiUsage | null;
  /** Wait before answering (generate) or between streamed words (stream). */
  delayMs?: number;
  fail?: boolean;
  /** Stream: fail after sending this many words. */
  failAfterWords?: number;
}

export class FakeProvider implements AiProvider {
  readonly name = "fake";
  calls = 0;
  /** The last request received (tests check what was sent to the AI). */
  lastRequest: AiRequest | null = null;

  constructor(private readonly options: FakeProviderOptions = {}) {}

  private usageFor(): AiUsage | null {
    return this.options.usage === undefined ? { inputTokens: 100, outputTokens: 20 } : this.options.usage;
  }

  async generate(request: AiRequest): Promise<AiResult> {
    this.calls += 1;
    this.lastRequest = request;
    if (this.options.delayMs) await sleep(this.options.delayMs, request.signal);
    if (this.options.fail) throw new AiProviderError("fake provider failure");
    return { text: this.options.reply ?? "This is a test answer.", model: request.model, usage: this.usageFor() };
  }

  async *stream(request: AiRequest): AsyncIterable<AiStreamEvent> {
    this.calls += 1;
    this.lastRequest = request;
    if (this.options.fail) throw new AiProviderError("fake provider failure");
    const words = (this.options.reply ?? "This is a test answer.").split(/(?<= )/);
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
