import { rawForRef } from "./refs.js";
import { IMAGE_FULL_TOOL_NAME } from "./compress-tools.js";
import type {
  Config,
  CompressionState,
  ImageBillingMode,
  ImageCompressionConfig,
  ImageFormat,
  ImageShrinkRecord,
} from "./types.js";

/**
 * Image pre-compression (#353, filed from billion-context#1095 analysis):
 * screenshot-like tool-result images are downscaled ONCE at arrival before
 * entering the wire; non-screenshot originals pass through untouched; the
 * lossy step is backstopped by the image_full restore channel.
 *
 * Kernel scope (pure, zero native deps): routing decision + recipe, billing-
 * aware token estimation (canonical copy — moved from billion-context
 * src/image-tokens.ts), image_full contract (arg parsing, sticky-restore
 * state machine, result strings, system-note fragment), shrink records and
 * stats counters on session state.
 *
 * Host scope (NOT here): executing the recipe with a real encoder
 * (deterministic resize fit-inside withoutEnlargement → flatten →
 * webp{quality} / jpeg{quality, mozjpeg} / png{compressionLevel:9}, keeping
 * the smaller of original vs encoded), sidecar file I/O under the #1097
 * store, wire-body substitution across protocols, plugin-manifest
 * registration, logging.
 *
 * Determinism is load-bearing: the downsampled bytes become the standing
 * wire content after arrival-time substitution; a non-deterministic recipe
 * would invalidate the provider prefix cache mid-session (same invariant as
 * #1097's placeholder determinism).
 */

export const DEFAULT_IMAGE_COMPRESSION_CONFIG: Required<ImageCompressionConfig> = {
  enabled: false,
  minTokens: 512,
  maxDimension: 1280,
  quality: 80,
  format: "webp",
};

/** Sub-field merge over defaults; hosts layer global → provider → model
 *  exactly like absorb (three levels). */
export function resolveImageCompressionConfig(
  config: Config,
): Required<ImageCompressionConfig> {
  return { ...DEFAULT_IMAGE_COMPRESSION_CONFIG, ...(config.imageCompression ?? {}) };
}

// ---------------------------------------------------------------------------
// Billing-aware image token estimation (canonical copy; ported from
// billion-context src/image-tokens.ts — the kernel now owns the math, hosts
// keep only the body-scanning wrapper that feeds ImageMeta in).
// ---------------------------------------------------------------------------

/** Pixels-mode fallback when dimensions cannot be parsed header-only: the
 *  worst-case high-detail bill. */
export const PIXEL_IMAGE_FALLBACK_TOKENS = 16_384;

const TILE_EDGE = 512;
const TILE_SHORT_SIDE = 768;
const TILE_MAX_EDGE = 2048;

export interface ImageDimensions {
  width: number;
  height: number;
}

// NoUncheckedIndexedAccess: out-of-range reads are impossible after each
// section's length guard, but the type system cannot see that — coalesce.
function byteAt(b: Uint8Array, off: number): number {
  return b[off] ?? 0;
}

function u16be(b: Uint8Array, off: number): number {
  return (byteAt(b, off) << 8) | byteAt(b, off + 1);
}

function u16le(b: Uint8Array, off: number): number {
  return byteAt(b, off) | (byteAt(b, off + 1) << 8);
}

function u32be(b: Uint8Array, off: number): number {
  return (
    (byteAt(b, off) << 24) |
    (byteAt(b, off + 1) << 16) |
    (byteAt(b, off + 2) << 8) |
    byteAt(b, off + 3)
  ) >>> 0;
}

function i32le(b: Uint8Array, off: number): number {
  return (
    byteAt(b, off) |
    (byteAt(b, off + 1) << 8) |
    (byteAt(b, off + 2) << 16) |
    (byteAt(b, off + 3) << 24)
  );
}

/** Header-only dimension parse: reads just enough leading bytes for container
 *  headers. Supports PNG / GIF / BMP / WebP (VP8X, VP8L, VP8 lossy) / JPEG
 *  (SOF segment scan). Unknown formats or truncated headers → undefined. */
