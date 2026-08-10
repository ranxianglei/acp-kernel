import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { rebuildCompressionState } from "../src/rebuild.js";
import { createInitialState } from "../src/state.js";
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

test("hideConsumedCompressCalls keeps active-block compress calls, hides all orphaned", () => {
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
    // active-block call kept; consumed + all orphaned hidden (KEEP_LAST_ORPHANED=0).
    assert.equal(result.hidden, 3);
    const remainingCallIds = result.messages.filter((m) => m.toolName === "compress").map((m) => m.toolCallId);
    assert.ok(remainingCallIds.includes("call-active"));
    assert.ok(!remainingCallIds.includes("call-consumed"));
    assert.ok(!remainingCallIds.includes("call-orphan1"));
    assert.ok(!remainingCallIds.includes("call-orphan2"));
    assert.ok(result.messages.some((m) => m.text === "hello"));
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
    const config = defaultConfig(200000, { compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 }, preserveRecentMessages: 0, preserveRecentTokens: 0 });
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
    const result = rebuildCompressionState(createInitialState(), messages, defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }));
    assert.equal(result.blocksRebuilt, 0);
});

function compressInput(entries: Array<{ startId: string; endId: string; summary: string }>): string {
    return JSON.stringify({ content: entries });
}

function parseContent(text: string | undefined): Array<{ startId?: string; endId?: string; summary?: string }> {
    return (JSON.parse(text ?? "{}") as { content?: Array<{ startId?: string; endId?: string; summary?: string }> }).content ?? [];
}

test("batched compress: rewrites kept call to drop consumed sibling entries (issue #288)", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            block({ blockId: "b5", compressCallId: "call-batch", active: true, startRef: "m5", endRef: "m6" }),
            block({ blockId: "b8", compressCallId: "call-batch", active: false, startRef: "m8", endRef: "m9" }),
        ],
    };
    const messages: CoreMessage[] = [
        {
            id: "mc", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-batch",
            text: compressInput([
                { startId: "m5", endId: "m6", summary: "live entry summary" },
                { startId: "m8", endId: "m9", summary: "consumed entry summary" },
            ]),
        },
    ];
    const result = hideConsumedCompressCalls(state, messages);
    assert.equal(result.hidden, 0, "kept batch is not removed");
    const kept = result.messages.find((m) => m.toolCallId === "call-batch");
    assert.ok(kept, "batch call survives (one live sibling)");
    const content = parseContent(kept!.text);
    assert.equal(content.length, 1, "consumed entry dropped, live entry retained");
    assert.equal(content[0]!.startId, "m5");
    assert.equal(content[0]!.summary, "live entry summary");
});

test("batched compress: no rewrite when all sibling blocks are live", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            block({ blockId: "b5", compressCallId: "call-batch", active: true, startRef: "m5", endRef: "m6" }),
            block({ blockId: "b8", compressCallId: "call-batch", active: true, startRef: "m8", endRef: "m9" }),
        ],
    };
    const messages: CoreMessage[] = [
        {
            id: "mc", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-batch",
            text: compressInput([
                { startId: "m5", endId: "m6", summary: "S1" },
                { startId: "m8", endId: "m9", summary: "S2" },
            ]),
        },
    ];
    const result = hideConsumedCompressCalls(state, messages);
    assert.equal(result.hidden, 0);
    const kept = result.messages.find((m) => m.toolCallId === "call-batch")!;
    assert.equal(parseContent(kept.text).length, 2, "both live entries retained, no rewrite");
});

test("batched compress: fully removed when all sibling blocks consumed", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            block({ blockId: "b5", compressCallId: "call-batch", active: false, startRef: "m5", endRef: "m6" }),
            block({ blockId: "b8", compressCallId: "call-batch", active: false, startRef: "m8", endRef: "m9" }),
        ],
    };
    const messages: CoreMessage[] = [
        {
            id: "mc", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-batch",
            text: compressInput([
                { startId: "m5", endId: "m6", summary: "S1" },
                { startId: "m8", endId: "m9", summary: "S2" },
            ]),
        },
    ];
    const result = hideConsumedCompressCalls(state, messages);
    assert.equal(result.hidden, 1, "fully-consumed batch removed");
    assert.equal(result.messages.find((m) => m.toolCallId === "call-batch"), undefined);
});

test("batched compress: legacy live block (no startRef/endRef) keeps whole part intact", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            block({ blockId: "b5", compressCallId: "call-batch", active: true, startRef: "m5", endRef: "m6" }),
            block({ blockId: "b8", compressCallId: "call-batch", active: true }),
        ],
    };
    const messages: CoreMessage[] = [
        {
            id: "mc", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-batch",
            text: compressInput([
                { startId: "m5", endId: "m6", summary: "S1" },
                { startId: "m8", endId: "m9", summary: "S2" },
            ]),
        },
    ];
    const result = hideConsumedCompressCalls(state, messages);
    assert.equal(result.hidden, 0);
    const kept = result.messages.find((m) => m.toolCallId === "call-batch")!;
    assert.equal(parseContent(kept.text).length, 2, "legacy live block → no rewrite, all entries kept");
});
