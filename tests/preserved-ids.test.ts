import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { markBlockRestoredInline } from "../src/decompress.js";
import {
  buildFidelityAppendix,
  extractFidelityIds,
  fidelitySourceTexts,
} from "../src/preserved-ids.js";
import type {
  CompressionBlock,
  CompressionState,
  Config,
  CoreMessage,
} from "../src/types.js";

// #481: mechanical fidelity — subagent-dispatch session ids (ses_...) found in
// folded tool content must survive into the compression block verbatim,
// regardless of what the model summary writes. These tests are the mechanical
// assertions: includes-full-string on the stored block summary.

const SES_ID = "ses_f195c333effeab12cd34567890";

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function textMsg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

/** The opencode subagent dispatch pair shape: tool-call args + tool-result. */
function dispatchPair(): CoreMessage[] {
  return [
    {
      id: "call-1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "task",
      toolCallId: "tc-1",
      text: JSON.stringify({
        prompt: "continue the build",
        session_id: SES_ID,
      }),
    },
    {
      id: "result-1",
      role: "tool",
      contentType: "tool-result",
      toolName: "task",
      toolCallId: "tc-1",
      text: `Subagent finished. Log: resumed ${SES_ID}, rebuilt 4 targets.`,
    },
  ];
}

function stateWithRefs(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

function makeBlock(
  overrides: Partial<CompressionBlock> &
    Pick<CompressionBlock, "blockId" | "effectiveMessageIds">,
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "OLD SUMMARY",
    directMessageIds: overrides.effectiveMessageIds,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 1758800000000,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

// Unit: extraction -------------------------------------------------------------

test("extractFidelityIds dedupes across texts and preserves first-occurrence order", () => {
  const ids = extractFidelityIds([
    `dispatch ${SES_ID}`,
    `again ${SES_ID} and ses_b2b2b2`,
  ]);
  assert.deepEqual(ids.get("subagent-session"), [SES_ID, "ses_b2b2b2"]);
});

test("extractFidelityIds is prefix-collision safe: ses_ab and ses_abcdef are distinct ids", () => {
  const ids = extractFidelityIds(["id=ses_ab", "id=ses_abcdef"]);
  assert.deepEqual(ids.get("subagent-session"), ["ses_ab", "ses_abcdef"]);
});

test("extractFidelityIds returns an empty map when nothing matches", () => {
  assert.equal(extractFidelityIds(["no identifiers here"]).size, 0);
  assert.equal(extractFidelityIds([]).size, 0);
});

test("fidelitySourceTexts selects tool-call and tool-result messages only", () => {
  const texts = fidelitySourceTexts([
    textMsg("u", "prose with ses_shouldnotcount"),
    textMsg("a", "more prose ses_alsonot", "assistant"),
    {
      id: "t1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "task",
      text: "call ses_yes1",
    },
    {
      id: "t2",
      role: "tool",
      contentType: "tool-result",
      toolName: "task",
      text: "res ses_yes2",
    },
    {
      id: "r1",
      role: "assistant",
      contentType: "reasoning",
      text: "think ses_no",
    },
  ]);
  assert.deepEqual(texts, ["call ses_yes1", "res ses_yes2"]);
});

test("buildFidelityAppendix skips ids already present verbatim and is prefix-collision safe", () => {
  const ids = new Map([
    ["subagent-session", ["ses_ab", "ses_abcdef", "ses_present"]],
  ]);
  const appendix = buildFidelityAppendix(
    "summary mentions ses_abcdef and ses_present",
    ids,
  );
  assert.equal(appendix, "\n[acp-preserved:subagent-session] ses_ab");
});

test("buildFidelityAppendix returns '' when everything is already present or nothing extracted", () => {
  const ids = new Map([["subagent-session", ["ses_only"]]]);
  assert.equal(buildFidelityAppendix("kept ses_only verbatim", ids), "");
  assert.equal(buildFidelityAppendix("anything", new Map()), "");
});

test("DEFAULT_FIDELITY_EXTRACTORS captures the opencode session-id shape only", () => {
  const ids = extractFidelityIds([`x ${SES_ID} y`, "no identifiers here"]);
  assert.deepEqual(ids.get("subagent-session"), [SES_ID]);
});

// Integration: fresh T1 fold ----------------------------------------------------

test("T1 fold: model summary drops the subagent session id -> kernel appends it verbatim", () => {
  const core = createCore();
  const messages = [
    textMsg("u1", "please continue the build via subagent"),
    ...dispatchPair(),
    textMsg("a1", "continuing with the results", "assistant"),
  ];
  const state = stateWithRefs(messages);

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00004",
        summary: "Subagent dispatched and returned; work continued.",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[0]!;
  // Mechanical assertion: the id exists verbatim whatever the model wrote.
  assert.ok(
    block.summary.includes(SES_ID),
    `stored summary lost the id: ${block.summary}`,
  );
  assert.ok(
    block.summary.includes(`[acp-preserved:subagent-session] ${SES_ID}`),
    `missing machine appendix line: ${block.summary}`,
  );
  assert.ok(
    result.result.notes?.some((n) =>
      n.includes("[acp-preserved:subagent-session]"),
    ),
    "kernel note surfaces the mechanical preservation",
  );
  assert.deepEqual(
    block.effectiveMessageIds.sort(),
    ["a1", "call-1", "result-1", "u1"].sort(),
  );
});

test("T1 fold: model summary already carries the full id -> stored summary byte-identical, no duplicate line", () => {
  const core = createCore();
  const messages = [
    textMsg("u1", "dispatch"),
    ...dispatchPair(),
    textMsg("a1", "done", "assistant"),
  ];
  const state = stateWithRefs(messages);
  const modelSummary = `Worked with session ${SES_ID} and finished.`;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: modelSummary }],
    messages,
    state,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  const block = result.state.blocks[0]!;
  assert.equal(
    block.summary,
    modelSummary,
    "byte-identical when the model got it right",
  );
  assert.equal(result.result.notes?.length ?? 0, 0);
});

