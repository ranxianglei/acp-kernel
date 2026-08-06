import type {
  CoreMessage,
  CompressionState,
  MessageRefMap,
  RenderConfig,
} from "./types.js";
import { refForRaw, BLOCKED_REF } from "./refs.js";
import type { PipelineNode, PipelineContext, NodeIO } from "./pipeline.js";

export interface RenderOptions {
  skipToolMessages?: boolean;
}

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

export function renderMessage(
  message: CoreMessage,
  map: MessageRefMap,
  countTokens: (text: string) => number,
  options?: RenderOptions,
): CoreMessage {
  const ref = refForRaw(map, message.id);
  if (!ref || ref === BLOCKED_REF) return message;

  if (
    options?.skipToolMessages &&
    (message.contentType === "tool-call" ||
      message.contentType === "tool-result")
  ) {
    return message;
  }

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
  options?: RenderOptions,
): CoreMessage[] {
  const map = state.messageRefs;
  return messages.map((message) =>
    renderMessage(message, map, countTokens, options),
  );
}

export function optionsFromConfig(
  config?: { render?: RenderConfig },
): RenderOptions | undefined {
  if (config?.render?.skipToolMessageTags) {
    return { skipToolMessages: true };
  }
  return undefined;
}

export const renderRefsNode: PipelineNode = {
  name: "render-refs",
  run(io: NodeIO, ctx: PipelineContext): NodeIO {
    return {
      ...io,
      messages: renderVisibleRefs(
        io.messages,
        io.state,
        ctx.countTokens,
        optionsFromConfig(ctx.config),
      ),
    };
  },
};
