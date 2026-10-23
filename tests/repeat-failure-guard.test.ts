/**
 * Regression: #311 — repeated identical compression failures must escalate
 * instead of repeating a verbatim error forever (the 7× self-reinforcing loop
 * of ranxianglei/billion-context#847), and the size-gate fallback must point
 * at acp_status instead of only saying "combine more messages".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import { mergeCompressionState } from "../src/persist/state-merge.js";
import type { Config, CoreMessage, CompressionState } from "../src/types.js";

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
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function seededState(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

test("repeat identical too-small rejection escalates from the second attempt (#311)", () => {
  const core = createCore();
  const messages = [msg("u", "the task"), msg("a", "alpha"), msg("b", "beta")];
  let state = seededState(messages);

  const first = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "small" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(first.result.blocksCreated, 0);
  assert.equal(first.result.errors.length, 1);
  assert.match(first.result.errors[0]!, /Total compressible content too small/);
  assert.doesNotMatch(first.result.errors[0]!, /Repeat-failure guard/);
  assert.match(
    first.result.errors[0]!,
    /run acp_status and target one of the CURRENT compressible ranges/,
  );
  assert.deepEqual(first.state.repeatFailures, { "m2..m3": 1 });

  const second = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "small" }],
    messages,
    state: first.state,
    config: config(),
  });
  assert.equal(second.result.blocksCreated, 0);
  assert.equal(second.result.errors.length, 2);
  assert.match(
    second.result.errors[0]!,
    /Repeat-failure guard: you have now requested this exact range set 2 time\(s\); it deterministically fails/,
  );
  assert.match(second.result.errors[0]!, /Do NOT re-issue it/);
  assert.match(second.result.errors[0]!, /Call acp_status first/);
  assert.match(
    second.result.errors[1]!,
    /Total compressible content too small/,
  );
  assert.deepEqual(second.state.repeatFailures, { "m2..m3": 2 });

  const third = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "small" }],
    messages,
    state: second.state,
    config: config(),
  });
  assert.match(third.result.errors[0]!, /3 time\(s\)/);
});

test("counter keys are canonical: padded refs, direction, and batch order all collapse (#311)", () => {
  const core = createCore();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];

  let state = seededState(messages);
  const r1 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "x" }],
    messages,
    state,
    config: config(),
  });
  assert.deepEqual(r1.state.repeatFailures, { "m2..m3": 1 });

  const r2 = core.applyCompression({
    ranges: [{ startRef: "m3", endRef: "m2", summary: "x" }],
    messages,
    state: r1.state,
    config: config(),
  });
  assert.match(r2.result.errors[0]!, /Repeat-failure guard/);
  assert.deepEqual(r2.state.repeatFailures, { "m2..m3": 2 });

  let s2 = seededState(messages);
  const b1 = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "x" },
      { startRef: "m00004", endRef: "m00005", summary: "y" },
    ],
    messages,
    state: s2,
    config: config(),
  });
  assert.deepEqual(b1.state.repeatFailures, { "m2..m3|m4..m5": 1 });

  const b2 = core.applyCompression({
    ranges: [
      { startRef: "m00004", endRef: "m00005", summary: "y" },
      { startRef: "m00002", endRef: "m00003", summary: "x" },
    ],
    messages,
    state: b1.state,
    config: config(),
  });
  assert.match(b2.result.errors[0]!, /Repeat-failure guard/);
  assert.deepEqual(b2.state.repeatFailures, { "m2..m3|m4..m5": 2 });
});

test("any successful compression clears the whole failure table (#311)", () => {
  const core = createCore();
  const big = "x".repeat(6000);
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", big),
  ];
  let state = seededState(messages);

  const f1 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "small" }],
    messages,
    state,
    config: config(),
  });
  const f2 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "small" }],
    messages,
    state: f1.state,
    config: config(),
  });
  assert.match(f2.result.errors[0]!, /Repeat-failure guard/);

  const ok = core.applyCompression({
    ranges: [
      { startRef: "m00004", endRef: "m00004", summary: big.slice(0, 20) },
    ],
    messages,
    state: f2.state,
    config: config(),
  });
  assert.equal(ok.result.blocksCreated, 1);
  assert.deepEqual(ok.state.repeatFailures, {});

  const retry = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "small" }],
    messages,
    state: ok.state,
    config: config(),
  });
  assert.doesNotMatch(retry.result.errors[0]!, /Repeat-failure guard/);
  assert.deepEqual(retry.state.repeatFailures, { "m2..m3": 1 });
});

test("distinct range sets are counted independently (#311)", () => {
  const core = createCore();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
  ];
  let state = seededState(messages);

  const a1 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00002", summary: "x" }],
    messages,
    state,
    config: config(),
  });
  const b1 = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00003", summary: "y" }],
    messages,
    state: a1.state,
    config: config(),
  });
  assert.deepEqual(b1.state.repeatFailures, { "m2..m2": 1, "m3..m3": 1 });

  const a2 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00002", summary: "x" }],
    messages,
    state: b1.state,
    config: config(),
  });
  assert.match(a2.result.errors[0]!, /Repeat-failure guard/);
  assert.deepEqual(a2.state.repeatFailures, { "m2..m2": 2, "m3..m3": 1 });
});

test("already-compressed no-op retries also count and escalate (#311)", () => {
  const core = createCore();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
  ];
  let state = seededState(messages);

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 0,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });
  assert.deepEqual(after.repeatFailures, {});
  const pruned = prune(messages, after);

  const r1 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages: pruned,
    state: after,
    config: config(),
  });
  assert.equal(r1.result.blocksCreated, 0);
  assert.equal(r1.result.errors.length, 1);
  assert.match(r1.result.errors[0]!, /already compressed/);
  assert.doesNotMatch(r1.result.errors[0]!, /Repeat-failure guard/);
  assert.deepEqual(r1.state.repeatFailures, { "m2..m3": 1 });

  const r2 = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages: pruned,
    state: r1.state,
    config: config(),
  });
  assert.equal(r2.result.errors.length, 2);
  assert.match(r2.result.errors[0]!, /Repeat-failure guard/);
  assert.match(r2.result.errors[1]!, /already compressed/);
});

test("unparseable-ref requests count and escalate on the zero-counted gate (#311)", () => {
  const core = createCore();
  const messages = [msg("u", "the task"), msg("a", "alpha"), msg("b", "beta")];
  let state = seededState(messages);

  const g1 = core.applyCompression({
    ranges: [{ startRef: "zzz", endRef: "qqq", summary: "garbage" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(g1.result.blocksCreated, 0);
  assert.equal(g1.result.errors.length, 1);
  assert.match(g1.result.errors[0]!, /Invalid boundary ref/);
  assert.doesNotMatch(g1.result.errors[0]!, /Repeat-failure guard/);
  assert.deepEqual(g1.state.repeatFailures, { "zzz..qqq": 1 });

  const g2 = core.applyCompression({
    ranges: [{ startRef: "ZZZ", endRef: "qqq", summary: "garbage" }],
    messages,
    state: g1.state,
    config: config(),
  });
  assert.equal(g2.result.errors.length, 2);
  assert.match(
    g2.result.errors[0]!,
    /Repeat-failure guard: you have now requested this exact range set 2 time\(s\)/,
  );
  assert.match(g2.result.errors[1]!, /Invalid boundary ref/);
  assert.deepEqual(g2.state.repeatFailures, { "zzz..qqq": 2 });
});

test("mergeCompressionState carries repeatFailures through load (#311)", () => {
  const withCounter = mergeCompressionState({
    ...createInitialState(),
    repeatFailures: { "m2..m3": 2 },
  });
  assert.deepEqual(withCounter.repeatFailures, { "m2..m3": 2 });

  const without = mergeCompressionState(createInitialState());
  assert.equal(without.repeatFailures, undefined);
});
