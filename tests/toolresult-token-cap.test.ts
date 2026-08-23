import { test } from "node:test";
import assert from "node:assert/strict";
import {
  truncateLargeToolOutputs,
  capLargeToolResults,
  resolveToolResultCap,
} from "../src/truncate-tools.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  type: CoreMessage["contentType"] = "text",
): CoreMessage {
  return { id, role: "user", contentType: type, text };
}

test("resolveToolResultCap: auto = min(10% of limit, 16384)", () => {
  assert.equal(resolveToolResultCap(defaultConfig(100000)), 10000);
  assert.equal(resolveToolResultCap(defaultConfig(131072)), 13107);
  // 10% of 500000 is 50000 — clamped by the absolute ceiling.
  assert.equal(resolveToolResultCap(defaultConfig(500000)), 16384);
  assert.equal(resolveToolResultCap(defaultConfig(163840)), 16384);
  // Unknown limit: auto still fires at the ceiling.
  assert.equal(resolveToolResultCap(defaultConfig(0)), 16384);
});

test("resolveToolResultCap: explicit values and disable", () => {
  assert.equal(
    resolveToolResultCap(
      defaultConfig(100000, { truncate: { maxToolResultTokens: 5000 } }),
    ),
    5000,
  );
  assert.equal(
    resolveToolResultCap(
      defaultConfig(100000, { truncate: { maxToolResultTokens: 0 } }),
    ),
    0,
  );
  // Explicit cap wins over auto even when larger.
  assert.equal(
    resolveToolResultCap(
      defaultConfig(100000, { truncate: { maxToolResultTokens: 20000 } }),
    ),
    20000,
  );
});

test("capLargeToolResults rewrites an oversized tool-result over the cap", () => {
  const cfg = defaultConfig(100000); // auto cap = 10000
  const original = "L".repeat(60000); // 15000 tokens
  const messages = [msg("a", "small text"), msg("t1", original, "tool-result")];
  const result = capLargeToolResults(messages, cfg, defaultCountTokens);
  assert.equal(result.cappedCount, 1);
  assert.equal(result.capTokens, 10000);
  const rewritten = result.messages[1]!.text!;
  assert.ok(rewritten.includes("[acp: tool-result truncated"));
  assert.ok(rewritten.includes("original ~15000 tokens"));
  // Head and tail survive.
  assert.ok(rewritten.startsWith(original.slice(0, 100)));
  assert.ok(rewritten.endsWith(original.slice(-100)));
  // The rewrite itself fits the cap under the CJK-aware tokenizer.
  assert.ok(defaultCountTokens(rewritten) <= 10000);
  // Untouched messages keep their text verbatim.
  assert.equal(result.messages[0]!.text, "small text");
});

test("capLargeToolResults leaves small tool-results untouched", () => {
  const cfg = defaultConfig(100000);
  const messages = [
    msg("a", "x".repeat(400), "tool-result"),
    msg("b", "y".repeat(20000), "tool-result"), // 5000 tokens < 10000
    msg("c", "plain text"),
  ];
  const result = capLargeToolResults(messages, cfg, defaultCountTokens);
  assert.equal(result.cappedCount, 0);
  assert.equal(result.messages, messages);
});

test("capLargeToolResults ignores huge non-tool-result messages", () => {
  const cfg = defaultConfig(100000);
  const messages = [msg("a", "x".repeat(60000))];
  const result = capLargeToolResults(messages, cfg, defaultCountTokens);
  assert.equal(result.cappedCount, 0);
});

test("capLargeToolResults uses the CJK-aware tokenizer (chars/4 would pass it)", () => {
  const cfg = defaultConfig(100000); // cap = 10000
  // 30000 CJK chars: ~30000 real tokens, but a naive chars/4 estimate is
  // only 7500 — under the cap. The CJK-aware estimate must catch it.
  const cjk = "汉".repeat(30000);
  assert.ok(defaultCountTokens(cjk) > 10000);
  assert.ok(Math.ceil(cjk.length / 4) <= 10000);
  const result = capLargeToolResults(
    [msg("t", cjk, "tool-result")],
    cfg,
    defaultCountTokens,
  );
  assert.equal(result.cappedCount, 1);
  const rewritten = result.messages[0]!.text!;
  assert.ok(rewritten.includes("original ~30000 tokens"));
  assert.ok(defaultCountTokens(rewritten) <= 10000);
});

