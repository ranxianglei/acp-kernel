import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OUTPUT_HEADROOM_MAX_PCT,
  resolveOutputHeadroomCap,
  reserveOutputHeadroom,
  shouldReserveOutputHeadroom,
  applyOutputHeadroom,
} from "../src/output-headroom.js";

test("DEFAULT_OUTPUT_HEADROOM_MAX_PCT is 0.25", () => {
  assert.equal(DEFAULT_OUTPUT_HEADROOM_MAX_PCT, 0.25);
});

test("resolveOutputHeadroomCap: unset → default, ratio/percent passthrough", () => {
  assert.equal(resolveOutputHeadroomCap(undefined), DEFAULT_OUTPUT_HEADROOM_MAX_PCT, "unset → 0.25 default");
  assert.equal(resolveOutputHeadroomCap(0.5), 0.5, "ratio passthrough");
  assert.equal(resolveOutputHeadroomCap(0), 0, "0 stays 0 (disable)");
  assert.equal(resolveOutputHeadroomCap(1), 1, "1 = legacy full reservation");
  assert.equal(resolveOutputHeadroomCap("25%"), 0.25, "percent string");
  assert.equal(resolveOutputHeadroomCap("50%"), 0.5);
  assert.equal(resolveOutputHeadroomCap("100%"), 1);
  assert.equal(resolveOutputHeadroomCap("0%"), 0);
  assert.equal(resolveOutputHeadroomCap("0.5"), 0.5, "plain ratio string");
  assert.equal(resolveOutputHeadroomCap(" 25% "), 0.25, "whitespace trimmed");
});

test("resolveOutputHeadroomCap: non-numeric string yields NaN (treated as not provided downstream)", () => {
  assert.ok(Number.isNaN(resolveOutputHeadroomCap("abc")));
  // "" parses as 0 in Number() — pinned for parity with both host implementations.
  assert.equal(resolveOutputHeadroomCap(""), 0);
});

test("reserveOutputHeadroom: reserves the output budget from the window", () => {
  assert.equal(reserveOutputHeadroom(100_000, 16_384), 83_616);
  assert.equal(reserveOutputHeadroom(128_000, 1), 127_999);
});

test("reserveOutputHeadroom: no-op for unusable maxOutput", () => {
  assert.equal(reserveOutputHeadroom(100_000, 0), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, -5), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, Number.NaN), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, Number.POSITIVE_INFINITY), 100_000);
});

test("reserveOutputHeadroom: no-op when maxOutput >= window (degenerate request)", () => {
  assert.equal(reserveOutputHeadroom(100_000, 100_000), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, 200_000), 100_000);
});

test("reserveOutputHeadroom: no-op for unusable window", () => {
  assert.equal(reserveOutputHeadroom(0, 10_000), 0);
  assert.equal(reserveOutputHeadroom(-1, 10_000), -1);
  assert.equal(reserveOutputHeadroom(Number.NaN, 10_000), Number.NaN);
});

test("reserveOutputHeadroom: capPct bounds the reservation at capPct * window", () => {
  // qwen3.8-27b case: 131072 max_tokens on a 262144 window, capped at 25%.
  assert.equal(reserveOutputHeadroom(262_144, 131_072, 0.25), 196_608);
  // Cap above maxOutput → reservation unchanged vs uncapped (min picks maxOutput).
  assert.equal(reserveOutputHeadroom(262_144, 32_768, 0.25), 229_376);
  assert.equal(reserveOutputHeadroom(100_000, 16_384, 0.25), 83_616);
});

test("reserveOutputHeadroom: capPct edge semantics", () => {
  assert.equal(reserveOutputHeadroom(100_000, 50_000, 0), 100_000, "0 disables the reservation");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, -1), 100_000, "negative clamps to 0 → disabled");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, 1), 50_000, "1 = legacy full reservation");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, 2), 50_000, ">= 1 clamps to legacy");
  assert.equal(reserveOutputHeadroom(100_000, 50_000, Number.NaN), 50_000, "non-finite = not provided → legacy");
  assert.equal(reserveOutputHeadroom(100_000, 50_000), 50_000, "default arg preserves pre-cap behavior");
});

