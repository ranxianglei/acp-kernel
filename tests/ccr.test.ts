import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createContentStore,
  hashContent,
  storeOriginal,
  retrieveByRef,
  hasStoredRef,
  contentStoreStats,
} from "../src/content-store.js";
import {
  DEFAULT_CCR_CONFIG,
  resolveCcrConfig,
  STORED_PLACEHOLDER_MARKER,
  RETRIEVED_ID_PREFIX,
  classifyKind,
  normalizeHead,
  extractCommand,
  buildStoredPlaceholder,
  isStoredPlaceholderText,
  retrievedMessageId,
  isRetrievedMessage,
  buildRetrievalInjection,
  applyRetrieve,
  storeLargeResults,
  storeCoveredOriginals,
  noteRetrieval,
} from "../src/ccr.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { assignRefs, refForRaw } from "../src/refs.js";
import { isAbsorbCandidate } from "../src/absorb.js";
import { DEFAULT_ABSORB_CONFIG } from "../src/absorb.js";
import {
  RETRIEVE_TOOL_NAME,
  RETRIEVE_TOOL,
  RETRIEVE_TOOL_OPENAI,
  RETRIEVE_TOOL_RESPONSES,
  ACP_TOOLS_OPENAI,
  ACP_TOOL_NAMES,
} from "../src/compress-tools.js";
import type { Config, CoreMessage } from "../src/types.js";

const countTokens = (text: string) => Math.ceil(text.length / 4);

function bigText(): string {
  return "line of output ".repeat(2000);
}

function toolCall(id: string, callId: string, toolName = "bash"): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: JSON.stringify({ command: `run ${callId}` }),
  };
}

function toolResult(
  id: string,
  callId: string,
  toolName = "bash",
  text = bigText(),
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId: callId,
    text,
  };
}

function ccrConfig(overrides: Partial<Config["ccr"]> = {}): Config {
  return defaultConfig(100000, {
    ccr: { ...DEFAULT_CCR_CONFIG, enabled: true, ...overrides },
  });
}

test("createContentStore yields an empty v1 store", () => {
  const store = createContentStore();
  assert.deepEqual(store, { version: 1, byHash: {}, byRef: {} });
});

test("storeOriginal + retrieveByRef round-trip", () => {
  let store = createContentStore();
  const text = "hello world";
  store = storeOriginal(store, {
    ref: "m00042",
    rawId: "h_raw1",
    text,
    kind: "shell output",
    toolName: "bash",
    tokens: 3,
    head: "hello world",
  });
  assert.ok(hasStoredRef(store, "m00042"));
  const found = retrieveByRef(store, "m00042");
  assert.ok(found.ok);
  if (found.ok) {
    assert.equal(found.text, text);
    assert.equal(found.entry.rawId, "h_raw1");
    assert.equal(found.entry.kind, "shell output");
    assert.equal(found.entry.toolName, "bash");
    assert.equal(found.entry.tokens, 3);
    assert.equal(found.entry.chars, text.length);
  }
});

test("store dedups identical content across refs (content-addressed)", () => {
  let store = createContentStore();
  const text = "same bytes twice";
  store = storeOriginal(store, {
    ref: "m00001",
    rawId: "a",
    text,
    kind: "k",
    tokens: 1,
    head: "",
  });
  store = storeOriginal(store, {
    ref: "m00002",
    rawId: "b",
    text,
    kind: "k",
    tokens: 1,
    head: "",
  });
  assert.equal(Object.keys(store.byHash).length, 1);
  assert.equal(Object.keys(store.byRef).length, 2);
  assert.deepEqual(contentStoreStats(store), {
    entries: 2,
    uniqueContents: 1,
    totalChars: text.length,
  });
});

test("store is append-only per ref: first write wins", () => {
  let store = createContentStore();
  store = storeOriginal(store, {
    ref: "m00001",
    rawId: "a",
    text: "original",
    kind: "k",
    tokens: 1,
    head: "",
  });
  store = storeOriginal(store, {
    ref: "m00001",
    rawId: "b",
    text: "MUTATED",
    kind: "k2",
    tokens: 9,
    head: "",
  });
  const found = retrieveByRef(store, "m00001");
  assert.ok(found.ok);
  if (found.ok) {
    assert.equal(found.text, "original");
    assert.equal(found.entry.rawId, "a");
  }
});

