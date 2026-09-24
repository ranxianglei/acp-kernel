import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToCore, coreToOpenai } from "../src/wire/openai.js";
import type { OpenAIRequestBody } from "../src/wire/openai.js";
import { hasMediaPayload } from "../src/protected.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

const IMG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DATA_URL = `data:image/png;base64,${IMG_DATA}`;
// DeepSeek Files API attachment ref — an unknown part type on the OpenAI chat wire.
const FILE_PART = { type: "file", file_id: "file-api-abc123" };

function bodyOf(messages: OpenAIRequestBody["messages"]): OpenAIRequestBody {
  return { model: "test", messages };
}

function textMsg(
  id: string,
  role: CoreMessage["role"],
  text: string,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function mediaUserMsg(id: string, text: string, extra: object): CoreMessage {
  return Object.assign(
    { id, role: "user" as const, contentType: "text" as const, text },
    extra,
  );
}

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
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function rebuiltUserContent(
  msgs: CoreMessage[],
): Array<Record<string, unknown>> | string {
  const rebuilt = coreToOpenai(msgs as Parameters<typeof coreToOpenai>[0]);
  const user = rebuilt.find((m) => m.role === "user")!;
  return user.content as Array<Record<string, unknown>> | string;
}

// --- Wire round-trip: unknown parts must survive (billion-context#1205) ---

test("openai: [text, file] round-trips the file part verbatim", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [{ type: "text", text: "what is in this file?" }, FILE_PART],
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs.length, 1);
  // Pre-existing stringContent semantics: array entries join with "\n" and
  // non-text entries contribute "" — same as today's [text, image] messages.
  // The id derives from this text, so the shape must not change.
  assert.equal(msgs[0]?.text, "what is in this file?\n");
  assert.deepEqual(
    msgs[0]?.rawOpenaiContentParts,
    [FILE_PART],
    "opaque part rides the plural sidecar",
  );
  assert.equal(
    msgs[0]?.rawOpenaiContent,
    undefined,
    "singular sidecar not used for non-image parts",
  );

  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.equal((content as Array<Record<string, unknown>>)[0]?.type, "text");
  assert.deepEqual(
    (content as Array<Record<string, unknown>>)[1],
    FILE_PART,
    "file part re-emitted verbatim",
  );
});

test("openai: lone [file] part survives with empty text", () => {
  const body = bodyOf([{ role: "user", content: [FILE_PART] }]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs[0]?.text, "");
  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.deepEqual(content, [FILE_PART]);
});

test("openai: [text, file, image] keeps wire order of non-text parts", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [
        { type: "text", text: "compare these" },
        FILE_PART,
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    },
  ]);
  const { msgs } = openaiToCore(body);
  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  const types = (content as Array<Record<string, unknown>>).map((p) => p.type);
  assert.deepEqual(types, ["text", "file", "image_url"]);
  assert.deepEqual((content as Array<Record<string, unknown>>)[1], FILE_PART);
});

test("openai: single data-URL image keeps legacy singular sidecar shape", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.ok(msgs[0]?.rawOpenaiContent, "singular sidecar preserved");
  assert.equal(
    msgs[0]?.rawOpenaiContentParts,
    undefined,
    "no plural sidecar for a lone image",
  );
  assert.equal(msgs[0]?.imageBase64, IMG_DATA);
  assert.equal(msgs[0]?.imageMediaType, "image/png");

  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.deepEqual((content as Array<Record<string, unknown>>)[1], {
    type: "image_url",
    image_url: { url: DATA_URL },
  });
});

test("openai: multi-image plural sidecar unchanged", () => {
  const body = bodyOf([
    {
      role: "user",
      content: [
        { type: "text", text: "two pics" },
        { type: "image_url", image_url: { url: DATA_URL } },
        { type: "image_url", image_url: { url: "https://example.com/x.png" } },
      ],
    },
  ]);
  const { msgs } = openaiToCore(body);
  assert.equal(msgs[0]?.rawOpenaiContentParts?.length, 2);
  const content = rebuiltUserContent(msgs);
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    (content as Array<Record<string, unknown>>).map((p) => p.type),
    ["text", "image_url", "image_url"],
  );
});