test("T1 fold: no ses_ ids anywhere -> stored summary byte-identical", () => {
  const core = createCore();
  const messages = [
    textMsg("u1", "plain question"),
    {
      id: "call-1",
      role: "assistant",
      contentType: "tool-call" as const,
      toolName: "bash",
      toolCallId: "tc-1",
      text: JSON.stringify({ command: "ls -la" }),
    },
    {
      id: "result-1",
      role: "tool",
      contentType: "tool-result" as const,
      toolName: "bash",
      toolCallId: "tc-1",
      text: "file.txt\ndir/",
    },
    textMsg("a1", "listed files", "assistant"),
  ];
  const state = stateWithRefs(messages);
  const modelSummary = "Listed the directory contents.";

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: modelSummary }],
    messages,
    state,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.state.blocks[0]!.summary, modelSummary);
});

test("T1 fold: ses_ id only in prose (not tool content) is NOT preserved — directed narrowing holds", () => {
  const core = createCore();
  const messages = [
    textMsg("u1", `the ticket mentions ${SES_ID} in passing`),
    textMsg("a1", "noted the mention", "assistant"),
  ];
  const state = stateWithRefs(messages);
  const modelSummary = "User mentioned a session id in passing.";

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: modelSummary }],
    messages,
    state,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(
    result.state.blocks[0]!.summary,
    modelSummary,
    "prose ids stay model-owned",
  );
});

