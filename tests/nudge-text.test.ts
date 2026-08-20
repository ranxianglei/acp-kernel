import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNudgeText } from "../src/nudge-text.js";
import type { NudgeDecision, CompressibleRange, CompressionBlock } from "../src/types.js";

function makeRanges(count: number): CompressibleRange[] {
  return Array.from({ length: count }, (_, i) => ({
    startRef: `m${String(i * 3 + 1).padStart(5, "0")}`,
    endRef: `m${String(i * 3 + 3).padStart(5, "0")}`,
    count: 3,
    tokens: 1000 * (i + 1),
    toolPct: 0.7,
    textPct: 0.3,
  }));
}

function makeDecision(overrides: Partial<NudgeDecision> = {}): NudgeDecision {
  return {
    shouldInject: true,
    reason: "test",
    compressibleRanges: makeRanges(3),
    contextUsage: 0.5,
    tier: null,
    breakdown: { emergencyOverride: 0 },
    ...overrides,
  };
}

test("gentle mode: voice and header text", () => {
  const result = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  assert.equal(result.voice, "gentle");
  assert.ok(result.text.includes("efficiency nudge"), "should contain gentle header");
  assert.ok(result.text.includes("not an overflow warning"), "should reassure it's not overflow");
});

test("emergency mode: voice and header text", () => {
  const result = renderNudgeText(
    makeDecision({
      contextUsage: 0.99,
      breakdown: { emergencyOverride: 1 },
    }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(result.text.includes("Context limit reached"), "should contain emergency header");
  assert.ok(result.text.includes("compress now"), "should demand compression");
});

test("gentle mode does NOT contain emergency language", () => {
  const result = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  assert.ok(!result.text.includes("MUST compress"), "gentle should not demand");
  assert.ok(!result.text.includes("⚠️"), "gentle should not have warning symbol");
});

test("emergency mode does NOT contain gentle language", () => {
  const result = renderNudgeText(
    makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 } }),
  );
  assert.ok(!result.text.includes("EFFICIENCY NUDGE"), "emergency should not be gentle");
  assert.ok(!result.text.includes("not an overflow warning"), "emergency should not reassure");
});

test("tier-2 distillation: text contains tier header", () => {
  const result = renderNudgeText(makeDecision({ tier: 2 }));
  assert.ok(result.text.includes("TIER 2"), "should contain tier-2 header");
  assert.ok(result.text.includes("Distill"), "should mention distillation");
});

test("tier-3 distillation: text contains tier header", () => {
  const result = renderNudgeText(makeDecision({ tier: 3 }));
  assert.ok(result.text.includes("TIER 3"), "should contain tier-3 header");
  assert.ok(result.text.includes("Condense"), "should mention condensation");
});

test("tier-2 distillation: guidance warns raw messages in span are absorbed", () => {
  const result = renderNudgeText(makeDecision({ tier: 2 }));
  assert.ok(result.text.includes("raw"), "should mention raw messages in span");
  assert.ok(result.text.includes("absorbed"), "should state raw messages are absorbed into the tier-2 block");
  assert.ok(result.text.includes("HOW TO COMPRESS"), "should direct raw messages to HOW TO COMPRESS rules");
});

test("tier-3 condensation: guidance warns raw messages in span are absorbed", () => {
  const result = renderNudgeText(makeDecision({ tier: 3 }));
  assert.ok(result.text.includes("raw"), "should mention raw messages in span");
  assert.ok(result.text.includes("absorbed"), "should state raw messages are absorbed into the tier-3 block");
  assert.ok(result.text.includes("HOW TO COMPRESS"), "should direct raw messages to HOW TO COMPRESS rules");
});

