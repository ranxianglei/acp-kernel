import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import { openaiToCore, coreToOpenai } from "../src/wire/openai.js";
import { responsesToCore, coreToResponses, patchResponsesInput } from "../src/wire/responses.js";
import type { AnthropicBlock, AnthropicRequestBody } from "../src/wire/anthropic.js";
import type { OpenAIRequestBody } from "../src/wire/openai.js";
import type { ResponsesRequestBody } from "../src/wire/responses.js";

const IMG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DATA_URL = `data:image/png;base64,${IMG_DATA}`;

function block(rebuilt: { content: string | AnthropicBlock[] }, i: number): Record<string, unknown> {
    return (rebuilt.content as unknown[])[i] as Record<string, unknown>;
}

// 1. Anthropic image block round-trips losslessly (source.base64 + media_type).
test("anthropic: image block is restored verbatim via rawAnthropicBlock", () => {
    const source = { type: "base64", media_type: "image/png", data: IMG_DATA };
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "image", source }] }],
    };
    const { msgs } = anthropicToCore(body);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.contentType, "text");
    assert.equal(msgs[0]?.text, "[image]");
    assert.ok(msgs[0]?.rawAnthropicBlock, "sidecar rawAnthropicBlock stored");
    const rebuilt = coreToAnthropic(msgs);
    assert.equal(rebuilt.length, 1);
    const img = block(rebuilt[0]!, 0);
    assert.equal(img.type, "image", "image block reconstructed (not a text placeholder)");
    assert.deepEqual(img.source, source, "source preserved verbatim (base64 + media_type)");
});

// 2. Anthropic thinking + signature round-trips (signature was previously dropped).
test("anthropic: thinking signature is restored", () => {
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [
            { role: "assistant", content: [{ type: "thinking", thinking: "let me consider", signature: "sig_EqMAC" }] },
        ],
    };
    const { msgs } = anthropicToCore(body);
    assert.equal(msgs[0]?.contentType, "reasoning");
    assert.equal(msgs[0]?.thinkingSignature, "sig_EqMAC", "thinkingSignature sidecar stored");
    const rebuilt = coreToAnthropic(msgs);
    const th = block(rebuilt[0]!, 0);
    assert.equal(th.type, "thinking");
    assert.equal(th.thinking, "let me consider");
    assert.equal(th.signature, "sig_EqMAC", "signature reattached (Anthropic rejects thinking without it)");
});

// 3. Anthropic tool_result.is_error round-trips (was previously dropped).
test("anthropic: tool_result.is_error is restored", () => {
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
        ],
    };
    const { msgs } = anthropicToCore(body);
    const result = msgs.find((m) => m.contentType === "tool-result");
    assert.equal(result?.toolIsError, true, "toolIsError sidecar stored");
    const rebuilt = coreToAnthropic(msgs);
    const userMsg = rebuilt.find((m) => m.role === "user")!;
    const tr = block(userMsg, 0);
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.is_error, true, "is_error reconstructed");
});

// 3b. Sanity: a non-error tool_result does NOT gain is_error.
test("anthropic: tool_result without is_error stays clean", () => {
    const body: AnthropicRequestBody = {
        model: "claude",
        max_tokens: 100,
        messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ],
    };
    const { msgs } = anthropicToCore(body);
    const result = msgs.find((m) => m.contentType === "tool-result");
    assert.equal(result?.toolIsError, undefined);
    const rebuilt = coreToAnthropic(msgs);
    const userMsg = rebuilt.find((m) => m.role === "user")!;
    const tr = block(userMsg, 0);
    assert.equal(tr.is_error, undefined, "no spurious is_error");
});

// 4. OpenAI leading system/developer prefix is hoisted OUT of the fold space
// (restart-regression fix: host system content is runtime-unstable, so it must
// never enter the id/fingerprint space); originalRole still round-trips for
// mid-conversation system traffic.
test("openai: leading developer/system prefix is hoisted, not folded", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "developer", content: "you are a dev" },
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
        ],
    };
    const { msgs, systemText } = openaiToCore(body);
    assert.equal(systemText, "you are a dev\n\nsys", "prefix returned separately");
    assert.ok(msgs.every((m) => m.role !== "system"), "no system piece in the fold space");
    assert.equal(msgs[0]?.role, "user");
});

