import type { CoreMessage, CompressionState, MessageRefMap } from "./types.js";
import { refForRaw, BLOCKED_REF } from "./refs.js";
import type { PipelineNode, PipelineContext, NodeIO } from "./pipeline.js";

function refTag(ref: string): string {
  return `[${ref}] `;
}

function renderMessage(message: CoreMessage, map: MessageRefMap): CoreMessage {
  const ref = refForRaw(map, message.id);
  if (!ref || ref === BLOCKED_REF) return message;
  const tag = refTag(ref);
  if (!message.text) return { ...message, text: tag };
  let text = message.text;
  while (text.startsWith(tag)) text = text.slice(tag.length);
  return { ...message, text: tag + text };
}

export function renderVisibleRefs(
  messages: CoreMessage[],
  state: CompressionState,
): CoreMessage[] {
  const map = state.messageRefs;
  return messages.map((message) => renderMessage(message, map));
}

export const renderRefsNode: PipelineNode = {
  name: "render-refs",
  run(io: NodeIO, _ctx: PipelineContext): NodeIO {
    return {
      ...io,
      messages: renderVisibleRefs(io.messages, io.state),
    };
  },
};