test("retrieveByRef returns not-found for unknown and empty refs", () => {
  const store = createContentStore();
  assert.deepEqual(retrieveByRef(store, "m99999"), {
    ok: false,
    reason: "not-found",
  });
  assert.deepEqual(retrieveByRef(store, ""), {
    ok: false,
    reason: "not-found",
  });
});

test("hashContent is deterministic sha256 hex", () => {
  assert.equal(hashContent("abc"), hashContent("abc"));
  assert.notEqual(hashContent("abc"), hashContent("abd"));
  assert.match(hashContent("abc"), /^[0-9a-f]{64}$/);
});

test("buildStoredPlaceholder matches the deterministic wire shape", () => {
  const placeholder = buildStoredPlaceholder({
    ref: "m00423",
    kind: "shell output",
    tokens: 4213,
    head: "some preview",
    command: "npm run build",
    retrieveToolName: "acp_retrieve",
  });
  assert.equal(
    placeholder,
    `📦 ${STORED_PLACEHOLDER_MARKER} #m00423 · shell output · 4,213 tok] \`npm run build\`\n   → acp_retrieve("m00423") returns the full text`,
  );
});

test("buildStoredPlaceholder falls back to head when no command; byte-stable", () => {
  const input = {
    ref: "m00007",
    kind: "file read",
    tokens: 5000,
    head: "head preview here",
    retrieveToolName: "acp_retrieve",
  };
  const first = buildStoredPlaceholder(input);
  const second = buildStoredPlaceholder({ ...input });
  assert.equal(first, second);
  assert.ok(first.includes("`head preview here`"));
  assert.ok(isStoredPlaceholderText(first));
});

test("classifyKind maps common tools and defaults to 'tool result'", () => {
  assert.equal(classifyKind("bash"), "shell output");
  assert.equal(classifyKind("Bash"), "shell output");
  assert.equal(classifyKind("read"), "file read");
  assert.equal(classifyKind("grep"), "search output");
  assert.equal(classifyKind("webfetch"), "web fetch");
  assert.equal(classifyKind("some_unknown_tool"), "tool result");
  assert.equal(classifyKind(undefined), "tool result");
});

test("normalizeHead collapses whitespace and truncates deterministically", () => {
  assert.equal(normalizeHead("  a\n\n b \t c ", 96), "a b c");
  const long = "w".repeat(200);
  const head = normalizeHead(long, 10);
  assert.equal(head, "wwwwwwwwww…");
  assert.equal(normalizeHead("", 10), "");
});

test("extractCommand pulls known fields from args JSON; undefined otherwise", () => {
  assert.equal(
    extractCommand(JSON.stringify({ command: "ls -la /tmp" }), 96),
    "ls -la /tmp",
  );
  assert.equal(
    extractCommand(JSON.stringify({ path: "/etc/hosts" }), 96),
    "/etc/hosts",
  );
  assert.equal(
    extractCommand(JSON.stringify({ url: "https://example.com/a b" }), 96),
    "https://example.com/a b",
  );
  assert.equal(extractCommand("not json {", 96), undefined);
  assert.equal(extractCommand(JSON.stringify({ other: 1 }), 96), undefined);
  assert.equal(extractCommand(undefined, 96), undefined);
  const longCmd = "x".repeat(200);
  assert.equal(
    extractCommand(JSON.stringify({ command: longCmd }), 10),
    "xxxxxxxxxx…",
  );
});

function refsFor(messages: CoreMessage[]) {
  const refResult = assignRefs(messages, { existing: {}, nextIndex: 1 });
  return refResult.map;
}

test("storeLargeResults: disabled config leaves everything untouched", () => {
  const messages = [toolCall("c1", "call1"), toolResult("r1", "call1")];
  const map = refsFor(messages);
  const state = { ...createInitialState(), messageRefs: map };
  const config = defaultConfig(100000);
  const result = storeLargeResults({
    messages,
    state,
    store: createContentStore(),
    config,
    countTokens,
  });
  assert.equal(result.storedCount, 0);
  assert.equal(result.messages[1]!.text, bigText());
});

