import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
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
    compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function setup() {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x".repeat(200)), msg("b", "y".repeat(200)), msg("c", "z".repeat(200))];
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return { core, state, messages };
}

// Reproduces dog/billion-context-pi session 01a02542: after every compressible
// range is consumed, the model re-submitted the SAME rejected compress 3853
// times because the gate error kept ending with a retry suggestion.
test("identical rejected compress flips to a terminal message with no retry guidance", () => {
  const { core, state, messages } = setup();
  const spec = { startRef: "m00001", endRef: "m00002", summary: "s" };
  const first = core.applyCompression({ ranges: [spec], messages, state, config: config() });
  assert.equal(first.result.blocksCreated, 0);
  assert.match(first.result.errors[0]!, /already compressed|too small/);
  assert.ok(!/rejected \d+ times/.test(first.result.errors[0]!), "first rejection keeps guidance");
  assert.equal(first.state.rejections?.[0]?.count, 1);

  const second = core.applyCompression({ ranges: [spec], messages, state: first.state, config: config() });
  assert.match(second.result.errors[0]!, /rejected 2 times/);
  assert.ok(!/retry/i.test(second.result.errors[0]!), "terminal message must not suggest retry");
  assert.ok(!/re-issue|acp_status/.test(second.result.errors[0]!));

  const third = core.applyCompression({ ranges: [spec], messages, state: second.state, config: config() });
  assert.match(third.result.errors[0]!, /rejected 3 times/);
});

test("a different range after a rejection starts its own counter", () => {
  const { core, state, messages } = setup();
  const a = core.applyCompression(
    { ranges: [{ startRef: "m00001", endRef: "m00002", summary: "s" }], messages, state, config: config() },
  );
  const b = core.applyCompression(
    { ranges: [{ startRef: "m00002", endRef: "m00003", summary: "s" }], messages, state: a.state, config: config() },
  );
  assert.equal(b.state.rejections?.length, 2);
  assert.ok(!/rejected \d+ times/.test(b.result.errors[0]!));
});

test("rejection tracking does not mutate the caller's state object", () => {
  const { core, state, messages } = setup();
  const out = core.applyCompression(
    { ranges: [{ startRef: "m00001", endRef: "m00002", summary: "s" }], messages, state, config: config() },
  );
  assert.equal(state.rejections, undefined, "input state untouched");
  assert.equal(out.state.rejections?.length, 1);
});

test("state without the rejections field (old persisted state) counts from 1", () => {
  const { core, state, messages } = setup();
  const legacy = { ...state };
  delete (legacy as { rejections?: unknown }).rejections;
  const out = core.applyCompression(
    { ranges: [{ startRef: "m00001", endRef: "m00002", summary: "s" }], messages, state: legacy, config: config() },
  );
  assert.equal(out.state.rejections?.[0]?.count, 1);
});
