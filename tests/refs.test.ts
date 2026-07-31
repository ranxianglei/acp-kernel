import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRefs,
  BLOCKED_REF,
  emptyRefMap,
  highestUsedIndex,
  indexToRef,
  rawForRef,
  refForRaw,
  refToIndex,
  rebuildRefIndex,
} from "../src/refs.js";
import type { CoreMessage } from "../src/types.js";

function msg(id: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text: id };
}

test("indexToRef zero-pads to 5 digits", () => {
  assert.equal(indexToRef(1), "m00001");
  assert.equal(indexToRef(42), "m00042");
  assert.equal(indexToRef(99999), "m99999");
});

test("indexToRef rejects out-of-range indices", () => {
  assert.throws(() => indexToRef(0));
  assert.throws(() => indexToRef(100000));
  assert.throws(() => indexToRef(1.5));
});

test("refToIndex parses and normalizes", () => {
  assert.equal(refToIndex("m00001"), 1);
  assert.equal(refToIndex("m1"), 1);
  assert.equal(refToIndex("M0042"), 42);
  assert.equal(refToIndex("BLOCKED"), null);
  assert.equal(refToIndex("b3"), null);
  assert.equal(refToIndex("xyz"), null);
});

test("assignRefs assigns sequential refs to new messages", () => {
  const messages = [msg("a"), msg("b"), msg("c")];
  const result = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
  });

  assert.equal(result.newlyAssigned, 3);
  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "b"), "m00002");
  assert.equal(refForRaw(result.map, "c"), "m00003");
  assert.equal(rawForRef(result.map, "m00002"), "b");
});

test("assignRefs preserves existing refs and continues numbering", () => {
  const existing = emptyRefMap();
  existing.byRaw["a"] = "m00001";
  existing.byRef["m00001"] = "a";

  const messages = [msg("a"), msg("b")];
  const result = assignRefs(messages, { existing, nextIndex: 5 });

  assert.equal(result.newlyAssigned, 1);
  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "b"), "m00005");
});

test("assignRefs marks protected messages as BLOCKED without consuming an index", () => {
  const messages = [msg("a"), msg("b"), msg("c")];
  const result = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
    isProtected: (m) => m.id === "b",
  });

  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "b"), BLOCKED_REF);
  assert.equal(refForRaw(result.map, "c"), "m00002");
  assert.equal(result.newlyAssigned, 2);
});

test("assignRefs skips messages per shouldSkip", () => {
  const messages = [msg("a"), msg("b"), msg("c")];
  const result = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
    shouldSkip: (m) => m.id === "b",
  });

  assert.equal(refForRaw(result.map, "b"), null);
  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "c"), "m00002");
});

test("assignRefs skips free indices already taken (no collision)", () => {
  const existing = emptyRefMap();
  existing.byRaw["old"] = "m00002";
  existing.byRef["m00002"] = "old";

  const result = assignRefs([msg("x")], { existing, nextIndex: 1 });
  assert.equal(refForRaw(result.map, "x"), "m00001");
  assert.equal(result.nextIndex, 2);
});

test("rebuildRefIndex drops stale byRef entries and ignores BLOCKED", () => {
  const map = emptyRefMap();
  map.byRaw["a"] = "m00001";
  map.byRaw["b"] = BLOCKED_REF;
  map.byRef["m00099"] = "ghost";

  const rebuilt = rebuildRefIndex(map);
  assert.equal(rawForRef(rebuilt, "m00001"), "a");
  assert.equal(rawForRef(rebuilt, "m00099"), null);
});

test("highestUsedIndex returns max assigned numeric ref", () => {
  const map = emptyRefMap();
  map.byRaw["a"] = "m00003";
  map.byRaw["b"] = "m00010";
  map.byRaw["c"] = BLOCKED_REF;
  assert.equal(highestUsedIndex(map), 10);
});
