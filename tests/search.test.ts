import test from "node:test";
import assert from "node:assert";
import { searchBlocks } from "../src/search.js";
import { createInitialState } from "../src/state.js";
import type { CompressionState, CompressionBlock } from "../src/types.js";

function makeBlock(overrides: Partial<CompressionBlock>): CompressionBlock {
    return {
        blockId: "b1",
        runId: "r1",
        tier: 1,
        active: true,
        topic: "",
        summary: "",
        directMessageIds: [],
        effectiveMessageIds: [],
        survivedCount: 0,
        createdAt: Date.now(),
        ...overrides,
    };
}

test("searchBlocks: returns empty for empty state", () => {
    const state = createInitialState();
    const results = searchBlocks(state, "anything");
    assert.equal(results.length, 0);
});

test("searchBlocks: finds matching block by summary", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({
                blockId: "b1",
                summary: "Auth token refresh logic in auth.ts",
                topic: "Auth implementation",
            }),
            makeBlock({
                blockId: "b2",
                summary: "Database connection pooling",
                topic: "DB layer",
            }),
        ],
    };
    const results = searchBlocks(state, "auth");
    assert.equal(results.length, 1);
    assert.equal(results[0].blockId, "b1");
    assert.ok(results[0].score >= 2);
});

test("searchBlocks: searches both topic and summary", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({
                blockId: "b1",
                topic: "config loading",
                summary: "Three-layer config merge",
            }),
        ],
    };
    const results = searchBlocks(state, "config");
    assert.equal(results.length, 1);
    assert.equal(results[0].score, 2);
});

test("searchBlocks: multi-term query accumulates score", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({
                blockId: "b1",
                topic: "token",
                summary: "token token refresh token",
            }),
        ],
    };
    const results = searchBlocks(state, "token refresh");
    assert.equal(results.length, 1);
    assert.ok(results[0].score >= 5);
});

test("searchBlocks: sorts by score descending", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", summary: "one match here" }),
            makeBlock({ blockId: "b2", summary: "match match match match" }),
            makeBlock({ blockId: "b3", summary: "match match" }),
        ],
    };
    const results = searchBlocks(state, "match");
    assert.equal(results.length, 3);
    assert.equal(results[0].blockId, "b2");
    assert.equal(results[1].blockId, "b3");
    assert.equal(results[2].blockId, "b1");
});

test("searchBlocks: skips inactive blocks", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", active: true, summary: "active match" }),
            makeBlock({ blockId: "b2", active: false, summary: "inactive match match match" }),
        ],
    };
    const results = searchBlocks(state, "match");
    assert.equal(results.length, 1);
    assert.equal(results[0].blockId, "b1");
});

test("searchBlocks: respects limit option", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: Array.from({ length: 20 }, (_, i) =>
            makeBlock({ blockId: `b${i}`, summary: "match match match" }),
        ),
    };
    const results = searchBlocks(state, "match", { limit: 5 });
    assert.equal(results.length, 5);
});

test("searchBlocks: empty query returns nothing", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [makeBlock({ summary: "some content" })],
    };
    assert.equal(searchBlocks(state, "").length, 0);
    assert.equal(searchBlocks(state, "   ").length, 0);
});

test("searchBlocks: case insensitive", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [makeBlock({ summary: "Auth Token Refresh" })],
    };
    const results = searchBlocks(state, "AUTH token");
    assert.equal(results.length, 1);
    assert.ok(results[0].score >= 2);
});

test("searchBlocks: includes preview and tier in results", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({
                tier: 2,
                topic: "compressed history",
                summary: "A".repeat(300),
            }),
        ],
    };
    const results = searchBlocks(state, "compressed", { previewLength: 50 });
    assert.equal(results.length, 1);
    assert.equal(results[0].tier, 2);
    assert.equal(results[0].preview.length, 50);
    assert.equal(results[0].topic, "compressed history");
});

test("searchBlocks: minScore filters low-scoring results", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", summary: "one match" }),
            makeBlock({ blockId: "b2", summary: "match match match match match" }),
        ],
    };
    const results = searchBlocks(state, "match", { minScore: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0].blockId, "b2");
});
