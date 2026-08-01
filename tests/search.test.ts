import test from "node:test";
import assert from "node:assert";
import { searchBlocks, searchBlocksAsync, blockDocs, messageDocs } from "../src/search.js";
import { registerSearchAlgorithm, listSearchAlgorithms } from "../src/search.js";
import { createInitialState } from "../src/state.js";
import type { CompressionState, CompressionBlock } from "../src/types.js";
import type { SearchDoc } from "../src/search/types.js";

function makeBlock(overrides: Partial<CompressionBlock>): CompressionBlock {
    return {
        blockId: "b1", runId: "r1", tier: 1, active: true, topic: "", summary: "",
        directMessageIds: [], effectiveMessageIds: [], survivedCount: 0, createdAt: Date.now(),
        ...overrides,
    };
}

function stateWithBlocks(...blocks: CompressionBlock[]): CompressionState {
    return { ...createInitialState(), blocks };
}

// ─────────────────────────────────────────────────────────────────────────
// Blocks: active + inactive now both searchable
// ─────────────────────────────────────────────────────────────────────────

test("blockDocs: includes BOTH active and inactive blocks", () => {
    const state = stateWithBlocks(
        makeBlock({ blockId: "b1", active: true, topic: "active", summary: "live content" }),
        makeBlock({ blockId: "b2", active: false, topic: "archived", summary: "old content" }),
    );
    const docs = blockDocs(state);
    assert.equal(docs.length, 2);
    assert.ok(docs.some((d) => d.ref === "b1"));
    assert.ok(docs.some((d) => d.ref === "b2"));
});

test("searchBlocks: finds match in active block", () => {
    const docs = blockDocs(stateWithBlocks(
        makeBlock({ blockId: "b1", summary: "Auth token refresh", topic: "Auth" }),
        makeBlock({ blockId: "b2", summary: "database pool", topic: "DB" }),
    ));
    const r = searchBlocks(docs, "auth");
    assert.equal(r.length, 1);
    assert.equal(r[0].ref, "b1");
    assert.equal(r[0].kind, "block");
    assert.ok(r[0].score > 0);
});

test("searchBlocks: finds match in INACTIVE block (the bug fix)", () => {
    const docs = blockDocs(stateWithBlocks(
        makeBlock({ blockId: "b1", active: true, summary: "current work" }),
        makeBlock({ blockId: "b2", active: false, summary: "old auth token logic" }),
    ));
    const r = searchBlocks(docs, "auth");
    assert.equal(r.length, 1);
    assert.equal(r[0].ref, "b2");
});

// ─────────────────────────────────────────────────────────────────────────
// Messages: original text searchable, with role weighting
// ─────────────────────────────────────────────────────────────────────────

test("messageDocs: builds message docs from inputs", () => {
    const docs = messageDocs([
        { ref: "m00100", role: "user", text: "how does auth work", blockId: "b1" },
        { ref: "m00200", role: "tool", text: "auth.ts: 401 handler", blockId: "b1" },
    ]);
    assert.equal(docs.length, 2);
    assert.equal(docs[0].kind, "message");
    assert.equal(docs[0].role, "user");
    assert.equal(docs[0].blockId, "b1");
});

test("searchBlocks: searches messages by original text", () => {
    const docs = messageDocs([
        { ref: "m00100", role: "user", text: "implement jwt refresh endpoint", blockId: "b1" },
        { ref: "m00200", role: "tool", text: "postgres connection string", blockId: "b2" },
    ]);
    const r = searchBlocks(docs, "jwt");
    assert.equal(r.length, 1);
    assert.equal(r[0].ref, "m00100");
    assert.equal(r[0].kind, "message");
    assert.equal(r[0].blockId, "b1", "result carries owning block for decompress");
});

test("searchBlocks: user role outranks tool role at equal text match (role weighting)", () => {
    const docs = messageDocs([
        { ref: "m-tool", role: "tool", text: "match match here", blockId: "b1" },
        { ref: "m-user", role: "user", text: "match match here", blockId: "b1" },
    ]);
    const r = searchBlocks(docs, "match");
    assert.equal(r[0].ref, "m-user", "user (1.5x) beats tool (0.6x) on same content");
    assert.ok(r[0].score > r[1].score);
});

