import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
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

function withRefs(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

function makeT1(
  core: ReturnType<typeof createCore>,
  state: ReturnType<typeof createInitialState>,
  messages: CoreMessage[],
  startRef: string,
  endRef: string,
  summary: string,
) {
  const res = core.applyCompression({
    ranges: [{ startRef, endRef, summary }],
    messages,
    state,
    config: config(),
  });
  return { state: res.state, block: res.state.blocks.at(-1)! };
}

function activeCoverage(state: ReturnType<typeof createInitialState>): Set<string> {
  const covered = new Set<string>();
  for (const blk of state.blocks) {
    if (blk.active) for (const id of blk.effectiveMessageIds) covered.add(id);
  }
  return covered;
}

test("blockIds distills non-contiguous T1 blocks into one T2 block; intervening raw messages stay visible", () => {
  const core = createCore();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma-middle"),
    msg("d", "delta"),
    msg("e", "epsilon"),
  ];
  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "ab");
  state = r1.state;
  const b1 = r1.block;
  const r2 = makeT1(core, state, messages, "m00004", "m00005", "de");
  state = r2.state;
  const b2 = r2.block;
  assert.equal(b1.tier, 1);
  assert.equal(b2.tier, 1);

  const result = core.applyCompression({
    ranges: [
      {
        blockIds: [b1.blockId, b2.blockId],
        summary: "distilled T2 of b1+b2",
        topic: "t2",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  const t2 = result.state.blocks.find((b) => b.tier === 2 && b.active)!;
  assert.equal(t2.active, true);
  assert.deepEqual(
    t2.directBlockIds.sort(),
    [b1.blockId, b2.blockId].sort(),
  );
  assert.deepEqual(t2.effectiveMessageIds.sort(), ["a", "b", "d", "e"]);
  assert.equal(
    result.state.blocks.find((b) => b.blockId === b1.blockId)!.active,
    false,
  );
  assert.equal(
    result.state.blocks.find((b) => b.blockId === b2.blockId)!.active,
    false,
  );
  assert.equal(activeCoverage(result.state).has("c"), false);
});

test("blockIds distills T2 blocks into T3", () => {
  const core = createCore();
  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c"),
    msg("d", "d"),
    msg("e", "e"),
    msg("f", "f"),
    msg("g", "g"),
    msg("h", "h"),
  ];
  let state = withRefs(messages);
  const t1a = makeT1(core, state, messages, "m00001", "m00002", "t1a");
  state = t1a.state;
  const t1b = makeT1(core, state, messages, "m00003", "m00004", "t1b");
  state = t1b.state;
  const t1c = makeT1(core, state, messages, "m00005", "m00006", "t1c");
  state = t1c.state;
  const t1d = makeT1(core, state, messages, "m00007", "m00008", "t1d");
  state = t1d.state;

  const t2x = core.applyCompression({
    ranges: [{ blockIds: [t1a.block.blockId, t1b.block.blockId], summary: "t2x" }],
    messages,
    state,
    config: config(),
  });
  state = t2x.state;
  const t2y = core.applyCompression({
    ranges: [{ blockIds: [t1c.block.blockId, t1d.block.blockId], summary: "t2y" }],
    messages,
    state,
    config: config(),
  });
  state = t2y.state;
  const bT2x = state.blocks.find((b) => b.summary === "t2x")!;
  const bT2y = state.blocks.find((b) => b.summary === "t2y")!;
  assert.equal(bT2x.tier, 2);
  assert.equal(bT2y.tier, 2);

  const result = core.applyCompression({
    ranges: [{ blockIds: [bT2x.blockId, bT2y.blockId], summary: "t3" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  const t3 = result.state.blocks.find((b) => b.tier === 3 && b.active)!;
  assert.deepEqual(
    t3.directBlockIds.sort(),
    [bT2x.blockId, bT2y.blockId].sort(),
  );
  assert.equal(
    result.state.blocks.find((b) => b.blockId === bT2x.blockId)!.active,
    false,
  );
});

test("blockIds takes precedence over startRef/endRef when both are provided", () => {
  const core = createCore();
  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c"),
    msg("d", "d"),
    msg("e", "e"),
  ];
  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "b1");
  state = r1.state;
  const b1 = r1.block;
  const r2 = makeT1(core, state, messages, "m00004", "m00005", "b2");
  state = r2.state;
  const b2 = r2.block;

  const result = core.applyCompression({
    ranges: [
      {
        blockIds: [b1.blockId, b2.blockId],
        startRef: "m00003",
        endRef: "m00003",
        summary: "prec",
      },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  const t2 = result.state.blocks.find((b) => b.tier === 2 && b.active)!;
  assert.deepEqual(t2.effectiveMessageIds.sort(), ["a", "b", "d", "e"]);
});

test("blockIds can batch with a non-overlapping message range", () => {
  const core = createCore();
  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c"),
    msg("d", "d"),
    msg("e", "e"),
    msg("f", "f"),
  ];
  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "b1");
  state = r1.state;
  const b1 = r1.block;

  const result = core.applyCompression({
    ranges: [
      { blockIds: [b1.blockId], summary: "t2 from b1" },
      { startRef: "m00005", endRef: "m00006", summary: "ef range" },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 2);
  assert.equal(result.result.errors.length, 0);
});

test("blockIds batch: two ranges sharing a block are rejected as overlapping", () => {
  const core = createCore();
  const messages = [msg("a", "a"), msg("b", "b"), msg("c", "c"), msg("d", "d")];
  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "b1");
  state = r1.state;
  const b1 = r1.block;
  const r2 = makeT1(core, state, messages, "m00003", "m00004", "b2");
  state = r2.state;
  const b2 = r2.block;

  const result = core.applyCompression({
    ranges: [
      { blockIds: [b1.blockId], summary: "r1" },
      { blockIds: [b1.blockId, b2.blockId], summary: "r2" },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors[0]!.includes("overlaps"));
});

test("blockIds error: invalid block id format", () => {
  const core = createCore();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  const state = withRefs(messages);
  const result = core.applyCompression({
    ranges: [{ blockIds: ["m00001"], summary: "x" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors[0]!.includes("not a valid block id"));
});

test("blockIds error: nonexistent block", () => {
  const core = createCore();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  const state = withRefs(messages);
  const result = core.applyCompression({
    ranges: [{ blockIds: ["b99"], summary: "x" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors[0]!.includes("does not exist"));
});

test("blockIds error: inactive (already-consumed) block", () => {
  const core = createCore();
  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c"),
    msg("d", "d"),
  ];
  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "b1");
  state = r1.state;
  const b1 = r1.block;
  const r2 = makeT1(core, state, messages, "m00003", "m00004", "b2");
  state = r2.state;
  const b2 = r2.block;

  state = core.applyCompression({
    ranges: [{ blockIds: [b1.blockId, b2.blockId], summary: "t2" }],
    messages,
    state,
    config: config(),
  }).state;
  assert.equal(
    state.blocks.find((b) => b.blockId === b1.blockId)!.active,
    false,
  );

  const result = core.applyCompression({
    ranges: [{ blockIds: [b1.blockId], summary: "again" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors[0]!.includes("not active"));
});

test("blockIds error: mixed tiers rejected", () => {
  const core = createCore();
  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c"),
    msg("d", "d"),
    msg("e", "e"),
    msg("f", "f"),
    msg("g", "g"),
    msg("h", "h"),
  ];
  let state = withRefs(messages);
  const t1a = makeT1(core, state, messages, "m00001", "m00002", "t1a");
  state = t1a.state;
  const t1b = makeT1(core, state, messages, "m00003", "m00004", "t1b");
  state = t1b.state;
  const t1c = makeT1(core, state, messages, "m00005", "m00006", "t1c");
  state = t1c.state;
  const t1d = makeT1(core, state, messages, "m00007", "m00008", "t1d");
  state = t1d.state;

  const t2cd = core.applyCompression({
    ranges: [{ blockIds: [t1c.block.blockId, t1d.block.blockId], summary: "t2cd" }],
    messages,
    state,
    config: config(),
  });
  state = t2cd.state;
  const bT2cd = state.blocks.find((b) => b.summary === "t2cd")!;
  assert.equal(bT2cd.tier, 2);

  const result = core.applyCompression({
    ranges: [
      { blockIds: [t1a.block.blockId, bT2cd.blockId], summary: "mix" },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors[0]!.includes("same tier"));
});

test("blockIds distills T3 blocks and outputTier caps at 3 (never tier 4)", () => {
  const core = createCore();
  const messages = Array.from({ length: 16 }, (_, i) =>
    msg(String.fromCharCode("a".charCodeAt(0) + i), `m${i}`),
  );
  let state = withRefs(messages);

  const t1blocks: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    const startRef = `m${String(i + 1).padStart(5, "0")}`;
    const endRef = `m${String(i + 2).padStart(5, "0")}`;
    const res = makeT1(core, state, messages, startRef, endRef, `t1-${i}`);
    state = res.state;
    t1blocks.push(res.block.blockId);
  }
  assert.equal(t1blocks.length, 8);

  const t2blocks: string[] = [];
  for (let i = 0; i < 8; i += 2) {
    const res = core.applyCompression({
      ranges: [{ blockIds: [t1blocks[i]!, t1blocks[i + 1]!], summary: `t2-${i}` }],
      messages,
      state,
      config: config(),
    });
    state = res.state;
    assert.equal(res.result.errors.length, 0);
    t2blocks.push(state.blocks.at(-1)!.blockId);
  }
  assert.equal(t2blocks.length, 4);
  for (const id of t2blocks) {
    assert.equal(state.blocks.find((b) => b.blockId === id)!.tier, 2);
  }

  const t3a = core.applyCompression({
    ranges: [{ blockIds: [t2blocks[0]!, t2blocks[1]!], summary: "t3a" }],
    messages,
    state,
    config: config(),
  });
  state = t3a.state;
  const t3b = core.applyCompression({
    ranges: [{ blockIds: [t2blocks[2]!, t2blocks[3]!], summary: "t3b" }],
    messages,
    state,
    config: config(),
  });
  state = t3b.state;
  const bT3a = state.blocks.find((b) => b.summary === "t3a")!;
  const bT3b = state.blocks.find((b) => b.summary === "t3b")!;
  assert.equal(bT3a.tier, 3);
  assert.equal(bT3b.tier, 3);

  const result = core.applyCompression({
    ranges: [{ blockIds: [bT3a.blockId, bT3b.blockId], summary: "t3-capped" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  const t3c = result.state.blocks.at(-1)!;
  assert.equal(t3c.tier, 3);
  assert.deepEqual(
    t3c.directBlockIds.sort(),
    [bT3a.blockId, bT3b.blockId].sort(),
  );
  assert.equal(
    result.state.blocks.find((b) => b.blockId === bT3a.blockId)!.active,
    false,
  );
  assert.equal(
    result.state.blocks.find((b) => b.blockId === bT3b.blockId)!.active,
    false,
  );
  assert.equal(t3c.active, true);
});

test("blockIds range overlaps a message range in the same batch is rejected", () => {
  const core = createCore();
  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c"),
    msg("d", "d"),
  ];
  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "b1");
  state = r1.state;
  const b1 = r1.block;

  const result = core.applyCompression({
    ranges: [
      { blockIds: [b1.blockId], summary: "t2 from b1" },
      { startRef: "m00002", endRef: "m00003", summary: "bc overlap" },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors.length > 0);
  assert.ok(result.result.errors[0]!.includes("overlaps"));
});

test("empty blockIds array falls through to startRef/endRef and errors when absent", () => {
  const core = createCore();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  const state = withRefs(messages);

  const result = core.applyCompression({
    ranges: [{ blockIds: [], summary: "x" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.ok(result.result.errors.length > 0);
  assert.ok(result.result.errors[0]!.includes("Invalid boundary ref"));
});

test("blockIds distillation leaves an intervening ACTIVE block active and unconsumed", () => {
  const core = createCore();
  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c-gap"),
    msg("d", "d"),
    msg("e", "e"),
  ];
  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "b1");
  state = r1.state;
  const b1 = r1.block;
  const rGap = makeT1(core, state, messages, "m00003", "m00003", "bGap");
  state = rGap.state;
  const bGap = rGap.block;
  const r2 = makeT1(core, state, messages, "m00004", "m00005", "b2");
  state = r2.state;
  const b2 = r2.block;
  assert.deepEqual(bGap.effectiveMessageIds, ["c"]);

  const result = core.applyCompression({
    ranges: [{ blockIds: [b1.blockId, b2.blockId], summary: "t2 of b1+b2" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);

  const t2 = result.state.blocks.find((b) => b.tier === 2 && b.active)!;
  assert.deepEqual(t2.effectiveMessageIds.sort(), ["a", "b", "d", "e"]);
  assert.ok(!t2.effectiveMessageIds.includes("c"));

  const gapAfter = result.state.blocks.find((b) => b.blockId === bGap.blockId)!;
  assert.equal(gapAfter.active, true);
  assert.deepEqual(gapAfter.effectiveMessageIds, ["c"]);
  assert.equal(
    result.state.blocks.find((b) => b.blockId === b1.blockId)!.active,
    false,
  );
  assert.equal(
    result.state.blocks.find((b) => b.blockId === b2.blockId)!.active,
    false,
  );
  assert.ok(activeCoverage(result.state).has("c"));
});

test("blockIds bypasses compress.minCompressRange floor while a message-only range is blocked by it", () => {
  const core = createCore();
  const bigFloor = config({
    compress: { minCompressRange: 1e9, maxSummaryLength: 0, minSummaryLength: 0 },
  });

  const messages = [
    msg("a", "a"),
    msg("b", "b"),
    msg("c", "c"),
    msg("d", "d"),
  ];

  let state = withRefs(messages);
  const r1 = makeT1(core, state, messages, "m00001", "m00002", "b1");
  state = r1.state;
  const b1 = r1.block;
  const r2 = makeT1(core, state, messages, "m00003", "m00004", "b2");
  state = r2.state;
  const b2 = r2.block;

  const blockResult = core.applyCompression({
    ranges: [{ blockIds: [b1.blockId, b2.blockId], summary: "t2 bypasses floor" }],
    messages,
    state,
    config: bigFloor,
  });
  assert.equal(blockResult.result.blocksCreated, 1);
  assert.equal(blockResult.result.errors.length, 0);
  assert.equal(
    blockResult.state.blocks.find((b) => b.tier === 2 && b.active)!.summary,
    "t2 bypasses floor",
  );

  const freshState = withRefs(messages);
  const msgResult = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "ab tiny" }],
    messages,
    state: freshState,
    config: bigFloor,
  });
  assert.equal(msgResult.result.blocksCreated, 0);
  assert.ok(msgResult.result.errors.length > 0);
  assert.ok(msgResult.result.errors[0]!.includes("too small"));
});