test("storeLargeResults: below-threshold results are untouched", () => {
  const small = "short output";
  const messages = [
    toolCall("c1", "call1"),
    toolResult("r1", "call1", "bash", small),
  ];
  const state = { ...createInitialState(), messageRefs: refsFor(messages) };
  const result = storeLargeResults({
    messages,
    state,
    store: createContentStore(),
    config: ccrConfig(),
    countTokens,
  });
  assert.equal(result.storedCount, 0);
  assert.equal(result.messages[1]!.text, small);
});

test("storeLargeResults: over-threshold result is stored + replaced once", () => {
  const original = bigText();
  const messages = [
    toolCall("c1", "call1"),
    toolResult("r1", "call1", "bash", original),
  ];
  const state = { ...createInitialState(), messageRefs: refsFor(messages) };
  const result = storeLargeResults({
    messages,
    state,
    store: createContentStore(),
    config: ccrConfig(),
    countTokens,
  });
  assert.equal(result.storedCount, 1);
  const replaced = result.messages[1]!.text ?? "";
  assert.ok(isStoredPlaceholderText(replaced));
  assert.ok(replaced.includes("#m00002"));
  assert.ok(replaced.includes("· shell output ·"));
  assert.ok(replaced.includes('acp_retrieve("m00002")'));
  assert.ok(replaced.includes("`run call1`"));
  assert.equal(result.messages[1]!.id, "r1");
  assert.equal(result.messages[1]!.toolCallId, "call1");
  assert.equal(
    result.messages[0]!.text,
    JSON.stringify({ command: "run call1" }),
  );
  const found = retrieveByRef(result.store, "m00002");
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.text, original);
});

test("storeLargeResults: idempotent on already-replaced text", () => {
  const messages = [
    toolCall("c1", "call1"),
    toolResult("r1", "call1", "bash", bigText()),
  ];
  const state = { ...createInitialState(), messageRefs: refsFor(messages) };
  const first = storeLargeResults({
    messages,
    state,
    store: createContentStore(),
    config: ccrConfig(),
    countTokens,
  });
  const second = storeLargeResults({
    messages: first.messages,
    state,
    store: first.store,
    config: ccrConfig(),
    countTokens,
  });
  assert.equal(second.storedCount, 0);
  assert.deepEqual(second.messages, first.messages);
  assert.deepEqual(second.store, first.store);
});

test("storeLargeResults: ACP tools, own retrieve tool, excludeTools, protected tools are skipped", () => {
  const mk = (id: string, name: string) => [
    toolCall(`c-${id}`, `call-${id}`, name),
    toolResult(`r-${id}`, `call-${id}`, name),
  ];
  const all = [
    ...mk("compress", "compress"),
    ...mk("retrieve", "acp_retrieve"),
    ...mk("excluded", "secret_tool"),
    ...mk("protected", "vault_tool"),
  ];
  const state = { ...createInitialState(), messageRefs: refsFor(all) };
  const config = ccrConfig({
    excludeTools: ["secret_*", "vault_*"],
  });
  const withProtected = defaultConfig(100000, {
    ccr: {
      ...DEFAULT_CCR_CONFIG,
      enabled: true,
      excludeTools: ["secret_*", "vault_*"],
    },
    protectedTools: ["vault_tool"],
  });
  for (const cfg of [config, withProtected]) {
    const result = storeLargeResults({
      messages: all,
      state,
      store: createContentStore(),
      config: cfg as Config,
      countTokens,
    });
    assert.equal(
      result.storedCount,
      0,
      `expected zero stored for ${JSON.stringify(cfg.protectedTools)}`,
    );
  }
});

test("storeLargeResults: results without toolCallId or with BLOCKED refs are skipped", () => {
  const orphan = { ...toolResult("r1", "", "bash"), toolCallId: undefined };
  const blockedMessages = [toolResult("r2", "call2", "bash")];
  const blockedState = {
    ...createInitialState(),
    messageRefs: { byRaw: { r2: "BLOCKED" }, byRef: { BLOCKED: "r2" } },
  };
  const base = {
    store: createContentStore(),
    config: ccrConfig(),
    countTokens,
  };
  const r1 = storeLargeResults({
    messages: [orphan],
    state: { ...createInitialState(), messageRefs: refsFor([orphan]) },
    ...base,
  });
  assert.equal(r1.storedCount, 0);
  const r2 = storeLargeResults({
    messages: blockedMessages,
    state: blockedState,
    ...base,
  });
  assert.equal(r2.storedCount, 0);
});

