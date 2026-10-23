import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCore,
  createInitialState,
  defaultConfig,
  defaultCountTokens,
  type CoreMessage,
} from "../src/index.js";
import { findOffBranchBlocks } from "../src/branch-awareness.js";

// Branch-aware masking (ProcessTurnInput.persistedMessageIds): after a
// rewind into a block's range (pi `/tree`), the block's summary — which
// describes messages now on another branch — must not stand in for the few
// messages still in view.

const L = 200_000;
const FUTURE =
  "FUTURE-DECISION: switch to SiUD412ED (made after the rewind point)";
const filler = (tag: string) =>
  `${tag} ` + "lorem ipsum dolor sit amet ".repeat(60);

function u(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text } as CoreMessage;
}
function a(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "text", text } as CoreMessage;
}

/** Compress e1..e4 into one block whose summary leaks a "future" decision. */
function compressedState() {
  const core = createCore({ countTokens: defaultCountTokens });
  const config = defaultConfig(L);
  const full = [
    u("e1", filler("q1")),
    a("e2", filler("a1")),
    u("e3", filler("q2")),
    a("e4", filler("a2")),
    u("e5", "tail-1"),
    a("e6", "tail-2"),
    u("e7", "tail-3"),
    a("e8", "tail-4"),
    u("e9", "tail-5"),
    a("e10", "tail-6"),
  ];
  const turn = core.processTurn({
    messages: full,
    state: createInitialState(),
    config,
    tokenCount: 5_000,
  });
  const ref = (id: string) => turn.state.messageRefs.byRaw[id]!;
  const applied = core.applyCompression({
    ranges: [
      {
        startRef: ref("e1"),
        endRef: ref("e4"),
        summary: `Block summary. ${FUTURE}. Padding to clear the minimum summary length.`,
      },
    ],
    messages: turn.messages,
    state: turn.state,
    config,
    protectedMessageIds: new Set(),
  });
  assert.equal(
    applied.result.blocksCreated,
    1,
    JSON.stringify(applied.result.errors),
  );
  return {
    core,
    config,
    state: applied.state,
    allIds: new Set(full.map((m) => m.id)),
  };
}

const textOf = (messages: CoreMessage[]) =>
  messages.map((m) => String((m as { text?: unknown }).text ?? "")).join("\n");

test("a block partly on another branch is masked; its in-view messages show raw", () => {
  const { core, config, state, allIds } = compressedState();
  // Rewound to e2: e3/e4 (and the tail) are persisted but on another branch.
  const view = [
    u("e1", filler("q1")),
    a("e2", filler("a1")),
    u("e11", "new question on the new branch"),
  ];
  assert.deepEqual(findOffBranchBlocks(view, state, allIds), [
    state.blocks[0]!.blockId,
  ]);

  // Opt-out host (field omitted): the summary (with the future decision)
  // replaces e1/e2 — unchanged baseline behaviour.
  const plain = core.processTurn({
    messages: view,
    state,
    config,
    tokenCount: 5_000,
  });
  assert.match(
    textOf(plain.messages),
    /FUTURE-DECISION/,
    "baseline: kernel leaks the future summary",
  );

  // Opt-in host: the block is masked for the turn; e1/e2 show raw.
  const guarded = core.processTurn({
    messages: view,
    state,
    config,
    tokenCount: 5_000,
    persistedMessageIds: allIds,
  });
  const text = textOf(guarded.messages);
  assert.doesNotMatch(text, /FUTURE-DECISION/);
  assert.match(text, /^q1 lorem/m, "e1 is shown raw");
  assert.equal(guarded.state.blocks[0]!.active, false);
  assert.equal(
    guarded.state.blocks[0]!.expanded,
    undefined,
    "the mask is not persisted",
  );
  // The input state was not mutated by the masking.
  assert.equal(state.blocks[0]!.expanded, undefined);
});

test("back on the full branch the block stays active", () => {
  const { core, config, state, allIds } = compressedState();
  const full = [
    u("e1", ""),
    a("e2", ""),
    u("e3", ""),
    a("e4", ""),
    u("e5", "tail-1"),
  ];
  assert.deepEqual(findOffBranchBlocks(full, state, allIds), []);
  const turn = core.processTurn({
    messages: full,
    state,
    config,
    tokenCount: 5_000,
    persistedMessageIds: allIds,
  });
  assert.equal(turn.state.blocks[0]!.active, true);
});

test("ids missing but never persisted keep the kernel's default behaviour", () => {
  const { core, config, state } = compressedState();
  // e3/e4 absent from the view but unknown to the persisted set: that is a
  // live-id situation, not a branch rewind — the summary stays in charge.
  const view = [u("e1", ""), a("e2", "")];
  const turn = core.processTurn({
    messages: view,
    state,
    config,
    tokenCount: 5_000,
    persistedMessageIds: new Set(["e1", "e2"]),
  });
  assert.match(textOf(turn.messages), /FUTURE-DECISION/);
});

test("live-instance subids share the base id for both view and persisted matching", () => {
  const { state } = compressedState();
  const view = [
    u("e1#l1", filler("q1")),
    a("e2#l1", filler("a1")),
    u("e11", "new"),
  ];
  assert.deepEqual(
    findOffBranchBlocks(view, state, new Set(["e1", "e2", "e3", "e4"])),
    [state.blocks[0]!.blockId],
  );
});
