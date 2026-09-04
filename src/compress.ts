import { assignRefs, highestUsedIndex, indexToRef } from "./refs.js";
import { prune, isSummaryMessageId } from "./prune.js";
import { syncBlocks } from "./sync.js";
import { advanceSurvival, activeBlocks, blockById } from "./state.js";
import { allocateBlockId, allocateRunId, createInitialState } from "./state.js";
import { defaultCountTokens } from "./tokenize.js";
import { validateConfig } from "./config.js";
import {
  BoundaryNotFoundError,
  resolveBoundaries,
  blockVisibleInRange,
  parseBoundary,
} from "./boundaries.js";
import type { ResolvedRange } from "./boundaries.js";
import { truncateLargeToolOutputs } from "./truncate-tools.js";
import { hideConsumedCompressCalls } from "./hide-consumed.js";
import { appendAbsorbPrompts, hideAbsorbedMessages } from "./absorb.js";
import { applyMessageFilters, listMessageFilters } from "./filter/index.js";
import { createRenderRefsNode } from "./render-refs.js";
import type { RenderStrategy } from "./render-refs.js";
import { isMessageProtected } from "./protected.js";
import { adjustBoundariesForToolPairs } from "./tool-pairs.js";
import { adjustBoundariesForReasoningPairs } from "./reasoning-pairs.js";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
  mergeRangesToThreshold,
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

/**
 * Per-range classification from a single resolveBoundaries pass. "ok" ranges
 * go on to applySingleRange (which re-resolves internally for tool-pair
 * adjustment); "consumed" means the refs existed but their messages were
 * hidden by an existing block; "unknown" means a ref never existed in this
 * session; "invalid" means a ref failed to parse (e.g. "foo").
 */
type RangeResolution =
  | { status: "ok"; resolved: ResolvedRange }
  | { status: "consumed"; error: BoundaryNotFoundError }
  | { status: "unknown"; error: BoundaryNotFoundError }
  | { status: "invalid"; error: Error };

function rangeError(
  spec: { startRef: string; endRef: string },
  message: string,
): string {
  return `range ${spec.startRef}..${spec.endRef}: ${message}`;
}

function numericBlockId(id: string): number {
  const parsed = /^b(\d+)$/.exec(id);
  return parsed ? Number(parsed[1]) : 0;
}

function refGateDiagnostics(
  state: CompressionState,
  requestedRanges: number,
  unknownCount: number,
): string {
  const highest = highestUsedIndex(state.messageRefs);
  const highestRef = highest > 0 ? indexToRef(highest) : "none";
  return `[diagnostics: session highest ref=${highestRef}, unknown ranges in request=${unknownCount}/${requestedRanges}, session history=${state.stats.compressionCount} compression(s), ${state.blocks.length} block(s)]`;
}

