/** Display labels for buildStatusPanel. The English defaults below are the
 *  key source of truth; hosts pass Partial<PanelLabels> to localize the panel
 *  (billion-context-pi issue #153). This is a DISPLAY-ONLY surface: these
 *  strings render in the terminal and never reach the model, so translating
 *  them cannot affect compression/nudge behavior.
 *
 *  Templates use `{name}` placeholders filled by fill(). Keys omitted by a
 *  host pack fall back to the English default per key (partial packs degrade
 *  gracefully instead of failing wholesale). */
export interface PanelLabels {
  /** Title rendered inside the decorative box. */
  title: string;
  /** Params: pct (number), used / limit (formatted token counts). */
  context: string;
  /** Params: growth (formatted). Line rendered only when growth > 0. */
  growth: string;
  /** Params: sent (formatted). */
  sent: string;
  /** Params: pct (number). Appended to the sent line only when a context
   *  limit is configured; omit the placeholder in a pack to drop it. */
  sentOfLimit: string;
  /** Params: only (formatted). Line rendered only when unprunedTokens is
   *  provided and the derived value is positive. */
  sessionOnly: string;
  breakdown: string;
  catTool: string;
  catSysPrompt: string;
  catText: string;
  catCode: string;
  catSummaries: string;
  /** Params: last / session (hit-rate strings), read / billed (formatted),
   *  requests (number). */
  promptCache: string;
  /** Params: tierInfo (string, empty when no tier), reason (verbatim model-
   *  facing text — keep it in your template verbatim). */
  nudgeActive: string;
  /** Params: tier (number). */
  nudgeTierInfo: string;
  /** Params: reason (verbatim model-facing text). */
  nudgeIdle: string;
  /** Params: active / total (numbers), tokens (formatted). Used for both the
   *  active and zero-active block counts. */
  blocksHeader: string;
  /** Rendered when no blocks exist at all. */
  blocksNone: string;
  tagVisibility: string;
}

export const DEFAULT_PANEL_LABELS: PanelLabels = {
  title: "ACP Context Analysis",
  context: "Context (session accounting, host footer scale): {pct}% ({used} / {limit}) — includes compressed originals; shrinks slower than the sent view",
  growth: "Growth: +{growth} since last nudge",
  sent: "Sent to LLM (after compression, est.): {sent}",
  sentOfLimit: " ({pct}% of limit)",
  sessionOnly: "Session-only (compressed originals, est.): {only} — pruned from every request; the footer/nudge still count them",
  breakdown: "Token Breakdown (sent view):",
  catTool: "Tool",
  catSysPrompt: "SysPrompt",
  catText: "Text",
  catCode: "Code",
  catSummaries: "Summaries",
  promptCache: "Prompt cache (provider-reported): {last} last · {session} session avg — {read} of {billed} billed prompt tokens served from cache ({requests} req)",
  nudgeActive: "Nudge: ACTIVE{tierInfo} — {reason}",
  nudgeTierInfo: " [T{tier} distillation]",
  nudgeIdle: "Nudge: idle — {reason}",
  blocksHeader: "Blocks: {active} active / {total} total ({tokens} tokens compressed, cumulative)",
  blocksNone: "Blocks: none (nothing compressed yet)",
  tagVisibility: "Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.",
};

/** Merge a partial label pack over the English defaults, ignoring entries
 *  whose value is not a string (explicit `undefined` from a config merge,
 *  `null`, …). A plain `{ ...defaults, ...pack }` spread lets one undefined
 *  key blank out its default and crash the display-width renderers. */
export function resolvePanelLabels(labels?: Partial<PanelLabels>): PanelLabels {
  const out: PanelLabels = { ...DEFAULT_PANEL_LABELS };
  if (!labels) return out;
  for (const key of Object.keys(labels) as Array<keyof PanelLabels>) {
    const value = labels[key];
    if (typeof value === "string" && Object.hasOwn(DEFAULT_PANEL_LABELS, key)) out[key] = value;
  }
  return out;
}

/** Substitute `{name}` placeholders from params. Unknown placeholders are
 *  left intact so a typo in a host pack is visible on screen instead of
 *  silently dropping information. */
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

// Legacy fixed-width title box (inner width 45). Frozen so the default
// output stays byte-identical for hosts that don't pass labels.
const LEGACY_TITLE_BOX = [
  "╭─────────────────────────────────────────────╮",
  "│           ACP Context Analysis              │",
  "╰─────────────────────────────────────────────╯",
];
const MIN_INNER_WIDTH = 45;

function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi syllables
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // halfwidth/fullwidth forms
    cp >= 0x20000; // CJK extensions and beyond
  return wide ? 2 : 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charDisplayWidth(ch);
  return w;
}

/** Pad s with trailing spaces to a DISPLAY width (wide chars count as two
 *  columns), keeping bar-chart columns aligned for CJK category labels.
 *  Identical to String.prototype.padEnd for ASCII input. */
export function padLabel(s: string, width: number): string {
  const dw = displayWidth(s);
  return dw >= width ? s : s + " ".repeat(width - dw);
}

/** Decorative title box, width-aware so CJK titles stay aligned (wide chars
 *  occupy two terminal columns). The exact default title renders the legacy
 *  fixed box; any other title gets a computed box that widens past
 *  MIN_INNER_WIDTH when the title is long. */
export function renderTitleBox(title: string): string[] {
  if (title === DEFAULT_PANEL_LABELS.title) return LEGACY_TITLE_BOX;
  const dw = displayWidth(title);
  const inner = Math.max(MIN_INNER_WIDTH, dw + 2);
  const padL = Math.floor((inner - dw) / 2);
  const padR = inner - dw - padL;
  return ["╭" + "─".repeat(inner) + "╮", `│${" ".repeat(padL)}${title}${" ".repeat(padR)}│`, "╰" + "─".repeat(inner) + "╯"];
}
