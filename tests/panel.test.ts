import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusPanel, topicFallback, formatCompactTokens } from "../src/panel/index.js";
import { VIABLE_RANGE_MIN_TOKENS } from "../src/viable.js";

test("panel separates session accounting from sent view", () => {
  const nudge = {
    shouldInject: false,
    reason: "idle — max compressible 8106 < threshold 50000",
    compressibleRanges: [
      { startRef: "m00002", endRef: "m00005", tokens: 16 },
      { startRef: "m00010", endRef: "m00040", tokens: 8_106 },
    ],
    contextUsage: 0.43,
    tier: null,
    breakdown: { emergencyOverride: 0 },
    contextBreakdown: { system: 0, tool: 20_000, text: 4_000, code: 0, summaries: 0, total: 24_000, growth: 6_100 },
  };
  const state = {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 0 },
    nextBlockId: 1,
    nextRunId: 1,
  };
  const text = buildStatusPanel({
    version: "acp-kernel@0.0.36 (test)",
    tokenCount: 430_000,
    systemPromptTokens: 0,
    state: state as never,
    nudge: nudge as never,
    modelContextLimit: 1_000_000,
  });

  assert.match(text, /Context \(session accounting, host footer scale\): 43% \(430k \/ 1\.0M\) — never shrinks/);
  assert.match(text, /Sent to LLM \(after compression, est\.\): 24k \(2% of limit\)/);
  assert.doesNotMatch(text, /Session-only/, "omitted without unprunedTokens — no cross-scale subtraction");
  assert.match(text, /Token Breakdown \(sent view\):/);
  assert.doesNotMatch(text, /Framework/, "no fake Framework bucket");
  const toolLine = text.split("\n").find((l) => l.trim().startsWith("Tool"))!;
  assert.match(toolLine, / 83%/, `bar percentages must use the sent view: ${toolLine}`);
  assert.doesNotMatch(text, /m00002\.\.m00005/, "sub-viability ranges must not be listed");
});

test("panel renders blocks with topic fallback and version line", () => {
  const state = {
    blocks: [
      { blockId: "b1", tier: 1, active: true, summary: "Plugin discovery and registration walkthrough.", compressedTokens: 25_000, effectiveMessageIds: [], coveredRawIds: [], createdAt: 1 },
    ],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 25_000 },
    nextBlockId: 2,
    nextRunId: 1,
  };
  const text = buildStatusPanel({ tokenCount: 1_000, systemPromptTokens: 0, state: state as never, nudge: undefined, modelContextLimit: 200_000 });
  assert.match(text, /Blocks: 1 active \/ 1 total \(25k tokens compressed\)/);
  assert.match(text, /\[b1\] T1 25k→\d+.*Plugin discovery and registrat…/);
  assert.doesNotMatch(text, /acp-kernel@/, "no version line when omitted");
});

test("viability floor constant stays coupled to kernel summary rules", () => {
  assert.equal(VIABLE_RANGE_MIN_TOKENS, 200);
});

test("session-only derives on the estimation scale, never cross-scale", () => {
  // 430k provider-scale footer vs 24k sent view (chars/4). With the full
  // projection estimated at 134k on the SAME chars/4 scale, session-only
  // must read 110k — not 430k − 24k = 406k (issue #18).
  const nudge = {
    shouldInject: false,
    reason: "idle",
    contextBreakdown: { system: 0, tool: 20_000, text: 4_000, code: 0, summaries: 0, total: 24_000, growth: 0 },
  };
  const state = { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nudge: {}, stats: { tokensCompressed: 0 }, nextBlockId: 1, nextRunId: 1 };
  const text = buildStatusPanel({
    tokenCount: 430_000,
    systemPromptTokens: 0,
    state: state as never,
    nudge: nudge as never,
    modelContextLimit: 1_000_000,
    unprunedTokens: 134_000,
  });
  assert.match(text, /Session-only \(compressed originals, est\.\): 110k — pruned from every request/);
});

test("topicFallback takes the first sentence segment, ≤30 chars", () => {
  assert.equal(topicFallback("Database migration steps failed twice."), "Database migration steps faile…");
  assert.equal(topicFallback('He said "hello". More text.'), 'He said "hello"');
  assert.equal(topicFallback("Short."), "Short");
});

test("topicFallback truncates long segments at 30 chars with ellipsis", () => {
  const out = topicFallback("A".repeat(50));
  assert.equal(out.length, 31);
  assert.ok(out.endsWith("…"));
});

test("formatCompactTokens matches host footer thresholds", () => {
  assert.equal(formatCompactTokens(999), "999");
  assert.equal(formatCompactTokens(9_500), "9.5k");
  assert.equal(formatCompactTokens(430_000), "430k");
  assert.equal(formatCompactTokens(1_500_000), "1.5M");
});