export function parseImageDimensions(
  bytes: Uint8Array,
): ImageDimensions | undefined {
  const b = bytes;
  if (b.length < 10) return undefined;
  // PNG: 8-byte signature, IHDR holds width/height (BE u32) at offset 16.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return undefined;
    const w = u32be(b, 16);
    const h = u32be(b, 20);
    return w > 0 && h > 0 ? { width: w, height: h } : undefined;
  }
  // GIF: "GIF87a"/"GIF89a", logical screen size LE u16 at offsets 6/8.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const w = u16le(b, 6);
    const h = u16le(b, 8);
    return w > 0 && h > 0 ? { width: w, height: h } : undefined;
  }
  // BMP: "BM", BITMAPINFOHEADER at 14, width/height signed LE i32 at 18/22
  // (top-down bitmaps carry negative height).
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = i32le(b, 18);
    const h = Math.abs(i32le(b, 22));
    return w > 0 && h > 0 ? { width: w, height: h } : undefined;
  }
  // WebP: RIFF....WEBP + VP8X (extended canvas) / VP8L (lossless) / VP8 (lossy).
  // Each chunk carries its own required length (VP8L packs end at byte 24).
  if (
    b.length >= 20 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    if (b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58) {
      if (b.length < 30) return undefined;
      // VP8X: 4-byte flags field, then canvas width-1 / height-1 24-bit LE.
      const w = byteAt(b, 24) | (byteAt(b, 25) << 8) | (byteAt(b, 26) << 16);
      const h = byteAt(b, 27) | (byteAt(b, 28) << 8) | (byteAt(b, 29) << 16);
      return w > 0 && h > 0 ? { width: w + 1, height: h + 1 } : undefined;
    }
    if (b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x4c) {
      if (b.length < 25) return undefined;
      // VP8L: signature byte 0x2F, then a 4-byte pack: width-1 (14 bits),
      // height-1 (14 bits), version (4 bits).
      if (b[20] !== 0x2f) return undefined;
      const w = ((byteAt(b, 22) & 0x3f) << 8 | byteAt(b, 21)) + 1;
      const h =
        ((byteAt(b, 24) & 0x0f) << 10) | (byteAt(b, 23) << 2) | ((byteAt(b, 22) & 0xc0) >> 6);
      return w > 0 && h > 0 ? { width: w, height: h + 1 } : undefined;
    }
    if (b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x20) {
      if (b.length < 30) return undefined;
      // VP8 lossy: sync code 9D 01 2A, then actual width/height 14-bit fields
      // (no -1 encoding, unlike VP8X/VP8L).
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
      const w = u16le(b, 26) & 0x3fff;
      const h = u16le(b, 28) & 0x3fff;
      return w > 0 && h > 0 ? { width: w, height: h } : undefined;
    }
    return undefined;
  }
  // JPEG: walk segments until an SOFn marker (C0-CF excluding C4/C8/CC).
  if (b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 4 <= b.length) {
      if (b[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = byteAt(b, off + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        off += 2;
        continue;
      }
      if (marker === 0xda) break; // SOS with no SOF before it — malformed
      const segLen = u16be(b, off + 2);
      if (segLen < 2) break;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (off + 9 > b.length) break;
        const h = u16be(b, off + 5);
        const w = u16be(b, off + 7);
        if (w > 0 && h > 0) return { width: w, height: h };
        break;
      }
      off += 2 + segLen;
    }
  }
  return undefined;
}

const HEADER_SCAN_CHARS = 64;
const JPEG_SCAN_CHARS = 350_000;

/** Base64 convenience entry: decodes only the leading slice — enough for
 *  container headers (PNG/GIF/BMP/WebP within 64 chars; JPEG SOF within ~350K
 *  chars of EXIF bloat). Node-targeted (Buffer). */
