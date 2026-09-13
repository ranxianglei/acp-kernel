import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
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

const state: CompressionState = {
    ...createInitialState(),
    blocks: [block({ blockId: "b1", summary: "first block", topic: "auth", effectiveMessageIds: ["old1"] })],
};

const messages: CoreMessage[] = [{ id: "live1", role: "user", contentType: "text", text: "visible text message" }];

const SURFACE_LINE = "ACTIVE SURFACE: pack=lean v3 | host=billion-context-pi 0.1.69";
const FULL_META = { meta: { pack: "lean", packVersion: "v3", host: "billion-context-pi 0.1.69" } };

test("overview without meta stays byte-identical (no ACTIVE SURFACE line)", () => {
    const plain = buildStatusReport(state, messages, defaultCountTokens);
    assert.ok(!plain.includes("ACTIVE SURFACE"));
    assert.equal(plain.split("\n")[0], "CONTEXT BREAKDOWN");
});

test("empty meta object is indistinguishable from absent meta", () => {
    const plain = buildStatusReport(state, messages, defaultCountTokens);
    assert.equal(buildStatusReport(state, messages, defaultCountTokens, { meta: {} }), plain);
    assert.equal(
        buildStatusReport(state, [], defaultCountTokens, { scope: "compressed", meta: {} }),
        buildStatusReport(state, [], defaultCountTokens, { scope: "compressed" }),
    );
});

test("overview renders leading ACTIVE SURFACE line with full meta", () => {
    const lines = buildStatusReport(state, messages, defaultCountTokens, FULL_META).split("\n");
    assert.equal(lines[0], SURFACE_LINE);
    assert.equal(lines[1], "");
    assert.equal(lines[2], "CONTEXT BREAKDOWN");
});

test("compressed drilldown renders leading ACTIVE SURFACE line", () => {
    const report = buildStatusReport(state, [], defaultCountTokens, { scope: "compressed", ...FULL_META });
    const lines = report.split("\n");
    assert.equal(lines[0], SURFACE_LINE);
    assert.equal(lines[1], "");
    assert.ok(lines[2]!.startsWith("COMPRESSED — 1 blocks"));
});

test("compressed drilldown without meta unchanged", () => {
    const report = buildStatusReport(state, [], defaultCountTokens, { scope: "compressed" });
    assert.ok(!report.includes("ACTIVE SURFACE"));
    assert.ok(report.startsWith("COMPRESSED — 1 blocks"));
});

test("partial meta renders only declared parts", () => {
    assert.equal(
        buildStatusReport(state, messages, defaultCountTokens, { meta: { pack: "lean" } }).split("\n")[0],
        "ACTIVE SURFACE: pack=lean",
    );
    assert.equal(
        buildStatusReport(state, messages, defaultCountTokens, { meta: { host: "pi 0.1.69" } }).split("\n")[0],
        "ACTIVE SURFACE: host=pi 0.1.69",
    );
    assert.equal(
        buildStatusReport(state, messages, defaultCountTokens, { meta: { packVersion: "v3" } }).split("\n")[0],
        "ACTIVE SURFACE: pack=v3",
    );
});

test("uncompressed views never get the surface line", () => {
    const ranges = buildStatusReport(state, messages, defaultCountTokens, { scope: "uncompressed", ...FULL_META });
    assert.ok(!ranges.includes("ACTIVE SURFACE"));
    const msgsView = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        ...FULL_META,
    });
    assert.ok(!msgsView.includes("ACTIVE SURFACE"));
});
