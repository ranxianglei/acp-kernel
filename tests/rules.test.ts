import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import {
  RULE_TOOL_NAME,
  DEFAULT_RULE_LIMITS,
  RULES_USAGE_PROMPT,
  listRules,
  allocateRuleId,
  addRule,
  removeRule,
  clearRules,
  formatRulesForPrompt,
} from "../src/rules.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCall(id: string, toolName: string, callId: string, args: string): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId: callId, text: args };
}

function toolResult(id: string, callId: string, text: string): CoreMessage {
  return { id, role: "tool", contentType: "tool-result", toolCallId: callId, text };
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
const validSummary = "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0, preserveRecentTokens: 0,
    ...overrides,
  });
}

test("rules: allocateRuleId issues sequential ids without mutating state", () => {
  const state = createInitialState();
  assert.equal(allocateRuleId(state), "rule1");
  assert.equal(allocateRuleId(state), "rule1");
  const s1 = addRule(state, "first").state;
  const s2 = addRule(s1, "second").state;
  assert.deepEqual(listRules(s2).map((r) => r.id), ["rule1", "rule2"]);
});

test("rules: addRule records a valid rule with trimmed text on legacy state", () => {
  const legacy = { ...createInitialState() };
  delete legacy.rules;
  delete legacy.nextRuleId;
  const res = addRule(legacy, "  remember to run npm ci before tests  ");
  assert.ok(res.ok);
  assert.equal(res.rule?.id, "rule1");
  assert.equal(res.rule?.text, "remember to run npm ci before tests");
  assert.equal(listRules(res.state).length, 1);
  assert.equal(res.state.nextRuleId, 2);
});

test("rules: addRule rejects empty and whitespace-only text", () => {
  const state = createInitialState();
  for (const text of ["", "   ", "\n\t"]) {
    const res = addRule(state, text);
    assert.equal(res.ok, false);
    assert.match(res.resultText, /empty/);
    assert.equal(listRules(res.state).length, 0);
  }
});

test("rules: addRule enforces the per-rule character limit", () => {
  const atLimit = addRule(createInitialState(), "a".repeat(300));
  assert.ok(atLimit.ok, "300 chars is within the default limit");
  const overDefault = addRule(createInitialState(), "a".repeat(301));
  assert.equal(overDefault.ok, false);
  assert.match(overDefault.resultText, /exceeds the 300-char limit/);
  const overCustom = addRule(createInitialState(), "b".repeat(10), { maxChars: 5 });
  assert.equal(overCustom.ok, false);
  assert.match(overCustom.resultText, /exceeds the 5-char limit/);
});

test("rules: addRule enforces the total rule count limit", () => {
  let state = createInitialState();
  for (let i = 1; i <= 50; i++) {
    const res = addRule(state, `rule number ${i}`);
    assert.ok(res.ok, `adding rule ${i} should succeed`);
    state = res.state;
  }
  const over = addRule(state, "one too many");
  assert.equal(over.ok, false);
  assert.match(over.resultText, /limit reached \(50\)/);
  assert.equal(listRules(over.state).length, 50);
  const zeroCap = addRule(createInitialState(), "x", { maxCount: 0 });
  assert.equal(zeroCap.ok, false);
});

test("rules: addRule deduplicates identical content", () => {
  const state = addRule(createInitialState(), "always use pnpm here").state;
  const dup = addRule(state, "  always use pnpm here  ");
  assert.equal(dup.ok, false);
  assert.match(dup.resultText, /identical rule already exists \(rule1\)/);
  assert.equal(listRules(dup.state).length, 1);
  const other = addRule(state, "use pnpm only in this repo");
  assert.ok(other.ok);
  assert.equal(other.rule?.id, "rule2");
});