export function parseImageDimensionsFromBase64(
  b64: string,
): ImageDimensions | undefined {
  if (typeof b64 !== "string" || b64.length === 0) return undefined;
  const head = parseImageDimensions(Buffer.from(b64.slice(0, HEADER_SCAN_CHARS), "base64"));
  if (head) return head;
  if (b64.startsWith("/9j/") && b64.length > HEADER_SCAN_CHARS) {
    return parseImageDimensions(Buffer.from(b64.slice(0, JPEG_SCAN_CHARS), "base64"));
  }
  return undefined;
}

/** OpenAI high-detail tile model: scale so the short side is at least 768
 *  (providers bill small images enlarged), cap the long side at 2048, then
 *  85 + 170 per 512×512 tile. Bounds ≈ [765, 2805]. */
export function pixelTileEstimate(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return PIXEL_IMAGE_FALLBACK_TOKENS;
  }
  let sw = width;
  let sh = height;
  const shortSide = Math.min(sw, sh);
  if (shortSide > 0 && shortSide < TILE_SHORT_SIDE) {
    const s = TILE_SHORT_SIDE / shortSide;
    sw *= s;
    sh *= s;
  }
  const longSide = Math.max(sw, sh);
  if (longSide > TILE_MAX_EDGE) {
    const s = TILE_MAX_EDGE / longSide;
    sw *= s;
    sh *= s;
  }
  const tiles = Math.ceil(sw / TILE_EDGE) * Math.ceil(sh / TILE_EDGE);
  return 85 + 170 * tiles;
}

/** One image attachment's metadata as seen by the routing decision. */
export interface ImageMeta {
  mediaType: string;
  /** Length of the base64 payload (characters). */
  base64Length: number;
  width?: number;
  height?: number;
  /** Upstream billing mode for this image. Default "bytes" (conservative). */
  billing?: ImageBillingMode;
  /** Optional base64 payload; only its leading decode budget is read, and
   *  only when width/height are missing in pixels mode. */
  base64?: string;
}

/** Billing-aware estimate of an image's token cost. Pixels mode uses the tile
 *  model on real dimensions (header-parsed from the payload head when absent);
 *  bytes mode counts ceil(base64len/4). Unknown dims in pixels mode fall back
 *  to PIXEL_IMAGE_FALLBACK_TOKENS. */
