import type { Config, CoreMessage } from "./types.js";

/** Tools that are ALWAYS protected, regardless of user config. These are ACP's
 *  own metadata tools whose records must remain in context: compress calls
 *  carry the summaries that decompress/search rely on, and the system prompt
 *  treats past compress calls as load-bearing metadata. Letting them be
 *  compressed away breaks decompress and the "summary is historical" contract. */
export const ALWAYS_PROTECTED_TOOLS = ["compress"] as const;

export function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}

export function isMessageProtected(
  msg: CoreMessage,
  config: Pick<Config, "protectedTools" | "isToolProtected">,
): boolean {
  // tool-result carries the same toolName as its tool-call (the host projects
  // it), so checking toolName covers both sides of a tool exchange.
  if (
    (msg.contentType !== "tool-call" && msg.contentType !== "tool-result") ||
    !msg.toolName
  ) {
    return false;
  }

  // Hard-coded protection: ACP metadata tools are never compressible.
  if ((ALWAYS_PROTECTED_TOOLS as readonly string[]).includes(msg.toolName)) {
    return true;
  }

  for (const pattern of config.protectedTools) {
    if (matchToolPattern(msg.toolName, pattern)) return true;
  }

  if (config.isToolProtected?.(msg.toolName, msg.text)) return true;

  return false;
}

/** Build the set of toolCallIds whose tool-call is protected. Use this to also
 *  protect tool-results that lack a toolName (common when the host projects a
 *  tool-result with only toolCallId). Without it, the result half of a
 *  protected tool exchange leaks into compressible ranges. */
export function collectProtectedToolCallIds(
  messages: CoreMessage[],
  config: Pick<Config, "protectedTools" | "isToolProtected">,
): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId && isMessageProtected(m, config)) {
      ids.add(m.toolCallId);
    }
  }
  return ids;
}

/** Like isMessageProtected, but also matches tool-results by toolCallId against
 *  the protected call set. Use when you have the full message list available. */
export function isMessageProtectedWithPairing(
  msg: CoreMessage,
  config: Pick<Config, "protectedTools" | "isToolProtected">,
  protectedCallIds: Set<string>,
): boolean {
  if (isMessageProtected(msg, config)) return true;
  if (
    msg.contentType === "tool-result" &&
    msg.toolCallId &&
    protectedCallIds.has(msg.toolCallId)
  ) {
    return true;
  }
  return false;
}
