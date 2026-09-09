import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import {
  resolveBoundaries,
  visibleBlockAnchor,
  blockVisibleInRange,
} from "../src/boundaries.js";
import {
  findBlocksOverlappingMessages,
  buildRestoredContentPreview,
  collectBlockContent,
} from "../src/decompress.js";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
} from "../src/recommend.js";
import { buildStatusReport } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type {
  CompressionBlock,
  CompressionState,
  Config,
  CoreMessage,
} from "../src/types.js";

// #234: exact-id membership between block.effectiveMessageIds (or ref-map ids)
// and current-view ids must normalize to the base id, so coverage survives a
// projection-form change (base vs base#sub). Every test here fails on the
// pre-fix exact-match code.

function msg(
  id: string,
  text?: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text: text ?? id };
}

function summaryMsg(blockId: string, summary: string): CoreMessage {
  return {
    id: `acp_summary_${blockId}`,
    role: "system",
    contentType: "text",
    text: `[Compressed conversation section]\n${summary}`,
  };
}

function makeBlock(
  overrides: Partial<CompressionBlock> & { blockId: string },
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function assignAll(
  messages: CoreMessage[],
  state: CompressionState = createInitialState(),
): CompressionState {
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

// ─── recommend.ts: isSyntheticOrPruned ────────────────────────────────────────

test("buildCompressibleRanges skips a sub-id view of a base-id block (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }));
  const messages = [msg("h_pre"), msg("h_abc#r0"), msg("h_post")];
  assignAll(messages, state);
  const ranges = buildCompressibleRanges(messages, state, config());
  // Covered m00002 must split the range — it must not sit inside a span.
  assert.deepEqual(
    ranges.compressible.map((r) => [r.startRef, r.endRef]),
    [
      ["m00001", "m00001"],
      ["m00003", "m00003"],
    ],
  );
});

test("buildCompressibleRanges skips a base view of a sub-id block (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }));
  const messages = [msg("h_pre"), msg("h_abc"), msg("h_post")];
  assignAll(messages, state);
  const ranges = buildCompressibleRanges(messages, state, config());
  assert.deepEqual(
    ranges.compressible.map((r) => [r.startRef, r.endRef]),
    [
      ["m00001", "m00001"],
      ["m00003", "m00003"],
    ],
  );
});

test("buildCompressibleRanges keeps a distinct id that extends a covered base (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }));
  const messages = [msg("h_abcde"), msg("h_post")];
  assignAll(messages, state);
  const ranges = buildCompressibleRanges(messages, state, config());
  const refs = ranges.compressible.flatMap((r) => [r.startRef, r.endRef]);
  assert.ok(refs.includes("m00001"), "h_abcde is not covered by base h_abc");
});

test("computeProtectedRefs ignores covered messages re-projected under sub-ids (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_a"] }));
  const messages = [msg("h_a#r0"), msg("h_b")];
  assignAll(messages, state);
  const refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 5 }),
  );
  assert.ok(refs.has("m00002"));
  assert.ok(!refs.has("m00001"), "covered message must not occupy a recent-window slot");
});

// ─── decompress.ts: findBlocksOverlappingMessages ─────────────────────────────

test("findBlocksOverlappingMessages matches a base-id block against sub-id view ids (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }));
  const matched = findBlocksOverlappingMessages(state, new Set(["h_abc#r0"]));
  assert.deepEqual(matched.map((b) => b.blockId), ["b1"]);
});

test("findBlocksOverlappingMessages matches a sub-id block against a base view id (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }));
  const matched = findBlocksOverlappingMessages(state, new Set(["h_abc"]));
  assert.deepEqual(matched.map((b) => b.blockId), ["b1"]);
});

test("findBlocksOverlappingMessages does not match a distinct id extending the base (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }));
  const matched = findBlocksOverlappingMessages(state, new Set(["h_abcde"]));
  assert.deepEqual(matched, []);
});

// ─── decompress.ts: buildRestoredContentPreview ───────────────────────────────

test("buildRestoredContentPreview keeps a still-covered message out (base block, sub-id view) (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }));
  const messages = [msg("h_abc#r0", "restored?"), msg("h_post", "new content")];
  const result = buildRestoredContentPreview(
    messages,
    new Set(["h_abc#r0", "h_post"]),
    state,
  );
  assert.equal(result.restoredCount, 1);
  assert.ok(result.preview.includes("new content"));
  assert.ok(!result.preview.includes("restored?"));
});

test("buildRestoredContentPreview keeps a still-covered message out (sub-id block, base view) (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }));
  const messages = [msg("h_abc", "restored?"), msg("h_post", "new content")];
  const result = buildRestoredContentPreview(
    messages,
    new Set(["h_abc", "h_post"]),
    state,
  );
  assert.equal(result.restoredCount, 1);
  assert.ok(!result.preview.includes("restored?"));
});

// ─── decompress.ts: collectBlockContent ───────────────────────────────────────

test("collectBlockContent collects sub-id view messages of a base-id block (#234)", () => {
  const state = createInitialState();
  const block = makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] });
  state.blocks.push(block);
  const messages = [msg("h_abc#r0", "the content")];
  const result = collectBlockContent(state, block, messages, { full: true });
  assert.equal(result.count, 1);
  assert.ok(result.text.includes("the content"));
});

