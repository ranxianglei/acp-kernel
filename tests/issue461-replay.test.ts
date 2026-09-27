import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { remintCoveredLiveIds } from "../src/instance-reid.js";
import { defaultConfig } from "../src/config.js";
import { ClusterCounter, deriveMessageId } from "../src/wire/message-id.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

const H = "h_0123456789abcdef";
const E = "h_aaaaaaaaaaaaaaaa";
const SUMMARY_ID = "acp_summary_b1";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function folded(
  ids: string[],
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: ids,
    directBlockIds: [],
    compressedTokens: 0,
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("positional replay keeps original ids so prune can replace them (#461)", () => {
  const state = createInitialState();
  state.blocks.push(folded([E, H]));
  const msgs = [msg(E, "a"), msg(H, "b")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out, msgs);
});

test("single-base replay keeps the original id (one-message fold echo, #461)", () => {
  const state = createInitialState();
  state.blocks.push(folded([H]));
  const msgs = [msg(H, "b")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out, msgs);
});

test("positional replay tolerates an appended new duplicate of folded text", () => {
  const state = createInitialState();
  state.blocks.push(folded([E, H]));
  const msgs = [msg(E, "a"), msg(H, "b"), msg(`${H}_1`, "c")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out, msgs);
});

test("pruned-view shape re-mints the colliding occurrence (#1476)", () => {
  const state = createInitialState();
  state.blocks.push(folded([E, H]));
  const out = remintCoveredLiveIds(
    [
      msg(SUMMARY_ID, "[Compressed conversation section] …", "system"),
      msg(H, "b"),
    ],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [SUMMARY_ID, `${H}_1`],
  );
});

test("partial presence re-mints conservatively (survival over deletion)", () => {
  const state = createInitialState();
  state.blocks.push(folded([E, H]));
  const out = remintCoveredLiveIds([msg(H, "b")], state);
  assert.equal(out[0].id, `${H}_1`);
});

test("non-conflicting siblings keep their own numbering when a sibling base is folded", () => {
  const state = createInitialState();
  state.blocks.push(folded([`${H}_1`]));
  const msgs = [msg(H, "a"), msg(`${H}_1`, "b")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out, msgs);
});

test("deactivated block whose summary returns still protects new duplicates", () => {
  const state = createInitialState();
  state.blocks.push(folded([H], { active: false }));
  const out = remintCoveredLiveIds(
    [
      msg(SUMMARY_ID, "[Compressed conversation section] …", "system"),
      msg(H, "b"),
    ],
    state,
  );
  assert.equal(out[1].id, `${H}_1`);
});

test("expanded blocks never cover (restored originals keep their ids)", () => {
  const state = createInitialState();
  state.blocks.push(folded([H], { expanded: true }));
  const msgs = [msg(H, "b")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out, msgs);
});

// ── End-to-end: 40 alternating messages, fold m00001..m00015, then resend ──

const N = 40;
const FOLD_SUMMARY =
  "Summary body of the first fifteen alternating messages, covering their unique content.";

function buildHistory(): CoreMessage[] {
  const clusters = new ClusterCounter();
  const out: CoreMessage[] = [];
  for (let i = 0; i < N; i++) {
    const role: CoreMessage["role"] = i % 2 === 0 ? "user" : "assistant";
    const filler = `filler-${i}-`.repeat(40);
    const text = `message number ${i} with unique content alpha-${i} ${filler}`;
    out.push({
      id: clusters.next(deriveMessageId(role, "text", text)),
      role,
      contentType: "text",
      text,
    });
  }
  return out;
}

function setupFolded() {
  const core = createCore();
  const config = defaultConfig(200000);
  const history = buildHistory();
  const pass1 = core.processTurn({
    messages: history,
    state: createInitialState(),
    config,
    tokenCount: N * 60,
  });
  const ap = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00015", summary: FOLD_SUMMARY }],
    messages: pass1.messages,
    state: pass1.state,
    config: { ...config, preserveRecentTokens: 0 },
  });
  assert.equal(ap.result.blocksCreated, 1);
  return { core, config, history, stateAfterFold: ap.state };
}