test("T1 fold: multiple distinct ids each preserved once, duplicates across call+result collapsed", () => {
  const core = createCore();
  const other = "ses_aaaabbbbccccdddd";
  const messages = [
    textMsg("u1", "fan out"),
    {
      id: "call-1",
      role: "assistant",
      contentType: "tool-call" as const,
      toolName: "task",
      toolCallId: "tc-1",
      text: JSON.stringify({ session_id: SES_ID }),
    },
    {
      id: "result-1",
      role: "tool",
      contentType: "tool-result" as const,
      toolName: "task",
      toolCallId: "tc-1",
      text: `done ${SES_ID}`,
    },
    {
      id: "call-2",
      role: "assistant",
      contentType: "tool-call" as const,
      toolName: "task",
      toolCallId: "tc-2",
      text: JSON.stringify({ session_id: other }),
    },
    {
      id: "result-2",
      role: "tool",
      contentType: "tool-result" as const,
      toolName: "task",
      toolCallId: "tc-2",
      text: `done ${other}`,
    },
    textMsg("a1", "both back", "assistant"),
  ];
  const state = stateWithRefs(messages);

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00006", summary: "Two subagents ran." },
    ],
    messages,
    state,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  const summary = result.state.blocks[0]!.summary;
  assert.equal(
    summary.match(new RegExp(SES_ID, "g"))!.length,
    1,
    "each id recorded once",
  );
  assert.equal(summary.match(new RegExp(other, "g"))!.length, 1);
  assert.ok(
    summary.includes(`[acp-preserved:subagent-session] ${SES_ID}, ${other}`),
  );
});

// Integration: tier distillation propagation -------------------------------------

test("T2 distillation: ids carried in consumed T1 summaries propagate into the T2 block", () => {
  const core = createCore();
  const messages = [
    textMsg("a", "early work one"),
    textMsg("b", "early work two"),
    textMsg("c", "later work one"),
    textMsg("d", "later work two"),
  ];
  const state = stateWithRefs(messages);
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: ["a", "b"],
      summary: `Dispatched and folded earlier. [acp-preserved:subagent-session] ${SES_ID}`,
    }),
    makeBlock({
      blockId: "b2",
      effectiveMessageIds: ["c", "d"],
      summary: "Later work recap.",
    }),
  );
  state.nextBlockId = 3;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "b1",
        endRef: "b2",
        summary: "Distilled span.",
        topic: "distill",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.deepEqual(result.result.errors, [], JSON.stringify(result.result));
  const created = result.state.blocks.find((b) => b.active && b.tier === 2)!;
  assert.ok(created, "a T2 block was created");
  assert.ok(
    created.summary.includes(SES_ID),
    `T2 block lost the id: ${created.summary}`,
  );
  assert.deepEqual(created.directBlockIds.sort(), ["b1", "b2"]);
});

// Integration: refold-in-place ----------------------------------------------------

test("refold-in-place: re-fold dropping the id keeps it via the machine appendix", () => {
  const core = createCore();
  const messages = Array.from({ length: 4 }, (_, i) =>
    textMsg(`msg-${i + 1}`, `content ${i + 1}`, "assistant"),
  );
  const state = stateWithRefs(messages);
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.map((m) => m.id),
      startRef: "m00001",
      endRef: "m00004",
      summary: `Old fold. [acp-preserved:subagent-session] ${SES_ID}`,
    }),
  );
  state.nextBlockId = 2;
  const { state: marked } = markBlockRestoredInline(state, "b1");

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00004", summary: "Re-folded details." },
    ],
    messages: [],
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(
    result.state.blocks.length,
    1,
    "refolded in place, no new block",
  );
  const block = result.state.blocks[0]!;
  assert.equal(block.blockId, "b1");
  assert.ok(
    block.summary.startsWith("Re-folded details."),
    "new summary leads",
  );
  assert.ok(
    block.summary.includes(SES_ID),
    `refold dropped the id: ${block.summary}`,
  );
  assert.ok(
    block.summary.includes(`[acp-preserved:subagent-session] ${SES_ID}`),
  );
});

test("refold-in-place: id present only in still-visible tool messages is appended too", () => {
  const core = createCore();
  const messages = [
    ...dispatchPair(),
    textMsg("a1", "aftermath", "assistant"),
    textMsg("a2", "more aftermath", "assistant"),
  ];
  const state = stateWithRefs(messages);
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.map((m) => m.id),
      startRef: "m00001",
      endRef: "m00004",
      summary: "Old fold without any id.",
    }),
  );
  state.nextBlockId = 2;
  const { state: marked } = markBlockRestoredInline(state, "b1");

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00004", summary: "Re-folded again." },
    ],
    messages,
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  const block = result.state.blocks[0]!;
  assert.ok(
    block.summary.includes(SES_ID),
    `live tool content id lost: ${block.summary}`,
  );
});
