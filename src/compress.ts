import { assignRefs, highestUsedIndex } from "./refs.js";
import { prune } from "./prune.js";
import { syncBlocks } from "./sync.js";
import { advanceSurvival, activeBlocks, blockById } from "./state.js";
import {
  allocateBlockId,
  allocateRunId,
  createInitialState,
} from "./state.js";
import { defaultCountTokens } from "./tokenize.js";
import { validateConfig } from "./config.js";
import { resolveBoundaries, earliestIndexOfIds } from "./boundaries.js";
import { truncateLargeToolOutputs } from "./truncate-tools.js";
import { hideConsumedCompressCalls } from "./hide-consumed.js";
import { applyMessageFilters, listMessageFilters } from "./filter/index.js";
import { createRenderRefsNode } from "./render-refs.js";
import type { RenderStrategy } from "./render-refs.js";
import { isMessageProtected } from "./protected.js";
import { adjustBoundariesForToolPairs } from "./tool-pairs.js";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
} from "./recommend.js";
import {
  runPipeline,
  type PipelineContext,
  type PipelineNode,
  type NodeIO,
} from "./pipeline.js";
import type {
  ApplyCompressionResult,
  CompressionBlock,
  CompressionState,
  CompressionTier,
  Config,
  ContextBreakdown,
  CoreMessage,
  NudgeConfig,
  NudgeDecision,
  ProcessTurnResult,
  Recommendation,
  StatusReport,
} from "./types.js";

export interface Ports {
  countTokens?: (text: string) => number;
}

export interface CompressionCore {
  processTurn(input: ProcessTurnInput): ProcessTurnResult;
  applyCompression(input: ApplyCompressionInput): ApplyCompressionResult;
  defaultNodes(): PipelineNode[];
  decompress(
    blockId: string,
    state: CompressionState,
  ): CompressionBlock | undefined;
  search(query: string, state: CompressionState): CompressionBlock[];
  status(
    state: CompressionState,
    tokenCount: number,
    config: Config,
  ): StatusReport;
}

export interface ProcessTurnInput {
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  tokenCount: number;
  /**
   * Which messages get an <acp> ref tag injected into their text
   * (the render-refs pipeline node). Refs are ALWAYS assigned regardless
   * (assign-refs node runs unconditionally).
   *   - "all" (default): tag every mapped message — in-process hosts
   *     like pai-acp want tags for the LLM to reference compress ranges.
   *   - "text-only": tag only user/assistant text; leave tool-call args
   *     and tool-result content pristine — proxy hosts where structured
   *     content must not be polluted.
   *   - "none": leave all text untouched — hosts that read the ref map
   *     directly from result.state.messageRefs.
   */
  renderTags?: RenderStrategy;
}

export interface ApplyCompressionInput {
  ranges: {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
    summaryMaxChars?: number;
  }[];
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  protectedMessageIds?: Set<string>;
}

