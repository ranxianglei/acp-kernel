import type { CoreMessage, CompressionState, MessageRefMap } from "./types.js";
import { refForRaw, BLOCKED_REF } from "./refs.js";
import type { PipelineNode, PipelineContext, NodeIO } from "./pipeline.js";

/** Format token count: <1K raw, <10K "X.YK", >=10K "XK". */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return (tokens / 1000).toFixed(1) + "K";
  return Math.round(tokens / 1000) + "K";
}

function classifyType(message: CoreMessage): string {
  if (
    message.contentType === "tool-call" ||
    message.contentType === "tool-result"
  ) {
    return message.toolName || "tool";
  }
  return message.contentType;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LT = "\x3c";
const GT = "\x3e";
const TAG_OPEN = LT + "acp ";
const TAG_CLOSE = LT + "/acp" + GT;

function acpTag(ref: string, tokens: number, type: string): string {
  return TAG_OPEN + 'tokens="' + formatTokens(tokens) + '" type="' + type + '"' + GT + ref + TAG_CLOSE;
}

function renderMessage(
  message: CoreMessage,
  map: MessageRefMap,
  countTokens: (text: string) => number,
): CoreMessage {
  const ref = refForRaw(map, message.id);
  if (!ref || ref === BLOCKED_REF) return message;

  // Strip own stale tag BEFORE computing tokens (idempotency).
  // Match the message's own ref only — foreign tags survive (content-corruption fix).
  const ownTagRe = new RegExp(
    "^" + escapeRegex(TAG_OPEN) + "[^>]*" + GT + escapeRegex(ref) + escapeRegex(TAG_CLOSE) + "\\n?",
  );
  const cleanText = (message.text || "").replace(ownTagRe, "");

  const tokens = countTokens(cleanText);
  const type = classifyType(message);
  const prefix = acpTag(ref, tokens, type) + "\n";

  if (!cleanText) return { ...message, text: prefix };
  return { ...message, text: prefix + cleanText };
}

export function renderVisibleRefs(
  messages: CoreMessage[],
  state: CompressionState,
  countTokens: (text: string) => number = (text) =>
    Math.ceil(text.length / 4),
): CoreMessage[] {
  const map = state.messageRefs;
  return messages.map((message) =>
    renderMessage(message, map, countTokens),
  );
}

export const renderRefsNode: PipelineNode = {
  name: "render-refs",
  run(io: NodeIO, ctx: PipelineContext): NodeIO {
    return {
      ...io,
      messages: renderVisibleRefs(io.messages, io.state, ctx.countTokens),
    };
  },
};