// 4b. Mid-conversation system traffic keeps the role sidecar round-trip.
test("openai: mid-conversation developer role is restored", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "user", content: "hi" },
            { role: "developer", content: "you are a dev" },
        ],
    };
    const { msgs } = openaiToCore(body);
    const dev = msgs.find((m) => m.role === "system")!;
    assert.equal(dev.originalRole, "developer", "originalRole sidecar stored");
    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt[1]?.role, "developer", "developer role reconstructed");
    assert.equal(rebuilt[1]?.content, "you are a dev");
});

// 5. OpenAI image_url round-trips (image was previously dropped entirely).
test("openai: user image_url content part is restored", () => {
    const body: OpenAIRequestBody = {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "what is this?" },
                    { type: "image_url", image_url: { url: DATA_URL } },
                ],
            },
        ],
    };
    const { msgs } = openaiToCore(body);
    assert.ok(msgs[0]?.text?.startsWith("what is this?"), "text preserved");
    assert.equal(msgs[0]?.imageMediaType, "image/png");
    assert.equal(msgs[0]?.imageBase64, IMG_DATA);
    assert.ok(msgs[0]?.rawOpenaiContent, "rawOpenaiContent sidecar stored");
    const rebuilt = coreToOpenai(msgs);
    const u = rebuilt[0]!;
    assert.equal(u.role, "user");
    assert.ok(Array.isArray(u.content), "content rebuilt as array (text + image)");
    const parts = u.content as unknown as { type: string; [k: string]: unknown }[];
    const text = parts.find((p) => p.type === "text");
    assert.ok(typeof text?.text === "string" && text.text.startsWith("what is this?"));
    const img = parts.find((p) => p.type === "image_url");
    assert.ok(img, "image_url part reconstructed");
    assert.deepEqual((img as unknown as { image_url: { url: string } }).image_url.url, DATA_URL, "image data URL restored");
});

// 5b. OpenAI multi-image user message preserves ALL images. firstImagePart
//     previously kept only the first image, so images 2..N were silently
//     dropped on the coreToOpenai rebuild (and the omp wire-fold gate failed
//     open on the whole payload). All data-URL parts must round-trip in order.
test("openai: user message with multiple image_url parts round-trips ALL images", () => {
    const DATA_URL2 = `data:image/png;base64,${IMG_DATA}AAAA`;
    const DATA_URL3 = `data:image/png;base64,${IMG_DATA}AAAAA`;
    const body: OpenAIRequestBody = {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "compare these?" },
                    { type: "image_url", image_url: { url: DATA_URL } },
                    { type: "image_url", image_url: { url: DATA_URL2 } },
                    { type: "image_url", image_url: { url: DATA_URL3 } },
                ],
            },
        ],
    };
    const { msgs } = openaiToCore(body);
    assert.ok(msgs[0]?.rawOpenaiContentParts, "multi-image sidecar stored (not singular rawOpenaiContent)");
    assert.equal((msgs[0]?.rawOpenaiContentParts ?? []).length, 3);
    const rebuilt = coreToOpenai(msgs);
    const u = rebuilt[0]!;
    assert.ok(Array.isArray(u.content), "content rebuilt as array");
    const parts = u.content as unknown as { type: string; [k: string]: unknown }[];
    const imgs = parts.filter((p) => p.type === "image_url");
    assert.equal(imgs.length, 3, "all 3 image_url parts preserved");
    const urls = imgs.map((p) => (p as unknown as { image_url: { url: string } }).image_url.url);
    assert.deepEqual(urls, [DATA_URL, DATA_URL2, DATA_URL3], "image order preserved");
    const text = parts.find((p) => p.type === "text");
    assert.ok(typeof text?.text === "string" && text.text.startsWith("compare these?"), "text preserved");
});

