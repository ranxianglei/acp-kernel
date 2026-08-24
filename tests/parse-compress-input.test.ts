import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompressArgs } from "../src/parse-compress-input.js";
import { rebuildCompressionState } from "../src/rebuild.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CompressRangeSpec, CoreMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Input-shape normalization
// ---------------------------------------------------------------------------

test("parseCompressArgs parses a valid object with all fields", () => {
    const input = {
        content: [
            { startRef: "m00001", endRef: "m00002", summary: "intro", topic: "setup", summaryMaxChars: 5000 },
        ],
    };
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(diagnostics.ok, true);
    assert.equal(diagnostics.invalidItems, 0);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.startRef, "m00001");
    assert.equal(ranges[0]?.endRef, "m00002");
    assert.equal(ranges[0]?.summary, "intro");
    assert.equal(ranges[0]?.topic, "setup");
    assert.equal(ranges[0]?.summaryMaxChars, 5000);
});

test("parseCompressArgs parses a raw JSON document string", () => {
    const input = JSON.stringify({
        content: [{ startRef: "m00001", endRef: "m00002", summary: "intro" }],
    });
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "intro");
    assert.equal(diagnostics.length, input.length);
    assert.equal(diagnostics.rawPrefix, input.slice(0, 800));
});

test("parseCompressArgs unwraps one level of double-stringification", () => {
    const input = JSON.stringify(
        JSON.stringify({
            content: [{ startRef: "m00001", endRef: "m00002", summary: "doubled" }],
        }),
    );
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "doubled");
});

test("parseCompressArgs accepts a stringified content array (vLLM shape)", () => {
    const input = {
        content: JSON.stringify([{ startRef: "m00001", endRef: "m00002", summary: "vllm" }]),
    };
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.startRef, "m00001");
    assert.equal(ranges[0]?.summary, "vllm");
});

test("parseCompressArgs salvages a stringified content array truncated mid-entry", () => {
    const full = [
        { startRef: "m00001", endRef: "m00002", summary: "first entry complete" },
        { startRef: "m00003", endRef: "m00004", summary: "second entry cut off mid" },
    ];
    const cut = JSON.stringify(full).slice(0, JSON.stringify(full).length - 12);
    const input = { content: cut };
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "truncated");
    assert.equal(diagnostics.ok, true);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "first entry complete");
    assert.equal(diagnostics.invalidItems, 0);
});

test("parseCompressArgs strips markdown fences (with and without language tag)", () => {
    const doc = JSON.stringify({
        content: [{ startRef: "m00001", endRef: "m00002", summary: "fenced" }],
    });
    for (const input of ["```json\n" + doc + "\n```", "```\n" + doc + "\n```"]) {
        const { ranges, diagnostics } = parseCompressArgs(input);
        assert.equal(diagnostics.kind, "ok", "expected ok for: " + input.slice(0, 20));
        assert.equal(ranges.length, 1);
        assert.equal(ranges[0]?.summary, "fenced");
    }
});

test("parseCompressArgs repairs trailing commas", () => {
    const input =
        '{"content": [{"startRef": "m00001", "endRef": "m00002", "summary": "S",}]}';
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "S");
});

test("parseCompressArgs escapes raw newlines inside JSON string values", () => {
    // A provider serialized a real newline inside the summary string.
    const input =
        '{"content": [{"startRef": "m00001", "endRef": "m00002", "summary": "line1\nline2"}]}';
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "line1\nline2");
});

test("parseCompressArgs preserves escaped quotes in salvaged entries", () => {
    const entry = { startRef: "m00001", endRef: "m00002", summary: 'has "quotes" inside' };
    const doc = JSON.stringify({ content: [entry, { startRef: "m00003", endRef: "m00004", summary: "gone" }] });
    // Cut after the first entry's closing brace (the comma follows it).
    const firstClose = doc.indexOf("}") + 1;
    const input = doc.slice(0, firstClose) + ', {"startRef": "m00003", "endRef": "m0';
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "truncated");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, 'has "quotes" inside');
});

