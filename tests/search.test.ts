import test from "node:test";
import assert from "node:assert";
import { searchBlocks, registerSearchAlgorithm, listSearchAlgorithms } from "../src/search.js";
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

// ─────────────────────────────────────────────────────────────────────────
// Generic behavior (algorithm-agnostic)
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: returns empty for empty state", () => {
    const state = createInitialState();
    const results = searchBlocks(state, "anything");
    assert.equal(results.length, 0);
});

test("searchBlocks: finds matching block by summary", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", summary: "Auth token refresh logic in auth.ts", topic: "Auth" }),
            makeBlock({ blockId: "b2", summary: "Database connection pooling", topic: "DB" }),
        ],
    };
    const results = searchBlocks(state, "auth");
    assert.equal(results.length, 1);
    assert.equal(results[0].blockId, "b1");
    assert.ok(results[0].score > 0);
});

test("searchBlocks: searches both topic and summary", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", topic: "config loading", summary: "Three-layer config merge" }),
        ],
    };
    const results = searchBlocks(state, "config");
    assert.equal(results.length, 1);
    assert.ok(results[0].score > 0);
});

test("searchBlocks: a match in BOTH topic and summary scores higher than one field alone", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", topic: "token", summary: "token token refresh token" }),
            makeBlock({ blockId: "b2", topic: "other", summary: "token appears once here" }),
        ],
    };
    const results = searchBlocks(state, "token");
    assert.equal(results[0].blockId, "b1");
    assert.ok(results[0].score > results[1].score);
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
    assert.ok(results[0].score >= results[1].score);
    assert.ok(results[1].score >= results[2].score);
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
        blocks: Array.from({ length: 20 }, (_, i) => makeBlock({ blockId: `b${i}`, summary: "match match match" })),
    };
    const results = searchBlocks(state, "match", { limit: 5 });
    assert.equal(results.length, 5);
});

test("searchBlocks: empty query returns nothing", () => {
    const state: CompressionState = { ...createInitialState(), blocks: [makeBlock({ summary: "content" })] };
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
    assert.ok(results[0].score > 0);
});

test("searchBlocks: includes preview and tier in results", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [makeBlock({ tier: 2, topic: "compressed history", summary: "A".repeat(300) })],
    };
    const results = searchBlocks(state, "compressed", { previewLength: 50 });
    assert.equal(results.length, 1);
    assert.equal(results[0].tier, 2);
    assert.ok(results[0].preview.length <= 52); // 50 + ellipsis allowance
    assert.equal(results[0].topic, "compressed history");
});

test("searchBlocks: minScore filters low-scoring results", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", summary: "one match" }),
            makeBlock({ blockId: "b2", summary: "match match match match match match match match" }),
        ],
    };
    const all = searchBlocks(state, "match");
    const high = searchBlocks(state, "match", { minScore: all[0].score - 0.001 });
    assert.ok(high.length < all.length, "minScore should filter out the weaker match");
    assert.equal(high[0].blockId, "b2");
});

// ─────────────────────────────────────────────────────────────────────────
// Algorithm selection & registry
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: algorithm option selects the algorithm", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [makeBlock({ blockId: "b1", summary: "authentication token" })],
    };
    const hybrid = searchBlocks(state, "auth", { algorithm: "hybrid" });
    const substr = searchBlocks(state, "auth", { algorithm: "substring" });
    assert.ok(hybrid.length > 0);
    assert.ok(substr.length > 0);
    // substring score is integer occurrence count; hybrid is normalized [0,1]
    assert.ok(substr[0].score >= 1, "substring score is occurrence count");
    assert.ok(hybrid[0].score <= 1.0001, "hybrid score is normalized");
});

test("listSearchAlgorithms: includes all builtins", () => {
    const names = listSearchAlgorithms().map((a) => a.name);
    assert.ok(names.includes("hybrid"));
    assert.ok(names.includes("bm25"));
    assert.ok(names.includes("fuzzy"));
    assert.ok(names.includes("substring"));
});

test("registerSearchAlgorithm: custom algorithm is usable by name", () => {
    registerSearchAlgorithm({
        name: "test-only-prefix",
        description: "scores by whether summary starts with query",
        score(docs, query) {
            const q = query.toLowerCase();
            return docs.map((d) => ({ blockId: d.blockId, score: d.summary.toLowerCase().startsWith(q) ? 1 : 0 }));
        },
    });
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", summary: "prefix match" }),
            makeBlock({ blockId: "b2", summary: "match without prefix" }),
        ],
    };
    const results = searchBlocks(state, "prefix", { algorithm: "test-only-prefix" });
    assert.equal(results.length, 1);
    assert.equal(results[0].blockId, "b1");
});

test("searchBlocks: unknown algorithm returns empty", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [makeBlock({ blockId: "b1", summary: "match" })],
    };
    assert.equal(searchBlocks(state, "match", { algorithm: "nonexistent" }).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Hybrid algorithm properties (the quality wins)
// ─────────────────────────────────────────────────────────────────────────

test("hybrid: CJK query matches CJK content (bigram tokenization)", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", topic: "用户认证", summary: "实现了用户登录认证流程" }),
            makeBlock({ blockId: "b2", topic: "database", summary: "postgres connection pool" }),
        ],
    };
    const results = searchBlocks(state, "登录");
    assert.equal(results.length, 1);
    assert.equal(results[0].blockId, "b1");
});