// 5c. A single REMOTE (non-data) URL image gets no base64 sidecar, so it must
//     ride rawOpenaiContent verbatim. Previously allImageParts filtered to
//     data: URLs, so a lone remote-URL image produced NO sidecar at all and
//     was silently dropped on the coreToOpenai rebuild (issue #187).
test("openai: single remote-URL image_url round-trips via rawOpenaiContent", () => {
    const REMOTE_URL = "https://example.com/a.png";
    const body: OpenAIRequestBody = {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "t" },
                    { type: "image_url", image_url: { url: REMOTE_URL } },
                ],
            },
        ],
    };
    const { msgs } = openaiToCore(body);
    assert.ok(msgs[0]?.rawOpenaiContent, "rawOpenaiContent sidecar stored for a single remote-URL image");
    assert.equal(msgs[0]?.imageBase64, undefined, "no base64 split for non-data URLs");
    assert.equal(msgs[0]?.imageMediaType, undefined, "no mediaType split for non-data URLs");
    const rebuilt = coreToOpenai(msgs);
    const u = rebuilt[0]!;
    assert.ok(Array.isArray(u.content), "content rebuilt as array");
    const parts = u.content as unknown as { type: string; [k: string]: unknown }[];
    const img = parts.find((p) => p.type === "image_url") as unknown as { image_url: { url: string } };
    assert.equal(img?.image_url.url, REMOTE_URL, "remote-URL image restored verbatim");
    const text = parts.find((p) => p.type === "text");
    assert.ok(typeof text?.text === "string" && text.text.startsWith("t"), "text preserved");
});

// 5d. Image-only user message (no text part) with a remote URL: the message
//     text is empty, so survival depends entirely on the sidecar.
test("openai: image-only remote-URL user message survives rebuild", () => {
    const REMOTE_URL = "https://example.com/b.jpg";
    const body: OpenAIRequestBody = {
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: REMOTE_URL } }] }],
    };
    const { msgs } = openaiToCore(body);
    assert.equal(msgs[0]?.text, "");
    assert.ok(msgs[0]?.rawOpenaiContent, "sidecar stored despite empty text");
    const rebuilt = coreToOpenai(msgs);
    const u = rebuilt[0]!;
    assert.ok(Array.isArray(u.content), "content rebuilt as array (not an empty string)");
    const parts = u.content as unknown as { type: string; [k: string]: unknown }[];
    assert.equal(parts.length, 1, "exactly one part — no empty text part injected");
    const img = parts[0] as unknown as { type: string; image_url: { url: string } };
    assert.equal(img.type, "image_url");
    assert.equal(img.image_url.url, REMOTE_URL);
});

// 5e. Mixed data-URL + remote-URL multi-image message: allImageParts used to
//     keep only data-URL parts, so the remote one vanished from
//     rawOpenaiContentParts (wider gap than the single-image case).
test("openai: mixed data-URL + remote-URL multi-image message preserves ALL images in order", () => {
    const REMOTE_URL = "https://example.com/c.webp";
    const body: OpenAIRequestBody = {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "both?" },
                    { type: "image_url", image_url: { url: DATA_URL } },
                    { type: "image_url", image_url: { url: REMOTE_URL } },
                ],
            },
        ],
    };
    const { msgs } = openaiToCore(body);
    assert.ok(msgs[0]?.rawOpenaiContentParts, "multi-image sidecar stored");
    assert.equal((msgs[0]?.rawOpenaiContentParts ?? []).length, 2, "BOTH images collected (remote included)");
    const rebuilt = coreToOpenai(msgs);
    const u = rebuilt[0]!;
    const parts = u.content as unknown as { type: string; [k: string]: unknown }[];
    const imgs = parts.filter((p) => p.type === "image_url");
    assert.equal(imgs.length, 2, "all 2 image_url parts preserved");
    const urls = imgs.map((p) => (p as unknown as { image_url: { url: string } }).image_url.url);
    assert.deepEqual(urls, [DATA_URL, REMOTE_URL], "order preserved");
});