export function estimateImageTokens(meta: ImageMeta): number {
  const billing = meta.billing ?? "bytes";
  if (billing === "bytes") return Math.ceil(meta.base64Length / 4);
  const w = meta.width;
  const h = meta.height;
  if (w && h) return pixelTileEstimate(w, h);
  if (meta.base64) {
    const dims = parseImageDimensionsFromBase64(meta.base64);
    if (dims) return pixelTileEstimate(dims.width, dims.height);
  }
  return PIXEL_IMAGE_FALLBACK_TOKENS;
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

/** Pluggable screenshot classifier. v1 ships the heuristic below; a trained
 *  router slots in here later without pipeline changes. */
export interface ScreenshotClassifier {
  readonly name: string;
  isScreenshotLike(meta: ImageMeta): boolean;
}

export interface HeuristicClassifierOptions {
  /** Low end of the long/short aspect band. Default 1.4. */
  aspectRatioMin?: number;
  /** High end of the long/short aspect band. Default 2.6. */
  aspectRatioMax?: number;
  /** Short-side floor (px): below it even band-shaped images pass — small
   *  crops would be upscaled by the tile model and billed larger. Default 720. */
  minShortSide?: number;
}

/** v1 heuristic: long/short aspect ratio within [1.4, 2.6] AND short side ≥
 *  720 px. Missing dimensions → false (conservative: never route what cannot
 *  be classified). Known limitation: 3:2 photos (ratio 1.5) false-positive as
 *  screenshots until a trained router slots into the classifier interface. */
export function createHeuristicClassifier(
  options: HeuristicClassifierOptions = {},
): ScreenshotClassifier {
  const aspectRatioMin = options.aspectRatioMin ?? 1.4;
  const aspectRatioMax = options.aspectRatioMax ?? 2.6;
  const minShortSide = options.minShortSide ?? 720;
  return {
    name: "heuristic-v1",
    isScreenshotLike(meta) {
      const w = meta.width;
      const h = meta.height;
      if (!w || !h || w <= 0 || h <= 0) return false;
      const shortSide = Math.min(w, h);
      if (shortSide < minShortSide) return false;
      const ratio = Math.max(w, h) / shortSide;
      return ratio >= aspectRatioMin && ratio <= aspectRatioMax;
    },
  };
}

export const DEFAULT_SCREENSHOT_CLASSIFIER: ScreenshotClassifier =
  createHeuristicClassifier();

export type ImageRouteReason =
  | "disabled"
  | "not-an-image"
  | "below-min-tokens"
  | "not-screenshot-like"
  | "downsample";

/** Downsample parameters the host executes with its own encoder (sharp etc.). */
export interface DownsampleRecipe {
  /** Longest side (px) after resize. */
  maxDimension: number;
  quality: number;
  format: ImageFormat;
}

export interface ImageRoutingDecision {
  action: "pass" | "downsample";
  reason: ImageRouteReason;
  /** Token estimate of the ORIGINAL payload (host log lines). */
  estimatedTokens: number;
  recipe?: DownsampleRecipe;
}

/** Pure + deterministic: same input + config → identical decision, always.
 *  The host executes the returned recipe exactly once, at arrival time. */
export function decideImageRoute(
  meta: ImageMeta,
  config: Config,
  classifier: ScreenshotClassifier = DEFAULT_SCREENSHOT_CLASSIFIER,
): ImageRoutingDecision {
  const cfg = resolveImageCompressionConfig(config);
  const estimatedTokens = estimateImageTokens(meta);
  if (!cfg.enabled) return { action: "pass", reason: "disabled", estimatedTokens };
  if (!meta.mediaType.startsWith("image/")) {
    return { action: "pass", reason: "not-an-image", estimatedTokens };
  }
  if (estimatedTokens < cfg.minTokens) {
    return { action: "pass", reason: "below-min-tokens", estimatedTokens };
  }
  if (!classifier.isScreenshotLike(meta)) {
    return { action: "pass", reason: "not-screenshot-like", estimatedTokens };
  }
  return {
    action: "downsample",
    reason: "downsample",
    estimatedTokens,
    recipe: { maxDimension: cfg.maxDimension, quality: cfg.quality, format: cfg.format },
  };
}

// ---------------------------------------------------------------------------
// image_full restore channel
// ---------------------------------------------------------------------------

/** Failure-prefix convention (mirrors absorb's marker style): any resultText
 *  starting with this marks a rejected call. */
export const IMAGE_FULL_FAILURE_MARKER = "[image_full FAILED:";

/** Byte-stable system-prompt fragment; count = images downscaled so far in
 *  this session. Hosts inject it while the feature is enabled and shrinks
 *  exist. */
export function buildImageFullSystemNote(count: number): string {
  return `[Downscaled screenshots: ${count} image(s) were reduced before entering context. If you cannot read details (text, colors, alignment) in a reduced image, call ${IMAGE_FULL_TOOL_NAME} with that message's ref ("mNNNNN") to restore the original resolution.]`;
}

/** Content-store entry-kind contract for image originals (#1097 store layout:
 *  binary sidecar entries under the same mNNNNN key scheme, append-once,
 *  drop-on-fold). The kernel owns this shape; file I/O stays host-side. */
export interface ImageStoreEntry {
  kind: "image";
  ref: string;
  rawMessageId: string;
  mediaType: string;
  originalBytes: number;
  createdAt: number;
}

export interface ParsedImageFull {
  ref: string;
  callId?: string;
}

/** Lenient arg parser mirroring parseAbsorbInput: accepts object or JSON-
 *  string payloads, key aliases (ref/messageId/of), trims whitespace. */
export function parseImageFullInput(
  input: unknown,
  callId?: string,
  onWarn?: (message: string) => void,
): ParsedImageFull | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (input && typeof input === "object") {
    obj = input as Record<string, unknown>;
  }
  if (!obj) {
    onWarn?.(`[acp-image-full-input] rejected: not an object (${typeof input})`);
    return null;
  }
  let ref: string | undefined;
  for (const key of ["ref", "messageId", "of"]) {
    const value = obj[key];
    if (typeof value === "string") {
      ref = value;
      break;
    }
  }
  if (typeof ref !== "string") {
    onWarn?.(
      `[acp-image-full-input] rejected: need ref (string); keys: ${Object.keys(obj).join(",")}`,
    );
    return null;
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    onWarn?.("[acp-image-full-input] rejected: ref is empty");
    return null;
  }
  return { ref: trimmed, ...(callId ? { callId } : {}) };
}