function danglingMessageRefs(
  state: CompressionState,
  messages: CoreMessage[],
  spec: { startRef: string; endRef: string },
): string[] {
  const visible = new Set(messages.map((m) => m.id));
  const dangling: string[] = [];
  for (const ref of [spec.startRef, spec.endRef]) {
    const parsed = parseBoundary(ref);
    if (!parsed || parsed.kind !== "message") continue;
    const rawId =
      state.messageRefs.byRef[parsed.raw] ??
      state.messageRefs.byRef[indexToRef(parsed.numericId)];
    if (!rawId || visible.has(rawId)) continue;
    const covered = state.blocks.some(
      (block) => block.active && block.effectiveMessageIds.includes(rawId),
    );
    if (!covered) dangling.push(parsed.raw);
  }
  return dangling;
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
      computeProtectedRefs(
        input.messages,
        input.state,
        input.config,
        countTokens,
      );

    const preExistingCoverage = collectCoverage(state);

    // Classify every requested range ONCE. The result feeds overlap
    // skipSpecs, the minCompressRange pre-check, and the per-range loop —
    // previously each re-resolved and silently swallowed failures, so
    // consumed/unknown ranges produced misleading "too small" errors.
    const classifications = new Map<
      (typeof input.ranges)[number],
      RangeResolution
    >();
    const classificationErrors: string[] = [];
    const consumedRanges: typeof input.ranges = [];
    for (const spec of input.ranges) {
      try {
        const resolved = resolveBoundaries({
          startRef: spec.startRef,
          endRef: spec.endRef,
          messages: input.messages,
          state,
        });
        classifications.set(spec, { status: "ok", resolved });
      } catch (error) {
        if (error instanceof BoundaryNotFoundError) {
          classifications.set(
            spec,
            error.kind === "unknown"
              ? { status: "unknown", error }
              : { status: "consumed", error },
          );
          if (error.kind === "consumed") {
            consumedRanges.push(spec);
          } else {
            classificationErrors.push(rangeError(spec, error.message));
          }
        } else {
          classifications.set(spec, {
            status: "invalid",
            error: error instanceof Error ? error : new Error(String(error)),
          });
          classificationErrors.push(
            rangeError(
              spec,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
    }

    let resolvableCount = 0;
    let unknownCount = 0;
    for (const resolution of classifications.values()) {
      if (resolution.status === "ok") resolvableCount++;
      else if (resolution.status === "unknown") unknownCount++;
    }

    // Overlap detection uses resolved boundary indices, not messageIds: a
    // summary-only range (block refs over a pruned view) has empty
    // messageIds after synthetic-id filtering but still occupies its
    // [startIndex, endIndex] span.
    const rangeSpans: {
      spec: (typeof input.ranges)[number];
      start: number;
      end: number;
    }[] = [];
    for (const [spec, resolution] of classifications) {
      if (resolution.status !== "ok") continue;
      rangeSpans.push({
        spec,
        start: resolution.resolved.startIndex,
        end: resolution.resolved.endIndex,
      });
    }
    const sortedRanges = [...rangeSpans].sort((a, b) => a.start - b.start);
    // Overlapping ranges warn+skip (earliest wins) rather than aborting the
    // whole batch — see ISSUE-42 / dog/billion-context-pi#21.
    const skipSpecs = new Set<(typeof input.ranges)[number]>();
    let acceptedMaxIndex = -1;
    for (const entry of sortedRanges) {
      if (entry.start <= acceptedMaxIndex) {
        skipSpecs.add(entry.spec);
        warnings.push(
          `Skipped range (${entry.spec.startRef}..${entry.spec.endRef}) — overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`,
        );
        continue;
      }
      if (entry.end > acceptedMaxIndex) acceptedMaxIndex = entry.end;
    }

    if (input.config.compress.minCompressRange > 0 && input.ranges.length > 0) {
      let totalRangeChars = 0;
      let hasBlockBoundaryRange = false;
      let countedRanges = 0;
      for (const [spec, resolution] of classifications) {
        if (resolution.status !== "ok" || skipSpecs.has(spec)) continue;
        if (resolution.resolved.boundaryKind === "block") {
          hasBlockBoundaryRange = true;
          continue;
        }
        countedRanges++;
        for (const id of resolution.resolved.messageIds) {
          const msg = input.messages.find((m) => m.id === id);
          totalRangeChars += msg?.text?.length ?? 0;
        }
      }
      if (
        !hasBlockBoundaryRange &&
        totalRangeChars < input.config.compress.minCompressRange
      ) {
        const live = activeBlocks(state)
          .map((b) => b.blockId)
          .sort((x, y) => numericBlockId(x) - numericBlockId(y));
        const liveHint =
          live.length > 0
            ? ` Current active blocks span ${live[0]}..${live[live.length - 1]} — retry with startId/endId set to active block IDs in that span.`
            : "";
        const diagnostics = refGateDiagnostics(
          state,
          input.ranges.length,
          unknownCount,
        );
        const danglingRefs = consumedRanges.flatMap((spec) =>
          danglingMessageRefs(state, input.messages, spec),
        );
        const gateMessage =
          resolvableCount === 0 &&
          consumedRanges.length === 0 &&
          unknownCount > 0
            ? `None of the ${input.ranges.length} requested range(s) resolved — every ref is unknown to this session. Refs are per-session snapshots, assigned once when a message is first rendered; no compress reassigns them, so unknown refs cannot come from an earlier compress in this session. They come from a different generation: a previous session instance (switching model or upstream mid-conversation starts a fresh session whose refs restart at m00001), the generation before a native-compaction rebase (which also resets refs to m00001), or a typo. ${diagnostics} Run acp_status, then call the compress tool again using only the refs it reports.`
            : consumedRanges.length > 0
              ? danglingRefs.length > 0
                ? `Requested range(s) cannot be anchored (e.g. ${consumedRanges[0]!.startRef}..${consumedRanges[0]!.endRef}) — the refs exist in this session's ref map, but the messages they point to are no longer in the visible context and no active block covers them: the message content changed (or the message was filtered out of the view) and now carries a new ref, leaving your old refs dangling. ${diagnostics} Run acp_status, then call the compress tool again using only the refs it reports.`
                : `Requested range(s) already compressed (e.g. ${consumedRanges[0]!.startRef}..${consumedRanges[0]!.endRef}) — those refs no longer point to directly compressible content: the range is covered by active block(s) or the block ref(s) are stale (distilled or consumed). ${diagnostics} Run acp_status, then call the compress tool again using only the CURRENT compressible ranges it reports.${liveHint}`
              : `Total compressible content too small (${totalRangeChars} chars across ${countedRanges} range(s), min ${input.config.compress.minCompressRange}). Combine more messages into your range(s) to meet the threshold.`;
        return {
          state: input.state,
          result: {
            blocksCreated: 0,
            tokensCompressed: 0,
            errors: [gateMessage, ...classificationErrors],
            warnings: [],
          },
        };
      }
    }

    for (const spec of input.ranges) {
      if (skipSpecs.has(spec)) continue;
      const resolution = classifications.get(spec);
      if (resolution === undefined) continue;
      if (resolution.status === "consumed") {
        warnings.push(
          `Skipped range (${spec.startRef}..${spec.endRef}) — already compressed (messages consumed by existing block(s)); nothing to compress.`,
        );
        continue;
      }
      if (resolution.status === "unknown" || resolution.status === "invalid") {
        errors.push(rangeError(spec, resolution.error.message));
        continue;
      }
      warnings.push(...resolution.resolved.snappedBoundaries);
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
        errors.push(
          rangeError(
            spec,
            error instanceof Error ? error.message : String(error),
          ),
        );
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

    return {
      state,
      result: { blocksCreated, tokensCompressed, errors, warnings },
    };
  }

  function processTurn(input: ProcessTurnInput): ProcessTurnResult {
    const configErrors = validateConfig(input.config);
    if (configErrors.length > 0) {
      console.warn(
        `[acp-kernel] Config validation warnings: ${configErrors.join("; ")}. Thresholds may not fire correctly.`,
      );
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
      absorbHideNode,
      absorbPromptNode,
      filterNode,
      hideCompressCallsNode,
      recommendNode,
      nudgeNode,
      emergencyTruncateNode,
    ];
    if (strategy === "none") return base;
    return [...base, createRenderRefsNode(strategy)];
  }

  return {
    processTurn,
    applyCompression,
    defaultNodes,
    decompress,
    search,
    status,
  };
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

const absorbHideNode: PipelineNode = {
  name: "absorb-hide",
  enabled: (io) => (io.state.absorbed?.length ?? 0) > 0,
  run(io) {
    return { ...io, messages: hideAbsorbedMessages(io.messages, io.state) };
  },
};

const absorbPromptNode: PipelineNode = {
  name: "absorb-prompt",
  enabled: (_io, ctx) => ctx.config.absorb?.enabled === true,
  run(io, ctx) {
    const applied = appendAbsorbPrompts(
      io.messages,
      io.state,
      ctx.config,
      ctx.tokenCount,
      ctx.countTokens,
    );
    return {
      ...io,
      messages: applied.messages,
      effects: { ...io.effects, absorbPromptedCount: applied.promptedCount },
    };
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
      recommendedRanges: mergeRangesToThreshold(
        contextRanges.compressible,
        ctx.config.compress.minCompressRange,
      ),
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

    if (baseline > 0 && ctx.tokenCount < baseline - nudgeGrowthTokens) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
      stamped.lastNudgeShownTokens = 0;
      // The context shrank dramatically — host compaction, or a tokenCount
      // scale switch (an adapter moving from session-tree accounting to
      // sent-view estimation). Per-tier cadence stamps recorded at the old
      // scale would otherwise make `tokenCount - lastShownByTier[t] >=
      // growthFloor` unreachable (a stamp above the window never re-arms),
      // suppressing mid-band nudges until the absolute overLimit band fires.
      // Restart tier cadence from the new baseline, mirroring the full stamp
      // reset a successful applyCompression performs.
      stamped.lastShownByTier = {};
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
        stamped.lastShownByTier = {
          ...stamped.lastShownByTier,
          [nudge.tier]: ctx.tokenCount,
        };
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
  spec: {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
    summaryMaxChars?: number;
  };
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

  const rangeMessageIds = applyPairBoundaryAdjustments(
    resolved,
    input.messages,
  ).filter((id) => !isSummaryMessageId(id));

  // Re-scan for nested blocks in the ADJUSTED range (tool-pair extension may
  // have pulled in messages that are anchors of existing blocks).
  if (rangeMessageIds.length > resolved.messageIds.length) {
    const indexByMessageId = new Map<string, number>();
    input.messages.forEach((m, i) => indexByMessageId.set(m.id, i));
    const adjustedStart =
      rangeMessageIds.length > 0
        ? (indexByMessageId.get(rangeMessageIds[0]!) ?? resolved.startIndex)
        : resolved.startIndex;
    const adjustedEnd =
      rangeMessageIds.length > 0
        ? (indexByMessageId.get(rangeMessageIds[rangeMessageIds.length - 1]!) ??
          resolved.endIndex)
        : resolved.endIndex;
    const nestedSeen = new Set(resolved.nestedBlockIds);
    for (const block of activeBlocks(input.state)) {
      if (nestedSeen.has(block.blockId)) continue;
      if (
        blockVisibleInRange(block, indexByMessageId, adjustedStart, adjustedEnd)
      ) {
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

  // Livelock guard (billion-context-pi#199): a message-ref range whose entire
  // content is already owned by active block(s) — its raw ids are all covered
  // or dropped as protected tool pairs — resolves with zero NEW direct
  // messages. Creating a block here would be an empty same-tier rewrite
  // (directMessageIds: []) that still reports blocksCreated>0: fake success.
  // The caller's view does not change, so a model driven by that report
  // repeats the identical call forever. Promote/merge must go through
  // explicit block-boundary refs (bN..bM) instead.
  if (
    !isBlockBoundary &&
    filteredIds.length === 0 &&
    consumedBlockIds.length > 0
  ) {
    const first = consumedBlockIds[0]!;
    const last = consumedBlockIds[consumedBlockIds.length - 1]!;
    throw new Error(
      `Range ${input.spec.startRef}..${input.spec.endRef} contains no new compressible messages — every message in it is already covered by active block(s) ${consumedBlockIds.join(
        ", ",
      )}. Nothing was compressed. To rewrite or merge those blocks, reference them by block ID (${first}..${last}); otherwise run acp_status and compress a range it reports as compressible.`,
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

function applyPairBoundaryAdjustments(
  resolved: {
    startIndex: number;
    endIndex: number;
    messageIds: string[];
    boundaryKind: string;
  },
  messages: CoreMessage[],
): string[] {
  if (resolved.boundaryKind === "block") {
    return resolved.messageIds;
  }
  // Compose tool-pair and reasoning-pair boundary adjustments to a fixpoint
  // (≤2 passes). Reasoning may pull in a tool-call whose result tool-pairs
  // then extends for; tool-pairs may pull in a tool-call whose preceding
  // reasoning is then drawn in. Both only ever WIDEN the range.
  let startIndex = resolved.startIndex;
  let endIndex = resolved.endIndex;
  for (let pass = 0; pass < 2; pass++) {
    const reasoningAdjusted = adjustBoundariesForReasoningPairs(
      startIndex,
      endIndex,
      messages,
    );
    const toolAdjusted = adjustBoundariesForToolPairs(
      reasoningAdjusted.startIndex,
      reasoningAdjusted.endIndex,
      messages,
    );
    const changed =
      toolAdjusted.startIndex !== startIndex ||
      toolAdjusted.endIndex !== endIndex;
    startIndex = toolAdjusted.startIndex;
    endIndex = toolAdjusted.endIndex;
    if (!changed) break;
  }
  if (startIndex === resolved.startIndex && endIndex === resolved.endIndex) {
    return resolved.messageIds;
  }
  const ids: string[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
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
  if (effectiveMax > 0 && summary.length > effectiveMax) {
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

/** Compressible amount for each tier. T1 = EFFECTIVE merged-range tokens —
 *  only ranges whose real char count >= minCompressRange count (avoids
 *  inflation from fragmentation; matches the apply-side gate, which counts
 *  raw `msg.text.length`, so a nudge never offers a range the kernel would
 *  atomically reject — see CompressibleRange.chars); T2 = total summary
 *  tokens of all active tier-1 blocks; T3 = total summary tokens of all
 *  active tier-2 blocks. */
function pendingByTier(
  state: CompressionState,
  recommendation: Recommendation | undefined,
  countTokens: (t: string) => number,
  minCompressRange: number,
): Record<number, { pending: number; targetBlocks: CompressionBlock[] }> {
  const out: Record<
    number,
    { pending: number; targetBlocks: CompressionBlock[] }
  > = {};
  const merged = recommendation?.recommendedRanges ?? [];
  const effective =
    minCompressRange > 0
      ? merged.filter((r) => (r.chars ?? r.tokens * 4) >= minCompressRange)
      : merged;
  out[1] = {
    pending: effective.reduce((s, r) => s + r.tokens, 0),
    targetBlocks: [],
  };
  const active = activeBlocks(state);
  const t1 = active.filter((b) => b.tier === 1);
  const t2 = active.filter((b) => b.tier === 2);
  out[2] = {
    pending: t1.reduce((s, b) => s + countTokens(b.summary), 0),
    targetBlocks: t1,
  };
  out[3] = {
    pending: t2.reduce((s, b) => s + countTokens(b.summary), 0),
    targetBlocks: t2,
  };
  return out;
}

function decideNudge(input: NudgeInput): NudgeDecision {
  const { config, state, tokenCount, recommendation, countTokens } = input;
  const limit = config.modelContextLimit;
  const usage = limit > 0 ? tokenCount / limit : 0;

  const nudgeGrowthTokens = resolveAdaptiveGrowth(limit, config.nudge);

  const overLimit = usage >= config.nudge.maxContextLimitPct;
  const emergencyOverride = usage >= config.nudge.emergencyThresholdPct;
  // High-pressure band: over maxContextLimitPct (subsumes the emergency
  // threshold). Bypasses growth gate + cadence; gated on effective pending.
  const pressure = overLimit || emergencyOverride;

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
  const tiers = pendingByTier(
    state,
    rec,
    countTokens,
    config.compress.minCompressRange,
  );

  // Tier arbitration. Emergency (usage >= emergencyThresholdPct) ignores tier
  // priority and picks the tier with the MAX pending. Non-emergency defaults to
  // T1; T2/T3 override via either path: (a) COUNT — the number of active
  // lower-tier blocks reached tiers.tier2Trigger/tier3Trigger (the documented
  // block-count trigger; summaries are ~10:1 condensed so a token comparison
  // against raw pending starves), or (b) TOKEN MASS — crossed the shared 1.5x
  // threshold AND exceeds the effective pending of every lower tier (T2 > T1
  // effective; T3 > T2 and > T1 effective).
  const tier2Threshold = Math.round(
    nudgeGrowthTokens * (config.nudge.tier2GrowthMultiplier ?? 1.5),
  );
  let injectedTier: CompressionTier | null = null;
  let injectedReason = "";
  const t1Eff = tiers[1]?.pending ?? 0;
  const t2Pen = tiers[2]?.pending ?? 0;
  const t3Pen = tiers[3]?.pending ?? 0;
  // First-sight mass bypass (#194): growthReference seeds to tokenCount when
  // no baseline exists, so a session that ARRIVES with a huge ready mass
  // (stateless full-history ingest / restored state) shows growthSinceReference
  // ≈ 0 and waits for a full floor of NEW tokens before its first compress —
  // #351 sat 934K-ready for 18 idle minutes and died ~4 min short of the floor.
  // The floor paces WITHIN a backlog; it must not gate draining one. The bypass
  // re-arms after every SUCCESSFUL compression (which clears the baseline):
  // still-in-band with ready mass over threshold keeps nudging the backlog
  // down, one compress per re-fire — no growth debt between compressions.
  // Guardrails: while the model IGNORES a nudge the shown stamp stays set, so
  // this never re-fires on an unresponsive session; a fresh session below the
  // usage band still waits, as before; and the tier branches below apply
  // unchanged.
  const firstSightMassReady =
    state.nudge.lastNudgeShownTokens === 0 &&
    baseline === 0 &&
    usage >= config.nudge.minContextLimitPct &&
    Math.max(t1Eff, t2Pen, t3Pen) >= nudgeGrowthTokens;
  const growthReady =
    firstSightMassReady || growthSinceReference >= growthFloor;
  const t2Count = tiers[2]?.targetBlocks.length ?? 0;
  const t3Count = tiers[3]?.targetBlocks.length ?? 0;

  if (pressure) {
    // High pressure: pick the tier with the MAX pending so pressure can route
    // to distillation when that reclaims the most tokens. Gated on effective
    // pending (real chars >= minCompressRange for T1) so we never offer ranges
    // the kernel would atomically reject. emergency vs over-limit only
    // changes the reason label/voice; truncate.threshold remains the
    // independent last resort when there is genuinely nothing to compress.
    const candidates: CompressionTier[] = [1];
    if (config.tiers.enabled) {
      candidates.push(2, 3);
    }
    let best: CompressionTier | null = null;
    let bestPending = 0;
    for (const t of candidates) {
      const p = tiers[t]?.pending ?? 0;
      if (p > bestPending) {
        bestPending = p;
        best = t;
      }
    }
    if (best !== null && bestPending > 0) {
      injectedTier = best;
      const label = emergencyOverride ? "EMERGENCY" : "OVER-LIMIT";
      injectedReason =
        best === 1
          ? `${label} T1: max effective pending ${bestPending}, usage ${Math.round(usage * 100)}%`
          : `${label} T${best} distill: max pending ${bestPending} (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}), usage ${Math.round(usage * 100)}%`;
    }
  } else if (growthReady) {
    if (t1Eff >= nudgeGrowthTokens) {
      injectedTier = 1;
      injectedReason = `T1 effective ${t1Eff} >= ${nudgeGrowthTokens}, growth ${growthSinceReference}, usage ${Math.round(usage * 100)}%`;
    } else if (
      config.tiers.enabled &&
      (t2Count >= config.tiers.tier2Trigger ||
        (t2Pen >= tier2Threshold && t2Pen > t1Eff))
    ) {
      const lastShown = state.nudge.lastShownByTier[2] ?? 0;
      const cadenceMet =
        lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (cadenceMet) {
        injectedTier = 2;
        injectedReason =
          t2Count >= config.tiers.tier2Trigger
            ? `T2 distill ready: ${t2Count} tier-1 blocks >= tier2Trigger ${config.tiers.tier2Trigger} (${t2Pen} tokens), usage ${Math.round(usage * 100)}%`
            : `T2 distill ready: ${tiers[2]!.targetBlocks.length} tier-1 blocks (${t2Pen} tokens) >= ${tier2Threshold} (1.5x) and > T1 effective ${t1Eff}, usage ${Math.round(usage * 100)}%`;
      }
    } else if (
      config.tiers.enabled &&
      (t3Count >= config.tiers.tier3Trigger ||
        (t3Pen >= tier2Threshold && t3Pen > t2Pen && t3Pen > t1Eff))
    ) {
      const lastShown = state.nudge.lastShownByTier[3] ?? 0;
      const cadenceMet =
        lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (cadenceMet) {
        injectedTier = 3;
        injectedReason =
          t3Count >= config.tiers.tier3Trigger
            ? `T3 condense ready: ${t3Count} tier-2 blocks >= tier3Trigger ${config.tiers.tier3Trigger} (${t3Pen} tokens), usage ${Math.round(usage * 100)}%`
            : `T3 condense ready: ${tiers[3]!.targetBlocks.length} tier-2 blocks (${t3Pen} tokens) >= ${tier2Threshold} (1.5x) and > T2 ${t2Pen} and > T1 effective ${t1Eff}, usage ${Math.round(usage * 100)}%`;
      }
    }
  }

  const shouldInject = injectedTier !== null;
  if (shouldInject && firstSightMassReady) {
    injectedReason += " [first-sight mass]";
  }

  let reason: string;
  if (injectedTier !== null) {
    reason = injectedReason;
  } else if (pressure) {
    const label = emergencyOverride ? "EMERGENCY" : "OVER-LIMIT";
    reason = `${label}: usage ${Math.round(usage * 100)}% but no tier has effective compressible content (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}) — nudge suppressed to avoid offering ranges below minCompressRange`;
   } else {
    const tiersList = [1, 2, 3] as const;
    const eligible = tiersList.filter((t) => config.tiers.enabled || t === 1);
    const countReady = (t: 1 | 2 | 3) =>
      t === 2
        ? t2Count >= config.tiers.tier2Trigger
        : t === 3
          ? t3Count >= config.tiers.tier3Trigger
          : false;
    const ready = eligible
      .filter((t) => (tiers[t]?.pending ?? 0) >= nudgeGrowthTokens)
      .map((t) => `T${t} ${tiers[t]!.pending}`);
    const readyCount = eligible
      .filter((t) => (tiers[t]?.pending ?? 0) < nudgeGrowthTokens && countReady(t))
      .map((t) => `T${t} ${t === 2 ? t2Count : t3Count} blocks (count)`);
    const readyAll = [...ready, ...readyCount];
    const readyHint = readyAll.length > 0 ? `, ready: ${readyAll.join(", ")}` : "";
    const blocked = eligible
      .filter(
        (t) =>
          ((tiers[t]?.pending ?? 0) >= nudgeGrowthTokens || countReady(t)) &&
          (state.nudge.lastShownByTier[t] ?? 0) > 0 &&
          tokenCount - (state.nudge.lastShownByTier[t] ?? 0) < growthFloor,
      )
      .map((t) => `T${t} (cadence)`);
    const blockedHint =
      blocked.length > 0 ? `, blocked: ${blocked.join(", ")}` : "";
    const maxPending = Math.max(
      0,
      ...Object.values(tiers).map((t) => t.pending),
    );
    // Report the ACTUAL blocking condition, not a fixed template. A session
    // can have plenty to compress (pending >= threshold) but still not
    // inject because growth/floor/cadence isn't met — the old fixed
    // "< threshold" string lied in that case.
    const pendingShort = maxPending < nudgeGrowthTokens;
    const growthShort = growthSinceReference < growthFloor;
    const parts: string[] = [];
    if (pendingShort)
      parts.push(
        `max compressible ${maxPending} < threshold ${nudgeGrowthTokens}`,
      );
    if (growthShort)
      parts.push(`growth ${growthSinceReference} < floor ${growthFloor}`);
    if (parts.length === 0)
      parts.push(
        `max compressible ${maxPending}, growth ${growthSinceReference}`,
      );
    reason = `${parts.join("; ")}${readyHint}${blockedHint}`;
  }

  const ctxBreakdown = computeContextBreakdown(
    input.messages,
    tokenCount,
    growthSinceReference,
    countTokens,
  );

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

function computeContextBreakdown(
  messages: CoreMessage[],
  total: number,
  growth: number,
  countTokens: (t: string) => number,
): ContextBreakdown {
  const count = countTokens ?? ((t: string) => Math.ceil(t.length / 4));
  let system = 0,
    tool = 0,
    summaries = 0,
    code = 0,
    text = 0;
  for (const msg of messages) {
    const tokens = count(msg.text ?? "");
    if (msg.text?.startsWith("[Compressed conversation section]")) {
      summaries += tokens;
    } else if (
      msg.contentType === "tool-call" ||
      msg.contentType === "tool-result"
    ) {
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
    tokenSnapshot: { ...(state.tokenSnapshot ?? {}) },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    absorbed: (state.absorbed ?? []).map((record) => ({ ...record })),
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
