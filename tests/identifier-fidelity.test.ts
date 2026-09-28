import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
} from "../src/compression-rules.js";
import { LEAN_HOW_TO_COMPRESS } from "../src/packs.js";
import { renderNudgeText } from "../src/nudge-text.js";
import { buildCompressSystemPrompt } from "../src/compress-tools.js";
import type { NudgeDecision, CompressibleRange } from "../src/types.js";

// billion-context#1563: a fold summary copied a `ses_` session id short
// (24 → 12 chars); subagent resume-by-id then failed ("Subagent session not
// found"). The identifier-fidelity clauses below were added to every tier's
// contract because weak models abbreviated ids even though "exact values" was
// already listed. These pins fail if any clause is ever removed or rewritten —
// changing them must be a deliberate, reviewed act.

const T1_IDENTIFIER_BULLET = `- Identifiers (session ids, commit hashes, PR/issue numbers, and any other opaque machine-generated string): copy character-for-character — never truncate, abbreviate, or ellipsize. A shortened identifier fails silently at the point of reuse (subagent resume with a truncated \`ses_\` id finds nothing), long after the summary that mangled it.`;

const T2_IDENTIFIER_BULLET = `- Live identifiers still referenced by kept content — session ids, commit hashes, PR/issue numbers named in a surviving fact: re-carry them character-for-character from the source blocks; never re-derive, shorten, or "tidy." An identifier no kept fact references may drop with its context.`;

const LEAN_IDENTIFIER_BULLET = `- Identifiers (session ids, commit hashes, PR/issue numbers, other opaque machine-generated strings): character-for-character — never truncated or abbreviated; a shortened id fails silently at reuse.`;

test("HOW_TO_COMPRESS_RULES pins the identifier-fidelity clause (#1563)", () => {
  assert.ok(
    HOW_TO_COMPRESS_RULES.includes(T1_IDENTIFIER_BULLET),
    "T1 KEEP VERBATIM list lost its identifier bullet",
  );
});

test("TIER2_DISTILL_RULES pins the live-identifier re-carry clause (#1563)", () => {
  assert.ok(
    TIER2_DISTILL_RULES.includes(T2_IDENTIFIER_BULLET),
    "T2 distill KEEP list lost its identifier bullet",
  );
});

test("LEAN_HOW_TO_COMPRESS pins the identifier-fidelity clause (#1563)", () => {
  assert.ok(
    LEAN_HOW_TO_COMPRESS.includes(LEAN_IDENTIFIER_BULLET),
    "lean pack KEEP VERBATIM list lost its identifier bullet",
  );
});

function makeRanges(count: number): CompressibleRange[] {
  return Array.from({ length: count }, (_, i) => ({
    startRef: `m${String(i * 3 + 1).padStart(5, "0")}`,
    endRef: `m${String(i * 3 + 3).padStart(5, "0")}`,
    count: 3,
    tokens: 1000 * (i + 1),
    toolPct: 0.7,
    textPct: 0.3,
  }));
}

function makeDecision(overrides: Partial<NudgeDecision> = {}): NudgeDecision {
  return {
    shouldInject: true,
    reason: "test",
    compressibleRanges: makeRanges(3),
    contextUsage: 0.5,
    tier: null,
    breakdown: { emergencyOverride: 0 },
    ...overrides,
  };
}

test("gentle nudge channel carries the clause (full rules embedded)", () => {
  const rendered = renderNudgeText(makeDecision({ contextUsage: 0.5 }));
  assert.ok(rendered.text.includes(T1_IDENTIFIER_BULLET));
});

test("tier-2 nudge channel carries the live-identifier clause", () => {
  const rendered = renderNudgeText(makeDecision({ tier: 2 }));
  assert.ok(rendered.text.includes(T2_IDENTIFIER_BULLET));
});

test("standing compress system prompt carries the clause", () => {
  const prompt = buildCompressSystemPrompt();
  assert.ok(prompt.includes(T1_IDENTIFIER_BULLET));
});