function sessionWithBigBash(): CoreMessage[] {
  return [
    { id: "u1", role: "user", contentType: "text", text: "build the project" },
    {
      id: "a1",
      role: "assistant",
      contentType: "text",
      text: "running the build now",
    },
    toolCall("c1", "call1", "bash"),
    toolResult("r1", "call1", "bash", bigText()),
  ];
}

test("processTurn without CCR: empty store echoed back, messages unchanged", () => {
  const core = createCore({ countTokens });
  const messages = sessionWithBigBash();
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 1000,
    renderTags: "none",
  });
  assert.deepEqual(result.contentStore, { version: 1, byHash: {}, byRef: {} });
  assert.equal(result.messages[3]!.text, bigText());
  assert.equal(result.state.stats.storedCount, 0);
});

test("processTurn with CCR: stores at arrival, replaces with placeholder, bumps stats", () => {
  const core = createCore({ countTokens });
  const original = bigText();
  const result = core.processTurn({
    messages: sessionWithBigBash(),
    state: createInitialState(),
    config: ccrConfig(),
    tokenCount: 1000,
  });
  assert.equal(result.state.stats.storedCount, 1);
  const replaced = result.messages[3]!.text ?? "";
  assert.ok(isStoredPlaceholderText(replaced));
  assert.ok(replaced.includes("#m00004"));
  const found = retrieveByRef(result.contentStore, "m00004");
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.text, original);
});

test("processTurn is byte-stable across turns after replacement", () => {
  const core = createCore({ countTokens });
  const turn1 = core.processTurn({
    messages: sessionWithBigBash(),
    state: createInitialState(),
    config: ccrConfig(),
    tokenCount: 1000,
  });
  const placeholderTurn1 = turn1.messages[3]!.text!;
  const followUp: CoreMessage = {
    id: "u2",
    role: "user",
    contentType: "text",
    text: "did it work?",
  };
  const turn2 = core.processTurn({
    messages: [...turn1.messages, followUp],
    state: turn1.state,
    config: ccrConfig(),
    tokenCount: 1200,
    contentStore: turn1.contentStore,
  });
  assert.equal(turn2.messages[3]!.text, placeholderTurn1);
  assert.equal(turn2.state.stats.storedCount, 1);
  assert.deepEqual(turn2.contentStore, turn1.contentStore);
});

test("core.retrieve resolves originals; hallucinated refs are not-found", () => {
  const core = createCore({ countTokens });
  const turn = core.processTurn({
    messages: sessionWithBigBash(),
    state: createInitialState(),
    config: ccrConfig(),
    tokenCount: 1000,
  });
  const hit = core.retrieve(turn.contentStore, "m00004");
  assert.ok(hit.ok);
  if (hit.ok) {
    assert.equal(hit.text, bigText());
    assert.equal(hit.injection.id, retrievedMessageId("m00004"));
    assert.equal(hit.injection.role, "system");
    assert.ok(hit.injection.text!.startsWith("[acp-retrieved #m00004"));
    assert.ok(hit.injection.text!.endsWith(bigText()));
    assert.ok(hit.ackText.includes("m00004"));
  }
  const miss = core.retrieve(turn.contentStore, "m99999");
  assert.equal(miss.ok, false);
  if (!miss.ok) {
    assert.equal(miss.reason, "not-found");
    assert.ok(miss.ackText.includes("not found"));
  }
});

test("retrieved refs survive host-side ref-map pruning (archive resilience)", () => {
  const core = createCore({ countTokens });
  const turn = core.processTurn({
    messages: sessionWithBigBash(),
    state: createInitialState(),
    config: ccrConfig(),
    tokenCount: 1000,
  });
  assert.equal(refForRaw(turn.state.messageRefs, "r1"), "m00004");
  const pruned = { ...turn.state, messageRefs: { byRaw: {}, byRef: {} } };
  assert.equal(refForRaw(pruned.messageRefs, "r1"), null);
  const found = core.retrieve(turn.contentStore, "m00004");
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.text, bigText());
});

