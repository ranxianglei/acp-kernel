import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRangesToThreshold } from "../src/recommend.js";
import type { CompressibleRange } from "../src/types.js";

function makeRange(
  overrides: Partial<CompressibleRange> & Pick<CompressibleRange, "tokens">,
): CompressibleRange {
  return {
    startRef: "m00001",
    endRef: "m00005",
    count: 1,
    toolPct: 0,
    textPct: 100,
    ...overrides,
  };
}

test("empty ranges → []", () => {
  assert.deepEqual(mergeRangesToThreshold([], 5000), []);
});

test("minChars <= 0 → ranges unchanged (disabled)", () => {
  const ranges = [
    makeRange({ tokens: 100, startRef: "m00001", endRef: "m00002" }),
    makeRange({ tokens: 200, startRef: "m00003", endRef: "m00004" }),
  ];
  assert.equal(mergeRangesToThreshold(ranges, 0), ranges);
  assert.equal(mergeRangesToThreshold(ranges, -1), ranges);
});

test("single range already >= threshold → returned as one batch unchanged", () => {
  const ranges = [
    makeRange({
      tokens: 1250,
      count: 4,
      toolPct: 50,
      textPct: 50,
      startRef: "m00001",
      endRef: "m00010",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tokens, 1250);
  assert.equal(out[0]!.count, 4);
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00010");
});

test("two small ranges whose sum >= threshold → ONE merged batch", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 2,
      toolPct: 100,
      textPct: 0,
      startRef: "m00001",
      endRef: "m00005",
    }),
    makeRange({
      tokens: 700,
      count: 3,
      toolPct: 0,
      textPct: 100,
      startRef: "m00010",
      endRef: "m00020",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "should merge into a single batch");
  assert.equal(out[0]!.count, 5);
  assert.equal(out[0]!.tokens, 1300);
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00020", "endRef = second child endRef");
});

test("three ranges: first two >= threshold, third tiny → TWO batches (tail kept)", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00003",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00004",
      endRef: "m00006",
    }),
    makeRange({
      tokens: 50,
      count: 1,
      startRef: "m00010",
      endRef: "m00011",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 2, "batch1 (>= threshold) + tail");
  assert.equal(out[0]!.tokens, 1300, "first batch is the merged first two");
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00006");
  assert.equal(out[1]!.tokens, 50, "tail is the tiny third range");
  assert.equal(out[1]!.startRef, "m00010");
  assert.equal(out[1]!.endRef, "m00011");
});

test("dangerous: true on a child propagates to merged batch", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00003",
      endRef: "m00004",
      dangerous: true,
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.dangerous, true, "dangerous flag propagates");
});

test("no dangerous children → merged batch omits dangerous", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00003",
      endRef: "m00004",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.dangerous, undefined, "no dangerous flag when none set");
});

test("count-weighted toolPct: A(count2,tool100) + B(count3,tool0) → 40 / 60", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 2,
      toolPct: 100,
      textPct: 0,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 3,
      toolPct: 0,
      textPct: 100,
      startRef: "m00003",
      endRef: "m00004",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(
    out[0]!.toolPct,
    40,
    "round((100×2 + 0×3)/5) = 40",
  );
  assert.equal(out[0]!.textPct, 60, "textPct = 100 - toolPct");
});

test("merges across ref gaps (non-adjacent refs)", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00050",
      endRef: "m00060",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "non-adjacent refs still merge");
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00060");
});

test("all-tiny tail: three ranges each < threshold → ONE merged range via trailing flush", () => {
  // Each range tokens=100 → 100*4=400 chars, never reaches 5000 mid-loop, so
  // the batch accumulates all three and is emitted as one range by the
  // trailing flush. The merged range spans r1.startRef..r3.endRef with
  // count/tokens summed.
  const ranges = [
    makeRange({ tokens: 100, count: 1, startRef: "m00001", endRef: "m00002" }),
    makeRange({ tokens: 100, count: 1, startRef: "m00003", endRef: "m00004" }),
    makeRange({ tokens: 100, count: 1, startRef: "m00005", endRef: "m00006" }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "trailing flush emits a single merged range");
  assert.equal(out[0]!.tokens, 300, "tokens summed");
  assert.equal(out[0]!.count, 3, "count summed");
  assert.equal(out[0]!.startRef, "m00001", "spans first child startRef");
  assert.equal(out[0]!.endRef, "m00006", "spans last child endRef");
});