test("rules: removeRule removes by id and reports unknown ids", () => {
  const state = addRule(addRule(createInitialState(), "first").state, "second").state;
  const removed = removeRule(state, "rule1");
  assert.ok(removed.ok);
  assert.deepEqual(listRules(removed.state).map((r) => r.id), ["rule2"]);
  const missing = removeRule(state, "rule99");
  assert.equal(missing.ok, false);
  assert.match(missing.resultText, /no rule with id/);
  assert.equal(listRules(missing.state).length, 2);
});

test("rules: clearRules empties the list without reusing ids", () => {
  const state = addRule(createInitialState(), "doomed").state;
  const cleared = clearRules(state);
  assert.ok(cleared.ok);
  assert.equal(listRules(cleared.state).length, 0);
  const next = addRule(cleared.state, "fresh");
  assert.equal(next.rule?.id, "rule2");
  const noop = clearRules(createInitialState());
  assert.ok(noop.ok);
  assert.match(noop.resultText, /no rules to clear/);
});

test("rules: formatRulesForPrompt renders rules and constants are wired", () => {
  assert.equal(formatRulesForPrompt(createInitialState()), "");
  let state = addRule(createInitialState(), "never force-push master").state;
  state = addRule(state, "run npm test before committing").state;
  const section = formatRulesForPrompt(state);
  assert.match(section, /PERSISTENT USER RULES/);
  assert.match(section, /\[rule1\] never force-push master/);
  assert.match(section, /\[rule2\] run npm test before committing/);
  assert.match(RULES_USAGE_PROMPT, new RegExp(RULE_TOOL_NAME));
  assert.equal(RULE_TOOL_NAME, "acp_rule");
  assert.equal(DEFAULT_RULE_LIMITS.maxChars, 300);
  assert.equal(DEFAULT_RULE_LIMITS.maxCount, 50);
});

test("rules: acp_rule calls and results are hard-excluded from compression without any config", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "acp_rule", "call-rule", '{"action":"add","text":"remember X"}'),
    toolResult("c", "call-rule", "rule recorded as rule1"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ protectedTools: [] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);

  const block = result.state.blocks[0]!;
  assert.ok(!block.directMessageIds.includes("b"), "acp_rule tool-call must be excluded");
  assert.ok(!block.directMessageIds.includes("c"), "acp_rule tool-result must be excluded");
  assert.ok(block.directMessageIds.includes("a"), "regular msg 'a' should remain");
  assert.ok(block.directMessageIds.includes("d"), "regular msg 'd' should remain");
  assert.ok(!block.effectiveMessageIds.includes("b"), "tool-call excluded from effective coverage");
  assert.ok(!block.effectiveMessageIds.includes("c"), "tool-result excluded from effective coverage");
  assert.ok(block.effectiveMessageIds.includes("a"), "regular msg 'a' in effective coverage");
  assert.ok(block.effectiveMessageIds.includes("d"), "regular msg 'd' in effective coverage");
});

test("rules: survive processTurn and applyCompression; ids are never re-issued", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "acp_rule", "call-rule", '{"action":"add","text":"remember X"}'),
    toolResult("c", "call-rule", "rule recorded as rule1"),
    msg("d", longText),
  ];
  let state = setupRefs(messages);
  state = addRule(state, "always reply in Chinese").state;
  assert.equal(state.nextRuleId, 2);

  const afterTurn = core.processTurn({ messages, state, config: cfg(), tokenCount: 100 }).state;
  assert.deepEqual(listRules(afterTurn).map((r) => r.id), ["rule1"], "rules must survive processTurn");
  assert.equal(afterTurn.nextRuleId, 2, "counter must survive processTurn");

  const afterCompress = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state: afterTurn,
    config: cfg(),
  }).state;
  assert.deepEqual(listRules(afterCompress).map((r) => r.id), ["rule1"], "rules must survive applyCompression");
  assert.equal(afterCompress.nextRuleId, 2, "counter must survive applyCompression");

  const next = addRule(afterCompress, "second rule");
  assert.ok(next.ok);
  assert.equal(next.rule?.id, "rule2", "id space is monotonic across turns and compressions");
});