test("ephemeral retrieval injections consume no ref and survive the pipeline", () => {
  const core = createCore({ countTokens });
  const injection = buildRetrievalInjection(
    "m00004",
    {
      hash: "h",
      rawId: "r1",
      kind: "shell output",
      tokens: 5000,
      chars: 20000,
      head: "",
    },
    "FULL TEXT HERE",
  );
  assert.ok(isRetrievedMessage(injection.injection));
  assert.equal(injection.injection.id, `${RETRIEVED_ID_PREFIX}m00004`);
  assert.ok(
    !isRetrievedMessage({
      id: "x",
      role: "system",
      contentType: "text",
      text: "y",
    }),
  );

  const roundTripped: CoreMessage[] = [
    ...sessionWithBigBash().slice(0, 3),
    injection.injection,
    { id: "u2", role: "user", contentType: "text", text: "next question" },
  ];
  const result = core.processTurn({
    messages: roundTripped,
    state: createInitialState(),
    config: ccrConfig(),
    tokenCount: 1000,
  });
  assert.equal(
    refForRaw(result.state.messageRefs, injection.injection.id),
    null,
  );
  const survived = result.messages.find((m) => m.id === injection.injection.id);
  assert.ok(survived, "retrieval injection must survive processTurn");
});

test("retrieval injections never enter fold space (block effectiveMessageIds exclusion)", () => {
  const core = createCore({ countTokens });
  const injection = buildRetrievalInjection(
    "m00004",
    {
      hash: "h",
      rawId: "r1",
      kind: "shell output",
      tokens: 5000,
      chars: 20000,
      head: "",
    },
    "FULL TEXT HERE",
  ).injection;
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "start" },
    { id: "a1", role: "assistant", contentType: "text", text: "working on it" },
    injection,
    { id: "u2", role: "user", contentType: "text", text: "continue please" },
    {
      id: "a2",
      role: "assistant",
      contentType: "text",
      text: "done with the work here",
    },
    {
      id: "u3",
      role: "user",
      contentType: "text",
      text: "final question to keep tail recent",
    },
    {
      id: "a3",
      role: "assistant",
      contentType: "text",
      text: "final answer to the final question",
    },
  ];
  const seeded = core.processTurn({
    messages,
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 1000,
  });
  const compressed = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00005", summary: "S".repeat(60) }],
    messages: seeded.messages,
    state: seeded.state,
    config: defaultConfig(100000, {
      compress: { minCompressRange: 0 },
      preserveRecentMessages: 1,
      preserveRecentTokens: 0,
    }),
  });
  assert.equal(compressed.result.blocksCreated, 1);
  const block = compressed.state.blocks.find((b) => b.active)!;
  assert.ok(block.effectiveMessageIds.includes("u1"));
  assert.ok(!block.effectiveMessageIds.includes(injection.id));
});

test("placeholder-marked results are not absorb candidates (ID-reference priority)", () => {
  const placeholder = buildStoredPlaceholder({
    ref: "m00004",
    kind: "shell output",
    tokens: 5000,
    head: "preview",
    retrieveToolName: "acp_retrieve",
  });
  const msg: CoreMessage = {
    id: "r1",
    role: "tool",
    contentType: "tool-result",
    toolName: "bash",
    toolCallId: "call1",
    text: placeholder,
  };
  const config = defaultConfig(100000, {
    absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true },
  });
  assert.equal(isAbsorbCandidate(msg, config), false);
  const plain: CoreMessage = { ...msg, text: bigText() };
  assert.equal(isAbsorbCandidate(plain, config), true);
});

test("noteRetrieval increments stats.retrievalCount; status reports both metrics", () => {
  const core = createCore({ countTokens });
  const turn = core.processTurn({
    messages: sessionWithBigBash(),
    state: createInitialState(),
    config: ccrConfig(),
    tokenCount: 1000,
  });
  const bumped = noteRetrieval(noteRetrieval(turn.state));
  const report = core.status(bumped, 1000, ccrConfig());
  assert.equal(report.breakdown.storedMessages, 1);
  assert.equal(report.breakdown.retrievals, 2);
});

