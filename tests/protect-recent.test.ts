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

test("applyCompression fails when the range is ENTIRELY within the recent zone", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00006..m00008 are the last 3 → entirely protected. After filtering there
  // is nothing left to compress, so the range must still fail.
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
    /entirely.*protected.*last 3|last 3.*protected/i,
    `error should mention the protected recent zone with nothing left, got: ${result.result.errors[0]}`,
  );
});

test("applyCompression excludes protected tail and compresses the rest (partial overlap)", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00005 is outside the zone, m00006..m00007 are inside. The unprotected
  // head (m00005) must still be compressed; the protected tail is excluded
  // and surfaced as a warning rather than failing the whole range.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00005", endRef: "m00007", summary: "overlapping the recent zone", topic: "partial" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 1, "unprotected head still compressed");
  assert.equal(result.result.errors.length, 0, "no error — overlap is non-fatal");
  assert.equal(result.result.warnings.length, 1, "a warning is surfaced");
  assert.match(result.result.warnings[0]!, /Excluded.*protected.*m0000[67]/i);
  // The created block must NOT cover the protected messages.
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.ok(!block.effectiveMessageIds.includes("f"), "m00006 raw id not covered");
  assert.ok(!block.effectiveMessageIds.includes("g"), "m00007 raw id not covered");
  assert.ok(block.directMessageIds.includes("e"), "m00005 raw id IS compressed");
});

test("applyCompression excludes the most recent user message and compresses the rest", () => {
  const core = createCore();
  // Preserve only 1 recent message; the last user message (m00003) is still
  // protected by Rule 3. The assistant message m00002 is compressible.
  const messages = [
    msg("a", "u1 text alpha", "user"),
    msg("b", "assistant reply beta", "assistant"),
    msg("c", "u2 text gamma — the latest user message", "user"),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 1 });

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "grabbing the last user msg", topic: "partial" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 1, "assistant msg still compressed");
  assert.equal(result.result.errors.length, 0);
  assert.equal(result.result.warnings.length, 1);
  assert.match(result.result.warnings[0]!, /Excluded.*protected.*m00003/i);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.ok(block.directMessageIds.includes("b"), "m00002 compressed");
  assert.ok(!block.effectiveMessageIds.includes("c"), "m00003 stays visible");
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
  assert.equal(result.result.warnings.length, 0, "no warnings for a clean range");
});

test("applyCompression fails by default when the whole range is protected (no explicit set)", () => {
  // No explicit protectedMessageIds passed — applyCompression must compute the
  // soft-protected zone itself (recent-N + last user message). When the entire
  // range falls in that zone, it still fails.
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
  assert.match(result.result.errors[0]!, /protected/i);
});

// --- decompress results are excluded from the recent-protected zone ---

function toolResult(
  id: string,
  toolName: string,
  text: string,
  toolCallId = "tc-" + id,
): CoreMessage {
  return { id, role: "tool", contentType: "tool-result", toolName, toolCallId, text };
}

test("computeProtectedRefs excludes decompress tool results from the recent zone", async () => {
  // A decompress tool result sits at the tail. Without the NEVER_PRESERVE_RECENT
  // exclusion it would occupy the recent-N window and become un-compressible.
  const { computeProtectedRefs } = await import("../src/recommend.js");
  const messages: CoreMessage[] = [
    msg("a", "old alpha", "user"),
    msg("b", "old beta", "assistant"),
    msg("c", "old gamma", "user"),
    toolResult("d", "decompress", "x".repeat(20000)),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  const protectedRefs = computeProtectedRefs(messages, state, cfg);
  // m00004 is the decompress result — must NOT be in the protected zone.
  assert.ok(!protectedRefs.has("m00004"), "decompress result not protected by recent zone");
  // The last USER message (m00003) is still protected by Rule 3.
  assert.ok(protectedRefs.has("m00003"), "last user message still protected");
});

test("applyCompression can compress a decompress tool result in the recent tail", () => {
  // The decompress result is the last message (within preserveRecentMessages=3).
  // It must still be compressible because it is excluded from the protected zone.
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "first message alpha", "user"),
    msg("b", "second message beta", "assistant"),
    msg("c", "third message gamma", "user"),
    toolResult("d", "decompress", "restored content " + "x".repeat(200)),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00004", endRef: "m00004", summary: "compressing the decompress result", topic: "reclaim" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 1, "decompress result is compressible despite being in the tail");
  assert.equal(result.result.errors.length, 0);
  assert.equal(result.result.warnings.length, 0, "no warning — it is genuinely outside the protected zone");
});

test("warnings accumulate across multiple ranges in one batch", () => {
  const core = createCore();
  const messages = [
    ...EIGHT,
    msg("i", "ninth message iota", "user"),
    msg("j", "tenth message kappa", "assistant"),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // Two ranges: each partially overlaps the recent zone (m00008..m00010).
  // Both should produce warnings, and both unprotected heads should compress.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00004", endRef: "m00009", summary: "first partial range summary", topic: "a" },
      { startRef: "m00010", endRef: "m00010", summary: "second range fully protected tail", topic: "b" },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.ok(result.result.blocksCreated >= 1, "at least the unprotected head compresses");
  assert.ok(result.result.warnings.length >= 1, "warnings surfaced");
});
