import type { Prompts } from "../prompts.js";
import type { CompressPromptSections, ToolPrompts } from "../surface-config.js";
import type { NudgePromptSections } from "../nudge-text.js";
import type { PackSurface, PromptPackFile } from "./types.js";

const PROMPT_RULE_KEYS = [
  "compressPhilosophy",
  "howToCompressRules",
  "tier2DistillRules",
  "tier3CondenseRules",
] as const satisfies readonly (keyof Prompts)[];

const COMPRESS_SECTION_KEYS = [
  "acpTags",
  "tools",
  "summariesInContext",
  "textProtocol",
  "textTools",
  "functionTools",
] as const satisfies readonly (keyof CompressPromptSections)[];

const NUDGE_SECTION_KEYS = [
  "efficiencyNote",
  "emergencyHeader",
  "t2Guidance",
  "t3Guidance",
] as const satisfies readonly (keyof NudgePromptSections)[];

function pickSection(
  raw: unknown,
  keys: readonly string[],
): Record<string, string | null> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" || value === null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickToolPrompts(raw: unknown): ToolPrompts | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: ToolPrompts = {};
  for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const src = value as Record<string, unknown>;
    const entry: {
      description?: string;
      paramDescriptions?: Record<string, string>;
    } = {};
    if (typeof src.description === "string")
      entry.description = src.description;
    if (
      src.paramDescriptions &&
      typeof src.paramDescriptions === "object" &&
      !Array.isArray(src.paramDescriptions)
    ) {
      const params: Record<string, string> = {};
      for (const [name, description] of Object.entries(
        src.paramDescriptions as Record<string, unknown>,
      )) {
        if (typeof description === "string") params[name] = description;
      }
      if (Object.keys(params).length > 0) entry.paramDescriptions = params;
    }
    if (Object.keys(entry).length > 0) out[tool] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Narrow a raw pack file into a sanitized {@link PackSurface}. Unknown keys,
 * wrong types, and empty results are dropped — a bad pack degrades to "no
 * override", never corrupts a good default. `adapters` is kept opaquely when
 * it is a plain object (shallow-copied so later mutation cannot reach the
 * source file's parsed tree).
 */
export function sanitizePackSurface(
  pack: PromptPackFile | null | undefined,
): PackSurface {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return {};
  const surface: PackSurface = {};

  const prompts: Partial<Prompts> = {};
  const rawPrompts = pack.prompts;
  if (
    rawPrompts &&
    typeof rawPrompts === "object" &&
    !Array.isArray(rawPrompts)
  ) {
    for (const key of PROMPT_RULE_KEYS) {
      const value = (rawPrompts as Record<string, unknown>)[key];
      if (typeof value === "string")
        (prompts as Record<string, string>)[key] = value;
    }
  }
  if (Object.keys(prompts).length > 0) surface.prompts = prompts;

  const promptSections = pickSection(
    pack.promptSections,
    COMPRESS_SECTION_KEYS,
  );
  if (promptSections)
    surface.promptSections = promptSections as CompressPromptSections;

  const nudgeSections = pickSection(pack.nudgeSections, NUDGE_SECTION_KEYS);
  if (nudgeSections)
    surface.nudgeSections = nudgeSections as NudgePromptSections;

  const toolPrompts = pickToolPrompts(pack.toolPrompts);
  if (toolPrompts) surface.toolPrompts = toolPrompts;

  if (
    pack.adapters &&
    typeof pack.adapters === "object" &&
    !Array.isArray(pack.adapters)
  ) {
    surface.adapters = { ...(pack.adapters as Record<string, unknown>) };
  }
  return surface;
}
