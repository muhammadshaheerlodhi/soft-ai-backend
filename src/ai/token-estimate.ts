import type { AiMessage } from "./provider.js";

/**
 * A deliberately HIGH guess of how many tokens a request will use, made BEFORE
 * calling the AI, so we can hold enough credits. The real number from the
 * provider is what we finally charge.
 *
 * Rule of thumb: ~4 characters per token for English. We use 3 bytes per
 * token on the UTF-8 size, which over-estimates on purpose; Urdu letters take
 * 2 bytes each in UTF-8, so Urdu text is also estimated on the safe (high) side.
 */
const BYTES_PER_TOKEN = 3;
const PER_MESSAGE_OVERHEAD = 8;

export function estimateInputTokens(system: string | undefined, messages: AiMessage[]): number {
  let total = system ? Math.ceil(Buffer.byteLength(system, "utf8") / BYTES_PER_TOKEN) + PER_MESSAGE_OVERHEAD : 0;
  for (const m of messages) {
    total += Math.ceil(Buffer.byteLength(m.content, "utf8") / BYTES_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
  }
  return total;
}
