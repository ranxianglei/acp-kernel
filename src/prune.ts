import { activeBlocks, coveredMessageIds } from "./state.js";
import type { CompressionState, CoreMessage } from "./types.js";

export const SUMMARY_HEADER = "[Compressed conversation section]";

// Reserved prefix for rendered-summary ids. Hosts own their message ids and
// must never assign one with this prefix; kernel-generated ids are mNNNNN
// refs and bN block ids.
const SUMMARY_ID_PREFIX = "acp_summary_";

/**
 * The transient visible id of an active block's rendered summary message.
 * This is a VIEW-ONLY representation: it must never be persisted into
 * `effectiveMessageIds`/`directMessageIds` (the durable coverage is the
 * block's raw message ids).
 */
export function summaryMessageId(blockId: string): string {
  return `${SUMMARY_ID_PREFIX}${blockId}`;
}

export function isSummaryMessageId(id: string): boolean {
  return id.startsWith(SUMMARY_ID_PREFIX);
}

/**
 * True when a message is a rendered block summary (the exact shape prune
 * emits). The id prefix alone is not sufficient — a host-authored message
 * that happens to carry a reserved id must not be treated as a rendered
 * summary (it would be silently dropped from ranges or deleted by rebuild).
 */
export function isRenderedSummaryMessage(
  message: Pick<CoreMessage, "id" | "role" | "contentType">,
): boolean {
  return (
    isSummaryMessageId(message.id) &&
    message.role === "system" &&
    message.contentType === "text"
  );
}

export interface PruneOptions {
  injectSummaries?: boolean;
}

export function prune(
  messages: CoreMessage[],
  state: CompressionState,
  options: PruneOptions = {},
): CoreMessage[] {
  const covered = coveredMessageIds(state);
  if (covered.size === 0) return [...messages];

  const inject = options.injectSummaries ?? true;
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user",
  );
  // Rendered summaries are `role: "system"`. Strict OpenAI backends reject a
  // system message that follows any non-system message, so every summary
  // anchor is clamped to the first non-system message — summaries always land
  // in the leading system prefix (index 0 when the view has none). Clamping to
  // the first non-system (not first user) message also covers hosts that lead
  // with a non-user, non-system message.
  const firstNonSystemIndex = messages.findIndex(
    (message) => message.role !== "system",
  );
  const summaryClampIndex = firstNonSystemIndex >= 0 ? firstNonSystemIndex : 0;

  const indexById = new Map<string, number>();
  const summaryIndexById = new Map<string, number>();
  messages.forEach((message, index) => {
    indexById.set(message.id, index);
    if (isRenderedSummaryMessage(message))
      summaryIndexById.set(message.id, index);
  });

  const anchors = inject
    ? collectSummaryAnchors(
        state,
        indexById,
        summaryIndexById,
        summaryClampIndex,
      )
    : [];

  return stripOrphanedReasoning(
    stripOrphanedToolResults(
      stripOrphanedToolCalls(
        rebuildMessages(messages, covered, firstUserIndex, anchors),
      ),
    ),
  );
}

interface SummaryAnchor {
  blockId: string;
  summary: string;
  topic?: string;
  insertAt: number;
  // Unclamped position, used only to order summaries chronologically after
  // clamping folds several of them onto the same leading-prefix slot.
  orderKey: number;
}

function collectSummaryAnchors(
  state: CompressionState,
  indexById: Map<string, number>,
  summaryIndexById: Map<string, number>,
  clampIndex: number,
): SummaryAnchor[] {
  const anchors: SummaryAnchor[] = [];
  for (const block of activeBlocks(state)) {
    // Prefer the position of an already-rendered summary (hosts may pass a
    // previously-pruned view): keeps the summary stable in place instead of
    // jumping to index 0 when the raw ids are no longer in the input.
    const existingIndex = summaryIndexById.get(summaryMessageId(block.blockId));
    if (existingIndex !== undefined) {
      anchors.push({
        blockId: block.blockId,
        summary: block.summary,
        topic: block.topic,
        insertAt: Math.min(existingIndex, clampIndex),
        orderKey: existingIndex,
      });
      continue;
    }
    let earliest: number | null = null;
    for (const id of block.effectiveMessageIds) {
      const index = indexById.get(id);
      if (index !== undefined && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    const original = earliest ?? 0;
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      insertAt: Math.min(original, clampIndex),
      orderKey: original,
    });
  }
  anchors.sort((left, right) => left.orderKey - right.orderKey);
  return anchors;
}