export function createCore(ports: Ports = {}): CompressionCore {
  const countTokens = ports.countTokens ?? defaultCountTokens;

  function applyCompression(
    input: ApplyCompressionInput,
  ): ApplyCompressionResult {
    const state: CompressionState = cloneState(input.state);
    const runId = allocateRunId(state);
    let blocksCreated = 0;
    let tokensCompressed = 0;
    const errors: string[] = [];
    const warnings: string[] = [];

    // Default to the soft-protected zone (recent-N + last user message) when the
    // caller doesn't pass an explicit set. This makes applyCompression safe by
    // default; applySingleRange enforces it as a hard backstop.
    const protectedMessageIds =
      input.protectedMessageIds ??
      computeProtectedRefs(input.messages, input.state, input.config, countTokens);

    const preExistingCoverage = collectCoverage(state);

    const rangeIndexSets: { spec: typeof input.ranges[number]; indices: number[] }[] = [];
    for (const spec of input.ranges) {
      let resolved;
      try {
        resolved = resolveBoundaries({
          startRef: spec.startRef,
          endRef: spec.endRef,
          messages: input.messages,
          state,
        });
      } catch {
        continue;
      }
      const indices = resolved.messageIds.map((id) =>
        input.messages.findIndex((m) => m.id === id),
      ).filter((i) => i >= 0);
      rangeIndexSets.push({ spec, indices });
    }
    const sortedRanges = [...rangeIndexSets].sort((a, b) => {
      const aMin = a.indices.length > 0 ? Math.min(...a.indices) : Infinity;
      const bMin = b.indices.length > 0 ? Math.min(...b.indices) : Infinity;
      return aMin - bMin;
    });
    // Overlapping ranges warn+skip (earliest wins) rather than aborting the
    // whole batch — see ISSUE-42 / dog/billion-context-pi#21.
    const skipSpecs = new Set<typeof input.ranges[number]>();
    let acceptedMaxIndex = -1;
    for (const entry of sortedRanges) {
      const entryMax = entry.indices.length > 0 ? Math.max(...entry.indices) : -1;
      const entryMin = entry.indices.length > 0 ? Math.min(...entry.indices) : -1;
      if (entryMin >= 0 && entryMin <= acceptedMaxIndex) {
        skipSpecs.add(entry.spec);
        warnings.push(
          `Skipped range (${entry.spec.startRef}..${entry.spec.endRef}) — overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`,
        );
        continue;
      }
      if (entryMax > acceptedMaxIndex) acceptedMaxIndex = entryMax;
    }

    if (input.config.compress.minCompressRange > 0 && input.ranges.length > 0) {
      let totalRangeChars = 0;
      let hasBlockBoundaryRange = false;
      for (const spec of input.ranges) {
        if (skipSpecs.has(spec)) continue;
        let resolved;
        try {
          resolved = resolveBoundaries({
            startRef: spec.startRef,
            endRef: spec.endRef,
            messages: input.messages,
            state,
          });
        } catch {
          continue;
        }
        if (resolved.boundaryKind === "block") {
          hasBlockBoundaryRange = true;
          continue;
        }
        for (const id of resolved.messageIds) {
          const msg = input.messages.find((m) => m.id === id);
          totalRangeChars += msg?.text?.length ?? 0;
        }
      }
      if (!hasBlockBoundaryRange && totalRangeChars < input.config.compress.minCompressRange) {
        return {
          state: input.state,
          result: {
            blocksCreated: 0,
            tokensCompressed: 0,
            errors: [
              `Total compressible content too small (${totalRangeChars} chars across ${input.ranges.length} range(s), min ${input.config.compress.minCompressRange}). Combine more messages into your range(s) to meet the threshold.`,
            ],
            warnings: [],
          },
        };
      }
    }

    for (const spec of input.ranges) {
      if (skipSpecs.has(spec)) continue;
      try {
        const outcome = applySingleRange({
          spec,
          messages: input.messages,
          state,
          runId,
          config: input.config,
          protectedMessageIds,
          countTokens,
          preExistingCoverage,
        });
        blocksCreated++;
        tokensCompressed += outcome.tokens;
        warnings.push(...outcome.warnings);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    state.stats.compressionCount += blocksCreated;
    state.stats.tokensCompressed += tokensCompressed;

    if (blocksCreated > 0) {
      // Compress succeeded: clear the growth baseline so the next turn
      // re-establishes it at the new (lower) token count. Without this the
      // nudge re-fires in a feedback loop (the §5.7 baseline-reset bug).
      state.nudge.lastPerMessageNudgeTokens = 0;
      state.nudge.lastNudgeShownTokens = 0;
      // Clearing the per-tier cadence too: after a successful compression
      // (which may have consumed blocks of tier N to produce tier N+1), every
      // tier should be eligible to re-evaluate from the new token count.
      state.nudge.lastShownByTier = {};
    }

    return { state, result: { blocksCreated, tokensCompressed, errors, warnings } };
  }

  function processTurn(input: ProcessTurnInput): ProcessTurnResult {
    const configErrors = validateConfig(input.config);
    if (configErrors.length > 0) {
      console.warn(`[acp-kernel] Config validation warnings: ${configErrors.join("; ")}. Thresholds may not fire correctly.`);
    }
    const ctx: PipelineContext = {
      config: input.config,
      tokenCount: input.tokenCount,
      countTokens,
    };
    const initial: NodeIO = {
      messages: input.messages,
      state: input.state,
      effects: {},
    };
    // Conversion (assign-refs) and rendering (render-refs) are separate
    // concerns. Refs are always assigned; renderTags only controls which
    // message texts receive an <acp> tag.
    const strategy: RenderStrategy = input.renderTags ?? "all";
    const nodes = buildNodes(strategy);
    const result = runPipeline(nodes, initial, ctx);
    return {
      messages: result.messages,
      state: result.state,
      nudge: result.effects.nudge,
    };
  }

  function decompress(blockId: string, state: CompressionState) {
    return blockById(state, blockId);
  }

  function search(query: string, state: CompressionState): CompressionBlock[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    if (terms.length === 0) return [];
    const scored = activeBlocks(state)
      .map((block) => ({ block, score: scoreRelevance(block, terms) }))
      .filter((entry) => entry.score > 0.1)
      .sort((left, right) => right.score - left.score);
    return scored.map((entry) => entry.block);
  }

  function status(
    state: CompressionState,
    tokenCount: number,
    config: Config,
  ): StatusReport {
    const active = activeBlocks(state);
    const usage =
      config.modelContextLimit > 0 ? tokenCount / config.modelContextLimit : 0;
    return {
      contextUsage: usage,
      tokenCount,
      modelContextLimit: config.modelContextLimit,
      activeBlocks: active.length,
      totalBlocks: state.blocks.length,
      tokensCompressed: state.stats.tokensCompressed,
      breakdown: { active: active.length, total: state.blocks.length },
    };
  }

  function defaultNodes(): PipelineNode[] {
    return buildNodes("all");
  }

  /** Build the pipeline node list for a given render strategy. "none" omits
   *  the render-refs node entirely; "all"/"text-only" append a render-refs
   *  node bound to that strategy. */
  function buildNodes(strategy: RenderStrategy): PipelineNode[] {
    const base: PipelineNode[] = [
      assignRefsNode,
      syncBlocksNode,
      pruneNode,
      filterNode,
      hideCompressCallsNode,
      recommendNode,
      nudgeNode,
      emergencyTruncateNode,
    ];
    if (strategy === "none") return base;
    return [...base, createRenderRefsNode(strategy)];
  }

  return { processTurn, applyCompression, defaultNodes, decompress, search, status };
}

// --- Pipeline nodes -------------------------------------------------------
// Each node owns ONE concern. The ref map has a SINGLE writer (assignRefsNode);
// tags are DERIVED at the end (renderRefsNode) — no dual source of truth, so
// the old stripHallucinations band-aid is gone. Truncation is the LAST
// token-reducing safety valve; render-refs is the final annotation pass.

const assignRefsNode: PipelineNode = {
  name: "assign-refs",
  run(io, ctx) {
    const hasProtection =
      ctx.config.protectedTools.length > 0 || !!ctx.config.isToolProtected;
    const protectedFn = hasProtection
      ? (m: CoreMessage) => isMessageProtected(m, ctx.config)
      : undefined;
    const refResult = assignRefs(io.messages, {
      existing: io.state.messageRefs,
      nextIndex: highestUsedIndex(io.state.messageRefs) + 1,
      isProtected: protectedFn,
    });
    return { ...io, state: { ...io.state, messageRefs: refResult.map } };
  },
};

const syncBlocksNode: PipelineNode = {
  name: "sync-blocks",
  run(io, ctx) {
    const synced = syncBlocks(io.messages, io.state);
    advanceSurvival(synced.state, ctx.config.promotionThreshold);
    return { ...io, state: synced.state };
  },
};

const pruneNode: PipelineNode = {
  name: "prune",
  run(io) {
    return { ...io, messages: prune(io.messages, io.state) };
  },
};

const filterNode: PipelineNode = {
  name: "filter",
  enabled: (_io, ctx) =>
    !!ctx.config.messageFilters?.enabled && listMessageFilters().length > 0,
  run(io, ctx) {
    const applied = applyMessageFilters(io.messages, ctx.config.messageFilters);
    return { ...io, messages: applied.messages };
  },
};

const hideCompressCallsNode: PipelineNode = {
  name: "hide-compress-calls",
  run(io) {
    const hidden = hideConsumedCompressCalls(io.state, io.messages);
    return { ...io, messages: hidden.messages };
  },
};

const recommendNode: PipelineNode = {
  name: "recommend",
  run(io, ctx) {
    const protectedRefs = computeProtectedRefs(
      io.messages,
      io.state,
      ctx.config,
      ctx.countTokens,
    );
    const contextRanges = buildCompressibleRanges(
      io.messages,
      io.state,
      ctx.config,
      protectedRefs,
      ctx.countTokens,
    );
    const nothingToCompress = contextRanges.compressible.length === 0;
    const recommendation: Recommendation = {
      contextRanges,
      recommendedRanges: contextRanges.compressible,
      nothingToCompress,
    };
    return { ...io, effects: { ...io.effects, recommendation } };
  },
};

const nudgeNode: PipelineNode = {
  name: "nudge-inject",
  run(io, ctx) {
    const nudge = decideNudge({
      tokenCount: ctx.tokenCount,
      config: ctx.config,
      state: io.state,
      messages: io.messages,
      recommendation: io.effects.recommendation,
      countTokens: ctx.countTokens,
    });

    const baseline = io.state.nudge.lastPerMessageNudgeTokens;
    const nudgeGrowthTokens = resolveAdaptiveGrowth(
      ctx.config.modelContextLimit,
      ctx.config.nudge,
    );

    let stamped = { ...io.state.nudge };

    if (
      baseline > 0 &&
      ctx.tokenCount < baseline - nudgeGrowthTokens
    ) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
      stamped.lastNudgeShownTokens = 0;
    }

    if (stamped.lastPerMessageNudgeTokens === 0) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
    }

    if (nudge.shouldInject) {
      stamped.lastNudgeShownTokens = ctx.tokenCount;
      // Record the injected tier's own cadence baseline. Shared baseline
      // (lastNudgeShownTokens) suppresses lower-priority tiers within this
      // turn; the per-tier entry throttles re-firing of the SAME tier.
      if (nudge.tier !== null) {
        stamped.lastShownByTier = { ...stamped.lastShownByTier, [nudge.tier]: ctx.tokenCount };
      }
    }

    return {
      ...io,
      state: { ...io.state, nudge: stamped },
      effects: { ...io.effects, nudge },
    };
  },
};

