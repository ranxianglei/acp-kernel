import { test } from "node:test";
import assert from "node:assert/strict";
import { syncBlocks } from "../src/sync.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

function msg(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: id };
}

function makeBlock(
  overrides: Partial<CompressionBlock> & { blockId: string },
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("syncBlocks deactivates blocks whose messages are all gone", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["gone1", "gone2"] }),
    makeBlock({ blockId: "b2", effectiveMessageIds: ["kept", "also-gone"] }),
  );

  const result = syncBlocks([msg("kept")], state);
  assert.deepEqual(result.deactivated, ["b1"]);
  assert.equal(result.state.blocks[0]!.active, false);
  assert.equal(result.state.blocks[1]!.active, true);
});

test("syncBlocks leaves blocks intact when at least one message remains", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["a", "b"] }),
  );
  const result = syncBlocks([msg("a")], state);
  assert.deepEqual(result.deactivated, []);
  assert.equal(result.state.blocks[0]!.active, true);
});

test("syncBlocks does not mutate input state", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["x"] }));
  syncBlocks([], state);
  assert.equal(state.blocks[0]!.active, true);
});

test("defaultConfig provides sensible production defaults", () => {
  const cfg = defaultConfig(200000);
  assert.equal(cfg.modelContextLimit, 200000);
  assert.equal(cfg.promotionThreshold, 5);
  assert.equal(cfg.truncate.threshold, 0.95);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.75);
  assert.equal(cfg.nudge.emergencyThresholdPct, 0.95);
  assert.ok(cfg.tiers.tier3Trigger > cfg.tiers.tier2Trigger);
});

test("defaultConfig has no gc namespace (GC removed)", () => {
  const cfg = defaultConfig(200000) as unknown as Record<string, unknown>;
  assert.equal(cfg["gc"], undefined, "gc config namespace must not exist");
});

test("defaultConfig applies overrides", () => {
  const cfg = defaultConfig(200000, { preserveRecentMessages: 20 });
  assert.equal(cfg.preserveRecentMessages, 20);
  assert.equal(cfg.modelContextLimit, 200000);
});

test("validateConfig flags invalid limits", () => {
  const cfg = defaultConfig(200000, { modelContextLimit: -1 } as never);
  assert.ok(validateConfig(cfg).some((e) => e.includes("modelContextLimit")));
});

test("validateConfig flags min > max nudge thresholds", () => {
  const base = defaultConfig(200000);
  base.nudge.minContextLimitPct = 0.8;
  base.nudge.maxContextLimitPct = 0.5;
  assert.ok(validateConfig(base).some((e) => e.includes("minContextLimitPct")));
});

test("validateConfig passes for default config", () => {
  assert.deepEqual(validateConfig(defaultConfig(200000)), []);
});

// Issue #46 scope: tier2GrowthMultiplier is intentionally left unvalidated.
type NudgeNumberField =
  | "growthRatio"
  | "growthFloor"
  | "growthCap"
  | "minGrowthFloor"
  | "minGrowthRatio"
  | "emergencyThresholdPct";

test("validateConfig rejects negative nudge growth values", () => {
  const cases: Array<{ field: NudgeNumberField; value: number }> = [
    { field: "growthRatio", value: -0.1 },
    { field: "growthFloor", value: -1 },
    { field: "minGrowthFloor", value: -1 },
    { field: "minGrowthRatio", value: -0.1 },
  ];
  for (const { field, value } of cases) {
    const cfg = defaultConfig(200000);
    cfg.nudge[field] = value;
    assert.ok(
      validateConfig(cfg).some((e) => e.includes(`nudge.${field}`)),
      `expected nudge.${field} to be rejected`,
    );
  }
});

test("validateConfig rejects non-finite nudge numbers", () => {
  const cases: Array<{ field: NudgeNumberField; value: number }> = [
    { field: "growthRatio", value: NaN },
    { field: "growthFloor", value: Infinity },
    { field: "growthCap", value: Infinity },
    { field: "minGrowthFloor", value: NaN },
    { field: "minGrowthRatio", value: Infinity },
    { field: "emergencyThresholdPct", value: NaN },
  ];
  for (const { field, value } of cases) {
    const cfg = defaultConfig(200000);
    cfg.nudge[field] = value;
    assert.ok(
      validateConfig(cfg).some((e) => e.includes(`nudge.${field}`)),
      `expected non-finite nudge.${field} to be rejected`,
    );
  }
});

test("validateConfig accepts zero for non-negative nudge fields", () => {
  const fields: NudgeNumberField[] = [
    "growthRatio",
    "growthFloor",
    "minGrowthFloor",
    "minGrowthRatio",
  ];
  for (const field of fields) {
    const cfg = defaultConfig(200000);
    cfg.nudge[field] = 0;
    assert.deepEqual(
      validateConfig(cfg),
      [],
      `expected nudge.${field}=0 to be valid`,
    );
  }
});

test("validateConfig rejects growthCap below growthFloor", () => {
  const cfg = defaultConfig(200000);
  cfg.nudge.growthFloor = 100;
  cfg.nudge.growthCap = 99;
  assert.ok(
    validateConfig(cfg).some((e) => e.includes("nudge.growthCap")),
  );
});

test("validateConfig accepts growthCap equal to growthFloor", () => {
  const cfg = defaultConfig(200000);
  cfg.nudge.growthFloor = 100;
  cfg.nudge.growthCap = 100;
  assert.deepEqual(validateConfig(cfg), []);
});

test("validateConfig rejects emergencyThresholdPct of 0", () => {
  const cfg = defaultConfig(200000);
  cfg.nudge.emergencyThresholdPct = 0;
  assert.ok(
    validateConfig(cfg).some((e) => e.includes("nudge.emergencyThresholdPct")),
  );
});

test("validateConfig rejects emergencyThresholdPct above 1", () => {
  const cfg = defaultConfig(200000);
  cfg.nudge.emergencyThresholdPct = 1.01;
  assert.ok(
    validateConfig(cfg).some((e) => e.includes("nudge.emergencyThresholdPct")),
  );
});

test("validateConfig accepts emergencyThresholdPct of 1", () => {
  const cfg = defaultConfig(200000);
  cfg.nudge.emergencyThresholdPct = 1;
  assert.deepEqual(validateConfig(cfg), []);
});

test("validateConfig does not reject finite ratios above 1", () => {
  const cfg = defaultConfig(200000);
  cfg.nudge.growthRatio = 2;
  cfg.nudge.minGrowthRatio = 2;
  assert.deepEqual(validateConfig(cfg), []);
});