// ---------------------------------------------------------------------------
// Truncation salvage
// ---------------------------------------------------------------------------

test("parseCompressArgs salvages complete entries from a truncated JSON prefix", () => {
    const doc = JSON.stringify({
        content: [
            { startRef: "m00001", endRef: "m00002", summary: "first entry complete" },
            { startRef: "m00003", endRef: "m00004", summary: "second entry cut off mid" },
        ],
    });
    const input = doc.slice(0, doc.length - 12);
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "truncated");
    assert.equal(diagnostics.ok, true);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "first entry complete");
});

test("parseCompressArgs salvages entries when the closing brackets are missing entirely", () => {
    const entry = '{"startRef": "m00001", "endRef": "m00002", "summary": "no brackets after me"}';
    const input = '{"content": [' + entry + ", {\"startRef\": \"m00003\"";
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "truncated");
    assert.equal(diagnostics.ok, true);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "no brackets after me");
});

test("parseCompressArgs reports truncated with no ranges when the first entry is cut", () => {
    const input = '{"content": [{"startRef": "m00001", "endRef": "m0';
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "truncated");
    assert.equal(diagnostics.ok, false);
    assert.equal(ranges.length, 0);
});

test("parseCompressArgs does not fabricate partial entries", () => {
    // startRef present, endRef/summary missing and cut: entry is incomplete, must be dropped.
    const input = '{"content": [{"startRef": "m00001", "summary": "par';
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "truncated");
    assert.equal(ranges.length, 0);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("parseCompressArgs classifies empty inputs", () => {
    for (const input of [null, undefined, "", "   "]) {
        const { ranges, diagnostics } = parseCompressArgs(input);
        assert.equal(diagnostics.kind, "empty-input", JSON.stringify(input));
        assert.equal(diagnostics.ok, false);
        assert.equal(ranges.length, 0);
    }
});

test("parseCompressArgs classifies non-object parsed values", () => {
    for (const input of [[], 42, '"just a string"', "true"]) {
        const { ranges, diagnostics } = parseCompressArgs(input);
        assert.equal(diagnostics.kind, "not-object", JSON.stringify(input));
        assert.equal(diagnostics.ok, false);
        assert.equal(ranges.length, 0);
    }
});

test("parseCompressArgs classifies an object without a content key", () => {
    const { diagnostics } = parseCompressArgs({ foo: 1, bar: "x" });
    assert.equal(diagnostics.kind, "missing-content");
    assert.equal(diagnostics.ok, false);
    assert.deepEqual(diagnostics.keys, ["foo", "bar"]);
});

test("parseCompressArgs classifies a content value that is neither array nor array-string", () => {
    const { diagnostics } = parseCompressArgs({ content: "123" });
    assert.equal(diagnostics.kind, "content-not-array");
    assert.equal(diagnostics.ok, false);
});

test("parseCompressArgs classifies balanced garbage as malformed-json", () => {
    const { ranges, diagnostics } = parseCompressArgs("hello");
    assert.equal(diagnostics.kind, "malformed-json");
    assert.equal(diagnostics.ok, false);
    assert.equal(ranges.length, 0);
});

test("parseCompressArgs counts invalid entries and keeps the valid ones", () => {
    const input = {
        content: [
            { startRef: "m00001", endRef: "m00002", summary: "good" },
            { summary: "missing refs" },
            { startRef: "m00003", endRef: "m00004" },
            { startRef: "m00005", endRef: "m00006", summary: 42 },
            "garbage",
            null,
        ],
    };
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "good");
    assert.equal(diagnostics.invalidItems, 5);
});

test("parseCompressArgs reports no-valid-ranges for an empty content array", () => {
    const { ranges, diagnostics } = parseCompressArgs({ content: [] });
    assert.equal(diagnostics.kind, "no-valid-ranges");
    assert.equal(diagnostics.ok, false);
    assert.equal(ranges.length, 0);
    assert.equal(diagnostics.invalidItems, 0);
});

