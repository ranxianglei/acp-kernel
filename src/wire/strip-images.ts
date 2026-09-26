// Wire-level removal of HISTORICAL image payloads. Image bytes ride along
// verbatim on every request even after compression folds the surrounding text
// (the codecs move images out of CoreMessage.text into sidecars, so the raw
// payload is forwarded regardless of what got summarized). When a host opts in,
// every message EXCEPT the most recent `keepRecent` has its image parts dropped
// before the wire rebuild; an image-only message collapses to a "[image]" text
// placeholder so message count / role ordering stay stable. Images nested in
// tool results (anthropic `tool_result.content`, Responses tool-output `output`,
// Gemini `functionResponse.parts`) are stripped the same way (Gemini: image
// MIME types only); the tool result
// itself and its call id are kept, and an emptied Gemini `parts` is dropped
// because FunctionResponsePart admits no text. Pure over the RAW parsed body;
// returns the input reference unchanged when nothing changed.
// Content-hash message ids shift once per message (tool results included) when
// it ages out of the recent-N window (self-healing downstream via orphan-GC:
// a tool result whose call was folded is dropped by the orphan strip in prune,
// never sent unpaired). Shared across hosts
// (proxy + in-process adapters) so "which field carries an image" has one home.

export type StripProtocol =
  "anthropic" | "openai" | "responses" | "google" | null;

export interface StripResult {
  body: unknown;
  removed: number;
}

const IMAGE_PLACEHOLDER = "[image]";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isImagePart(
  protocol: Exclude<StripProtocol, null>,
  part: unknown,
): boolean {
  if (!isObj(part)) return false;
  if (protocol === "responses") return part.type === "input_image";
  if (protocol === "openai") return part.type === "image_url";
  // Gemini carries image payloads in two nested part variants (inline bytes,
  // or a Files API reference); both are raw base64/remote bytes.
  if (protocol === "google")
    return isObj(part.inlineData) || isObj(part.fileData);
  return part.type === "image";
}

function placeholderContent(
  protocol: Exclude<StripProtocol, null>,
): Record<string, unknown>[] {
  // Gemini parts have no `type` discriminator — a text part is just {text}.
  if (protocol === "google") return [{ text: IMAGE_PLACEHOLDER }];
  const type = protocol === "responses" ? "input_text" : "text";
  return [{ type, text: IMAGE_PLACEHOLDER }];
}

// functionResponse.parts also carries documents (e.g. application/pdf), so
// only image MIME types are stripped there.
function isGoogleNestedImage(part: unknown): boolean {
  if (!isObj(part)) return false;
  const media = isObj(part.inlineData) ? part.inlineData : part.fileData;
  return (
    isObj(media) &&
    typeof media.mimeType === "string" &&
    media.mimeType.startsWith("image/")
  );
}

function stripNestedImages(
  protocol: Exclude<StripProtocol, null>,
  part: unknown,
): { part: unknown; removed: number } {
  if (!isObj(part)) return { part, removed: 0 };
  if (
    protocol === "anthropic" &&
    part.type === "tool_result" &&
    Array.isArray(part.content)
  ) {
    const inner = part.content as unknown[];
    const kept = inner.filter((p) => !isImagePart(protocol, p));
    const removed = inner.length - kept.length;
    if (removed === 0) return { part, removed: 0 };
    return {
      part: {
        ...part,
        content: kept.length > 0 ? kept : placeholderContent(protocol),
      },
      removed,
    };
  }
  if (
    protocol === "google" &&
    isObj(part.functionResponse) &&
    Array.isArray(part.functionResponse.parts)
  ) {
    const fr = part.functionResponse;
    // Gemini 3 lets `response` point at a part via {"$ref": displayName};
    // dropping the part would leave that pointer dangling.
    if (JSON.stringify(fr.response ?? null).includes('"$ref"'))
      return { part, removed: 0 };
    const inner = fr.parts as unknown[];
    const kept = inner.filter((p) => !isGoogleNestedImage(p));
    const removed = inner.length - kept.length;
    if (removed === 0) return { part, removed: 0 };
    // FunctionResponsePart admits only media variants, so no text placeholder.
    const { parts: _, ...rest } = fr;
    return {
      part: {
        ...part,
        functionResponse: kept.length > 0 ? { ...fr, parts: kept } : rest,
      },
      removed,
    };
  }
  return { part, removed: 0 };
}

function stripParts(
  protocol: Exclude<StripProtocol, null>,
  parts: unknown[],
): { parts: unknown[]; removed: number } | null {
  let removed = 0;
  const kept: unknown[] = [];
  for (const p of parts) {
    if (isImagePart(protocol, p)) {
      removed++;
      continue;
    }
    const nested = stripNestedImages(protocol, p);
    removed += nested.removed;
    kept.push(nested.part);
  }
  if (removed === 0) return null;
  return {
    parts: kept.length > 0 ? kept : placeholderContent(protocol),
    removed,
  };
}

/** Drop image parts from every message older than the most recent `keepRecent`.
 *  `protocol` selects the wire dialect; `null` (unparseable) is a no-op. Returns
 *  `{ body, removed }` where `body` is the input reference untouched (and
 *  `removed` is 0) when there was nothing to strip. */
export function stripHistoricalImages(
  body: unknown,
  protocol: StripProtocol,
  keepRecent: number,
): StripResult {
  if (!protocol || !isObj(body)) return { body, removed: 0 };
  const recentCount = Math.max(0, Math.floor(keepRecent));

  if (protocol === "responses") {
    const input = body.input;
    if (!Array.isArray(input)) return { body, removed: 0 };
    const cutoff = input.length - recentCount;
    let removed = 0;
    let touched = false;
    const nextInput = input.map((item, i) => {
      if (i >= cutoff || !isObj(item)) return item;
      const key =
        item.type === "function_call_output" ||
        item.type === "custom_tool_call_output"
          ? "output"
          : "content";
      if (!Array.isArray(item[key])) return item;
      const r = stripParts("responses", item[key] as unknown[]);
      if (!r) return item;
      removed += r.removed;
      touched = true;
      return { ...item, [key]: r.parts };
    });
    if (!touched) return { body, removed: 0 };
    return { body: { ...body, input: nextInput }, removed };
  }

  // Gemini: the conversation lives in `contents`, each content carrying a
  // `parts` array (no `content` field, no per-part `type` discriminator).
  if (protocol === "google") {
    const contents = body.contents;
    if (!Array.isArray(contents)) return { body, removed: 0 };
    const cutoff = contents.length - recentCount;
    let removed = 0;
    let touched = false;
    const nextContents = contents.map((c, i) => {
      if (i < cutoff && isObj(c) && Array.isArray(c.parts)) {
        const r = stripParts("google", c.parts as unknown[]);
        if (r) {
          removed += r.removed;
          touched = true;
          return { ...c, parts: r.parts };
        }
      }
      return c;
    });
    if (!touched) return { body, removed: 0 };
    return { body: { ...body, contents: nextContents }, removed };
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, removed: 0 };
  const cutoff = messages.length - recentCount;
  let removed = 0;
  let touched = false;
  const nextMessages = messages.map((m, i) => {
    if (i < cutoff && isObj(m) && Array.isArray(m.content)) {
      const r = stripParts(protocol, m.content as unknown[]);
      if (r) {
        removed += r.removed;
        touched = true;
        return { ...m, content: r.parts };
      }
    }
    return m;
  });
  if (!touched) return { body, removed: 0 };
  return { body: { ...body, messages: nextMessages }, removed };
}