// 6. Responses API input_image round-trips (image was previously dropped).
test("responses: user input_image is restored via rawResponsesItem", () => {
    const body: ResponsesRequestBody = {
        input: [
            {
                type: "message",
                role: "user",
                content: [
                    { type: "input_text", text: "see this" },
                    { type: "input_image", image_url: DATA_URL },
                ],
            },
        ],
    };
    const { msgs } = responsesToCore(body);
    assert.ok(msgs[0]?.text?.startsWith("see this"), "text preserved");
    assert.equal(msgs[0]?.imageMediaType, "image/png");
    assert.equal(msgs[0]?.imageBase64, IMG_DATA);
    assert.ok(msgs[0]?.rawResponsesItem, "rawResponsesItem sidecar stored");
    const rebuilt = coreToResponses(msgs);
    assert.equal(rebuilt.length, 1);
    const m = rebuilt[0] as { type: string; content: unknown };
    assert.equal(m.type, "message");
    assert.ok(Array.isArray(m.content), "message content rebuilt as array");
    const parts = m.content as unknown as { type: string; [k: string]: unknown }[];
    const img = parts.find((p) => p.type === "input_image");
    assert.ok(img, "input_image reconstructed");
    assert.equal(img?.image_url, DATA_URL, "image url restored");
});

// 6b. Image-ONLY user item (no input_text) previously produced NO core
//     message at all (effText === ""), so coreToResponses never saw it and
//     the item vanished from the rebuilt input (issue #187). It must be
//     tracked with the "[image]" placeholder (anthropic codec precedent) and
//     re-emitted verbatim via rawResponsesItem while unmodified.
test("responses: image-only user item is tracked and round-trips verbatim", () => {
    const body: ResponsesRequestBody = {
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_URL }] }],
    };
    const { msgs } = responsesToCore(body);
    assert.equal(msgs.length, 1, "image-only item produces exactly one core message");
    assert.equal(msgs[0]?.text, "[image]", "placeholder text used for identity + display");
    assert.ok(msgs[0]?.rawResponsesItem, "rawResponsesItem sidecar stored");
    assert.equal(msgs[0]?.imageMediaType, "image/png", "data-URL sidecar fields still populated");
    assert.equal(msgs[0]?.imageBase64, IMG_DATA);
    const rebuilt = coreToResponses(msgs);
    assert.equal(rebuilt.length, 1);
    assert.deepEqual(rebuilt[0], body.input[0], "raw item re-emitted verbatim (images intact)");
});

// 6c. The tracked image-only item must survive patchResponsesInput (the
//     host-rebuild path) AND disappear when its id leaves msgs[] — i.e. it
//     participates in compression like any other message. Before the fix it
//     was only kept by the layout fallback (untracked → invisible to the
//     compression pipeline, accumulating unbounded).
test("responses: image-only item survives patchResponsesInput and prunes with its turn", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_URL }] },
            { type: "message", role: "assistant", content: "got it" },
        ],
    };
    const proj = responsesToCore(body);
    assert.equal(proj.msgs.length, 2, "both items tracked");
    const imgMsg = proj.msgs.find((m) => m.text === "[image]")!;
    assert.ok(imgMsg, "image-only item has a tracked core id");
    const kept = patchResponsesInput(proj, proj.msgs);
    assert.ok(JSON.stringify(kept).includes(DATA_URL), "image survives the patch rebuild");
    const pruned = patchResponsesInput(proj, proj.msgs.filter((m) => m.id !== imgMsg.id));
    assert.ok(!JSON.stringify(pruned).includes(DATA_URL), "pruning the id removes the image from the rebuild");
});

// 6d. Two identical image-only items must get distinct but STABLE ids across
//     turns (ClusterCounter disambiguation), so a later turn cannot collapse
//     or misalign them.
test("responses: image-only item ids are stable and distinct across turns", () => {
    const first: ResponsesRequestBody = {
        input: [
            { type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_URL }] },
            { type: "message", role: "assistant", content: "ok" },
        ],
    };
    const second: ResponsesRequestBody = {
        input: [
            ...first.input,
            { type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_URL }] },
            { type: "message", role: "assistant", content: "ok again" },
        ],
    };
    const a = responsesToCore(first);
    const b = responsesToCore(second);
    const idsA = a.msgs.map((m) => m.id);
    const idsB = b.msgs.map((m) => m.id);
    assert.deepEqual(idsA.slice(0, 2), idsB.slice(0, 2), "earlier ids unchanged by later turns");
    const imgIds = b.msgs.filter((m) => m.text === "[image]").map((m) => m.id);
    assert.equal(new Set(imgIds).size, 2, "identical image-only items get distinct ids");
});

