import type { CompressionState, Config, RuleRecord } from "./types.js";

/** Canonical model-facing tool name for rule recording (adapters may rename). */
export const RULE_TOOL_NAME = "acp_rule";

export interface RuleLimits {
  /** Maximum number of rules per session. Default 50. */
  maxRules: number;
  /** Maximum characters per rule text (after trim). Default 300. */
  maxRuleChars: number;
}

export const DEFAULT_RULE_LIMITS: RuleLimits = Object.freeze({
  maxRules: 50,
  maxRuleChars: 300,
});

export function rulesEnabled(config: Pick<Config, "rules">): boolean {
  return config.rules?.enabled === true;
}

export function resolveRuleLimits(
  config: Pick<Config, "rules">,
): RuleLimits {
  return {
    maxRules: config.rules?.maxRules ?? DEFAULT_RULE_LIMITS.maxRules,
    maxRuleChars:
      config.rules?.maxRuleChars ?? DEFAULT_RULE_LIMITS.maxRuleChars,
  };
}

export type AddRuleResult =
  | { ok: true; rule: RuleRecord }
  | { ok: false; error: string };

export function listRules(state: CompressionState): RuleRecord[] {
  return state.rules ?? [];
}

const RULE_ID_RE = /^rule-(\d+)$/;

export function allocateRuleId(state: CompressionState): string {
  let max = 0;
  for (const rule of state.rules ?? []) {
    const m = RULE_ID_RE.exec(rule.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `rule-${max + 1}`;
}

export function addRule(
  state: CompressionState,
  text: string,
  limits: Partial<RuleLimits> = {},
): AddRuleResult {
  const maxRules = limits.maxRules ?? DEFAULT_RULE_LIMITS.maxRules;
  const maxRuleChars = limits.maxRuleChars ?? DEFAULT_RULE_LIMITS.maxRuleChars;
  const clean = text.trim();
  if (clean.length === 0) {
    return { ok: false, error: "rule text must not be empty" };
  }
  if (clean.length > maxRuleChars) {
    return {
      ok: false,
      error: `rule too long (${clean.length} chars, limit ${maxRuleChars}) — keep rules short and principle-level`,
    };
  }
  const existing = state.rules ?? [];
  const dup = existing.find((r) => r.text === clean);
  if (dup) {
    return { ok: false, error: `identical rule already recorded (${dup.id})` };
  }
  if (existing.length >= maxRules) {
    return {
      ok: false,
      error: `rule limit reached (${maxRules}) — stale rules can be dropped by editing the session state file`,
    };
  }
  const rule: RuleRecord = { id: allocateRuleId(state), text: clean };
  state.rules = [...existing, rule];
  return { ok: true, rule };
}

export function removeRule(state: CompressionState, id: string): boolean {
  const existing = state.rules ?? [];
  const next = existing.filter((r) => r.id !== id);
  if (next.length === existing.length) return false;
  state.rules = next;
  return true;
}

export function clearRules(state: CompressionState): number {
  const count = (state.rules ?? []).length;
  state.rules = [];
  return count;
}

/** Render recorded rules for list output (model/human review). Empty string
 *  when none. */
export function formatRulesList(rules: RuleRecord[]): string {
  if (rules.length === 0) return "";
  const lines = rules.map((r, i) => `${i + 1}. ${r.text}`);
  return `Recorded rules (${rules.length}):\n${lines.join("\n")}`;
}

/** Model-facing usage instructions. Placed ONLY in the tool description —
 *  the feature deliberately does not touch the system prompt. */
export const RULE_TOOL_DESCRIPTION =
  "Record a short, principle-level reminder so it survives context compression — the call and its result are protected and stay in context. " +
  "Record when: the user calls out or repeatedly emphasizes a lesson; the user asks you to remember or follow a behavior; you personally hit a major pitfall worth remembering long-term. " +
  "Keep each rule to one short line. Omit the rule argument to list recorded rules.";

const RULE_PARAMETERS = {
  type: "object" as const,
  properties: {
    rule: {
      type: "string",
      description:
        "Short principle-level reminder to record. Omit to list recorded rules.",
    },
  },
};

/** Anthropic-format tool (name + description + input_schema). Opt-in feature:
 *  NOT part of ACP_TOOLS_* arrays — hosts register/inject only when
 *  config.rules.enabled. */
export const RULE_TOOL = {
  name: RULE_TOOL_NAME,
  description: RULE_TOOL_DESCRIPTION,
  input_schema: RULE_PARAMETERS,
};

export const RULE_TOOL_OPENAI = {
  type: "function" as const,
  function: {
    name: RULE_TOOL_NAME,
    description: RULE_TOOL_DESCRIPTION,
    parameters: RULE_PARAMETERS,
  },
};

export const RULE_TOOL_RESPONSES = {
  type: "function" as const,
  name: RULE_TOOL_NAME,
  description: RULE_TOOL_DESCRIPTION,
  parameters: RULE_PARAMETERS,
};