test("searchBlocks: roleWeights option overrides defaults", () => {
    const docs = messageDocs([
        { ref: "m-tool", role: "tool", text: "match match here", blockId: "b1" },
        { ref: "m-user", role: "user", text: "match match here", blockId: "b1" },
    ]);
    // equalize weights → scores tie, order falls back to original
    const r = searchBlocks(docs, "match", { roleWeights: { user: 1, tool: 1, assistant: 1, block: 1 } });
    assert.ok(Math.abs(r[0].score - r[1].score) < 1e-9);
});

test("searchBlocks: mixed blocks + messages ranked together", () => {
    const docs = [
        ...blockDocs(stateWithBlocks(makeBlock({ blockId: "b1", summary: "auth token refresh", topic: "auth" }))),
        ...messageDocs([{ ref: "m00500", role: "assistant", text: "auth token refresh detail", blockId: "b1" }]),
    ];
    const r = searchBlocks(docs, "auth");
    assert.equal(r.length, 2);
    // both should appear; refs preserved
    const refs = r.map((x) => x.ref);
    assert.ok(refs.includes("b1"));
    assert.ok(refs.includes("m00500"));
});

// ─────────────────────────────────────────────────────────────────────────
// Result shape: ref, tokens, preview, decompress hint
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: message result includes tokens + blockId (for decompress hint)", () => {
    const docs = messageDocs([{ ref: "m00420", role: "user", text: "login flow design".padEnd(500, "."), blockId: "b7", tokens: 150 }]);
    const r = searchBlocks(docs, "login");
    assert.equal(r[0].ref, "m00420");
    assert.equal(r[0].blockId, "b7");
    assert.equal(r[0].tokens, 150);
    assert.match(r[0].preview, /login/);
});

test("searchBlocks: preview centers on the matched term", () => {
    const docs = messageDocs([{
        ref: "m1", role: "assistant",
        text: "padding ".repeat(20) + " NEEDLE found here " + "more ".repeat(20),
        blockId: "b1",
    }]);
    const r = searchBlocks(docs, "NEEDLE", { previewLength: 40 });
    assert.match(r[0].preview, /NEEDLE/);
    assert.ok(!r[0].preview.startsWith("padding padding"));
});

// ─────────────────────────────────────────────────────────────────────────
// Generic behavior + algorithm selection
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: empty query returns nothing", () => {
    const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "content" })));
    assert.equal(searchBlocks(docs, "").length, 0);
    assert.equal(searchBlocks(docs, "   ").length, 0);
});

test("searchBlocks: respects limit", () => {
    const docs = blockDocs(stateWithBlocks(
        ...Array.from({ length: 20 }, (_, i) => makeBlock({ blockId: `b${i}`, summary: "match match match" })),
    ));
    assert.equal(searchBlocks(docs, "match", { limit: 5 }).length, 5);
});

test("searchBlocks: sorts by score descending", () => {
    const docs = blockDocs(stateWithBlocks(
        makeBlock({ blockId: "b1", summary: "one match" }),
        makeBlock({ blockId: "b2", summary: "match match match match" }),
        makeBlock({ blockId: "b3", summary: "match match" }),
    ));
    const r = searchBlocks(docs, "match");
    assert.equal(r[0].ref, "b2");
    assert.ok(r[0].score >= r[1].score);
});

test("searchBlocks: case insensitive", () => {
    const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "Auth Token Refresh" })));
    assert.equal(searchBlocks(docs, "AUTH token").length, 1);
});

test("searchBlocks: algorithm option selects algorithm", () => {
    const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "auth token" })));
    const hybrid = searchBlocks(docs, "auth", { algorithm: "hybrid" });
    const substr = searchBlocks(docs, "auth", { algorithm: "substring" });
    assert.ok(hybrid.length > 0 && substr.length > 0);
    assert.ok(substr[0].score >= 1, "substring score is occurrence count");
    assert.ok(hybrid[0].score <= 1.0001, "hybrid score is normalized");
});

