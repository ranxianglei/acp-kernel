# acp-kernel — Auto-Merge Guardrails & Review Discipline

> Evidence base for §7 of this repo's `AGENTS.md`. Derived from a full-history audit of this
> repo plus its siblings (`billion-context`, `billion-context-pi`), filed under
> [billion-context#801](https://github.com/ranxianglei/billion-context/issues/801).
> **This is the CORE library** — it OWNS the compression-block model and the wire-artifact format
> every adapter depends on, so its auto-merge surface is deliberately the **narrowest** of the
> three repos.
> **Positioning:** the authoritative rule / auto-merge-gate / reviewer-checklist text lives in
> [`AGENTS.md` §7](./AGENTS.md#7-review--auto-merge-discipline) (loaded every session — the single
> source of truth). This file is **evidence-only**: measured baseline + the incident that proves
> each invariant load-bearing + blind-spot analysis. Rules/gate/checklist are NOT restated here,
> to avoid drift. Cross-repo changes stay manual/human.

## 1. Baseline facts (measured from this repo's history)

- 295 tracked items (220 PR / 75 issues); **175 merged, 0 closed-unmerged, 21 open**; 16 carry
  the `ework-agent-pr` marker. Authorship cannot separate AI from human (owner PAT) — classify by
  the `[bot] 🏷` comment prefix + PR marker instead.
- **Second-round ("重灾区") rate: of 20 merged PRs that drew human review, 5 (≈25%) needed ≥2
  human review touches** (billion-context ≈27%, billion-context-pi ≈42%).
- Zero runtime deps + pure pipeline = small per-file blast radius but **high fan-out**: every
  adapter links the kernel inline, so any contract change is cross-repo by construction.

## 2. Rules humans actually enforce (evidence)

> Rule text lives in `AGENTS.md` §7.1–§7.3; below is *why* each exists.

### 2.A Already codified in AGENTS.md
§2 Key Design Principles (esp. #3 single-owner content, #6 message-id immutability), §4 Git
Safety, §5 Release Workflow, §6 Code Review ("at least 2 separate agents").

### 2.B Implicit rules observed in review threads
- **Never split a tool call from its result** in prune/compress/fold
  ([#286](https://github.com/ranxianglei/acp-kernel/issues/286) /
  [#287](https://github.com/ranxianglei/acp-kernel/pull/287) /
  [#293](https://github.com/ranxianglei/acp-kernel/pull/293)) — a fold that separates them corrupts
  the transcript the model re-sends.
- **Lossless round-trip is a guarantee, not best-effort.** Empty `reasoning_content` survives the
  core round-trip ([#289](https://github.com/ranxianglei/acp-kernel/issues/289)); raw control chars
  in compound JSON don't damage it ([#274](https://github.com/ranxianglei/acp-kernel/pull/274)); a
  body `detectWireFormat` cannot parse MUST pass through untransformed.
- **Docs must match code defaults.** [#163](https://github.com/ranxianglei/acp-kernel/issues/163)
  `NudgeConfig` docstring drifted from the actual defaults — nudge thresholds are load-bearing, so
  a lying docstring misleads every adapter author.
- **Block state must be stable across turns** (keep host-expanded blocks deactivated
  [#181](https://github.com/ranxianglei/acp-kernel/pull/181)); tier-distillation nudges are
  pure-count, no usage gate, default-off 1000/2000 ([#379](https://github.com/ranxianglei/acp-kernel/issues/379) deleted
  #238's band gate; [#237](https://github.com/ranxianglei/acp-kernel/issues/237)/[#162](https://github.com/ranxianglei/acp-kernel/pull/162) history);
  the growth baseline resets on a successful compress (no feedback-loop re-fire).
- **Capacity pressure resolves by widening `REF_WIDTH`, never recycling** (PR #176 ref-reclamation
  was reverted in #191).

## 3. What AI cannot reliably self-judge (blind spots)

### 3.1 Kernel-owned contracts — the incident proving each is load-bearing
> Definitions live in `AGENTS.md` §7.3 (always human-gated). Below is only *why* each is
> non-negotiable:
1. **Message-id / ref immutability** — a re-issued number silently misattributes on decompress
   (**wrong content, not an error**); #176 was reverted for exactly this.
2. **Wire-artifact format** (tag / `acp_summary` / token-snapshot freezing) — changing shape breaks
   every adapter plus the prefix cache at once.
3. **Single-owner content** — a second writer of message content breaks determinism.
4. **Lossless round-trip** — see #289 (empty `reasoning_content`) and #274 (control chars).
5. **Tool call/result atomicity** — see #286/#287/#293.
6. **Protected-tool filtering** (Bug 39) — dropping protected calls out of compression changes what
   the model sees.
7. **Load-bearing Prompts rules** — overriding one silently degrades summary quality across sessions.
8. **Pipeline node ordering + nudge invariants** — reordering nodes or making count-triggered
   distillation the default again reintroduces needless wire rewrites and prefix-cache loss (#379).

### 3.2 Structural constraints that stay human
Zero runtime deps (§2 principle 1 — a new dep lands inside every adapter's inline bundle),
platform-agnostic (§2 principle 5 — no host API / file I/O / network creep into the core), and the
state schema (explicit in/out; changing its shape is cross-repo).

## Appendix
- **Gate + must-stay-human list + reviewer checklist:** see `AGENTS.md` §7.4 / §7.5 (single source
  of truth). Because a contract change is cross-repo by construction, it also follows the manual
  cross-repo rule: release acp-kernel first, verify `npm view acp-kernel version`, then bump adapters.
- **Release ordering:** acp-kernel ships FIRST in the chain (adapters pin exact versions and bundle
  inline). Sibling consumption duties live in `billion-context` / `billion-context-pi` `AGENTS.md §7`.
- **Owner decision (#801):** rules merged into `AGENTS.md §7`; cross-repo stays manual for now.
