import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { SUMMARY_HEADER, prune } from "../src/prune.js";
import type {
  CompressionBlock,
  CompressionState,
  Config,
  CoreMessage,
} from "../src/types.js";

// #489: the pre-fix unconditional first-user pin voided fold coverage whenever
// a covered message became the view's first user (divergent resend or direct
// opening fold) — syncBlocks kept the block active while rebuildMessages kept
// the covered payload verbatim on every turn. The pin is now conditional: a
// covered first user drops when another user survives behind it, and keeps the
// legacy behavior in degenerate shapes where no user would lead.

function msg(
  id: string,
  role: CoreMessage["role"] = "user",
  text = id,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function makeBlock(
  overrides: Partial<CompressionBlock> & { blockId: string },
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "the summary",
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

function stateCovering(ids: string[]): CompressionState {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ids }));
  return state;
}

const renderedSummary = (): CoreMessage => ({
  id: "acp_summary_b1",
  role: "system",
  contentType: "text",
  text: `${SUMMARY_HEADER}\nthe summary`,
});

test("#489 unit: covered first user drops when an uncovered user survives behind it", () => {
  const result = prune(
    [msg("u1"), msg("u2"), msg("u3")],
    stateCovering(["u1", "u2"]),
    { injectSummaries: false },
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ["u3"],
  );
});

test("#489 unit: covered first user skips covered followers when finding the surviving leader", () => {
  const result = prune(
    [msg("u1"), msg("u2"), msg("u3"), msg("u4")],
    stateCovering(["u1", "u2", "u3"]),
    { injectSummaries: false },
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ["u4"],
  );
});

test("#489 unit: covered first user drops past a rendered summary (summaries never lead)", () => {
  const result = prune(
    [msg("u1"), renderedSummary(), msg("u2")],
    stateCovering(["u1"]),
    { injectSummaries: false },
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ["acp_summary_b1", "u2"],
  );
});

test("#489 unit: covered first user stays pinned when the earliest survivor is an assistant (degenerate)", () => {
  const result = prune(
    [msg("u1"), msg("a1", "assistant")],
    stateCovering(["u1"]),
    { injectSummaries: false },
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ["u1", "a1"],
  );
});

test("#489 unit: covered first user stays pinned when nothing survives behind it (degenerate)", () => {
  const result = prune([msg("u1")], stateCovering(["u1"]), {
    injectSummaries: false,
  });
  assert.deepEqual(
    result.map((m) => m.id),
    ["u1"],
  );
});

test("#489 unit: uncovered first user always survives", () => {
  const result = prune(
    [msg("u1"), msg("a1", "assistant")],
    stateCovering(["a1"]),
    { injectSummaries: false },
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ["u1"],
  );
});

test("#489 unit: sub-id coverage drops the covered base first user (#231)", () => {
  const result = prune(
    [msg("h_abc"), msg("h_def")],
    stateCovering(["h_abc#r0"]),
    { injectSummaries: false },
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ["h_def"],
  );
});

function config(): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
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
    compress: {
      minCompressRange: 500,
      maxSummaryLength: 20000,
      minSummaryLength: 10,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  };
}

const tokenCount = (t: string) => Math.ceil(t.length / 4);

test("#489 pipeline: divergent resend — folded message becomes first user (A/B)", () => {
  const core = createCore();
  const seed = msg("seed", "user", "seed prompt");
  const sentinel = msg(
    "sentinel",
    "user",
    `SENTINEL-PAYLOAD ${"x".repeat(4096)}`,
  );
  const tail = [msg("u3"), msg("u4"), msg("u5")];
  const full = [seed, sentinel, ...tail];

  let state = core.processTurn({
    messages: full,
    state: createInitialState(),
    config: config(),
    tokenCount,
  }).state;

  const ref = state.messageRefs.byRaw["sentinel"]!;
  const res = core.applyCompression({
    state,
    messages: full,
    config: config(),
    ranges: [{ startRef: ref, endRef: ref, summary: "s".repeat(400) }],
  });
  assert.equal(res.state.blocks[0]?.active, true, "fold reports success");

  const control = core.processTurn({
    messages: full,
    state: res.state,
    config: config(),
    tokenCount,
  });
  assert.ok(
    !control.messages.some((m) => m.id === "sentinel"),
    "control: sentinel pruned when the seed still leads",
  );

  const divergent = core.processTurn({
    messages: [sentinel, ...tail],
    state: res.state,
    config: config(),
    tokenCount,
  });
  assert.ok(
    !divergent.messages.some((m) => m.id === "sentinel"),
    "covered sentinel must be pruned even as the view's first user",
  );
  assert.ok(
    divergent.messages.every((m) => !m.text?.includes("SENTINEL-PAYLOAD")),
    "payload must not re-send verbatim while the block stays active",
  );
  assert.ok(
    divergent.messages.some((m) => m.id === "acp_summary_b1"),
    "rendered summary carries the coverage",
  );
  assert.equal(
    res.state.blocks[0]?.active,
    true,
    "block remains active (coverage now takes effect)",
  );
});

test("#489 pipeline: direct fold of the opening message takes effect", () => {
  const core = createCore();
  const opening = msg("opening", "user", `OPENING-PAYLOAD ${"x".repeat(4096)}`);
  const rest = [msg("u2"), msg("u3")];

  let state = core.processTurn({
    messages: [opening, ...rest],
    state: createInitialState(),
    config: config(),
    tokenCount,
  }).state;

  const ref = state.messageRefs.byRaw["opening"]!;
  const res = core.applyCompression({
    state,
    messages: [opening, ...rest],
    config: config(),
    ranges: [{ startRef: ref, endRef: ref, summary: "o".repeat(400) }],
  });
  assert.equal(res.state.blocks[0]?.active, true, "fold reports success");

  const view = core.processTurn({
    messages: [opening, ...rest],
    state: res.state,
    config: config(),
    tokenCount,
  });
  assert.ok(
    !view.messages.some((m) => m.id === "opening"),
    "covered opening message must be pruned",
  );
  assert.ok(
    view.messages.every((m) => !m.text?.includes("OPENING-PAYLOAD")),
    "payload must not re-send verbatim while the block stays active",
  );
  assert.ok(
    view.messages.some((m) => m.id === "acp_summary_b1"),
    "rendered summary carries the coverage",
  );
});
