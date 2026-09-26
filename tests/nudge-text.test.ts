import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNudgeText } from "../src/nudge-text.js";
import { builtinSource, createPackResolver } from "../src/packs.js";
import type { NudgeDecision, CompressibleRange, BlockSpan } from "../src/types.js";

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

test("gentle mode: tail tip is conditional and licenses deferral (#1198)", () => {
  // The tail must not read as an unconditional "compress all ranges" directive —
  // #1198-class models obeyed it at 11% usage and folded files they still
  // needed. The tip teaches BATCHING under an explicit "if you compress",
  // and states that skipped ranges reappear later (no now-or-never pressure).
  // Emergency mode keeps its unconditional directive and must not inherit
  // this line.
  const gentle = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  assert.ok(gentle.text.includes("If you compress"), "tip must be conditional on the model choosing to compress");
  assert.ok(!gentle.text.includes("Compress all ranges in one call"), "unconditional compress-all directive must be gone");
  assert.ok(gentle.text.includes("they reappear in later nudges"), "skipped ranges must be framed as deferrable, not lost");
  const emergency = renderNudgeText(makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 } }));
  assert.ok(!emergency.text.includes("If you compress"), "emergency stays unconditional");
  assert.ok(emergency.text.includes("compress now"), "emergency keeps its mandatory directive");
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

test("over-limit uses pressure wording, not 'limit reached' (#312)", () => {
  const result = renderNudgeText(
    makeDecision({
      contextUsage: 0.85,
      breakdown: { overLimit: 1 },
    }),
  );
  assert.ok(result.text.includes("Context pressure high"), "pressure band must use the pressure header");
  assert.ok(!result.text.includes("Context limit reached"), "must not claim the limit is reached");
  assert.ok(!result.text.includes("85%"), "no usage percentage in the pressure band");
});

