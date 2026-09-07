import { summaryMessageId } from "./prune.js";
import type { CompressionState, CoreMessage } from "./types.js";

export interface SyncResult {
  state: CompressionState;
  deactivated: string[];
}

export function syncBlocks(
  messages: CoreMessage[],
  state: CompressionState,
): SyncResult {
  const presentIds = new Set(messages.map((message) => message.id));
  const deactivated: string[] = [];
  // Deep-clone (not just `{...state}`) so the caller's input state is never
  // mutated: processTurn stamps `state.nudge.*` and reassigns `messageRefs`,
  // and block sub-arrays must not alias the input. Previously nudge/stats/
  // messageRefs were shared references → input-state mutation leak.
  const result: CompressionState = {
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
    // Snapshot is keyed by ref with primitive values — shallow copy suffices.
    tokenSnapshot: { ...(state.tokenSnapshot ?? {}) },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    absorbed: (state.absorbed ?? []).map((record) => ({ ...record })),
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId,
  };

  // Refs are additive (assignRefs never removes them from messageRefs), so
  // prune the snapshot by currently-present message refs — otherwise it grows
  // unboundedly as messages are compressed/deleted across a long session.
  const liveRefs = new Set(
    messages
      .map((m) => result.messageRefs.byRaw[m.id])
      .filter((r): r is string => typeof r === "string"),
  );
  if (Object.keys(result.tokenSnapshot).length !== liveRefs.size) {
    const pruned: Record<string, number> = {};
    for (const [ref, n] of Object.entries(result.tokenSnapshot)) {
      if (liveRefs.has(ref)) pruned[ref] = n;
    }
    result.tokenSnapshot = pruned;
  }

  const consumedBlockIds = new Set<string>();
  for (const block of result.blocks) {
    for (const consumedId of block.directBlockIds) {
      consumedBlockIds.add(consumedId);
    }
  }

  for (const block of result.blocks) {
    if (consumedBlockIds.has(block.blockId)) {
      block.active = false;
      continue;
    }
    // Host-set `expanded` = the user explicitly decompressed this block, so its
    // deactivated state is intentional. Re-activating it here would re-fold the
    // already-restored messages next turn (double cost + lost originals). Keep
    // it inactive; a fresh compress of the same range creates a NEW block.
    if (block.expanded) {
      block.active = false;
      continue;
    }
    block.active = true;
    // A block whose raw messages were replaced by its rendered summary
    // (pruned view) is still present — the summary IS the block's visible
    // representation. Without this, hosts passing pruned views would lose
    // block activity every turn.
    const stillPresent =
      block.effectiveMessageIds.some((id) => presentIds.has(id)) ||
      presentIds.has(summaryMessageId(block.blockId));
    if (!stillPresent) {
      block.active = false;
      deactivated.push(block.blockId);
    }
  }

  return { state: result, deactivated };
}
