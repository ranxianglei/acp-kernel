import { activeBlocks, coveredMessageIds } from "./state.js";
import type { CompressionState, CoreMessage } from "./types.js";

export const SUMMARY_HEADER = "[Compressed conversation section]";

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

  const indexById = new Map<string, number>();
  messages.forEach((message, index) => indexById.set(message.id, index));

  const anchors = inject ? collectSummaryAnchors(state, indexById) : [];

  return stripOrphanedToolResults(
    stripOrphanedToolCalls(
      rebuildMessages(messages, covered, firstUserIndex, anchors),
    ),
  );
}

interface SummaryAnchor {
  blockId: string;
  summary: string;
  topic?: string;
  insertAt: number;
}

function collectSummaryAnchors(
  state: CompressionState,
  indexById: Map<string, number>,
): SummaryAnchor[] {
  const anchors: SummaryAnchor[] = [];
  for (const block of activeBlocks(state)) {
    let earliest: number | null = null;
    for (const id of block.effectiveMessageIds) {
      const index = indexById.get(id);
      if (index !== undefined && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      insertAt: earliest ?? 0,
    });
  }
  anchors.sort((left, right) => left.insertAt - right.insertAt);
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

  for (let index = 0; index < messages.length; index++) {
    while (pending.length > 0 && pending[0]!.insertAt === index) {
      result.push(renderSummary(pending.shift()!));
    }
    if (index === firstUserIndex && firstUserIndex >= 0) {
      result.push(messages[index]!);
      continue;
    }
    if (covered.has(messages[index]!.id)) continue;
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
    id: `acp_summary_${anchor.blockId}`,
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