test("full-history resend: covered originals pruned, summary at anchor, refs stable (#461)", () => {
  const { core, config, history, stateAfterFold } = setupFolded();
  const result = core.processTurn({
    messages: history,
    state: stateAfterFold,
    config,
    tokenCount: N * 60,
  });
  const msgs = result.messages;
  assert.equal(msgs.length, 27);
  assert.equal(msgs[0]?.id, SUMMARY_ID);
  assert.equal(msgs[1]?.id, history[0]!.id);
  for (let i = 2; i < msgs.length; i++) {
    assert.equal(msgs[i]!.id, history[i + 13]!.id);
  }
  assert.ok(!msgs.some((m) => /_\d+$/.test(m.id)));
  assert.equal(
    result.state.blocks.find((b) => b.blockId === "b1")?.active,
    true,
  );
  assert.equal(result.state.messageRefs.byRaw[history[20]!.id], "m00021");
});

test("full-history resend + genuinely new duplicate: dup survives with its own ref (#461/#1476)", () => {
  const { core, config, history, stateAfterFold } = setupFolded();
  const h7 = history[7]!;
  const dup: CoreMessage = {
    id: `${h7.id}_1`,
    role: h7.role,
    contentType: "text",
    text: h7.text,
  };
  const result = core.processTurn({
    messages: [...history, dup],
    state: stateAfterFold,
    config,
    tokenCount: (N + 1) * 60,
  });
  const fresh = result.messages.find((m) => m.id === dup.id);
  assert.ok(fresh, "new duplicate must survive under its distinct id");
  assert.ok(result.state.messageRefs.byRaw[dup.id]);
  assert.ok(!result.messages.some((m) => m.id === h7.id));
  assert.ok(result.messages.some((m) => m.id === SUMMARY_ID));
  assert.equal(
    result.state.blocks.find((b) => b.blockId === "b1")?.active,
    true,
  );
  const coveredAlive = history
    .slice(0, 15)
    .filter((m) => result.messages.some((o) => o.id === m.id));
  assert.ok(
    coveredAlive.length <= 1 &&
      coveredAlive.every((m) => m.id === history[0]!.id),
  );
});

test("pruned view + new duplicate of folded text: re-minted, ref'd, not dropped (#461)", () => {
  const { core, config, history, stateAfterFold } = setupFolded();
  // Feed the post-resend state forward: on the buggy head this turn silently
  // DROPPED the new duplicate (block deactivated by the prior bad resend).
  const s1 = core.processTurn({
    messages: history,
    state: stateAfterFold,
    config,
    tokenCount: N * 60,
  });
  const h7 = history[7]!;
  const dup: CoreMessage = {
    id: h7.id,
    role: h7.role,
    contentType: "text",
    text: h7.text,
  };
  const result = core.processTurn({
    messages: [
      msg(
        SUMMARY_ID,
        "[Compressed conversation section]\nSummary body…",
        "system",
      ),
      history[0]!,
      ...history.slice(15),
      dup,
    ],
    state: s1.state,
    config,
    tokenCount: 28 * 60,
  });
  assert.equal(result.messages[0]?.id, SUMMARY_ID);
  const reminted = result.messages.find((m) => m.id === `${h7.id}_1`);
  assert.ok(reminted, "new duplicate must be re-minted to a distinct id");
  assert.ok(result.state.messageRefs.byRaw[`${h7.id}_1`]);
  assert.ok(!result.messages.some((m) => m.id === h7.id));
});

test("full-history resend + compress tool pair: pair survives alongside injected summary (#461)", () => {
  const { core, config, history, stateAfterFold } = setupFolded();
  const pair: CoreMessage[] = [
    {
      id: "h_cccccccccccccccc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call_c1",
      text: JSON.stringify({
        startRef: "m00016",
        endRef: "m00020",
        summary: "more content here",
      }),
    },
    {
      id: "h_dddddddddddddddd",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "call_c1",
      text: "compressed ok",
    },
  ];
  const result = core.processTurn({
    messages: [...history, ...pair],
    state: stateAfterFold,
    config,
    tokenCount: (N + 2) * 60,
  });
  assert.ok(result.messages.some((m) => m.id === SUMMARY_ID));
  assert.ok(
    result.messages.some(
      (m) => m.toolCallId === "call_c1" && m.contentType === "tool-call",
    ),
  );
  assert.ok(
    result.messages.some(
      (m) => m.toolCallId === "call_c1" && m.contentType === "tool-result",
    ),
  );
  const coveredAlive = history
    .slice(0, 15)
    .filter((m) => result.messages.some((o) => o.id === m.id));
  assert.ok(
    coveredAlive.length <= 1 &&
      coveredAlive.every((m) => m.id === history[0]!.id),
  );
});