const emergencyTruncateNode: PipelineNode = {
  name: "emergency-truncate",
  run(io, ctx) {
    const usage =
      ctx.config.modelContextLimit > 0
        ? ctx.tokenCount / ctx.config.modelContextLimit
        : 0;
    if (usage < ctx.config.truncate.threshold) return io;
    const trunc = truncateLargeToolOutputs(
      io.messages,
      ctx.tokenCount,
      ctx.config,
      ctx.countTokens,
      { protectRecentMessages: ctx.config.preserveRecentMessages },
    );
    return {
      ...io,
      messages: trunc.messages,
      effects: { ...io.effects, truncatedCount: trunc.truncatedCount },
    };
  },
};

interface SingleRangeInput {
  spec: { startRef: string; endRef: string; summary: string; topic?: string; compressCallId?: string; summaryMaxChars?: number };
  messages: CoreMessage[];
  state: CompressionState;
  runId: string;
  config: Config;
  protectedMessageIds?: Set<string>;
  countTokens: (text: string) => number;
  preExistingCoverage: Set<string>;
}

interface SingleRangeOutcome {
  tokens: number;
  warnings: string[];
}

function applySingleRange(input: SingleRangeInput): SingleRangeOutcome {
  const warnings: string[] = [];
  const resolved = resolveBoundaries({
    startRef: input.spec.startRef,
    endRef: input.spec.endRef,
    messages: input.messages,
    state: input.state,
  });

  const rangeMessageIds = applyToolPairAdjustment(
    resolved,
    input.messages,
  );

  // Re-scan for nested blocks in the ADJUSTED range (tool-pair extension may
  // have pulled in messages that are anchors of existing blocks).
  if (rangeMessageIds.length > resolved.messageIds.length) {
    const indexByRawId = new Map<string, number>();
    input.messages.forEach((m, i) => indexByRawId.set(m.id, i));
    const adjustedStart = indexByRawId.get(rangeMessageIds[0]!) ?? resolved.startIndex;
    const adjustedEnd = indexByRawId.get(rangeMessageIds[rangeMessageIds.length - 1]!) ?? resolved.endIndex;
    const nestedSeen = new Set(resolved.nestedBlockIds);
    for (const block of activeBlocks(input.state)) {
      if (nestedSeen.has(block.blockId)) continue;
      const anchor = earliestIndexOfIds(block.effectiveMessageIds, indexByRawId);
      if (anchor !== null && anchor >= adjustedStart && anchor <= adjustedEnd) {
        nestedSeen.add(block.blockId);
        resolved.nestedBlockIds.push(block.blockId);
      }
    }
  }

  const isBlockBoundary = resolved.boundaryKind === "block";
  const targetTier = resolveTargetTier(
    input.state,
    resolved.nestedBlockIds,
    isBlockBoundary,
  );
  const outputTier = isBlockBoundary
    ? (Math.min(3, targetTier + 1) as CompressionTier)
    : 1;

  const consumedBlockIds = resolved.nestedBlockIds.filter((id) => {
    const block = blockById(input.state, id);
    return block?.active && block.tier === targetTier;
  });

  const effectiveMessageIds = new Set<string>(rangeMessageIds);
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      for (const id of consumed.effectiveMessageIds)
        effectiveMessageIds.add(id);
    }
  }

  const directMessageIds = [...effectiveMessageIds].filter(
    (id) => !input.preExistingCoverage.has(id),
  );

  let filteredIds = filterProtectedToolMessages(
    directMessageIds,
    input.messages,
    input.config,
  );

  // filterProtectedToolMessages drops protected tool calls (and their paired
  // results) from the compressible set. They must also leave effectiveMessageIds,
  // otherwise the block would record them as covered and hide them from view.
  // (Bug 39: protected tool messages folded into a block.)
  if (filteredIds.length < directMessageIds.length) {
    const kept = new Set(filteredIds);
    for (const id of directMessageIds) {
      if (!kept.has(id)) effectiveMessageIds.delete(id);
    }
  }

  // SOFT PROTECTION: the recent-N / last-user-message zone is advisory-only at
  // compress time. Instead of failing the whole range when it brushes protected
  // messages, exclude those messages and proceed with the rest (so the model
  // isn't blocked when it picks a range that slightly overlaps the recent
  // window). If excluding them empties the range entirely AND there are no
  // consumed blocks to merge, we still fail — there is genuinely nothing to
  // compress. `protectedMessageIds` holds REF ids (mNNNNN) from
  // computeProtectedRefs; filteredIds holds RAW message ids, so convert via
  // state.messageRefs.byRaw before testing membership.
  const protectedRefs = input.protectedMessageIds;
  const hitProtectedRaw = protectedRefs
    ? filteredIds.filter((id) => {
        const ref = input.state.messageRefs.byRaw[id];
        return ref !== undefined && protectedRefs.has(ref);
      })
    : [];
  if (hitProtectedRaw.length > 0) {
    const protectedSet = new Set(hitProtectedRaw);
    filteredIds = filteredIds.filter((id) => !protectedSet.has(id));
    // Remove protected messages from effective coverage too, so they are NOT
    // hidden by the new block (they must stay fully visible).
    for (const id of hitProtectedRaw) effectiveMessageIds.delete(id);

    const hitRefs = hitProtectedRaw
      .map((id) => input.state.messageRefs.byRaw[id])
      .filter((v): v is string => typeof v === "string");

    if (filteredIds.length === 0 && consumedBlockIds.length === 0) {
      const recentN = input.config.preserveRecentMessages;
      throw new Error(
        `Range is entirely within the protected zone (the last ${recentN} messages and/or the most recent user message): ${hitRefs.join(
          ", ",
        )}. Adjust startId/endId to older messages.`,
      );
    }
    warnings.push(
      `Excluded ${hitProtectedRaw.length} protected message(s) ${hitRefs.join(
        ", ",
      )} from compression range (recent/last-user zone).`,
    );
  }

  validateCompressionRange(input, filteredIds, consumedBlockIds.length);

  let compressedTokens = 0;
  for (const id of filteredIds) {
    const message = input.messages.find((entry) => entry.id === id);
    compressedTokens += input.countTokens(message?.text ?? "");
  }
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      compressedTokens += input.countTokens(consumed.summary);
    }
  }

  const blockId = allocateBlockId(input.state);
  const block: CompressionBlock = {
    blockId,
    runId: input.runId,
    tier: outputTier,
    topic: input.spec.topic,
    summary: input.spec.summary,
    directMessageIds: filteredIds,
    effectiveMessageIds: [...effectiveMessageIds],
    directBlockIds: [...consumedBlockIds],
    compressedTokens,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: input.spec.compressCallId,
    startRef: input.spec.startRef,
    endRef: input.spec.endRef,
  };
  input.state.blocks.push(block);

  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) consumed.active = false;
  }

  return { tokens: compressedTokens, warnings };
}

