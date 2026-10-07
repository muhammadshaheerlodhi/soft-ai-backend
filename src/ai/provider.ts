/**
 * The provider layer: the ONLY place that knows which AI company we call.
 * Gemini lives in gemini-provider.ts; switching to another model later means
 * writing one new provider, not changing the rest of Soft AI.
 */

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  model: string;
  system?: string;
  messages: AiMessage[];
  /**
   * Hard cap on the reply length, INCLUDING the model's hidden "thinking"
   * tokens (Gemini counts both). Also used to size the credit hold.
   */
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface AiUsage {
  /** Tokens we sent (prompt, history, system text). */
  inputTokens: number;
  /** Tokens the model produced: visible answer + hidden thinking (both billed as output). */
  outputTokens: number;
}

export interface AiResult {
  text: string;
  /** Model that actually answered (as reported by the provider). */
  model: string;
  /** Token counts reported by the provider. null = provider did not report them. */
  usage: AiUsage | null;
}

/** Pieces of a streamed reply, in order. */
export type AiStreamEvent =
  | { type: "delta"; text: string }
  /** Running totals; the LAST one is final. */
  | { type: "usage"; usage: AiUsage; model: string };

export interface AiProvider {
  readonly name: string;
  generate(request: AiRequest): Promise<AiResult>;
  stream(request: AiRequest): AsyncIterable<AiStreamEvent>;
}

/** The provider was unreachable or returned an error. */
export class AiProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiProviderError";
  }
}
