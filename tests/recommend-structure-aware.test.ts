import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
  mergeRangesToThreshold,
  computeOpenTurnMemberIds,
} from "../src/recommend.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type {
  Config,
  CompressionState,
  CompressibleRange,
  CoreMessage,
} from "../src/types.js";

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

function userMsg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function textMsg(
  id: string,
  text: string,
  role: CoreMessage["role"],
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function reasoningMsg(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "reasoning", text };
}

function callMsg(
  id: string,
  toolName: string,
  toolCallId: string,
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId,
    text: `call ${toolName}`,
  };
}

function resultMsg(
  id: string,
  toolName: string,
  toolCallId: string,
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId,
    text: `${toolName} output`,
  };
}

function assignAll(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

function recommend(
  messages: CoreMessage[],
  state: CompressionState,
  cfg: Config,
): { ranges: CompressibleRange[]; contextRanges: ReturnType<typeof buildCompressibleRanges> } {
  const protectedRefs = computeProtectedRefs(messages, state, cfg);
  const contextRanges = buildCompressibleRanges(
    messages,
    state,
    cfg,
    protectedRefs,
  );
  return {
    ranges: mergeRangesToThreshold(
      contextRanges.compressible,
      cfg.compress.minCompressRange,
    ),
    contextRanges,
  };
}

function covers(r: CompressibleRange, index: number): boolean {
  return (
    r.startIndex !== undefined &&
    r.endIndex !== undefined &&
    index >= r.startIndex &&
    index <= r.endIndex
  );
}

test("computeOpenTurnMemberIds: empty when every call has a result", () => {
  const messages = [
    userMsg("u0", "task"),
    reasoningMsg("r1", "think"),
    callMsg("c1", "bash", "call_1"),
    resultMsg("t1", "bash", "call_1"),
  ];
  assert.deepEqual(computeOpenTurnMemberIds(messages), new Set<string>());
});

test("computeOpenTurnMemberIds: open call excludes its whole turn group", () => {
  const messages = [
    userMsg("u0", "task"),
    reasoningMsg("r1", "plan"),
    callMsg("c1", "edit", "call_1"),
    callMsg("c2", "edit", "call_2"),
    resultMsg("t1", "edit", "call_1"),
  ];
  // Burst [c1, c2] with only c1 answered: the turn {r1, c1, c2, t1} is open.
  assert.deepEqual(
    computeOpenTurnMemberIds(messages),
    new Set(["r1", "c1", "c2", "t1"]),
  );
});

test("open tail turn never lands inside a recommended range", () => {
  const messages = [
    userMsg("u0", "task one"),
    textMsg("a0", "ack", "assistant"),
    reasoningMsg("r1", "thinking"),
    callMsg("c1", "bash", "call_1"),
    resultMsg("t1", "bash", "call_1"),
    userMsg("u1", "task two"),
    reasoningMsg("r2", "thinking more"),
    callMsg("c2", "edit", "call_2"),
  ];
  const cfg = config();
  const state = assignAll(messages);
  const { ranges, contextRanges } = recommend(messages, state, cfg);

  for (const r of ranges) {
    assert.ok(!covers(r, 6), `range ${r.startRef}..${r.endRef} covers open reasoning m00007`);
    assert.ok(!covers(r, 7), `range ${r.startRef}..${r.endRef} covers open call m00008`);
  }
  for (const g of contextRanges.compressible) {
    assert.ok(!covers(g, 7), `context range ${g.startRef}..${g.endRef} covers open call m00008`);
  }
  const coveringCompleted = ranges.find((r) => covers(r, 2) && covers(r, 4));
  assert.ok(
    coveringCompleted,
    `the completed turn must stay advertised, got ${ranges
      .map((r) => `${r.startRef}..${r.endRef}`)
      .join(", ")}`,
  );
});

test("partially complete burst: the whole burst folds out, not just the open call", () => {
  const messages = [
    userMsg("u0", "task"),
    textMsg("a0", "ack", "assistant"),
    reasoningMsg("r1", "plan two edits"),
    callMsg("c1", "edit", "call_1"),
    callMsg("c2", "edit", "call_2"),
    resultMsg("t1", "edit", "call_1"),
  ];
  const cfg = config();
  const state = assignAll(messages);
  const { ranges } = recommend(messages, state, cfg);

  for (const i of [2, 3, 4, 5]) {
    for (const r of ranges) {
      assert.ok(!covers(r, i), `range ${r.startRef}..${r.endRef} covers in-progress member at index ${i}`);
    }
  }
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.startRef, "m00001");
  assert.equal(ranges[0]!.endRef, "m00002");
});

test("sequential tool use: completed turns stay compressible, only the live call is excluded", () => {
  const messages = [
    userMsg("u0", "task"),
    reasoningMsg("r1", "step one"),
    callMsg("c1", "bash", "call_1"),
    resultMsg("t1", "bash", "call_1"),
    callMsg("c2", "bash", "call_2"),
  ];
  const cfg = config();
  const state = assignAll(messages);
  const { ranges } = recommend(messages, state, cfg);

  assert.deepEqual(
    computeOpenTurnMemberIds(messages),
    new Set(["c2"]),
    "adjacency semantics: c2 after t1 starts its own turn",
  );
  for (const r of ranges) {
    assert.ok(!covers(r, 4), `range ${r.startRef}..${r.endRef} covers live call m00005`);
  }
  const coveringCompleted = ranges.find((r) => covers(r, 1) && covers(r, 3));
  assert.ok(coveringCompleted, "completed turn must stay advertised");
});

