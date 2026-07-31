import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { mergeMarkedBlocks, collectOldGenBlocks } from "../src/merge.js";
import { rebuildCompressionState } from "../src/rebuild.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionBlock, CompressionState, CoreMessage } from "../src/types.js";

function block(overrides: Partial<CompressionBlock>): CompressionBlock {
    return {
        blockId: "b0",
        runId: "r0",
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

test("hideConsumedCompressCalls keeps active-block compress calls and recent orphaned", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [block({ blockId: "b1", compressCallId: "call-active", active: true })],
    };
    const messages: CoreMessage[] = [
        { id: "m1", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-active", text: "{}" },
        { id: "m2", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-consumed", text: "{}" },
        { id: "m3", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-orphan1", text: "{}" },
        { id: "m4", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-orphan2", text: "{}" },
        { id: "m5", role: "user", contentType: "text", text: "hello" },
    ];
    const result = hideConsumedCompressCalls(state, messages);
    assert.equal(result.hidden, 1);
    const remainingCallIds = result.messages.filter((m) => m.toolName === "compress").map((m) => m.toolCallId);
    assert.ok(remainingCallIds.includes("call-active"));
    assert.ok(!remainingCallIds.includes("call-consumed"));
    assert.ok(result.messages.some((m) => m.text === "hello"));
});

test("mergeMarkedBlocks merges old-gen blocks into one summary", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            block({ blockId: "b1", summary: "first summary", effectiveMessageIds: ["m1"], generation: "old", active: true }),
            block({ blockId: "b2", summary: "second summary", effectiveMessageIds: ["m2"], generation: "old", active: true }),
        ],
    };
    const result = mergeMarkedBlocks(state, ["b1", "b2"], 5000, defaultCountTokens);
    assert.equal(result.mergedCount, 2);
    assert.ok(result.savedTokens >= 0);
    const merged = result.state.blocks.find((b) => b.blockId === "b2" || b.active && b.summary.includes("---"));
    const newBlock = result.state.blocks.find((b) => b.directBlockIds.length === 2);
    assert.ok(newBlock);
    assert.ok(newBlock!.summary.includes("first summary"));
    assert.ok(newBlock!.summary.includes("second summary"));
    assert.deepEqual(newBlock!.directBlockIds.sort(), ["b1", "b2"]);
    assert.ok(result.state.blocks.find((b) => b.blockId === "b1")!.active === false);
});

test("mergeMarkedBlocks refuses to merge fewer than 2 blocks", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [block({ blockId: "b1", active: true })],
    };
    const result = mergeMarkedBlocks(state, ["b1"], 5000, defaultCountTokens);
    assert.equal(result.mergedCount, 0);
});

test("collectOldGenBlocks gathers old-generation or oversized active blocks", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            block({ blockId: "b1", generation: "young", active: true }),
            block({ blockId: "b2", generation: "old", active: true }),
            block({ blockId: "b3", generation: "young", summary: "x".repeat(100), active: true }),
            block({ blockId: "b4", generation: "old", active: false }),
        ],
    };
    const collected = collectOldGenBlocks(state, 50);
    assert.equal(collected.length, 2);
    assert.ok(collected.some((b) => b.blockId === "b2"));
    assert.ok(collected.some((b) => b.blockId === "b3"));
});

test("rebuildCompressionState replays historical compress tool calls", () => {
    const compressInput = JSON.stringify({
        content: [
            { startId: "m00001", endId: "m00002", summary: "rebuilt summary of early talk", topic: "intro" },
        ],
    });
    const messages: CoreMessage[] = [
        { id: "raw1", role: "user", contentType: "text", text: "first message content" },
        { id: "raw2", role: "assistant", contentType: "text", text: "second message content" },
        { id: "raw3", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call1", text: compressInput },
        { id: "raw4", role: "user", contentType: "text", text: "later message" },
    ];
    const config = defaultConfig(200000, { compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 } });
    const result = rebuildCompressionState(createInitialState(), messages, config);
    assert.ok(result.blocksRebuilt >= 1);
    const rebuiltBlock = result.state.blocks.find((b) => b.summary.includes("rebuilt summary"));
    assert.ok(rebuiltBlock);
    assert.equal(rebuiltBlock!.compressCallId, "call1");
    assert.ok(result.state.messageRefs.byRaw["raw1"]);
});

test("rebuildCompressionState returns zero blocks when no compress calls exist", () => {
    const messages: CoreMessage[] = [
        { id: "raw1", role: "user", contentType: "text", text: "plain" },
    ];
    const result = rebuildCompressionState(createInitialState(), messages, defaultConfig(200000));
    assert.equal(result.blocksRebuilt, 0);
});