test("parseCompressArgs reports no-valid-ranges for an empty stringified content", () => {
    const { ranges, diagnostics } = parseCompressArgs({ content: "" });
    assert.equal(diagnostics.kind, "no-valid-ranges");
    assert.equal(ranges.length, 0);
});

// ---------------------------------------------------------------------------
// Field-name variants and call-id stamping
// ---------------------------------------------------------------------------

test("parseCompressArgs accepts startId/endId and messageId name variants", () => {
    const { ranges, diagnostics } = parseCompressArgs({
        content: [
            { startId: "m00001", endId: "m00002", summary: "variant-a" },
            { messageId: "m00003", summary: "variant-b" },
        ],
    });
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0]?.startRef, "m00001");
    assert.equal(ranges[0]?.endRef, "m00002");
    assert.equal(ranges[1]?.startRef, "m00003");
    assert.equal(ranges[1]?.endRef, "m00003");
});

test("parseCompressArgs stamps compressCallId when a callId is provided", () => {
    const input = { content: [{ startRef: "m00001", endRef: "m00002", summary: "stamped" }] };
    const stamped = parseCompressArgs(input, { callId: "call-9" });
    assert.equal(stamped.ranges[0]?.compressCallId, "call-9");
    const plain = parseCompressArgs(input);
    assert.equal(plain.ranges[0]?.compressCallId, undefined);
});

// ---------------------------------------------------------------------------
// Diagnostics shape
// ---------------------------------------------------------------------------

test("parseCompressArgs caps rawPrefix at 800 chars and reports full length", () => {
    const input = "x".repeat(1000);
    const { diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "malformed-json");
    assert.equal(diagnostics.length, 1000);
    assert.equal(diagnostics.rawPrefix?.length, 800);
});

test("parseCompressArgs leaves rawPrefix/length undefined for object input", () => {
    const { diagnostics } = parseCompressArgs({ content: [] });
    assert.equal(diagnostics.rawPrefix, undefined);
    assert.equal(diagnostics.length, undefined);
});

// ---------------------------------------------------------------------------
// rebuildCompressionState regression (fork-recovery path)
// ---------------------------------------------------------------------------

function rebuildMessages(toolCallText: string, toolCallId: string): CoreMessage[] {
    const messages: CoreMessage[] = [
        { id: "raw1", role: "user", contentType: "text", text: "first message" },
        { id: "raw2", role: "assistant", contentType: "text", text: "second message" },
    ];
    if (toolCallText !== "") {
        messages.push({
            id: "raw3",
            role: "assistant",
            contentType: "tool-call",
            toolName: "compress",
            toolCallId,
            text: toolCallText,
        });
    }
    return messages;
}

function rebuildConfig() {
    return defaultConfig(200000, {
        compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
    });
}

test("rebuildCompressionState rebuilds from a strict JSON object (pre-existing behavior)", () => {
    const args = JSON.stringify({
        content: [{ startId: "m00001", endId: "m00002", summary: "strict object" }],
    });
    const result = rebuildCompressionState(createInitialState(), rebuildMessages(args, "call1"), rebuildConfig());
    assert.equal(result.blocksRebuilt, 1);
    const block = result.state.blocks.find((b) => b.summary.includes("strict object"));
    assert.ok(block);
    assert.equal(block.compressCallId, "call1");
});

test("rebuildCompressionState recovers vLLM stringified content (fork-recovery gap fix)", () => {
    // vLLM hosts stringify the nested content array; the old strict
    // Array.isArray check dropped these silently.
    const args = JSON.stringify({
        content: JSON.stringify([{ startId: "m00001", endId: "m00002", summary: "vllm stringified" }]),
    });
    const result = rebuildCompressionState(createInitialState(), rebuildMessages(args, "call1"), rebuildConfig());
    assert.equal(result.blocksRebuilt, 1);
    const block = result.state.blocks.find((b) => b.summary.includes("vllm stringified"));
    assert.ok(block);
    assert.equal(block.compressCallId, "call1");
});

