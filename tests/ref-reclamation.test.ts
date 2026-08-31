import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import {
  BLOCKED_REF,
  assignRefs,
  indexToRef,
  pruneDeadRefs,
  refToIndex,
} from "../src/refs.js";
import { syncBlocks } from "../src/sync.js";
import { deactivateBlock } from "../src/decompress.js";
import { BoundaryNotFoundError, resolveBoundaries } from "../src/boundaries.js";
import type {
  CompressionBlock,
  CompressionState,
  Config,
  CoreMessage,
  MessageRefMap,
} from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function config(overrides: Partial<Config> = {}): Config {
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
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function block(
  blockId: string,
  summary: string,
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId,
    runId: "r1",
    tier: 1,
    summary,
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

function boundaryError(
  startRef: string,
  endRef: string,
  messages: CoreMessage[],
  state: CompressionState,
): BoundaryNotFoundError {
  try {
    resolveBoundaries({ startRef, endRef, messages, state });
  } catch (error) {
    if (error instanceof BoundaryNotFoundError) return error;
    throw error;
  }
  throw new Error(`expected BoundaryNotFoundError for ${startRef}..${endRef}`);
}

test("pruneDeadRefs drops dead byRaw entries and rebuilds byRef", () => {
  const map: MessageRefMap = {
    byRaw: { a: "m00001", b: "m00002", c: "m00003" },
    byRef: { m00001: "a", m00002: "b", m00003: "c" },
  };
  const { map: pruned, pruned: count } = pruneDeadRefs(
    map,
    new Set(["a", "c"]),
  );
  assert.deepEqual(pruned.byRaw, { a: "m00001", c: "m00003" });
  assert.deepEqual(pruned.byRef, { m00001: "a", m00003: "c" });
  assert.equal(count, 1);
  assert.equal(map.byRaw.b, "m00002");
});

test("pruneDeadRefs drops dead BLOCKED entries (re-protected on reappear)", () => {
  const map: MessageRefMap = {
    byRaw: { p: BLOCKED_REF, q: "m00001" },
    byRef: { m00001: "q" },
  };
  const { map: pruned, pruned: count } = pruneDeadRefs(map, new Set(["q"]));
  assert.deepEqual(pruned.byRaw, { q: "m00001" });
  assert.deepEqual(pruned.byRef, { m00001: "q" });
  assert.equal(count, 1);
});

test("assignRefs reuses freed low slots when the cursor is past capacity", () => {
  const existing: MessageRefMap = {
    byRaw: { hi1: "m99998", hi2: "m99999" },
    byRef: { m99998: "hi1", m99999: "hi2" },
  };
  const result = assignRefs([msg("new1", "x")], {
    existing,
    nextIndex: 100000,
  });
  assert.equal(result.map.byRaw.new1, "m00001");
  assert.equal(result.newlyAssigned, 1);
});

test("assignRefs throws only when all 99999 slots are occupied", () => {
  const byRaw: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  for (let i = 1; i <= 99999; i++) {
    const ref = indexToRef(i);
    byRaw[`d${i}`] = ref;
    byRef[ref] = `d${i}`;
  }
  assert.throws(
    () =>
      assignRefs([msg("x", "x")], {
        existing: { byRaw, byRef },
        nextIndex: 1,
      }),
    /ref capacity exhausted/,
  );
});

test("syncBlocks releases refs of edit-drifted messages no block covers", () => {
  const state = createInitialState();
  state.messageRefs = {
    byRaw: { old: "m00001", kept: "m00002", gone: "m00003" },
    byRef: { m00001: "old", m00002: "kept", m00003: "gone" },
  };
  const view = [msg("edited", "old text v2"), msg("kept", "same")];
  const { state: synced } = syncBlocks(view, state);
  assert.deepEqual(synced.messageRefs.byRaw, { kept: "m00002" });
  assert.deepEqual(synced.messageRefs.byRef, { m00002: "kept" });
  assert.equal(state.messageRefs.byRaw.old, "m00001");
});

test("syncBlocks keeps refs of messages covered by ACTIVE blocks even when absent from view", () => {
  const state = createInitialState();
  state.messageRefs = {
    byRaw: { x: "m00001", y: "m00002", a: "m00003" },
    byRef: { m00001: "x", m00002: "y", m00003: "a" },
  };
  state.blocks = [
    block("b1", "s", {
      directMessageIds: ["x", "y"],
      effectiveMessageIds: ["x", "y"],
    }),
  ];
  const { state: synced } = syncBlocks([msg("y", "y"), msg("a", "a")], state);
  assert.equal(synced.blocks[0]!.active, true);
  assert.deepEqual(synced.messageRefs.byRaw, {
    x: "m00001",
    y: "m00002",
    a: "m00003",
  });
});

test("syncBlocks deactivates orphaned active blocks and releases their refs", () => {
  const state = createInitialState();
  state.messageRefs = {
    byRaw: { x: "m00001", y: "m00002", a: "m00003" },
    byRef: { m00001: "x", m00002: "y", m00003: "a" },
  };
  state.blocks = [
    block("b1", "s", {
      directMessageIds: ["x", "y"],
      effectiveMessageIds: ["x", "y"],
    }),
  ];
  const { state: synced, deactivated } = syncBlocks([msg("a", "a")], state);
  assert.equal(synced.blocks[0]!.active, false);
  assert.deepEqual(deactivated, ["b1"]);
  assert.deepEqual(synced.messageRefs.byRaw, { a: "m00003" });
});

test("syncBlocks releases refs covered only by INACTIVE blocks (tombstones do not leak)", () => {
  const state = createInitialState();
  state.messageRefs = {
    byRaw: { x: "m00001", a: "m00002" },
    byRef: { m00001: "x", m00002: "a" },
  };
  state.blocks = [
    block("b1", "s", {
      directMessageIds: ["x"],
      effectiveMessageIds: ["x"],
      active: false,
    }),
  ];
  const { state: synced } = syncBlocks([msg("a", "a")], state);
  assert.deepEqual(synced.messageRefs.byRaw, { a: "m00002" });
});

test("applyCompression deactivates orphaned active blocks before boundary resolution", () => {
  const core = createCore();
  const state = createInitialState();
  state.messageRefs = {
    byRaw: { x: "m00001", y: "m00002", a: "m00003", b: "m00004" },
    byRef: { m00001: "x", m00002: "y", m00003: "a", m00004: "b" },
  };
  state.blocks = [
    block("b1", "old", {
      directMessageIds: ["x", "y"],
      effectiveMessageIds: ["x", "y"],
    }),
  ];
  const view = [msg("a", "a"), msg("b", "b")];
  const result = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00004", summary: "new" }],
    messages: view,
    state,
    config: config(),
  });
  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(
    result.state.blocks.find((b) => b.blockId === "b1")!.active,
    false,
  );
  assert.equal(result.state.messageRefs.byRaw.x, undefined);
  assert.equal(result.state.messageRefs.byRaw.y, undefined);
});

