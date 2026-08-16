import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentNamespace } from "../src/wire/responses.js";

test("subagentNamespace: first-seen instructions anchor the identity; identical instructions reuse it", () => {
    const id = "ns-unit-a";
    assert.equal(subagentNamespace(id, "You are Codex, the main agent."), id);
    assert.equal(subagentNamespace(id, "You are Codex, the main agent."), id);
});

test("subagentNamespace: differing instructions map to a stable separate |sub: namespace", () => {
    const id = "ns-unit-b";
    assert.equal(subagentNamespace(id, "main prompt"), id);
    const sub = subagentNamespace(id, "guardian prompt");
    assert.match(sub, /^ns-unit-b\|sub:[0-9a-f]{16}$/);
    assert.equal(subagentNamespace(id, "guardian prompt"), sub, "same subagent instructions reuse the sub namespace");
    assert.notEqual(subagentNamespace(id, "reviewer prompt"), sub, "a different subagent gets its own namespace");
    assert.equal(subagentNamespace(id, "main prompt"), id, "main conversation keeps the anchored namespace");
});

test("subagentNamespace: absent or empty instructions never anchor or split", () => {
    const id = "ns-unit-c";
    assert.equal(subagentNamespace(id, undefined), id);
    assert.equal(subagentNamespace(id, "   "), id);
    assert.equal(subagentNamespace(id, "real prompt"), id);
});
