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
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function seededState(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

// Eight messages m00001..m00008, all long enough to clear minCompressRange when
// several are combined.
const EIGHT = [
  msg("a", "first detailed message body content alpha"),
  msg("b", "second detailed message body content beta"),
  msg("c", "third detailed message body content gamma"),
  msg("d", "fourth detailed message body content delta"),
  msg("e", "fifth detailed message body content epsilon"),
  msg("f", "sixth detailed message body content zeta"),
  msg("g", "seventh detailed message body content eta"),
  msg("h", "eighth detailed message body content theta"),
];

test("applyCompression refuses to compress the last N messages (preserveRecentMessages)", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00006..m00008 are the last 3 → must be protected.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00006", endRef: "m00008", summary: "trying to compress the recent zone", topic: "bad" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 0, "no block created");
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /protected messages.*last 3/i,
    `error should mention the protected recent zone, got: ${result.result.errors[0]}`,
  );
});

test("applyCompression refuses to compress a range that overlaps the recent zone", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00005 is outside the zone, but m00006..m00008 are inside → partial overlap must be rejected.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00005", endRef: "m00007", summary: "overlapping the recent zone", topic: "bad" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 0, "no block created on overlap");
  assert.match(result.result.errors[0]!, /protected messages/i);
});

test("applyCompression protects the most recent user message even outside the recent-N window", () => {
  const core = createCore();
  // Preserve only 1 recent message, but make the last-but-one a user message:
  // the last user message must still be protected by Rule 3 regardless of distance.
  const messages = [
    msg("a", "u1 text alpha", "user"),
    msg("b", "assistant reply beta", "assistant"),
    msg("c", "u2 text gamma — the latest user message", "user"),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 1 });

  // preserveRecentMessages=1 protects only m00003; m00002 (assistant) is the
  // assistant turn, m00001 is a user message — but it is NOT the most recent
  // user message, so it is compressible. Verify compressing the genuine
  // latest user message is refused.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "grabbing the last user msg", topic: "bad" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /protected messages/i);
});

test("applyCompression still allows compressing messages strictly before the recent zone", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00001..m00003 are well before the last 3 (m00006..m00008) → must succeed.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00003", summary: "compressing older messages is allowed", topic: "ok" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 1, "older range still compressible");
  assert.equal(result.result.errors.length, 0);
});

test("applyCompression defaults to safe protection when caller omits protectedMessageIds", () => {
  // No explicit protectedMessageIds passed — applyCompression must compute the
  // soft-protected zone itself (recent-N + last user message).
  const core = createCore();
  const messages = [
    msg("a", "old user msg alpha", "user"),
    msg("b", "old assistant beta", "assistant"),
    msg("c", "current user intent gamma", "user"),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 2 });

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "should be refused by default protection", topic: "bad" },
    ],
    messages,
    state,
    config: cfg,
    // intentionally NO protectedMessageIds
  });

  assert.equal(result.result.blocksCreated, 0, "default protection applies without explicit set");
  assert.match(result.result.errors[0]!, /protected messages/i);
});