test("message ref into an orphaned block reports released ref, not 'active but invisible'", () => {
  const core = createCore();
  const state = createInitialState();
  state.messageRefs = {
    byRaw: { x: "m00001", y: "m00002", a: "m00003" },
    byRef: { m00001: "x", m00002: "y", m00003: "a" },
  };
  state.blocks = [
    block("b1", "old", {
      directMessageIds: ["x", "y"],
      effectiveMessageIds: ["x", "y"],
    }),
  ];
  const view = [msg("a", "a")];
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "retry" }],
    messages: view,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /does not exist in this session/);
  assert.doesNotMatch(
    result.result.errors[0]!,
    /active block but none of its content/,
  );
});

test("block ref into an orphaned block reports consumed (inactive), not 'active but invisible'", () => {
  const state = createInitialState();
  state.messageRefs = {
    byRaw: { x: "m00001", y: "m00002", a: "m00003" },
    byRef: { m00001: "x", m00002: "y", m00003: "a" },
  };
  state.blocks = [
    block("b1", "old", {
      directMessageIds: ["x", "y"],
      effectiveMessageIds: ["x", "y"],
    }),
  ];
  const view = [msg("a", "a")];
  const { state: synced } = syncBlocks(view, state);
  const error = boundaryError("b1", "m00003", view, synced);
  assert.equal(error.kind, "consumed");
  assert.equal(error.reason, "generation-replaced");
  assert.match(error.message, /inactive \(distilled or garbage-collected\)/);
});

test("resolveBoundaries classifies consumed failures: consumed / generation-replaced / edit-drift", () => {
  const state = createInitialState();
  state.messageRefs = {
    byRaw: {
      a: "m00001",
      covered: "m00002",
      distilled: "m00003",
      drifted: "m00004",
    },
    byRef: {
      m00001: "a",
      m00002: "covered",
      m00003: "distilled",
      m00004: "drifted",
    },
  };
  state.blocks = [
    block("b1", "s1", {
      directMessageIds: ["covered"],
      effectiveMessageIds: ["covered"],
    }),
    block("b2", "s2", {
      directMessageIds: ["distilled"],
      effectiveMessageIds: ["distilled"],
      active: false,
    }),
  ];
  const view = [msg("a", "a")];

  const consumed = boundaryError("m00002", "m00001", view, state);
  assert.equal(consumed.kind, "consumed");
  assert.equal(consumed.reason, "consumed");
  assert.match(
    consumed.message,
    /already compressed into active block\(s\) b1/,
  );

  const replaced = boundaryError("m00003", "m00001", view, state);
  assert.equal(replaced.kind, "consumed");
  assert.equal(replaced.reason, "generation-replaced");
  assert.match(replaced.message, /distilled or consumed/);

  const drifted = boundaryError("m00004", "m00001", view, state);
  assert.equal(drifted.kind, "consumed");
  assert.equal(drifted.reason, "edit-drift");
  assert.match(drifted.message, /edited or removed/);

  const unknown = boundaryError("m00099", "m00001", view, state);
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.reason, null);
  assert.match(unknown.message, /does not exist in this session/);
});