test("collectBlockContent folds nested children across forms (#234)", () => {
  const state = createInitialState();
  const parent = makeBlock({
    blockId: "b1",
    effectiveMessageIds: ["h_a", "h_b"],
    directBlockIds: ["b2"],
  });
  const child = makeBlock({
    blockId: "b2",
    effectiveMessageIds: ["h_b#r0"],
    summary: "child summary",
  });
  state.blocks.push(parent, child);
  const messages = [msg("h_a#r0", "a content"), msg("h_b#r0", "b content")];
  const result = collectBlockContent(state, parent, messages);
  assert.ok(result.text.includes("a content"), "direct message rendered in full");
  assert.ok(!result.text.includes("b content"), "nested-covered message stays folded");
  assert.ok(result.text.includes("child summary"), "nested summary rendered in place");
  assert.equal(result.count, 2, "1 direct message + 1 nested summary");
});

// ─── compress.ts: danglingMessageRefs ─────────────────────────────────────────

test("dangling-ref report recognizes cross-form coverage as already-compressed (#234)", () => {
  const core = createCore();
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }));
  // Ref map holds the older base form; the view is pruned (summary only).
  state.messageRefs.byRaw = { "h_abc": "m00001" };
  state.messageRefs.byRef = { m00001: "h_abc" };
  const messages = [summaryMsg("b1", "subid summary")];
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00001", summary: "retry" }],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 1000, maxSummaryLength: 0, minSummaryLength: 0 },
    }),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors.length > 0);
  assert.ok(
    result.result.errors[0]!.includes("already compressed"),
    `expected already-compressed guidance, got: ${result.result.errors[0]}`,
  );
  assert.ok(
    !result.result.errors[0]!.includes("cannot be anchored"),
    "cross-form coverage must not be reported as a dangling ref",
  );
});

// ─── compress.ts: collectCoverage / preExistingCoverage (livelock guard) ──────

test("livelock guard fires when a range is fully covered across forms (#234)", () => {
  const core = createCore();
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }));
  const messages = [msg("h_abc#r0", "already compressed content"), msg("h_post", "post")];
  assignAll(messages, state);
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00001", summary: "fake" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0, "no empty same-tier rewrite");
  assert.ok(result.result.errors.length > 0);
  assert.ok(
    result.result.errors[0]!.includes("no new compressible messages"),
    `expected livelock-guard error, got: ${result.result.errors[0]}`,
  );
});

// ─── boundaries.ts: activeOwnerAnchor (inherited.has) ─────────────────────────

test("message ref snaps to the inheriting block across projection forms (#234)", () => {
  const state = createInitialState();
  const b1 = makeBlock({
    blockId: "b1",
    effectiveMessageIds: ["h_a"],
    active: false,
  });
  const b2 = makeBlock({
    blockId: "b2",
    tier: 2,
    effectiveMessageIds: ["h_a", "h_b"],
    directBlockIds: ["b1"],
  });
  state.blocks.push(b1, b2);
  // Ref map holds the sub-id form recorded under an older projection.
  state.messageRefs.byRaw = { "h_a#call1": "m00001" };
  state.messageRefs.byRef = { m00001: "h_a#call1" };
  const messages = [summaryMsg("b2", "tier2 summary")];
  const resolved = resolveBoundaries({
    startRef: "m00001",
    endRef: "m00001",
    messages,
    state,
  });
  assert.equal(resolved.startIndex, 0);
  assert.equal(resolved.endIndex, 0);
  assert.equal(
    resolved.snappedBoundaries.length,
    2,
    "both endpoints snap to the active ancestor",
  );
});

// ─── boundaries.ts: visibleBlockAnchor / blockVisibleInRange ──────────────────

test("visibleBlockAnchor resolves a base-id block against a sub-id view (#234)", () => {
  const block = makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] });
  const indexByMessageId = new Map<string, number>([["h_abc#r0", 1]]);
  assert.equal(visibleBlockAnchor(block, indexByMessageId), 1);
  const baseIndexById = new Map<string, number>([["h_abc", 1]]);
  assert.equal(visibleBlockAnchor(block, indexByMessageId, baseIndexById), 1);
});

test("blockVisibleInRange detects a block whose recorded form differs from the view (#234)", () => {
  const block = makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] });
  const indexByMessageId = new Map<string, number>([["h_abc#r0", 1]]);
  assert.equal(blockVisibleInRange(block, indexByMessageId, 0, 2), true);
  assert.equal(blockVisibleInRange(block, indexByMessageId, 2, 3), false);
});

test("block-boundary anchor resolves a base-id block over a sub-id view (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_a", "h_b"] }));
  const messages = [msg("h_a#r0"), msg("h_b#r0")];
  const resolved = resolveBoundaries({
    startRef: "b1",
    endRef: "b1",
    messages,
    state,
  });
  assert.equal(resolved.startIndex, 0);
  assert.equal(resolved.endIndex, 0);
  assert.deepEqual(resolved.nestedBlockIds, ["b1"]);
});

// ─── boundaries.ts: message-ref exact lookup with base fallback ───────────────

test("message ref in the older projection form still anchors to the visible message (#234)", () => {
  const state = createInitialState();
  state.messageRefs.byRaw = { "h_a": "m00001" };
  state.messageRefs.byRef = { m00001: "h_a" };
  const messages = [msg("h_a#r0")];
  const resolved = resolveBoundaries({
    startRef: "m00001",
    endRef: "m00001",
    messages,
    state,
  });
  assert.equal(resolved.startIndex, 0);
  assert.deepEqual(resolved.snappedBoundaries, [], "no snap — the message is visible");
});

// ─── report.ts: collectVisible ────────────────────────────────────────────────

test("status report excludes a covered message re-projected under sub-ids (#234)", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }));
  const messages = [msg("h_abc#r0"), msg("h_post")];
  assignAll(messages, state);
  const report = buildStatusReport(state, messages, (t) => Math.ceil(t.length / 4), {
    scope: "uncompressed",
    view: "messages",
  });
  assert.ok(report.includes("m00002"), "uncovered message stays listed");
  assert.ok(!report.includes("m00001"), "covered message must not be listed");
});
