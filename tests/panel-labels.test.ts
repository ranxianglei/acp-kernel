import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatusPanel,
  DEFAULT_PANEL_LABELS,
  displayWidth,
  fill,
  padLabel,
  renderTitleBox,
  resolvePanelLabels,
  type PanelLabels,
  type StatusPanelInput,
} from "../src/panel/index.js";

function fixture(): StatusPanelInput {
  const nudge = {
    shouldInject: true,
    reason: "ctx high",
    tier: 2,
    compressibleRanges: [],
    contextUsage: 0.43,
    breakdown: { emergencyOverride: 0 },
    contextBreakdown: { system: 0, tool: 20_000, text: 4_000, code: 3_000, summaries: 1_000, total: 28_000, growth: 6_100 },
  };
  const state = {
    blocks: [
      { blockId: "b1", tier: 1, active: true, summary: "Some topic here.", compressedTokens: 25_000, effectiveMessageIds: [], coveredRawIds: [], createdAt: 1 },
    ],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 25_000 },
    nextBlockId: 2,
    nextRunId: 1,
  };
  return {
    version: "test@1",
    tokenCount: 430_000,
    systemPromptTokens: 2_000,
    state: state as never,
    nudge: nudge as never,
    modelContextLimit: 1_000_000,
    unprunedTokens: 134_000,
    cacheUsages: [{ input: 5_000, cacheRead: 9_000, cacheWrite: 1_000 }],
  };
}

test("labels: {} renders byte-identical to no labels", () => {
  const base = fixture();
  const plain = buildStatusPanel(base);
  const empty = buildStatusPanel({ ...base, labels: {} });
  assert.equal(empty, plain);
});

test("default title renders the legacy fixed box verbatim", () => {
  const text = buildStatusPanel(fixture());
  assert.ok(text.includes("╭─────────────────────────────────────────────╮"));
  assert.ok(text.includes("│           ACP Context Analysis              │"));
  assert.ok(text.includes("╰─────────────────────────────────────────────╯"));
});

test("custom title gets a display-width-aware box (CJK counts double)", () => {
  const title = "ACP 上下文分析";
  const [top, mid, bottom] = renderTitleBox(title);
  assert.equal(top, "╭" + "─".repeat(45) + "╮");
  // display width 14 (3 ascii + 1 space + 5×2 cjk) → padL 15, padR 16
  assert.equal(mid, `│${" ".repeat(15)}${title}${" ".repeat(16)}│`);
  assert.equal(bottom, "╰" + "─".repeat(45) + "╯");
  const text = buildStatusPanel({ ...fixture(), labels: { title } });
  assert.ok(text.startsWith(top));
});

test("long title widens the box past the minimum inner width", () => {
  const title = "一二三四五六七八九十一二三四五六七八九十甲乙";
  const [top, mid] = renderTitleBox(title);
  assert.equal(displayWidth(title), 44);
  assert.equal(top, "╭" + "─".repeat(46) + "╮");
  assert.equal(mid, `│ ${title} │`);
});

test("per-key fallback: overriding only title leaves other lines English", () => {
  const text = buildStatusPanel({ ...fixture(), labels: { title: "X" } });
  assert.match(text, /Context \(session accounting, host footer scale\): 43%/);
  assert.match(text, /Token Breakdown \(sent view\):/);
  assert.match(text, /Tag visibility:/);
});

test("full pack substitutes every templated section", () => {
  const labels: PanelLabels = {
    title: "T",
    context: "CTX:{pct}|{used}|{limit}",
    growth: "GRW:{growth}",
    sent: "SENT:{sent}",
    sentOfLimit: "<{pct}>",
    sessionOnly: "ONLY:{only}",
    breakdown: "BD:",
    catTool: "TOOL",
    catSysPrompt: "SYS",
    catText: "TXT",
    catCode: "CODE",
    catSummaries: "SUM",
    promptCache: "PC:{last}|{session}|{read}|{billed}|{requests}",
    nudgeActive: "NA{tierInfo}::{reason}",
    nudgeTierInfo: "[T{tier}]",
    nudgeIdle: "NI::{reason}",
    blocksHeader: "BLK:{active}/{total}/{tokens}",
    blocksNone: "BLK-NONE",
    tagVisibility: "TV",
  };
  const text = buildStatusPanel({ ...fixture(), labels });
  const lines = text.split("\n");
  assert.ok(lines.includes("CTX:43|430k|1.0M"), text);
  assert.ok(lines.includes("GRW:6.1k"), text);
  assert.ok(lines.includes("SENT:30k<3>"), text);
  assert.ok(lines.includes("ONLY:104k"), text);
  assert.ok(lines.includes("BD:"), text);
  const toolLine = lines.find((l) => l.trim().startsWith("TOOL"))!;
  assert.match(toolLine, /67%.*20k/);
  const sysLine = lines.find((l) => l.trim().startsWith("SYS "))!;
  assert.match(sysLine, /7%.*2\.0k/);
  assert.ok(lines.includes("PC:60.0%|60.0%|9.0k|15k|1"), text);
  assert.ok(lines.includes("NA[T2]::ctx high"), text);
  assert.ok(lines.includes("BLK:1/1/25k"), text);
  assert.ok(lines.includes("TV"), text);
  // per-block line stays structural (ids/tier/topic untranslated); topic falls back to topicFallback (first sentence segment)
  assert.ok(lines.some((l) => l.includes("[b1] T1 25k→") && l.endsWith(": Some topic here")), text);
});