test("stress: 1200 mixed turns keep the ref map bounded (no monotonic leak)", () => {
  const core = createCore();
  let state = createInitialState();
  const cfg = config();
  const view: CoreMessage[] = [];
  let seq = 0;
  let maxByRaw = 0;

  for (let turn = 1; turn <= 1200; turn++) {
    if (view.length > 30) view.splice(0, 2);
    if (turn % 3 === 0 && view.length > 4) {
      const i = (turn * 7) % view.length;
      const original = view[i]!;
      view[i] = {
        ...original,
        id: `msg-${++seq}`,
        text: `${original.text} edited`,
      };
    }
    view.push({
      id: `msg-${++seq}`,
      role: "user",
      contentType: "text",
      text: `turn ${turn} ${"x".repeat(16 + (seq % 13))}`,
    });

    if (turn % 50 === 0 && view.length >= 8) {
      const startRef = state.messageRefs.byRaw[view[0]!.id];
      const endRef = state.messageRefs.byRaw[view[7]!.id];
      if (startRef && endRef) {
        const res = core.applyCompression({
          ranges: [{ startRef, endRef, summary: `stress summary ${turn}` }],
          messages: view,
          state,
          config: cfg,
        });
        state = res.state;
      }
    }

    if (turn % 100 === 0) {
      const active = state.blocks.filter((b) => b.active);
      if (active.length > 0) {
        const victim = active[0]!;
        const victimIds = new Set(victim.effectiveMessageIds);
        for (let i = view.length - 1; i >= 0; i--) {
          if (victimIds.has(view[i]!.id)) view.splice(i, 1);
        }
        state = deactivateBlock(state, [victim.blockId]);
      }
    }

    const result = core.processTurn({
      messages: view,
      state,
      config: cfg,
      tokenCount: 1000,
      renderTags: "none",
    });
    state = result.state;

    const activeIds = new Set<string>();
    for (const b of state.blocks) {
      if (b.active) for (const id of b.effectiveMessageIds) activeIds.add(id);
    }
    const bound = view.length + activeIds.size;
    const byRawSize = Object.keys(state.messageRefs.byRaw).length;
    assert.ok(
      byRawSize <= bound,
      `turn ${turn}: byRaw ${byRawSize} exceeds bound ${bound}`,
    );
    maxByRaw = Math.max(maxByRaw, byRawSize);
  }

  assert.ok(seq > 1500, `workload should churn many ids, created ${seq}`);
  assert.ok(
    maxByRaw <= 150,
    `ref map should stay proportional to the live view, saw max ${maxByRaw}`,
  );
});

test("near-capacity legacy state: dead refs reclaimed, refs reused, compression works", () => {
  const core = createCore();
  const state = createInitialState();
  const byRaw: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  for (let i = 1; i <= 99999; i++) {
    const ref = indexToRef(i);
    byRaw[`dead-${i}`] = ref;
    byRef[ref] = `dead-${i}`;
  }
  state.messageRefs = { byRaw, byRef };
  const view = [
    msg("live-1", "one"),
    msg("live-2", "two"),
    msg("live-3", "three"),
  ];

  const result = core.processTurn({
    messages: view,
    state,
    config: config(),
    tokenCount: 100,
    renderTags: "none",
  });
  assert.equal(Object.keys(result.state.messageRefs.byRaw).length, 3);
  for (const m of view) {
    const ref = result.state.messageRefs.byRaw[m.id]!;
    assert.ok(
      (refToIndex(ref) ?? 0) <= 100,
      `expected a low reused ref, got ${ref}`,
    );
  }

  const refs = view.map((m) => result.state.messageRefs.byRaw[m.id]!);
  const compressed = core.applyCompression({
    ranges: [{ startRef: refs[0]!, endRef: refs[2]!, summary: "s" }],
    messages: view,
    state: result.state,
    config: config(),
  });
  assert.deepEqual(compressed.result.errors, []);
  assert.equal(compressed.result.blocksCreated, 1);
});
