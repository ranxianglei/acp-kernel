import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_IMAGE_COMPRESSION_CONFIG,
  DEFAULT_SCREENSHOT_CLASSIFIER,
  IMAGE_FULL_FAILURE_MARKER,
  PIXEL_IMAGE_FALLBACK_TOKENS,
  applyImageFull,
  buildImageFullSystemNote,
  createHeuristicClassifier,
  decideImageRoute,
  estimateImageTokens,
  imageShrinksForRef,
  isImageFullRestored,
  parseImageDimensions,
  parseImageDimensionsFromBase64,
  parseImageFullInput,
  pixelTileEstimate,
  recordImageShrink,
  resetImageFullState,
  resolveImageCompressionConfig,
} from "../src/image-compress.js";
import type { ImageMeta } from "../src/image-compress.js";
import {
  IMAGE_FULL_TOOL,
  IMAGE_FULL_TOOL_NAME,
  IMAGE_FULL_TOOL_OPENAI,
  IMAGE_FULL_TOOL_RESPONSES,
} from "../src/compress-tools.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import { mergeCompressionState } from "../src/persist/state-merge.js";
import type { CompressionState, ImageShrinkRecord } from "../src/types.js";

function u16beAt(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >> 8) & 0xff;
  b[off + 1] = v & 0xff;
}

function u16leAt(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >> 8) & 0xff;
}

function u32beAt(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

function u32leAt(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >> 8) & 0xff;
  b[off + 2] = (v >> 16) & 0xff;
  b[off + 3] = (v >>> 24) & 0xff;
}

function pngBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  u32beAt(b, 8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  u32beAt(b, 16, w);
  u32beAt(b, 20, h);
  return b;
}

function gifBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  u16leAt(b, 6, w);
  u16leAt(b, 8, h);
  return b;
}

function bmpBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x42, 0x4d], 0);
  u32leAt(b, 14, 40);
  u32leAt(b, 18, w | 0);
  u32leAt(b, 22, h | 0);
  return b;
}

function webpVp8xBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  u32leAt(b, 4, 22);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  u32leAt(b, 16, 10);
  b[24] = (w - 1) & 0xff;
  b[25] = ((w - 1) >> 8) & 0xff;
  b[26] = ((w - 1) >> 16) & 0xff;
  b[27] = (h - 1) & 0xff;
  b[28] = ((h - 1) >> 8) & 0xff;
  b[29] = ((h - 1) >> 16) & 0xff;
  return b;
}

function webpVp8lBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(25);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  u32leAt(b, 4, 22);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x4c], 12);
  u32leAt(b, 16, 10);
  b[20] = 0x2f;
  const wm = w - 1;
  const hm = h - 1;
  b[21] = wm & 0xff;
  b[22] = ((wm >> 8) & 0x3f) | ((hm & 0x3) << 6);
  b[23] = (hm >> 2) & 0xff;
  b[24] = (hm >> 10) & 0x0f;
  return b;
}

function webpVp8LossyBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  u32leAt(b, 4, 22);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x20], 12);
  u32leAt(b, 16, 12);
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b[26] = w & 0xff;
  b[27] = (w >> 8) & 0x3f;
  b[28] = h & 0xff;
  b[29] = (h >> 8) & 0x3f;
  return b;
}

function jpegBytes(w: number, h: number, app1Pad = 0): Uint8Array {
  const b = new Uint8Array(14 + app1Pad);
  b[0] = 0xff;
  b[1] = 0xd8;
  let off = 2;
  if (app1Pad > 0) {
    b[2] = 0xff;
    b[3] = 0xe1;
    u16beAt(b, 4, app1Pad);
    off += 2 + app1Pad;
  }
  b[off] = 0xff;
  b[off + 1] = 0xc0;
  u16beAt(b, off + 2, 10);
  b[off + 4] = 0x08;
  u16beAt(b, off + 5, h);
  u16beAt(b, off + 7, w);
  b[off + 9] = 0x01;
  return b;
}

const OFF_CFG = () => defaultConfig(200_000);
const ON_CFG = () => defaultConfig(200_000, { imageCompression: { enabled: true } });