// 6e. MULTI-part image-only item: joining N−1 empty part texts yields a
//     truthy "\n", which is not real text — it must still take the "[image]"
//     placeholder (and keep matching canonicalUserText verbatim).
test("responses: multi-input_image user item takes the [image] placeholder", () => {
    const DATA_URL2 = `data:image/png;base64,${IMG_DATA}AAAA`;
    const body: ResponsesRequestBody = {
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_URL }, { type: "input_image", image_url: DATA_URL2 }] }],
    };
    const { msgs } = responsesToCore(body);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.text, "[image]", "no-text multi-image item uses the placeholder (not the \"\\n\" join artifact)");
    const rebuilt = coreToResponses(msgs);
    assert.deepEqual(rebuilt[0], body.input[0], "raw item re-emitted verbatim");
});

// 6f. Whitespace-only text + image: the whitespace IS real text (a text part
//     exists), so it must be kept as-is — both responsesToCore and
//     canonicalUserText must agree on it for the verbatim round-trip to hold.
test("responses: whitespace-only text plus image keeps its exact text", () => {
    const body: ResponsesRequestBody = {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "   " }, { type: "input_image", image_url: DATA_URL }] }],
    };
    const { msgs } = responsesToCore(body);
    assert.equal(msgs.length, 1);
    assert.notEqual(msgs[0]?.text, "[image]", "whitespace text counts as real text, not the placeholder");
    assert.ok(msgs[0]?.text?.startsWith("   "), "exact whitespace text preserved (kernel joins non-text parts with \\n)");
    const rebuilt = coreToResponses(msgs);
    assert.deepEqual(rebuilt[0], body.input[0], "verbatim round-trip holds for truthy-blank text");
});

// 6g. Image part whose image_url is malformed (non-string): still tracked and
//     re-emitted verbatim; no base64 sidecar fields.
test("responses: input_image with non-string image_url is tracked without sidecar fields", () => {
    const badPart = { type: "input_image", image_url: { not: "a string" } } as unknown as { type: string; [k: string]: unknown };
    const body = { input: [{ type: "message", role: "user", content: [badPart] }] } as unknown as ResponsesRequestBody;
    const { msgs } = responsesToCore(body);
    assert.equal(msgs.length, 1, "tracked despite malformed url");
    assert.equal(msgs[0]?.text, "[image]");
    assert.equal(msgs[0]?.imageBase64, undefined, "no base64 split for non-string urls");
    const rebuilt = coreToResponses(msgs);
    assert.deepEqual(rebuilt[0], body.input[0], "malformed item re-emitted verbatim");
});

// 7. Responses reasoning is routed into the compression pipeline (NOT the
// opaque preamble) so the kernel hides it once its turn is summarized. The raw
// item — including encrypted_content — round-trips verbatim via
// rawResponsesItem while the turn is still live.
test("responses: reasoning enters msgs[] as a tracked reasoning message (not preamble)", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "ENC_BLOB" },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs, preamble } = responsesToCore(body);
    assert.equal(preamble.length, 0, "reasoning is NOT in the opaque preamble");
    const r = msgs.find((m) => m.contentType === "reasoning");
    assert.ok(r, "reasoning entered msgs[] as contentType reasoning");
    assert.ok(r?.rawResponsesItem, "raw reasoning item carried in rawResponsesItem");
    const rebuilt = coreToResponses(msgs);
    const out = rebuilt.find((i) => (i as { id?: string }).id === "rs_abc") as { type: string; encrypted_content?: string };
    assert.ok(out, "reasoning item rebuilt");
    assert.equal(out.type, "reasoning");
    assert.equal(out.encrypted_content, "ENC_BLOB", "encrypted_content preserved verbatim");
});

// 8. additional_tools (and other opaque host directives) still go to the
// preamble verbatim — only reasoning was promoted into compression.
test("responses: additional_tools stays in the opaque preamble", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "additional_tools", tools: [{ name: "exec" }] },
            { type: "reasoning", id: "rs_1" },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs, preamble } = responsesToCore(body);
    assert.equal(preamble.length, 1, "only additional_tools is opaque");
    assert.equal(preamble[0]?.type, "additional_tools");
    assert.ok(msgs.find((m) => m.contentType === "reasoning"), "reasoning went to msgs[], not preamble");
});

