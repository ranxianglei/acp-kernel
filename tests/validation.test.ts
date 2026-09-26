import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text };
}

function setupRefs(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

const longText = "x".repeat(6000);
const validSummary = "This is a meaningful summary that captures the key information of the compressed range including paths and decisions.";

test("validation: empty summary is rejected", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("b", longText),
  ];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "" }],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /empty/i);
});

test("validation: whitespace-only summary is rejected", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "   \n\t  " }],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /empty/i);
});

test("validation: summary below minSummaryLength is rejected", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, {
    preserveRecentMessages: 0, preserveRecentTokens: 0,
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 100 },
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "too short" }],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /too short/i);
});

test("validation: summary above maxSummaryLength is rejected", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, {
    preserveRecentMessages: 0, preserveRecentTokens: 0,
    compress: { minCompressRange: 0, maxSummaryLength: 50, minSummaryLength: 0 },
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: validSummary }],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /too long/i);
});

test("validation: range below minCompressRange is rejected", () => {
  const core = createCore();
  const messages = [msg("a", "short"), msg("b", "text")];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, {
    preserveRecentMessages: 0, preserveRecentTokens: 0,
    compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 },
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: validSummary }],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /too small/i);
});

test("validation: batch aggregate — many small ranges pass if total >= minCompressRange", () => {
  const core = createCore();
  const chunk = "x".repeat(1200);
  const messages = [
    msg("a", chunk), msg("b", chunk), msg("c", chunk), msg("d", chunk), msg("e", chunk),
  ];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, {
    preserveRecentMessages: 0, preserveRecentTokens: 0,
    compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 },
  });

  // 5 separate ranges, each 1200 chars — individually below 5000 but total 6000
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00001", summary: validSummary },
      { startRef: "m00002", endRef: "m00002", summary: validSummary },
      { startRef: "m00003", endRef: "m00003", summary: validSummary },
      { startRef: "m00004", endRef: "m00004", summary: validSummary },
      { startRef: "m00005", endRef: "m00005", summary: validSummary },
    ],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 5);
  assert.equal(result.result.errors.length, 0);
});

test("validation: range with zero compressible messages (covered by non-nested block) is rejected", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("b", longText),
    msg("c", longText),
    msg("d", longText),
  ];
  let state = setupRefs(messages);
  const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });

  const first = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: validSummary }],
    messages,
    state,
    config,
  });
  state = first.state;

  // m00002→m00003 maps to b,c. Block b1 covers a,b,c but its anchor is
  // at index 0 (a), outside range [1,2]. So b1 is NOT nested → consumedBlockCount=0.
  // But b,c are in preExistingCoverage → directMessageIds=[]. Validation fires.
  const second = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: validSummary }],
    messages,
    state,
    config,
  });
  assert.equal(second.result.blocksCreated, 0);
  assert.match(second.result.errors[0]!, /no compressible/i);
});

test("validation: block-boundary compress with 0 direct msgs but consumed blocks is allowed", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText), msg("c", longText)];
  let state = setupRefs(messages);
  const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });

  const t1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: validSummary }],
    messages,
    state,
    config,
  });
  state = t1.state;

  const t2 = core.applyCompression({
    ranges: [{ startRef: "b1", endRef: "b1", summary: validSummary }],
    messages,
    state,
    config,
  });
  assert.equal(t2.result.blocksCreated, 1);
  assert.equal(t2.result.errors.length, 0);
  assert.equal(t2.state.blocks[1]!.tier, 2);
});

test("validation: all checks disabled (0s) allows any input", () => {
  const core = createCore();
  const messages = [msg("a", "x"), msg("b", "y")];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, {
    preserveRecentMessages: 0, preserveRecentTokens: 0,
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "ok" }],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
});

function captureWarns(fn: () => void): string[] {
  const original = console.warn;
  const captured: string[] = [];
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return captured;
}

test("config validation: min>max warns once across repeated turns, not per turn (#346)", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  let state = setupRefs(messages);
  const config = defaultConfig(200000, { nudge: { maxContextLimitPct: 0.35 } });

  const w1 = captureWarns(() => {
    state = core.processTurn({ messages, state, config, tokenCount: 5000 }).state;
  });
  assert.equal(w1.length, 1);
  assert.match(w1[0]!, /nudge\.minContextLimitPct must not exceed nudge\.maxContextLimitPct/);

  const w2 = captureWarns(() => {
    state = core.processTurn({ messages, state, config, tokenCount: 5000 }).state;
  });
  assert.equal(w2.length, 0);

  const w3 = captureWarns(() => {
    state = core.processTurn({ messages, state, config, tokenCount: 5000 }).state;
  });
  assert.equal(w3.length, 0);
});

test("config validation: re-warns when the validation error set changes", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  let state = setupRefs(messages);
  const configA = defaultConfig(200000, { nudge: { maxContextLimitPct: 0.35 } });
  const configB = defaultConfig(200000, { nudge: { maxContextLimitPct: 0.99 } });

  let w = captureWarns(() => {
    state = core.processTurn({ messages, state, config: configA, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 1);

  w = captureWarns(() => {
    state = core.processTurn({ messages, state, config: configB, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 1);
  assert.match(w[0]!, /nudge\.maxContextLimitPct must not exceed nudge\.emergencyThresholdPct/);

  w = captureWarns(() => {
    state = core.processTurn({ messages, state, config: configB, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 0);
});

test("config validation: re-warns when config becomes invalid again after being valid", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  let state = setupRefs(messages);
  const invalid = defaultConfig(200000, { nudge: { maxContextLimitPct: 0.35 } });
  const valid = defaultConfig(200000);

  let w = captureWarns(() => {
    state = core.processTurn({ messages, state, config: invalid, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 1);

  w = captureWarns(() => {
    state = core.processTurn({ messages, state, config: valid, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 0);
  assert.deepEqual(state.lastConfigWarnings, []);

  w = captureWarns(() => {
    state = core.processTurn({ messages, state, config: invalid, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 1);
  assert.match(w[0]!, /nudge\.minContextLimitPct must not exceed nudge\.maxContextLimitPct/);
});

test("config validation: valid config never warns and stores empty set", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  let state = setupRefs(messages);
  const config = defaultConfig(200000);

  const w = captureWarns(() => {
    state = core.processTurn({ messages, state, config, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 0);
  assert.deepEqual(state.lastConfigWarnings, []);
});

test("config validation: dedup memory survives JSON round-trip (host persist/load)", () => {
  const core = createCore();
  const messages = [msg("a", longText), msg("b", longText)];
  let state = setupRefs(messages);
  const config = defaultConfig(200000, { nudge: { maxContextLimitPct: 0.35 } });

  captureWarns(() => {
    state = core.processTurn({ messages, state, config, tokenCount: 5000 }).state;
  });

  const restored = JSON.parse(JSON.stringify(state)) as typeof state;
  const w = captureWarns(() => {
    state = core.processTurn({ messages, state: restored, config, tokenCount: 5000 }).state;
  });
  assert.equal(w.length, 0);
});

test("validation: errors are collected per-range in batch compress", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("b", longText),
    msg("c", longText),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "" },
      { startRef: "m00003", endRef: "m00004", summary: validSummary },
    ],
    messages,
    state,
    config,
  });
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /empty/i);
});
