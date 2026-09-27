import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { remintCoveredLiveIds } from "../src/instance-reid.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

const HASH = "h_0123456789abcdef";
const EARLY = "h_aaaaaaaaaaaaaaaa";

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
  state.lastPassIds = [];
  const out = remintCoveredLiveIds([msg(HASH, "都按推荐来")], state);
  assert.equal(out[0].id, `${HASH}_1`);
});

test("leaves numbering untouched when the base is not folded (incident 3)", () => {
  const state = createInitialState();
  state.lastPassIds = [];
  const msgs = [msg(HASH, "x"), msg(`${HASH}_1`, "x")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.deepEqual(
    out.map((m) => m.id),
    [HASH, `${HASH}_1`],
  );
  assert.equal(out, msgs);
});

test("renumbers every live instance of a conflicting root", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  state.lastPassIds = [];
  const out = remintCoveredLiveIds(
    [msg(HASH, "a"), msg(`${HASH}_1`, "b")],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [`${HASH}_1`, `${HASH}_2`],
  );
});

test("skips instance numbers already claimed by folded copies", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH, `${HASH}_1`]));
  state.lastPassIds = [];
  const out = remintCoveredLiveIds([msg(HASH, "a")], state);
  assert.equal(out[0].id, `${HASH}_2`);
});

test("preserves the sub-id projection tail", () => {
  const state = createInitialState();
  state.blocks.push(folded([`${HASH}#sub`]));
  state.lastPassIds = [];
  const out = remintCoveredLiveIds([msg(`${HASH}#sub`, "a")], state);
  assert.equal(out[0].id, `${HASH}_1#sub`);
});

test("ignores non-content-hash ids", () => {
  const state = createInitialState();
  state.blocks.push(folded(["acp_summary_b9"]));
  state.lastPassIds = [];
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
  state.lastPassIds = [];
  const a = remintCoveredLiveIds([msg(HASH, "x")], state).map((m) => m.id);
  const b = remintCoveredLiveIds([msg(HASH, "x")], state).map((m) => m.id);
  assert.deepEqual(a, b);
});

test("skips re-minting entirely when lastPassIds is absent (pre-feature state, #462)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  const msgs = [msg(HASH, "都按推荐来")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out[0].id, HASH);
  assert.equal(out, msgs);
});

test("leaves an echo of a folded original untouched (#462)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  state.lastPassIds = [HASH];
  const msgs = [msg(HASH, "都按推荐来")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.equal(out[0].id, HASH);
  assert.equal(out, msgs);
});

test("renumbers only the new instances in a mixed echo+new group (#462)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  // Previous pass inbound carried the bare echo; this pass adds a second
  // identical occurrence, which the converter numbers _1.
  state.lastPassIds = [HASH];
  const out = remintCoveredLiveIds(
    [msg(HASH, "echo"), msg(`${HASH}_1`, "new")],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [HASH, `${HASH}_1`],
  );
});

test("renumbering skips numbers claimed by folded copies AND kept echoes (#462)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH, `${HASH}_1`]));
  state.lastPassIds = [HASH];
  const out = remintCoveredLiveIds(
    [msg(HASH, "echo"), msg(`${HASH}_1`, "new")],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [HASH, `${HASH}_2`],
  );
});

test("fresh later user turn survives prune with a distinct id + ref (#1476 e2e)", () => {
  const core = createCore();
  const state = createInitialState();
  // Earlier "都按推荐来" was ref'd (m00001) then folded into b1 (off the wire).
  state.messageRefs.byRaw[HASH] = "m00001";
  state.messageRefs.byRef["m00001"] = HASH;
  state.blocks.push(folded([HASH]));
  // Previous pass inbound: the host sent its pruned view (echo absent), so the
  // bare id re-derived now is a genuinely NEW instance.
  state.lastPassIds = [EARLY, "acp_summary_b1"];
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
  assert.deepEqual(
    result.state.lastPassIds,
    input.map((m) => m.id),
    "this pass's inbound ids become the next pass's echo discriminator",
  );
});

test("post-fold resends stay pruned under stable refs — no wire re-inflation (#462 e2e)", () => {
  const core = createCore();
  const F1 = "h_cccccccccccccccc";
  const F2 = "h_dddddddddddddddd";
  const FRESH = "h_eeeeeeeeeeeeeeee";
  // Pass 1: raw history before any fold.
  const pass1 = [
    msg(EARLY, "帮我看看这段代码"),
    msg(HASH, "都按推荐来"),
    msg(F1, "第一条折叠消息", "assistant"),
    msg(F2, "第二条折叠消息", "assistant"),
  ];
  const r1 = core.processTurn({
    messages: pass1,
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  assert.deepEqual(
    r1.state.lastPassIds,
    pass1.map((m) => m.id),
  );
  const refEarly = r1.state.messageRefs.byRaw[EARLY]!;
  const refHash = r1.state.messageRefs.byRaw[HASH]!;
  const refF1 = r1.state.messageRefs.byRaw[F1]!;
  const refF2 = r1.state.messageRefs.byRaw[F2]!;

  // Fold [HASH, F1, F2] into b1 (off the wire, replaced by a summary).
  r1.state.blocks.push(folded([HASH, F1, F2]));

  // Pass 2: a stateless host RESENDS the full raw history — including the
  // folded originals — plus the rendered summary and one fresh turn.
  const pass2 = [
    msg(EARLY, "帮我看看这段代码"),
    msg(HASH, "都按推荐来"),
    msg(F1, "第一条折叠消息", "assistant"),
    msg(F2, "第二条折叠消息", "assistant"),
    msg("acp_summary_b1", "[Compressed conversation section] …", "system"),
    msg(FRESH, "新的一条"),
  ];
  const r2 = core.processTurn({
    messages: pass2,
    state: r1.state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  const wire2 = r2.messages.map((m) => m.id);
  // The echoed folded originals stay bare and get PRUNED — they do not
  // rejoin the wire alongside their summary.
  for (const id of [HASH, F1, F2]) {
    assert.ok(!wire2.includes(id), `folded echo ${id} must stay pruned`);
  }
  assert.ok(wire2.includes("acp_summary_b1"), "summary stays on the wire");
  assert.ok(wire2.includes(FRESH), "fresh turn survives");
  assert.ok(!wire2.some((id) => id.startsWith(`${HASH}_`)), "no _n re-mints");
  // Refs did NOT churn: echoes keep their original refs, no fresh ref minted.
  assert.equal(r2.state.messageRefs.byRaw[EARLY], refEarly);
  assert.equal(r2.state.messageRefs.byRaw[HASH], refHash);
  assert.equal(r2.state.messageRefs.byRaw[F1], refF1);
  assert.equal(r2.state.messageRefs.byRaw[F2], refF2);

  // Pass 3: identical resend → byte-stable wire view (the re-inflation loop is gone).
  const r3 = core.processTurn({
    messages: pass2,
    state: r2.state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  assert.deepEqual(
    r3.messages.map((m) => m.id),
    wire2,
  );
  assert.equal(r3.state.messageRefs.byRaw[HASH], refHash);
});
