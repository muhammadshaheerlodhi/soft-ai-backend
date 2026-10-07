/**
 * The provider layer: the ONLY place that knows which AI company we call.
 * Gemini lives in gemini-provider.ts; switching to another model later means
 * writing one new provider, not changing the rest of Soft AI.
 */

/** A normal chat message. */
export interface AiTextMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * A model turn that asked for tools, kept EXACTLY as the provider returned it
 * (Gemini attaches hidden "thought signatures" that must be sent back unchanged).
 */
export interface AiModelTurnMessage {
  role: "model_turn";
  raw: unknown;
}

/** Our answers to the tools the model asked for. */
export interface AiToolResultsMessage {
  role: "tool_results";
  results: { id?: string; name: string; response: Record<string, unknown> }[];
}

export type AiMessage = AiTextMessage | AiModelTurnMessage | AiToolResultsMessage;

/** A tool the model may ask us to run (see src/tools/registry.ts). */
export interface AiToolDeclaration {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>;
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
  tools?: AiToolDeclaration[];
  /** "none" = the model must answer in text now (used for the last round). */
  toolChoice?: "auto" | "none";
  signal: AbortSignal;
}

export interface AiUsage {
  /** Tokens we sent (prompt, history, system text, tool results). */
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
  /** Running totals for THIS request; the LAST one is final. */
  | { type: "usage"; usage: AiUsage; model: string }
  /** The model asks us to run a tool. */
  | { type: "tool_call"; id?: string; name: string; args: Record<string, unknown> }
  /** At the end of the stream: the whole model turn, to replay if tools were called. */
  | { type: "turn"; raw: unknown };

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