const PHONE: ImageMeta = {
  mediaType: "image/png",
  base64Length: 2_000_000,
  width: 1568,
  height: 2248,
  billing: "pixels",
};
const DESKTOP: ImageMeta = {
  mediaType: "image/jpeg",
  base64Length: 1_800_000,
  width: 1920,
  height: 1080,
  billing: "pixels",
};
const SQUARE_PHOTO: ImageMeta = {
  mediaType: "image/jpeg",
  base64Length: 3_000_000,
  width: 2000,
  height: 2000,
  billing: "pixels",
};
const BANNER: ImageMeta = {
  mediaType: "image/png",
  base64Length: 900_000,
  width: 4000,
  height: 1000,
  billing: "pixels",
};

function shrinkRecord(
  ref: string,
  originalBytes: number,
  shrunkBytes: number,
  tokensBefore: number,
  tokensAfter: number,
): ImageShrinkRecord {
  return {
    ref,
    rawMessageId: `raw-${ref}`,
    mediaType: "image/png",
    format: "webp",
    originalBytes,
    shrunkBytes,
    tokensBefore,
    tokensAfter,
    createdAt: 1,
  };
}

function stateWithRefOnly(): CompressionState {
  const state = createInitialState();
  state.messageRefs.byRaw["raw-1"] = "m00001";
  state.messageRefs.byRef["m00001"] = "raw-1";
  return state;
}

function stateWithShrink(): CompressionState {
  const state = stateWithRefOnly();
  return recordImageShrink(state, shrinkRecord("m00001", 2_000_000, 180_000, 2125, 765));
}

test("pixelTileEstimate: known values and bounds", () => {
  assert.equal(pixelTileEstimate(1568, 2248), 2125);
  assert.equal(pixelTileEstimate(1920, 1080), 2125);
  assert.equal(pixelTileEstimate(512, 512), 765);
  assert.equal(pixelTileEstimate(100, 100), 765);
  assert.equal(pixelTileEstimate(3000, 3000), 2805);
  assert.equal(pixelTileEstimate(400, 5000), 765);
  assert.equal(pixelTileEstimate(0, 100), PIXEL_IMAGE_FALLBACK_TOKENS);
  assert.equal(pixelTileEstimate(Number.NaN, 100), PIXEL_IMAGE_FALLBACK_TOKENS);
});

test("estimateImageTokens: bytes mode counts ceil(base64len/4)", () => {
  assert.equal(estimateImageTokens({ mediaType: "image/png", base64Length: 1003 }), 251);
  assert.equal(
    estimateImageTokens({ mediaType: "image/png", base64Length: 1003, billing: "bytes" }),
    251,
  );
});

test("estimateImageTokens: pixels mode uses the tile model on known dims", () => {
  assert.equal(
    estimateImageTokens({
      mediaType: "image/png",
      base64Length: 0,
      width: 1568,
      height: 2248,
      billing: "pixels",
    }),
    2125,
  );
});

test("estimateImageTokens: pixels mode parses dims from the base64 head when absent", () => {
  const b64 = Buffer.from(pngBytes(1280, 960)).toString("base64");
  assert.equal(
    estimateImageTokens({
      mediaType: "image/png",
      base64Length: b64.length,
      base64: b64,
      billing: "pixels",
    }),
    pixelTileEstimate(1280, 960),
  );
});

test("estimateImageTokens: pixels mode falls back to 16384 for unknown dims", () => {
  assert.equal(PIXEL_IMAGE_FALLBACK_TOKENS, 16_384);
  assert.equal(
    estimateImageTokens({
      mediaType: "image/png",
      base64Length: 999_999,
      base64: "bm90YW4gaW1hZ2U=",
      billing: "pixels",
    }),
    PIXEL_IMAGE_FALLBACK_TOKENS,
  );
});

