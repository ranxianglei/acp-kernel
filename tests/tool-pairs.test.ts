import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjustBoundariesForToolPairs } from "../src/tool-pairs.js";
import type { CoreMessage } from "../src/types.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";

function msg(id: string, contentType: CoreMessage["contentType"], extra: Partial<CoreMessage> = {}): CoreMessage {
  return { id, role: "user", contentType, text: `msg-${id}`, ...extra };
}

function toolCall(id: string, callId: string, toolName = "read"): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId: callId, text: `call-${callId}` };
}

function toolResult(id: string, callId: string, toolName = "read"): CoreMessage {
  return { id, role: "user", contentType: "tool-result", toolName, toolCallId: callId, text: `result-${callId}` };
}

function textMsg(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: `text-${id}` };
}

describe("adjustBoundariesForToolPairs", () => {
  it("no-op when range has no tool messages", () => {
    const messages = [textMsg("a"), textMsg("b"), textMsg("c"), textMsg("d")];
    const result = adjustBoundariesForToolPairs(0, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 2 });
  });

  it("extends forward to include tool-result after range", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      textMsg("c"),
      toolResult("d", "call1"),
      textMsg("e"),
    ];
    const result = adjustBoundariesForToolPairs(0, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 3 });
  });

  it("extends backward to include tool-call before range", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      textMsg("c"),
      toolResult("d", "call1"),
      textMsg("e"),
    ];
    const result = adjustBoundariesForToolPairs(2, 3, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 3 });
  });

  it("extends both directions when two pairs straddle the range", () => {
    const messages = [
      toolCall("a", "call1"),
      toolResult("b", "call1"),
      toolCall("c", "call2"),
      textMsg("d"),
      toolResult("e", "call2"),
    ];
    const result = adjustBoundariesForToolPairs(1, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 4 });
  });

  it("skips compress tool (force-protected)", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "comp1", "compress"),
      textMsg("c"),
      toolResult("d", "comp1", "compress"),
      textMsg("e"),
    ];
    const result = adjustBoundariesForToolPairs(0, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 2 });
  });

  it("stop-at-first-gap: stops after finding match then hitting gap", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      toolResult("c", "call1"),
      textMsg("d"),
      toolResult("e", "call1"),
    ];
    const result = adjustBoundariesForToolPairs(0, 1, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 2 });
  });

  it("does not pull result beyond maxScan distance", () => {
    const messages: CoreMessage[] = [toolCall("a", "call1")];
    for (let i = 0; i < 25; i++) {
      messages.push(textMsg(`gap${i}`));
    }
    messages.push(toolResult("result", "call1"));
    const result = adjustBoundariesForToolPairs(0, 0, messages, 5);
    assert.deepEqual(result, { startIndex: 0, endIndex: 0 });
  });

  it("handles multiple pairs in range", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      toolResult("c", "call1"),
      toolCall("d", "call2"),
      textMsg("e"),
      toolResult("f", "call2"),
    ];
    const result = adjustBoundariesForToolPairs(1, 4, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 5 });
  });
});

describe("compression with tool-pair protection", () => {
  const cfg = { ...defaultConfig(100000), compress: { ...defaultConfig(100000).compress, minCompressRange: 0 } };

  it("compression auto-includes orphaned tool-result", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      toolCall("m2", "c1"),
      textMsg("m3"),
      toolResult("m4", "c1"),
      textMsg("m5"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({ messages, state, config: cfg, tokenCount: 1000 }).state;

    const result = core.applyCompression({
      ranges: [{
        startRef: "m00001",
        endRef: "m00003",
        summary: "Compressed range with tool-call but not its result. The range should auto-extend to include the result.",
      }],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    assert.equal(result.result.blocksCreated, 1);
    const block = result.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(block!.effectiveMessageIds.includes("m4"), "tool-result m4 should be auto-included");
    assert.ok(block!.effectiveMessageIds.includes("m2"), "tool-call m2 should be in block");
  });

  it("compression auto-includes orphaned tool-call", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      toolCall("m2", "c1"),
      textMsg("m3"),
      toolResult("m4", "c1"),
      textMsg("m5"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({ messages, state, config: cfg, tokenCount: 1000 }).state;

    const result = core.applyCompression({
      ranges: [{
        startRef: "m00003",
        endRef: "m00004",
        summary: "Compressed range with tool-result but not its call. The range should auto-extend backward to include the call.",
      }],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    assert.equal(result.result.blocksCreated, 1);
    const block = result.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(block!.effectiveMessageIds.includes("m2"), "tool-call m2 should be auto-included");
    assert.ok(block!.effectiveMessageIds.includes("m4"), "tool-result m4 should be in block");
  });
});

describe("prune stripOrphanedToolCalls (defense-in-depth)", () => {
  it("strips orphaned tool-call when result is compressed away", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      toolCall("m2", "c1"),
      toolResult("m3", "c1"),
      toolCall("m4", "c2"),
      toolResult("m5", "c2"),
      textMsg("m6"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({ messages, state, config: { ...defaultConfig(100000), compress: { ...defaultConfig(100000).compress, minCompressRange: 0 } }, tokenCount: 1000 }).state;

    const result = core.applyCompression({
      ranges: [{
        startRef: "m00004",
        endRef: "m00005",
        summary: "Second tool pair compressed. First pair should survive intact.",
      }],
      messages,
      state: stateWithRefs,
      config: { ...defaultConfig(100000), compress: { ...defaultConfig(100000).compress, minCompressRange: 0 } },
    });

    const pruned = core.processTurn({
      messages,
      state: result.state,
      config: { ...defaultConfig(100000), compress: { ...defaultConfig(100000).compress, minCompressRange: 0 } },
      tokenCount: 500,
    }).messages;

    const ids = pruned.map((m) => m.id);
    assert.ok(ids.includes("m2"), "uncompressed tool-call m2 survives");
    assert.ok(ids.includes("m3"), "uncompressed tool-result m3 survives");
    assert.ok(!ids.includes("m4"), "compressed tool-call m4 removed");
    assert.ok(!ids.includes("m5"), "compressed tool-result m5 removed");
  });
});
