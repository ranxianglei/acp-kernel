import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import type { CompressionState, Config, CoreMessage } from "../src/types.js";

const countTokens = (text: string) => Math.ceil(text.length / 4);

function cfg(limit: number, reasoningReplay: Config["reasoningReplay"]): Config {
  return { ...defaultConfig(limit), reasoningReplay };
}

function user(id: string, text = "hi"): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function reasoning(id: string, text = "thinking…"): CoreMessage {
  return { id, role: "assistant", contentType: "reasoning", text };
}

function asst(id: string, text = "answer"): CoreMessage {
  return { id, role: "assistant", contentType: "text", text };
}

test("open-round keeps reasoning after the last genuine user text, drops closed history", () => {
  const core = createCore({ countTokens });
  const messages = [
    user("u1"),
    reasoning("r1"),
    asst("a1"),
    user("u2"),
    reasoning("r2"),
    asst("a2"),
  ];
  const out = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg(262144, "open-round"),
    tokenCount: 100,
  });
  const kinds = out.messages.map((m) => `${m.role}/${m.contentType}`);
  assert.deepEqual(kinds, [
    "user/text",
    "assistant/text",
    "user/text",
    "assistant/reasoning",
    "assistant/text",
  ]);
});

test("never drops all reasoning; always keeps everything", () => {
  const core = createCore({ countTokens });
  const messages = [user("u1"), reasoning("r1"), asst("a1")];
  const never = core.processTurn({
    messages: messages.map((m) => ({ ...m })),
    state: createInitialState(),
    config: cfg(262144, "never"),
    tokenCount: 100,
  });
  assert.equal(never.messages.some((m) => m.contentType === "reasoning"), false);
  const always = core.processTurn({
    messages: messages.map((m) => ({ ...m })),
    state: createInitialState(),
    config: cfg(262144, "always"),
    tokenCount: 100,
  });
  assert.equal(always.messages.length, 3);
});

test("open-round without any user text message treats the view as open", () => {
  const core = createCore({ countTokens });
  const out = core.processTurn({
    messages: [reasoning("r1"), asst("a1"), reasoning("r2")],
    state: createInitialState(),
    config: cfg(262144, "open-round"),
    tokenCount: 100,
  });
  assert.equal(out.messages.length, 3);
});

test("tool-result user messages are not turn boundaries", () => {
  const core = createCore({ countTokens });
  const messages = [
    user("u1"),
    {
      id: "t1",
      role: "tool",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "c1",
      text: "output",
    },
    reasoning("r1"),
    asst("a1"),
  ];
  const out = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg(262144, "open-round"),
    tokenCount: 100,
  });
  assert.equal(out.messages.some((m) => m.contentType === "reasoning"), true);
});

function blockState(summary: string, startRef: string, endRef: string): CompressionState {
  const state = createInitialState();
  state.blocks.push({
    blockId: "b1",
    runId: "run1",
    tier: 1,
    summary,
    directMessageIds: ["m1"],
    effectiveMessageIds: ["m1"],
    directBlockIds: [],
    compressedTokens: 5000,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: "call1",
    startRef,
    endRef,
  });
  return state;
}

function compressCall(text: string): CoreMessage {
  return {
    id: "mc1",
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId: "call1",
    text,
  };
}

test("fully-live compress call args get their long summaries stubbed", () => {
  const longSummary = "x".repeat(5000);
  const callText = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00050", topic: "T", summary: longSummary }],
  });
  const state = blockState(longSummary, "m00001", "m00050");
  const { messages } = hideConsumedCompressCalls(state, [compressCall(callText)]);
  assert.equal(messages.length, 1);
  const parsed = JSON.parse(messages[0]!.text!) as {
    content: { summary: string; topic: string }[];
  };
  assert.equal(parsed.content[0]!.summary.length, 200);
  assert.ok(parsed.content[0]!.summary.endsWith("…"));
  assert.equal(parsed.content[0]!.topic, "T");
});

test("short summaries and orphaned calls are left untouched", () => {
  const callText = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00050", summary: "short" }],
  });
  const state = blockState("s", "m00001", "m00050");
  const { messages } = hideConsumedCompressCalls(state, [compressCall(callText)]);
  assert.equal(JSON.parse(messages[0]!.text!).content[0].summary, "short");

  const orphanText = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00050", summary: "y".repeat(4000) }],
  });
  const emptyState = createInitialState();
  const orphan = { ...compressCall(orphanText), toolCallId: "nope" };
  const { messages: orphanOut } = hideConsumedCompressCalls(emptyState, [orphan]);
  assert.equal(orphanOut.length, 1);
  assert.equal(JSON.parse(orphanOut[0]!.text!).content[0].summary.length, 200);
});

test("extraTokens folds into usage for pressure decisions", () => {
  const core = createCore({ countTokens });
  const limit = 100000;
  const config = defaultConfig(limit, { limit, preserveRecentMessages: 0 });
  const filler = "x".repeat(240000);
  const messages = [
    user("u1", "go"),
    {
      id: "t1",
      role: "tool",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "c1",
      text: filler,
    },
    asst("a1", "done"),
    user("u2"),
    asst("a2"),
  ];
  const without = core.processTurn({
    messages: messages.map((m) => ({ ...m })),
    state: createInitialState(),
    config,
    tokenCount: 40000,
  });
  assert.equal(without.nudge?.shouldInject, false);
  const withExtra = core.processTurn({
    messages: messages.map((m) => ({ ...m })),
    state: createInitialState(),
    config,
    tokenCount: 40000,
    extraTokens: 15000,
  });
  assert.equal(withExtra.nudge?.shouldInject, true);
});

test("tag-prefixed compress call text is still stubbed (ref tag precedes the JSON)", () => {
  const longSummary = "z".repeat(3000);
  const tagged = `<acp tokens="1.4K" type="compress">m00097</acp>\n\n{"content":[{"startId":"m00001","endId":"m00050","summary":"${longSummary}"}]}`;
  const state = blockState(longSummary, "m00001", "m00050");
  const { messages } = hideConsumedCompressCalls(state, [compressCall(tagged)]);
  const text = messages[0]!.text!;
  const parsed = JSON.parse(text.slice(text.indexOf("{"))) as { content: { summary: string }[] };
  assert.equal(parsed.content[0]!.summary.length, 200);
  assert.ok(text.startsWith("<acp"));
});

test("sub-id cores are pruned when the block covered a sibling sub-id", () => {
  const core = createCore({ countTokens });
  const state = createInitialState();
  state.blocks.push({
    blockId: "b1",
    runId: "run1",
    tier: 1,
    summary: "s",
    directMessageIds: ["a1#c1"],
    effectiveMessageIds: ["a1#c1"],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
  });
  const messages = [
    user("u1"),
    { id: "a1#r0", role: "assistant", contentType: "reasoning", text: "secret" },
    { id: "a1#c1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "c1", text: "cmd" },
    { id: "t1", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "c1", text: "out" },
    user("u2"),
  ];
  const out = core.processTurn({ messages, state, config: cfg(262144, "always"), tokenCount: 100 });
  assert.equal(out.messages.some((m) => m.id === "a1#r0"), false);
  assert.equal(out.messages.some((m) => m.id === "a1#c1"), false);
});
