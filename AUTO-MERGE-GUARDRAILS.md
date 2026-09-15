# acp-kernel — Auto-Merge Guardrails & Review Discipline

> Evidence base for §7 of this repo's `AGENTS.md`. Derived from a full-history audit of this
> repo plus its siblings (`billion-context`, `billion-context-pi`), filed under
> [billion-context#801](https://github.com/ranxianglei/billion-context/issues/801).
> **This is the CORE library.** Unlike the adapters, the kernel OWNS the compression-block
> model and the wire-artifact format that every adapter depends on. Its auto-merge surface is
> deliberately the **narrowest** of the three repos: a wrong "safe" change here propagates to
> every host and to the prefix cache by construction. Cross-repo changes stay manual/human.

## 1. Baseline facts (measured from this repo's history)

- 295 tracked items (220 PR / 75 issues); **175 merged, 0 closed-unmerged, 21 open**; 16 carry
  the `ework-agent-pr` marker. Authorship cannot separate AI from human (owner PAT) — classify
  by the `[bot] 🏷` comment prefix + PR marker instead.
- **Second-round ("重灾区") rate: of 20 merged PRs that drew human review, 5 (≈25%) needed ≥2
  human review touches** (billion-context ≈27%, billion-context-pi ≈42%). "≥2 human touches"
  approximates "needed a second review round."
- Zero runtime deps + pure pipeline = small per-file blast radius but **high fan-out**: every
  adapter links the kernel inline, so any contract change is cross-repo by construction.

## 2. Rules humans actually enforce

### 2.A Already codified in AGENTS.md
§2 Key Design Principles (esp. #3 single-owner content, #6 message-id immutability), §4 Git
Safety, §5 Release Workflow, §6 Code Review ("at least 2 separate agents").

### 2.B Implicit rules observed in review threads
- **Never split a tool call from its result** in prune/compress/fold
  ([#286](https://github.com/ranxianglei/acp-kernel/issues/286) /
  [#287](https://github.com/ranxianglei/acp-kernel/pull/287) /
  [#293](https://github.com/ranxianglei/acp-kernel/pull/293)). A fold that separates them
  corrupts the transcript the model re-sends.
- **Lossless round-trip is a guarantee, not best-effort.** Empty `reasoning_content` must
  survive the core round-trip ([#289](https://github.com/ranxianglei/acp-kernel/issues/289));
  raw control chars in compound JSON must not damage it ([#274](https://github.com/ranxianglei/acp-kernel/pull/274));
  a body `detectWireFormat` cannot parse MUST pass through untransformed.
- **Docs must match code defaults.** [#163](https://github.com/ranxianglei/acp-kernel/issues/163)
  `NudgeConfig` docstring drifted from the actual defaults. Nudge thresholds are load-bearing;
  a docstring that lies about a default misleads every adapter author.
- **Block state must be stable across turns** (keep host-expanded blocks deactivated
  [#181](https://github.com/ranxianglei/acp-kernel/pull/181)); tier-distillation nudges are
  count-triggered but gated to the nudge band ([#237](https://github.com/ranxianglei/acp-kernel/issues/237) /
  [#162](https://github.com/ranxianglei/acp-kernel/pull/162)); the growth baseline resets on a
  successful compress (no feedback-loop re-fire).
- **Capacity pressure resolves by widening `REF_WIDTH`, never recycling**
  (PR #176 ref-reclamation was reverted in #191).

## 3. What AI cannot reliably self-judge (blind spots)

### 3.1 KERNEL-OWNED CONTRACTS (first-class; ALWAYS human-gated)
The invariants every adapter relies on. A change to ANY of them is cross-repo +
prefix-cache-affecting by construction:
1. **Message-id / ref immutability** (§2 principle 6): a raw content-hash id and a `mNNNNN`
   ref denote exactly one message forever; no slot reclamation/recycling; widen `REF_WIDTH`.
   A re-issued number silently misattributes on decompress (**wrong content, not an error**).
2. **Wire-artifact format contract**: the ACP compression tag wrapping `mNNNNN`, the
   `acp_summary` structure, block refs, and rendered-tag token counts being **SNAPSHOTS frozen
   at first render** (not recomputed when text is later filtered/truncated/edited). Changing
   shape breaks every adapter plus the prefix cache.
3. **Single-owner content** (§2 principle 3): `assignRefsNode` is the sole writer of message
   content. Introducing a second writer breaks determinism.
4. **Lossless round-trip** (wire codec): `deriveMessageId` stability, the BiliMessage sidecar,
   passthrough-untransformed for unparseable bodies.
5. **Tool call/result atomicity** in prune/compress/fold.
6. **Protected-tool filtering** (hard-excluded from compression — Bug 39) and soft recent-zone
   semantics (excluded from the range but does not fail it).
7. **The four load-bearing Prompts rules** (overriding one requires `acknowledgeRisk`).
8. **Pipeline node ordering** (the canonical 9-node sequence) and nudge invariants
   (growth-gating, tier-trigger gating, baseline reset on compress).

### 3.2 Structural constraints that stay human
- **Zero runtime deps** (§2 principle 1) — no new dependency without sign-off.
- **Platform-agnostic** (§2 principle 5) — no host API / file I/O / network creep into the core.
- **State schema** — state is explicit in/out; adapters persist however they like. Changing the
  state *shape* is cross-repo.

## 4. Auto-merge gate (narrowest of the three repos)

A bugfix may **auto-merge** ONLY if ALL hold:
1. Scoped to **ONE pipeline node or standalone module**; no change to node ordering or pipeline shape.
2. A **pure** regression test reproduces the bug and now passes (no I/O / network / mocks of internals).
3. Green **on the rebased head** (typecheck + test + build + format:check).
4. Touches **NO** §3.1 contract or §3.2 structural constraint.
5. Pure `fix:` — no new capability surface.
6. Clean diff.
7. References its issue via `Fixes #N`.

**Must stay human:** any §3.1 contract, any §3.2 constraint, wire/message-shape changes,
config/schema, state format, cross-repo dependencies, feat/refactor/architecture, security, or
any default-value change (a product decision). Because a contract change is cross-repo by
construction, it ALSO follows the manual cross-repo rule: release acp-kernel first, verify
`npm view acp-kernel version`, then bump the adapters.

## 5. Reviewer checklist (walk in order)
1. Base current master? Rebase + re-run the full suite (typecheck/test/build/format).
2. Does the diff touch a §3.1 contract or §3.2 constraint? If yes → **human gate + cross-repo sequencing, stop.**
3. Is a touched node/module also changed by another open PR? (pipeline nodes are shared hotspots)
4. Round-trip preserved? (empty `reasoning_content`, control chars, unparseable → passthrough)
5. Tool-pair atomicity preserved in any prune/fold path?
6. Do docs still match the actual code defaults (#163)?
7. Deterministic test, no env/port luck?

## Appendix
- **Release ordering:** acp-kernel ships FIRST in the chain (adapters pin exact versions and
  bundle inline). Sibling consumption duties live in `billion-context` / `billion-context-pi`
  `AGENTS.md §7`.
- **Owner decision (#801):** rules merged into `AGENTS.md §7`; cross-repo stays manual for now.
