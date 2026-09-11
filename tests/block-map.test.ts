import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBlockSpan,
  activeBlockSpans,
  formatCreatedBlocks,
} from "../src/block-map.js";
import {
  buildCompressibleRanges,
  mergeRangesToThreshold,
} from "../src/recommend.js";
import { computeProtectedRefs } from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type {
  CompressionBlock,
  Config,
  CoreMessage,
  CompressibleRange,
} from "../src/types.js";
import { defaultCountTokens } from "../src/tokenize.js";

function config(): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  };
}

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text };
}

function makeState(ids: string[]): ReturnType<typeof createInitialState> {
  const state = createInitialState();
  state.messageRefs = assignRefs(
    ids.map((id) => msg(id, "x")),
    { existing: state.messageRefs, nextIndex: 1 },
  ).map;
  return state;
}

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

// ─── resolveBlockSpan ─────────────────────────────────────────────────────────

test("resolveBlockSpan prefers stored startRef/endRef", () => {
  const block = makeBlock({
    effectiveMessageIds: ["a", "b"],
    startRef: "m00010",
    endRef: "m00020",
  });
  assert.deepEqual(resolveBlockSpan(block, {}), {
    startRef: "m00010",
    endRef: "m00020",
  });
});

test("resolveBlockSpan falls back to effectiveMessageIds when stored refs missing", () => {
  const byRaw: Record<string, string> = {
    a: "m00044",
    b: "m00001",
    c: "m00030",
  };
  const block = makeBlock({ effectiveMessageIds: ["a", "b", "c"] });
  assert.deepEqual(resolveBlockSpan(block, byRaw), {
    startRef: "m00001",
    endRef: "m00044",
  });
});

test("resolveBlockSpan sorts numerically, not lexicographically", () => {
  const byRaw: Record<string, string> = {
    a: "m00009",
    b: "m000100",
  };
  const block = makeBlock({ effectiveMessageIds: ["a", "b"] });
  assert.deepEqual(resolveBlockSpan(block, byRaw), {
    startRef: "m00009",
    endRef: "m000100",
  });
});

test("resolveBlockSpan returns null when nothing resolves", () => {
  const block = makeBlock({ effectiveMessageIds: ["gone"] });
  assert.equal(resolveBlockSpan(block, {}), null);
});

// ─── activeBlockSpans ─────────────────────────────────────────────────────────

test("activeBlockSpans skips inactive and unresolvable blocks, keeps order", () => {
  const state = makeState(["a", "b"]);
  state.blocks = [
    makeBlock({ blockId: "b1", effectiveMessageIds: ["a"], startRef: "m00001", endRef: "m00001" }),
    makeBlock({ blockId: "b2", active: false, startRef: "m00002", endRef: "m00002" }),
    makeBlock({ blockId: "b3", effectiveMessageIds: ["vanished"], tier: 2 }),
  ];
  const spans = activeBlockSpans(state);
  assert.deepEqual(
    spans.map((s) => s.blockId),
    ["b1"],
  );
});

// ─── formatCreatedBlocks ──────────────────────────────────────────────────────

test("formatCreatedBlocks formats id=span per block", () => {
  const state = makeState([]);
  state.blocks = [
    makeBlock({ blockId: "b3", startRef: "m00044", endRef: "m00097" }),
    makeBlock({ blockId: "b4", startRef: "m00103", endRef: "m00123" }),
  ];
  assert.equal(
    formatCreatedBlocks(state, [state.blocks[0]!, state.blocks[1]!]),
    "blocks: b3=m00044–m00097, b4=m00103–m00123",
  );
});

test("formatCreatedBlocks falls back to bare id when span unresolvable", () => {
  const state = makeState([]);
  const block = makeBlock({ blockId: "b5", effectiveMessageIds: ["gone"] });
  assert.equal(formatCreatedBlocks(state, [block]), "blocks: b5");
});

test("formatCreatedBlocks returns empty string for no blocks", () => {
  assert.equal(formatCreatedBlocks(makeState([]), []), "");
});

// ─── userMsgs tracking ────────────────────────────────────────────────────────

test("buildCompressibleRanges counts user messages per range", () => {
  const messages = [
    msg("u1", "first user request"),
    msg("a1", "assistant reply", "assistant"),
    msg("u2", "second user request"),
    msg("a2", "more assistant", "assistant"),
  ];
  const state = makeState(messages.map((m) => m.id));
  const cfg = config();
  const protectedRefs = computeProtectedRefs(messages, state, cfg, defaultCountTokens);
  const ranges = buildCompressibleRanges(
    messages,
    state,
    cfg,
    protectedRefs,
    defaultCountTokens,
  ).compressible;
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.userMsgs, 2);
});

test("mergeRangesToThreshold sums userMsgs across merged ranges", () => {
  const base = { count: 2, chars: 100, toolPct: 50, textPct: 50, tokens: 500 };
  const ranges: CompressibleRange[] = [
    { startRef: "m00001", endRef: "m00002", userMsgs: 1, ...base },
    { startRef: "m00003", endRef: "m00004", userMsgs: 2, ...base },
    { startRef: "m00005", endRef: "m00006", ...base },
  ];
  const merged = mergeRangesToThreshold(ranges, 1000);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.startRef, "m00001");
  assert.equal(merged[0]!.endRef, "m00006");
  assert.equal(merged[0]!.userMsgs, 3);
});
