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
  collectLatestProtected,
  collectProtectedToolCallIds,
  isMessageLatestProtected,
  isMessageProtectedWithPairing,
  isNeverPreserveRecent,
} from "./protected.js";
import { countMessageTokens } from "./tokenize.js";
import {
  computeIntegrityWithdrawals,
  computeTurnGroups,
} from "./turn-integrity.js";

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
    visible.push({ ref, tokens: countMessageTokens(msg, countTokens) });
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
interface CompressibleInfo {
  id: string;
  ref: string;
  gapBefore: boolean;
  tokens: number;
  chars: number;
  isTool: boolean;
  isUser: boolean;
  index: number;
}

/** Message ids of in-progress turns (#344): turns holding a tool-call that
 *  has no tool-result anywhere in the array (an open call). Folding such a
 *  turn would absorb the session's live, unfinished exchange — the range
 *  endpoint lands inside the sequence and the model loses its working context
 *  mid-task. The whole turn group is excluded from the compressible set and
 *  treated as a gap; the triggering user message stays compressible (user
 *  messages carry no wire-level pairing constraint, and the recent-zone
 *  default already protects the tail).
 *
 *  A burst that is only partially complete (some calls already have results)
 *  is likewise open and excluded wholesale. Returns an empty set when every
 *  call has a result — the common case, zero overhead. */
export function computeOpenTurnMemberIds(messages: CoreMessage[]): Set<string> {
  const resultCallIds = new Set<string>();
  for (const msg of messages) {
    if (
      msg.contentType === "tool-result" &&
      typeof msg.toolCallId === "string"
    ) {
      resultCallIds.add(msg.toolCallId);
    }
  }
  const openCallIds = new Set<string>();
  for (const msg of messages) {
    if (
      msg.id &&
      msg.role === "assistant" &&
      msg.contentType === "tool-call" &&
      typeof msg.toolCallId === "string" &&
      !resultCallIds.has(msg.toolCallId)
    ) {
      openCallIds.add(msg.id);
    }
  }
  if (openCallIds.size === 0) return new Set();
  const excluded = new Set<string>();
  for (const group of computeTurnGroups(messages)) {
    if (!group.some((id) => openCallIds.has(id))) continue;
    for (const id of group) excluded.add(id);
  }
  return excluded;
}

