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

test("computeProtectedRefs: last user message is protected when preserveRecentMessages > 0", () => {
  const messages = [msg("a", "x"), msg("b", "y", "assistant")];
  const state = assignAll(messages);
  const refs = computeProtectedRefs(messages, state, config({ preserveRecentMessages: 5 }));
  assert.ok(refs.has("m00001"), "last user message (a) protected by Rule 3 when recent protection is on");
});

test("computeProtectedRefs: last user message is NOT protected when preserveRecentMessages = 0 (full opt-out)", () => {
  const messages = [msg("a", "x"), msg("b", "y", "assistant")];
  const state = assignAll(messages);
  const refs = computeProtectedRefs(messages, state, config());
  assert.ok(!refs.has("m00001"), "Rule 3 follows preserveRecentMessages — 0 opts out of all recent protection");
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

test("buildCompressibleRanges: splits at user-turn boundaries once a group has >= 3 messages", () => {
  // 4 user turns: each user + assistant(tool-call) + tool-result = 3 msgs.
  // Without user-boundary splitting these collapse into one m00001–m00012
  // block; with it they form 4 turn-aligned blocks.
  const messages: CoreMessage[] = [];
  for (let i = 0; i < 4; i++) {
    messages.push(msg("u" + i, "user turn " + i + " content".repeat(50)));
    messages.push(toolMsg("a" + i, "bash"));
    messages.push({ id: "t" + i, role: "tool", contentType: "tool-result", toolCallId: "c" + i, text: "result".repeat(50) });
  }
  const state = assignAll(messages);
  const ranges = buildCompressibleRanges(messages, state, config());
  assert.equal(ranges.compressible.length, 4, "one compressible block per user turn");
  // Each block covers exactly one turn (3 msgs): u0/a0/t0, u1/a1/t1, ...
  assert.equal(ranges.compressible[0]!.startRef, "m00001");
  assert.equal(ranges.compressible[0]!.endRef, "m00003");
  assert.equal(ranges.compressible[0]!.count, 3);
  assert.equal(ranges.compressible[3]!.startRef, "m00010");
  assert.equal(ranges.compressible[3]!.endRef, "m00012");
});

test("buildCompressibleRanges: does NOT split before a group reaches 3 messages", () => {
  // 2 messages then a user message: group is only 2 when the user arrives,
  // so the user message should join the existing group rather than start a new one.
  const messages = [
    toolMsg("a", "bash"),
    { id: "t", role: "tool", contentType: "tool-result", toolCallId: "c", text: "result".repeat(50) },
    msg("u", "user message"),
  ];
  const state = assignAll(messages);
  const ranges = buildCompressibleRanges(messages, state, config());
  assert.equal(ranges.compressible.length, 1, "short group not split at user boundary");
  assert.equal(ranges.compressible[0]!.count, 3);
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

// ─── countTokens injection (Phase 1: T1 pending uses injected countTokens) ────

test("buildCompressibleRanges: CJK-aware countTokens inflates Chinese pending vs chars/4", () => {
  const zh = "这是一个中文测试消息用于验证token校准的效果。".repeat(20); // ~340 chars
  const messages = [msg("a", zh), toolMsg("b", "bash"), msg("c", "tail", "tool")];
  const state = assignAll(messages);

  const chars4 = buildCompressibleRanges(messages, state, config());
  const cjk = buildCompressibleRanges(messages, state, config(), undefined, (t) => t.length);

  const pendingDefault = chars4.compressible.reduce((s, r) => s + r.tokens, 0);
  const pendingCjk = cjk.compressible.reduce((s, r) => s + r.tokens, 0);
  assert.ok(pendingCjk > pendingDefault, `cjk ${pendingCjk} should exceed chars/4 ${pendingDefault}`);
  // ~340 chars: chars/4 ≈ 85, CJK-aware ≈ 340+ → multiple of ~3+
  assert.ok(pendingCjk >= pendingDefault * 3, `expected >=3x inflation, got ${pendingCjk} vs ${pendingDefault}`);
});

test("buildCompressibleRanges: default countTokens preserves chars/4 legacy behavior", () => {
  const messages = [msg("a", "x".repeat(40))];
  const state = assignAll(messages);
  const ranges = buildCompressibleRanges(messages, state, config());
  assert.equal(ranges.compressible[0]!.tokens, 10, "chars/4 of 40 chars = 10");
});

test("computeProtectedRefs: injected countTokens sizes the recent-token zone", () => {
  const messages = [msg("a", "前"), msg("b", "x".repeat(400)), msg("c", "后", "assistant")];
  const state = assignAll(messages);
  // preserveRecentTokens = 100 with chars/4: last 400 chars msg b = 100 tokens → zone covers b, a unprotected
  const chars4 = computeProtectedRefs(messages, state, config({ preserveRecentTokens: 100, preserveRecentMessages: 0 }));
  assert.equal(chars4.has("m00001"), false, "chars/4: a (1 token) stays outside 100-token zone starting at b(100)");
  assert.equal(chars4.has("m00002"), true, "chars/4: b fills the zone");
  // same config but CJK-aware: b = 400 tokens → zone far exceeds, a (1 token) still outside, but b dominates
  const cjk = computeProtectedRefs(messages, state, config({ preserveRecentTokens: 100, preserveRecentMessages: 0 }), (t) => t.length);
  assert.equal(cjk.has("m00002"), true, "cjk: b is in recent zone");
  assert.equal(cjk.has("m00003"), true, "cjk: c is in recent zone");
});