test("hybrid: stemming matches morphological variants", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            // query "compressed" must still hit a block that only has "compress"
            makeBlock({ blockId: "b1", topic: "compress tool", summary: "the compress utility" }),
            makeBlock({ blockId: "b2", topic: "unrelated", summary: "completely different topic about caching" }),
        ],
    };
    const results = searchBlocks(state, "compressed");
    assert.ok(results.length >= 1);
    assert.equal(results[0].blockId, "b1", "stemmed query must rank the morphological root #1");
});

test("hybrid: fuzzy tolerance for typos", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", topic: "auth", summary: "authentication token refresh" }),
            makeBlock({ blockId: "b2", topic: "db", summary: "database postgres pool" }),
        ],
    };
    // "tokan" is a typo of "token" — fuzzy bigrams should still rank b1 first
    const results = searchBlocks(state, "tokan");
    assert.ok(results.length > 0);
    assert.equal(results[0].blockId, "b1");
});

test("hybrid: preview centers on the matched term (snippet, not head)", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({
                blockId: "b1",
                summary: "AAAA " + "padding ".repeat(20) + " NEEDLE found here " + "more ".repeat(20) + " tail",
            }),
        ],
    };
    const results = searchBlocks(state, "NEEDLE", { previewLength: 40 });
    assert.equal(results.length, 1);
    assert.match(results[0].preview, /NEEDLE/);
    // not just the head (which is all "padding")
    assert.ok(!results[0].preview.startsWith("AAAA padding padding"));
});

// ─────────────────────────────────────────────────────────────────────────
// Async / semantic (embedding-based) algorithm
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: throws when algorithm is async and sync entry is used", async () => {
    const { createSemanticAlgorithm } = await import("../src/search/algorithms/semantic.js");
    const semantic = createSemanticAlgorithm({
        embed: async (texts) => texts.map(() => [1, 0, 0]),
    });
    registerSearchAlgorithm(semantic);
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [makeBlock({ blockId: "b1", summary: "auth login" })],
    };
    assert.throws(() => searchBlocks(state, "login", { algorithm: "semantic" }), /searchBlocksAsync/);
});

test("searchBlocksAsync: runs async semantic algorithm and ranks by cosine similarity", async () => {
    const { searchBlocksAsync } = await import("../src/search.js");
    const { createSemanticAlgorithm } = await import("../src/search/algorithms/semantic.js");

    // mock embeddings: "auth" and "login" map near [1,0]; "database" maps near [0,1]
    const vocab: Record<string, number[]> = {
        auth: [1, 0, 0], authentication: [0.95, 0.05, 0], login: [0.9, 0.1, 0],
        signin: [0.88, 0.1, 0], database: [0, 1, 0], postgres: [0.05, 0.95, 0],
    };
    const embed = async (texts: string[]): Promise<number[][]> =>
        texts.map((t) => {
            const hit = Object.keys(vocab).find((k) => t.toLowerCase().includes(k));
            return hit ? vocab[hit]! : [0, 0, 1];
        });

    const semantic = createSemanticAlgorithm({ embed, name: "semantic-test" });
    registerSearchAlgorithm(semantic);

    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", topic: "auth", summary: "login authentication" }),
            makeBlock({ blockId: "b2", topic: "db", summary: "database postgres" }),
        ],
    };

    // "signin" is a pure synonym — lexical hybrid misses this, semantic catches it
    const results = await searchBlocksAsync(state, "signin", { algorithm: "semantic-test" });
    assert.equal(results[0].blockId, "b1", "semantic must rank the synonym match #1");
    assert.ok(results[0].score > results[1].score);
});

test("semantic: embeddings are memoized — changed summary re-embeds, unchanged reuses", async () => {
    const { searchBlocksAsync } = await import("../src/search.js");
    const { createSemanticAlgorithm } = await import("../src/search/algorithms/semantic.js");
    let calls = 0;
    const embed = async (texts: string[]): Promise<number[][]> => {
        calls += texts.length;
        return texts.map(() => [1, 0]);
    };
    const semantic = createSemanticAlgorithm({ embed, name: "semantic-memo" });
    registerSearchAlgorithm(semantic);
    const mk = (s: string): CompressionState => ({
        ...createInitialState(),
        blocks: [
            makeBlock({ blockId: "b1", summary: s }),
            makeBlock({ blockId: "b2", summary: "stable" }),
        ],
    });
    await searchBlocksAsync(mk("v1"), "q", { algorithm: "semantic-memo" });
    const afterFirst = calls;
    // second call: b1 changed → re-embed b1 + query; b2 stable → reused
    await searchBlocksAsync(mk("v2"), "q", { algorithm: "semantic-memo" });
    assert.ok(calls > afterFirst, "changed doc re-embedded");
    assert.ok(calls - afterFirst <= 2, "stable doc was NOT re-embedded (memoized)");
});