function applyToolPairAdjustment(
  resolved: { startIndex: number; endIndex: number; messageIds: string[]; boundaryKind: string },
  messages: CoreMessage[],
): string[] {
  if (resolved.boundaryKind === "block") {
    return resolved.messageIds;
  }
  const adjusted = adjustBoundariesForToolPairs(
    resolved.startIndex,
    resolved.endIndex,
    messages,
  );
  if (
    adjusted.startIndex === resolved.startIndex &&
    adjusted.endIndex === resolved.endIndex
  ) {
    return resolved.messageIds;
  }
  const ids: string[] = [];
  for (let i = adjusted.startIndex; i <= adjusted.endIndex; i++) {
    const msg = messages[i];
    if (msg) ids.push(msg.id);
  }
  return ids;
}

function validateCompressionRange(
  input: SingleRangeInput,
  directMessageIds: string[],
  consumedBlockCount: number,
): void {
  const cfg = input.config.compress;
  const summary = input.spec.summary?.trim() ?? "";

  if (summary.length === 0) {
    throw new Error(
      "Summary is empty — provide a meaningful summary of the compressed range.",
    );
  }

  if (cfg.minSummaryLength > 0 && summary.length < cfg.minSummaryLength) {
    throw new Error(
      `Summary too short (${summary.length} chars, min ${cfg.minSummaryLength}). The summary must capture the compressed range's key information.`,
    );
  }

  const effectiveMax = input.spec.summaryMaxChars ?? cfg.maxSummaryLength;
  if (
    effectiveMax > 0 &&
    summary.length > effectiveMax
  ) {
    throw new Error(
      `Summary too long (${summary.length} chars, max ${effectiveMax}). Strip noise — keep critical paths, decisions, errors, and code references. Or pass summaryMaxChars to increase the limit — don't lose critical info just to fit.`,
    );
  }

  if (directMessageIds.length === 0 && consumedBlockCount === 0) {
    throw new Error(
      "Range contains no compressible messages — all are already covered by active blocks or protected.",
    );
  }
}

