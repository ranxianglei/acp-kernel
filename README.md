# acp-kernel

Framework-agnostic, model-driven context-compression engine. Pure TypeScript core with **zero host dependency** — like a zip library, it does not assume any agent, server, or UI exists.

## What this is

`acp-kernel` is a **host-agnostic, model-driven context-compression engine**: 3-tier LSM-tree context compression, growth-based nudge policy, protected-content filtering. Its compression algorithms and pipeline architecture (`PipelineNode` / `processTurn` / `CompressionCore`) are **original work by the ACP authors** — an independent reimplementation, not a port of any existing codebase.

The key design principle: **the model writes the summaries; this library orchestrates everything around them.** The core decides *when* to compress, *what range* to compress, tracks *state* (blocks, message-id mapping, tiers), applies a compress *decision*, prunes compressed ranges, and supports decompress/search. It never calls a model.

## Why a separate library

- **Decoupling**: the original plugin is tightly coupled to OpenCode's hook system, making the algorithm hard to test and reuse.
- **Multi-host**: one core, multiple thin adapters (OpenCode, Pi, or any agent).
- **License clarity**: an independent reimplementation that shares **no source code** with its inspiration, opencode-dynamic-context-pruning (DCP, AGPL-3.0). Released under the permissive MIT license. See the [License](#license) section for the full provenance statement.

## Mental model

```
processTurn({ messages, state }) → { messages, state, nudge? }    // like zip(data)→data, but stateful state passed in/out
applyCompression({ call, state }) → { state, result }             // call.summary is produced externally by the model
```

The core is **stateless with respect to storage**: state is an explicit input and output of every call. The host persists state between turns however it likes.

See [DESIGN.md](./DESIGN.md) for the full contract and [PROVENANCE.md](./PROVENANCE.md) for the per-module origin audit (which modules are original work vs. reimplemented from scratch).

## API

### Core engine (`createCore`)

```ts
import { createCore, createInitialState, defaultConfig } from "acp-kernel";

const core = createCore();          // optional: { countTokens }
const state = createInitialState();
const config = defaultConfig(200000); // modelContextLimit (positional); optional overrides as 2nd arg

// processTurn runs the canonical node pipeline every turn:
// assign-refs → sync-blocks → merge-blocks → prune → filter →
// hide-compress-calls → nudge-inject → emergency-truncate → render-refs
const { messages, state: nextState, nudge } = core.processTurn({
  messages, state, config, tokenCount,
});

// When the model emits a compress decision (summary written by the model):
const { state: compressed, result } = core.applyCompression({
  ranges: [{ startRef: "m00005", endRef: "m00020", summary: "..." }],
  messages, state: nextState, config,
});

core.decompress("b3", compressed);            // look up a block
core.search("auth token", compressed);        // relevance-ranked block search
core.status(compressed, tokenCount, config);  // context-usage report
```

#### `renderTags` — host-side rendering strategy

`processTurn` always assigns a ref (e.g. `m00005`) to **every** mapped message,
including tool calls — that ref map is the anchor the model cites inside
`compress` calls. What varies is whether the `<acp>` tag is also **injected into
message text**. Pick the strategy that matches how your host consumes the
output:

```ts
import { processTurn, type RenderStrategy } from "acp-kernel";

type RenderStrategy = "all" | "text-only" | "none";

// default: every mapped message gets a visible <acp> tag.
// Use for in-process hosts (pai-acp / billion-context-pi) where the LLM
// reads the tag to identify compress ranges.
processTurn({ messages, state, config, tokenCount });

// proxy mode: tag user/assistant text, but leave tool-call args and tool
// results pristine (a <acp> tag inside {"command":"echo"} corrupts the JSON).
// Refs are still assigned to every message; only text rendering is selective.
processTurn({ messages, state, config, tokenCount, renderTags: "text-only" });

// host reads the ref map directly and never wants tags in the text.
// processTurn honors this by omitting the render-refs node entirely.
processTurn({ messages, state, config, tokenCount, renderTags: "none" });
```

`renderTags` is optional and defaults to `"all"`, so existing call sites keep
working unchanged.

### Standalone modules

| Module | Purpose |
|--------|---------|
| `truncateLargeToolOutputs` | Emergency context-threshold-gated truncation of large visible tool outputs (last-resort safety valve; summaries are never touched) |
| `hideConsumedCompressCalls` | Hide historical compress tool-calls whose block is inactive |
| `buildStatusReport` / `buildRecap` | Context-usage report + block recap |
| `mergeMarkedBlocks` / `collectOldGenBlocks` | Batch merge old-gen blocks into one summary |
| `rebuildCompressionState` | Fork-recovery: replay historical compress calls |
| `applyMessageFilters` | Pluggable message-filter framework |

### Nudge system

The nudge system tells the model *when* to compress. It implements:

- **Threshold gate**: fires when context usage ≥ `nudge.minContextLimitPct`.
- **Growth-gating**: a repeat nudge requires positive growth since the baseline (prevents re-firing every turn). `"strong"` force relaxes this.
- **Tier-distillation triggers**: when active tier-1 blocks pile up past `tiers.tier2Trigger`, emit a tier-2 distillation nudge; tier-3 analogously.
- **Compressible-range computation**: reports the actual compressible ranges (excluding covered + preserved-recent messages) so the model knows what to target.
- **Baseline reset on compress**: `applyCompression` clears the growth baseline on success, preventing the feedback-loop bug where the nudge re-fires post-compress.

## Status

✅ **Engine complete** — 23 source modules, 167 tests, typecheck + build clean. 3-tier compression, growth-gated nudges, emergency truncation,, fork-recovery, batch merge, composable node pipeline. Ready for adapter authoring.

> **Protected tool messages:** protected tool calls (per `config.protectedTools`) and their paired tool-results are hard-excluded from compression — they are dropped from the compressible set and from the new block's `effectiveMessageIds`, so they stay fully visible and are never folded into a summary. This matches opencode-acp's Bug 39 fix. The soft-protected recent zone (`preserveRecentMessages` / last user message) is handled separately: messages there are excluded from the range but do not fail it (an entirely-protected range fails with a clear error).

## License

MIT © ranxianglei

### Provenance

`acp-kernel` is an **independent reimplementation** of the ACP compression engine. Its compression algorithms and pipeline architecture (`PipelineNode` / `runPipeline` / `processTurn` / `CompressionCore`, the `CompressionBlock` data model, the `messageRefs` mapping, `assign-refs`, `NudgeDecision`, etc.) are **original work by the ACP authors**.

It is **inspired by, but not derived from**, [opencode-dynamic-context-pruning](https://github.com/Tarquinen/opencode-dynamic-context-pruning) (DCP, AGPL-3.0, by Tarquinen). The two projects:

- share **no source code** (different tokenizers — chars/4 vs. tiktoken; different strategies; different data models);
- were written from scratch independently;
- use unrelated host integration models.

Because acp-kernel is an independent work rather than a derivative of DCP, the ACP authors — as sole copyright holders of this codebase — release it under the permissive MIT license. This is independent of DCP's AGPL-3.0 terms, which govern only DCP and its derivatives (such as [opencode-acp](https://github.com/ranxianglei/opencode-acp)).
