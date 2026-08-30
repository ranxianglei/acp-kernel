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

  // The anchor is clamped to the leading system prefix: the summary precedes
  // the preserved first user message (m1) so no system message is mid-conversation.
  assert.equal(result.length, 3);
  assert.equal(result[0]!.id, "acp_summary_b1");
  assert.ok(result[0]!.text!.startsWith(SUMMARY_HEADER));
  assert.ok(result[0]!.text!.includes("the summary"));
  assert.equal(result[1]!.id, "m1");
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

  // Both anchors clamp to the leading prefix; they keep their chronological
  // order by original position (b2 covers w before b1 covers x).
  assert.equal(result[0]!.id, "acp_summary_b2");
  assert.ok(result[0]!.text!.includes("earlier"));
  assert.equal(result[1]!.id, "acp_summary_b1");
  assert.ok(result[1]!.text!.includes("later"));
  assert.equal(result[2]!.id, "u");
  assert.equal(result[3]!.id, "z");
});

function assertNoMidConversationSystem(messages: CoreMessage[]): void {
  let seenNonSystem = false;
  for (const m of messages) {
    if (m.role !== "system") seenNonSystem = true;
    else if (seenNonSystem)
      assert.fail(`system message ${m.id} appears after a non-system message`);
  }
}

test("prune never emits a system message after a non-system message (OpenAI wire validity)", () => {
  const state = createInitialState();
  // A range that starts AFTER the head — the normal "fold the old stuff, keep
  // the tail" pattern that used to strand a system summary mid-conversation.
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      summary: "folded history",
      effectiveMessageIds: ["a2", "u3", "a4"],
    }),
  );
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "u1" },
    { id: "a2", role: "assistant", contentType: "text", text: "a2" },
    { id: "u3", role: "user", contentType: "text", text: "u3" },
    { id: "a4", role: "assistant", contentType: "text", text: "a4" },
    { id: "u5", role: "user", contentType: "text", text: "u5" },
    { id: "a6", role: "assistant", contentType: "text", text: "a6" },
  ];
  const result = prune(messages, state);

  assert.deepEqual(
    result.map((m) => m.id),
    ["acp_summary_b1", "u1", "u5", "a6"],
  );
  assertNoMidConversationSystem(result);
});

test("prune keeps the summary in the leading prefix after an existing system message", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      summary: "folded",
      effectiveMessageIds: ["a2", "u3"],
    }),
  );
  const messages: CoreMessage[] = [
    { id: "sys0", role: "system", contentType: "text", text: "host system" },
    { id: "u1", role: "user", contentType: "text", text: "u1" },
    { id: "a2", role: "assistant", contentType: "text", text: "a2" },
    { id: "u3", role: "user", contentType: "text", text: "u3" },
    { id: "a4", role: "assistant", contentType: "text", text: "a4" },
  ];
  const result = prune(messages, state);

  // The summary clamps to the first non-system message (u1): it lands after the
  // leading host system message but still ahead of the conversation proper.
  assert.deepEqual(
    result.map((m) => m.id),
    ["sys0", "acp_summary_b1", "u1", "a4"],
  );
  assertNoMidConversationSystem(result);
});
