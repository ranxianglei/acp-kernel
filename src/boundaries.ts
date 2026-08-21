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

/**
 * Thrown when a boundary ref parses but cannot be anchored in the visible
 * context. `kind` distinguishes a ref that never existed ("unknown", e.g. a
 * typo or a ref from another session) from one that was consumed by an
 * existing block ("consumed", messages hidden by prune). `endpoint` names the
 * failing side of the range so callers can attribute the error precisely.
 */
export class BoundaryNotFoundError extends Error {
  readonly code = "BOUNDARY_NOT_FOUND";
  readonly kind: "unknown" | "consumed";
  readonly endpoint: "start" | "end";

  constructor(
    kind: "unknown" | "consumed",
    endpoint: "start" | "end",
    message: string,
  ) {
    super(message);
    this.name = "BoundaryNotFoundError";
    this.code = "BOUNDARY_NOT_FOUND";
    this.kind = kind;
    this.endpoint = endpoint;
  }
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
  snappedBoundaries: string[];
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

  let snappedBoundaries: string[] = [];
  const startAnchor = resolveAnchorIndex(start, input.state, indexByRawId, "start");
  if (startAnchor.snapped) snappedBoundaries.push(startAnchor.snapped);
  const endAnchor = resolveAnchorIndex(end, input.state, indexByRawId, "end");
  if (endAnchor.snapped) snappedBoundaries.push(endAnchor.snapped);
  let startIndex = startAnchor.index;
  let endIndex = endAnchor.index;

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
    snappedBoundaries,
  };
}

interface AnchorResolution {
  index: number;
  snapped: string | null;
}

function resolveAnchorIndex(
  boundary: ParsedBoundary,
  state: CompressionState,
  indexByRawId: Map<string, number>,
  endpoint: "start" | "end",
): AnchorResolution {
  const label = endpoint === "start" ? "startId" : "endId";
  if (boundary.kind === "message") {
    const rawId =
      state.messageRefs.byRef[boundary.raw] ??
      state.messageRefs.byRef[formatPaddedRef(boundary.numericId)];
    if (!rawId) {
      throw new BoundaryNotFoundError(
        "unknown",
        endpoint,
        `${label}="${boundary.raw}" does not exist in this session (typo or wrong session) — run acp_status for current refs.`,
      );
    }
    const index = indexByRawId.get(rawId);
    if (index !== undefined) {
      return { index, snapped: null };
    }
    const owner = activeOwnerAnchor(state, [rawId], indexByRawId);
    if (owner !== null) {
      return {
        index: owner,
        snapped: `${label}="${boundary.raw}" refers to a message already compressed into an active block — anchored to that block's summary instead.`,
      };
    }
    throw new BoundaryNotFoundError(
      "consumed",
      endpoint,
      `${label}="${boundary.raw}" not found in visible context (likely consumed by an existing block).`,
    );
  }

  const block = blockById(state, `b${boundary.numericId}`);
  if (!block) {
    throw new BoundaryNotFoundError(
      "unknown",
      endpoint,
      `${label}="b${boundary.numericId}" does not exist in this session (typo or wrong session) — run acp_status for current refs.`,
    );
  }
  if (block.active) {
    const anchor = earliestIndexOfIds(block.effectiveMessageIds, indexByRawId);
    if (anchor !== null) {
      return { index: anchor, snapped: null };
    }
  }
  const owner = activeOwnerAnchor(state, block.effectiveMessageIds, indexByRawId);
  if (owner !== null) {
    return {
      index: owner,
      snapped: `${label}="b${boundary.numericId}" was consumed by a higher-tier block — anchored to the active block covering its content instead.`,
    };
  }
  if (!block.active) {
    throw new BoundaryNotFoundError(
      "consumed",
      endpoint,
      `${label}="b${boundary.numericId}" not found in visible context (block distilled/consumed by a higher-tier block).`,
    );
  }
  throw new BoundaryNotFoundError(
    "consumed",
    endpoint,
    `${label}="b${boundary.numericId}" not found in visible context (block messages consumed by a higher-tier block).`,
  );
}

/**
 * Snap a consumed anchor to the active block that now owns its content.
 * Throwing instead dead-ends compress calls that follow nudge instructions
 * with older (already-distilled) refs — the livelock in dog/billion-context-pi#32.
 */
function activeOwnerAnchor(
  state: CompressionState,
  ownedIds: string[],
  indexByRawId: Map<string, number>,
): number | null {
  if (ownedIds.length === 0) return null;
  const owned = new Set(ownedIds);
  let best: number | null = null;
  for (const block of state.blocks) {
    if (!block.active) continue;
    const anchor = earliestIndexOfIds(block.effectiveMessageIds, indexByRawId);
    if (anchor === null) continue;
    const ownsContent = block.effectiveMessageIds.some((id) => owned.has(id));
    if (ownsContent && (best === null || anchor < best)) {
      best = anchor;
    }
  }
  return best;
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
