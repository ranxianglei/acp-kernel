import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPrompts } from "../src/prompts.js";
import {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
} from "../src/compression-rules.js";
import { renderNudgeText } from "../src/nudge-text.js";
import {
  buildCompressSystemPrompt,
  buildCompressTextSystemPrompt,
  buildCompressHybridSystemPrompt,
} from "../src/compress-tools.js";
import { LEAN_HOW_TO_COMPRESS } from "../src/packs.js";
import type { NudgeDecision, CompressibleRange } from "../src/types.js";

// #493 regression: pins the source-language contract in the canonical rule
// constants AND on every render path that delivers them to the model (nudge
// voices, system prompts, lean pack) — weakening the clause anywhere fails here.

const lower = (s: string): string => s.toLowerCase();

function hasAll(text: string, ...needles: string[]): boolean {
  const t = lower(text);
  return needles.every((n) => t.includes(n));
}

const CORE = ["primary language", "do not translate"];

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

test("shared philosophy requires source-language preservation", () => {
  assert.ok(
    hasAll(COMPRESS_PHILOSOPHY, ...CORE),
    `philosophy missing ${CORE.join(" / ")}`,
  );
});

test("T1 how-to-compress rules require source-language preservation", () => {
  assert.ok(
    hasAll(HOW_TO_COMPRESS_RULES, ...CORE),
    `T1 rules missing ${CORE.join(" / ")}`,
  );
  assert.ok(
    hasAll(
      HOW_TO_COMPRESS_RULES,
      "mixed-language",
      "identifiers",
      "exactly as written",
    ),
    "T1 rules must cover mixed-language passages and verbatim technical text",
  );
});

test("T2 distillation rules require source-language preservation", () => {
  assert.ok(
    hasAll(TIER2_DISTILL_RULES, ...CORE),
    `T2 rules missing ${CORE.join(" / ")}`,
  );
  assert.ok(
    hasAll(TIER2_DISTILL_RULES, "language of its source summaries"),
    "T2 rules must anchor the summary language to its sources",
  );
});

test("T3 condensation rules require source-language preservation", () => {
  assert.ok(
    hasAll(TIER3_CONDENSE_RULES, ...CORE),
    `T3 rules missing ${CORE.join(" / ")}`,
  );
  assert.ok(
    hasAll(TIER3_CONDENSE_RULES, "language of its source blocks"),
    "T3 rules must anchor the fact language to its sources",
  );
});

test("defaultPrompts carries the language contract on all four fields", () => {
  assert.equal(defaultPrompts.compressPhilosophy, COMPRESS_PHILOSOPHY);
  assert.equal(defaultPrompts.howToCompressRules, HOW_TO_COMPRESS_RULES);
  assert.equal(defaultPrompts.tier2DistillRules, TIER2_DISTILL_RULES);
  assert.equal(defaultPrompts.tier3CondenseRules, TIER3_CONDENSE_RULES);
  for (const [name, value] of Object.entries(defaultPrompts)) {
    assert.ok(hasAll(value, ...CORE), `${name} lost the language contract`);
  }
});

test("gentle nudge delivers the language contract (philosophy + T1)", () => {
  const result = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  assert.equal(result.voice, "gentle");
  assert.ok(hasAll(result.text, ...CORE));
});

test("emergency nudge delivers the language contract (philosophy + T1)", () => {
  const result = renderNudgeText(
    makeDecision({
      contextUsage: 0.99,
      breakdown: { emergencyOverride: 1 },
    }),
  );
  assert.equal(result.voice, "emergency");
  assert.ok(hasAll(result.text, ...CORE));
});

test("tier-2 nudge delivers the T2 language contract", () => {
  const result = renderNudgeText(makeDecision({ tier: 2 }));
  assert.ok(hasAll(result.text, ...CORE, "language of its source summaries"));
});

test("tier-3 nudge delivers the T3 language contract", () => {
  const result = renderNudgeText(makeDecision({ tier: 3 }));
  assert.ok(hasAll(result.text, ...CORE, "language of its source blocks"));
});

test("all three system-prompt builders deliver the language contract", () => {
  for (const [name, built] of [
    ["function", buildCompressSystemPrompt()],
    ["text", buildCompressTextSystemPrompt()],
    ["hybrid", buildCompressHybridSystemPrompt()],
  ] as const) {
    assert.ok(
      hasAll(built, ...CORE),
      `${name} system prompt lost the language contract`,
    );
  }
});

test("lean pack contract mirrors the language rule", () => {
  assert.ok(
    hasAll(LEAN_HOW_TO_COMPRESS, "primary language", "never translate"),
    "lean how-to-compress lost the language rule",
  );
});