test("reserveOutputHeadroom: cap does not resurrect no-op cases", () => {
  assert.equal(reserveOutputHeadroom(100_000, 0, 0.25), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, 100_000, 0.25), 100_000, "maxOutput >= window still degenerate");
  assert.equal(reserveOutputHeadroom(0, 10_000, 0.25), 0);
});

test("shouldReserveOutputHeadroom: anthropic-family exempt (both host identifier spaces)", () => {
  assert.equal(shouldReserveOutputHeadroom("anthropic"), false, "proxy wire-protocol id");
  assert.equal(shouldReserveOutputHeadroom("anthropic-messages"), false, "pi-ai model api id");
  assert.equal(shouldReserveOutputHeadroom("anthropic_messages"), false, "separator-insensitive");
  assert.equal(shouldReserveOutputHeadroom("AnthropicMessages"), false, "case-insensitive");
  assert.equal(shouldReserveOutputHeadroom(" Anthropic Messages "), false, "whitespace-insensitive");
});

test("shouldReserveOutputHeadroom: openai-family and unknown protocols reserve", () => {
  assert.equal(shouldReserveOutputHeadroom("openai"), true);
  assert.equal(shouldReserveOutputHeadroom("responses"), true);
  assert.equal(shouldReserveOutputHeadroom("openai-chat"), true);
  assert.equal(shouldReserveOutputHeadroom("openai-responses"), true);
  assert.equal(shouldReserveOutputHeadroom("openai-completions"), true);
  assert.equal(shouldReserveOutputHeadroom("google"), true);
  assert.equal(shouldReserveOutputHeadroom("bedrock-converse-stream"), true, "conservative for uncertain APIs");
  assert.equal(shouldReserveOutputHeadroom(""), true, "empty → conservative (reserve)");
  assert.equal(shouldReserveOutputHeadroom(undefined), true, "unknown api → conservative (reserve)");
});

test("applyOutputHeadroom: threads the cap through to reserveOutputHeadroom", () => {
  const config = { modelContextLimit: 262_144 };
  const model = { maxTokens: 131_072, api: "openai-responses" };
  assert.equal(applyOutputHeadroom(config, model, 0.25).modelContextLimit, 196_608, "capped reservation");
  assert.equal(applyOutputHeadroom(config, model, 1).modelContextLimit, 131_072, "cap 1 = legacy full reservation");
  assert.equal(applyOutputHeadroom(config, model).modelContextLimit, 131_072, "no cap arg = legacy for old call sites");
  assert.equal(applyOutputHeadroom(config, model, 0).modelContextLimit, 262_144, "cap 0 disables the reservation");
});

test("applyOutputHeadroom: exempt protocol and missing model leave the limit untouched", () => {
  const config = { modelContextLimit: 262_144 };
  assert.equal(applyOutputHeadroom(config, { maxTokens: 131_072, api: "anthropic-messages" }, 0.25).modelContextLimit, 262_144, "anthropic exempt even with a cap");
  assert.equal(applyOutputHeadroom(config, { maxTokens: 131_072, api: "anthropic" }, 0.25).modelContextLimit, 262_144, "proxy-style id also exempt");
  assert.equal(applyOutputHeadroom(config, undefined, 0.25).modelContextLimit, 262_144, "no model → no reservation");
  assert.equal(applyOutputHeadroom(config, {}, 0.25).modelContextLimit, 262_144, "no maxTokens → no reservation");
});

test("applyOutputHeadroom: returns a new object only when it changes the limit; never mutates", () => {
  const config = { modelContextLimit: 262_144, extra: "kept" };
  const changed = applyOutputHeadroom(config, { maxTokens: 131_072, api: "openai" }, 0.25);
  assert.notEqual(changed, config, "changed → new object");
  assert.equal(changed.modelContextLimit, 196_608);
  assert.equal(changed.extra, "kept", "other fields preserved");
  assert.equal(config.modelContextLimit, 262_144, "original untouched");
  const same = applyOutputHeadroom(config, { maxTokens: 131_072, api: "anthropic" });
  assert.equal(same, config, "no-op → same object identity");
});
