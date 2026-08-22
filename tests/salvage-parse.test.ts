import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { salvageParseRanges, extractRanges } from "../src/salvage-parse.js";

const LONG_SUMMARY =
  "Analyzed the billing export pipeline: root cause was a timezone drift in the scheduler (UTC vs local) duplicating 3% of rows nightly since Aug 12. Fixed by pinning TZ in cron and adding a dedup migration at /srv/billing/migrations/0042_dedup.sql. Verified 14 days of data.";

describe("salvageParseRanges — layers 1-3 (valid-ish JSON)", () => {
  it("strict JSON parses at layer json", () => {
    const raw = JSON.stringify({
      content: [{ startId: "m00004", endId: "m00018", summary: LONG_SUMMARY, topic: "billing" }],
    });
    const r = salvageParseRanges(raw);
    assert.equal(r.layer, "json");
    assert.equal(r.ranges.length, 1);
    assert.equal(r.ranges[0]!.startRef, "m00004");
    assert.equal(r.ranges[0]!.topic, "billing");
  });

  it("fenced JSON parses at layer json-fenced", () => {
    const raw = "```json\n" + JSON.stringify({ content: [{ startId: "m00150", endId: "m00220", summary: LONG_SUMMARY }] }) + "\n```";
    const r = salvageParseRanges(raw);
    assert.equal(r.layer, "json-fenced");
    assert.equal(r.ranges.length, 1);
  });

  it("trailing comma + raw newline inside summary repaired at json-repaired", () => {
    const raw =
      '{"content":[{"startId":"m00150","endId":"m00220","summary":"line one\nline two ' +
      LONG_SUMMARY +
      '",},],}';
    const r = salvageParseRanges(raw);
    assert.equal(r.layer, "json-repaired");
    assert.equal(r.ranges.length, 1);
    assert.ok(r.ranges[0]!.summary.includes("line one\nline two"));
  });

  it("JSON-string content (double-encoded) is unwrapped", () => {
    const inner = JSON.stringify([{ startId: "m00010", endId: "m00012", summary: LONG_SUMMARY }]);
    const r = salvageParseRanges(JSON.stringify({ content: inner }));
    assert.equal(r.ranges.length, 1);
    assert.equal(r.ranges[0]!.endRef, "m00012");
  });

  it("bare array payload works", () => {
    const r = salvageParseRanges(JSON.stringify([{ startId: "m00001", endId: "m00005", summary: LONG_SUMMARY }]));
    assert.equal(r.ranges.length, 1);
  });

  it("single top-level range object works", () => {
    const r = salvageParseRanges(JSON.stringify({ startId: "m00001", endId: "m00005", summary: LONG_SUMMARY }));
    assert.equal(r.ranges.length, 1);
  });
});

describe("salvageParseRanges — layer 4 (truncated array salvage)", () => {
  it("truncated content array salvages the complete prefix entry", () => {
    const full =
      '{"content":[{"startId":"m00150","endId":"m00220","summary":"' + LONG_SUMMARY + '"},{"startId":"m00300","endId":"m0';
    const r = salvageParseRanges(full);
    assert.equal(r.layer, "array-prefix");
    assert.equal(r.ranges.length, 1);
    assert.equal(r.ranges[0]!.startRef, "m00150");
  });

  it("all entries truncated to nothing returns 0 ranges", () => {
    const r = salvageParseRanges('{"content":[{"startId":"m0030');
    assert.equal(r.ranges.length, 0);
  });
});

describe("salvageParseRanges — layer 5 (non-JSON prose fallback)", () => {
  it("field-per-line text yields a range", () => {
    const raw = `startId: m00150
endId: m00220
topic: billing fix
summary: ${LONG_SUMMARY}`;
    const r = salvageParseRanges(raw);
    assert.equal(r.layer, "field-regex");
    assert.equal(r.ranges.length, 1);
    assert.equal(r.ranges[0]!.startRef, "m00150");
    assert.equal(r.ranges[0]!.topic, "billing fix");
  });

  it("prose with startId/endId markers inline", () => {
    const raw = `Compress from m00010 to m00025. summary = "${LONG_SUMMARY}" — everything else is noise.`;
    const r = salvageParseRanges(raw);
    assert.equal(r.ranges.length, 1);
    assert.equal(r.ranges[0]!.startRef, "m00010");
    assert.equal(r.ranges[0]!.endRef, "m00025");
  });

  it("short summaries are rejected (< 50 chars) in regex layer", () => {
    const raw = `startId: m00150\nendId: m00220\nsummary: too short`;
    const r = salvageParseRanges(raw);
    assert.equal(r.ranges.length, 0);
  });
});

describe("salvageParseRanges — total garbage", () => {
  it("empty input", () => {
    const r = salvageParseRanges("   ");
    assert.equal(r.ranges.length, 0);
  });

  it("unrelated prose returns 0 ranges and never throws", () => {
    const r = salvageParseRanges("The quick brown fox jumps over the lazy dog. " + LONG_SUMMARY);
    assert.equal(r.ranges.length, 0);
  });
});

describe("extractRanges", () => {
  it("rejects non-object/non-array", () => {
    assert.deepEqual(extractRanges(null), []);
    assert.deepEqual(extractRanges(42), []);
    assert.deepEqual(extractRanges("string"), []);
  });

  it("drops incomplete entries at the end of arrays", () => {
    const r = extractRanges([
      { startId: "m00001", endId: "m00005", summary: LONG_SUMMARY },
      { startId: "m00006" }, // missing endId/summary
      { startId: "m00007", endId: "m00008", summary: LONG_SUMMARY }, // after a gap — dropped
    ]);
    assert.equal(r.length, 1);
  });
});

describe("salvageParseRanges — double-encoded content", () => {
  it("salvages a JSON-string content truncated mid-array", () => {
    const raw = JSON.stringify({
      content: '[{"startId":"m00005","endId":"m00006","summary":"ok"},{"startId":"m0',
    });
    const res = salvageParseRanges(raw);
    assert.equal(res.layer, "array-prefix");
    assert.equal(res.ranges.length, 1);
    assert.equal(res.ranges[0]?.startRef, "m00005");
    assert.equal(res.ranges[0]?.summary, "ok");
  });
});