function filterProtectedToolMessages(
  directMessageIds: string[],
  messages: CoreMessage[],
  config: Config,
): string[] {
  // Protected tool calls (and their results, paired by toolCallId) stay in
  // visible context and are simply dropped from the compressible set. They are
  // NOT folded into the summary — the summary reflects what the author wrote,
  // nothing auto-appended.
  const protectedCallIds = new Set<string>();
  const removedIds = new Set<string>();
  for (const msg of messages) {
    if (isMessageProtected(msg, config) && msg.toolCallId) {
      protectedCallIds.add(msg.toolCallId);
    }
  }

  for (const id of directMessageIds) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (isMessageProtected(msg, config)) {
      removedIds.add(id);
      if (msg.toolCallId) protectedCallIds.add(msg.toolCallId);
    }
  }

  for (const id of directMessageIds) {
    if (removedIds.has(id)) continue;
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (
      msg.contentType === "tool-result" &&
      msg.toolCallId &&
      protectedCallIds.has(msg.toolCallId)
    ) {
      removedIds.add(id);
    }
  }

  return directMessageIds.filter((id) => !removedIds.has(id));
}

function resolveTargetTier(
  state: CompressionState,
  nestedBlockIds: string[],
  isBlockBoundary: boolean,
): CompressionTier {
  if (!isBlockBoundary) return 1;
  if (nestedBlockIds.length === 0) return 1;
  let minTier: CompressionTier = 3;
  for (const id of nestedBlockIds) {
    const block = blockById(state, id);
    if (block && block.tier < minTier) minTier = block.tier;
  }
  return minTier;
}

