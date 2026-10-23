import type { CompressionState, CoreMessage } from "./types.js";

/**
 * Branch-aware block activity.
 *
 * The kernel's syncBlocks keeps a block active while ANY of its covered
 * messages is still in view. After a host-side rewind into the middle of a
 * block's range (e.g. pi's `/tree` navigation), the block's summary — which
 * describes messages that now live on another branch — would replace the few
 * messages still in view, showing the model decisions from a future it has
 * not reached.
 *
 * A block is "off-branch" when some of its covered messages are in view and
 * some are known-persisted session entries that are NOT on the current
 * branch. The host declares the persisted id set per turn via
 * `ProcessTurnInput.persistedMessageIds`; `processTurn` then masks such
 * blocks as expanded for the turn (their in-view messages show raw) and
 * restores the original `expanded` flag on the result, so nothing is
 * persisted: returning to the full branch reactivates the block. Messages
 * missing for other reasons (never persisted, host-side live ids) keep the
 * kernel's default behaviour.
 */

/** Strip a live-instance subid: `"e3#k2"` and `"e3"` share the base `"e3"`. */
function baseIdOf(id: string): string {
  const hash = id.indexOf("#");
  return hash > 0 ? id.substring(0, hash) : id;
}

export function findOffBranchBlocks(
  messages: readonly CoreMessage[],
  state: CompressionState,
  persistedIds: ReadonlySet<string>,
): string[] {
  const present = new Set<string>();
  for (const m of messages)
    if (typeof m.id === "string") present.add(baseIdOf(m.id));
  const off: string[] = [];
  for (const block of state.blocks) {
    if (block.expanded) continue;
    let inView = false;
    let elsewhere = false;
    for (const id of block.effectiveMessageIds) {
      const base = baseIdOf(id);
      if (present.has(base)) inView = true;
      else if (persistedIds.has(base)) elsewhere = true;
      if (inView && elsewhere) break;
    }
    if (inView && elsewhere) off.push(block.blockId);
  }
  return off;
}
