export * from "./types.js";
export { createCore } from "./compress.js";
export type {
  Ports,
  CompressionCore,
  ProcessTurnInput,
  ApplyCompressionInput,
} from "./compress.js";
export {
  createInitialState,
  allocateBlockId,
  allocateRunId,
  blockById,
  activeBlocks,
  coveredMessageIds,
  highestActiveTier,
  advanceSurvival,
} from "./state.js";
export { defaultConfig, validateConfig } from "./config.js";
export * from "./compress-tools.js";
export {
  assignRefs,
  highestUsedIndex,
  emptyRefMap,
  indexToRef,
  refToIndex,
  refForRaw,
  rawForRef,
  pruneDeadRefs,
  BLOCKED_REF,
} from "./refs.js";
export {
  prune,
  SUMMARY_HEADER,
  summaryMessageId,
  isSummaryMessageId,
  isRenderedSummaryMessage,
} from "./prune.js";
export { syncBlocks } from "./sync.js";
export {
  resolveBoundaries,
  parseBoundary,
  BoundaryNotFoundError,
  visibleBlockAnchor,
  blockVisibleInRange,
} from "./boundaries.js";
export type { BoundaryFailureReason } from "./boundaries.js";
export {
  defaultCountTokens,
  estimateTokensFast,
  createBpeTokenizer,
} from "./tokenize.js";
export type { TokenCountFn } from "./tokenize.js";
export { renderNudgeText, formatRanges } from "./nudge-text.js";
export type { NudgeVoice, RenderedNudge } from "./nudge-text.js";
export {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
} from "./compression-rules.js";
export { defaultPrompts, resolvePrompts } from "./prompts.js";
export type { Prompts, ResolvePromptsOptions } from "./prompts.js";
export {
  applySectionOverrides,
  cloneWithDescriptions,
  applyAcpToolOverrides,
} from "./surface-config.js";
export type {
  SectionOverride,
  CompressPromptSections,
  ToolPromptOverrides,
  ToolPrompts,
  AcpToolLike,
} from "./surface-config.js";
export { truncateLargeToolOutputs } from "./truncate-tools.js";
export type { TruncateOptions, TruncateResult } from "./truncate-tools.js";
export {
  parseBlockIdArg,
  findBlocksOverlappingMessages,
  findActiveAncestor,
  deactivateBlock,
  buildRestoredContentPreview,
  collectBlockContent,
} from "./decompress.js";
export type {
  DeactivateOptions,
  CollectedContentResult,
  CollectContentOptions,
} from "./decompress.js";
export { buildStatusReport, buildRecap } from "./report.js";
export type { StatusReportOptions } from "./report.js";
export { renderHandoff, renderMessage, matchSession } from "./handoff.js";
export type { HandoffInput, HandoffMeta } from "./handoff.js";
export { hideConsumedCompressCalls } from "./hide-consumed.js";
export type { HideConsumedResult } from "./hide-consumed.js";
export {
  ABSORB_TOOL_NAME,
  ABSORB_TOOL,
  ABSORB_TOOL_OPENAI,
} from "./compress-tools.js";
export {
  ABSORB_PROMPT_MARKER,
  DEFAULT_ABSORB_CONFIG,
  resolveAbsorbConfig,
  buildAbsorbPrompt,
  buildAbsorbSystemPrompt,
  isAbsorbCandidate,
  hideAbsorbedMessages,
  appendAbsorbPrompts,
  parseAbsorbInput,
  applyAbsorb,
} from "./absorb.js";
export type {
  AbsorbInput,
  AbsorbOutcome,
  ParsedAbsorb,
  AppendAbsorbPromptsResult,
} from "./absorb.js";
export { rebuildCompressionState } from "./rebuild.js";
export type { RebuildResult, RebuildPorts } from "./rebuild.js";
export { parseCompressArgs } from "./parse-compress-input.js";
export type { CompressParseDiagnostics, CompressParseKind, ParsedCompressInput } from "./parse-compress-input.js";
export {
  renderVisibleRefs,
  renderRefsNode,
  createRenderRefsNode,
} from "./render-refs.js";
export type { RenderStrategy } from "./render-refs.js";
export { resolveTransformChannel } from "./transform-channel.js";
export type { TransformChannel } from "./transform-channel.js";
export {
  searchBlocks,
  searchBlocksAsync,
  blockDocs,
  messageDocs,
} from "./search.js";
export {
  clearDocFeatures,
  docCacheInfo,
  docFeatures,
  setDocCacheCap,
} from "./search.js";
export type {
  SearchResult,
  SearchOptions,
  SearchAlgorithm,
  AsyncSearchAlgorithm,
  AnySearchAlgorithm,
  SearchDoc,
  SearchDocKind,
  ScoredBlock,
  MessageRole,
  RoleWeights,
  MessageInput,
} from "./search.js";
export {
  DEFAULT_ALGORITHM,
  DEFAULT_ROLE_WEIGHTS,
  registerSearchAlgorithm,
  getSearchAlgorithm,
  listSearchAlgorithms,
} from "./search.js";
export { isMessageProtected, matchToolPattern } from "./protected.js";
export {
  runPipeline,
  makeIO,
  type PipelineNode,
  type PipelineContext,
  type NodeIO,
  type NodeEffects,
} from "./pipeline.js";
export * from "./filter/index.js";

export { VIABLE_RANGE_MIN_TOKENS, viableRanges } from "./viable.js";