test("emergency + tier 2: emergency voice with distillation guidance", () => {
  const result = renderNudgeText(
    makeDecision({ tier: 2, breakdown: { emergencyOverride: 1 } }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(
    result.text.toLowerCase().includes("distill"),
    "should still carry distillation guidance",
  );
  assert.ok(result.text.includes("TIER 2"), "should still name the tier");
});

test("emergency + tier 3: emergency voice with condensation guidance", () => {
  const result = renderNudgeText(
    makeDecision({ tier: 3, breakdown: { emergencyOverride: 1 } }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(
    result.text.toLowerCase().includes("condense"),
    "should still carry condensation guidance",
  );
  assert.ok(result.text.includes("TIER 3"), "should still name the tier");
});

test("both modes include compressible ranges", () => {
  const gentle = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  const emergency = renderNudgeText(
    makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 } }),
  );

  for (const [label, result] of [["gentle", gentle], ["emergency", emergency]] as const) {
    assert.ok(result.text.includes("Compressible ranges"), `${label} should list ranges`);
    assert.ok(result.text.includes("m00001"), `${label} should contain range ref`);
    assert.ok(result.text.includes("1.0K") || result.text.includes("6.0K"), `${label} should show token estimate`);
  }
});

test("both modes include compression guide (KEEP/DROP)", () => {
  const gentle = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  const emergency = renderNudgeText(
    makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 } }),
  );

  for (const [label, result] of [["gentle", gentle], ["emergency", emergency]] as const) {
    assert.ok(result.text.includes("KEEP VERBATIM"), `${label} should include KEEP rules`);
    assert.ok(result.text.includes("DROP"), `${label} should include DROP rules`);
    assert.ok(result.text.includes("PRIORITY"), `${label} should include priority ordering`);
    assert.ok(result.text.includes("file paths"), `${label} should mention file paths rule`);
  }
});

test("empty compressible ranges handled gracefully", () => {
  const result = renderNudgeText(
    makeDecision({ compressibleRanges: [], contextUsage: 0.5 }),
  );
  assert.ok(result.text.includes("No specific ranges"), "should handle empty ranges");
});

test("percentage is NOT shown (only token amounts)", () => {
  const result = renderNudgeText(makeDecision({ contextUsage: 0.62 }));
  assert.ok(!result.text.includes("62%"), "should NOT show usage percentage");
});

test("dangerous flag appears in range listing", () => {
  const ranges: CompressibleRange[] = [
    {
      startRef: "m00001",
      endRef: "m00005",
      count: 5,
      tokens: 3000,
      toolPct: 0.5,
      textPct: 0.5,
      dangerous: true,
    },
  ];
  const result = renderNudgeText(makeDecision({ compressibleRanges: ranges }));
  assert.ok(result.text.includes("⚠️"), "should show dangerous flag");
});

test("over-limit renders with emergency voice (MAJOR-2 fix)", () => {
  const result = renderNudgeText(
    makeDecision({
      contextUsage: 0.85,
      breakdown: { overLimit: 1 },
    }),
  );
  assert.equal(result.voice, "emergency", "over-limit should use emergency voice, not gentle");
  assert.ok(!result.text.includes("not an overflow warning"), "should NOT contain gentle reassurance");
});

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1 as const,
    summary: "s".repeat(10000), // length/4 = 2500
    directMessageIds: ["m00001"],
    effectiveMessageIds: ["m00001"],
    directBlockIds: [],
    compressedTokens: 5000,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: true,
    ...overrides,
  };
}

test("tier-2 renderer uses precomputed tierTargetBlockStats, not length/4 (issue #45)", () => {
  const result = renderNudgeText(
    makeDecision({
      tier: 2,
      tierTargetBlocks: [makeBlock()],
      tierTargetBlockStats: [{ blockId: "b1", summaryTokens: 12345 }],
    }),
  );
  assert.ok(result.text.includes("12.3K"), "should display the precomputed summary token count");
  assert.ok(!result.text.includes("2.5K"), "must NOT fall back to length/4 when stats are present");
});

test("tier-2 renderer without stats keeps legacy length/4 behavior (compat)", () => {
  const result = renderNudgeText(
    makeDecision({ tier: 2, tierTargetBlocks: [makeBlock()] }),
  );
  assert.ok(result.text.includes("2.5K"), "legacy hand-built decisions still estimate via length/4");
});

test("tier-2 ASCII output unchanged when precomputed stats match the legacy estimate", () => {
  const block = makeBlock();
  const legacy = renderNudgeText(
    makeDecision({ tier: 2, tierTargetBlocks: [block] }),
  );
  const withStats = renderNudgeText(
    makeDecision({
      tier: 2,
      tierTargetBlocks: [block],
      tierTargetBlockStats: [{ blockId: "b1", summaryTokens: 2500 }],
    }),
  );
  assert.equal(withStats.text, legacy.text, "precomputed stats equal to the legacy estimate must not alter output");
  assert.equal(withStats.voice, legacy.voice, "voice must be identical as well");
});
