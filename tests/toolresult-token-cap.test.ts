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

test("resolveToolResultCap: auto = 10% of limit quantized down to a power of two, ceiling 16384", () => {
  // 10% of 100000 = 10000 -> quantized down to 8192.
  assert.equal(resolveToolResultCap(defaultConfig(100000)), 8192);
  assert.equal(resolveToolResultCap(defaultConfig(131072)), 8192);
  // 10% of 500000 is 50000 — clamped by the absolute ceiling.
  assert.equal(resolveToolResultCap(defaultConfig(500000)), 16384);
  assert.equal(resolveToolResultCap(defaultConfig(163840)), 16384);
  // Exactly on a power-of-two boundary stays put.
  assert.equal(resolveToolResultCap(defaultConfig(81920)), 8192);
  assert.equal(resolveToolResultCap(defaultConfig(65536)), 4096);
  // Below the quantization step the raw 10% is kept (tiny-limit models).
  assert.equal(resolveToolResultCap(defaultConfig(8192)), 819);
  // Unknown limit: auto still fires at the ceiling.
  assert.equal(resolveToolResultCap(defaultConfig(0)), 16384);
  // Non-finite limit falls back to the ceiling, never NaN.
  assert.equal(
    resolveToolResultCap(defaultConfig(Number.NaN)),
    16384,
  );
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
  assert.equal(result.capTokens, 8192);
  const rewritten = result.messages[1]!.text!;
  assert.ok(rewritten.includes("[acp: tool-result truncated"));
  assert.ok(rewritten.includes("original ~15000 tokens"));
  // Head and tail survive.
  assert.ok(rewritten.startsWith(original.slice(0, 100)));
  assert.ok(rewritten.endsWith(original.slice(-100)));
  // The rewrite itself fits the cap under the CJK-aware tokenizer.
  assert.ok(defaultCountTokens(rewritten) <= 8192);
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
  assert.ok(defaultCountTokens(cjk) > 8192);
  assert.ok(Math.ceil(cjk.length / 4) <= 8192);
  const result = capLargeToolResults(
    [msg("t", cjk, "tool-result")],
    cfg,
    defaultCountTokens,
  );
  assert.equal(result.cappedCount, 1);
  const rewritten = result.messages[0]!.text!;
  assert.ok(rewritten.includes("original ~30000 tokens"));
  assert.ok(defaultCountTokens(rewritten) <= 8192);
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
  assert.ok(defaultCountTokens(content) <= 8192);
  // The cap is observable on the turn result (host logging/alerting).
  assert.equal(result.toolResultCappedCount, 1);
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
  assert.equal(result.toolResultCappedCount, undefined);
});

test("capLargeToolResults: a legitimate oversized result QUOTING the marker is still capped (marker-bypass regression)", () => {
  const cfg = defaultConfig(100000); // cap 8192
  // e.g. a grep/read of this repo's own source, a git diff, a log dump.
  const quoting =
    "[acp: tool-result truncated, original ~99999 tokens]" + "x".repeat(60000);
  assert.ok(defaultCountTokens(quoting) > 8192);
  const result = capLargeToolResults(
    [msg("t", quoting, "tool-result")],
    cfg,
    defaultCountTokens,
  );
  assert.equal(result.cappedCount, 1);
  assert.ok(
    result.messages[0]!.text!.startsWith("[acp: tool-result truncated"),
  );
});

test("capLargeToolResults: marker text within the cap (stored outbound view) stays skipped", () => {
  const cfg = defaultConfig(100000); // cap 8192
  const stored = capLargeToolResults(
    [msg("t", "x".repeat(60000), "tool-result")],
    cfg,
    defaultCountTokens,
  ).messages[0]!.text!;
  assert.ok(stored.includes("[acp: tool-result truncated"));
  // Re-run with the same cap: idempotent skip (within ALREADY_CAPPED_MARGIN).
  const again = capLargeToolResults(
    [msg("t", stored, "tool-result")],
    cfg,
    defaultCountTokens,
  );
  assert.equal(again.cappedCount, 0);
});

test("capLargeToolResults: non-finite maxToolResultTokens falls back to auto instead of truncating everything", () => {
  // NaN compares false against every bound; pre-fix this replaced EVERY
  // tool-result (even "hello world") with the bare marker.
  const cfg = defaultConfig(100000, {
    truncate: { maxToolResultTokens: Number.NaN },
  });
  assert.equal(resolveToolResultCap(cfg), 8192); // auto, not NaN
  const result = capLargeToolResults(
    [msg("t", "hello world", "tool-result")],
    cfg,
    defaultCountTokens,
  );
  assert.equal(result.cappedCount, 0);
  assert.equal(result.messages[0]!.text, "hello world");
});

test("resolveToolResultCap: fractional explicit caps clamp to >= 1 token (never silently disable)", () => {
  assert.equal(
    resolveToolResultCap(
      defaultConfig(100000, { truncate: { maxToolResultTokens: 0.5 } }),
    ),
    1,
  );
});

test("truncateLargeToolOutputs re-truncates capped tool-results at emergency (stacked markers allowed)", () => {
  // Review finding #4: at >=95%/threshold usage the prefix is already broken
  // by design — emergency must still be able to shrink capped-but-large
  // messages. Pre-fix, the marker skip made them permanently untouchable.
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
  assert.equal(result.truncatedCount, 1);
  const text = result.messages[0]!.text!;
  assert.ok(text.includes("[truncated for context space"));
  assert.ok(defaultCountTokens(text) < 1000);
});

test("truncateLargeToolOutputs leaves capped tool-results alone when usage is already below target", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const capped = capLargeToolResults(
    [msg("t", "x".repeat(60000), "tool-result")],
    cfg,
    defaultCountTokens,
  );
  // 44000 < threshold 50000: early return — capped messages are only
  // re-touched when usage actually crosses the emergency threshold.
  const result = truncateLargeToolOutputs(
    capped.messages,
    44000,
    cfg,
    defaultCountTokens,
    { minOutputTokens: 100, keepPrefixChars: 100, keepSuffixChars: 100 },
  );
  assert.equal(result.truncatedCount, 0);
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