function rebuildMessages(
  messages: CoreMessage[],
  covered: Set<string>,
  firstUserIndex: number,
  anchors: SummaryAnchor[],
): CoreMessage[] {
  const result: CoreMessage[] = [];
  const pending = [...anchors];
  const anchoredSummaryIds = new Set(
    anchors.map((anchor) => summaryMessageId(anchor.blockId)),
  );

  for (let index = 0; index < messages.length; index++) {
    while (pending.length > 0 && pending[0]!.insertAt === index) {
      result.push(renderSummary(pending.shift()!));
    }
    if (index === firstUserIndex && firstUserIndex >= 0) {
      result.push(messages[index]!);
      continue;
    }
    if (covered.has(messages[index]!.id)) continue;
    // A stale copy of this block's summary from a previously-pruned view:
    // the freshly rendered one above replaces it. Only rendered-summary
    // shaped messages qualify — a host message that merely reuses the
    // reserved prefix is content, not a stale copy.
    if (
      isRenderedSummaryMessage(messages[index]!) &&
      anchoredSummaryIds.has(messages[index]!.id)
    )
      continue;
    result.push(messages[index]!);
  }

  while (pending.length > 0) {
    result.push(renderSummary(pending.shift()!));
  }

  return result;
}

function renderSummary(anchor: SummaryAnchor): CoreMessage {
  const body = anchor.summary.trim();
  const topicLine = anchor.topic
    ? `${SUMMARY_HEADER} — ${anchor.topic}`
    : SUMMARY_HEADER;
  const text = body.length === 0 ? topicLine : `${topicLine}\n${body}`;
  return {
    id: summaryMessageId(anchor.blockId),
    role: "system",
    contentType: "text",
    text,
  };
}

function stripOrphanedToolResults(messages: CoreMessage[]): CoreMessage[] {
  const knownCallIds = new Set<string>();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId) {
      knownCallIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) =>
      m.contentType !== "tool-result" ||
      !m.toolCallId ||
      knownCallIds.has(m.toolCallId),
  );
}

function stripOrphanedToolCalls(messages: CoreMessage[]): CoreMessage[] {
  const knownResultIds = new Set<string>();
  for (const m of messages) {
    if (m.contentType === "tool-result" && m.toolCallId) {
      knownResultIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) =>
      m.contentType !== "tool-call" ||
      !m.toolCallId ||
      m.toolName === "compress" ||
      knownResultIds.has(m.toolCallId),
  );
}

/**
 * Defense-in-depth for reasoning/text pairing (analogue of
 * {@link stripOrphanedToolCalls}). A `reasoning` message is only meaningful
 * when immediately followed — after any same-run reasoning — by its companion
 * assistant text/tool-call; strict thinking models (DeepSeek et al.) reject
 * reasoning_content that has lost its response with HTTP 400. Compress-time
 * boundary expansion normally keeps the pair in one block, so this only fires
 * for degenerate straddles (block-boundary ranges, malformed input, or a
 * reasoning that never had a companion): drop the dangling run rather than
 * ship a 400-triggering half-pair. Runs AFTER tool stripping, since removing
 * an orphaned tool-call can leave its preceding reasoning dangling too.
 */
function stripOrphanedReasoning(messages: CoreMessage[]): CoreMessage[] {
  const drop = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue;
    if (messages[i]!.contentType !== "reasoning") continue;
    let j = i;
    while (
      j + 1 < messages.length &&
      messages[j + 1]!.contentType === "reasoning"
    ) {
      j++;
    }
    const companion = messages[j + 1];
    const hasCompanion =
      companion !== undefined &&
      companion.role === "assistant" &&
      (companion.contentType === "text" ||
        companion.contentType === "tool-call");
    if (!hasCompanion) {
      for (let k = i; k <= j; k++) drop.add(k);
    }
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, i) => !drop.has(i));
}
