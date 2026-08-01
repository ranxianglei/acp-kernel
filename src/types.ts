export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageContentType =
  "text" | "tool-call" | "tool-result" | "reasoning";

export interface CoreMessage {
  id: string;
  role: MessageRole;
  contentType: MessageContentType;
  text?: string;
  toolName?: string;
  toolCallId?: string;
}

export type CompressionTier = 1 | 2 | 3;

export type BlockGeneration = "young" | "old";

export interface CompressionBlock {
  blockId: string;
  runId: string;
  tier: CompressionTier;
  topic?: string;
  summary: string;
  directMessageIds: string[];
  effectiveMessageIds: string[];
  directBlockIds: string[];
  /** Token count of the original messages compressed by this block (for accurate reporting). */
  compressedTokens: number;
  createdAt: number;
  survivedCount: number;
  generation: BlockGeneration;
  active: boolean;
  durationMs?: number;
  compressCallId?: string;
}

export interface MessageRefMap {
  byRaw: Record<string, string>;
  byRef: Record<string, string>;
}

export interface NudgeState {
  lastPerMessageNudgeTokens: number;
  lastNudgeShownTokens: number;
  baselineTokens: number;
  anchors: Record<string, unknown>;
}

export interface CompressionStats {
  tokensCompressed: number;
  compressionCount: number;
}

export interface CompressionState {
  blocks: CompressionBlock[];
  messageRefs: MessageRefMap;
  nudge: NudgeState;
  stats: CompressionStats;
  nextBlockId: number;
  nextRunId: number;
}

export interface TierConfig {
  enabled: boolean;
  tier2Trigger: number;
  tier3Trigger: number;
}

export interface NudgeConfig {
  maxContextLimitPct: number;
  minContextLimitPct: number;
  frequency: number;
  iterationThreshold: number;
  force: "soft" | "strong";
  growthRatio: number;
  /** Adaptive growth threshold = modelContextLimit × this ratio, clamped to [growthFloor, growthCap]. Default 0.05 (5%). */
  growthFloor: number;
  /** Upper clamp for adaptive growth threshold. Default 50000. */
  growthCap: number;
  /** Anti-thrashing: suppress nudge unless growth ≥ max(minGrowthFloor, minGrowthRatio × growthTokens). Default 5000. */
  minGrowthFloor: number;
  /** Ratio for growth floor: max(minGrowthFloor, minGrowthRatio × growthTokens). Default 0.45. */
  minGrowthRatio: number;
  /** Emergency override: always nudge when usage ≥ this fraction. Default 0.98 (98%). */
  emergencyThresholdPct: number;
}

export interface TruncateConfig {
  // Context-usage fraction that triggers the emergency tool-output truncation
  // node (the LAST safety valve of the pipeline). 1.0 = 100% of the model
  // context limit. Removed GC age-deactivation/summary-truncation are gone;
  // this is the only "context near full" fallback that remains.
  threshold: number;
}

export interface CompressValidationConfig {
  /** Minimum total chars of original messages in a range to allow compression. 0 = disabled. Default 5000. */
  minCompressRange: number;
  /** Maximum summary length (chars). Summary exceeding this is rejected unless summaryMaxChars override is used. 0 = disabled. Default 20000. */
  maxSummaryLength: number;
  /** Minimum summary length (chars). Summary shorter than this is rejected. 0 = disabled. Default 50. */
  minSummaryLength: number;
}

export interface Config {
  tiers: TierConfig;
  nudge: NudgeConfig;
  // young→old promotion after N survivals (drives merge-blocks). Age-based
  // deactivation is GONE — blocks are never dropped for being old.
  promotionThreshold: number;
  truncate: TruncateConfig;
  compress: CompressValidationConfig;
  protectedTools: string[];
  isToolProtected?: (toolName: string, toolInputText?: string) => boolean;
  preserveRecentMessages: number;
  preserveRecentTokens: number;
  modelContextLimit: number;
  messageFilters?: import("./filter/types.js").MessageFiltersConfig;
}

export type CompressMode = "range" | "message";

export interface CompressRangeSpec {
  startRef: string;
  endRef: string;
  summary: string;
  topic?: string;
  compressCallId?: string;
  /** Per-call override for max summary length. Model can set this when content needs more detail. */
  summaryMaxChars?: number;
}

export interface CompressCall {
  mode: CompressMode;
  ranges: CompressRangeSpec[];
}

export interface CompressibleRange {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  toolPct: number;
  textPct: number;
  dangerous?: boolean;
}

export interface ProtectedRange {
  startRef: string;
  endRef: string;
  count: number;
  tokens: number;
  tools: string[];
}

export interface ContextRanges {
  compressible: CompressibleRange[];
  protected: ProtectedRange[];
}

export interface Recommendation {
  contextRanges: ContextRanges;
  recommendedRanges: CompressibleRange[];
  nothingToCompress: boolean;
}

export interface ContextBreakdown {
  system: number;
  tool: number;
  summaries: number;
  code: number;
  text: number;
  total: number;
  growth: number;
}

export interface NudgeDecision {
  shouldInject: boolean;
  reason: string;
  compressibleRanges: CompressibleRange[];
  protectedRanges?: ProtectedRange[];
  contextUsage: number;
  tier: CompressionTier | null;
  breakdown: Record<string, number>;
  contextBreakdown?: ContextBreakdown;
}

export interface ResolvedBoundary {
  startIndex: number;
  endIndex: number;
  protectedGaps: number[];
}

export interface ApplyCompressionResult {
  state: CompressionState;
  result: {
    blocksCreated: number;
    tokensCompressed: number;
    errors: string[];
  };
}

export interface ProcessTurnResult {
  messages: CoreMessage[];
  state: CompressionState;
  nudge?: NudgeDecision;
}

export interface StatusReport {
  contextUsage: number;
  tokenCount: number;
  modelContextLimit: number;
  activeBlocks: number;
  totalBlocks: number;
  tokensCompressed: number;
  breakdown: Record<string, number>;
}
