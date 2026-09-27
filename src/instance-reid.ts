import { baseIdOf, summaryMessageId } from "./prune.js";
import { isBlockStillPresent } from "./sync.js";
import type { CompressionState, CoreMessage } from "./types.js";

// deriveMessageId mints "h_" + 16 lowercase hex, optionally with a within-pass
// cluster suffix "_<n>" and/or a sub-id projection "#<tail>". These are the only
// ids that collide across turns; reserved ids (acp_summary_*, retrieved_*, host
// ids) never do and are left untouched.
const CONTENT_HASH_ROOT = /^h_([0-9a-f]{16})(?:_\d+)?(?:#.*)?$/;

function clusterRoot(id: string): string | null {
  const m = CONTENT_HASH_ROOT.exec(id);
  return m ? `h_${m[1]}` : null;
}

function instanceNumber(id: string, root: string): number | null {
  if (!id.startsWith(`${root}_`)) return null;
  const n = Number(id.slice(root.length + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Re-mint live messages whose content identity collides with an already-FOLDED
 * copy (#1476) — unless the collision is the host positionally replaying the
 * very originals the block was folded from (#461). Runs as the FIRST pipeline
 * node, before assign-refs and sync-blocks, so the id that survives this node
 * is what gets ref'd, what sync sees, and what prune sees.
 *
 * Two distinct situations produce a live message carrying a covered id:
 *
 *   1. POSITIONAL REPLAY (#461). Hosts that compress server-side resend their
 *      FULL raw history each request; after a fold the next request carries the
 *      folded originals verbatim and their deterministic ids re-derive
 *      identically (the cluster counter restarts per pass). Those resends ARE
 *      the originals: they must keep their ids so prune drops them and the
 *      rendered summary takes their place at the anchor (the pre-0.0.96
 *      contract). Re-minting them lets the folded content back onto the wire
 *      every turn, deactivates the block, and starves the summary of its
 *      carrier.
 *   2. GENUINELY NEW INSTANCE (#1476). A fresh message matching folded content
 *      re-derives the SAME bare id in a pass where the original is not
 *      positionally resent (pruned view carrying the rendered summary, trimmed
 *      history, …). It must get a distinct instance id or assignRefs
 *      (first-wins on byRaw) starves it of a ref and prune silently deletes it.
 *
 * The kernel cannot ask the host which case applies (no Ports surface), so the
 * positional fingerprint distinguishes them deterministically: a block is
 * REPLAYING when its rendered summary is absent AND every one of its covered
 * bases is present — only a full resend of the folded population produces that
 * shape. An occurrence under exclusively-replaying coverage keeps its id; under
 * any other shape (summary present, partial presence, ambiguous single-message
 * fingerprint) it is treated as a new instance and re-minted — erring toward
 * shipping a duplicate rather than deleting a user turn.
 *
 * Coverage is judged per sync's own activation predicate (isBlockStillPresent,
 * recomputed against THIS input) rather than the stored `active` flag: a block
 * deactivated last turn (view lacked both raws and summary) reactivates this
 * turn when the summary returns, and its coverage must already be visible here
 * or a colliding new instance slips through un-minted and gets pruned.
 * Consumed (tier-folded) and expanded blocks never cover.
 *
 * For each conflicting root, only the classified new instances are renumbered,
 * in arrival order, to root_1, root_2, … skipping any number a folded copy
 * claims and any number retained by a group member that keeps its id. Non-
 * conflicting members are never touched (their refs must not churn).
 * Deterministic for a fixed (state, body).
 */
export function remintCoveredLiveIds(
  messages: CoreMessage[],
  state: CompressionState,
): CoreMessage[] {
  const liveBases = new Set<string>();
  const liveIds = new Set<string>();
  for (const message of messages) {
    if (typeof message.id !== "string") continue;
    liveIds.add(message.id);
    liveBases.add(baseIdOf(message.id));
  }

  const consumed = new Set<string>();
  for (const block of state.blocks) {
    for (const id of block.directBlockIds) consumed.add(id);
  }

  const coverersByBase = new Map<string, boolean[]>();
  const coveredBases = new Set<string>();
  let anyCoverage = false;
  for (const block of state.blocks) {
    if (consumed.has(block.blockId) || block.expanded) continue;
    if (!isBlockStillPresent(block, liveBases, liveIds)) continue;
    const bases = new Set<string>();
    for (const id of block.effectiveMessageIds) bases.add(baseIdOf(id));
    let allPresent = bases.size > 0;
    for (const base of bases) {
      if (!liveBases.has(base)) {
        allPresent = false;
        break;
      }
    }
    const replaying =
      allPresent && !liveIds.has(summaryMessageId(block.blockId));
    anyCoverage = true;
    for (const base of bases) {
      coveredBases.add(base);
      const flags = coverersByBase.get(base);
      if (flags) flags.push(replaying);
      else coverersByBase.set(base, [replaying]);
    }
  }
  if (!anyCoverage) return messages;

  const groups = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const id = messages[i]!.id;
    if (typeof id !== "string") continue;
    const root = clusterRoot(id);
    if (root === null) continue;
    const idxs = groups.get(root);
    if (idxs) idxs.push(i);
    else groups.set(root, [i]);
  }

  const next = [...messages];
  let changed = false;
  for (const [root, idxs] of groups) {
    const remintIdx: number[] = [];
    for (const i of idxs) {
      const flags = coverersByBase.get(baseIdOf(messages[i]!.id));
      if (!flags) continue;
      const positionalReplay = flags.every((replaying) => replaying);
      if (positionalReplay) continue;
      remintIdx.push(i);
    }
    if (remintIdx.length === 0) continue;

    const reminting = new Set(remintIdx);
    const taken = new Set<number>();
    for (const base of coveredBases) {
      const n = instanceNumber(base, root);
      if (n !== null) taken.add(n);
    }
    for (const i of idxs) {
      if (reminting.has(i)) continue;
      const n = instanceNumber(baseIdOf(messages[i]!.id), root);
      if (n !== null) taken.add(n);
    }
    let k = 1;
    for (const i of remintIdx) {
      while (taken.has(k)) k++;
      const id = messages[i]!.id;
      const hash = id.indexOf("#");
      const tail = hash > 0 ? id.slice(hash) : "";
      next[i] = { ...messages[i]!, id: `${root}_${k}${tail}` };
      taken.add(k);
      changed = true;
    }
  }
  return changed ? next : messages;
}
