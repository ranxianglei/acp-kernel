import type { CoreMessage, ReasoningReplay } from "./types.js";

/**
 * A real user message: user-role text. Tool results are `role: "tool"` in
 * every wire codec (anthropic/openai/responses), so this is provider-agnostic
 * and marks the round boundary the provider's thinking-replay requirement
 * keys off of — the provider only replays the CURRENT open round's thinking
 * (Anthropic signature / Gemini thought_signature), never closed rounds.
 */
export function isRealUserMessage(message: CoreMessage): boolean {
  return message.role === "user" && message.contentType === "text";
}

export interface StripReasoningResult {
  messages: CoreMessage[];
  stripped: number;
}

/**
 * Strip `reasoning` messages per the replay policy.
 *
 * "always" is a no-op (legacy behavior). "open-round" keeps reasoning only
 * after the last real user message — the open round. "never" strips
 * everything. When no real user message exists, "open-round" keeps
 * everything (no closed round exists — conservative).
 */
export function stripReasoningByRound(
  messages: CoreMessage[],
  mode: ReasoningReplay,
): StripReasoningResult {
  if (mode === "always") return { messages, stripped: 0 };

  let cutoff: number;
  if (mode === "never") {
    cutoff = messages.length;
  } else {
    let lastRealUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRealUserMessage(messages[i]!)) {
        lastRealUserIndex = i;
        break;
      }
    }
    if (lastRealUserIndex === -1) return { messages, stripped: 0 };
    cutoff = lastRealUserIndex + 1;
  }

  let stripped = 0;
  const kept: CoreMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.contentType === "reasoning" && i < cutoff) {
      stripped++;
      continue;
    }
    kept.push(message);
  }
  return { messages: kept, stripped };
}
