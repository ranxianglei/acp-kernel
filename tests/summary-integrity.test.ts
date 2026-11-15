import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, detectTruncatedSummary } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function config(compress: Partial<Config["compress"]> = {}): Config {
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
      minCompressRange: 0,
      maxSummaryLength: 0,
      minSummaryLength: 0,
      ...compress,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  } as Config;
}

// One ~1000-token message (countTokens below is 1 token per char).
function run(summary: string, compress: Partial<Config["compress"]> = {}) {
  const core = createCore({ countTokens: (text: string) => text.length });
  const state = createInitialState();
  const messages = [msg("a", "x".repeat(1000)), msg("b", "tail")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00001", summary }],
    messages,
    state,
    config: config(compress),
  }).result;
}

test("detectTruncatedSummary flags ellipsis tails and unclosed fences only", () => {
  assert.equal(detectTruncatedSummary("done."), null);
  assert.equal(detectTruncatedSummary("- item one\n- item two"), null);
  assert.equal(detectTruncatedSummary("see:\n```ts\ncode\n```"), null);
  assert.match(detectTruncatedSummary("verify comm…")!, /ellipsis/);
  assert.match(detectTruncatedSummary("and then...  ")!, /ellipsis/);
  assert.match(detectTruncatedSummary("```ts\nconst a = 1")!, /fence/);
});

test("truncated summary is rejected by default", () => {
  const r = run("Recorded findings, then verify comm…");
  assert.equal(r.blocksCreated, 0);
  assert.match(
    r.errors[0]!,
    /Summary looks truncated \(ends with an ellipsis\)/,
  );
});

test("rejectTruncatedSummary: false restores the old behavior", () => {
  const r = run("Recorded findings, then verify comm…", {
    rejectTruncatedSummary: false,
  });
  assert.equal(r.blocksCreated, 1);
});

test("minSummaryRatio rejects a summary too short for its range", () => {
  const r = run("y".repeat(15) + ".", { minSummaryRatio: 0.02 });
  assert.equal(r.blocksCreated, 0);
  assert.match(
    r.errors[0]!,
    /Summary too short for its range \(16 chars .*min 20/,
  );
});

test("minSummaryRatio passes once the summary meets the floor", () => {
  const r = run("y".repeat(25) + ".", { minSummaryRatio: 0.02 });
  assert.equal(r.blocksCreated, 1);
});

test("ratio floor is capped at half of maxSummaryLength", () => {
  // 1000 tokens * 1.0 = 1000, but ceiling 40 caps the floor at 20.
  const r = run("y".repeat(25) + ".", {
    minSummaryRatio: 1,
    maxSummaryLength: 40,
  });
  assert.equal(r.blocksCreated, 1);
});

test("minSummaryRatio is off by default", () => {
  const r = run("short.");
  assert.equal(r.blocksCreated, 1);
});