test("self-contained history: output identical to legacy grouping (regression pin)", () => {
  const messages = [
    userMsg("u0", "task one"),
    textMsg("a0", "ack", "assistant"),
    reasoningMsg("r1", "thinking"),
    callMsg("c1", "bash", "call_1"),
    resultMsg("t1", "bash", "call_1"),
    userMsg("u1", "task two"),
    reasoningMsg("r2", "thinking more"),
    callMsg("c2", "edit", "call_2"),
    resultMsg("t2", "edit", "call_2"),
  ];
  const cfg = config();
  const state = assignAll(messages);
  const { ranges } = recommend(messages, state, cfg);

  assert.equal(ranges.length, 2);
  assert.deepEqual(
    [ranges[0]!.startRef, ranges[0]!.endRef, ranges[0]!.count],
    ["m00001", "m00005", 5],
  );
  assert.deepEqual(
    [ranges[1]!.startRef, ranges[1]!.endRef, ranges[1]!.count],
    ["m00006", "m00009", 4],
  );
  for (const r of ranges) {
    const res = createCore().applyCompression({
      ranges: [{ startRef: r.startRef, endRef: r.endRef, summary: "fold it" }],
      messages,
      state,
      config: cfg,
    });
    assert.deepEqual(res.result.errors, []);
  }
});

test("self-contained history with protected zone: unchanged (regression pin)", () => {
  const messages = [
    userMsg("u0", "task"),
    textMsg("a0", "ack", "assistant"),
    reasoningMsg("r1", "thinking"),
    callMsg("c1", "edit", "call_1"),
    resultMsg("t1", "edit", "call_1"),
    textMsg("a1", "summarized", "assistant"),
    userMsg("u1", "next"),
    textMsg("a2", "reply", "assistant"),
  ];
  const cfg = config({ preserveRecentMessages: 2 });
  const state = assignAll(messages);
  const { ranges } = recommend(messages, state, cfg);

  assert.equal(ranges.length, 1);
  assert.deepEqual(
    [ranges[0]!.startRef, ranges[0]!.endRef, ranges[0]!.count],
    ["m00001", "m00006", 6],
  );
  const res = createCore().applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00006", summary: "turn recap" }],
    messages,
    state,
    config: cfg,
  });
  assert.deepEqual(res.result.errors, []);
});

test("parallel-tool sandwich: no range splits a call/result pair across a protected gap", () => {
  const messages = [
    userMsg("u0", "run both tools"),
    callMsg("c1", "bash", "call_1"),
    callMsg("c2", "skill", "call_2"),
    resultMsg("t2", "skill", "call_2"),
    resultMsg("t1", "bash", "call_1"),
  ];
  const cfg = config({ protectedTools: ["skill"] });
  const state = assignAll(messages);
  const { ranges, contextRanges } = recommend(messages, state, cfg);

  const protectedRefs = contextRanges.protected.flatMap((p) => [
    p.startRef,
    p.endRef,
  ]);
  assert.ok(protectedRefs.includes("m00003"));
  assert.ok(protectedRefs.includes("m00004"));

  for (const i of [1, 4]) {
    for (const r of ranges) {
      assert.ok(
        !covers(r, i),
        `range ${r.startRef}..${r.endRef} holds half of a pair split by the protected gap`,
      );
    }
  }
  assert.equal(contextRanges.compressible.length, 1);
  assert.equal(contextRanges.compressible[0]!.startRef, "m00001");
  assert.equal(contextRanges.compressible[0]!.endRef, "m00001");
  const res = createCore().applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00001", summary: "user recap" }],
    messages,
    state,
    config: cfg,
  });
  assert.deepEqual(res.result.errors, []);
});

test("merged batches respect the open-turn boundary under minCompressRange", () => {
  const pad = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const messages = [
    userMsg("u0", pad("u0 ", 36)),
    textMsg("a0", pad("a0 ", 36), "assistant"),
    reasoningMsg("r1", pad("r1 ", 36)),
    callMsg("c1", "bash", "call_1"),
    resultMsg("t1", "bash", "call_1"),
    userMsg("u1", pad("u1 ", 36)),
    reasoningMsg("r2", pad("r2 ", 36)),
    callMsg("c2", "edit", "call_2"),
  ];
  const cfg = config({ compress: { minCompressRange: 100, maxSummaryLength: 0, minSummaryLength: 0 } });
  const state = assignAll(messages);
  const { ranges } = recommend(messages, state, cfg);

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.endRef, "m00006");
  for (const r of ranges) {
    assert.ok(!covers(r, 6));
    assert.ok(!covers(r, 7));
  }
});

test("determinism: same input yields byte-identical recommendations on a mixed history", () => {
  const messages = [
    userMsg("u0", "task A"),
    textMsg("a0", "ack", "assistant"),
    reasoningMsg("r1", "work"),
    callMsg("c1", "bash", "call_1"),
    resultMsg("t1", "bash", "call_1"),
    userMsg("u1", "task B"),
    reasoningMsg("r2", "more work"),
    callMsg("c2", "skill", "call_2"),
    resultMsg("t2", "skill", "call_2"),
    callMsg("c3", "bash", "call_3"),
    resultMsg("t3", "bash", "call_3"),
    userMsg("u2", "task C"),
    reasoningMsg("r3", "live work"),
    callMsg("c4", "edit", "call_4"),
  ];
  const cfg = config({ protectedTools: ["skill"] });
  const state = assignAll(messages);
  const first = recommend(messages, state, cfg);
  const second = recommend(messages, state, cfg);
  assert.deepEqual(second.ranges, first.ranges);
  assert.deepEqual(second.contextRanges, first.contextRanges);
});
