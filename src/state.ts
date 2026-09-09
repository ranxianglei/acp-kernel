import type { CompressionBlock, CompressionState } from "./types.js";

export function createInitialState(): CompressionState {
  return {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    tokenSnapshot: {},
    nudge: {
      lastPerMessageNudgeTokens: 0,
      lastNudgeShownTokens: 0,
      baselineTokens: 0,
      anchors: {},
      lastShownByTier: {},
    },
    stats: { tokensCompressed: 0, compressionCount: 0, absorbedTokens: 0 },
    absorbed: [],
    nextBlockId: 1,
    nextRunId: 1,
  };
}

export function allocateBlockId(state: CompressionState): string {
  const id = state.nextBlockId;
  state.nextBlockId = Math.max(1, id) + 1;
  return `b${id}`;
}

export function allocateRunId(state: CompressionState): string {
  const id = state.nextRunId;
  state.nextRunId = Math.max(1, id) + 1;
  return `r${id}`;
}

export function blockById(
  state: CompressionState,
  blockId: string,
): CompressionBlock | undefined {
  return state.blocks.find((block) => block.blockId === blockId);
}

export function activeBlocks(state: CompressionState): CompressionBlock[] {
  return state.blocks.filter((block) => block.active);
}

/**
 * Host projections may append a `#suffix` to a core message id (e.g.
 * `base#callId`, `base#r0`) to represent a variant of the same logical
 * message. Coverage is defined on the base id: a message is covered when any
 * sibling projection of it is covered by an active block.
 */
export function baseMessageId(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

/** True when `id` or any sibling projection of it is in `covered`. */
export function isIdCovered(covered: Set<string>, id: string): boolean {
  return covered.has(id) || covered.has(baseMessageId(id));
}

export function coveredMessageIds(state: CompressionState): Set<string> {
  const covered = new Set<string>();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) {
      covered.add(id);
      covered.add(baseMessageId(id));
    }
  }
  return covered;
}

export function highestActiveTier(state: CompressionState): 0 | 1 | 2 | 3 {
  let highest: 0 | 1 | 2 | 3 = 0;
  for (const block of state.blocks) {
    if (block.active && block.tier > highest) highest = block.tier;
  }
  return highest;
}

export function advanceSurvival(
  state: CompressionState,
  promotionThreshold: number,
): void {
  for (const block of state.blocks) {
    if (!block.active) continue;
    block.survivedCount += 1;
    if (block.survivedCount >= promotionThreshold) {
      block.generation = "old";
    }
  }
}
