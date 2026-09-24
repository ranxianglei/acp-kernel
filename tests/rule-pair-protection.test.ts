import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectRulePairProtection,
  isMessageRuleProtected,
} from "../src/protected.js";
import { assignRefs, emptyRefMap, refForRaw } from "../src/refs.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { applyAbsorb } from "../src/absorb.js";
import {
  DEFAULT_CCR_CONFIG,
  isStoredPlaceholderText,
  storeLargeResults,
} from "../src/ccr.js";
import { createContentStore } from "../src/content-store.js";
import type { Config, CoreMessage } from "../src/types.js";

function textMsg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function ruleCall(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "acp_rule",
    toolCallId: callId,
    text: '{"rule":"always run tests before pushing"}',
  };
}

// Realistic projection: results carry toolCallId but often no toolName.
function ruleResult(id: string, callId: string, text: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: callId,
    text,
  };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    ...overrides,
  });
}

function rangesFor(messages: CoreMessage[], overrides?: Partial<Config>) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
  }).map;
  return buildCompressibleRanges(messages, state, cfg(overrides));
}

function refNum(ref: string): number {
  return Number(ref.replace(/^m/, ""));
}

function compressibleRefSet(ranges: ReturnType<typeof rangesFor>): Set<number> {
  const out = new Set<number>();
  for (const r of ranges.compressible) {
    for (let n = refNum(r.startRef); n <= refNum(r.endRef); n++) out.add(n);
  }
  return out;
}

test("live record pair stays protected", () => {
  const c1 = ruleCall("c1", "rec-1");
  const r1 = ruleResult("r1", "rec-1", "Recorded rule1: keep cache warm");
  const prot = collectRulePairProtection([textMsg("u1", "hi"), c1, r1]);
  assert.ok(prot.callIds.has("rec-1"));
  assert.ok(isMessageRuleProtected(c1, prot));
  assert.ok(isMessageRuleProtected(r1, prot));
  assert.ok(!isMessageRuleProtected(textMsg("u1", "hi"), prot));
});

test("removed rule pair becomes unprotected, delete trace too", () => {
  const c1 = ruleCall("c1", "rec-1");
  const r1 = ruleResult("r1", "rec-1", "Recorded rule1: old model pin");
  const c2 = ruleCall("c2", "del-1");
  const r2 = ruleResult("r2", "del-1", "Removed rule1: old model pin");
  const prot = collectRulePairProtection([c1, r1, c2, r2]);
  assert.equal(prot.callIds.size, 0);
  assert.equal(prot.msgIds.size, 0);
  for (const m of [c1, r1, c2, r2]) assert.ok(!isMessageRuleProtected(m, prot));
});

test("clear wipes all record protection", () => {
  const c1 = ruleCall("c1", "rec-1");
  const r1 = ruleResult("r1", "rec-1", "Recorded rule1: a");
  const c2 = ruleCall("c2", "rec-2");
  const r2 = ruleResult("r2", "rec-2", "Recorded rule2: b");
  const c3 = ruleCall("c3", "clr-1");
  const r3 = ruleResult("r3", "clr-1", "Cleared 2 rule(s).");
  const prot = collectRulePairProtection([c1, r1, c2, r2, c3, r3]);
  assert.equal(prot.callIds.size, 0);
  assert.ok(!isMessageRuleProtected(c1, prot));
  assert.ok(!isMessageRuleProtected(r2, prot));
});

test("re-record after removal protects only the new id", () => {
  const c1 = ruleCall("c1", "rec-1");
  const r1 = ruleResult("r1", "rec-1", "Recorded rule1: v1");
  const c2 = ruleCall("c2", "del-1");
  const r2 = ruleResult("r2", "del-1", "Removed rule1: v1");
  const c3 = ruleCall("c3", "rec-2");
  const r3 = ruleResult("r3", "rec-2", "Recorded rule2: v2");
  const prot = collectRulePairProtection([c1, r1, c2, r2, c3, r3]);
  assert.deepEqual([...prot.callIds], ["rec-2"]);
  assert.ok(!isMessageRuleProtected(r1, prot));
  assert.ok(isMessageRuleProtected(c3, prot));
  assert.ok(isMessageRuleProtected(r3, prot));
});

test("malformed Recorded result fails closed on both halves", () => {
  const c1 = ruleCall("c1", "rec-x");
  const r1 = ruleResult("r1", "rec-x", "Recorded ruleX: drifted format");
  const prot = collectRulePairProtection([c1, r1]);
  assert.ok(isMessageRuleProtected(c1, prot));
  assert.ok(isMessageRuleProtected(r1, prot));
});

test("listings and errors neither add nor remove liveness", () => {
  const c1 = ruleCall("c1", "rec-1");
  const r1 = ruleResult("r1", "rec-1", "Recorded rule1: a");
  const c2 = ruleCall("c2", "lst-1");
  const r2 = ruleResult("c2r", "lst-1", "1. [rule1] a");
  const c3 = ruleCall("c3", "err-1");
  const r3 = ruleResult(
    "r3",
    "err-1",
    'no rule with id "rule9" — list current rules first (omit the text argument).',
  );
  const prot = collectRulePairProtection([c1, r1, c2, r2, c3, r3]);
  assert.deepEqual([...prot.callIds], ["rec-1"]);
  assert.ok(!isMessageRuleProtected(r2, prot));
  assert.ok(!isMessageRuleProtected(r3, prot));
});

test("result without toolName pairs via the call-side name", () => {
  const c1 = ruleCall("c1", "rec-1");
  const r1 = ruleResult("r1", "rec-1", "Recorded rule1: a");
  assert.equal(r1.toolName, undefined);
  const prot = collectRulePairProtection([c1, r1]);
  assert.ok(prot.callIds.has("rec-1"));
});