// 9. ACP_REASONING_KEEP=none drops reasoning entirely (escape hatch).
test("responses: ACP_REASONING_KEEP=none drops all reasoning", () => {
    const prev = process.env.ACP_REASONING_KEEP;
    process.env.ACP_REASONING_KEEP = "none";
    try {
        const body: ResponsesRequestBody = {
            input: [
                { type: "reasoning", id: "rs_abc", encrypted_content: "ENC" },
                { type: "message", role: "user", content: "hi" },
            ],
        };
        const { msgs, preamble, droppedReasoning } = responsesToCore(body);
        assert.equal(preamble.length, 0);
        assert.ok(!msgs.find((m) => m.contentType === "reasoning"), "no reasoning in msgs[]");
        assert.equal(droppedReasoning, 1, "droppedReasoning counted");
    } finally {
        if (prev === undefined) delete process.env.ACP_REASONING_KEEP;
        else process.env.ACP_REASONING_KEEP = prev;
    }
});

// 10. Reasoning VANISHES from the rebuilt input once its turn is covered by a
// compression block — the central guarantee of the fix (issue #15). The kernel
// drops covered message ids before coreToResponses runs; simulating that prune
// here, the reasoning item must disappear while ordinary messages survive.
test("responses: reasoning is dropped from output after its turn is compressed", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_abc", encrypted_content: "ENC" },
            { type: "message", role: "user", content: "hi" },
            { type: "message", role: "assistant", content: "hello" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const reasoningId = msgs.find((m) => m.contentType === "reasoning")!.id;
    const pruned = msgs.filter((m) => m.id !== reasoningId);
    const rebuilt = coreToResponses(pruned);
    const gone = rebuilt.find((i) => (i as { type?: string }).type === "reasoning");
    assert.equal(gone, undefined, "reasoning item disappears once its turn is compressed");
    assert.equal(rebuilt.length, 2, "user + assistant messages survive");
});

// 11. Reasoning id is stable across turns — Codex re-sends the same reasoning
// items every turn, so the same input item must yield the same BiliMessage id
// or the kernel would accumulate phantom duplicates.
test("responses: reasoning id is stable across turns (same item → same id)", () => {
    const body = (): ResponsesRequestBody => ({
        input: [
            { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "t" }] },
            { type: "message", role: "user", content: "hi" },
        ],
    });
    const a = responsesToCore(body()).msgs.find((m) => m.contentType === "reasoning")!.id;
    const b = responsesToCore(body()).msgs.find((m) => m.contentType === "reasoning")!.id;
    assert.equal(a, b, "same reasoning item yields the same message id across turns");
});

// 12. Multiple reasoning items in one turn each get distinct ids and survive
// round-trip in order.
test("responses: multiple reasoning items keep distinct ids and order", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_1", encrypted_content: "A" },
            { type: "reasoning", id: "rs_2", encrypted_content: "B" },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const rs = msgs.filter((m) => m.contentType === "reasoning");
    assert.equal(rs.length, 2);
    assert.notEqual(rs[0]!.id, rs[1]!.id, "distinct ids");
    const rebuilt = coreToResponses(msgs);
    const ids = rebuilt
        .filter((i) => (i as { type?: string }).type === "reasoning")
        .map((i) => (i as { id?: string }).id);
    assert.deepEqual(ids, ["rs_1", "rs_2"], "order + ids preserved on rebuild");
});

// 13. Reasoning without encrypted_content (older API shape) still round-trips
// via rawResponsesItem.
test("responses: reasoning without encrypted_content round-trips", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "rs_x", summary: [{ type: "summary_text", text: "t" }] },
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const rebuilt = coreToResponses(msgs);
    const out = rebuilt.find((i) => (i as { id?: string }).id === "rs_x") as
        | { type: string; encrypted_content?: string }
        | undefined;
    assert.ok(out, "reasoning without encrypted_content still rebuilt");
    assert.equal(out!.type, "reasoning");
    assert.equal(out!.encrypted_content, undefined);
});

