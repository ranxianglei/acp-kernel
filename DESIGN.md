# acp-kernel Design

Framework-agnostic, model-driven context-compression engine. This document is the authoritative contract for the pure core.

---

## 1. Mental Model

ACP-style compression is **not** like zip in one essential way: **the model writes the summaries; this library orchestrates everything around them.**

- **zip**: computes the compressed output itself (`bytes → bytes`).
- **acp-kernel**: the *summary text* is produced externally (by an LLM) and passed in as an argument. The core decides *when* to compress, *what range* to compress, tracks *state*, applies a compress *decision*, prunes ranges, and supports decompress/search. **It never calls a model.**

This is precisely why the core can be a pure library: the one external dependency (the summarizer) is reduced to a string input.

---

## 2. Module Boundary

```
┌───────────────────────────────────────────────────────┐
│  CORE (pure TS, zero host dependency, MIT)             │
│  stateless w.r.t. storage: state passed in and out      │
│                                                        │
│  processTurn / applyCompression / resolveBoundaries    │
│  decompress / search / status / decideNudge            │
│  (node pipeline: assign-refs → sync → merge → prune →  │
│   filter → hide → nudge → emergency-truncate → render) │
└──────────────────────┬────────────────────────────────┘
                       │ pure function calls
┌──────────────────────┴────────────────────────────────┐
│  ADAPTER (thin, host-specific) — one per host           │
│  OpenCode adapter | Pi adapter | custom                 │
│  - pass messages into the core each turn                │
│  - own + persist the state object                       │
│  - render NudgeDecision into host message format        │
│  - register tools / commands / lifecycle hooks          │
└───────────────────────────────────────────────────────┘
```

**The core holds no state and performs no I/O.** State is an explicit input and output of every call. The host decides how to persist it (filesystem, memory, whatever). This is the zip model: `zip(data) → data`.

---

## 3. Domain Types

Portable, host-agnostic. Adapters translate host-native messages into `CoreMessage[]` before calling the core, and apply the core's output back.

```ts
type CoreMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    contentType: "text" | "tool-call" | "tool-result" | "reasoning";
    text?: string;
    toolName?: string;      // for protected-tool filtering
    toolCallId?: string;    // links tool-call ↔ tool-result
};

type CompressionBlock = {
    blockId: string;                    // "b0", "b1", ...
    runId: string;
    tier: 1 | 2 | 3;
    topic?: string;
    summary: string;                    // produced by the model
    directMessageIds: string[];
    effectiveMessageIds: string[];
    directBlockIds: string[];           // nested blocks consumed
    createdAt: number;
    survivedCount: number;
    generation: "young" | "old";
    active: boolean;
};

type CompressionState = {
    blocks: CompressionBlock[];
    messageRefs: { byRaw: Record<string, string>; byRef: Record<string, string> }; // raw ↔ mNNNNN
    nudge: {
        lastPerMessageNudgeTokens: number;
        lastNudgeShownTokens: number;
        baselineTokens: number;
        anchors: Record<string, unknown>;
    };
    stats: { tokensCompressed: number; compressionCount: number };
    nextBlockId: number;
    nextRunId: number;
};

type Config = {
    tiers: { enabled: boolean; tier2Trigger: number; tier3Trigger: number };
    nudge: {
        maxContextLimitPct: number;   // e.g. 0.55 (currently advisory; threshold gate uses minContextLimitPct)
        minContextLimitPct: number;   // e.g. 0.45 — nudge threshold gate
        frequency: number;            // advisory (reserved for future turn-frequency gating)
        iterationThreshold: number;   // advisory (reserved for future iteration gating)
        force: "soft" | "strong";
    };
    // young→old promotion after N survivals (drives the merge-blocks node).
    // NOTE: there is no GC — no age-based deactivation, no summary truncation.
    promotionThreshold: number;
    truncate: { threshold: number };          // emergency tool-output truncation node (LAST safety valve); 1.0 = 100%
    merge: { maxSummaryLength: number; minOldGenBlocks: number }; // batch-merge old-gen blocks into one summary
    protectedTools: string[];
    preserveRecentMessages: number;
    modelContextLimit: number;
};
```

---

## 4. Core Operations

