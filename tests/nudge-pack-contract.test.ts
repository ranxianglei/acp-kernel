import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinSource } from "../src/packs.js";
import { defaultPrompts, resolvePrompts } from "../src/prompts.js";
import { renderNudgeText } from "../src/nudge-text.js";

// Complements the non-tier parity contract in nudge-text.test.ts (#315):
// pins the TIER rendering path (T2/T3 trigger lines also gained band-specific
// wording in #312) and exercises the pack's prompts channel through
// resolvePrompts — so a lean surface that later ships kernel prompts or
// diverges tier lines fails here, not just in the non-tier tests.

const decision = (opts: { overLimit?: boolean; emergency?: boolean; tier?: 2 | 3 | null } = {}): Parameters<typeof renderNudgeText>[0] => ({
  shouldInject: true,
  reason: "test",
  compressibleRanges: [],
  protectedRanges: [],
  activeBlockSpans: [],
  contextUsage: 0.5,
  tier: opts.tier ?? null,
  breakdown: {
    usage: 0.5,
    growth: 100,
    growthReference: 1,
    effectiveThreshold: 0.75,
    nudgeGrowthTokens: 500,
    growthFloor: 200,
    hasPendingNudge: 0,
    overLimit: opts.overLimit || opts.emergency ? 1 : 0,
    emergencyOverride: opts.emergency ? 1 : 0,
    pendingT1: 0,
    pendingT2: 0,
    pendingT3: 0,
  },
  contextBreakdown: {
    system: 1000,
    tool: 2000,
    summaries: 0,
    code: 500,
    text: 300,
    growth: 100,
  },
  tierTargetBlocks: opts.tier
    ? [
        {
          blockId: "b1",
          tier: 1,
          effectiveMessageIds: ["m1", "m2"],
          compressedTokens: 2000,
          summary: "x".repeat(400),
          topic: "t",
        },
      ]
    : undefined,
});

function renderLean(opts: Parameters<typeof decision>[0] = {}) {
  const lean = builtinSource.resolve("lean");
  assert.ok(lean);
  return renderNudgeText(decision(opts), resolvePrompts(lean.surface.prompts), lean.surface.nudgeSections);
}

test("lean contributes no kernel prompts — rule overrides stay impossible without acknowledgeRisk (#412)", () => {
  const lean = builtinSource.resolve("lean");
  assert.ok(lean);
  assert.deepEqual(lean.surface.prompts ?? {}, {});
  const resolved = resolvePrompts(lean.surface.prompts);
  for (const key of ["compressPhilosophy", "howToCompressRules", "tier2DistillRules", "tier3CondenseRules"] as const) {
    assert.equal(resolved[key], defaultPrompts[key], `${key} must remain the kernel default under lean`);
  }
});

test("tier-2 trigger lines keep their band wording under the fully-resolved lean surface (#412)", () => {
  const over = renderLean({ tier: 2, overLimit: true });
  assert.equal(over.voice, "emergency");
  assert.ok(over.text.includes("[OVER-LIMIT — TIER 2 DISTILLATION] Context pressure high — distill now to reclaim tokens."));
  assert.ok(!over.text.includes("Context limit reached"));

  const emergency = renderLean({ tier: 2, emergency: true });
  assert.equal(emergency.voice, "emergency");
  assert.ok(emergency.text.includes("[EMERGENCY — TIER 2 DISTILLATION] Context limit reached — distill NOW into a denser summary to reclaim tokens."));
});

test("tier path renders byte-identical to default for every band (anti-divergence) (#412)", () => {
  const variants: Array<Parameters<typeof decision>[0]> = [
    { tier: 2 },
    { tier: 2, overLimit: true },
    { tier: 2, emergency: true },
    { tier: 3 },
    { tier: 3, overLimit: true },
    { tier: 3, emergency: true },
  ];
  for (const opts of variants) {
    assert.deepEqual(
      renderLean(opts).text,
      renderNudgeText(decision(opts)).text,
      `tier band diverged from default rendering for ${JSON.stringify(opts)}`,
    );
  }
});