test("openai: plain string and text-only content stay sidecar-free", () => {
  const strBody = bodyOf([{ role: "user", content: "hello" }]);
  const { msgs: strMsgs } = openaiToCore(strBody);
  assert.equal(strMsgs[0]?.rawOpenaiContent, undefined);
  assert.equal(strMsgs[0]?.rawOpenaiContentParts, undefined);
  assert.equal(rebuiltUserContent(strMsgs), "hello");

  const arrBody = bodyOf([
    { role: "user", content: [{ type: "text", text: "just words" }] },
  ]);
  const { msgs: arrMsgs } = openaiToCore(arrBody);
  assert.equal(arrMsgs[0]?.rawOpenaiContentParts, undefined);
  assert.equal(rebuiltUserContent(arrMsgs), "just words");
});

// --- Media payload protection against folding (billion-context#1188) ---

test("hasMediaPayload detects each sidecar carrier and ignores plain/tool-result shapes", () => {
  assert.equal(hasMediaPayload(textMsg("a", "user", "x")), false);
  assert.equal(
    hasMediaPayload(mediaUserMsg("b", "x", { imageBase64: "AQ" })),
    true,
  );
  assert.equal(
    hasMediaPayload(mediaUserMsg("c", "x", { rawOpenaiContent: FILE_PART })),
    true,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("d", "x", { rawOpenaiContentParts: [FILE_PART] }),
    ),
    true,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("e", "x", { rawAnthropicBlock: { type: "image" } }),
    ),
    true,
  );
  // The same sidecar field carries structured tool_results — must NOT count.
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("f", "x", { rawAnthropicBlock: { type: "tool_result" } }),
    ),
    false,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("g", "x", {
        rawResponsesItem: { content: [{ type: "input_image" }] },
      }),
    ),
    true,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("h", "x", {
        rawResponsesItem: { content: [{ type: "input_text" }] },
      }),
    ),
    false,
  );
  assert.equal(
    hasMediaPayload(
      mediaUserMsg("i", "x", { rawResponsesItem: { type: "input_image" } }),
    ),
    true,
  );
});

test("assignRefs gives media messages a BLOCKED ref", () => {
  const messages = [
    textMsg("a", "user", "alpha"),
    mediaUserMsg("img", "", { imageBase64: IMG_DATA }),
    textMsg("b", "assistant", "beta"),
  ];
  const state = createInitialState();
  const res = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: hasMediaPayload,
  });
  assert.equal(res.map.byRaw["a"], "m00001");
  assert.equal(res.map.byRaw["img"], BLOCKED_REF);
  assert.equal(res.map.byRaw["b"], "m00002");
});

test("buildCompressibleRanges never spans a media message", () => {
  const messages = [
    textMsg("a", "user", "alpha ".repeat(50).trim()),
    mediaUserMsg("img", "see attached", { imageBase64: IMG_DATA }),
    textMsg("b", "assistant", "beta ".repeat(50).trim()),
  ];
  const state = createInitialState();
  // Numeric refs for every message (legacy session shape) — protection must
  // hold regardless of ref state.
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const ranges = buildCompressibleRanges(messages, state, config());

  const refToIndex = new Map(
    messages.map((m, i) => [state.messageRefs.byRaw[m.id], i]),
  );
  const mediaIndex = messages.findIndex((m) => m.id === "img");
  for (const r of ranges.compressible) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      `range ${r.startRef}..${r.endRef} must not span the media message`,
    );
  }
  for (const r of ranges.protected) {
    const s = refToIndex.get(r.startRef)!;
    const e = refToIndex.get(r.endRef)!;
    assert.ok(
      !(s <= mediaIndex && mediaIndex <= e),
      "media message must not be advertised as protected either",
    );
  }
  assert.ok(
    ranges.compressible.length >= 1,
    "non-media messages stay compressible",
  );
});

test("applyCompression excludes media messages from the block and warns", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    textMsg("t1", "assistant", "thinking out loud"),
    mediaUserMsg("img", "see the screenshot", { imageBase64: IMG_DATA }),
    textMsg("t2", "assistant", "analyzing"),
    textMsg("u2", "user", "and now?"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00004",
        summary: "task + analysis summarized",
        topic: "work",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(
    result.result.errors.length,
    0,
    JSON.stringify(result.result.errors),
  );
  assert.equal(result.state.blocks.length, 1);
  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("img"),
    "media message not folded",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("img"),
    "media message not recorded as covered",
  );
  assert.deepEqual(block.directMessageIds.sort(), ["t1", "t2", "u"]);
  assert.ok(
    result.result.warnings.some((w) => w.includes("image/attachment")),
    `warning present, got: ${JSON.stringify(result.result.warnings)}`,
  );
});
