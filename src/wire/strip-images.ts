// Wire-level removal of HISTORICAL image payloads. Image bytes ride along
// verbatim on every request even after compression folds the surrounding text
// (the codecs move images out of CoreMessage.text into sidecars, so the raw
// payload is forwarded regardless of what got summarized). When a host opts in,
// every message EXCEPT the most recent `keepRecent` has its image parts dropped
// before the wire rebuild; an image-only message collapses to a "[image]" text
// placeholder so message count / role ordering stay stable. Pure over the RAW
// parsed body; returns the input reference unchanged when nothing changed.
// Content-hash message ids shift once per message when it ages out of the
// recent-N window (self-healing downstream via orphan-GC). Shared across hosts
// (proxy + in-process adapters) so "which field carries an image" has one home.

export type StripProtocol = "anthropic" | "openai" | "responses" | null;

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
  return part.type === "image";
}

function placeholderContent(
  protocol: Exclude<StripProtocol, null>,
): Record<string, unknown>[] {
  const type = protocol === "responses" ? "input_text" : "text";
  return [{ type, text: IMAGE_PLACEHOLDER }];
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
      if (i < cutoff && isObj(item) && Array.isArray(item.content)) {
        const content = item.content as unknown[];
        const imgs = content.filter((p) => isImagePart("responses", p)).length;
        if (imgs > 0) {
          removed += imgs;
          touched = true;
          const kept = content.filter((p) => !isImagePart("responses", p));
          return {
            ...item,
            content: kept.length > 0 ? kept : placeholderContent("responses"),
          };
        }
      }
      return item;
    });
    if (!touched) return { body, removed: 0 };
    return { body: { ...body, input: nextInput }, removed };
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, removed: 0 };
  const cutoff = messages.length - recentCount;
  let removed = 0;
  let touched = false;
  const nextMessages = messages.map((m, i) => {
    if (i < cutoff && isObj(m) && Array.isArray(m.content)) {
      const content = m.content as unknown[];
      const imgs = content.filter((p) => isImagePart(protocol, p)).length;
      if (imgs > 0) {
        removed += imgs;
        touched = true;
        const kept = content.filter((p) => !isImagePart(protocol, p));
        return {
          ...m,
          content: kept.length > 0 ? kept : placeholderContent(protocol),
        };
      }
    }
    return m;
  });
  if (!touched) return { body, removed: 0 };
  return { body: { ...body, messages: nextMessages }, removed };
}
