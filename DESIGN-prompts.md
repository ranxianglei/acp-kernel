# Customizable Prompts — Design

Status: **Layer 0 shipped** (this PR). Layers 1–3 are design intent, not yet built.

## Goal

Let hosts (and eventually third parties) customize the prompt text acp-kernel
feeds to the model — without forking the kernel. The feature is staged so the
highest-leverage, lowest-risk surface opens first.

## Why it is delicate

Most of the kernel's prompt text is **load-bearing**: it was tuned over months of
production use to keep summaries lossless enough for retrieval. A summary that
drops the "KEEP VERBATIM file paths / signatures / decisions" guidance will
quietly lose the strings a later `decompress` or `grep` needs. So customization
must distinguish two classes of text:

| Class | Examples | Override risk |
|-------|----------|---------------|
| **Load-bearing** | the 4 compression rules (`COMPRESS_PHILOSOPHY`, `HOW_TO_COMPRESS_RULES`, `TIER2_DISTILL_RULES`, `TIER3_CONDENSE_RULES`) | High — degrades summary quality / retrieval |
| **Surface** | summary section header, status-report chrome, tool descriptions, nudge tone | Low — presentation only |

Load-bearing overrides require explicit risk acknowledgement; surface overrides
are free.

## Architecture: where prompts live

Prompts are split across two layers, and the override interface must keep them
consistent:

- **acp-kernel** owns the load-bearing rules as exported constants
  (`src/compression-rules.ts`) and the nudge renderer
  (`renderNudgeText` in `src/nudge-text.ts`) that embeds them. Crucially,
  `processTurn` returns a *structured* `NudgeDecision`, not text — the host
  renders it, so nudge wording is already host-controllable.
- **Adapters** (billion-context-pi, opencode-acp, …) own the system prompt and
  tool descriptions, and they inline the kernel's rule constants when composing
  them.

The `Prompts` interface is the single typed surface a host overrides once and
passes everywhere, so both layers render the same customized text.

## Layer 0 — kernel override interface (shipped)

Scope: open the 4 load-bearing rules for override, behind a risk gate. No
default wording changes; pure additive.

### Public API (`src/prompts.ts`)

```ts
export interface Prompts {
  compressPhilosophy: string;
  howToCompressRules: string;
  tier2DistillRules: string;
  tier3CondenseRules: string;
}

export const defaultPrompts: Prompts;            // == the verbatim rule constants

export function resolvePrompts(
  overrides?: Partial<Prompts>,
  options?: { acknowledgeRisk?: boolean },
): Prompts;
```

- `resolvePrompts()` returns the defaults.
- `resolvePrompts({ ... })` **throws** unless `{ acknowledgeRisk: true }` is
  passed, because every field is load-bearing. The error names the offending
  keys. This mirrors the existing `compress`-tool `dangerous` /
  `acknowledgeRisk` pattern.
- `renderNudgeText(decision, prompts = defaultPrompts)` now accepts a `Prompts`
  argument, so an override flows into every nudge tier (gentle / emergency /
  tier-2 / tier-3). The default keeps the one-arg call backward-compatible.

### Host usage

```ts
import { resolvePrompts, renderNudgeText } from "acp-kernel";

// once, at startup — throws if user overrides rules without ack
const prompts = resolvePrompts(userOverrides, { acknowledgeRisk: userAcked });

// pass to the kernel renderer
const nudge = renderNudgeText(decision, prompts);

// and to the adapter's own system-prompt composition (Layer 2 will formalize)
systemPrompt += prompts.compressPhilosophy + prompts.howToCompressRules;
```

### Non-goals for Layer 0

- Surface text (summary header, status-report headers, tool descriptions) is
  intentionally **not** overridable here. Threading the summary header through
  `prune.ts` folding is invasive and low-value; status chrome is rarely
  customized. These belong to later layers.
- Inline validation error strings (`src/compress.ts`) stay fixed.
- No config field is added to `Config` / `defaultConfig`; the host holds the
  resolved `Prompts` object and passes it explicitly. This keeps config purely
  numeric and avoids threading prompts through `processTurn`.

## Layer 1 — prompt-set format (design intent)

A portable, validated bundle so overrides are declarative rather than code:

```
acp-prompt-set.json   # { name, version, targetKernel, description, acknowledgeRisk }
philosophy.md          # overrides compressPhilosophy (omit to inherit default)
how-to-compress.md
tier2.md
tier3.md
```

Principles:
- **Partial override + inheritance** — a set specifies only what it changes;
  everything else inherits kernel defaults. Forward-compatible: a new kernel
  prompt field does not break existing sets.
- **JSON Schema validation** at load time.
- **`acknowledgeRisk` in the manifest** — load-bearing fields are still gated,
  so the set declares up front that it knowingly overrides quality-critical
  rules.

## Layer 2 — adapter plumbing (design intent)

Each adapter reads a prompt-set path from its config and feeds the resolved
`Prompts` to both the kernel renderer and its own system-prompt composition.

For billion-context-pi, `user-config.ts` (already reads `~/.pi/agent/acp.json`)
gains:

```json
{ "prompts": { "preset": "acp-prompt-pack-zen", "overrides": { "..." : "..." } } }
```

The same format works for every downstream (opencode-acp, omp-acp, …), so a
prompt set is portable across hosts.

## Layer 3 — third-party prompt packages (design intent)

Once the format is stable, a third party publishes an npm package exporting a
validated prompt set. Install + reference by name:

```
npm install acp-prompt-pack-zen
```

The kernel gains a `registerPromptSet` registry, matching the existing
`registerSearchAlgorithm` / `registerMessageFilter` pattern.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Compression-quality regression from bad rules | `acknowledgeRisk` gate; defaults stay the strongly-recommended path |
| Version drift (kernel changes `NudgeDecision` shape) | `Prompts` is data-only (no function fields), so it is stable across refactors; future renderer overrides would carry a version stamp |
| Prompt injection via third-party packs | Prompt packs are trusted code (same trust level as any npm dep); documented in the trust model |
| Tool-description / schema mismatch | Tool schemas stay kernel-owned and fixed; only human-readable descriptions are customizable |

## Migration / rollout

1. Kernel ships Layer 0 (this PR). No downstream change required — defaults are
   byte-identical.
2. Adapters adopt the resolved-`Prompts` object when they want to offer
   customization (Layer 2), reading the same object for both nudge rendering and
   system-prompt composition.
3. Format + packages (Layers 1 & 3) follow once adoption confirms the field set
   is right.
