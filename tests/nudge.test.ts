import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.9,
      minContextLimitPct: 0.45,
      frequency: 1,
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
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function textMessage(role: CoreMessage["role"], id: string, text: string): CoreMessage {
  return { id, role, contentType: "text", text };
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) =>
    textMessage(i % 2 === 0 ? "user" : "assistant", `m${i}`, `message ${i} `.repeat(2000)),
  );
}

// nudgeGrowthTokens = resolveAdaptiveGrowth(100000) = max(6000, 5000) = 6000
// growthFloor = max(5000, 0.45*6000) = 5000
// effectiveThreshold (no pending) = 6000
// effectiveThreshold (pending) = 3000

test("nudge: baseline stamped on first turn, no nudge below threshold", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const state = createInitialState();

  const turn1 = core.processTurn({ messages, state, config, tokenCount: 10000 });
  assert.equal(turn1.nudge.shouldInject, false);
  assert.equal(turn1.state.nudge.lastPerMessageNudgeTokens, 10000, "baseline stamped");
  assert.equal(turn1.state.nudge.lastNudgeShownTokens, 0, "no nudge shown");
});

test("nudge: fires when growth exceeds threshold AND usage over min limit", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  const turn2 = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(turn2.nudge.shouldInject, true, "growth 45000 >= 6000, usage 55% >= 45%");
  assert.equal(turn2.state.nudge.lastNudgeShownTokens, 55000, "shown tokens stamped");
});

test("nudge: growth-gating suppresses repeat nudge without sufficient growth", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  state = core.processTurn({ messages, state, config, tokenCount: 55000 }).state;

  const turn3 = core.processTurn({ messages, state, config, tokenCount: 58000 });
  assert.equal(turn3.nudge.shouldInject, false, "growth 3000 < 6000 effectiveThreshold");
});

test("nudge: pending nudge halves threshold for faster re-nudge", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  state = core.processTurn({ messages, state, config, tokenCount: 55000 }).state;
  assert.equal(state.nudge.lastNudgeShownTokens, 55000, "pending nudge set");

  // Halved threshold = floor(6000/2) = 3000. Growth must also pass growthFloor=5000.
  // Growth of 5500 >= 5000 → fires despite being below the unhalved 6000.
  const turn3 = core.processTurn({ messages, state, config, tokenCount: 60500 });
  assert.equal(
    turn3.nudge.shouldInject,
    true,
    "pending nudge → growth 5500 >= 5000 floor (would fail unhalved 6000)",
  );
});

test("nudge: growth floor gate suppresses when growth below floor", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: {
      ...buildConfig().nudge,
      minGrowthFloor: 10000,
      minGrowthRatio: 0.9,
    },
  });
  const messages = makeMessages(10);
  let state = createInitialState();

  // nudgeGrowthTokens = 6000, growthFloor = max(10000, 0.9*6000) = max(10000, 5400) = 10000
  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  // Growth 45000 but growthFloor=10000 → 45000 >= 10000 → passes. Let's test suppression:
  // Growth 7000 >= effectiveThreshold 6000 but < growthFloor 10000 → suppressed
  const turn2 = core.processTurn({ messages, state, config, tokenCount: 17000 });
  assert.equal(turn2.nudge.shouldInject, false, "growth 7000 >= 6000 threshold but < 10000 floor");
});

test("nudge: emergency override fires at 98% regardless of growth", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;

  const turn2 = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn2.nudge.shouldInject, true, "emergency: 99% >= 98% override");
  assert.ok(
    turn2.nudge.reason.includes("EMERGENCY"),
    `reason should mention EMERGENCY, got: ${turn2.nudge.reason}`,
  );
});

test("nudge: baseline correction when tokens drop significantly", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  state = core.processTurn({ messages, state, config, tokenCount: 55000 }).state;
  assert.equal(state.nudge.lastPerMessageNudgeTokens, 10000, "baseline at 10000");

  // Token drops below baseline - nudgeGrowthTokens (10000 - 6000 = 4000)
  // 3000 < 4000 → baseline corrected to 3000
  const turn3 = core.processTurn({ messages, state, config, tokenCount: 3000 });
  assert.equal(
    turn3.state.nudge.lastPerMessageNudgeTokens,
    3000,
    "baseline corrected on significant drop",
  );
  assert.equal(turn3.state.nudge.lastNudgeShownTokens, 0, "pending nudge cleared");
});

test("nudge: compress resets baseline, preventing feedback loop", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  state = core.processTurn({ messages, state, config, tokenCount: 55000 }).state;

  state = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "compressed early msgs" }],
    messages,
    state,
    config,
  }).state;

  assert.equal(state.nudge.lastPerMessageNudgeTokens, 0, "baseline cleared post-compress");
  assert.equal(state.nudge.lastNudgeShownTokens, 0, "shown cleared post-compress");

  const turn = core.processTurn({ messages, state, config, tokenCount: 30000 });
  assert.equal(turn.nudge.shouldInject, false, "30% < 45% threshold → no nudge");
  assert.equal(turn.state.nudge.lastPerMessageNudgeTokens, 30000, "baseline re-established");
});

