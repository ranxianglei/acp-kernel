/**
 * Recommendation engine — compression protection + recommendation.
 *
 * Clean-room reimplementation of the recommendation algorithm (MIT, ours).
 * These pure functions answer two questions every turn:
 *
 *  1. **Protection** — which messages must NOT be compressed? (protected tools,
 *     recent messages, recent tokens)
 *  2. **Recommendation** — which remaining ranges are actually WORTH compressing?
 *     (growth-aware threshold; suppress nudges when ranges are too small)
 *
 * Called by the `recommend` pipeline node. No side effects, no state mutation.
 */

import type {
  CompressibleRange,
  Config,
  ContextRanges,
  CoreMessage,
  ProtectedRange,
} from "./types.js";
import type { CompressionState } from "./types.js";
import {
  collectProtectedToolCallIds,
  isMessageProtectedWithPairing,
} from "./protected.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function refNum(ref: string): number {
  const n = parseInt(ref.slice(1), 10);
  return Number.isNaN(n) ? -1 : n;
}

function estimateMessageTokens(message: CoreMessage): number {
  return Math.ceil((message.text ?? "").length / 4);
}

function isToolMessage(message: CoreMessage): boolean {
  return message.contentType === "tool-call" || message.contentType === "tool-result";
}


function isSyntheticOrPruned(
  message: CoreMessage,
  state: CompressionState,
): boolean {
  if (message.text?.startsWith("[Compressed conversation section]")) return true;
  for (const block of state.blocks) {
    if (block.active && block.effectiveMessageIds.includes(message.id)) return true;
  }
  return false;
}

// ─── 1. Protected Refs (soft protection zone) ─────────────────────────────────

/**
 * Compute the set of protected message refs (mNNNNN) that form the
 * "soft-protected zone" at the tail of the conversation.
 *
 * Combines two rules:
 *   1. Last N messages (`config.preserveRecentMessages`)
 *   2. Last N tokens expanding backward (`config.preserveRecentTokens`)
 *
 * Only considers visible, non-synthetic, non-pruned messages that have refs.
 */
export function computeProtectedRefs(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
): Set<string> {
  const preserveN = config.preserveRecentMessages;
  const preserveTokens = config.preserveRecentTokens;

  const result = new Set<string>();
  const visible: { ref: string; tokens: number }[] = [];

  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, state)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    visible.push({ ref, tokens: estimateMessageTokens(msg) });
  }

  // Rule 1: last N messages
  if (preserveN > 0) {
    for (const m of visible.slice(-preserveN)) {
      result.add(m.ref);
    }
  }

  // Rule 2: last N tokens (expand backward from tail)
  if (preserveTokens > 0) {
    let tokenAccum = 0;
    for (let i = visible.length - 1; i >= 0 && tokenAccum < preserveTokens; i--) {
      result.add(visible[i]!.ref);
      tokenAccum += visible[i]!.tokens;
    }
  }

  // Rule 3: last visible user message. Protected whenever recent-message
  // protection is on (preserveRecentMessages > 0) — this couples it to the
  // same switch as Rule 1, so setting preserveRecentMessages = 0 fully opts
  // out (needed by tests that compress the tail). Production defaultConfig
  // uses 5, so the last user message is always protected in practice.
  if (preserveN > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role !== "user" || isSyntheticOrPruned(msg, state)) continue;
      const ref = state.messageRefs.byRaw[msg.id];
      if (ref && ref !== "BLOCKED") result.add(ref);
      break;
    }
  }

  return result;
}

// ─── 2. Build Compressible + Protected Ranges ────────────────────────────────

/**
 * Build compressible and protected range groups from the message list.
 *
 * Messages are classified into:
 *   - **compressible**: normal messages outside the protected zone
 *   - **protected**: messages from protected tools (e.g., skill, task)
 *   - **skipped**: covered by blocks, synthetic, or in the protected zone
 *
 * Compressible messages are grouped into contiguous ranges. The protected
 * zone (from `computeProtectedRefs`) splits groups — the unprotected head
 * survives as its own range.
 */
export function buildCompressibleRanges(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  protectedZoneRefs?: Set<string>,
): ContextRanges {
  const compressibleMsgs: {
    ref: string;
    refNum: number;
    tokens: number;
    isTool: boolean;
    isUser: boolean;
  }[] = [];
  const protectedMsgs: {
    ref: string;
    refNum: number;
    tokens: number;
    tools: string[];
  }[] = [];

  // Pairing: a tool-result may carry only toolCallId (no toolName). Collect the
  // callIds of protected tool-calls first, then protect matching results too.
  const protectedCallIds = collectProtectedToolCallIds(messages, config);

  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, state)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;

    const rn = refNum(ref);

    if (isMessageProtectedWithPairing(msg, config, protectedCallIds)) {
      protectedMsgs.push({
        ref,
        refNum: rn,
        tokens: estimateMessageTokens(msg),
        tools: msg.toolName ? [msg.toolName] : [],
      });
      continue;
    }

    if (protectedZoneRefs?.has(ref)) {
      continue;
    }

    compressibleMsgs.push({
      ref,
      refNum: rn,
      tokens: estimateMessageTokens(msg),
      isTool: isToolMessage(msg),
      isUser: msg.role === "user",
    });
  }

  // Build compressible groups (contiguous, split at ref gaps and at user
  // messages once a group has >= 3 messages). Splitting at user boundaries
  // keeps each compressible range aligned to roughly one user turn, instead
  // of producing one giant range spanning many turns (or, conversely, a
  // fragment per message when ref gaps appear). Mirrors opencode-acp's
  // buildCompressibleRanges condition.
  const compressible: CompressibleRange[] = [];
  let cur: CompressibleRange | null = null;
  let prevRefNum = -2;

  for (const info of compressibleMsgs) {
    const hasGap = info.refNum > prevRefNum + 1;
    if (cur && ((info.isUser && cur.count >= 3) || hasGap)) {
      compressible.push(cur);
      cur = null;
    }
    prevRefNum = info.refNum;
    if (!cur) {
      cur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        toolPct: info.isTool ? 100 : 0,
        textPct: info.isTool ? 0 : 100,
      };
    } else {
      cur.endRef = info.ref;
      cur.count++;
      cur.tokens += info.tokens;
      if (info.isTool) {
        cur.toolPct = Math.round((cur.toolPct * (cur.count - 1) + 100) / cur.count);
      } else {
        cur.toolPct = Math.round((cur.toolPct * (cur.count - 1)) / cur.count);
      }
      cur.textPct = 100 - cur.toolPct;
    }
  }
  if (cur) compressible.push(cur);

  // Build protected groups (contiguous)
  const protectedRanges: ProtectedRange[] = [];
  let pcur: ProtectedRange | null = null;
  let pPrevRefNum = -2;

  for (const info of protectedMsgs) {
    const hasGap = info.refNum > pPrevRefNum + 1;
    if (pcur && hasGap) {
      protectedRanges.push(pcur);
      pcur = null;
    }
    pPrevRefNum = info.refNum;
    if (!pcur) {
      pcur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        tools: [...info.tools],
      };
    } else {
      pcur.endRef = info.ref;
      pcur.count++;
      pcur.tokens += info.tokens;
      for (const t of info.tools) {
        if (!pcur!.tools.includes(t)) pcur!.tools.push(t);
      }
    }
  }
  if (pcur) protectedRanges.push(pcur);

  return {
    compressible: compressible.filter((g) => g.tokens > 0),
    protected: protectedRanges,
  };
}
