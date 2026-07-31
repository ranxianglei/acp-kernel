import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeBlocks,
  allocateBlockId,
  allocateRunId,
  blockById,
  coveredMessageIds,
  createInitialState,
  highestActiveTier,
  advanceSurvival,
} from "../src/state.js";
import { SUMMARY_HEADER, prune } from "../src/prune.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

function msg(id: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text: id };
}

function makeBlock(
  overrides: Partial<CompressionBlock> & { blockId: string },
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("createInitialState returns empty state with id counters at 1", () => {
  const state = createInitialState();
  assert.deepEqual(state.blocks, []);
  assert.equal(state.nextBlockId, 1);
  assert.equal(state.nextRunId, 1);
  assert.equal(state.stats.tokensCompressed, 0);
});

test("allocateBlockId issues sequential ids and advances counter", () => {
  const state = createInitialState();
  assert.equal(allocateBlockId(state), "b1");
  assert.equal(allocateBlockId(state), "b2");
  assert.equal(state.nextBlockId, 3);
});

test("allocateRunId issues sequential ids", () => {
  const state = createInitialState();
  assert.equal(allocateRunId(state), "r1");
  assert.equal(allocateRunId(state), "r2");
});

test("blockById finds block by string id", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b3" }));
  assert.equal(blockById(state, "b3")?.blockId, "b3");
  assert.equal(blockById(state, "b9"), undefined);
});

test("activeBlocks filters inactive", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", active: true }));
  state.blocks.push(makeBlock({ blockId: "b2", active: false }));
  assert.equal(activeBlocks(state).length, 1);
});

test("coveredMessageIds unions active blocks' effective ids", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["m1", "m2"] }),
    makeBlock({ blockId: "b2", active: false, effectiveMessageIds: ["m3"] }),
    makeBlock({ blockId: "b3", effectiveMessageIds: ["m2", "m4"] }),
  );
  assert.deepEqual([...coveredMessageIds(state)].sort(), ["m1", "m2", "m4"]);
});

test("highestActiveTier returns max tier among active blocks", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", tier: 1 }),
    makeBlock({ blockId: "b2", tier: 2, active: false }),
    makeBlock({ blockId: "b3", tier: 3 }),
  );
  assert.equal(highestActiveTier(state), 3);
});

test("advanceSurvival increments survivedCount and promotes past threshold", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", survivedCount: 4 }),
    makeBlock({ blockId: "b2", survivedCount: 1, active: false }),
  );
  advanceSurvival(state, 5);
  assert.equal(state.blocks[0]!.survivedCount, 5);
  assert.equal(state.blocks[0]!.generation, "old");
  assert.equal(state.blocks[1]!.survivedCount, 1);
});

test("prune returns messages unchanged when nothing is covered", () => {
  const state = createInitialState();
  const messages = [msg("a"), msg("b")];
  assert.deepEqual(prune(messages, state), messages);
});

test("prune removes covered messages and injects summary at anchor", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      summary: "the summary",
      effectiveMessageIds: ["m2", "m3"],
    }),
  );
  const messages = [msg("m1"), msg("m2"), msg("m3"), msg("m4")];
  const result = prune(messages, state);

  assert.equal(result.length, 3);
  assert.equal(result[0]!.id, "m1");
  assert.equal(result[1]!.id, "acp_summary_b1");
  assert.ok(result[1]!.text!.startsWith(SUMMARY_HEADER));
  assert.ok(result[1]!.text!.includes("the summary"));
  assert.equal(result[2]!.id, "m4");
});

test("prune preserves first user message even when covered", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["m1", "m2"] }),
  );
  const messages = [msg("m1", "user"), msg("m2"), msg("m3")];
  const result = prune(messages, state, { injectSummaries: false });

  assert.equal(result.length, 2);
  assert.equal(result[0]!.id, "m1");
  assert.equal(result[1]!.id, "m3");
});

test("prune without summary injection only removes covered messages", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["m2"] }));
  const messages = [msg("m1"), msg("m2"), msg("m3")];
  const result = prune(messages, state, { injectSummaries: false });

  assert.deepEqual(
    result.map((m) => m.id),
    ["m1", "m3"],
  );
});

test("prune orders multiple summaries by their anchor position", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", summary: "later", effectiveMessageIds: ["x"] }),
    makeBlock({
      blockId: "b2",
      summary: "earlier",
      effectiveMessageIds: ["w"],
    }),
  );
  const messages = [msg("u", "user"), msg("w"), msg("x"), msg("z")];
  const result = prune(messages, state);

  assert.equal(result[0]!.id, "u");
  assert.equal(result[1]!.id, "acp_summary_b2");
  assert.ok(result[1]!.text!.includes("earlier"));
  assert.equal(result[2]!.id, "acp_summary_b1");
  assert.ok(result[2]!.text!.includes("later"));
  assert.equal(result[3]!.id, "z");
});
