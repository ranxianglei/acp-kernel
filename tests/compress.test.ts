import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { resolveBoundaries, BoundaryNotFoundError } from "../src/boundaries.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
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

test("applyCompression creates a T1 block covering the resolved range", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "a and b summarized",
        topic: "intro",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  assert.equal(result.state.blocks.length, 1);
  const block = result.state.blocks[0]!;
  assert.equal(block.tier, 1);
  assert.equal(block.active, true);
  assert.equal(block.topic, "intro");
  assert.deepEqual(block.effectiveMessageIds.sort(), ["a", "b"]);
  assert.deepEqual(block.directMessageIds.sort(), ["a", "b"]);
  assert.ok(result.result.tokensCompressed > 0);
});

test("prune after applyCompression removes covered messages and injects summary", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });

  const pruned = prune(messages, after);
  assert.deepEqual(
    pruned.map((m) => m.id),
    ["u", "acp_summary_b1", "c", "d"],
  );
  assert.ok(pruned[1]!.text!.includes("intro recap"));
});

test("applyCompression auto-swaps reversed boundaries", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x"), msg("b", "y"), msg("c", "z")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00001", summary: "swapped" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.deepEqual(result.state.blocks[0]!.effectiveMessageIds.sort(), [
    "a",
    "b",
    "c",
  ]);
});

test("block-boundary compression produces T2 and consumes matching T1 blocks", () => {
  const core = createCore();
  let state = createInitialState();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
    msg("e", "epsilon"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const t1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "t1 block a-b" }],
    messages,
    state,
    config: config(),
  });
  state = t1.state;

  const t2 = core.applyCompression({
    ranges: [
      { startRef: "b1", endRef: "b1", summary: "t2 distillation of b1" },
    ],
    messages,
    state,
    config: config(),
  });

  const block = t2.state.blocks[1]!;
  assert.equal(block.tier, 2);
  assert.equal(block.blockId, "b2");
  const consumed = t2.state.blocks[0]!;
  assert.equal(consumed.active, false);
  assert.deepEqual(block.effectiveMessageIds.sort(), ["a", "b"]);
});

test("processTurn assigns refs, prunes, and returns nudge decision", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "hello world"), msg("b", "second message")];

  const result = core.processTurn({
    messages,
    state,
    config: config(),
    tokenCount: 50000,
  });

  assert.equal(result.state.messageRefs.byRaw["a"], "m00001");
  assert.equal(result.state.messageRefs.byRaw["b"], "m00002");
  assert.equal(result.messages.length, 2);
  assert.ok(result.nudge, "nudge decision returned");
  assert.ok(result.nudge!.contextUsage > 0);
});

test("search returns active blocks matching the query, ranked", () => {
  const core = createCore();
  const state = createInitialState();
  state.blocks.push(
    {
      blockId: "b1",
      runId: "r1",
      tier: 1,
      topic: "auth login",
      summary: "token refresh flow",
      directMessageIds: [],
      effectiveMessageIds: [],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
    {
      blockId: "b2",
      runId: "r1",
      tier: 1,
      topic: "deployment",
      summary: "docker compose",
      directMessageIds: [],
      effectiveMessageIds: [],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
  );

  const hits = core.search("auth token", state);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.blockId, "b1");
});

test("GC is fully removed: createCore() exposes no gc method", () => {
  const core = createCore() as unknown as Record<string, unknown>;
  assert.equal(core["gc"], undefined, "gc() must not exist — GC was removed");
});

test("blocks are never deactivated for age (no maxBlockAge behavior)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("old1", "content from old turn")];
  state.blocks.push({
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "old but still active",
    directMessageIds: ["old1"],
    effectiveMessageIds: ["old1"],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 999,
    generation: "old",
    active: true,
  });
  const result = core.processTurn({
    messages,
    state,
    config: config(),
    tokenCount: 95000,
  });
  assert.equal(result.state.blocks[0]!.active, true, "block must stay active regardless of age");
});

test("applyCompression reports error for unknown boundary ref", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00099", endRef: "m00100", summary: "nope" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
});

