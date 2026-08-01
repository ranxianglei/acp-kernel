import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { renderVisibleRefs, renderRefsNode } from "../src/render-refs.js";
import { runPipeline, makeIO, type PipelineNode } from "../src/pipeline.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

function msg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function stateWithRefs(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

test("defaultNodes exposes the canonical ordered pipeline", () => {
  const core = createCore();
  const names = core.defaultNodes().map((n) => n.name);
  assert.deepEqual(names, [
    "assign-refs",
    "sync-blocks",
    "prune",
    "filter",
    "hide-compress-calls",
    "recommend",
    "nudge-inject",
    "emergency-truncate",
    "render-refs",
  ]);
});

test("emergency-truncate is the last token-reducing node; render-refs is final", () => {
  const core = createCore();
  const nodes = core.defaultNodes();
  const truncateIdx = nodes.findIndex((n) => n.name === "emergency-truncate");
  const renderIdx = nodes.findIndex((n) => n.name === "render-refs");
  assert.ok(truncateIdx >= 0 && renderIdx === truncateIdx + 1);
  assert.equal(renderIdx, nodes.length - 1);
});

test("filter node runs AFTER prune (operates only on post-compression visible content)", () => {
  const core = createCore();
  const nodes = core.defaultNodes();
  const pruneIdx = nodes.findIndex((n) => n.name === "prune");
  const filterIdx = nodes.findIndex((n) => n.name === "filter");
  assert.ok(filterIdx > pruneIdx);
});

test("renderVisibleRefs derives tags from the ref map (single source of truth)", () => {
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  const state = stateWithRefs(messages);
  const rendered = renderVisibleRefs(messages, state);
  assert.match(rendered[0]!.text!, /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/);
  assert.match(rendered[1]!.text!, /^<acp tokens="\d+" type="text">m00002<\/acp>\nbeta$/);
});

test("renderVisibleRefs is idempotent: running twice yields the same result", () => {
  const messages = [msg("a", "alpha")];
  const state = stateWithRefs(messages);
  const once = renderVisibleRefs(messages, state);
  const twice = renderVisibleRefs(once, state);
  assert.deepEqual(twice.map((m) => m.text), once.map((m) => m.text));
});

test("renderVisibleRefs preserves non-own ref-like content and re-derives the own tag", () => {
  // A foreign tag (model echo OR user quote) must NOT be stripped — only the
  // message's own tag is ever peeled (content-corruption fix).
  const messages = [msg("a", "[m00009] alpha")];
  const state = stateWithRefs(messages); // authoritative ref for "a" is m00001
  const rendered = renderVisibleRefs(messages, state);
  assert.match(rendered[0]!.text!, /^<acp tokens="\d+" type="text">m00001<\/acp>\n\[m00009\] alpha$/);
});

test("renderVisibleRefs peels the message's own stale tag before re-deriving", () => {
  // A message carrying its OWN tag from a prior turn's render: idempotent re-tag.
  const staleTag = '<acp tokens="99" type="text">m00001</acp>\nalpha';
  const messages = [msg("a", staleTag)];
  const state = stateWithRefs(messages); // own ref for "a" is m00001
  const rendered = renderVisibleRefs(messages, state);
  assert.match(rendered[0]!.text!, /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/);
});

test("renderVisibleRefs leaves messages without a ref (BLOCKED/unmapped) untagged", () => {
  const messages = [msg("a", "alpha")];
  const state = createInitialState(); // no refs assigned -> untagged
  const rendered = renderVisibleRefs(messages, state);
  assert.equal(rendered[0]!.text, "alpha");
});

test("runPipeline threads messages, state, and effects through nodes in order", () => {
  const order: string[] = [];
  const node = (name: string): PipelineNode => ({
    name,
    run(io) {
      order.push(name);
      return { ...io, effects: { ...io.effects, [name]: true } };
    },
  });
  const result = runPipeline(
    [node("first"), node("second"), node("third")],
    makeIO([], createInitialState()),
    { config: defaultConfig(100000), tokenCount: 0, countTokens: () => 0 },
  );
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(result.effects["third"], true);
});

test("runPipeline skips nodes whose enabled predicate returns false", () => {
  const seen: string[] = [];
  const nodes: PipelineNode[] = [
    { name: "a", run: (io) => { seen.push("a"); return io; } },
    { name: "b", enabled: () => false, run: (io) => { seen.push("b"); return io; } },
    { name: "c", run: (io) => { seen.push("c"); return io; } },
  ];
  runPipeline(nodes, makeIO([], createInitialState()), {
    config: defaultConfig(100000),
    tokenCount: 0,
    countTokens: () => 0,
  });
  assert.deepEqual(seen, ["a", "c"]);
});

test("processTurn tags every mapped message with a derived ref (end-to-end)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  const result = core.processTurn({
    messages,
    state,
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  assert.match(result.messages[0]!.text!, /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/);
  assert.match(result.messages[1]!.text!, /^<acp tokens="\d+" type="text">m00002<\/acp>\nbeta$/);
});
