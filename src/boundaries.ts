import { activeBlocks, blockById } from "./state.js";
import type {
  CompressionState,
  CoreMessage,
  ResolvedBoundary,
} from "./types.js";

export type BoundaryKind = "message" | "block";

export interface ParsedBoundary {
  kind: BoundaryKind;
  numericId: number;
  raw: string;
}

const MESSAGE_REF_PATTERN = /^m0*(\d{1,5})$/;
const BLOCK_REF_PATTERN = /^b(\d{1,9})$/;

export function parseBoundary(ref: string): ParsedBoundary | null {
  const normalized = ref.trim().toLowerCase();
  const messageMatch = MESSAGE_REF_PATTERN.exec(normalized);
  if (messageMatch) {
    const numericId = Number(messageMatch[1]);
    if (numericId >= 1 && numericId <= 99999) {
      return { kind: "message", numericId, raw: normalized };
    }
  }
  const blockMatch = BLOCK_REF_PATTERN.exec(normalized);
  if (blockMatch) {
    const numericId = Number(blockMatch[1]);
    if (numericId >= 1) return { kind: "block", numericId, raw: normalized };
  }
  return null;
}

export interface ResolveBoundariesInput {
  startRef: string;
  endRef: string;
  messages: CoreMessage[];
  state: CompressionState;
}

export interface ResolvedRange {
  startIndex: number;
  endIndex: number;
  messageIds: string[];
  nestedBlockIds: string[];
  boundaryKind: BoundaryKind;
  protectedGaps: number[];
}

export function resolveBoundaries(
  input: ResolveBoundariesInput,
): ResolvedRange {
  const start = parseBoundary(input.startRef);
  const end = parseBoundary(input.endRef);
  if (!start || !end) {
    throw new Error(
      `Invalid boundary ref(s): startId="${input.startRef}", endId="${input.endRef}". Use mNNNNN or bN.`,
    );
  }

  const indexByRawId = new Map<string, number>();
  input.messages.forEach((message, index) =>
    indexByRawId.set(message.id, index),
  );

  let startIndex = resolveAnchorIndex(start, input.state, indexByRawId);
  let endIndex = resolveAnchorIndex(end, input.state, indexByRawId);

  if (startIndex === null || endIndex === null) {
    throw new Error(
      `Boundary not found in visible context (likely consumed by an existing block). ` +
        `startId="${input.startRef}", endId="${input.endRef}".`,
    );
  }

  if (startIndex > endIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
  }

  const messageIds: string[] = [];
  for (let index = startIndex; index <= endIndex; index++) {
    const message = input.messages[index];
    if (message) messageIds.push(message.id);
  }

  const boundaryKind: BoundaryKind =
    start.kind === "block" || end.kind === "block" ? "block" : "message";

  const nestedBlockIds: string[] = [];
  const nestedSeen = new Set<string>();
  for (const block of activeBlocks(input.state)) {
    const anchor = earliestIndexOfIds(block.effectiveMessageIds, indexByRawId);
    if (anchor !== null && anchor >= startIndex && anchor <= endIndex) {
      if (!nestedSeen.has(block.blockId)) {
        nestedSeen.add(block.blockId);
        nestedBlockIds.push(block.blockId);
      }
    }
  }

  const protectedGaps: number[] = [];

  return {
    startIndex,
    endIndex,
    messageIds,
    nestedBlockIds,
    boundaryKind,
    protectedGaps,
  };
}

function resolveAnchorIndex(
  boundary: ParsedBoundary,
  state: CompressionState,
  indexByRawId: Map<string, number>,
): number | null {
  if (boundary.kind === "message") {
    const rawId =
      state.messageRefs.byRef[boundary.raw] ??
      state.messageRefs.byRef[formatPaddedRef(boundary.numericId)];
    if (!rawId) return null;
    const index = indexByRawId.get(rawId);
    return index === undefined ? null : index;
  }

  const block = blockById(state, `b${boundary.numericId}`);
  if (!block || !block.active) return null;
  return earliestIndexOfIds(block.effectiveMessageIds, indexByRawId);
}

function formatPaddedRef(index: number): string {
  return `m${String(index).padStart(5, "0")}`;
}

export function earliestIndexOfIds(
  ids: string[],
  indexByRawId: Map<string, number>,
): number | null {
  let earliest: number | null = null;
  for (const id of ids) {
    const index = indexByRawId.get(id);
    if (index !== undefined && (earliest === null || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}

export function toResolvedBoundary(range: ResolvedRange): ResolvedBoundary {
  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    protectedGaps: range.protectedGaps,
  };
}