test("batch compress attributes per-range errors and keeps partial success", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta"), msg("c", "gamma"), msg("d", "delta")];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(60), topic: "ok" },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(22), topic: "short" },
    ],
    messages,
    state,
    config: config({ compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 50 } }),
  });

  assert.equal(result.result.blocksCreated, 1, "valid range still compresses");
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /^range m00003\.\.m00004: Summary too short \(22 chars, min 50\)/);
});

test("retrying a consumed range reports already-compressed guidance, not too-small", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages: pruned,
    state: after,
    config: config({ compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 } }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 1);
  assert.match(retry.result.errors[0]!, /already compressed/);
  assert.match(retry.result.errors[0]!, /run acp_status/);
  assert.doesNotMatch(retry.result.errors[0]!, /Total compressible content too small/);
});

test("consumed plus fresh-but-small range is not misreported as too small", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "intro recap" },
      { startRef: "m00004", endRef: "m00005", summary: "c and d" },
    ],
    messages: pruned,
    state: after,
    config: config({ compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 } }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 1);
  assert.match(retry.result.errors[0]!, /already compressed/);
  assert.match(retry.result.errors[0]!, /remaining compressible content/);
  assert.doesNotMatch(retry.result.errors[0]!, /Combine more messages/);
});

test("fresh small content without consumed ranges keeps the too-small message", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "a and b" }],
    messages,
    state,
    config: config({ compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 } }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /^Total compressible content too small \(\d+ chars across 1 range\(s\), min 5000\)/);
});

test("consumed plus fresh content above threshold proceeds with a warning", () => {
  const core = createCore();
  const state = createInitialState();
  const big = "z".repeat(6000);
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", big),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "intro recap" },
      { startRef: "m00004", endRef: "m00005", summary: "big block" },
    ],
    messages: pruned,
    state: after,
    config: config({ compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 } }),
  });

  assert.equal(retry.result.blocksCreated, 1);
  assert.equal(retry.result.errors.length, 0);
  assert.ok(
    retry.result.warnings.some((w) => /Skipped range \(m00002\.\.m00003\) — already compressed/.test(w)),
    `expected consumed warning in: ${JSON.stringify(retry.result.warnings)}`,
  );
});

test("empty summary is attributed to its range", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /^range m00001\.\.m00002: Summary is empty/);
});

test("invalid refs are reported per-range without failing the batch", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m999999", endRef: "m00002", summary: "bad ref" },
      { startRef: "m00001", endRef: "m00002", summary: "good summary" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, "valid range still compresses");
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /^range m999999\.\.m00002: Invalid boundary ref/);
});

test("unknown ref (valid format, never allocated) names the ref and suggests acp_status", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha")];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00099", endRef: "m00100", summary: "nope" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /does not exist in this session/);
  assert.match(result.result.errors[0]!, /run acp_status/);
});

test("consumed ranges warn+skip when minCompressRange is 0", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
  ];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages: pruned,
    state: after,
    config: config(),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 0);
  assert.ok(
    retry.result.warnings.some((w) => /Skipped range \(m00002\.\.m00003\) — already compressed/.test(w)),
    `expected consumed warning in: ${JSON.stringify(retry.result.warnings)}`,
  );
});

test("resolveBoundaries throws typed BoundaryNotFoundError with kind and endpoint", () => {
  const state = createInitialState();
  const messages = [msg("u", "the task"), msg("a", "alpha"), msg("b", "beta"), msg("c", "gamma")];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;

  assert.throws(
    () => resolveBoundaries({ startRef: "m00099", endRef: "m00001", messages, state }),
    (e: unknown) =>
      e instanceof BoundaryNotFoundError && e.kind === "unknown" && e.endpoint === "start",
  );

  const core = createCore();
  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "a and b" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);
  assert.throws(
    () => resolveBoundaries({ startRef: "m00002", endRef: "m00003", messages: pruned, state: after }),
    (e: unknown) =>
      e instanceof BoundaryNotFoundError && e.kind === "consumed" && e.endpoint === "start",
  );
});
