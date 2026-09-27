import { coveredMessageIds } from "./state.js";
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

/**
 * Re-mint live messages whose id is claimed by an already-FOLDED copy of the
 * same content (billion-context #1476), WITHOUT re-minting ECHOS (#462). Runs
 * as the FIRST pipeline node, before assign-refs and prune, so the re-minted
 * id is what gets ref'd and what prune sees.
 *
 * Root cause: deriveMessageId's cluster counter restarts every conversion pass,
 * so text whose earlier copy was folded re-derives the SAME bare `h_…` id. A
 * stateless host resends its full raw history every turn — including those
 * folded originals — so within one pass an ECHO (the folded original itself,
 * resent verbatim) and a genuinely NEW identical instance are byte-identical.
 * The only reliable separator is cross-pass continuity via state.lastPassIds
 * (the exact ids inbound on the previous processTurn, written by processTurn):
 *
 * - exact id ∈ covered AND ∈ lastPassIds → ECHO. Leave untouched: prune drops
 *   it (coverage is decided per base id) and its ref stays stable. Renumbering
 *   it instead minted a fresh `_n` id + ref every turn, and since prune's
 *   `baseIdOf` strips `#tail` but NOT `_n`, the folded original escaped prune
 *   and re-inflated the wire alongside its summary (#462).
 * - exact id ∈ covered AND ∉ lastPassIds → genuinely NEW instance of folded
 *   content. Re-mint it a distinct `root_k` so assign-refs (first-wins on
 *   byRaw) can ref it and prune keeps it (#1476).
 * - exact id ∉ covered (incl. converter `_k` second-occurrence forms) → the
 *   old copy is still on the wire and un-folded; the in-pass occurrence count
 *   already keeps the pair distinct. Leave the converter numbering untouched —
 *   touching these ids only churns the prefix cache. Do not broaden to all
 *   bases.
 * - state.lastPassIds absent (pre-feature persisted state) → skip re-minting
 *   for this pass entirely (0.0.95 semantics); the field self-populates when
 *   the next processTurn runs.
 *
 * When ANY member of a conflicting root group needs re-minting, ALL non-echo
 * members are renumbered in arrival order to root_1, root_2, … skipping any
 * number a covered copy (folded or kept echo) already claims — otherwise two
 * live instances could land on the same id. Deterministic for a fixed
 * (state, body): stable _k every turn (prefix-cache stable), shifting only
 * when a newer identical instance joins the pass.
 */
export function remintCoveredLiveIds(
  messages: CoreMessage[],
  state: CompressionState,
): CoreMessage[] {
  const lastPass = state.lastPassIds;
  if (lastPass === undefined) return messages;
  const covered = new Set(coveredMessageIds(state));
  if (covered.size === 0) return messages;
  const seenLastPass = new Set(lastPass);

  const groups = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const root = clusterRoot(messages[i]!.id);
    if (root === null) continue;
    const idxs = groups.get(root);
    if (idxs) idxs.push(i);
    else groups.set(root, [i]);
  }

  const next = [...messages];
  let changed = false;
  for (const [root, idxs] of groups) {
    // Only renumber when some live instance claims an id a folded copy owns
    // EXACTLY. Echoes of folded originals are the common case post-fold and
    // must stay put (prune drops them under their stable refs).
    const conflict = idxs.some((i) => covered.has(messages[i]!.id));
    if (!conflict) continue;
    let k = 1;
    for (const i of idxs) {
      const id = messages[i]!.id;
      if (covered.has(id) && seenLastPass.has(id)) continue;
      while (covered.has(`${root}_${k}`)) k++;
      const hash = id.indexOf("#");
      const tail = hash > 0 ? id.slice(hash) : "";
      next[i] = { ...messages[i]!, id: `${root}_${k}${tail}` };
      k++;
      changed = true;
    }
  }
  return changed ? next : messages;
}