test("emergency keeps 'limit reached' wording and drops the pressure header (#312)", () => {
  const result = renderNudgeText(
    makeDecision({
      contextUsage: 0.99,
      breakdown: { overLimit: 1, emergencyOverride: 1 },
    }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(result.text.includes("Context limit reached"));
  assert.ok(!result.text.includes("Context pressure high"));
});

test("over-limit + tier 2: emergency voice, OVER-LIMIT trigger line (#312)", () => {
  const result = renderNudgeText(makeDecision({ tier: 2, breakdown: { overLimit: 1 } }));
  assert.equal(result.voice, "emergency");
  assert.ok(
    result.text.includes("[OVER-LIMIT — TIER 2 DISTILLATION] Context pressure high — distill now to reclaim tokens."),
  );
  assert.ok(!result.text.includes("Context limit reached"));
  assert.ok(!result.text.includes("not an overflow warning"), "tier branch must not lead with the gentle note in the pressure band");
});

test("emergency + tier 2 keeps the EMERGENCY trigger line (#312)", () => {
  const result = renderNudgeText(
    makeDecision({ tier: 2, breakdown: { overLimit: 1, emergencyOverride: 1 } }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(
    result.text.includes("[EMERGENCY — TIER 2 DISTILLATION] Context limit reached — distill NOW into a denser summary to reclaim tokens."),
  );
});

function makeSpans(n: number): BlockSpan[] {
  return Array.from({ length: n }, (_, i) => ({
    blockId: `b${i + 1}`,
    tier: 1,
    startRef: `m${String(i * 10 + 1).padStart(5, "0")}`,
    endRef: `m${String(i * 10 + 9).padStart(5, "0")}`,
  }));
}

test("gentle nudge renders active block map", () => {
  const result = renderNudgeText(makeDecision({ activeBlockSpans: makeSpans(2) }));
  assert.ok(
    result.text.includes("Active blocks (2): b1=m00001–m00009 · b2=m00011–m00019"),
    "should list each active block with its ref span",
  );
});

test("block map marks non-tier-1 blocks with tier suffix", () => {
  const spans = [{ ...makeSpans(1)[0]!, tier: 2 }];
  const result = renderNudgeText(makeDecision({ activeBlockSpans: spans }));
  assert.ok(result.text.includes("b1=m00001–m00009 t2"));
});

test("block map truncates beyond 8 blocks, keeping newest", () => {
  const result = renderNudgeText(makeDecision({ activeBlockSpans: makeSpans(10) }));
  assert.ok(result.text.includes("Active blocks (10): …+2 older · "), "should show hidden count");
  assert.ok(!result.text.includes("b1="), "oldest hidden blocks must not be listed");
  assert.ok(result.text.includes("b8="));
  assert.ok(result.text.includes("b10="));
});

test("no block map line when absent or empty", () => {
  const r1 = renderNudgeText(makeDecision());
  assert.ok(!r1.text.includes("Active blocks"), "absent activeBlockSpans → no line");
  const r2 = renderNudgeText(makeDecision({ activeBlockSpans: [] }));
  assert.ok(!r2.text.includes("Active blocks"), "empty activeBlockSpans → no line");
});

test("emergency nudge also renders block map", () => {
  const result = renderNudgeText(
    makeDecision({
      contextUsage: 0.99,
      breakdown: { emergencyOverride: 1 },
      activeBlockSpans: makeSpans(1),
    }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(result.text.includes("Active blocks (1): b1=m00001–m00009"));
});

test("range lines annotate user message count", () => {
  const ranges: CompressibleRange[] = [
    { startRef: "m00001", endRef: "m00005", count: 5, tokens: 2000, toolPct: 0.5, textPct: 0.5, userMsgs: 3 },
    { startRef: "m00010", endRef: "m00011", count: 2, tokens: 500, toolPct: 1, textPct: 0, userMsgs: 1 },
  ];
  const result = renderNudgeText(makeDecision({ compressibleRanges: ranges }));
  assert.ok(result.text.includes("· 3 user msgs"));
  assert.ok(result.text.includes("· 1 user msg"));
});

test("no user-msg annotation when count is zero or absent", () => {
  const result = renderNudgeText(makeDecision());
  assert.ok(!result.text.includes("user msg"), "makeRanges fixtures carry no userMsgs");
});

// #315 divergence guard: lean ships no nudgeSections, so all three bands must
// render through the shared (pack-free) renderNudgeText path, identical to default.

function resolveLeanPack() {
  const pack = createPackResolver([builtinSource]).resolve("lean");
  assert.ok(pack, "lean must resolve from the builtin registry");
  return pack!;
}

test("lean pack ships no nudgeSections — single shared render path (#315)", () => {
  const pack = resolveLeanPack();
  assert.equal(
    pack.surface.nudgeSections,
    undefined,
    "lean must leave nudgeSections untouched; tier guidance flows via the shared nudge text",
  );
});

test("lean pack renders all three bands byte-identical to default (#315)", () => {
  const pack = resolveLeanPack();
  const bands: { label: string; decision: NudgeDecision }[] = [
    { label: "gentle", decision: makeDecision({ contextUsage: 0.5 }) },
    { label: "over-limit", decision: makeDecision({ contextUsage: 0.85, breakdown: { overLimit: 1 } }) },
    { label: "emergency", decision: makeDecision({ contextUsage: 0.99, breakdown: { overLimit: 1, emergencyOverride: 1 } }) },
  ];
  for (const { label, decision } of bands) {
    const viaLean = renderNudgeText(decision, undefined, pack.surface.nudgeSections);
    const viaDefault = renderNudgeText(decision);
    assert.equal(viaLean.voice, viaDefault.voice, `${label}: voice must match default`);
    assert.equal(viaLean.text, viaDefault.text, `${label}: rendered text must be byte-identical to default`);
  }
});

test("lean pack: over-limit band renders pressureHeader wording, voice binary unchanged (#315)", () => {
  const pack = resolveLeanPack();
  const result = renderNudgeText(
    makeDecision({ contextUsage: 0.85, breakdown: { overLimit: 1 } }),
    undefined,
    pack.surface.nudgeSections,
  );
  assert.equal(result.voice, "emergency", "voice stays binary: pressure band maps to the emergency voice");
  assert.ok(result.text.includes("⚠️ Context pressure high"), "over-limit must use the pressure header");
  assert.ok(!result.text.includes("Context limit reached"), "must not claim the limit is reached");
});

test("lean pack: emergency band keeps limit-reached wording, voice binary unchanged (#315)", () => {
  const pack = resolveLeanPack();
  const result = renderNudgeText(
    makeDecision({ contextUsage: 0.99, breakdown: { overLimit: 1, emergencyOverride: 1 } }),
    undefined,
    pack.surface.nudgeSections,
  );
  assert.equal(result.voice, "emergency");
  assert.ok(result.text.includes("⚠️ Context limit reached"), "emergency must keep the limit-reached header");
  assert.ok(!result.text.includes("Context pressure high"), "emergency must not downshift to the pressure wording");
});

test("lean pack: gentle band keeps the efficiency note, voice stays gentle (#315)", () => {
  const pack = resolveLeanPack();
  const result = renderNudgeText(makeDecision({ contextUsage: 0.5 }), undefined, pack.surface.nudgeSections);
  assert.equal(result.voice, "gentle");
  assert.ok(result.text.includes("efficiency nudge"), "gentle band must keep the efficiency note");
  assert.ok(!result.text.includes("Context limit reached"));
  assert.ok(!result.text.includes("Context pressure high"));
});
