import type { CoreMessage, MessageRefMap } from "./types.js";

const REF_WIDTH = 5;
const MIN_INDEX = 1;
const MAX_INDEX = 99999;
const REF_PATTERN = /^m0*(\d{1,5})$/;

export const BLOCKED_REF = "BLOCKED";

export function emptyRefMap(): MessageRefMap {
  return { byRaw: {}, byRef: {} };
}

export function indexToRef(index: number): string {
  if (!Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX) {
    throw new RangeError(
      `ref index out of bounds: ${index} (allowed ${MIN_INDEX}-${MAX_INDEX})`,
    );
  }
  return `m${String(index).padStart(REF_WIDTH, "0")}`;
}

export function refToIndex(ref: string): number | null {
  const match = REF_PATTERN.exec(ref.trim().toLowerCase());
  if (!match) return null;
  const index = Number(match[1]);
  if (index < MIN_INDEX || index > MAX_INDEX) return null;
  return index;
}

export function refForRaw(map: MessageRefMap, rawId: string): string | null {
  return map.byRaw[rawId] ?? null;
}

export function rawForRef(map: MessageRefMap, ref: string): string | null {
  return map.byRef[ref] ?? null;
}

export interface AssignRefsResult {
  map: MessageRefMap;
  nextIndex: number;
  newlyAssigned: number;
}

export interface AssignRefsOptions {
  existing: MessageRefMap;
  nextIndex: number;
  isProtected?: (message: CoreMessage) => boolean;
  shouldSkip?: (message: CoreMessage) => boolean;
}

export function assignRefs(
  messages: CoreMessage[],
  options: AssignRefsOptions,
): AssignRefsResult {
  const map: MessageRefMap = {
    byRaw: { ...options.existing.byRaw },
    byRef: { ...options.existing.byRef },
  };
  let cursor =
    Number.isInteger(options.nextIndex) && options.nextIndex >= MIN_INDEX
      ? options.nextIndex
      : MIN_INDEX;
  let newlyAssigned = 0;

  for (const message of messages) {
    if (!message.id || options.shouldSkip?.(message)) continue;

    if (map.byRaw[message.id]) continue;

    if (options.isProtected?.(message)) {
      map.byRaw[message.id] = BLOCKED_REF;
      continue;
    }

    const ref = allocateFreeRef(map, cursor);
    cursor = ref.index + 1;
    map.byRaw[message.id] = ref.text;
    map.byRef[ref.text] = message.id;
    newlyAssigned++;
  }

  return { map, nextIndex: cursor, newlyAssigned };
}

function allocateFreeRef(
  map: MessageRefMap,
  start: number,
): { text: string; index: number } {
  let candidate = Math.max(start, MIN_INDEX);
  while (candidate <= MAX_INDEX) {
    const text = indexToRef(candidate);
    if (!map.byRef[text]) {
      return { text, index: candidate };
    }
    candidate++;
  }
  throw new Error(
    `ref capacity exhausted: cannot allocate beyond ${indexToRef(MAX_INDEX)}`,
  );
}

export function rebuildRefIndex(map: MessageRefMap): MessageRefMap {
  const byRef: Record<string, string> = {};
  for (const [rawId, ref] of Object.entries(map.byRaw)) {
    if (ref !== BLOCKED_REF) byRef[ref] = rawId;
  }
  return { byRaw: { ...map.byRaw }, byRef };
}

export function highestUsedIndex(map: MessageRefMap): number {
  let highest = 0;
  for (const ref of Object.values(map.byRaw)) {
    const index = ref === BLOCKED_REF ? null : refToIndex(ref);
    if (index !== null && index > highest) highest = index;
  }
  return highest;
}
