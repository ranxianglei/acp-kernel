import { test } from "node:test";
import assert from "node:assert/strict";
import { stripReasoningByRound, isRealUserMessage } from "../src/strip-reasoning.js";
import { createCore } from "../src/compress.js";
import { createInitialState, coveredMessageIds, baseMessageId } from "../src/state.js";
import { prune } from "../src/prune.js";
import { syncBlocks } from "../src/sync.js";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionBlock, CompressionState, CoreMessage } from "../src/types.js";

function block(overrides: Partial<CompressionBlock>): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 1000,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

function user(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function reasoning(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "reasoning", text };
}

function text(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "text", text };
}

// ---------- strip-reasoning unit ----------

test("stripReasoningByRound: always is a no-op", () => {
  const messages = [user("u1", "hi"), reasoning("r1", "think"), text("t1", "ok")];
  const result = stripReasoningByRound(messages, "always");
  assert.equal(result.stripped, 0);
  assert.deepEqual(result.messages, messages);
});

test("stripReasoningByRound: open-round strips closed-round reasoning only", () => {
  const messages = [
    user("u1", "hi"),
    reasoning("r1", "closed thinking"),
    text("t1", "answer"),
    user("u2", "next"),
    reasoning("r2", "open thinking"),
    text("t2", "answer"),
  ];
  const result = stripReasoningByRound(messages, "open-round");
  assert.equal(result.stripped, 1);
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["u1", "t1", "u2", "r2", "t2"],
  );
});

test("stripReasoningByRound: open-round with no user message is a no-op", () => {
  const messages = [reasoning("r1", "think"), text("t1", "ok")];
  const result = stripReasoningByRound(messages, "open-round");
  assert.equal(result.stripped, 0);
  assert.deepEqual(result.messages, messages);
});

test("stripReasoningByRound: never strips all reasoning", () => {
  const messages = [user("u1", "hi"), reasoning("r1", "a"), text("t1", "ok"), reasoning("r2", "b")];
  const result = stripReasoningByRound(messages, "never");
  assert.equal(result.stripped, 2);
  assert.deepEqual(result.messages.map((m) => m.id), ["u1", "t1"]);
});

test("isRealUserMessage: tool results are not user messages", () => {
  const toolResult: CoreMessage = {
    id: "tr1",
    role: "tool",
    contentType: "tool-result",
    toolName: "bash",
    toolCallId: "c1",
    text: "out",
  };
  assert.equal(isRealUserMessage(toolResult), false);
  assert.equal(isRealUserMessage(user("u1", "hi")), true);
});

// ---------- processTurn integration ----------

function replayMessages(): CoreMessage[] {
  return [
    user("u1", "hi"),
    reasoning("r1", "closed thinking"),
    text("t1", "answer"),
    user("u2", "next"),
    reasoning("r2", "open thinking"),
    text("t2", "answer"),
  ];
}

test("processTurn: reasoningReplay open-round strips closed-round reasoning", () => {
  const core = createCore();
  const config = defaultConfig(100000, { reasoningReplay: "open-round" });
  const result = core.processTurn({
    messages: replayMessages(),
    state: createInitialState(),
    config,
    tokenCount: 1000,
  });
  const ids = result.messages.map((m) => m.id);
  assert.ok(!ids.includes("r1"), "closed-round reasoning stripped");
  assert.ok(ids.includes("r2"), "open-round reasoning kept");
});

test("processTurn: reasoningReplay never strips all reasoning", () => {
  const core = createCore();
  const config = defaultConfig(100000, { reasoningReplay: "never" });
  const result = core.processTurn({
    messages: replayMessages(),
    state: createInitialState(),
    config,
    tokenCount: 1000,
  });
  const ids = result.messages.map((m) => m.id);
  assert.ok(!ids.includes("r1"));
  assert.ok(!ids.includes("r2"));
});

test("processTurn: default (always) keeps all reasoning — legacy behavior", () => {
  const core = createCore();
  const config = defaultConfig(100000);
  const result = core.processTurn({
    messages: replayMessages(),
    state: createInitialState(),
    config,
    tokenCount: 1000,
  });
  const ids = result.messages.map((m) => m.id);
  assert.ok(ids.includes("r1"), "always keeps closed-round reasoning");
  assert.ok(ids.includes("r2"));
});

// ---------- base-id coverage normalization ----------

test("baseMessageId: strips host #suffix projections", () => {
  assert.equal(baseMessageId("m1"), "m1");
  assert.equal(baseMessageId("m1#r0"), "m1");
  assert.equal(baseMessageId("m1#callId"), "m1");
  assert.equal(baseMessageId("a#b#c"), "a");
});

test("coveredMessageIds: includes base ids of projected members", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [block({ effectiveMessageIds: ["m1", "m2#callId"] })],
  };
  const covered = coveredMessageIds(state);
  assert.ok(covered.has("m1"));
  assert.ok(covered.has("m2"));
  assert.ok(covered.has("m2#callId"));
});

test("prune: projected sibling (base#r0) is covered by a block on the base id", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [block({ effectiveMessageIds: ["m1"], directMessageIds: ["m1"] })],
  };
  const messages: CoreMessage[] = [
    user("u1", "hi"),
    text("m1", "a"),
    reasoning("m1#r0", "reasoning projection"),
    user("u2", "later"),
  ];
  const result = prune(messages, state);
  const ids = result.map((m) => m.id);
  assert.ok(!ids.includes("m1"), "base id pruned");
  assert.ok(!ids.includes("m1#r0"), "sibling projection pruned with base");
  assert.ok(ids.some((id) => id.startsWith("acp_summary_b1")), "summary injected");
});

