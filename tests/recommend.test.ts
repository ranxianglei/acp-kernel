import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
} from "../src/recommend.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

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

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolMsg(id: string, toolName: string): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, text: `call ${toolName}` };
}

function assignAll(
  messages: CoreMessage[],
  state = createInitialState(),
  opts?: { isProtected?: (m: CoreMessage) => boolean },
) {
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: opts?.isProtected,
  }).map;
  return state;
}

// ─── computeProtectedRefs ─────────────────────────────────────────────────────

test("computeProtectedRefs: protects last user message even when both preserve options are 0", () => {
  const messages = [msg("a", "x"), msg("b", "y", "assistant")];
  const state = assignAll(messages);
  const refs = computeProtectedRefs(messages, state, config());
  assert.equal(refs.size, 1);
  assert.ok(refs.has("m00001"), "last user message (a) protected by Rule 3");
});

test("computeProtectedRefs: preserves last N messages by count", () => {
  const messages = [msg("a", "x"), msg("b", "y"), msg("c", "z")];
  const state = assignAll(messages);
  const refs = computeProtectedRefs(messages, state, config({ preserveRecentMessages: 2 }));
  assert.ok(refs.has("m00002"));
  assert.ok(refs.has("m00003"));
  assert.ok(!refs.has("m00001"));
});

test("computeProtectedRefs: preserves last N tokens expanding backward", () => {
  const messages = [
    msg("a", "x".repeat(1200)),
    msg("b", "y".repeat(1200)),
    msg("c", "z".repeat(1200)),
  ];
  const state = assignAll(messages);
  const refs = computeProtectedRefs(messages, state, config({ preserveRecentTokens: 500 }));
  assert.ok(refs.has("m00003"));
  assert.ok(refs.has("m00002"));
  assert.ok(!refs.has("m00001"), "a is outside the 500-token window");
});

test("computeProtectedRefs: combines count + token rules (union)", () => {
  const messages = [
    msg("a", "x".repeat(1200)),
    msg("b", "y".repeat(1200)),
    msg("c", "z".repeat(1200)),
  ];
  const state = assignAll(messages);
  const refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 1, preserveRecentTokens: 500 }),
  );
  assert.ok(refs.has("m00003"));
  assert.ok(refs.has("m00002"));
  assert.ok(!refs.has("m00001"));
});

// ─── buildCompressibleRanges ─────────────────────────────────────────────────

test("buildCompressibleRanges: groups contiguous compressible messages", () => {
  const messages = [
    msg("a", "x".repeat(2000)),
    msg("b", "y".repeat(2000)),
    msg("c", "z".repeat(2000)),
  ];
  const state = assignAll(messages);
  const ranges = buildCompressibleRanges(messages, state, config());
  assert.equal(ranges.compressible.length, 1);
  assert.equal(ranges.compressible[0]!.startRef, "m00001");
  assert.equal(ranges.compressible[0]!.endRef, "m00003");
  assert.equal(ranges.compressible[0]!.count, 3);
  assert.equal(ranges.protected.length, 0);
});

test("buildCompressibleRanges: protected tools get BLOCKED, excluded from compressible", () => {
  const messages = [
    msg("a", "x".repeat(2000)),
    toolMsg("p", "skill"),
    msg("c", "z".repeat(2000)),
  ];
  const state = assignAll(messages, undefined, {
    isProtected: (m) => m.contentType === "tool-call" && m.toolName === "skill",
  });
  const ranges = buildCompressibleRanges(
    messages,
    state,
    config({ protectedTools: ["skill"] }),
  );
  assert.equal(ranges.compressible.length, 1, "a and c form one contiguous range");
  assert.equal(ranges.compressible[0]!.startRef, "m00001");
  assert.equal(ranges.compressible[0]!.endRef, "m00002");
});

test("buildCompressibleRanges: protected zone splits compressible groups", () => {
  const messages = [
    msg("a", "x".repeat(2000)),
    msg("b", "y".repeat(2000)),
    msg("c", "z".repeat(2000)),
    msg("d", "w".repeat(2000)),
  ];
  const state = assignAll(messages);
  const protectedZone = new Set(["m00003", "m00004"]);
  const ranges = buildCompressibleRanges(
    messages,
    state,
    config(),
    protectedZone,
  );
  assert.equal(ranges.compressible.length, 1);
  assert.equal(ranges.compressible[0]!.startRef, "m00001");
  assert.equal(ranges.compressible[0]!.endRef, "m00002");
});

test("buildCompressibleRanges: tool/text percentage computed", () => {
  const messages = [
    msg("a", "text content here"),
    toolMsg("t", "bash"),
    msg("c", "more text content"),
  ];
  const state = assignAll(messages);
  const ranges = buildCompressibleRanges(messages, state, config());
  assert.ok(ranges.compressible[0]!.toolPct > 0);
  assert.ok(ranges.compressible[0]!.textPct > 0);
  assert.equal(ranges.compressible[0]!.toolPct + ranges.compressible[0]!.textPct, 100);
});

// ─── Integration: 19-token bug fix ─────────────────────────────────────────────

test("integration: tiny ranges are suppressed — fixes the 19-token compression bug", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "hello"),
    msg("b", "world"),
  ];
  const result = core.processTurn({
    messages,
    state,
    config: config({ modelContextLimit: 12000 }),
    tokenCount: 9000,
  });
  assert.equal(result.nudge!.shouldInject, false, "turn 1: growth=0, no nudge");
  assert.ok(result.nudge!.reason.includes("growth"), `reason: ${result.nudge!.reason}`);
});