// 14. Prior-response ACTION items (computer_call, mcp_call, ...) are routed
// through the compression pipeline (NOT the opaque preamble) so they don't
// accumulate unbounded every turn and break the prompt-cache prefix. They
// round-trip verbatim via rawResponsesItem while their turn is live.
test("responses: call items (computer_call/mcp_call) enter msgs[] not preamble", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "additional_tools", tools: [] } as ResponseInputItem,
            { type: "mcp_list_tools", server_label: "s" } as ResponseInputItem,
            { type: "computer_call", id: "cc_1", action: { type: "screenshot" } } as ResponseInputItem,
            { type: "mcp_call", id: "mc_1", name: "search", arguments: "{}" } as ResponseInputItem,
            { type: "message", role: "user", content: "go" },
        ],
    };
    const { msgs, preamble } = responsesToCore(body);
    assert.deepEqual(
        preamble.map((p) => p.type),
        ["additional_tools", "mcp_list_tools"],
        "only definitions stay in the preamble",
    );
    const calls = msgs.filter((m) => m.contentType === "reasoning" && m.rawResponsesItem);
    assert.equal(calls.length, 2, "both call items routed into msgs[]");
    const rebuilt = coreToResponses(msgs);
    const types = rebuilt.map((i) => i.type);
    assert.ok(types.includes("computer_call"), "computer_call round-trips verbatim");
    assert.ok(types.includes("mcp_call"), "mcp_call round-trips verbatim");
});

// 15. Call items are hidden once their turn is compressed (same prune
// semantics as reasoning).
test("responses: call items drop from output after their turn is compressed", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "computer_call", id: "cc_1", action: { type: "screenshot" } } as ResponseInputItem,
            { type: "message", role: "user", content: "hi" },
        ],
    };
    const { msgs } = responsesToCore(body);
    const callMsg = msgs.find((m) => m.contentType === "reasoning" && (m.rawResponsesItem as { type?: string }).type === "computer_call");
    assert.ok(callMsg, "computer_call entered msgs[]");
    const pruned = msgs.filter((m) => m.id !== callMsg!.id);
    const rebuilt = coreToResponses(pruned);
    assert.equal(
        rebuilt.find((i) => i.type === "computer_call"),
        undefined,
        "computer_call disappears once its turn is compressed",
    );
});

// 16. A call item is given a distinct id namespace from reasoning, so the two
// never collide even when present in the same turn.
test("responses: call item and reasoning keep distinct ids in the same turn", () => {
    const body: ResponsesRequestBody = {
        input: [
            { type: "reasoning", id: "shared", encrypted_content: "E" },
            { type: "mcp_call", id: "shared", name: "n", arguments: "{}" } as ResponseInputItem,
        ],
    };
    const { msgs } = responsesToCore(body);
    const ids = msgs.filter((m) => m.contentType === "reasoning").map((m) => m.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "same raw id does not collide across kinds");
});

// 17. ACP_REASONING_KEEP=none drops chain-of-thought but MUST preserve call
// items: call items reuse the "reasoning" contentType only as a compression
// bucket, not because they are reasoning. Dropping a computer_call would
// corrupt the Responses conversation replay.
test("responses: ACP_REASONING_KEEP=none drops reasoning but keeps call items", () => {
    const prev = process.env.ACP_REASONING_KEEP;
    process.env.ACP_REASONING_KEEP = "none";
    try {
        const body: ResponsesRequestBody = {
            input: [
                { type: "reasoning", id: "rs_1", encrypted_content: "E" },
                { type: "computer_call", id: "cc_1", action: { type: "screenshot" } } as ResponseInputItem,
                { type: "mcp_call", id: "mc_1", name: "n", arguments: "{}" } as ResponseInputItem,
            ],
        };
        const { msgs } = responsesToCore(body);
        const reasoning = msgs.filter((m) => (m.rawResponsesItem as { type?: string }).type === "reasoning");
        const calls = msgs.filter((m) => (m.rawResponsesItem as { type?: string }).type !== "reasoning" && m.contentType === "reasoning");
        assert.equal(reasoning.length, 0, "chain-of-thought is dropped under ACP_REASONING_KEEP=none");
        assert.equal(calls.length, 2, "computer_call + mcp_call survive (replay-critical)");
    } finally {
        if (prev === undefined) delete process.env.ACP_REASONING_KEEP;
        else process.env.ACP_REASONING_KEEP = prev;
    }
});
