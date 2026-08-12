import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPrompts, resolvePrompts } from "../src/prompts.js";
import { renderNudgeText } from "../src/nudge-text.js";
import {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
} from "../src/compression-rules.js";
import type { NudgeDecision, CompressibleRange } from "../src/types.js";

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

test("defaultPrompts mirrors the verbatim rule constants", () => {
  assert.equal(defaultPrompts.compressPhilosophy, COMPRESS_PHILOSOPHY);
  assert.equal(defaultPrompts.howToCompressRules, HOW_TO_COMPRESS_RULES);
  assert.equal(defaultPrompts.tier2DistillRules, TIER2_DISTILL_RULES);
  assert.equal(defaultPrompts.tier3CondenseRules, TIER3_CONDENSE_RULES);
});

test("resolvePrompts with no overrides returns the defaults", () => {
  const p = resolvePrompts();
  assert.equal(p.compressPhilosophy, COMPRESS_PHILOSOPHY);
  assert.equal(p.howToCompressRules, HOW_TO_COMPRESS_RULES);
});

test("resolvePrompts with empty overrides does not throw (no keys changed)", () => {
  const p = resolvePrompts({});
  assert.equal(p.compressPhilosophy, COMPRESS_PHILOSOPHY);
});

test("resolvePrompts throws when overriding without acknowledgeRisk", () => {
  assert.throws(
    () => resolvePrompts({ compressPhilosophy: "custom" }),
    /acknowledgeRisk/,
  );
});

test("resolvePrompts lists the offending keys in the error", () => {
  assert.throws(
    () => resolvePrompts({ howToCompressRules: "x", tier2DistillRules: "y" }),
    /howToCompressRules.*tier2DistillRules|tier2DistillRules.*howToCompressRules/,
  );
});

test("resolvePrompts applies overrides when acknowledgeRisk is true", () => {
  const p = resolvePrompts(
    { compressPhilosophy: "CUSTOM-PHILO", tier3CondenseRules: "CUSTOM-T3" },
    { acknowledgeRisk: true },
  );
  assert.equal(p.compressPhilosophy, "CUSTOM-PHILO");
  assert.equal(p.tier3CondenseRules, "CUSTOM-T3");
  assert.equal(p.howToCompressRules, HOW_TO_COMPRESS_RULES);
  assert.equal(p.tier2DistillRules, TIER2_DISTILL_RULES);
});

test("renderNudgeText uses default prompts when called with one arg (back-compat)", () => {
  const result = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  assert.ok(result.text.includes("Compression Philosophy:"));
  assert.ok(result.text.includes("HOW TO COMPRESS"));
});

test("renderNudgeText reflects a custom compressPhilosophy in gentle mode", () => {
  const prompts = resolvePrompts(
    { compressPhilosophy: "UNIQUE-MARKER-PHILOSOPHY" },
    { acknowledgeRisk: true },
  );
  const result = renderNudgeText(makeDecision({ contextUsage: 0.5 }), prompts);
  assert.ok(result.text.includes("UNIQUE-MARKER-PHILOSOPHY"));
  assert.ok(!result.text.includes("Compression Philosophy:"));
});

test("renderNudgeText reflects custom rules in emergency mode", () => {
  const prompts = resolvePrompts(
    { howToCompressRules: "UNIQUE-MARKER-HOWTO" },
    { acknowledgeRisk: true },
  );
  const result = renderNudgeText(
    makeDecision({ contextUsage: 0.99, breakdown: { emergencyOverride: 1 } }),
    prompts,
  );
  assert.equal(result.voice, "emergency");
  assert.ok(result.text.includes("UNIQUE-MARKER-HOWTO"));
});

test("renderNudgeText reflects custom tier rules in tier-2 mode", () => {
  const prompts = resolvePrompts(
    { tier2DistillRules: "UNIQUE-MARKER-T2" },
    { acknowledgeRisk: true },
  );
  const result = renderNudgeText(makeDecision({ tier: 2 }), prompts);
  assert.ok(result.text.includes("UNIQUE-MARKER-T2"));
});