test("searchBlocks: unknown algorithm returns empty", () => {
    const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "match" })));
    assert.equal(searchBlocks(docs, "match", { algorithm: "nope" }).length, 0);
});

test("listSearchAlgorithms: includes all builtins", () => {
    const names = listSearchAlgorithms().map((a) => a.name);
    for (const n of ["hybrid", "bm25", "fuzzy", "substring"]) assert.ok(names.includes(n));
});

test("registerSearchAlgorithm: custom algorithm usable by name", () => {
    registerSearchAlgorithm({
        name: "test-prefix",
        description: "prefix-only scorer",
        score(docs, query) {
            const q = query.toLowerCase();
            return docs.map((d) => ({ ref: d.ref, score: d.text.toLowerCase().startsWith(q) ? 1 : 0 }));
        },
    });
    const docs = messageDocs([
        { ref: "m1", role: "user", text: "prefix match", blockId: "b1" },
        { ref: "m2", role: "user", text: "no prefix here", blockId: "b2" },
    ]);
    const r = searchBlocks(docs, "prefix", { algorithm: "test-prefix" });
    assert.equal(r.length, 1);
    assert.equal(r[0].ref, "m1");
});

// ─────────────────────────────────────────────────────────────────────────
// Hybrid quality properties
// ─────────────────────────────────────────────────────────────────────────

test("hybrid: CJK query matches CJK content", () => {
    const docs = [
        ...blockDocs(stateWithBlocks(makeBlock({ blockId: "b1", topic: "用户认证", summary: "实现了用户登录认证流程" }))),
        ...messageDocs([{ ref: "m1", role: "assistant", text: "database postgres pool", blockId: "b2" }]),
    ];
    const r = searchBlocks(docs, "登录");
    assert.equal(r[0].ref, "b1");
});

test("hybrid: typo tolerance via fuzzy", () => {
    const docs = messageDocs([{ ref: "m1", role: "assistant", text: "authentication token refresh", blockId: "b1" }]);
    const r = searchBlocks(docs, "tokan");
    assert.equal(r[0].ref, "m1");
});

test("hybrid: stemming matches morphological variants", () => {
    const docs = blockDocs(stateWithBlocks(
        makeBlock({ blockId: "b1", topic: "compress", summary: "the compress utility" }),
        makeBlock({ blockId: "b2", topic: "other", summary: "completely different caching topic" }),
    ));
    const r = searchBlocks(docs, "compressed");
    assert.equal(r[0].ref, "b1");
});

// ─────────────────────────────────────────────────────────────────────────
// Async / semantic
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: throws for async algorithm when sync entry used", async () => {
    const { createSemanticAlgorithm } = await import("../src/search/algorithms/semantic.js");
    registerSearchAlgorithm(createSemanticAlgorithm({ embed: async (t) => t.map(() => [1, 0]) }));
    const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "auth login" })));
    assert.throws(() => searchBlocks(docs, "login", { algorithm: "semantic" }), /searchBlocksAsync/);
});

test("searchBlocksAsync: semantic ranks synonyms by cosine similarity", async () => {
    const { createSemanticAlgorithm } = await import("../src/search/algorithms/semantic.js");
    const vocab: Record<string, number[]> = {
        auth: [1, 0], login: [0.95, 0.05], signin: [0.9, 0.1], database: [0, 1],
    };
    const semantic = createSemanticAlgorithm({
        embed: async (texts: string[]) => texts.map((t) => {
            const hit = Object.keys(vocab).find((k) => t.toLowerCase().includes(k));
            return hit ? vocab[hit]! : [0, 0, 1];
        }),
        name: "semantic-syn",
    });
    registerSearchAlgorithm(semantic);
    const docs = messageDocs([
        { ref: "m1", role: "user", text: "login authentication", blockId: "b1" },
        { ref: "m2", role: "user", text: "database postgres", blockId: "b2" },
    ]);
    const r = await searchBlocksAsync(docs, "signin", { algorithm: "semantic-syn" });
    assert.equal(r[0].ref, "m1", "semantic catches synonym signin≈login");
});