test("idle nudge uses nudgeIdle without tier info", () => {
  const base = fixture();
  const nudge = { ...(base.nudge as object), shouldInject: false, tier: null, reason: "all quiet" };
  const text = buildStatusPanel({ ...base, nudge: nudge as never, labels: { nudgeIdle: "NI::{reason}" } });
  assert.ok(text.includes("NI::all quiet"), text);
  assert.doesNotMatch(text, /NA/);
});

test("sentOfLimit omitted when no context limit configured", () => {
  const text = buildStatusPanel({ ...fixture(), modelContextLimit: 0, labels: { sentOfLimit: "ZZZ{pct}" } });
  assert.doesNotMatch(text, /ZZZ/);
  assert.doesNotMatch(text, /% of limit/);
  assert.match(text, /Sent to LLM \(after compression, est\.\): 30k$/m);
});

test("zero-active blocks reuse the blocksHeader template", () => {
  const base = fixture();
  const state = { ...(base.state as object), blocks: [(base.state as { blocks: unknown[] }).blocks.map((b) => ({ ...(b as object), active: false }))] };
  const text = buildStatusPanel({ ...base, state: state as never, nudge: undefined, labels: { blocksHeader: "BLK:{active}/{total}/{tokens}" } });
  assert.ok(text.includes("BLK:0/1/25k"), text);
});

test("blocksNone renders when no blocks exist at all", () => {
  const base = fixture();
  const state = { ...(base.state as object), blocks: [] };
  const text = buildStatusPanel({ ...base, state: state as never, nudge: undefined, labels: { blocksNone: "BLK-NONE" } });
  assert.ok(text.includes("BLK-NONE"), text);
  assert.doesNotMatch(text, /Blocks:/);
});

test("fill substitutes known placeholders and preserves unknown ones", () => {
  assert.equal(fill("{a}-{b}", { a: 1, b: "x" }), "1-x");
  assert.equal(fill("{a}{unknown}", { a: "v" }), "v{unknown}");
  assert.equal(fill("no placeholders", {}), "no placeholders");
});

test("padLabel matches padEnd for ASCII and pads CJK by display width", () => {
  assert.equal(padLabel("Tool", 10), "Tool".padEnd(10));
  assert.equal(padLabel("工具", 10), "工具" + " ".repeat(6));
  assert.equal(padLabel("一个很长的标签", 6), "一个很长的标签");
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
});

test("DEFAULT_PANEL_LABELS keys cover every template used by the panel", () => {
  const keys = Object.keys(DEFAULT_PANEL_LABELS).sort();
  assert.deepEqual(keys, [
    "blocksHeader",
    "blocksNone",
    "breakdown",
    "catCode",
    "catSummaries",
    "catSysPrompt",
    "catText",
    "catTool",
    "context",
    "growth",
    "nudgeActive",
    "nudgeIdle",
    "nudgeTierInfo",
    "promptCache",
    "sent",
    "sentOfLimit",
    "sessionOnly",
    "tagVisibility",
    "title",
  ]);
});

test("non-string label values fall back to the English default", () => {
  const base = fixture();
  const text = buildStatusPanel({ ...base, labels: { title: undefined, context: "CTX:{pct}", sentOfLimit: null as unknown as string } });
  assert.ok(text.includes("ACP Context Analysis"), text);
  assert.ok(text.includes("CTX:43"), text);
  assert.match(text, /% of limit/);
});

test("resolvePanelLabels merges only string entries over the defaults", () => {
  const r = resolvePanelLabels({ title: undefined, context: "X", blocksNone: null as unknown as string });
  assert.equal(r.title, DEFAULT_PANEL_LABELS.title);
  assert.equal(r.context, "X");
  assert.equal(r.blocksNone, DEFAULT_PANEL_LABELS.blocksNone);
});
