import { test } from "node:test";
import assert from "node:assert/strict";
import { stripHistoricalImages } from "../src/wire/strip-images.js";

const DATA_URL = "data:image/png;base64,AAAA";
const REMOTE_URL = "https://example.com/img.png";

const oaiImg = (url: string) => ({ type: "image_url", image_url: { url } });
const oaiTxt = (t: string) => ({ type: "text", text: t });
const antImgB64 = () => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
});
const antImgUrl = () => ({
  type: "image",
  source: { type: "url", url: REMOTE_URL },
});
const rspImg = (url: string) => ({ type: "input_image", image_url: url });
const rspTxt = (t: string) => ({ type: "input_text", text: t });

test("openai: drops image parts from old messages, keeps the most recent N", () => {
  const body = {
    model: "gpt",
    messages: [
      { role: "user", content: [oaiTxt("look"), oaiImg(DATA_URL)] },
      { role: "assistant", content: [oaiImg(DATA_URL)] },
      { role: "user", content: [oaiTxt("hi"), oaiImg(REMOTE_URL)] },
    ],
  };
  const r = stripHistoricalImages(body, "openai", 1);
  assert.equal(r.removed, 2);
  assert.notEqual(r.body, body);
  const m = (r.body as { messages: unknown[] }).messages;
  assert.deepEqual(m[0], { role: "user", content: [oaiTxt("look")] });
  assert.deepEqual(m[1], {
    role: "assistant",
    content: [{ type: "text", text: "[image]" }],
  });
  assert.equal(m[2], body.messages[2]);
});

test("openai: no images returns the input reference unchanged", () => {
  const body = {
    messages: [
      { role: "user", content: [oaiTxt("only text")] },
      { role: "assistant", content: [oaiTxt("still text")] },
    ],
  };
  const r = stripHistoricalImages(body, "openai", 1);
  assert.equal(r.removed, 0);
  assert.equal(r.body, body);
});

test("openai: keepRecent >= length strips nothing", () => {
  const body = {
    messages: [
      { role: "user", content: [oaiImg(DATA_URL)] },
      { role: "assistant", content: [oaiImg(DATA_URL)] },
    ],
  };
  const r = stripHistoricalImages(body, "openai", 5);
  assert.equal(r.removed, 0);
  assert.equal(r.body, body);
});

test("openai: keepRecent 0 strips every message", () => {
  const body = {
    messages: [
      { role: "user", content: [oaiImg(DATA_URL)] },
      { role: "assistant", content: [oaiTxt("x"), oaiImg(DATA_URL)] },
    ],
  };
  const r = stripHistoricalImages(body, "openai", 0);
  assert.equal(r.removed, 2);
  const m = (r.body as { messages: unknown[] }).messages;
  assert.deepEqual(m[0].content, [{ type: "text", text: "[image]" }]);
  assert.deepEqual(m[1].content, [oaiTxt("x")]);
});

test("openai: remote-URL images are stripped too (type-based, not data-URL-only)", () => {
  const body = { messages: [{ role: "user", content: [oaiImg(REMOTE_URL)] }] };
  const r = stripHistoricalImages(body, "openai", 0);
  assert.equal(r.removed, 1);
  assert.deepEqual((r.body as { messages: unknown[] }).messages[0].content, [
    { type: "text", text: "[image]" },
  ]);
});

test("openai: non-image fields on a message are preserved", () => {
  const body = {
    messages: [
      {
        role: "tool",
        tool_call_id: "t1",
        name: "search",
        content: [oaiImg(DATA_URL)],
      },
    ],
  };
  const r = stripHistoricalImages(body, "openai", 0);
  const m = (r.body as { messages: Array<Record<string, unknown>> })
    .messages[0];
  assert.equal(m.role, "tool");
  assert.equal(m.tool_call_id, "t1");
  assert.equal(m.name, "search");
  assert.deepEqual(m.content, [{ type: "text", text: "[image]" }]);
});

test("anthropic: strips base64 and url image parts, keeps recent", () => {
  const body = {
    model: "claude",
    messages: [
      { role: "user", content: [antImgB64()] },
      { role: "assistant", content: [oaiTxt("ok"), antImgUrl()] },
    ],
  };
  const r = stripHistoricalImages(body, "anthropic", 1);
  assert.equal(r.removed, 1);
  const m = (r.body as { messages: unknown[] }).messages;
  assert.deepEqual(m[0], {
    role: "user",
    content: [{ type: "text", text: "[image]" }],
  });
  assert.equal(m[1], body.messages[1]);
});

test("responses: strips input_image, uses input_text placeholder, ignores non-content items", () => {
  const body = {
    model: "gpt",
    input: [
      { type: "message", role: "user", content: [rspImg(DATA_URL)] },
      { type: "function_call", name: "f", call_id: "c1", arguments: "{}" },
      {
        type: "message",
        role: "user",
        content: [rspTxt("q"), rspImg(REMOTE_URL)],
      },
    ],
  };
  const r = stripHistoricalImages(body, "responses", 1);
  assert.equal(r.removed, 1);
  const inp = (r.body as { input: unknown[] }).input;
  assert.deepEqual(inp[0], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "[image]" }],
  });
  assert.equal(inp[1], body.input[1]);
  assert.equal(inp[2], body.input[2]);
});

test("null protocol is a no-op even when the body carries images", () => {
  const body = { messages: [{ role: "user", content: [oaiImg(DATA_URL)] }] };
  const r = stripHistoricalImages(body, null, 0);
  assert.equal(r.removed, 0);
  assert.equal(r.body, body);
});

test("non-object or missing container bodies are no-ops returning the same reference", () => {
  assert.deepEqual(stripHistoricalImages(null, "openai", 5), {
    body: null,
    removed: 0,
  });
  assert.deepEqual(stripHistoricalImages(42, "openai", 5), {
    body: 42,
    removed: 0,
  });
  const bare = { foo: 1 };
  const r = stripHistoricalImages(bare, "openai", 5);
  assert.equal(r.body, bare);
  assert.equal(r.removed, 0);
});