function collectCoverage(state: CompressionState): Set<string> {
  const coverage = new Set<string>();
  for (const block of activeBlocks(state)) {
    for (const id of block.effectiveMessageIds) coverage.add(id);
  }
  return coverage;
}

interface NudgeInput {
  tokenCount: number;
  config: Config;
  state: CompressionState;
  messages: CoreMessage[];
  recommendation?: Recommendation;
  countTokens: (t: string) => number;
}

function resolveAdaptiveGrowth(
  modelContextLimit: number,
  nudge: NudgeConfig,
): number {
  if (!modelContextLimit || modelContextLimit <= 0) return nudge.growthFloor;
  return Math.min(
    nudge.growthCap,
    Math.max(
      nudge.growthFloor,
      Math.round(modelContextLimit * nudge.growthRatio),
    ),
  );
}

/** Compressible amount for each tier — all tiers use the SAME definition
 *  ("how much can be compressed at this tier"), so they are handled by one
 *  unified loop. T1 = compressible raw-message tokens (excludes protected /
 *  already-covered); T2 = total summary tokens of all active tier-1 blocks;
 *  T3 = total summary tokens of all active tier-2 blocks. The "zero filter"
 *  for block tiers is simply that all blocks are compressible by default. */
function pendingByTier(
  state: CompressionState,
  recommendation: Recommendation | undefined,
  countTokens: (t: string) => number,
): Record<number, { pending: number; targetBlocks: CompressionBlock[] }> {
  const out: Record<number, { pending: number; targetBlocks: CompressionBlock[] }> = {};
  const compressible = recommendation?.contextRanges.compressible ?? [];
  out[1] = { pending: compressible.reduce((s, r) => s + r.tokens, 0), targetBlocks: [] };
  const active = activeBlocks(state);
  const t1 = active.filter((b) => b.tier === 1);
  const t2 = active.filter((b) => b.tier === 2);
  out[2] = { pending: t1.reduce((s, b) => s + countTokens(b.summary), 0), targetBlocks: t1 };
  out[3] = { pending: t2.reduce((s, b) => s + countTokens(b.summary), 0), targetBlocks: t2 };
  return out;
}