export function buildCompressibleRanges(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  protectedZoneRefs?: Set<string>,
  countTokens: (text: string) => number = estimateTextTokens,
): ContextRanges {
  let compressibleMsgs: CompressibleInfo[] = [];
  const protectedMsgs: {
    ref: string;
    gapBefore: boolean;
    tokens: number;
    tools: string[];
    index: number;
  }[] = [];

  // Pairing: a tool-result may carry only toolCallId (no toolName). Collect the
  // callIds of protected tool-calls first, then protect matching results too.
  const protectedCallIds = collectProtectedToolCallIds(messages, config);
  // Latest-only protected calls: their results are covered by the pairing
  // union; the calls themselves need the explicit check below (pairing only
  // matches tool-results).
  const latest = collectLatestProtected(messages, config);
  for (const id of latest.callIds) protectedCallIds.add(id);

  // Segmentation is array adjacency, never ref arithmetic: surface-replacing
  // hosts leave holes in the ref map (compressed messages leave the array, refs
  // stay assigned) and insert mid-array summary nodes with fresh HIGH refs —
  // ref arithmetic fragments every range there and emits startRef > endRef
  // pairs. Only a numbered-ref message physically skipped between two entries
  // interrupts; unrefed/BLOCKED consume no slot. On dense append-only hosts the
  // two rules coincide, so ranges are byte-identical to the old behavior.
  let skipSinceCompressible = false;
  let skipSinceProtected = false;
  let msgIndex = -1;

  for (const msg of messages) {
    msgIndex++;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    if (isSyntheticOrPruned(msg, state)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    if (
      isMessageProtectedWithPairing(msg, config, protectedCallIds) ||
      isMessageLatestProtected(msg, latest)
    ) {
      protectedMsgs.push({
        ref,
        gapBefore: skipSinceProtected,
        tokens: countMessageTokens(msg, countTokens),
        tools: msg.toolName ? [msg.toolName] : [],
        index: msgIndex,
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
      id: msg.id,
      ref,
      gapBefore: skipSinceCompressible,
      tokens: countMessageTokens(msg, countTokens),
      chars: (msg.text ?? "").length,
      isTool: isToolMessage(msg),
      isUser: msg.role === "user",
      index: msgIndex,
    });
    skipSinceCompressible = false;
    skipSinceProtected = true;
  }

  // Structure-aware selection (#344): keep in-progress turns out of the
  // compressible set so no candidate range ends inside an unfinished
  // tool-call sequence. No-op when every call has a result.
  const openTurnIds = computeOpenTurnMemberIds(messages);
  if (openTurnIds.size > 0) {
    let gapPending = false;
    const kept: CompressibleInfo[] = [];
    for (const info of compressibleMsgs) {
      if (openTurnIds.has(info.id)) {
        gapPending = true;
        continue;
      }
      kept.push(gapPending ? { ...info, gapBefore: true } : info);
      gapPending = false;
    }
    compressibleMsgs = kept;
  }

  // Foldability: the fold gate (src/compress.ts) withdraws every message whose
  // turn would lose its reasoning run or whose call/result pair it would split,
  // because the protected-zone carve removes individual messages after the
  // range is built. A residual range that brushes the zone can therefore hold
  // nothing the fold may take: it was advertised as compressible, and folding
  // it then failed with "Range would split N tool call/result pair(s)". Screen
  // the same messages out here so every advertised range is foldable, and treat
  // each removed message as a gap so no range spans it.
  const unfoldedIds = computeIntegrityWithdrawals(
    messages,
    new Set(compressibleMsgs.map((info) => info.id)),
  ).withdrawn;
  if (unfoldedIds.size > 0) {
    let gapPending = false;
    const kept: typeof compressibleMsgs = [];
    for (const info of compressibleMsgs) {
      if (unfoldedIds.has(info.id)) {
        gapPending = true;
        continue;
      }
      kept.push(gapPending ? { ...info, gapBefore: true } : info);
      gapPending = false;
    }
    compressibleMsgs = kept;
  }

  // Per-segment foldability (#344): the screen above assumes the ENTIRE
  // compressible set folds together, but each recommended range folds on its
  // own. A gap inside the compressible region (protected tool, zone edge) can
  // separate a call from its result — or a turn's reasoning from its calls —
  // leaving segments that the fold gate always empties when taken alone.
  // Re-run the integrity gate per contiguous segment until stable; withdrawn
  // messages become gaps so no range spans them. Self-contained histories
  // converge in one no-op pass (output byte-identical to before this step).
  const gapCount = compressibleMsgs.reduce(
    (s, info) => s + (info.gapBefore ? 1 : 0),
    0,
  );
  if (gapCount > 0) {
    compressibleMsgs = refineSegmentsForFoldability(messages, compressibleMsgs);
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
        userMsgs: info.isUser ? 1 : 0,
        startIndex: info.index,
        endIndex: info.index,
      };
    } else {
      cur.endRef = info.ref;
      cur.endIndex = info.index;
      cur.count++;
      cur.tokens += info.tokens;
      cur.chars = (cur.chars ?? 0) + info.chars;
      if (info.isUser) cur.userMsgs = (cur.userMsgs ?? 0) + 1;
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
        startIndex: info.index,
        endIndex: info.index,
      };
    } else {
      pcur.endRef = info.ref;
      pcur.endIndex = info.index;
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

/** Hard stop for the per-segment refinement loop. Every productive pass
 *  removes at least one message, so real sessions converge in a few passes;
 *  the cap bounds worst-case cost on adversarial interleave chains. Reaching
 *  it leaves the remaining ranges exactly as pre-refinement — the state the
 *  apply-side fold gate already guards against, never worse. */
const MAX_REFINEMENT_PASSES = 8;

function refineSegmentsForFoldability(
  messages: CoreMessage[],
  infos: CompressibleInfo[],
): CompressibleInfo[] {
  let current = infos;
  for (let pass = 0; pass < MAX_REFINEMENT_PASSES; pass++) {
    const segments: CompressibleInfo[][] = [];
    for (const info of current) {
      const seg = segments[segments.length - 1];
      if (seg === undefined || info.gapBefore) segments.push([info]);
      else seg.push(info);
    }
    const removed = new Set<string>();
    for (const seg of segments) {
      const withdrawn = computeIntegrityWithdrawals(
        messages,
        new Set(seg.map((info) => info.id)),
      ).withdrawn;
      for (const info of seg) {
        if (withdrawn.has(info.id)) removed.add(info.id);
      }
    }
    if (removed.size === 0) break;
    let gapPending = false;
    const kept: CompressibleInfo[] = [];
    for (const info of current) {
      if (removed.has(info.id)) {
        gapPending = true;
        continue;
      }
      kept.push(gapPending ? { ...info, gapBefore: true } : info);
      gapPending = false;
    }
    current = kept;
  }
  return current;
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
    userMsgs: batch.reduce((s, r) => s + (r.userMsgs ?? 0), 0),
  };
  if (first.startIndex !== undefined && last.endIndex !== undefined) {
    merged.startIndex = Math.min(...batch.map((r) => r.startIndex ?? Infinity));
    merged.endIndex = Math.max(...batch.map((r) => r.endIndex ?? -Infinity));
  }
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
 *  side then refused). Invariant: EVERY returned batch alone clears
 *  `minChars`. A sub-threshold tail is folded into the preceding batch
 *  (overshoot allowed); if no batch precedes it, nothing is emitted — the
 *  whole remainder is below the gate, so no selection of it can pass and
 *  offering it only yields guaranteed-rejected calls (billion-context #847). */
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
  if (batch.length > 0 && result.length > 0) {
    const prev = result[result.length - 1]!;
    result[result.length - 1] = mergeBatch([prev, ...batch]);
  }
  return result;
}