```ts
interface CompressionCore {
    // Per-turn node pipeline (replaces the message-transform hook's algorithm part).
    // Runs every turn (canonical order): assign-refs → sync-blocks → merge-blocks →
    // prune → filter → hide-compress-calls → nudge-inject → emergency-truncate →
    // render-refs. Survives/promotes blocks via advanceSurvival (no age-based
    // deactivation). Returns transformed messages + updated state + nudge decision.
    processTurn(input: {
        messages: CoreMessage[];
        state: CompressionState;
        config: Config;
        tokenCount: number;
    }): {
        messages: CoreMessage[];
        state: CompressionState;
        nudge?: NudgeDecision;
    };

    // When the model calls compress. `ranges[].summary` is model-produced text.
    // Allocates block(s), deactivates consumed blocks, updates indices, resets the
    // nudge growth baseline on success (§5.7 feedback-loop fix).
    applyCompression(input: {
        ranges: { startRef: string; endRef: string; summary: string; topic?: string }[];
        messages: CoreMessage[];
        state: CompressionState;
        config: Config;
    }): {
        state: CompressionState;
        result: { blocksCreated: number; tokensCompressed: number; errors: string[] };
    };

    resolveBoundaries(input: {
        startRef: string;
        endRef: string;
        messages: CoreMessage[];
        state: CompressionState;
    }): { startIndex: number; endIndex: number; protectedGaps: number[] };
    // protectedGaps is reserved (currently always []); protected-tool hard-exclusion
    // is intentionally NOT implemented in the core — see README "Known limitation".

    decompress(blockId: string, state: CompressionState): CompressionBlock | undefined;

    search(query: string, state: CompressionState): CompressionBlock[];

    status(state: CompressionState, tokenCount: number, config: Config): StatusReport;

    // No gc(): age-based deactivation was removed (it caused memory-loss upstream).
    // Block promotion (young→old) still happens via advanceSurvival in sync-blocks,
    // and old-gen blocks are batch-merged by the merge-blocks node — not dropped.
}

type CompressCall = {
    mode: "range" | "message";
    ranges: { startRef: string; endRef: string; summary: string; topic?: string }[];
};

type NudgeDecision = {
    shouldInject: boolean;
    reason: string;
    compressibleRanges: { startRef: string; endRef: string; tokens: number }[];
    contextUsage: number;       // 0..1
    tier: 1 | 2 | 3 | null;     // multi-tier trigger, if any
    breakdown: Record<string, number>;
};
```

---

## 5. Port Surface (host implements)

The core needs two capabilities from the host, both injected (the core never imports a host SDK):

```ts
interface Ports {
    countTokens(text: string): number;   // default impl ships in core
    // messages are PASSED IN to each call (never fetched) → no MessageStore port
    // state persistence is the host's job (state is plain data) → no storage port
}
```

A default `countTokens` ships with the core (word-level + unicode CJK tokenizer, the same MIT `cc-alg` tokenizer). Hosts may override with a model-specific tokenizer.

---

## 6. Concept Mapping (nothing is lost)

| ACP concept | Destination in acp-kernel |
|---|---|
| message-id ↔ ref mapping | **core** `processTurn` (pure) |
| prune (range → summary block) | **core** `processTurn` (pure) |
| boundary resolution / search | **core** `resolveBoundaries` (pure) |
| block allocation / state mutation / tiers | **core** `applyCompression` (pure) |
| compress **argument parsing** (lenient: fences, trailing commas, truncated-array salvage; field-name variants) | **core** `parseCompressArgs` (pure; diagnostics are data — adapters emit them) |
| young→old promotion / batch merge | **core** `sync-blocks` node (`advanceSurvival`) + `merge-blocks` node (pure) |
| emergency truncation (context near full) | **core** `emergency-truncate` node — the LAST safety valve; no age-based GC |
| protected-tools filtering logic | **core** (pure: message + config → bool) |
| `inject` **decision** (shouldNudge / growth / threshold) | **core** `decideNudge` (pure) |
| `inject` **text rendering** (nudge → message string) | **adapter** (host message format) |
| prompts (system / nudge text templates) | rules as **structured data** in core; text rendering in **adapter** |
| compress/decompress/search/status **tool registration** | **adapter** (calls core pure fns) |
| `/acp` commands | **adapter** |
| opencode hooks | **OpenCode adapter** |
| config three-layer merge | **adapter** (core only consumes its own `Config`) |
| logger / auth / persistence / update | **adapter** (core does zero I/O) |

---

## 7. Why the algorithm, but not the DCP-derived code, comes here

Copyright protects *expression*, not ideas, methods, or algorithms (17 USC §102(b)). The compression *methods* (3-tier, growth cadence, protected filtering) are the author's. This core reimplements them in **fresh expression** — it is not a copy or refactor of DCP-derived files. See [PROVENANCE.md](./PROVENANCE.md) for the per-module origin classification (original-bring / DCP-derived-reimplement / adapter-only).
