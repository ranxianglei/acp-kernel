import type { Pack, PackSource } from "./types.js";

export const defaultPack: Pack = {
  name: "default",
  version: "1.0.0",
  description: "Built-in defaults (no overrides).",
  source: "builtin:default",
  surface: {},
};

// The tag name is escaped so no live <acp> tag is embedded in prompt text.
const LEAN_ACP_TAGS = [
  "ACP TAGS",
  "",
  "User/tool messages carry hidden \\x3cacp\\x3e refs such as m00123. Never echo the XML tags; use only refs in ACP tool calls.",
].join("\n");

export const leanPack: Pack = {
  name: "lean",
  version: "1.0.0",
  description:
    "Token-lean surface adapted from kunkun9527/billion-context-pi-lean: compact ACP-tags section plus one-line tool descriptions for the four ACP tools. Compression rules stay default (load-bearing, delivered by the builders and nudges); host-specific lean surfaces ride under adapters.<hostId>.",
  source: "builtin:lean",
  surface: {
    promptSections: {
      acpTags: LEAN_ACP_TAGS,
    },
    toolPrompts: {
      compress: {
        description:
          "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.",
        paramDescriptions: {
          content: "Direct array; no JSON strings/nesting/mix.",
          startId: "Inclusive first mNNNNN or bN ref.",
          endId: "Inclusive last mNNNNN or bN ref.",
          summary:
            "Self-contained replacement preserving exact technical details.",
          topic:
            "Short label; a per-range label overrides the top-level fallback.",
          summaryMaxChars: "Optional summary length limit override.",
        },
      },
      decompress: {
        description:
          "Restore compressed content by block id (b5) or message ref; one tier up by default, full:true restores originals, toFile writes to a file instead of context.",
      },
      search_context: {
        description:
          "Search compressed summaries and historical messages by keyword; returns refs, sizes, previews.",
      },
      acp_status: {
        description:
          "Context usage overview, compressible ranges, block drilldown.",
      },
    },
  },
};

/** Built-in packs registered under their stable names. Adding a built-in = adding an entry. */
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
