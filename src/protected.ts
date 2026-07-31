import type { Config, CoreMessage } from "./types.js";

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
  if (msg.contentType !== "tool-call" || !msg.toolName) return false;

  for (const pattern of config.protectedTools) {
    if (matchToolPattern(msg.toolName, pattern)) return true;
  }

  if (config.isToolProtected?.(msg.toolName, msg.text)) return true;

  return false;
}
