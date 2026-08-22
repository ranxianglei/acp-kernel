import type { CompressRangeSpec } from "./types.js";

/** Why a salvage/parse path was taken. Surfaced in logs so operators can see
 *  how often weak models fall off the strict-JSON path — the ~50% arg-failure
 *  class of issues (see billion-context-omp#121) becomes measurable instead of
 *  a silent `{}`. */
export type SalvageLayer =
  | "json" // strict JSON.parse succeeded
  | "json-fenced" // stripped ```json fences, then parsed
  | "json-repaired" // fixed trailing commas / raw newlines inside strings, then parsed
  | "array-prefix" // truncated content array: salvaged complete prefix entries
  | "field-regex"; // last resort: per-field regex extraction

export interface SalvageResult {
  ranges: CompressRangeSpec[];
  layer: SalvageLayer;
  /** Human-readable note for logs: what was wrong with the raw input. */
  note: string;
}

const REF_RE = /(?:startId|startRef)["']?\s*[:=]?\s*["']?(m\d{4,7})["']?/i;
const END_RE = /(?:endId|endRef)["']?\s*[:=]?\s*["']?(m\d{4,7})["']?/i;
/** Prose shape: "compress from m00150 to m00220". */
const FROMTO_RE = /from\s+(m\d{4,7})\s+(?:to|through|thru|-|–)\s+(m\d{4,7})/i;
const TOPIC_RE =
  /topic["']?\s*[:=]\s*(?:"([^"'\n]{1,80})"|([^\n"']{1,80}))/i;
/** Summary value: quoted JSON string, or a `key: value` line running to EOL/next key. */
const SUMMARY_RE =
  /summary["']?\s*[:=]?\s*(?:"((?:[^"\\]|\\.)*)"|((?:[^"\n])[^\n]*))/i;

function stripFences(s: string): string {
  return s
    .replace(/^\uFEFF/, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** Escape raw control characters that appear inside JSON string literals when
 *  a model emits unescaped newlines/tabs in a summary. Outside-of-string
 *  newlines (structural whitespace) are legal JSON and left untouched. */
function repairStringLiterals(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr && c === "\\") {
      out += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr && (c === "\n" || c === "\r" || c === "\t")) {
      out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t";
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

interface RawRange {
  startId?: unknown;
  startRef?: unknown;
  endId?: unknown;
  endRef?: unknown;
  summary?: unknown;
  topic?: unknown;
}

function toSpec(r: RawRange): CompressRangeSpec | null {
  const startRef = typeof r.startId === "string" ? r.startId : typeof r.startRef === "string" ? r.startRef : undefined;
  const endRef = typeof r.endId === "string" ? r.endId : typeof r.endRef === "string" ? r.endRef : undefined;
  const summary = typeof r.summary === "string" ? r.summary : undefined;
  if (!startRef || !endRef || !summary || !summary.trim()) return null;
  const topic = typeof r.topic === "string" && r.topic.trim() ? r.topic : undefined;
  return { startRef, endRef, summary, ...(topic ? { topic } : {}) };
}

/** Find the longest prefix of `content`-array entries that each parse as
 *  complete objects. Stops at the first entry that is truncated/malformed. */
function salvageArrayPrefix(arr: unknown[]): CompressRangeSpec[] {
  const out: CompressRangeSpec[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") break;
    const spec = toSpec(item as RawRange);
    if (!spec) break; // incomplete entry — everything after it is suspect
    out.push(spec);
  }
  return out;
}

/** Salvage complete entries from a truncated payload by scanning for
 *  balanced `{...}` objects and parsing each individually. Works whether the
 *  truncation happened inside the `content` array or inside a wrapper object
 *  (`{"content":[...]}` cut mid-way — the wrapper never closes, so the whole
 *  payload can't parse; the inner complete entries still can). Recovered
 *  entries must still carry all required fields (a half-written summary is
 *  rejected by the summary-min-length gate downstream, so no data-loss risk). */
function salvageTruncatedArray(raw: string): CompressRangeSpec[] {
  const out: CompressRangeSpec[] = [];
  let depth = 0;
  let inStr = false;
  /** Stack of `{` offsets (with the depth they opened at). Popping on `}`
   *  gives the matching open for every closed object — the innermost-object
   *  slice is parsed even when the surrounding wrapper never closes. */
  const entryStarts: Array<{ depth: number; i: number }> = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      depth++;
      entryStarts.push({ depth, i });
    } else if (c === "}") {
      depth--;
      const opened = entryStarts.pop();
      if (opened && opened.depth - 1 === depth) {
        try {
          const spec = toSpec(JSON.parse(raw.slice(opened.i, i + 1)) as RawRange);
          if (spec) out.push(spec);
        } catch {
          /* skip unparseable entry */
        }
      }
    }
  }
  return out;
}

function fieldRegexExtract(s: string): CompressRangeSpec[] {
  const out: CompressRangeSpec[] = [];
  // Split on entry boundaries: a startId occurrence begins a new range.
  const parts = s.split(/(?=(?:startId|startRef))/i).filter((p) => /startId|startRef/i.test(p));
  for (const p of parts) {
    const startRef = REF_RE.exec(p)?.[1];
    const endRef = END_RE.exec(p)?.[1];
    const sm = SUMMARY_RE.exec(p);
    const summary = sm?.[1] !== undefined ? unescapeJson(sm[1]) : sm?.[2]?.trim();
    const topic = TOPIC_RE.exec(p)?.[1] ?? TOPIC_RE.exec(p)?.[2];
    if (startRef && endRef && summary && summary.trim().length >= 50) {
      out.push({ startRef, endRef, summary, ...(topic ? { topic } : {}) });
    }
  }
  if (out.length > 0) return out;
  // Prose shape: "compress from m00150 to m00220. summary = ..." with no
  // explicit startId/endId keys at all.
  const ft = FROMTO_RE.exec(s);
  if (ft) {
    const sm = SUMMARY_RE.exec(s);
    const summary = sm?.[1] !== undefined ? unescapeJson(sm[1]) : sm?.[2]?.trim();
    const topic = TOPIC_RE.exec(s)?.[1] ?? TOPIC_RE.exec(s)?.[2];
    if (summary && summary.trim().length >= 50) {
      out.push({ startRef: ft[1]!, endRef: ft[2]!, summary, ...(topic ? { topic } : {}) });
    }
  }
  return out;
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/** Lenient compress-arguments parser shared by all billion-context hosts.
 *  Layers (each only runs if the previous one failed):
 *    1. strict JSON.parse of the whole payload
 *    2. strip ``` fences, parse
 *    3. repair trailing commas / raw newlines in string literals, parse
 *    4. truncated `content` array → salvage complete prefix entries
 *    5. per-field regex extraction (startId/endId/summary/topic)
 *  Returns ranges + the deepest layer reached + a log note. Never throws. */
export function salvageParseRanges(raw: string): SalvageResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ranges: [], layer: "json", note: "empty arguments" };

  // Layer 1-3: whole-payload JSON (with repairs). Also accepts the
  // JSON-stringified-content double-encoding some providers emit.
  const attempts: Array<{ s: string; layer: SalvageLayer; desc: string }> = [
    { s: trimmed, layer: "json", desc: "strict JSON" },
    { s: stripFences(trimmed), layer: "json-fenced", desc: "fenced JSON" },
    {
      s: stripTrailingCommas(repairStringLiterals(stripFences(trimmed))),
      layer: "json-repaired",
      desc: "repaired JSON",
    },
  ];
  for (const a of attempts) {
    if (!a.s) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(a.s);
    } catch {
      continue;
    }
    const ranges = extractRanges(parsed);
    if (ranges.length > 0) {
      return { ranges, layer: a.layer, note: `parsed as ${a.desc}` };
    }
  }

  // Layer 4: truncated content array — salvage complete entries.
  const salvaged = salvageTruncatedArray(trimmed);
  if (salvaged.length > 0) {
    return {
      ranges: salvaged,
      layer: "array-prefix",
      note: `truncated JSON; salvaged ${salvaged.length} complete range(s)`,
    };
  }

  // Layer 5: field-regex fallback.
  const regexRanges = fieldRegexExtract(trimmed);
  if (regexRanges.length > 0) {
    return {
      ranges: regexRanges,
      layer: "field-regex",
      note: `non-JSON text; regex-extracted ${regexRanges.length} range(s)`,
    };
  }

  return {
    ranges: [],
    layer: "field-regex",
    note: "unparseable: no layer produced ranges",
  };
}

/** Normalize a parsed JSON value into range specs. Handles:
 *  - {content: [...]} / {content: "JSON-string"} (double-encoded args)
 *  - bare [...] array
 *  - single {startId,...} object */
export function extractRanges(parsed: unknown): CompressRangeSpec[] {
  if (Array.isArray(parsed)) return salvageArrayPrefix(parsed);
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  let content: unknown = obj.content ?? obj.ranges;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return [];
    }
  }
  if (Array.isArray(content)) return salvageArrayPrefix(content);
  const single = toSpec(obj);
  return single ? [single] : [];
}
