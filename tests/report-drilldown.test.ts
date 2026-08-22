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

// messages m0..m9 (oldest..newest), each with a distinct token size so the
// fixture doubles for both sort:"time" and sort:"size" ordering assertions.
function fixtureMessages(): CoreMessage[] {
    const messages: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) {
        messages.push({
            id: `m${i}`,
            role: "assistant",
            contentType: "tool-result",
            toolName: i % 2 === 0 ? "bash" : "read",
            text: "x".repeat(i * 4 + 4),
        });
    }
    return messages;
}

function fixtureState(messages: CoreMessage[]): CompressionState {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    messages.forEach((m, i) => {
        const ref = `m${String(i).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    return {
        ...createInitialState(),
        messageRefs: { byRaw, byRef },
        blocks: [],
    };
}

test("drilldown sort:time is oldest-first and head-only by default (status quo pinned)", () => {
    const messages = fixtureMessages();
    const state = fixtureState(messages);
    const report = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        sort: "time",
        limit: 3,
    });
    assert.ok(report.includes("  m00000 (1) bash"));
    assert.ok(report.includes("  m00001 (2) read"));
    assert.ok(report.includes("  m00002 (3) bash"));
    assert.ok(!report.includes("m00009"), "newest message must not appear with head-only default");
    assert.ok(report.includes("3 of 10 shown."));
});

test("drilldown sort:time + reverse:true reaches the newest messages", () => {
    const messages = fixtureMessages();
    const state = fixtureState(messages);
    const report = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        sort: "time",
        reverse: true,
        limit: 3,
    });
    assert.ok(report.includes("Sorted by time (reverse)"));
    assert.ok(report.includes("  m00009 (10) read"));
    assert.ok(report.includes("  m00008 (9) bash"));
    assert.ok(report.includes("  m00007 (8) read"));
    assert.ok(!report.includes("m00000"), "oldest message must not appear when reversed");
});

test("drilldown offset paginates past the head of any sort", () => {
    const messages = fixtureMessages();
    const state = fixtureState(messages);
    // time, ascending, page 3 of 4 (rows 7-9)
    const forward = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        sort: "time",
        limit: 3,
        offset: 6,
    });
    assert.ok(forward.includes("  m00006 (7) bash"));
    assert.ok(forward.includes("  m00008 (9) bash"));
    assert.ok(forward.includes("Showing 7–9 of 10."));
    assert.ok(!forward.includes("m00009"), "offset window ends before the last message");

    // time, descending, page 3 of 4 — the tail is now on page 1, later pages
    // walk back toward the head
    const backward = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        sort: "time",
        reverse: true,
        limit: 3,
        offset: 6,
    });
    assert.ok(backward.includes("  m00003 (4) read"));
    assert.ok(backward.includes("  m00002 (3) bash"));
    assert.ok(backward.includes("  m00001 (2) read"));
    assert.ok(backward.includes("Showing 7–9 of 10."));
});

test("drilldown offset past the end reports the miss instead of an empty page", () => {
    const messages = fixtureMessages();
    const state = fixtureState(messages);
    const report = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        sort: "time",
        limit: 3,
        offset: 10,
    });
    assert.ok(report.includes("Offset 10 past end (10 total)."));
    const body = report.replace(/^\s*$/gm, "");
    assert.ok(!body.includes("m0000"), "no message rows rendered past the end");
});

test("drilldown sort:size reverse flips largest-first to smallest-first", () => {
    const messages = fixtureMessages();
    const state = fixtureState(messages);
    const largest = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        sort: "size",
        limit: 2,
    });
    assert.ok(largest.includes("  m00009 (10) read"));
    assert.ok(largest.includes("  m00008 (9) bash"));

    const smallest = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        sort: "size",
        reverse: true,
        limit: 2,
    });
    assert.ok(smallest.includes("  m00000 (1) bash"));
    assert.ok(smallest.includes("  m00001 (2) read"));
});

test("drilldown tool filter combines with reverse:time to reach the newest rows of one tool", () => {
    const messages = fixtureMessages();
    const state = fixtureState(messages);
    const report = buildStatusReport(state, messages, defaultCountTokens, {
        scope: "uncompressed",
        view: "messages",
        tool: "bash",
        sort: "time",
        reverse: true,
        limit: 2,
    });
    // newest bash rows are m8 (9), m6 (7)
    assert.ok(report.includes("  m00008 (9) bash"));
    assert.ok(report.includes("  m00006 (7) bash"));
    assert.ok(!report.includes("read"), "tool filter must exclude other tools");
});

test("drilldown compressed scope: reverse:time shows newest blocks first", () => {
    const state: CompressionState = {
        ...createInitialState(),
        blocks: [
            block({ blockId: "b1", createdAt: 1000, summary: "old", topic: "one" }),
            block({ blockId: "b2", createdAt: 2000, summary: "mid", topic: "two" }),
            block({ blockId: "b3", createdAt: 3000, summary: "new", topic: "three" }),
        ],
    };
    const forward = buildStatusReport(state, [], defaultCountTokens, {
        scope: "compressed",
        sort: "time",
        limit: 2,
    });
    assert.ok(forward.includes("b1"));
    assert.ok(forward.includes("b2"));
    assert.ok(!forward.includes("b3"), "newest block must not appear with head-only default");
    assert.ok(forward.includes("2 of 3 shown."));

    const backward = buildStatusReport(state, [], defaultCountTokens, {
        scope: "compressed",
        sort: "time",
        reverse: true,
        limit: 2,
    });
    assert.ok(backward.includes("b3"));
    assert.ok(backward.includes("b2"));
    assert.ok(!backward.includes("b1"), "oldest block must not appear when reversed");

    const paged = buildStatusReport(state, [], defaultCountTokens, {
        scope: "compressed",
        sort: "time",
        limit: 1,
        offset: 2,
    });
    assert.ok(paged.includes("b3"));
    assert.ok(!paged.includes("b1"));
    assert.ok(paged.includes("Showing 3–3 of 3."));
});