test("parseImageDimensions: PNG / GIF / BMP / WebP variants", () => {
  assert.deepEqual(parseImageDimensions(pngBytes(1280, 960)), { width: 1280, height: 960 });
  assert.deepEqual(parseImageDimensions(gifBytes(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(parseImageDimensions(bmpBytes(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(parseImageDimensions(bmpBytes(1024, -768)), { width: 1024, height: 768 });
  assert.deepEqual(parseImageDimensions(webpVp8xBytes(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(parseImageDimensions(webpVp8lBytes(100, 200)), { width: 100, height: 200 });
  assert.deepEqual(parseImageDimensions(webpVp8LossyBytes(800, 600)), { width: 800, height: 600 });
});

test("parseImageDimensions: JPEG SOF scan incl. APP1 skip", () => {
  assert.deepEqual(parseImageDimensions(jpegBytes(1280, 960)), { width: 1280, height: 960 });
  assert.deepEqual(parseImageDimensions(jpegBytes(1920, 1080, 60)), { width: 1920, height: 1080 });
});

test("parseImageDimensions: unknown or truncated inputs → undefined", () => {
  assert.equal(parseImageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), undefined);
  assert.equal(parseImageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), undefined);
  assert.equal(parseImageDimensions(new Uint8Array([])), undefined);
});

test("parseImageDimensionsFromBase64: round-trips headers; JPEG needs the extended scan", () => {
  const png = Buffer.from(pngBytes(1568, 2248)).toString("base64");
  assert.deepEqual(parseImageDimensionsFromBase64(png), { width: 1568, height: 2248 });
  const jpeg = Buffer.from(jpegBytes(1920, 1080, 60)).toString("base64");
  assert.deepEqual(parseImageDimensionsFromBase64(jpeg), { width: 1920, height: 1080 });
  assert.equal(parseImageDimensionsFromBase64(""), undefined);
  assert.equal(parseImageDimensionsFromBase64("bm90YW4gaW1hZ2U="), undefined);
});

test("heuristic classifier: aspect band + short-side floor", () => {
  const c = DEFAULT_SCREENSHOT_CLASSIFIER;
  assert.equal(c.name, "heuristic-v1");
  assert.equal(c.isScreenshotLike(PHONE), true);
  assert.equal(c.isScreenshotLike(DESKTOP), true);
  assert.equal(c.isScreenshotLike(SQUARE_PHOTO), false);
  assert.equal(c.isScreenshotLike(BANNER), false);
  assert.equal(c.isScreenshotLike({ ...PHONE, width: 640, height: 960 }), false);
  assert.equal(c.isScreenshotLike({ mediaType: "image/png", base64Length: 1000 }), false);
});

test("heuristic classifier: custom options", () => {
  const c = createHeuristicClassifier({ aspectRatioMin: 2.0, aspectRatioMax: 3.0, minShortSide: 100 });
  assert.equal(
    c.isScreenshotLike({ mediaType: "image/png", base64Length: 0, width: 100, height: 300 }),
    true,
  );
  assert.equal(
    c.isScreenshotLike({ mediaType: "image/png", base64Length: 0, width: 800, height: 1200 }),
    false,
  );
});

test("decideImageRoute: disabled ⇒ byte-identical pass-through battery", () => {
  const metas: ImageMeta[] = [
    PHONE,
    DESKTOP,
    SQUARE_PHOTO,
    BANNER,
    { mediaType: "application/pdf", base64Length: 5_000_000 },
    { mediaType: "image/png", base64Length: 100 },
  ];
  for (const meta of metas) {
    const d = decideImageRoute(meta, OFF_CFG());
    assert.equal(d.action, "pass");
    assert.equal(d.reason, "disabled");
    assert.equal(d.recipe, undefined);
  }
});

test("decideImageRoute: screenshot-like ≥ minTokens ⇒ downsample with recipe", () => {
  const d = decideImageRoute(PHONE, ON_CFG());
  assert.equal(d.action, "downsample");
  assert.equal(d.reason, "downsample");
  assert.equal(d.estimatedTokens, 2125);
  assert.deepEqual(d.recipe, { maxDimension: 1280, quality: 80, format: "webp" });
});

test("decideImageRoute: below-min-tokens passes untouched", () => {
  const meta: ImageMeta = {
    mediaType: "image/png",
    base64Length: 2000,
    width: 1568,
    height: 2248,
    billing: "bytes",
  };
  const d = decideImageRoute(meta, ON_CFG());
  assert.equal(d.action, "pass");
  assert.equal(d.reason, "below-min-tokens");
  assert.equal(d.estimatedTokens, 500);
});

test("decideImageRoute: non-screenshot-like and non-image pass untouched", () => {
  assert.equal(decideImageRoute(SQUARE_PHOTO, ON_CFG()).reason, "not-screenshot-like");
  assert.equal(decideImageRoute(BANNER, ON_CFG()).reason, "not-screenshot-like");
  assert.equal(
    decideImageRoute({ mediaType: "application/pdf", base64Length: 5_000_000 }, ON_CFG()).reason,
    "not-an-image",
  );
  assert.equal(
    decideImageRoute(
      { mediaType: "image/png", base64Length: 1_000_000, billing: "pixels" },
      ON_CFG(),
    ).reason,
    "not-screenshot-like",
  );
});

test("decideImageRoute: custom config values flow into the recipe", () => {
  const cfg = defaultConfig(200_000, {
    imageCompression: { enabled: true, minTokens: 100, maxDimension: 1000, quality: 60, format: "jpeg" },
  });
  const d = decideImageRoute(PHONE, cfg);
  assert.deepEqual(d.recipe, { maxDimension: 1000, quality: 60, format: "jpeg" });
});

test("decideImageRoute: pluggable classifier injection", () => {
  const alwaysTrue = { name: "always", isScreenshotLike: () => true };
  const alwaysFalse = { name: "never", isScreenshotLike: () => false };
  assert.equal(decideImageRoute(SQUARE_PHOTO, ON_CFG(), alwaysTrue).action, "downsample");
  assert.equal(decideImageRoute(PHONE, ON_CFG(), alwaysFalse).action, "pass");
  assert.equal(decideImageRoute(PHONE, ON_CFG(), alwaysFalse).reason, "not-screenshot-like");
});

test("decideImageRoute: deterministic across repeated calls", () => {
  const metas: ImageMeta[] = [
    PHONE,
    DESKTOP,
    SQUARE_PHOTO,
    BANNER,
    { mediaType: "image/png", base64Length: 12_345, billing: "pixels" },
  ];
  for (const meta of metas) {
    const first = decideImageRoute(meta, ON_CFG());
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(decideImageRoute(meta, ON_CFG()), first);
    }
  }
});

test("recordImageShrink: appends record and bumps cumulative stats", () => {
  let state = createInitialState();
  state = recordImageShrink(state, shrinkRecord("m00001", 2_000_000, 180_000, 2125, 765));
  assert.equal(state.stats.imagesShrunk, 1);
  assert.equal(state.stats.imageBytesSaved, 1_820_000);
  assert.equal(state.stats.imageTokensSaved, 1360);
  assert.equal(state.imageShrinks?.length, 1);
  state = recordImageShrink(state, shrinkRecord("m00002", 1_000_000, 900_000, 2125, 765));
  assert.equal(state.stats.imagesShrunk, 2);
  assert.equal(state.stats.imageBytesSaved, 1_920_000);
});

test("recordImageShrink: negative deltas clamp to zero; works on pre-feature state shape", () => {
  const legacy = createInitialState();
  delete legacy.imageShrinks;
  delete legacy.imageFullRestored;
  delete legacy.stats.imagesShrunk;
  const grown = recordImageShrink(legacy, shrinkRecord("m00001", 1000, 1200, 700, 900));
  assert.equal(grown.stats.imageBytesSaved, 0);
  assert.equal(grown.stats.imageTokensSaved, 0);
  assert.equal(grown.imageShrinks?.length, 1);
});

test("imageShrinksForRef filters by ref", () => {
  let state = stateWithShrink();
  state = recordImageShrink(state, shrinkRecord("m00002", 1000, 500, 100, 50));
  assert.equal(imageShrinksForRef(state, "m00001").length, 1);
  assert.equal(imageShrinksForRef(state, "m00002").length, 1);
  assert.equal(imageShrinksForRef(state, "m00003").length, 0);
});

test("applyImageFull: happy path marks sticky restore", () => {
  const state = stateWithShrink();
  const out = applyImageFull({ ref: "m00001", state, config: ON_CFG() });
  assert.equal(out.ok, true);
  assert.match(out.resultText, /^restored original-resolution image\(s\) for m00001 \(1 image\)/);
  assert.deepEqual(out.state.imageFullRestored, ["m00001"]);
  assert.equal(isImageFullRestored(out.state, "m00001"), true);
});

test("applyImageFull: idempotent second call", () => {
  const first = applyImageFull({ ref: "m00001", state: stateWithShrink(), config: ON_CFG() });
  const second = applyImageFull({ ref: "m00001", state: first.state, config: ON_CFG() });
  assert.equal(second.ok, true);
  assert.match(second.resultText, /^already restored \(m00001\)/);
  assert.deepEqual(second.state.imageFullRestored, ["m00001"]);
});

test("applyImageFull: failure modes use the FAILED marker", () => {
  const state = stateWithShrink();

  const unknown = applyImageFull({ ref: "m00099", state, config: ON_CFG() });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.resultText.startsWith(IMAGE_FULL_FAILURE_MARKER));
  assert.match(unknown.resultText, /ref m00099 does not exist/);

  const noShrink = applyImageFull({ ref: "m00001", state: stateWithRefOnly(), config: ON_CFG() });
  assert.equal(noShrink.ok, false);
  assert.ok(noShrink.resultText.startsWith(IMAGE_FULL_FAILURE_MARKER));
  assert.match(noShrink.resultText, /no downscaled image/);

  const disabled = applyImageFull({ ref: "m00001", state, config: OFF_CFG() });
  assert.equal(disabled.ok, false);
  assert.ok(disabled.resultText.startsWith(IMAGE_FULL_FAILURE_MARKER));
  assert.match(disabled.resultText, /image compression is disabled/);
  assert.equal(disabled.state, state);
});

test("resetImageFullState: clears ref-keyed entries, keeps stats and blocks", () => {
  const state = stateWithShrink();
  const restored = applyImageFull({ ref: "m00001", state, config: ON_CFG() }).state;
  const reset = resetImageFullState(restored);
  assert.deepEqual(reset.imageFullRestored, []);
  assert.deepEqual(reset.imageShrinks, []);
  assert.equal(reset.stats.imagesShrunk, 1);
  assert.equal(reset.stats.imageBytesSaved, 1_820_000);
  assert.equal(isImageFullRestored(reset, "m00001"), false);
});

test("buildImageFullSystemNote: byte-stable, count-aware, mentions the contract", () => {
  const a = buildImageFullSystemNote(3);
  assert.equal(a, buildImageFullSystemNote(3));
  assert.notEqual(a, buildImageFullSystemNote(4));
  assert.match(a, /\[Downscaled screenshots: 3 image\(s\)/);
  assert.match(a, /image_full/);
  assert.match(a, /"mNNNNN"/);
});

test("parseImageFullInput: object, JSON string, aliases, trim", () => {
  assert.deepEqual(parseImageFullInput({ ref: "m00001" }), { ref: "m00001" });
  assert.deepEqual(parseImageFullInput('{"ref":"m00002"}'), { ref: "m00002" });
  assert.deepEqual(parseImageFullInput({ messageId: "m00003" }), { ref: "m00003" });
  assert.deepEqual(parseImageFullInput({ of: "m00004" }), { ref: "m00004" });
  assert.deepEqual(parseImageFullInput({ ref: "  m00005  " }), { ref: "m00005" });
  assert.deepEqual(parseImageFullInput({ ref: "m00001" }, "call-9"), {
    ref: "m00001",
    callId: "call-9",
  });
});

test("parseImageFullInput: rejects malformed payloads with warnings", () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.equal(parseImageFullInput(42, undefined, warn), null);
  assert.equal(parseImageFullInput(null, undefined, warn), null);
  assert.equal(parseImageFullInput("not json", undefined, warn), null);
  assert.equal(parseImageFullInput({ summary: "x" }, undefined, warn), null);
  assert.equal(parseImageFullInput({ ref: "   " }, undefined, warn), null);
  assert.equal(warnings.length, 5);
  assert.match(warnings[0], /^\[acp-image-full-input\] rejected:/);
});

test("image_full tool schemas: three wire shapes, required ref", () => {
  assert.equal(IMAGE_FULL_TOOL_NAME, "image_full");
  assert.equal(IMAGE_FULL_TOOL.name, "image_full");
  assert.deepEqual(IMAGE_FULL_TOOL.input_schema.required, ["ref"]);
  assert.equal(IMAGE_FULL_TOOL.input_schema.properties.ref.type, "string");
  assert.equal(IMAGE_FULL_TOOL_OPENAI.type, "function");
  assert.equal(IMAGE_FULL_TOOL_OPENAI.function.name, "image_full");
  assert.deepEqual(IMAGE_FULL_TOOL_OPENAI.function.parameters.required, ["ref"]);
  assert.equal(IMAGE_FULL_TOOL_RESPONSES.type, "function");
  assert.deepEqual(IMAGE_FULL_TOOL_RESPONSES.parameters.required, ["ref"]);
});

test("defaultConfig: imageCompression defaults are off with issue spec values", () => {
  assert.deepEqual(defaultConfig(200_000).imageCompression, {
    enabled: false,
    minTokens: 512,
    maxDimension: 1280,
    quality: 80,
    format: "webp",
  });
  assert.deepEqual(DEFAULT_IMAGE_COMPRESSION_CONFIG, defaultConfig(200_000).imageCompression);
});

test("defaultConfig: sub-field merge preserves other defaults (absorb-style)", () => {
  const cfg = defaultConfig(200_000, { imageCompression: { enabled: true } });
  assert.deepEqual(cfg.imageCompression, {
    enabled: true,
    minTokens: 512,
    maxDimension: 1280,
    quality: 80,
    format: "webp",
  });
  assert.equal(resolveImageCompressionConfig(cfg).enabled, true);
});

test("validateConfig: rejects invalid imageCompression fields", () => {
  const good = validateConfig(
    defaultConfig(200_000, {
      imageCompression: { enabled: true, minTokens: 0, maxDimension: 16, quality: 1, format: "png" },
    }),
  );
  assert.deepEqual(good.filter((e) => e.startsWith("imageCompression")), []);
  const bad = validateConfig(
    defaultConfig(200_000, {
      imageCompression: { enabled: true, minTokens: -1, maxDimension: 8, quality: 0, format: "gif" },
    }),
  );
  assert.deepEqual(bad, [
    "imageCompression.minTokens must be finite and >= 0",
    "imageCompression.maxDimension must be an integer >= 16",
    "imageCompression.quality must be in [1, 100]",
    'imageCompression.format must be "webp", "jpeg", or "png"',
  ]);
});

test("createInitialState seeds image counters and empty sticky arrays", () => {
  const s = createInitialState();
  assert.deepEqual(s.stats, {
    tokensCompressed: 0,
    compressionCount: 0,
    absorbedTokens: 0,
    imagesShrunk: 0,
    imageBytesSaved: 0,
    imageTokensSaved: 0,
    storedCount: 0,
    retrievalCount: 0,
  });
  assert.deepEqual(s.imageFullRestored, []);
  assert.deepEqual(s.imageShrinks, []);
});

test("mergeCompressionState carries image fields through persist/load", () => {
  const state = stateWithShrink();
  const restored = applyImageFull({ ref: "m00001", state, config: ON_CFG() }).state;
  const merged = mergeCompressionState(restored);
  assert.deepEqual(merged.imageFullRestored, ["m00001"]);
  assert.equal(merged.imageShrinks?.length, 1);
  const freshMerged = mergeCompressionState({ blocks: [] } as CompressionState);
  assert.deepEqual(freshMerged.imageFullRestored, []);
  assert.deepEqual(freshMerged.imageShrinks, []);
});
