import type { CompressionState, RuleRecord } from "./types.js";

/**
 * Persistent rules ("acp_rule") — durable reminders recorded for future turns.
 * The adapter injects formatRulesForPrompt(state) into the system prompt every
 * turn, and acp_rule tool calls/results are hard-protected from compression
 * (ALWAYS_PROTECTED_TOOLS), so a recorded rule survives context compaction.
 */

export const RULE_TOOL_NAME = "acp_rule";

export interface RuleLimits {
  maxChars: number;
  maxCount: number;
}

export const DEFAULT_RULE_LIMITS: RuleLimits = Object.freeze({
  maxChars: 300,
  maxCount: 50,
});

export function listRules(state: CompressionState): RuleRecord[] {
  return state.rules ?? [];
}

const RULE_ID_RE = /^rule(\d+)$/;

function highestRuleNumber(state: CompressionState): number {
  let highest = 0;
  for (const rule of state.rules ?? []) {
    const match = RULE_ID_RE.exec(rule.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/** Pure (unlike allocateBlockId): returns the next rule id without mutating
 *  state. Never re-issues an issued id, even after removal. */
export function allocateRuleId(state: CompressionState): string {
  const next = Math.max(state.nextRuleId ?? 1, highestRuleNumber(state) + 1);
  return `rule${next}`;
}

export interface AddRuleResult {
  state: CompressionState;
  ok: boolean;
  resultText: string;
  rule?: RuleRecord;
}

export function addRule(
  state: CompressionState,
  text: string,
  limits: Partial<RuleLimits> = {},
): AddRuleResult {
  const maxChars = limits.maxChars ?? DEFAULT_RULE_LIMITS.maxChars;
  const maxCount = limits.maxCount ?? DEFAULT_RULE_LIMITS.maxCount;
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return {
      state,
      ok: false,
      resultText:
        "acp_rule failed: text is empty — provide the reminder to remember.",
    };
  }
  if (trimmed.length > maxChars) {
    return {
      state,
      ok: false,
      resultText: `acp_rule failed: ${trimmed.length} chars exceeds the ${maxChars}-char limit — keep rules short and principle-level.`,
    };
  }
  const rules = listRules(state);
  const duplicate = rules.find((rule) => rule.text === trimmed);
  if (duplicate) {
    return {
      state,
      ok: false,
      resultText: `acp_rule failed: identical rule already exists (${duplicate.id}) — no change.`,
    };
  }
  if (rules.length >= maxCount) {
    return {
      state,
      ok: false,
      resultText: `acp_rule failed: rule limit reached (${maxCount}) — remove or clear outdated rules first.`,
    };
  }
  const next = Math.max(state.nextRuleId ?? 1, highestRuleNumber(state) + 1);
  const rule: RuleRecord = { id: `rule${next}`, text: trimmed };
  const stateAfter: CompressionState = {
    ...state,
    rules: [...rules, rule],
    nextRuleId: next + 1,
  };
  return {
    state: stateAfter,
    ok: true,
    resultText: `rule recorded as ${rule.id}. It stays in the system prompt every turn and is protected from compression.`,
    rule,
  };
}

export interface RuleOpResult {
  state: CompressionState;
  ok: boolean;
  resultText: string;
}

export function removeRule(state: CompressionState, id: string): RuleOpResult {
  const rules = listRules(state);
  const target = rules.find((rule) => rule.id === id.trim());
  if (!target) {
    return {
      state,
      ok: false,
      resultText: `acp_rule failed: no rule with id "${id}" (use action "list" to see current rules).`,
    };
  }
  const stateAfter: CompressionState = {
    ...state,
    rules: rules.filter((rule) => rule.id !== target.id),
  };
  return {
    state: stateAfter,
    ok: true,
    resultText: `rule removed (${target.id}). Its id will never be re-issued.`,
  };
}

export function clearRules(state: CompressionState): RuleOpResult {
  const rules = listRules(state);
  if (rules.length === 0) {
    return { state, ok: true, resultText: "no rules to clear." };
  }
  const stateAfter: CompressionState = { ...state, rules: [] };
  return {
    state: stateAfter,
    ok: true,
    resultText: `all ${rules.length} rule(s) cleared. Issued ids will never be re-issued.`,
  };
}

/** System-prompt section for adapters with rules enabled. Returns "" when no
 *  rules exist so empty sessions pay zero tokens. */
export function formatRulesForPrompt(state: CompressionState): string {
  const rules = listRules(state);
  if (rules.length === 0) return "";
  const lines = rules.map((rule) => `- [${rule.id}] ${rule.text}`);
  return `PERSISTENT USER RULES (${RULE_TOOL_NAME}) — these reminders apply to every turn of this session and take precedence over default behavior:\n${lines.join("\n")}`;
}

export const RULES_USAGE_PROMPT = `PERSISTENT REMINDERS (${RULE_TOOL_NAME})

You can record persistent reminders that are injected into your system prompt for every remaining turn of this session. Call ${RULE_TOOL_NAME}({ action: "add", text }) when:
- the user singles out a lesson, constraint, or preference ("remember this", "never do X again");
- the user emphasizes the same point repeatedly;
- the user asks you to remember a behavior or setting;
- you hit a significant pitfall worth not repeating (build failure, wrong assumption, environment quirk).

Rules must be SHORT and principle-level (max ${DEFAULT_RULE_LIMITS.maxChars} chars each, ${DEFAULT_RULE_LIMITS.maxCount} total) — record the rule, not the incident. Check existing rules first (action: "list") and never add duplicates. Drop outdated rules with action: "remove" (pass the rule id) or wipe all with action: "clear". Recorded rules survive context compression: their tool calls are hard-protected.`;
