/**
 * Regression: acp-kernel#379 — count-triggered tier distillation fired with
 * nothing to reclaim (block count is not a need signal; every needless
 * distillation rewrites the rendered wire from the fold anchor onward and
 * invalidates the prefix cache far beyond the reclaimed tokens — root cause
 * of billion-context#1249 cache-hit oscillation). Fix: defaults effectively
 * off (1000/2000), the #238 usage floor deleted from the count paths, and
 * tierActionHint agreeing (pure count, both channels default-off).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(100_000),
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    ...overrides,
  };
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) =>
    msg(
      `m${i}`,
      `message ${i} `.repeat(2000),
      i % 2 === 0 ? "user" : "assistant",
    ),
  );
}

function t1Blocks(anchorIds: string[], summaryChars: number) {
  return anchorIds.map((effId, i) => ({
    blockId: `b${i + 1}`,
    runId: "r1",
    tier: 1 as const,
    summary: "x".repeat(summaryChars),
    directMessageIds: [effId],
    effectiveMessageIds: [effId],
    directBlockIds: [],
    compressedTokens: summaryChars,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: true,
  }));
}

test("defaults: tier count triggers are effectively off (1000/2000) (#379)", () => {
  const cfg = defaultConfig(100_000);
  assert.equal(cfg.tiers.enabled, true);
  assert.equal(cfg.tiers.tier2Trigger, 1000);
  assert.equal(cfg.tiers.tier3Trigger, 2000);
});

test("nudge: 5 tiny T1 blocks do NOT trigger distillation under default config (#379)", () => {
  const core = createCore();
  const base = defaultConfig(100_000);
  const cfg = config({
    nudge: { ...base.nudge, frequency: 1, minGrowthFloor: 5000 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 30,
  });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: 30_000,
  }).state;
  state = {
    ...state,
    blocks: t1Blocks(["m1", "m2", "m3", "m4", "m5"], 400),
  };
  // 40k / 100k = 40% (below the 45% band), growth 10k >= 5k: the maintainer's
  // omp-session shape — steady usage, five condensed blocks, nothing to reclaim
  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 40_000,
  });
  assert.equal(turn.nudge.shouldInject, false, `reason: ${turn.nudge.reason}`);
  assert.doesNotMatch(turn.nudge.reason ?? "", /tier2Trigger/);
  assert.doesNotMatch(turn.nudge.reason ?? "", /tier3Trigger/);
  assert.doesNotMatch(turn.nudge.reason ?? "", /usage-gated/);
});

function makeSession(nMessages: number) {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = [];
  for (let i = 1; i <= nMessages; i++) {
    const id = `msg${String(i).padStart(4, "0")}`;
    messages.push(
      msg(
        id,
        `${id} work content `.repeat(10),
        i % 2 === 1 ? "user" : "assistant",
      ),
    );
  }
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return { core, state, messages };
}

function seedT1Blocks(
  state: ReturnType<typeof createInitialState>,
  count: number,
) {
  for (let i = 1; i <= count; i++) {
    state.blocks.push({
      blockId: `b${i}`,
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: `s${i}`,
      directMessageIds: [`x${i}`],
      effectiveMessageIds: [`x${i}`],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    });
  }
  state.nextBlockId = count + 1;
}

test("receipt: already-compressed error omits the tier-distillation hint under default config (#379)", () => {
  const { core, state, messages } = makeSession(30);
  seedT1Blocks(state, 4);

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00020", summary: "work recap" }],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 0,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });
  assert.equal(after.blocks.length, 5);

  const pruned = prune(messages, after);
  const retry = core.applyCompression({
    ranges: [{ startRef: "m00018", endRef: "m00020", summary: "retry slice" }],
    messages: pruned,
    state: after,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 1);
  assert.match(
    retry.result.errors[0]!,
    /Requested range\(s\) already compressed \(e\.g\. m00018\.\.m00020\)/,
  );
  // 5 active tier-1 blocks < default tier2Trigger 1000: the hint channel
  // (which escaped the #238 sweep) stays silent by default
  assert.doesNotMatch(
    retry.result.errors[0]!,
    /Tier distillation is actionable/,
  );
});
