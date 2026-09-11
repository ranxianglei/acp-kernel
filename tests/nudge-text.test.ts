import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNudgeText, formatBlockLedger } from "../src/nudge-text.js";
import type { NudgeDecision, CompressibleRange, CompressionBlock, MessageRefMap } from "../src/types.js";

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

function makeBlock(blockId: string, rawIds: string[], overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId,
    runId: "r1",
    tier: 1,
    summary: "summary",
    directMessageIds: rawIds,
    effectiveMessageIds: rawIds,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

function makeRefMap(pairs: Array<[rawId: string, ref: string]>): MessageRefMap {
  const byRaw: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  for (const [rawId, ref] of pairs) {
    byRaw[rawId] = ref;
    byRef[ref] = rawId;
  }
  return { byRaw, byRef };
}

function rangeRefs(start: number, end: number): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = start; i <= end; i++) {
    pairs.push([`raw-${i}`, `m${String(i).padStart(5, "0")}`]);
  }
  return pairs;
}

test("block ledger: gentle nudge shows active block id → ref span map (#251)", () => {
  const refs = makeRefMap([...rangeRefs(1, 43), ...rangeRefs(57, 78)]);
  const blocks = [makeBlock("b1", rangeRefs(1, 43).map(([r]) => r)), makeBlock("b2", rangeRefs(57, 78).map(([r]) => r))];
  const result = renderNudgeText(makeDecision({ activeBlocks: blocks, messageRefs: refs }));
  assert.ok(result.text.includes("Blocks: b1=m00001–m00043 · b2=m00057–m00078"), "should contain full block map");
  assert.ok(
    result.text.indexOf("Blocks:") > result.text.indexOf("Compressible ranges"),
    "ledger should appear after the ranges section",
  );
});

test("block ledger: single-message block renders bare ref without en-dash", () => {
  const refs = makeRefMap([["only", "m00009"]]);
  const blocks = [makeBlock("b1", ["only"])];
  assert.equal(formatBlockLedger(blocks, refs), "Blocks: b1=m00009");
});

test("block ledger: tier-2/tier-3 blocks annotated with tier", () => {
  const refs = makeRefMap(rangeRefs(1, 78));
  const t2 = makeBlock("b3", rangeRefs(1, 78).map(([r]) => r), { tier: 2 });
  const t3 = makeBlock("b4", rangeRefs(1, 78).map(([r]) => r), { tier: 3 });
  assert.equal(
    formatBlockLedger([t2, t3], refs),
    "Blocks: b3=tier2(m00001–m00078) · b4=tier3(m00001–m00078)",
  );
  const nudge = renderNudgeText(
    makeDecision({ tier: 2, activeBlocks: [t2], messageRefs: refs }),
  );
  assert.ok(nudge.text.includes("b3=tier2(m00001–m00078)"), "tier nudge should carry the ledger too");
});

test("block ledger: truncates to newest entries with older count", () => {
  const pairs: Array<[string, string]> = [];
  const blocks: CompressionBlock[] = [];
  for (let i = 1; i <= 11; i++) {
    const ref = `m${String(i * 10).padStart(5, "0")}`;
    pairs.push([`raw-${i}`, ref]);
    blocks.push(makeBlock(`b${i}`, [`raw-${i}`]));
  }
  const expected =
    "Blocks (+3 older): b4=m00040 · b5=m00050 · b6=m00060 · b7=m00070 · b8=m00080 · b9=m00090 · b10=m00100 · b11=m00110";
  assert.equal(formatBlockLedger(blocks, makeRefMap(pairs)), expected);
  assert.ok(!expected.includes("b1="), "oldest truncated entries must be dropped");
});

test("block ledger: no line when there are no blocks or nothing resolvable", () => {
  assert.equal(formatBlockLedger([]), "");
  const unresolvable = makeBlock("b1", ["ghost"]);
  assert.equal(formatBlockLedger([unresolvable], makeRefMap([])), "");
  const result = renderNudgeText(makeDecision({ activeBlocks: [] }));
  assert.ok(!result.text.includes("Blocks:"), "no ledger line without blocks");
});

test("block ledger: falls back to stored spec span only when it parses as m-refs", () => {
  const orphan = makeBlock("b1", ["ghost"], { startRef: "m00010", endRef: "m00020" });
  assert.equal(formatBlockLedger([orphan], makeRefMap([])), "Blocks: b1=m00010–m00020");
  const blockBoundarySpec = makeBlock("b2", ["ghost"], { startRef: "b1", endRef: "b3" });
  assert.equal(formatBlockLedger([blockBoundarySpec], makeRefMap([])), "");
});

test("block ledger: BLOCKED refs are skipped, remaining ids still spanned", () => {
  const refs = makeRefMap([["blocked", "BLOCKED"], ["a", "m00005"], ["b", "m00007"]]);
  const block = makeBlock("b1", ["blocked", "a", "b"]);
  assert.equal(formatBlockLedger([block], refs), "Blocks: b1=m00005–m00007");
  const allBlocked = makeBlock("b2", ["blocked"]);
  assert.equal(formatBlockLedger([allBlocked], refs), "");
});

test("block ledger: appears in emergency nudge after ranges", () => {
  const refs = makeRefMap(rangeRefs(1, 43));
  const blocks = [makeBlock("b1", rangeRefs(1, 43).map(([r]) => r))];
  const result = renderNudgeText(
    makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 }, activeBlocks: blocks, messageRefs: refs }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(result.text.includes("Blocks: b1=m00001–m00043"), "emergency nudge should carry the ledger");
  assert.ok(result.text.indexOf("Blocks:") > result.text.indexOf("Compressible ranges"));
});