test("result with explicit toolName also matches", () => {
  const c1 = ruleCall("c1", "rec-1");
  const r1: CoreMessage = {
    ...ruleResult("r1", "rec-1", "Recorded rule1: a"),
    toolName: "acp_rule",
  };
  const prot = collectRulePairProtection([c1, r1]);
  assert.ok(prot.callIds.has("rec-1"));
});

test("no acp_rule messages at all yields empty protection", () => {
  const prot = collectRulePairProtection([
    textMsg("u1", "hello"),
    {
      id: "b1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "bc-1",
      text: "ls",
    },
  ]);
  assert.equal(prot.callIds.size, 0);
  assert.equal(prot.msgIds.size, 0);
});

test("gate: live pair excluded from compressible ranges, dead pair included", () => {
  const messages: CoreMessage[] = [
    textMsg("u1", "work filler one"),
    ruleCall("c1", "rec-1"),
    ruleResult("r1", "rec-1", "Recorded rule1: keep cache warm"),
    textMsg("u2", "work filler two"),
    ruleCall("c2", "rec-2"),
    ruleResult("r2", "rec-2", "Recorded rule2: old model pin"),
    textMsg("u3", "work filler three"),
    ruleCall("c3", "del-1"),
    ruleResult("r3", "del-1", "Removed rule2: old model pin"),
    textMsg("u4", "work filler four"),
  ];
  const ranges = rangesFor(messages);
  assert.equal(ranges.protected.length, 1);
  assert.deepEqual(ranges.protected[0].tools, ["acp_rule"]);
  assert.equal(ranges.protected[0].startRef, "m00002");
  assert.equal(ranges.protected[0].endRef, "m00003");
  const compressible = compressibleRefSet(ranges);
  assert.ok(!compressible.has(2), "live call must not be compressible");
  assert.ok(!compressible.has(3), "live result must not be compressible");
  for (const n of [1, 4, 5, 6, 7, 8, 9, 10]) {
    assert.ok(
      compressible.has(n),
      `ref m${String(n).padStart(5, "0")} compressible`,
    );
  }
});

test("no-op safety: record-only history keeps every pair protected", () => {
  const messages: CoreMessage[] = [
    textMsg("u1", "work filler one"),
    ruleCall("c1", "rec-1"),
    ruleResult("r1", "rec-1", "Recorded rule1: a"),
    textMsg("u2", "work filler two"),
    ruleCall("c2", "rec-2"),
    ruleResult("r2", "rec-2", "Recorded rule2: b"),
    textMsg("u3", "work filler three"),
  ];
  const ranges = rangesFor(messages);
  const compressible = compressibleRefSet(ranges);
  for (const n of [2, 3, 5, 6]) assert.ok(!compressible.has(n));
  const protectedTools = ranges.protected.flatMap((r) => r.tools);
  assert.ok(protectedTools.includes("acp_rule"));
});

const countTokens = (text: string) => Math.ceil(text.length / 4);

function stateWithRefs(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
  }).map;
  return state;
}

test("CCR: live record result stays inline, dead pair is stored", () => {
  const messages: CoreMessage[] = [
    ruleCall("c1", "rec-1"),
    ruleResult("r1", "rec-1", "Recorded rule1: keep cache warm"),
    ruleCall("c2", "rec-2"),
    ruleResult("r2", "rec-2", "Recorded rule2: old model pin"),
    ruleCall("c3", "del-1"),
    ruleResult("r3", "del-1", "Removed rule2: old model pin"),
  ];
  const config = cfg({
    ccr: { ...DEFAULT_CCR_CONFIG, enabled: true, minToolTokens: 1 },
  });
  const out = storeLargeResults({
    messages,
    state: stateWithRefs(messages),
    store: createContentStore(),
    config,
    countTokens,
  });
  assert.equal(out.messages[1]?.text, "Recorded rule1: keep cache warm");
  assert.ok(isStoredPlaceholderText(out.messages[3]?.text ?? ""));
  assert.ok(isStoredPlaceholderText(out.messages[5]?.text ?? ""));
  assert.equal(out.storedCount, 2);
});

test("absorb: live record result refused, dead record result proceeds", () => {
  const messages: CoreMessage[] = [
    textMsg("u1", "work filler one"),
    ruleCall("c1", "rec-1"),
    ruleResult("r1", "rec-1", "Recorded rule1: keep cache warm"),
    ruleCall("c2", "rec-2"),
    ruleResult("r2", "rec-2", "Recorded rule2: old model pin"),
    ruleCall("c3", "del-1"),
    ruleResult("r3", "del-1", "Removed rule2: old model pin"),
  ];
  const state = stateWithRefs(messages);
  const config = cfg({
    absorb: {
      enabled: true,
      toolName: "absorb",
      minToolTokens: 0,
      contextThresholdPct: 0,
      excludeTools: [],
    },
  });
  const live = applyAbsorb({
    ref: refForRaw(state.messageRefs, "r1")!,
    summary: "rule recorded",
    messages,
    state,
    config,
  });
  assert.ok(!live.ok);
  assert.match(live.resultText, /protected tool/);
  const dead = applyAbsorb({
    ref: refForRaw(state.messageRefs, "r2")!,
    summary: "old model pin rule, since removed",
    messages,
    state,
    config,
  });
  assert.ok(dead.ok, dead.resultText);
  assert.equal(dead.state.absorbed!.length, 1);
  assert.equal(dead.state.absorbed![0]!.resultMessageId, "r2");
});
