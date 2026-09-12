import type { Prompts } from "../prompts.js";
import type { CompressPromptSections, ToolPrompts } from "../surface-config.js";
import type { NudgePromptSections } from "../nudge-text.js";

/**
 * Raw on-disk pack JSON schema (user-authored file or future installer
 * payload). Every field optional and untyped: {@link sanitizePackSurface}
 * narrows it into a {@link PackSurface} before use, so a malformed pack
 * degrades to "no override" and never clobbers a good default.
 */
export interface PromptPackFile {
  name?: string;
  version?: string;
  description?: string;
  prompts?: unknown;
  promptSections?: unknown;
  nudgeSections?: unknown;
  toolPrompts?: unknown;
  adapters?: unknown;
}

/**
 * Sanitized surface bundle a pack contributes. Every field layers on the
 * kernel's surface primitives: `promptSections` applies through the three
 * `build*SystemPrompt` builders, `nudgeSections` through `renderNudgeText`,
 * `toolPrompts` through `applyAcpToolOverrides`. `adapters.<hostId>` is
 * opaque data owned by that host — the kernel stores but never interprets it.
 */
export interface PackSurface {
  /**
   * Load-bearing compression rules. Apply via resolvePrompts(surface.prompts,
   * { acknowledgeRisk: true }) — overriding them can degrade summary quality.
   */
  prompts?: Partial<Prompts>;
  promptSections?: CompressPromptSections;
  nudgeSections?: NudgePromptSections;
  toolPrompts?: ToolPrompts;
  adapters?: Record<string, unknown>;
}

/**
 * A resolved prompt pack: a name plus a sanitized surface, tagged with its
 * provenance (`builtin:lean`, `file:/home/u/.acp/packs/x.json`, …). Built-in
 * packs, user file packs, and future installer-managed packs all implement
 * this single contract.
 */
export interface Pack {
  name: string;
  version?: string;
  description?: string;
  surface: PackSurface;
  source: string;
}

/**
 * A pluggable pack origin. Sources are consulted in resolver order; the first
 * non-null wins. Implementations must be safe to call per turn (sync, no throw).
 */
export interface PackSource {
  readonly id: string;
  resolve(name: string): Pack | null;
  list?(): Pack[];
}

/**
 * Pack names are path-safe identifiers; also guards the `<dir>/<name>.json`
 * join in directory sources (rejects traversal and dot-leading names).
 */
export function isValidPackName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}
