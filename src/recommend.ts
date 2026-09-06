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
  isNeverPreserveRecent,
} from "./protected.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default token estimate (chars/4) used when the caller doesn't inject a
 *  countTokens — preserves the historical behavior for backwards compat. */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function isToolMessage(message: CoreMessage): boolean {
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
  countTokens: (text: string) => number = estimateTextTokens,
): Set<string> {
  const preserveN = config.preserveRecentMessages;
  const preserveTokens = config.preserveRecentTokens;

  const result = new Set<string>();
  const visible: { ref: string; tokens: number }[] = [];

  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, state)) continue;
    // Exclude decompress-style tool results from the recent-zone window.
    // These are large inline restorations that the model should be free to
    // compress again immediately; counting them toward the last-N window
    // would make them un-compressible and hide them from recommendations.
    // The message stays fully visible — this only affects protection scope.
    if (isNeverPreserveRecent(msg)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    visible.push({ ref, tokens: countTokens(msg.text ?? "") });
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
  // Note: we scan the raw messages array (not `visible`) here so the last
  // user message is still found even when a decompress tool result was
  // skipped above — user intent is always protected regardless of recent
  // tool results.
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
  countTokens: (text: string) => number = estimateTextTokens,
): ContextRanges {
  const compressibleMsgs: {
    ref: string;
    gapBefore: boolean;
    tokens: number;
    chars: number;
    isTool: boolean;
    isUser: boolean;
  }[] = [];
  const protectedMsgs: {
    ref: string;
    gapBefore: boolean;
    tokens: number;
    tools: string[];
  }[] = [];

  // Pairing: a tool-result may carry only toolCallId (no toolName). Collect the
  // callIds of protected tool-calls first, then protect matching results too.
  const protectedCallIds = collectProtectedToolCallIds(messages, config);

  // Segmentation is array adjacency, never ref arithmetic: surface-replacing
  // hosts leave holes in the ref map (compressed messages leave the array, refs
  // stay assigned) and insert mid-array summary nodes with fresh HIGH refs —
  // ref arithmetic fragments every range there and emits startRef > endRef
  // pairs. Only a numbered-ref message physically skipped between two entries
  // interrupts; unrefed/BLOCKED consume no slot. On dense append-only hosts the
  // two rules coincide, so ranges are byte-identical to the old behavior.
  let skipSinceCompressible = false;
  let skipSinceProtected = false;

  for (const msg of messages) {
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    if (isSyntheticOrPruned(msg, state)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    if (isMessageProtectedWithPairing(msg, config, protectedCallIds)) {
      protectedMsgs.push({
        ref,
        gapBefore: skipSinceProtected,
        tokens: countTokens(msg.text ?? ""),
        tools: msg.toolName ? [msg.toolName] : [],
      });
      skipSinceProtected = false;
      skipSinceCompressible = true;
      continue;
    }

    if (protectedZoneRefs?.has(ref)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    compressibleMsgs.push({
      ref,
      gapBefore: skipSinceCompressible,
      tokens: countTokens(msg.text ?? ""),
      chars: (msg.text ?? "").length,
      isTool: isToolMessage(msg),
      isUser: msg.role === "user",
    });
    skipSinceCompressible = false;
    skipSinceProtected = true;
  }

  // Build compressible groups (split at real array gaps and at user messages
  // once a group has >= 3 messages). Splitting at user boundaries keeps each
  // compressible range aligned to roughly one user turn, instead of producing
  // one giant range spanning many turns. Mirrors opencode-acp's
  // buildCompressibleRanges condition.
  const compressible: CompressibleRange[] = [];
  let cur: CompressibleRange | null = null;

  for (const info of compressibleMsgs) {
    if (cur && ((info.isUser && cur.count >= 3) || info.gapBefore)) {
      compressible.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        chars: info.chars,
        toolPct: info.isTool ? 100 : 0,
        textPct: info.isTool ? 0 : 100,
      };
    } else {
      cur.endRef = info.ref;
      cur.count++;
      cur.tokens += info.tokens;
      cur.chars = (cur.chars ?? 0) + info.chars;
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

  for (const info of protectedMsgs) {
    if (pcur && info.gapBefore) {
      protectedRanges.push(pcur);
      pcur = null;
    }
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

function mergeBatch(batch: CompressibleRange[]): CompressibleRange {
  const first = batch[0]!;
  const last = batch[batch.length - 1]!;
  const count = batch.reduce((s, r) => s + r.count, 0);
  const tokens = batch.reduce((s, r) => s + r.tokens, 0);
  const chars = batch.reduce((s, r) => s + rangeChars(r), 0);
  const toolPct = Math.round(
    batch.reduce((s, r) => s + r.toolPct * r.count, 0) / count,
  );
  const merged: CompressibleRange = {
    startRef: first.startRef,
    endRef: last.endRef,
    count,
    tokens,
    chars,
    toolPct,
    textPct: 100 - toolPct,
  };
  if (batch.some((r) => r.dangerous === true)) {
    merged.dangerous = true;
  }
  return merged;
}

/** Effective size of a range in characters — the unit the apply-side
 *  minCompressRange gate uses. Falls back to the historical tokens*4
 *  estimate only for hand-built ranges that predate the `chars` field. */
function rangeChars(r: CompressibleRange): number {
  return r.chars ?? r.tokens * 4;
}

/** Merge adjacent ranges into batches that clear `minChars` of REAL text —
 *  the same accounting `applyCompression` uses — so a recommended range is
 *  never below the threshold the kernel would atomically reject. Batching by
 *  token estimates (tokens*4) instead broke whenever the host injected a
 *  tokenizer where tokens != chars/4 (CJK-aware estimators are ~1:1, so
 *  tokens*4 overestimated size ~4x and nudge recommended ranges the apply
 *  side then refused). A sub-threshold tail batch is still emitted — callers
 *  filter by effectiveness separately (see pendingByTier). */
export function mergeRangesToThreshold(
  ranges: CompressibleRange[],
  minChars: number,
): CompressibleRange[] {
  if (minChars <= 0 || ranges.length === 0) return ranges;
  const result: CompressibleRange[] = [];
  let batch: CompressibleRange[] = [];
  let batchChars = 0;
  for (const r of ranges) {
    batch.push(r);
    batchChars += rangeChars(r);
    if (batchChars >= minChars) {
      result.push(mergeBatch(batch));
      batch = [];
      batchChars = 0;
    }
  }
  if (batch.length > 0) {
    result.push(mergeBatch(batch));
  }
  return result;
}
