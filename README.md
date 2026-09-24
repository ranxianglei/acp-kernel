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
// assign-refs → sync-blocks → prune → ccr-store → absorb-hide → crush →
// absorb-prompt → filter → hide-compress-calls → recommend → nudge-inject
// → emergency-truncate → render-refs
const { messages, state: nextState, nudge, contentStore } = core.processTurn({
  messages, state, config, tokenCount,
  contentStore, // previous turn's content store (optional; see CCR below)
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

#### CCR — content-cached retrieval (lossless tool-result offload)

CCR is the lossless alternative to absorb's lossy distillation. When enabled,
a tool result at or above `ccr.minToolTokens` is stored **once, at arrival** in
the per-session content store, and its visible copy is replaced with a
deterministic placeholder carrying enough signal (kind, size, command/head
preview, ref) to judge relevance without retrieving. The model pulls the
original back via the `acp_retrieve` tool; the retrieved text rides back as an
ephemeral trailing message that never consumes a ref and never enters the fold
space. Disabled by default — no behavior change unless opted in.

```ts
const config = defaultConfig(200000, { ccr: { enabled: true } }); // opt-in

// Turn N: pass the previous turn's store back in.
const { messages, state, contentStore } = core.processTurn({
  messages, state, config, tokenCount,
  contentStore, // persisted from turn N-1 (host owns persistence)
});

// When the model calls acp_retrieve({ ref }):
const hit = core.retrieve(contentStore, "m00042");
if (hit.ok) {
  // hit.text      — the original bytes
  // hit.injection — trailing request-only message to append for this request
  // hit.ackText   — short tool-result ack string
} else {
  // hit.ackText — not-found notice (hallucinated ref costs one tool call)
}
```

Placeholder wire shape (deterministic — same inputs always produce identical
bytes, so the visible text is byte-stable after arrival and prefix-cache
friendly):

```
📦 [acp-stored #m00423 · shell output · 4,213 tok] `npm run build`
   → acp_retrieve("m000423") returns the full text
```

Contract guarantees:

- **Replace-once-at-arrival.** The visible bytes change exactly once
  (original → placeholder); every later turn sees identical bytes.
- **Tool-pair integrity.** Only the tool-result's own content shrinks; the
  paired assistant `tool_calls` survive untouched (OpenAI-family wire pairing).
- **id-never-reused safe.** The store is per-ref append-only, first-write-wins,
  and never reissues or recycles refs. Refs stay retrievable even if a host
  prunes its own `messageRefs` map after compaction (e.g. billion-context
  archive), because lookup happens against the store, not the ref map.
- **Ephemeral retrieval.** `acp_retrieved_*` messages are skipped by assign-refs
  and excluded from block coverage — they consume no ref and enter no fold
  space. Hosts may strip them after the request (nudge channel); if they
  round-trip anyway, the kernel handles them safely.
- **Coexists with absorb.** Placeholder-marked results are never absorb
  candidates (ID-reference wins); absorb keeps handling semantic distillation
  of everything else.

Persistence: the store is plain JSON (`{ version: 1, byHash, byRef }`) — hosts
persist it alongside `CompressionState` (same StateStore envelope path as
blockContents). Content-addressed dedup means identical bytes are written once.
`core.status(...)` reports `breakdown.storedMessages` and
`breakdown.retrievals` so a host can measure retrieve rate.

For folded-range retention (v2 groundwork), hosts can call
`storeCoveredOriginals(store, messages, compressedState, [blockId], countTokens)`
right after `applyCompression` so pruned originals stay retrievable by ref.

**Token counts in rendered tags are snapshots.** Each message's
`<acp tokens="N">` attribute is frozen at the tag's first render (the
per-message `tokenSnapshot` in state) and is not recomputed when the message
text is later filtered, truncated, or edited by the host — the number always
describes what the model originally saw. Nudge/pressure *decisions* are
unaffected: they recount live text every turn. If you need the legacy
live-recomputed tags, use `renderVisibleRefs` directly.

### Standalone modules

| Module | Purpose |
|--------|---------|
| `truncateLargeToolOutputs` | Emergency context-threshold-gated truncation of large visible tool outputs (last-resort safety valve; summaries are never touched) |
| `hideConsumedCompressCalls` | Hide historical compress tool-calls whose block is inactive |
| `buildStatusReport` / `buildRecap` | Context-usage report + block recap |
| `mergeMarkedBlocks` / `collectOldGenBlocks` | Batch merge old-gen blocks into one summary |
| `rebuildCompressionState` | Fork-recovery: replay historical compress calls |
| `MessageContentStore` / `storeLargeResults` / `retrieveByRef` / `storeCoveredOriginals` | CCR content store: per-session, content-addressed dedup of tool-result originals + on-demand retrieval (see "CCR" above) |
| `applyMessageFilters` | Pluggable message-filter framework |
| `resolveTransformChannel` | Channel-selection policy: an explicit preference wins; the default is the wire channel only when the caller reports it viable |
| `decideOutputSteering` / `classifyTurn` / `clampEffortToFloor` / `applySteeringToPrompt` | Output-side steering *decisions* (#355): structural turn classification (`new_user_ask` / `mechanical_continuation` / `error_continuation` / `unknown`), byte-stable verbosity directives L0–L4 (default L2), and clamp-only effort routing. The kernel decides; adapters land decisions onto wire fields. Default OFF |
| `applySectionOverrides` / `cloneWithDescriptions` / `applyAcpToolOverrides` | Prompt/tool *surface* customization (see below) |
| `sanitizePackSurface` / `createPackResolver` / `defaultPackSources` | Prompt packs: named, swappable surface presets resolved over pluggable sources (see below) |

### Prompt/tool surface configuration

The standing compression prompt and the ACP tool schemas split into
**load-bearing** text (the four `Prompts` rules — see `resolvePrompts`,
override requires `acknowledgeRisk`) and **surface** text (section headers,
guidance prose, tool descriptions, parameter descriptions). Surface text is
safe to customize freely; these helpers implement that:

- `applySectionOverrides(sections, overrides)` — tri-state per section:
  `string` replaces the section (header + body), `null` removes it, omitted
  keeps the default. Unknown keys are ignored.
- `buildCompressSystemPrompt` / `buildCompressTextSystemPrompt` /
  `buildCompressHybridSystemPrompt` accept an optional
  `CompressPromptSections` second argument (keys: `acpTags`, `tools`,
  `summariesInContext`, `textProtocol`, `textTools`, `functionTools`).
  With no sections argument the output is byte-identical to the
  pre-override release (regression-tested against fixtures).
- `cloneWithDescriptions(schema, paramDescriptions)` — returns a deep clone
  of a JSON tool schema with parameter `description` fields replaced by
  property name, at any nesting depth. The input is never mutated.
- `applyAcpToolOverrides(tools, overrides)` — applies per-tool `description`
  and `paramDescriptions` to any of the three wire shapes (anthropic
  `input_schema`, openai `function.parameters`, responses flat
  `parameters`). Shared tool constants are never mutated.

#### Prompt packs

Named, swappable surface configurations layered on top of the primitives above:

- `Pack` / `PackSurface` / `PackSource` / `PackResolver` — contracts. Sources are
  consulted in resolver order; first hit wins; sources must be per-turn safe
  (sync, no throw).
- `sanitizePackSurface(raw)` — turns a raw pack JSON into a sanitized
  `PackSurface`: tri-state for section keys (`string` replace / `null` remove /
  omitted keep), per-tool description + paramDescriptions. Malformed values are
  dropped. The opaque `adapters.<hostId>` record passes through for host-side
  validation.
- Builtins: `default` (identity) and `lean` (one-line tool descriptions;
  host-specific trims ride under `adapters.<hostId>` as data).
- `createDirPackSource(id, dir)` serves `<dir>/<name>.json` files;
  `defaultPackSources({ projectDir, userDirs })` assembles project > user >
  builtin. Directory paths are host policy.
- Pack *selection* (which name is active per config cascade) stays adapter-side;
  the kernel only resolves names.

### Nudge system

The nudge system tells the model *when* to compress. It implements:

- **Threshold gate**: fires when context usage ≥ `nudge.minContextLimitPct`.
- **Growth-gating**: a repeat nudge requires positive growth since the baseline (prevents re-firing every turn). `"strong"` force relaxes this.
- **Tier-distillation triggers**: when active tier-1 blocks pile up past `tiers.tier2Trigger`, emit a tier-2 distillation nudge; tier-3 analogously. Block COUNT is not a need signal, so the count path defaults OFF (`tier2Trigger: 1000`, `tier3Trigger: 2000`) — no usage gate: token-mass paths (≥1.5× growthFloor) and the T1 growth path are the need signal and fire ungated (#379, supersedes the #237/#238 usage band).
- **Compressible-range computation**: reports the actual compressible ranges (excluding covered + preserved-recent messages) so the model knows what to target.
- **Baseline reset on compress**: `applyCompression` clears the growth baseline on success, preventing the feedback-loop bug where the nudge re-fires post-compress.

### Tool-result crush gate

Deterministic first tier of the two-tier absorb gate. When a tool result qualifies as an absorb candidate and context pressure is on, the `crush` node (between `absorb-hide` and `absorb-prompt`) re-evaluates it **in view** with pure, deterministic strategies before the absorb-prompt decision runs:

- **skip** — below `absorb.minToolTokens` or under `absorb.contextThresholdPct`; bytes untouched.
- **crushed** — deterministic compression brought it under `minToolTokens`; no model round-trip. The wire carries the crushed payload (e.g. `__acp_crush` rows/identical-run envelopes for JSON, lossless — decodes back to an equal JSON document).
- **distill** — still over (or uncrushable); forwarded to the `[ACP absorb]` prompt path, carrying the crushed payload when crushing succeeded.

Built-in strategies form an ordered plugin registry (hosts can add/replace/disable via `registerCrushPlugin` / config):

| Strategy | Kind | Lossy | What it does |
|----------|------|-------|--------------|
| `json-fold` | json | no | constant-field hoisting + identical row/run collapse into annotated envelopes |
| `code-trim` | code | yes | comment/docstring elision behind a string-literal-aware scanner; template literals and assigned triple-quoted strings survive verbatim; unterminated constructs fail open |
| `log-select` | log | yes | level-classified line selection; **every distinct ERROR/FAIL line survives verbatim** (kernel-enforced invariant — output dropping one is rejected); warnings deduped, stack frames collapsed, honest `[N lines omitted]` footer |

Kernel-enforced guarantees: dispatch guards keep each payload kind on its own strategies; plugins must be pure and deterministic (same payload + config ⇒ same bytes, prefix-cache friendly); any throw, sub-`minReduction` result, or invariant violation fails open to the next candidate or pass-through. **Default off** (`crush.enabled: false`) and requires `absorb.enabled: true`; when disabled the pipeline is byte-identical to pre-crush behavior.

```json
"crush": {
  "enabled": false,
  "minReduction": 0.1,
  "strategies": {
    "json-fold": { "enabled": false },
    "code-trim": { "excludeTools": ["bash"] }
  }
}
```

## Wire codec (`acp-kernel/wire`)

The `acp-kernel/wire` subpath ships the provider wire-body codecs (lossless
round-trip via the `BiliMessage` sidecar): `anthropicToCore`/`coreToAnthropic`,
`openaiToCore`/`coreToOpenai`, `responsesToCore`/`coreToResponses`, plus
`deriveMessageId` (content-hash message identity), conversation signals and the
subagent-namespace helpers. `WIRE_FORMATS` / `detectWireFormat` classify a
request body by the codec that can parse it — `undefined` means the body is
unparseable and must be passed through untransformed. Adapters map their
host's model/API ids to formats and use `resolveTransformChannel` (with
`wireViable` = body parseable AND the host applies the payload replacement)
to decide between message-level and wire-level surgery.

## Status

✅ **Engine complete** — 23 source modules, full suite green (`npm test`), typecheck + build clean. 3-tier compression, growth-gated nudges, emergency truncation, fork-recovery, batch merge, composable node pipeline. Ready for adapter authoring.

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