test("rebuildCompressionState salvages a truncated compress tool-call text", () => {
    const doc = JSON.stringify({
        content: [
            { startId: "m00001", endId: "m00002", summary: "survives truncation" },
            { startId: "m00003", endId: "m00004", summary: "cut off here" },
        ],
    });
    const result = rebuildCompressionState(
        createInitialState(),
        rebuildMessages(doc.slice(0, doc.length - 12), "call1"),
        rebuildConfig(),
    );
    assert.equal(result.blocksRebuilt, 1);
    assert.ok(result.state.blocks.find((b) => b.summary.includes("survives truncation")));
});

test("rebuildCompressionState survives garbage tool-call text without rebuilding", () => {
    const result = rebuildCompressionState(
        createInitialState(),
        rebuildMessages("total garbage not json", "call1"),
        rebuildConfig(),
    );
    assert.equal(result.blocksRebuilt, 0);
    assert.equal(result.state.blocks.length, 0);
});

test("rebuildCompressionState skips compress calls with no valid ranges", () => {
    const result = rebuildCompressionState(
        createInitialState(),
        rebuildMessages(JSON.stringify({ content: [] }), "call1"),
        rebuildConfig(),
    );
    assert.equal(result.blocksRebuilt, 0);
    assert.equal(result.state.blocks.length, 0);
});

test("parseCompressArgs returns ranges typed as CompressRangeSpec", () => {
    // Compile-time contract: ranges feed core.applyCompression directly.
    const { ranges } = parseCompressArgs({
        content: [{ startRef: "m00001", endRef: "m00002", summary: "typed" }],
    });
    const spec: CompressRangeSpec | undefined = ranges[0];
    assert.ok(spec);
    assert.equal(typeof spec.startRef, "string");
});

// --- top-level shapes the adapters observe (single range, topic, summaryMaxChars) ---

test("parseCompressArgs accepts a single range at the top level (no content array)", () => {
    const { ranges, diagnostics } = parseCompressArgs({ startRef: "m00001", endRef: "m00002", summary: "single" });
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]!.startRef, "m00001");
    assert.equal(ranges[0]!.endRef, "m00002");
    assert.equal(ranges[0]!.summary, "single");
});

test("parseCompressArgs accepts a top-level single range with startId/endId variants", () => {
    const { ranges, diagnostics } = parseCompressArgs({ startId: "m00001", endId: "m00002", summary: "single" });
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]!.startRef, "m00001");
});

test("parseCompressArgs reports missing-content when there is no content and no valid single range", () => {
    const { ranges, diagnostics } = parseCompressArgs({ foo: "bar" });
    assert.equal(diagnostics.kind, "missing-content");
    assert.equal(ranges.length, 0);
});

test("parseCompressArgs applies a top-level topic to ranges without their own", () => {
    const { ranges } = parseCompressArgs({
        topic: "Top",
        content: [
            { startRef: "m00001", endRef: "m00002", summary: "a" },
            { startRef: "m00003", endRef: "m00004", summary: "b", topic: "Own" },
        ],
    });
    assert.equal(ranges[0]!.topic, "Top");
    assert.equal(ranges[1]!.topic, "Own");
});

test("parseCompressArgs applies a top-level summaryMaxChars to ranges without their own", () => {
    const { ranges } = parseCompressArgs({
        summaryMaxChars: 5000,
        content: [
            { startRef: "m00001", endRef: "m00002", summary: "a" },
            { startRef: "m00003", endRef: "m00004", summary: "b", summaryMaxChars: 999 },
        ],
    });
    assert.equal(ranges[0]!.summaryMaxChars, 5000);
    assert.equal(ranges[1]!.summaryMaxChars, 999);
});