function decideNudge(input: NudgeInput): NudgeDecision {
  const { config, state, tokenCount, recommendation, countTokens } = input;
  const limit = config.modelContextLimit;
  const usage = limit > 0 ? tokenCount / limit : 0;

  const nudgeGrowthTokens = resolveAdaptiveGrowth(limit, config.nudge);

  const overLimit = usage >= config.nudge.maxContextLimitPct;
  const emergencyOverride = usage >= config.nudge.emergencyThresholdPct;

  const baseline = state.nudge.lastPerMessageNudgeTokens;
  const hadPendingNudge = state.nudge.lastNudgeShownTokens > 0;

  const hasPendingNudge = hadPendingNudge;
  const effectiveThreshold = hasPendingNudge
    ? Math.floor(nudgeGrowthTokens / 2)
    : nudgeGrowthTokens;

  const growthReference =
    state.nudge.lastNudgeShownTokens > 0
      ? state.nudge.lastNudgeShownTokens
      : baseline > 0
        ? baseline
        : tokenCount;

  const growthFloor = Math.max(
    config.nudge.minGrowthFloor,
    config.nudge.minGrowthRatio * nudgeGrowthTokens,
  );

  const growthSinceReference = tokenCount - growthReference;

  const rec = recommendation;
  const tiers = pendingByTier(state, rec, countTokens);

  // Unified injection arbitration, priority T1 > T2 > T3 (ascending). Each
  // tier has its OWN cadence (lastShownByTier) so firing one doesn't block
  // another across turns; within a turn we inject at most the FIRST eligible
  // tier and stop, which raises the shared baseline (lastNudgeShownTokens) so
  // lower-priority tiers see a higher reference and naturally defer.
  let injectedTier: CompressionTier | null = null;
  let injectedReason = "";
  // growth acts as the "has accumulated since baseline" signal; pending is the
  // "there is enough compressible content" signal. Both must hold for a
  // non-emergency injection. This keeps the first turn (growth 0) from firing
  // immediately even if a lot is compressible — it just establishes baseline.
  const growthReady = growthSinceReference >= growthFloor;
  if (!overLimit && growthReady) {
    for (const tier of [1, 2, 3] as const) {
      if (!config.tiers.enabled && tier > 1) break;
      const info = tiers[tier];
      if (!info || info.pending < nudgeGrowthTokens) continue;
      const lastShown = state.nudge.lastShownByTier[tier] ?? 0;
      // Per-tier cadence: even with growth, a tier that fired recently waits
      // for its own cadence window. First time (lastShown===0) is always met.
      const cadenceMet = lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (!cadenceMet) continue;
      injectedTier = tier;
      injectedReason = tier === 1
        ? `T1 compressible ${info.pending} >= ${nudgeGrowthTokens}, growth ${growthSinceReference}, usage ${Math.round(usage * 100)}%`
        : `T${tier} distill ready: ${info.targetBlocks.length} tier-${tier - 1} blocks (${info.pending} tokens) >= ${nudgeGrowthTokens}, usage ${Math.round(usage * 100)}%`;
      break;
    }
  } else if (overLimit) {
    // Over maxContextLimitPct: bypass growth gate + cadence, accept any tier
    // with pending >= 1. emergencyThresholdPct is the stronger tier that also
    // trips the truncate node (see truncate.threshold, default 0.95).
    for (const tier of [1, 2, 3] as const) {
      if (!config.tiers.enabled && tier > 1) break;
      const info = tiers[tier];
      if (!info || info.pending < 1) continue;
      injectedTier = tier;
      injectedReason = emergencyOverride
        ? `EMERGENCY: usage ${Math.round(usage * 100)}% >= ${Math.round(config.nudge.emergencyThresholdPct * 100)}%, T${tier} pending ${info.pending}`
        : `OVER-LIMIT: usage ${Math.round(usage * 100)}% >= ${Math.round(config.nudge.maxContextLimitPct * 100)}%, T${tier} pending ${info.pending}`;
      break;
    }
  }

  const shouldInject = overLimit || injectedTier !== null;

  let reason: string;
  if (emergencyOverride && injectedTier !== null) {
    reason = injectedReason;
  } else if (emergencyOverride) {
    reason = `EMERGENCY: usage ${Math.round(usage * 100)}% >= ${Math.round(config.nudge.emergencyThresholdPct * 100)}% (no compressible content)`;
  } else if (overLimit && injectedTier !== null) {
    reason = injectedReason;
  } else if (overLimit) {
    reason = `OVER-LIMIT: usage ${Math.round(usage * 100)}% >= ${Math.round(config.nudge.maxContextLimitPct * 100)}% (no compressible content)`;
  } else if (injectedTier !== null) {
    reason = injectedReason;
  } else {
    const tiersList = [1, 2, 3] as const;
    const eligible = tiersList.filter((t) => config.tiers.enabled || t === 1);
    const ready = eligible
      .filter((t) => (tiers[t]?.pending ?? 0) >= nudgeGrowthTokens)
      .map((t) => `T${t} ${tiers[t]!.pending}`);
    const readyHint = ready.length > 0 ? `, ready: ${ready.join(", ")}` : "";
    const blocked = eligible
      .filter((t) => (tiers[t]?.pending ?? 0) >= nudgeGrowthTokens && (state.nudge.lastShownByTier[t] ?? 0) > 0 && tokenCount - (state.nudge.lastShownByTier[t] ?? 0) < growthFloor)
      .map((t) => `T${t} (cadence)`);
    const blockedHint = blocked.length > 0 ? `, blocked: ${blocked.join(", ")}` : "";
    const maxPending = Math.max(0, ...Object.values(tiers).map((t) => t.pending));
    // Report the ACTUAL blocking condition, not a fixed template. A session
    // can have plenty to compress (pending >= threshold) but still not
    // inject because growth/floor/cadence isn't met — the old fixed
    // "< threshold" string lied in that case.
    const pendingShort = maxPending < nudgeGrowthTokens;
    const growthShort = growthSinceReference < growthFloor;
    const parts: string[] = [];
    if (pendingShort) parts.push(`max compressible ${maxPending} < threshold ${nudgeGrowthTokens}`);
    if (growthShort) parts.push(`growth ${growthSinceReference} < floor ${growthFloor}`);
    if (parts.length === 0) parts.push(`max compressible ${maxPending}, growth ${growthSinceReference}`);
    reason = `${parts.join("; ")}${readyHint}${blockedHint}`;
  }

  const ctxBreakdown = computeContextBreakdown(input.messages, tokenCount, growthSinceReference, countTokens);

  return {
    shouldInject,
    reason,
    compressibleRanges: rec?.recommendedRanges ?? [],
    protectedRanges: rec?.contextRanges.protected ?? [],
    tierTargetBlocks: injectedTier ? tiers[injectedTier]!.targetBlocks : [],
    contextUsage: usage,
    tier: injectedTier,
    breakdown: {
      usage,
      growth: growthSinceReference,
      growthReference,
      effectiveThreshold,
      nudgeGrowthTokens,
      growthFloor,
      hasPendingNudge: hasPendingNudge ? 1 : 0,
      overLimit: overLimit ? 1 : 0,
      emergencyOverride: emergencyOverride ? 1 : 0,
      pendingT1: tiers[1]!.pending,
      pendingT2: tiers[2]!.pending,
      pendingT3: tiers[3]!.pending,
    },
    contextBreakdown: ctxBreakdown,
  };
}