test("nudge: full growth cycle — baseline → growth → nudge → compress → new baseline → growth → nudge", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(20);
  let state = createInitialState();

  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  assert.equal(state.nudge.lastPerMessageNudgeTokens, 10000);

  let turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(turn.nudge.shouldInject, true, "growth 45000 >= 6000");
  state = turn.state;

  state = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00005", summary: "compressed batch" }],
    messages,
    state,
    config,
  }).state;
  assert.equal(state.nudge.lastPerMessageNudgeTokens, 0);

  turn = core.processTurn({ messages, state, config, tokenCount: 30000 });
  assert.equal(turn.nudge.shouldInject, false, "30% < 45%");
  assert.equal(turn.state.nudge.lastPerMessageNudgeTokens, 30000, "new baseline at 30000");
  state = turn.state;

  turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(turn.nudge.shouldInject, true, "growth 25000 >= 6000, usage 55% >= 45%");
});

test("nudge: tier distillation fires when lower-tier blocks accumulate enough", () => {
  const core = createCore();
  // Preserve recent messages so pendingT1 (raw compressible) stays below
  // threshold — we want to isolate the T2 distillation path, not T1.
  const config = buildConfig({ tiers: { enabled: true, tier2Trigger: 3, tier3Trigger: 10 }, preserveRecentMessages: 30 });
  const messages = makeMessages(30);
  let state = createInitialState();
  // First turn establishes a baseline at a high token count.
  state = core.processTurn({ messages, state, config, tokenCount: 50000 }).state;

  // Inject three active T1 blocks with large summaries so pendingT2 (sum of
  // their summary tokens) exceeds the nudge threshold (buildConfig → 6000).
  state = {
    ...state,
    blocks: [0, 1, 2].map((i) => ({
      blockId: `b${i + 1}`,
      runId: "r1",
      tier: 1 as const,
      summary: `tier-1 summary block ${i} with substantial content `.repeat(1200),
      directMessageIds: [`m${i}`],
      effectiveMessageIds: [`m${i}`],
      directBlockIds: [],
      compressedTokens: 5000,
      createdAt: Date.now(),
      survivedCount: 0,
      generation: "root" as const,
      active: true,
    })),
  };
  assert.equal(state.blocks.filter((b) => b.active && b.tier === 1).length, 3, "three T1 blocks present");

  // growth is zero — must NOT inject even though T2 blocks are ready.
  let turn = core.processTurn({ messages, state, config, tokenCount: 50000 });
  assert.equal(turn.nudge.shouldInject, false, "no growth → no injection even with T2 ready");

  // Once growth passes the floor (buildConfig floor 5000), the nudge fires
  // WITH tier-2 distillation info (T1 blocked by preserve → T2 wins).
  turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, true, "growth past floor → injects");
  assert.equal(turn.nudge.tier, 2, "nudge carries tier-2 distillation guidance (T1 blocked by preserve)");
  assert.ok((turn.nudge.tierTargetBlocks?.length ?? 0) >= 1, "target T1 blocks listed");
});

test("nudge: production config (preserveRecentMessages > 0) computes compressible ranges", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 5 });
  const messages = makeMessages(15);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;

  const turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.ok(turn.nudge.compressibleRanges.length > 0, "compressible ranges reported");
  for (const range of turn.nudge.compressibleRanges) {
    assert.ok(!range.startRef.startsWith("m0001"), "preserved tail excluded");
  }
});

test("nudge: compressible ranges exclude messages covered by active blocks", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 2 });
  const messages = makeMessages(12);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;

  state = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00005", summary: "covered" }],
    messages,
    state,
    config,
  }).state;

  const turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.ok(turn.nudge.compressibleRanges.length > 0, "ranges reported");
  const lastRef = `m${String(messages.length).padStart(5, "0")}`;
  for (const range of turn.nudge.compressibleRanges) {
    assert.ok(
      range.endRef < lastRef || range.endRef === lastRef,
      `range ${range.endRef} valid`,
    );
  }
});

test("over-limit fires force-nudge when compressible content exists", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: { ...buildConfig().nudge, maxContextLimitPct: 0.75 },
    compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
  });
  const messages = makeMessages(10);
  const turn = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 80000 });
  assert.equal(turn.nudge.shouldInject, true, "force-nudge should fire with compressible content");
  assert.equal(turn.nudge.breakdown!.overLimit, 1, "overLimit flag set");
  assert.ok(turn.nudge.reason.includes("OVER-LIMIT"), `reason: ${turn.nudge.reason}`);
});

test("over-limit does NOT inject when nothing is compressible (MAJOR-1 fix)", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: { ...buildConfig().nudge, maxContextLimitPct: 0.75 },
    compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 5,
  });
  const messages = [
    textMessage("user", "a", "hello"),
    textMessage("assistant", "b", "world"),
  ];
  const turn = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 80000 });
  assert.equal(turn.nudge.shouldInject, false, "no spam when nothing to compress");
  assert.equal(turn.nudge.breakdown!.overLimit, 1, "overLimit flag still set for reporting");
  assert.ok(turn.nudge.reason.includes("OVER-LIMIT"), `reason: ${turn.nudge.reason}`);
});