test("capLargeToolResults disabled with maxToolResultTokens: 0", () => {
  const cfg = defaultConfig(100000, { truncate: { maxToolResultTokens: 0 } });
  const messages = [msg("t", "x".repeat(60000), "tool-result")];
  const result = capLargeToolResults(messages, cfg, defaultCountTokens);
  assert.equal(result.cappedCount, 0);
  assert.equal(result.capTokens, 0);
  assert.equal(result.messages, messages);
});

test("capLargeToolResults honors an explicit smaller cap", () => {
  const cfg = defaultConfig(100000, {
    truncate: { maxToolResultTokens: 1000 },
  });
  const messages = [msg("t", "x".repeat(5000), "tool-result")]; // 1250 tokens
  const result = capLargeToolResults(messages, cfg, defaultCountTokens);
  assert.equal(result.cappedCount, 1);
  assert.ok(defaultCountTokens(result.messages[0]!.text!) <= 1000);
});

test("capLargeToolResults is idempotent on already-capped text", () => {
  const cfg = defaultConfig(100000);
  const once = capLargeToolResults(
    [msg("t", "x".repeat(60000), "tool-result")],
    cfg,
    defaultCountTokens,
  );
  const twice = capLargeToolResults(once.messages, cfg, defaultCountTokens);
  assert.equal(twice.cappedCount, 0);
  assert.equal(twice.messages, once.messages);
});

test("processTurn caps a fresh oversized tool-result below the emergency threshold", () => {
  const cfg = defaultConfig(100000); // emergency needs >= 95000
  const core = createCore();
  const messages = [
    msg("u1", "user question"),
    msg("t1", "x".repeat(60000), "tool-result"), // 15000 tokens, MOST RECENT
  ];
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: 20000, // 20% usage — far below every usage-gated valve
  });
  const rewritten = result.messages[1]!.text!;
  assert.ok(rewritten.includes("[acp: tool-result truncated"));
  // The usage-gated emergency truncation must NOT have fired on top.
  assert.ok(!rewritten.includes("[truncated for context space"));
  // Count the capped content, not the <acp> tag prefix render-refs added
  // after the cap node (renderMessage strips the own tag before counting —
  // same convention here).
  const content = rewritten.replace(/^<acp [^>]*>m\d+<\/acp>\n?/, "");
  assert.ok(defaultCountTokens(content) <= 10000);
});

test("processTurn leaves the whole session untouched when under the cap", () => {
  const cfg = defaultConfig(100000);
  const core = createCore();
  const messages = [
    msg("u1", "user question"),
    msg("t1", "x".repeat(8000), "tool-result"), // 2000 tokens < 10000
  ];
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: 3000,
  });
  assert.ok(!result.messages[1]!.text!.includes("[acp: tool-result truncated"));
});

test("truncateLargeToolOutputs skips already-capped tool-results", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const capped = capLargeToolResults(
    [msg("t", "x".repeat(60000), "tool-result")],
    cfg,
    defaultCountTokens,
  );
  const result = truncateLargeToolOutputs(
    capped.messages,
    90000,
    cfg,
    defaultCountTokens,
    { minOutputTokens: 100, keepPrefixChars: 100, keepSuffixChars: 100 },
  );
  assert.equal(result.truncatedCount, 0);
  // No double-truncation marker stacking.
  assert.equal(result.messages[0]!.text, capped.messages[0]!.text);
});

test("validateConfig rejects a negative maxToolResultTokens", () => {
  const cfg = defaultConfig(100000, {
    truncate: { maxToolResultTokens: -5 },
  });
  const errors = validateConfig(cfg);
  assert.ok(
    errors.some((e) => e.includes("maxToolResultTokens")),
    `expected maxToolResultTokens error, got: ${errors.join("; ")}`,
  );
  // null (auto) and 0 (disabled) are both valid.
  assert.equal(
    validateConfig(
      defaultConfig(100000, { truncate: { maxToolResultTokens: null } }),
    ).length,
    0,
  );
  assert.equal(
    validateConfig(
      defaultConfig(100000, { truncate: { maxToolResultTokens: 0 } }),
    ).length,
    0,
  );
});