test("storeCoveredOriginals stores folded message originals for retrieve-by-ref", () => {
  const core = createCore({ countTokens });
  const messages: CoreMessage[] = [
    {
      id: "u1",
      role: "user",
      contentType: "text",
      text: "first user message here",
    },
    {
      id: "a1",
      role: "assistant",
      contentType: "text",
      text: "first assistant reply here",
    },
    {
      id: "u2",
      role: "user",
      contentType: "text",
      text: "second user message here",
    },
    {
      id: "a2",
      role: "assistant",
      contentType: "text",
      text: "second assistant reply here",
    },
    {
      id: "u3",
      role: "user",
      contentType: "text",
      text: "recent tail user message",
    },
    {
      id: "a3",
      role: "assistant",
      contentType: "text",
      text: "recent tail assistant reply",
    },
  ];
  const seeded = core.processTurn({
    messages,
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 1000,
  });
  const compressed = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "S".repeat(60) }],
    messages: seeded.messages,
    state: seeded.state,
    config: defaultConfig(100000, {
      compress: { minCompressRange: 0 },
      preserveRecentMessages: 1,
      preserveRecentTokens: 0,
    }),
  });
  const block = compressed.state.blocks.find((b) => b.active)!;
  let store = createContentStore();
  store = storeCoveredOriginals(
    store,
    seeded.messages,
    compressed.state,
    [block.blockId],
    countTokens,
  );
  const foundU1 = retrieveByRef(store, "m00001");
  assert.ok(foundU1.ok);
  if (foundU1.ok) assert.equal(foundU1.text, "first user message here");
  assert.ok(!hasStoredRef(store, "m00005"));
});

test("storeCoveredOriginals skips reasoning and keeps earlier CCR originals (first-write-wins)", () => {
  const core = createCore({ countTokens });
  const original = bigText();
  const messages: CoreMessage[] = [
    toolCall("c1", "call1", "bash"),
    toolResult("r1", "call1", "bash", original),
    {
      id: "th1",
      role: "assistant",
      contentType: "reasoning",
      text: "private thinking",
    },
    { id: "u2", role: "user", contentType: "text", text: "follow up question" },
    {
      id: "a2",
      role: "assistant",
      contentType: "text",
      text: "follow up answer here",
    },
    {
      id: "u3",
      role: "user",
      contentType: "text",
      text: "tail user message stays recent",
    },
    {
      id: "a3",
      role: "assistant",
      contentType: "text",
      text: "tail assistant reply stays recent",
    },
  ];
  const seeded = core.processTurn({
    messages,
    state: createInitialState(),
    config: ccrConfig(),
    tokenCount: 1000,
  });
  const compressed = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "S".repeat(60) }],
    messages: seeded.messages,
    state: seeded.state,
    config: defaultConfig(100000, {
      compress: { minCompressRange: 0 },
      preserveRecentMessages: 1,
      preserveRecentTokens: 0,
    }),
  });
  const block = compressed.state.blocks.find((b) => b.active)!;
  let store = seeded.contentStore;
  store = storeCoveredOriginals(
    store,
    seeded.messages,
    compressed.state,
    [block.blockId],
    countTokens,
  );
  const foundR1 = retrieveByRef(store, "m00002");
  assert.ok(foundR1.ok);
  if (foundR1.ok) assert.equal(foundR1.text, original);
  assert.ok(!hasStoredRef(store, "m00003"));
});

test("absorb minToolTokens default raised 1000 -> 4000 (issue #352 disclosure)", () => {
  assert.equal(DEFAULT_ABSORB_CONFIG.minToolTokens, 4000);
  assert.equal(defaultConfig(100000).absorb?.minToolTokens, 4000);
  assert.equal(DEFAULT_ABSORB_CONFIG.enabled, false);
});

test("ccr defaults: disabled, acp_retrieve, 4000 tok, mergeable overrides", () => {
  assert.deepEqual(DEFAULT_CCR_CONFIG, {
    enabled: false,
    toolName: "acp_retrieve",
    minToolTokens: 4000,
    excludeTools: [],
    maxHeadChars: 96,
  });
  const base = defaultConfig(100000);
  assert.equal(base.ccr?.enabled, false);
  assert.equal(base.ccr?.minToolTokens, 4000);
  const merged = defaultConfig(100000, {
    ccr: { enabled: true, minToolTokens: 100 },
  });
  assert.equal(resolveCcrConfig(merged).enabled, true);
  assert.equal(resolveCcrConfig(merged).minToolTokens, 100);
  assert.equal(resolveCcrConfig(merged).toolName, "acp_retrieve");
});