test("syncBlocks: block stays active when only a sibling projection is present", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [block({ effectiveMessageIds: ["m1"] })],
  };
  const messages: CoreMessage[] = [
    { id: "m1#callId", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "c1", text: "{}" },
    user("u2", "hi"),
  ];
  const result = syncBlocks(messages, state);
  assert.equal(result.deactivated.length, 0, "block must not be deactivated by id evolution");
  assert.equal(result.state.blocks[0]!.active, true);
});

// ---------- live compress-call args rewrite ----------

const REF_TAG = `<acp tokens="1.2K" type="compress">m00004</acp>\n`;

function liveState(): CompressionState {
  return {
    ...createInitialState(),
    blocks: [
      block({
        compressCallId: "call-1",
        startRef: "m00001",
        endRef: "m00003",
      }),
    ],
  };
}

function compressCall(id: string, toolCallId: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId, text };
}

test("rewrite: ref-tag prefix + canonical startRef/endRef + long summary → stubbed", () => {
  const longSummary = "x".repeat(500);
  const args = JSON.stringify({
    content: [{ startRef: "m00001", endRef: "m00003", summary: longSummary }],
  });
  const messages: CoreMessage[] = [
    compressCall("c1", "call-1", REF_TAG + args),
    user("u1", "hi"),
  ];
  const result = hideConsumedCompressCalls(liveState(), messages);
  assert.equal(result.hidden, 0);
  const rewritten = result.messages[0]!.text!;
  assert.ok(!rewritten.startsWith(REF_TAG), "ref-tag prefix removed");
  const parsed = JSON.parse(rewritten) as { content: Array<{ summary: string }> };
  assert.equal(parsed.content.length, 1);
  assert.equal(parsed.content[0]!.summary.length, 201, "200 chars + ellipsis");
  assert.ok(parsed.content[0]!.summary.endsWith("…"));
});

test("rewrite: pure JSON with legacy startId/endId still matches", () => {
  const longSummary = "y".repeat(300);
  const args = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00003", summary: longSummary }],
  });
  const messages: CoreMessage[] = [compressCall("c1", "call-1", args), user("u1", "hi")];
  const result = hideConsumedCompressCalls(liveState(), messages);
  const parsed = JSON.parse(result.messages[0]!.text!) as { content: Array<{ summary: string }> };
  assert.equal(parsed.content.length, 1);
  assert.equal(parsed.content[0]!.summary.length, 201);
});

test("rewrite: all-live single range is stubbed (no longer bails on kept === content)", () => {
  const longSummary = "z".repeat(400);
  const args = JSON.stringify({
    content: [{ startRef: "m00001", endRef: "m00003", summary: longSummary }],
  });
  const messages: CoreMessage[] = [compressCall("c1", "call-1", args), user("u1", "hi")];
  const result = hideConsumedCompressCalls(liveState(), messages);
  const parsed = JSON.parse(result.messages[0]!.text!) as { content: Array<{ summary: string }> };
  assert.equal(parsed.content.length, 1);
  assert.equal(parsed.content[0]!.summary.length, 201);
});

test("rewrite: short summary is not stubbed", () => {
  const args = JSON.stringify({
    content: [{ startRef: "m00001", endRef: "m00003", summary: "short" }],
  });
  const messages: CoreMessage[] = [compressCall("c1", "call-1", args), user("u1", "hi")];
  const result = hideConsumedCompressCalls(liveState(), messages);
  const parsed = JSON.parse(result.messages[0]!.text!) as { content: Array<{ summary: string }> };
  assert.equal(parsed.content[0]!.summary, "short");
});

test("rewrite: non-JSON args are left untouched", () => {
  const messages: CoreMessage[] = [
    compressCall("c1", "call-1", REF_TAG + "not json at all"),
    user("u1", "hi"),
  ];
  const result = hideConsumedCompressCalls(liveState(), messages);
  assert.equal(result.messages[0]!.text, REF_TAG + "not json at all");
});

test("rewrite: no live range match → call kept but untouched", () => {
  const args = JSON.stringify({
    content: [{ startRef: "m00005", endRef: "m00006", summary: "w".repeat(300) }],
  });
  const messages: CoreMessage[] = [compressCall("c1", "call-1", args), user("u1", "hi")];
  const result = hideConsumedCompressCalls(liveState(), messages);
  assert.equal(result.messages[0]!.text, args);
});

// ---------- extraTokens ----------

function nudgeConfig() {
  return defaultConfig(100000, {
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
  });
}

function textMessage(role: CoreMessage["role"], id: string, text: string): CoreMessage {
  return { id, role, contentType: "text", text };
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) =>
    textMessage(i % 2 === 0 ? "user" : "assistant", `m${i}`, `message ${i} `.repeat(2000)),
  );
}

test("extraTokens: host-invisible mass folds into usage/pressure", () => {
  const core = createCore();
  const config = nudgeConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  // Stamp the growth baseline at 89% (just under the 90% pressure threshold).
  state = core.processTurn({ messages, state, config, tokenCount: 89000 }).state;

  // 89% visible, no invisible mass → below the 90% pressure threshold → no nudge.
  const below = core.processTurn({ messages, state, config, tokenCount: 89000 });
  assert.equal(below.nudge.shouldInject, false, "89% < 90% pressure threshold");

  // Same 89% visible + 2000 invisible (replayed reasoning) → 91% → pressure → nudge.
  const withExtra = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 89000,
    extraTokens: 2000,
  });
  assert.equal(
    withExtra.nudge.shouldInject,
    true,
    "extraTokens push usage past the 90% pressure threshold",
  );
});
