import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { AiProviderError, type AiProvider, type AiRequest, type AiResult, type AiStreamEvent, type AiUsage } from "./provider.js";

/**
 * Google Gemini, through Google's official SDK (@google/genai).
 *
 * We use the stateless generateContent API on purpose: we send the chat
 * history ourselves and keep it in OUR database. (Google's newer
 * "Interactions" API stores conversations on Google's side for 55 days by
 * default; generateContent does not keep a conversation there.)
 *
 * Billing facts this code relies on (Google docs / SDK types, Oct 2026):
 *  - maxOutputTokens includes the hidden "thinking" tokens
 *  - thinking tokens are billed at the OUTPUT price
 *    -> outputTokens = candidatesTokenCount + thoughtsTokenCount
 *  - tool prompts are billed as input -> inputTokens = promptTokenCount + toolUsePromptTokenCount
 *  - stopping a request on our side does not stop Google's billing for it
 *
 * Tools (function calling): a model turn that asks for tools is replayed
 * EXACTLY as received (all parts, including hidden thoughtSignature fields),
 * as Google requires for stateless use.
 */

export interface GeminiProviderOptions {
  apiKey: string;
  /** "MINIMAL" | "LOW" | "MEDIUM" | "HIGH", or undefined to use the model's default. */
  thinkingLevel?: keyof typeof ThinkingLevel;
}

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenAI;

  constructor(private readonly options: GeminiProviderOptions) {
    if (!options.apiKey) throw new Error("GEMINI_API_KEY is required for the Gemini provider");
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
  }

  async generate(request: AiRequest): Promise<AiResult> {
    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: request.model,
        contents: toContents(request),
        config: this.config(request),
      });
    } catch (err) {
      if (request.signal.aborted) throw err;
      throw new AiProviderError(describe(err), { cause: err });
    }
    return {
      text: response.text ?? "",
      model: response.modelVersion ?? request.model,
      usage: toUsage(response),
    };
  }

  async *stream(request: AiRequest): AsyncIterable<AiStreamEvent> {
    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.client.models.generateContentStream({
        model: request.model,
        contents: toContents(request),
        config: this.config(request),
      });
    } catch (err) {
      if (request.signal.aborted) throw err;
      throw new AiProviderError(describe(err), { cause: err });
    }

    const turnParts: Part[] = [];
    try {
      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          turnParts.push(part); // kept unchanged (signatures included) for replay
          if (part.functionCall?.name) {
            yield {
              type: "tool_call",
              id: part.functionCall.id,
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            };
          } else if (typeof part.text === "string" && part.text && !part.thought) {
            yield { type: "delta", text: part.text };
          }
        }
        const usage = toUsage(chunk);
        if (usage) yield { type: "usage", usage, model: chunk.modelVersion ?? request.model };
      }
    } catch (err) {
      if (request.signal.aborted) throw err;
      throw new AiProviderError(describe(err), { cause: err });
    }
    yield { type: "turn", raw: { role: "model", parts: turnParts } satisfies Content };
  }

  private config(request: AiRequest): GenerateContentConfig {
    const config: GenerateContentConfig = {
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.signal,
    };
    if (request.system) config.systemInstruction = request.system;
    if (this.options.thinkingLevel) {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel[this.options.thinkingLevel] };
    }
    if (request.tools?.length) {
      config.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters,
          })),
        },
      ];
      config.toolConfig = {
        functionCallingConfig: {
          mode: request.toolChoice === "none" ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO,
        },
      };
    }
    return config;
  }
}

function toContents(request: AiRequest): Content[] {
  return request.messages.map((m): Content => {
    switch (m.role) {
      case "user":
        return { role: "user", parts: [{ text: m.content }] };
      case "assistant":
        return { role: "model", parts: [{ text: m.content }] };
      case "model_turn":
        return m.raw as Content; // exactly as Gemini sent it
      case "tool_results":
        return {
          role: "user",
          parts: m.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: r.response } })),
        };
    }
  });
}

function toUsage(response: GenerateContentResponse): AiUsage | null {
  const u = response.usageMetadata;
  if (!u || u.promptTokenCount === undefined) return null;
  return {
    inputTokens: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0),
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

/** Short error description for logs. Never includes the API key or prompts. */
function describe(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const status = (err as { status?: unknown }).status;
    const name = (err as { name?: unknown }).name;
    return `Gemini request failed${status ? ` (status ${String(status)})` : ""}${name ? ` [${String(name)}]` : ""}`;
  }
  return "Gemini request failed";
}
