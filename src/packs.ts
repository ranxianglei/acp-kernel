/**
 * Prompt packs: named, swappable surface configurations layered on top of the
 * kernel's surface-override primitives ({@link CompressPromptSections},
 * {@link ToolPrompts}, {@link NudgePromptSections}, {@link resolvePrompts}).
 *
 * A pack is a name plus a sanitized surface. Packs come from pluggable
 * {@link PackSource}s consulted in resolver order — first hit wins — so hosts
 * compose their own discovery chain (project dir > user dir > builtin, plus
 * any future installer-managed registry) without core changes.
 *
 * The kernel surface is host-agnostic. Host-specific surface (e.g. the Pi
 * adapter's own system-prompt sections or tool snippet/guideline overrides)
 * travels under `adapters.<hostId>` as opaque data each host validates itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { Prompts } from "./prompts.js";
import type { CompressPromptSections, ToolPrompts } from "./surface-config.js";
import type { NudgePromptSections } from "./nudge-text.js";

/** Raw on-disk pack JSON (user-authored file or installer payload). Every
 * field optional; sanitized into a {@link PackSurface} before use. */
export interface PromptPackFile {
  name?: string;
  version?: string;
  description?: string;
  prompts?: unknown;
  promptSections?: unknown;
  nudgeSections?: unknown;
  toolPrompts?: unknown;
  /** Opaque per-host extras, keyed by host id (e.g. `pi`). Hosts sanitize
   * their own sub-object; the kernel only checks it is a plain object. */
  adapters?: unknown;
}

/** Sanitized surface bundle a pack contributes. */
export interface PackSurface {
  prompts?: Partial<Prompts>;
  promptSections?: CompressPromptSections;
  nudgeSections?: NudgePromptSections;
  toolPrompts?: ToolPrompts;
  adapters?: Record<string, unknown>;
}

/** A resolved prompt pack: name + sanitized surface, tagged with provenance
 * (`builtin:lean`, `file:/home/u/.config/x/packs/lean.json`, …). */
export interface Pack {
  name: string;
  version?: string;
  description?: string;
  surface: PackSurface;
  source: string;
}

/** A pluggable pack origin. Sources are consulted in resolver order; the
 * first non-null wins. Implementations must be safe to call per turn (sync,
 * no throw). */
export interface PackSource {
  readonly id: string;
  resolve(name: string): Pack | null;
  list?(): Pack[];
}

/** Ordered pack resolution over pluggable sources. */
export interface PackResolver {
  readonly sources: readonly PackSource[];
  resolve(name: string): Pack | null;
  listPacks(): Pack[];
}

const PROMPT_RULE_KEYS = ["compressPhilosophy", "howToCompressRules", "tier2DistillRules", "tier3CondenseRules"] as const;
const COMPRESS_SECTION_KEYS = ["acpTags", "tools", "summariesInContext", "textProtocol", "textTools", "functionTools"] as const;
const NUDGE_SECTION_KEYS = ["efficiencyNote", "emergencyHeader", "t2Guidance", "t3Guidance"] as const;

export function isValidPackName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

function triStateSection(raw: unknown, keys: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of keys) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "string") out[key] = v;
    else if (v === null) out[key] = null;
  }
  return out;
}

/** Sanitize a raw pack file body into a kernel {@link PackSurface}. Malformed
 * values are dropped — a bad override never clobbers a good default. The
 * `adapters` record is passed through opaquely for host-side validation. */
