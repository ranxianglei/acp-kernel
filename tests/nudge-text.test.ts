import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNudgeText } from "../src/nudge-text.js";
import type { NudgeDecision, CompressibleRange } from "../src/types.js";
import { defaultPrompts } from "../src/prompts.js";
import {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
} from "../src/compression-rules.js";

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
    // decideNudge always populates this (src/compress.ts); keep the fixture realistic
    // so renders exercise the breakdown section like production nudges do.
    contextBreakdown: { system: 5_000, tool: 20_000, summaries: 2_000, code: 1_000, text: 3_000, total: 31_000, growth: 1_000 },
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

const SLIM = { includeGuidance: false } as const;

function allModes() {
  return [
    ["gentle", makeDecision({ contextUsage: 0.5 })],
    ["emergency", makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 } })],
    ["tier-2", makeDecision({ tier: 2 })],
    ["tier-3", makeDecision({ tier: 3 })],
  ] as const;
}

test("includeGuidance defaults to true and is backwards compatible (all modes)", () => {
  for (const [label, decision] of allModes()) {
    const defaultOut = renderNudgeText(decision);
    const explicitTrue = renderNudgeText(decision, defaultPrompts, { includeGuidance: true });
    const noOptions = renderNudgeText(decision, defaultPrompts);
    assert.equal(defaultOut.text, explicitTrue.text, `${label}: explicit true === default`);
    assert.equal(defaultOut.text, noOptions.text, `${label}: omitted options === default`);
  }
});

test("gentle + includeGuidance:false drops all four guidance texts, keeps dynamic chrome", () => {
  const result = renderNudgeText(makeDecision({ contextUsage: 0.5 }), defaultPrompts, SLIM);
  assert.ok(!result.text.includes(COMPRESS_PHILOSOPHY), "no philosophy");
  assert.ok(!result.text.includes(HOW_TO_COMPRESS_RULES), "no how-to-compress rules");
  assert.ok(!result.text.includes(TIER2_DISTILL_RULES), "no tier-2 rules");
  assert.ok(!result.text.includes(TIER3_CONDENSE_RULES), "no tier-3 rules");
  assert.ok(result.text.includes("efficiency nudge"), "keeps gentle header");
  assert.ok(result.text.includes("not an overflow warning"), "keeps reassurance line");
  assert.ok(result.text.includes("Compressible ranges"), "keeps range listing");
  assert.ok(result.text.includes("m00001"), "keeps range refs");
  assert.ok(result.text.includes("Compress all ranges in one call"), "keeps batch hint");
  assert.ok(!result.text.includes("\n\n\n"), "no stacked blank lines");
});

test("emergency + includeGuidance:false drops guidance, keeps call-shape example", () => {
  const result = renderNudgeText(
    makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 } }),
    defaultPrompts,
    SLIM,
  );
  assert.equal(result.voice, "emergency");
  assert.ok(!result.text.includes(COMPRESS_PHILOSOPHY), "no philosophy");
  assert.ok(!result.text.includes(HOW_TO_COMPRESS_RULES), "no how-to-compress rules");
  assert.ok(result.text.includes("Context limit reached"), "keeps emergency header");
  assert.ok(result.text.includes('Only use IDs from visible messages above'), "keeps ID warning");
  assert.ok(result.text.includes('"topic": "..."'), "keeps JSON call-shape example");
  assert.ok(result.text.includes("Compressible ranges"), "keeps range listing");
  assert.ok(!result.text.includes("\n\n\n"), "no stacked blank lines");
});

test("tier-2 + includeGuidance:false drops how-to-compress + tier rules, keeps target list", () => {
  const result = renderNudgeText(makeDecision({ tier: 2 }), defaultPrompts, SLIM);
  assert.ok(!result.text.includes(COMPRESS_PHILOSOPHY), "no philosophy");
  assert.ok(!result.text.includes(HOW_TO_COMPRESS_RULES), "no how-to-compress rules");
  assert.ok(!result.text.includes(TIER2_DISTILL_RULES), "no tier-2 rules");
  assert.ok(!result.text.includes(TIER3_CONDENSE_RULES), "no tier-3 rules");
  assert.ok(result.text.includes("TIER 2"), "keeps tier trigger line");
  assert.ok(result.text.includes("Target blocks"), "keeps target block list");
  assert.ok(result.text.includes("Example: compress("), "keeps example call");
  assert.ok(!result.text.includes("\n\n\n"), "no stacked blank lines");
});

test("tier-3 + includeGuidance:false drops how-to-compress + tier rules, keeps target list", () => {
  const result = renderNudgeText(makeDecision({ tier: 3 }), defaultPrompts, SLIM);
  assert.ok(!result.text.includes(COMPRESS_PHILOSOPHY), "no philosophy");
  assert.ok(!result.text.includes(HOW_TO_COMPRESS_RULES), "no how-to-compress rules");
  assert.ok(!result.text.includes(TIER2_DISTILL_RULES), "no tier-2 rules");
  assert.ok(!result.text.includes(TIER3_CONDENSE_RULES), "no tier-3 rules");
  assert.ok(result.text.includes("TIER 3"), "keeps tier trigger line");
  assert.ok(result.text.includes("Target blocks"), "keeps target block list");
  assert.ok(!result.text.includes("\n\n\n"), "no stacked blank lines");
});

test("default tier nudges still embed how-to-compress + only the active tier's rules", () => {
  const t2 = renderNudgeText(makeDecision({ tier: 2 }));
  assert.ok(t2.text.includes(HOW_TO_COMPRESS_RULES));
  assert.ok(t2.text.includes(TIER2_DISTILL_RULES));
  assert.ok(!t2.text.includes(TIER3_CONDENSE_RULES), "tier-2 nudge must not carry tier-3 rules");
  const t3 = renderNudgeText(makeDecision({ tier: 3 }));
  assert.ok(t3.text.includes(HOW_TO_COMPRESS_RULES));
  assert.ok(t3.text.includes(TIER3_CONDENSE_RULES));
  assert.ok(!t3.text.includes(TIER2_DISTILL_RULES), "tier-3 nudge must not carry tier-2 rules");
});

test("includeGuidance:false is materially smaller than the full nudge", () => {
  for (const [label, decision] of allModes()) {
    const full = renderNudgeText(decision).text.length;
    const slim = renderNudgeText(decision, defaultPrompts, SLIM).text.length;
    assert.ok(slim < full / 2, `${label}: slim (${slim}) should be under half of full (${full})`);
  }
});
