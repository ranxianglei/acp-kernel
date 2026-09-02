import { prune } from "./prune.js";
import type { CompressionState, CoreMessage } from "./types.js";

export interface HandoffMeta {
  title?: string;
  label?: string;
  sessionId: string;
  contextTokens?: number;
  extraBullets?: string[];
}

export interface HandoffInput {
  coreMessages: CoreMessage[];
  state: CompressionState;
  full: boolean;
  meta: HandoffMeta;
}

export function renderMessage(m: CoreMessage): string {
  const parts: string[] = [];
  switch (m.contentType) {
    case "text":
      parts.push(m.text ?? "");
      break;
    case "tool-call":
      parts.push(`\`${m.toolName ?? "?"}(${m.toolCallId ?? ""})\` args: ${m.text ?? ""}`);
      break;
    case "tool-result":
      parts.push(`\`${m.toolName ?? "?"}(${m.toolCallId ?? ""})\` → ${m.text ?? ""}`);
      break;
    case "reasoning":
      parts.push(`_reasoning_: ${m.text ?? ""}`);
      break;
  }
  const body = parts.join("\n").trim();
  return body === "" ? "_(empty)_" : body + "\n";
}

export function renderHandoff(input: HandoffInput): string {
  const { coreMessages, state, full, meta } = input;
  const lines: string[] = [];
  lines.push("# billion-context session handoff");
  lines.push("");
  lines.push(`- title: ${meta.title ?? "(untitled)"}`);
  if (meta.label) lines.push(`- label: ${meta.label}`);
  lines.push(`- session id: ${meta.sessionId}`);
  for (const bullet of meta.extraBullets ?? []) lines.push(bullet);
  if (meta.contextTokens) lines.push(`- last context tokens: ~${meta.contextTokens}`);
  lines.push(`- compression blocks: ${state.blocks.length} (active ${state.blocks.filter((b) => b.active).length})`);
  lines.push("");
  const view = full ? coreMessages : prune(coreMessages, state);
  lines.push(full
    ? `## Full conversation (${coreMessages.length} messages)`
    : `## Conversation (folded view as the model saw it, ${coreMessages.length} client messages)`);
  lines.push("");
  if (view.length === 0) {
    lines.push("No conversation messages to export.");
    lines.push("");
  }
  let lastRole = "";
  for (const m of view) {
    if (m.role !== lastRole) {
      lines.push(`### ${m.role}`);
      lines.push("");
      lastRole = m.role;
    }
    lines.push(renderMessage(m));
  }
  lines.push("");
  return lines.join("\n");
}

export function matchSession<T extends { id: string }>(
  sessions: T[],
  selector: string,
  labelOf: (s: T) => string | undefined,
): T[] {
  const exact = sessions.filter((s) => s.id === selector);
  if (exact.length > 0) return exact;
  const byLabel = sessions.filter((s) => labelOf(s) === selector);
  if (byLabel.length > 0) return byLabel;
  return sessions.filter((s) => s.id.startsWith(selector) || (labelOf(s) ?? "").startsWith(selector));
}