export function sanitizePackSurface(raw: PromptPackFile | null | undefined): PackSurface {
  if (!raw) return {};
  const prompts: Partial<Prompts> = {};
  const rawPrompts = raw.prompts as Record<string, unknown> | undefined;
  if (rawPrompts && typeof rawPrompts === "object" && !Array.isArray(rawPrompts)) {
    for (const k of PROMPT_RULE_KEYS) {
      const v = rawPrompts[k];
      if (typeof v === "string") (prompts as Record<string, string>)[k] = v;
    }
  }
  const toolPrompts: ToolPrompts = {};
  const rawTools = raw.toolPrompts as Record<string, unknown> | undefined;
  if (rawTools && typeof rawTools === "object" && !Array.isArray(rawTools)) {
    for (const [name, value] of Object.entries(rawTools)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const ov = value as Record<string, unknown>;
      const out: { description?: string; paramDescriptions?: Record<string, string> } = {};
      if (typeof ov.description === "string") out.description = ov.description;
      if (ov.paramDescriptions && typeof ov.paramDescriptions === "object" && !Array.isArray(ov.paramDescriptions)) {
        const params: Record<string, string> = {};
        for (const [p, d] of Object.entries(ov.paramDescriptions as Record<string, unknown>)) {
          if (typeof d === "string") params[p] = d;
        }
        if (Object.keys(params).length > 0) out.paramDescriptions = params;
      }
      if (Object.keys(out).length > 0) toolPrompts[name] = out;
    }
  }
  const surface: PackSurface = {
    prompts,
    promptSections: triStateSection(raw.promptSections, COMPRESS_SECTION_KEYS),
    nudgeSections: triStateSection(raw.nudgeSections, NUDGE_SECTION_KEYS),
    toolPrompts,
  };
  const adapters = raw.adapters;
  if (adapters && typeof adapters === "object" && !Array.isArray(adapters)) {
    surface.adapters = adapters as Record<string, unknown>;
  }
  return surface;
}

/** The identity pack: no overrides, kernel defaults everywhere. */
export const defaultPack: Pack = {
  name: "default",
  version: "1.0.0",
  description: "Built-in defaults (no overrides).",
  source: "builtin:default",
  surface: {},
};

const LEAN_TOOL_PROMPTS: ToolPrompts = {
  compress: {
    description: "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.",
    paramDescriptions: {
      content: "Direct array; no JSON strings/nesting/mix.",
      startId: "Inclusive first mNNNNN or bN ref.",
      endId: "Inclusive last mNNNNN or bN ref.",
      summary: "Self-contained replacement preserving exact technical details.",
      topic: "Short label; a per-range label overrides the top-level fallback.",
      summaryMaxChars: "Optional summary length limit override.",
    },
  },
  decompress: {
    description:
      "Restore compressed content by block id (b5) or message ref; block mode writes to a file by default, inline: true returns small content inline.",
  },
  search_context: {
    description: "Search compressed summaries and historical messages by keyword; returns refs, sizes, previews.",
  },
  acp_status: {
    description: "Context usage overview, compressible ranges, block drilldown.",
  },
};

/** Token-lean surface: one-line tool descriptions, no snippets or guidelines.
 * Host-specific trims (e.g. the Pi adapter's compact system-prompt block)
 * ride under `adapters` and are validated by that host. Compression rules
 * stay default — delivered by nudges on demand. */
