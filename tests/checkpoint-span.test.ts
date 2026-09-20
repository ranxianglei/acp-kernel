import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return { id, role, contentType: "text", text, ...extra };
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

// Host-managed-surface scenario (#335): the host records its compression
// result as a plain checkpoint message (its own user/message carrying the
// distilled text) plus a kernel block registered via applyCompression. A
// checkpoint declaring `summaryOfBlockId` is a view-only rendering of a
// prior distillation, like the kernel's own acp_summary_* messages.

function buildBaseLog(count: number): CoreMessage[] {
  const messages: CoreMessage[] = [];
  for (let seq = 1; seq <= count; seq++) {
    messages.push(
      msg(
        String(seq),
        `log message ${seq}`,
        seq % 2 === 1 ? "user" : "assistant",
      ),
    );
  }
  return messages;
}

test("plain range spanning a host checkpoint does not fold the checkpoint (#335)", () => {
  const core = createCore();
  let state = createInitialState();
  const base = buildBaseLog(12);
  state.messageRefs = assignRefs(base, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const first = core.applyCompression({
    ranges: [
      {
        startRef: "m00006",
        endRef: "m00009",
        summary: "first distillation",
        topic: "phase one",
      },
    ],
    messages: base,
    state,
    config: config(),
  });
  assert.equal(first.result.errors.length, 0);
  state = first.state;

  const checkpoint = msg("15", "host checkpoint: distilled phase one", "user", {
    summaryOfBlockId: "b1",
  });
  const tail = buildBaseLog(40).slice(17);
  const extended = [...base, checkpoint, ...tail];
  state.messageRefs = assignRefs(extended, {
    existing: state.messageRefs,
    nextIndex: 13,
  }).map;

  const second = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00036", summary: "full re-distillation" },
    ],
    messages: extended,
    state,
    config: config(),
  });
  assert.equal(second.result.errors.length, 0);
  assert.equal(second.result.blocksCreated, 1);
  state = second.state;

  const b1 = state.blocks[0]!;
  const b2 = state.blocks[1]!;
  assert.equal(b1.active, false, "nested block is consumed as before");
  assert.deepEqual(
    b2.directBlockIds,
    ["b1"],
    "supersession lineage is recorded",
  );
  assert.equal(b2.tier, 1, "plain range stays tier 1");
  assert.ok(
    b2.effectiveMessageIds.includes("6"),
    "inherited coverage survives",
  );
  assert.ok(
    !b2.effectiveMessageIds.includes("15"),
    "host checkpoint must not be folded into the new block's coverage",
  );
  assert.ok(!b2.directMessageIds.includes("15"));

  const prunedIds = prune(extended, state).map((m) => m.id);
  assert.ok(prunedIds.includes("15"), "previous distillation stays visible");
  assert.ok(prunedIds.includes("acp_summary_b2"));
  assert.ok(!prunedIds.includes("8"), "covered raws stay hidden");
});

test("plain range still folds unmarked host messages (marker is opt-in)", () => {
  const core = createCore();
  let state = createInitialState();
  const base = buildBaseLog(12);
  state.messageRefs = assignRefs(base, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  state = core.applyCompression({
    ranges: [
      { startRef: "m00006", endRef: "m00009", summary: "first distillation" },
    ],
    messages: base,
    state,
    config: config(),
  }).state;

  const unmarked = msg("15", "ordinary host message", "user");
  const tail = buildBaseLog(40).slice(17);
  const extended = [...base, unmarked, ...tail];
  state.messageRefs = assignRefs(extended, {
    existing: state.messageRefs,
    nextIndex: 13,
  }).map;

  const second = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00036", summary: "full re-distillation" },
    ],
    messages: extended,
    state,
    config: config(),
  });
  assert.equal(second.result.errors.length, 0);
  assert.ok(
    second.state.blocks[1]!.effectiveMessageIds.includes("15"),
    "unmarked messages keep being compressed as ordinary content",
  );
});

test("block-boundary distillation still folds host checkpoints in its span (#335: T2/T3 must not barrier)", () => {
  const core = createCore();
  let state = createInitialState();
  const messages = [
    msg("1", "one", "user"),
    msg("2", "two", "assistant"),
    msg("3", "host checkpoint of b1", "user", { summaryOfBlockId: "b1" }),
    msg("4", "four", "user"),
    msg("5", "five", "assistant"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  state = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "distill one-two" },
    ],
    messages,
    state,
    config: config(),
  }).state;
  state = core.applyCompression({
    ranges: [
      { startRef: "m00004", endRef: "m00005", summary: "distill four-five" },
    ],
    messages,
    state,
    config: config(),
  }).state;

  const t2 = core.applyCompression({
    ranges: [
      { startRef: "b1", endRef: "b2", summary: "tier two distillation" },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(t2.result.errors.length, 0);
  const block = t2.state.blocks[2]!;
  assert.equal(block.tier, 2);
  assert.deepEqual([...block.directBlockIds].sort(), ["b1", "b2"]);
  assert.ok(
    block.effectiveMessageIds.includes("3"),
    "tier distillation deliberately crosses checkpoints",
  );
  assert.deepEqual([...block.effectiveMessageIds].sort(), [
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  assert.equal(t2.state.blocks[0]!.active, false);
  assert.equal(t2.state.blocks[1]!.active, false);
});

test("checkpoint inside the recent-protection window is excluded by soft protection, not by the marker", () => {
  const core = createCore();
  let state = createInitialState();
  const base = buildBaseLog(6);
  state.messageRefs = assignRefs(base, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  state = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "early recap" }],
    messages: base,
    state,
    config: config(),
  }).state;

  const checkpoint = msg("15", "host checkpoint of b1", "user");
  const extended = [...base, checkpoint, msg("16", "sixteen", "assistant")];
  state.messageRefs = assignRefs(extended, {
    existing: state.messageRefs,
    nextIndex: 7,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00004", endRef: "m00008", summary: "late recap" }],
    messages: extended,
    state,
    config: config({ preserveRecentMessages: 2 }),
  });
  assert.equal(result.result.errors.length, 0);
  assert.equal(result.result.blocksCreated, 1);
  assert.ok(
    result.result.warnings.some((w) =>
      w.includes("Excluded 2 protected message(s)"),
    ),
    "exclusion comes from the soft-protection zone",
  );
  assert.ok(
    !result.state.blocks[1]!.effectiveMessageIds.includes("15"),
    "in-window checkpoint is not folded without any marker",
  );
  assert.deepEqual(result.state.blocks[1]!.effectiveMessageIds.sort(), [
    "4",
    "5",
    "6",
  ]);
});