function computeContextBreakdown(messages: CoreMessage[], total: number, growth: number, countTokens: (t: string) => number): ContextBreakdown {
  const count = countTokens ?? ((t: string) => Math.ceil(t.length / 4));
  let system = 0, tool = 0, summaries = 0, code = 0, text = 0;
  for (const msg of messages) {
    const tokens = count(msg.text ?? "");
    if (msg.text?.startsWith("[Compressed conversation section]")) {
      summaries += tokens;
    } else if (msg.contentType === "tool-call" || msg.contentType === "tool-result") {
      tool += tokens;
    } else if (msg.role === "system") {
      system += tokens;
    } else if (msg.text?.includes("```")) {
      code += tokens;
    } else {
      text += tokens;
    }
  }
  return { system, tool, summaries, code, text, total, growth };
}

function cloneState(state: CompressionState): CompressionState {
  return {
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds],
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef },
    },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId,
  };
}

function scoreRelevance(block: CompressionBlock, terms: string[]): number {
  const topic = (block.topic ?? "").toLowerCase();
  const summary = block.summary.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const topicHits = countOccurrences(topic, term);
    if (topicHits > 0) score += Math.min(topicHits * 0.15, 0.45);
    const summaryHits = countOccurrences(summary, term);
    if (summaryHits > 0) score += Math.min(summaryHits * 0.04, 0.2);
  }
  return Math.min(score, 1);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count++;
    position += needle.length;
  }
  return count;
}

export { createInitialState };