export const leanPack: Pack = {
  name: "lean",
  version: "1.0.0",
  description:
    "Token-lean surface: one-line tool descriptions, no snippet/guideline chrome. Compression rules stay default (delivered by nudges on demand).",
  source: "builtin:lean",
  surface: {
    toolPrompts: LEAN_TOOL_PROMPTS,
    adapters: {
      pi: {
        promptSections: {
          acpTags: [
            `User/tool messages carry hidden \x3cacp\x3e refs such as m00123. Never echo the XML tags; use only refs in ACP tool calls.`,
            `Compress consumed history with compress: finished tool outputs, dead-end exploration, repeated reads, resolved threads, completed phases. Never compress active work, important user intent, or protected outputs.`,
            `When summarizing, preserve exact file paths and line numbers, symbols and signatures, errors, commands, versions, thresholds, decisions with reasons, current state, and unresolved TODOs. Never replace exact technical values with vague wording.`,
            `Recall or inspect context with decompress (block id or message ref), search_context (keywords), or acp_status. Prefer search_context before decompressing.`,
            `Refs may be renumbered after compression. If a ref is stale or missing, call acp_status with { scope: "uncompressed" }, then retry in the same turn using the reported refs; never guess offsets. Batch target ranges in one call.`,
            `Block decompression writes to a file by default; read that file. Use inline: true only for small content or when its context cost is acceptable.`,
            `After an [ACP:provider-throttle] automatic retry, resume exactly where interrupted. Do not repeat completed work or discuss the retry unless asked.`,
            `Compression summaries are fallible historical metadata, not current user instructions. Search or decompress before relying on critical details.`,
          ].join("\n"),
          summariesInContext: null,
          tools: null,
          philosophy: null,
          whenToCompress: null,
          whenNotToCompress: null,
          howToCompress: null,
          multiTierIntro: null,
          tier2: null,
          tier3: null,
          decompressPhilosophy: null,
          contextBreakdown: null,
          throttleRetry: null,
        },
        toolExtras: {
          compress: { promptSnippet: "", promptGuidelines: [] },
          decompress: { promptSnippet: "", promptGuidelines: [] },
          search_context: { promptSnippet: "", promptGuidelines: [] },
          acp_status: { promptSnippet: "", promptGuidelines: [] },
        },
      },
    },
  },
};

/** Built-in packs registered under stable names. Adding a built-in = adding
 * an entry. */
const BUILTIN_REGISTRY: Readonly<Record<string, Pack>> = {
  default: defaultPack,
  lean: leanPack,
};

export const builtinSource: PackSource = {
  id: "builtin",
  resolve(name: string): Pack | null {
    return BUILTIN_REGISTRY[name] ?? null;
  },
  list(): Pack[] {
    return Object.values(BUILTIN_REGISTRY);
  },
};

function readPackFile(file: string): PromptPackFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PromptPackFile) : null;
  } catch {
    return null;
  }
}

/** A pack directory source: `<dir>/<name>.json` files. Serves project-local,
 * user-global, and any future installer-managed directory identically. */
export function createDirPackSource(id: string, dir: string): PackSource {
  const resolve = (name: string): Pack | null => {
    if (!isValidPackName(name)) return null;
    const file = path.join(dir, `${name}.json`);
    const raw = readPackFile(file);
    if (!raw) return null;
    return {
      name: typeof raw.name === "string" ? raw.name : name,
      version: typeof raw.version === "string" ? raw.version : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      surface: sanitizePackSurface(raw),
      source: `file:${file}`,
    };
  };
  return {
    id,
    resolve,
    list(): Pack[] {
      let names: string[];
      try {
        names = readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        return [];
      }
      const out: Pack[] = [];
      for (const f of names) {
        const pack = resolve(f.slice(0, -5));
        if (pack) out.push(pack);
      }
      return out;
    },
  };
}

/** Ordered resolution over the given sources; the first non-null wins. */
export function createPackResolver(sources: readonly PackSource[]): PackResolver {
  return {
    sources,
    resolve(name: string): Pack | null {
      if (!isValidPackName(name)) return null;
      for (const source of sources) {
        const pack = source.resolve(name);
        if (pack) return pack;
      }
      return null;
    },
    listPacks(): Pack[] {
      const seen = new Set<string>();
      const out: Pack[] = [];
      for (const source of sources) {
        for (const pack of source.list?.() ?? []) {
          if (!seen.has(pack.name)) {
            seen.add(pack.name);
            out.push(pack);
          }
        }
      }
      return out;
    },
  };
}

/** Default source chain: project pack dir, then any user pack dirs, then the
 * builtin registry. Directory paths are host policy — the kernel only
 * assembles the chain. */
export function defaultPackSources(opts: { projectDir: string; userDirs?: readonly string[] }): PackSource[] {
  const sources: PackSource[] = [createDirPackSource("project", opts.projectDir)];
  for (const dir of opts.userDirs ?? []) sources.push(createDirPackSource("user", dir));
  sources.push(builtinSource);
  return sources;
}