/** Append one shrink record and bump cumulative stats. Pure: returns new state. */
export function recordImageShrink(
  state: CompressionState,
  record: ImageShrinkRecord,
): CompressionState {
  const bytesSaved = Math.max(0, record.originalBytes - record.shrunkBytes);
  const tokensSaved = Math.max(0, record.tokensBefore - record.tokensAfter);
  return {
    ...state,
    imageShrinks: [...(state.imageShrinks ?? []), record],
    stats: {
      ...state.stats,
      imagesShrunk: (state.stats.imagesShrunk ?? 0) + 1,
      imageBytesSaved: (state.stats.imageBytesSaved ?? 0) + bytesSaved,
      imageTokensSaved: (state.stats.imageTokensSaved ?? 0) + tokensSaved,
    },
  };
}

export function isImageFullRestored(state: CompressionState, ref: string): boolean {
  return (state.imageFullRestored ?? []).includes(ref);
}

export function imageShrinksForRef(
  state: CompressionState,
  ref: string,
): ImageShrinkRecord[] {
  return (state.imageShrinks ?? []).filter((r) => r.ref === ref);
}

export interface ImageFullInput {
  ref: string;
  state: CompressionState;
  config: Config;
}

export interface ImageFullOutcome {
  state: CompressionState;
  ok: boolean;
  resultText: string;
}

/** Sticky-restore state machine. Success marks the ref restored for the rest
 *  of the session (idempotent re-calls report "already restored"). Failure
 *  modes return ok:false with an [image_full FAILED: ...] resultText. Pure:
 *  returns new state. */
export function applyImageFull(input: ImageFullInput): ImageFullOutcome {
  const cfg = resolveImageCompressionConfig(input.config);
  const ref = input.ref.trim();
  if (!cfg.enabled) {
    return {
      state: input.state,
      ok: false,
      resultText: `${IMAGE_FULL_FAILURE_MARKER} image compression is disabled in this session — no image was ever downscaled]`,
    };
  }
  const rawId = rawForRef(input.state.messageRefs, ref);
  if (!rawId) {
    return {
      state: input.state,
      ok: false,
      resultText: `${IMAGE_FULL_FAILURE_MARKER} ref ${ref} does not exist in this session]`,
    };
  }
  if (isImageFullRestored(input.state, ref)) {
    return {
      state: input.state,
      ok: true,
      resultText: `already restored (${ref}) — full resolution stays in effect for the rest of this session.`,
    };
  }
  const shrinks = imageShrinksForRef(input.state, ref);
  if (shrinks.length === 0) {
    return {
      state: input.state,
      ok: false,
      resultText: `${IMAGE_FULL_FAILURE_MARKER} no downscaled image is recorded for ${ref} — it was passed through untouched or never carried an image]`,
    };
  }
  return {
    state: {
      ...input.state,
      imageFullRestored: [...(input.state.imageFullRestored ?? []), ref],
    },
    ok: true,
    resultText: `restored original-resolution image(s) for ${ref} (${shrinks.length} image${shrinks.length === 1 ? "" : "s"}); full resolution applies for the rest of this session.`,
  };
}

/** Drop ref-keyed image_full state after a compaction reset (native-compaction
 *  archive, fork recovery, session restart). Refs are re-issued from m00001
 *  after a state reset, so stale entries would misattribute. Cumulative stats
 *  survive — they remain valid aggregates. Hosts MUST call this on every
 *  state reset. */
export function resetImageFullState(state: CompressionState): CompressionState {
  return { ...state, imageFullRestored: [], imageShrinks: [] };
}