test("validateConfig rejects invalid ccr settings", () => {
  assert.equal(validateConfig(ccrConfig()).length, 0);
  const bad1 = defaultConfig(100000, {
    ccr: { ...DEFAULT_CCR_CONFIG, enabled: true, toolName: "" },
  });
  assert.ok(validateConfig(bad1).some((e) => e.includes("ccr.toolName")));
  const bad2 = defaultConfig(100000, {
    ccr: { ...DEFAULT_CCR_CONFIG, minToolTokens: -1 },
  });
  assert.ok(validateConfig(bad2).some((e) => e.includes("ccr.minToolTokens")));
  const bad3 = defaultConfig(100000, {
    ccr: { ...DEFAULT_CCR_CONFIG, maxHeadChars: -5 },
  });
  assert.ok(validateConfig(bad3).some((e) => e.includes("ccr.maxHeadChars")));
});

test("RETRIEVE_TOOL schemas exist in all three wire shapes and stay opt-in", () => {
  assert.equal(RETRIEVE_TOOL_NAME, "acp_retrieve");
  assert.equal(RETRIEVE_TOOL.name, "acp_retrieve");
  assert.deepEqual(RETRIEVE_TOOL.input_schema.required, ["ref"]);
  assert.equal(RETRIEVE_TOOL_OPENAI.type, "function");
  assert.equal(RETRIEVE_TOOL_OPENAI.function.name, "acp_retrieve");
  assert.equal(RETRIEVE_TOOL_RESPONSES.type, "function");
  assert.equal(RETRIEVE_TOOL_RESPONSES.name, "acp_retrieve");
  const openaiNames = ACP_TOOLS_OPENAI.map((t) => t.function.name);
  assert.ok(!openaiNames.includes("acp_retrieve"));
  assert.ok(!ACP_TOOL_NAMES.has("acp_retrieve"));
});

test("storeCoveredOriginals never persists placeholder text as an original (#1340)", () => {
  const core = createCore({ countTokens });
  // The exact disease: history still carries the [acp-stored …] placeholder,
  // but the companion store LOST the ref (fork without store adoption, deleted
  // or corrupted store file, host migration without the envelope). Storing the
  // placeholder bytes as the "original" would make every later retrieve-by-ref
  // a fake hit that echoes the placeholder itself.
  const placeholder = buildStoredPlaceholder({
    ref: "m00099",
    kind: "tool:bash",
    tokens: 4213,
    head: "probe_kvnet.py: tests n-gram baseline",
    retrieveToolName: RETRIEVE_TOOL_NAME,
  });
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: placeholder },
    { id: "a1", role: "assistant", contentType: "text", text: "assistant reply that folds alongside" },
    { id: "u2", role: "user", contentType: "text", text: "recent tail user message" },
    { id: "a2", role: "assistant", contentType: "text", text: "recent tail assistant reply" },
  ];
  const seeded = core.processTurn({
    messages,
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 1000,
  });
  const compressed = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "S".repeat(60) }],
    messages: seeded.messages,
    state: seeded.state,
    config: defaultConfig(100000, {
      compress: { minCompressRange: 0 },
      preserveRecentMessages: 1,
      preserveRecentTokens: 0,
    }),
  });
  const block = compressed.state.blocks.find((b) => b.active)!;
  let store = createContentStore();
  store = storeCoveredOriginals(
    store,
    seeded.messages,
    compressed.state,
    [block.blockId],
    countTokens,
  );
  assert.ok(!hasStoredRef(store, "m00001"), "placeholder must not enter the store");
  const missed = retrieveByRef(store, "m00001");
  assert.ok(!missed.ok, "retrieve must miss honestly, not echo the placeholder");
  const kept = retrieveByRef(store, "m00002");
  assert.ok(kept.ok, "non-placeholder covered originals still store normally");
  if (kept.ok) assert.equal(kept.text, "assistant reply that folds alongside");
});
