import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { remintCoveredLiveIds } from "../src/instance-reid.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

const HASH = "h_0123456789abcdef";
const EARLY = "h_aaaaaaaaaaaaaaaa";
const SUMMARY_ID = "acp_summary_b1";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function folded(ids: string[]): CompressionBlock {
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
  };
}

test("re-mints a live message whose id collides with a folded copy (#1476)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  // Pruned-view shape: the rendered summary is in the pass, so the block is
  // not positionally replaying and the colliding occurrence is a new instance.
  const out = remintCoveredLiveIds(
    [
      msg(SUMMARY_ID, "[Compressed conversation section] …", "system"),
      msg(HASH, "都按推荐来"),
    ],
    state,
  );
  assert.equal(out[1].id, `${HASH}_1`);
});

test("leaves numbering untouched when the base is not folded (incident 3)", () => {
  const state = createInitialState();
  const msgs = [msg(HASH, "x"), msg(`${HASH}_1`, "x")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.deepEqual(
    out.map((m) => m.id),
    [HASH, `${HASH}_1`],
  );
  assert.equal(out, msgs);
});

test("re-mints conflicting instances only when the block is not replaying (#461)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  // Pruned-view shape (summary present): the bare-id occurrence is a new
  // instance; the non-conflicting `_1` member keeps its own id (no ref churn).
  const out = remintCoveredLiveIds(
    [
      msg(SUMMARY_ID, "[Compressed conversation section] …", "system"),
      msg(HASH, "a"),
      msg(`${HASH}_1`, "b"),
    ],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [SUMMARY_ID, `${HASH}_2`, `${HASH}_1`],
  );
});

test("keeps original ids when the host positionally replays the folded population (#461)", () => {
  const state = createInitialState();
  state.blocks.push(folded([EARLY, HASH]));
  const msgs = [msg(EARLY, "a"), msg(HASH, "b")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out, msgs);
});

test("skips instance numbers already claimed by folded copies", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH, `${HASH}_1`]));
  const out = remintCoveredLiveIds([msg(HASH, "a")], state);
  assert.equal(out[0].id, `${HASH}_2`);
});

test("preserves the sub-id projection tail", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  // Pruned-view shape: summary present ⇒ not positionally replaying (#461).
  const out = remintCoveredLiveIds(
    [
      msg(SUMMARY_ID, "[Compressed conversation section] …", "system"),
      msg(`${HASH}#sub`, "a"),
    ],
    state,
  );
  assert.equal(out[1].id, `${HASH}_1#sub`);
});

test("ignores non-content-hash ids", () => {
  const state = createInitialState();
  state.blocks.push(folded(["acp_summary_b9"]));
  const out = remintCoveredLiveIds(
    [msg("acp_summary_b9", "x"), msg("host-123", "y")],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["acp_summary_b9", "host-123"],
  );
});

test("is deterministic for a fixed (state, body)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  const a = remintCoveredLiveIds([msg(HASH, "x")], state).map((m) => m.id);
  const b = remintCoveredLiveIds([msg(HASH, "x")], state).map((m) => m.id);
  assert.deepEqual(a, b);
});

test("fresh later user turn survives prune with a distinct id + ref (#1476 e2e)", () => {
  const core = createCore();
  const state = createInitialState();
  // Earlier "都按推荐来" was ref'd (m00001) then folded into b1 (off the wire).
  state.messageRefs.byRaw[HASH] = "m00001";
  state.messageRefs.byRef["m00001"] = HASH;
  state.blocks.push(folded([HASH]));
  // Re-sent history: an earlier user turn (firstUserIndex), the rendered summary,
  // then the fresh resend whose bare id collides with the folded original.
  const input = [
    msg(EARLY, "帮我看看这段代码"),
    msg("acp_summary_b1", "[Compressed conversation section] …", "system"),
    msg(HASH, "都按推荐来"),
  ];
  const result = core.processTurn({
    messages: input,
    state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  const fresh = result.messages.find((m) => m.id === `${HASH}_1`);
  assert.ok(fresh, "fresh user turn must survive prune under a distinct id");
  assert.match(fresh!.text ?? "", /都按推荐来/);
  assert.ok(
    result.state.messageRefs.byRaw[`${HASH}_1`],
    "re-minted id gets a ref",
  );
  assert.ok(
    !result.messages.some((m) => m.id === HASH),
    "folded bare id must not be re-issued",
  );
});
