// Single lenient parser for compress tool arguments, with structured
// diagnostics for the failure shapes that actually occur in production.
//
// Models and LLM gateways do not always emit strict JSON for the compress
// tool call. Observed shapes:
//   - fenced JSON: "```json ... ```"
//   - trailing commas
//   - raw newlines inside string values (line-wrapped summaries)
//   - the whole arguments object stringified by the gateway (vLLM,
//     billion-context#176)
//   - single-quoted JSON: {'content': [...]} (weak local models,
//     billion-context#603 / omp#121)
//   - the stream cut off mid-arguments, leaving a truncated JSON prefix
//
// Hosts parse this on their own today: rebuild.ts (strict, silent skip),
// the billion-context proxy (strict, silent {}), billion-context-pi
// (strict, throw), billion-context-omp (strict, silent null). This module
// is the shared implementation the adapters converge on (acp-kernel#108).
//
// Salvage semantics: for truncated input, the complete entries of the
// `content` array are recovered from the surviving prefix. A partially
// written entry is dropped, never guessed. Diagnostics are data, not logs:
// adapters decide where to emit them (log line, debug event, tool text).

import type { CompressRangeSpec } from "./types.js";

export type CompressParseKind =
    | "ok"
    | "empty-input"
    | "not-object"
    | "missing-content"
    | "content-not-array"
    | "malformed-json"
    | "truncated"
    | "no-valid-ranges";

export interface CompressParseDiagnostics {
    /** true only when at least one range was recovered. */
    ok: boolean;
    /** Why the input parsed the way it did. */
    kind: CompressParseKind;
    /** True when the winning parse came from single→double quote repair. */
    quoteSalvage?: boolean;
    /** First 800 chars of the raw string input (string inputs only). */
    rawPrefix?: string;
    /** Raw string input length (string inputs only). */
    length?: number;
    /** Top-level keys of the parsed object — catches `content` vs `ranges` drift. */
    keys?: string[];
    /** Entries dropped because they were not valid ranges. */
    invalidItems: number;
    /** One human-readable reason per dropped entry (index-prefixed). */
    invalidReasons?: string[];
}

export interface ParsedCompressInput {
    ranges: CompressRangeSpec[];
    diagnostics: CompressParseDiagnostics;
}

/**
 * Parse compress tool arguments in any host wire shape.
 *
 * Accepts a decoded object, a JSON string (possibly fenced, trailing-comma,
 * raw-newline, or double-stringified), or a truncated JSON prefix (salvage
 * mode). Invalid entries are skipped, never fatal; the reason is in
 * `diagnostics.kind`.
 */
export function parseCompressArgs(input: unknown, opts?: { callId?: string }): ParsedCompressInput {
    const callId = opts?.callId;
    const diag: CompressParseDiagnostics = { ok: false, kind: "ok", invalidItems: 0 };

    if (input === null || input === undefined) {
        diag.kind = "empty-input";
        return finish([], diag);
    }

    if (typeof input === "string") {
        return parseStringInput(input, callId, diag);
    }

    if (typeof input !== "object" || Array.isArray(input)) {
        diag.kind = "not-object";
        return finish([], diag);
    }

    return parseObjectValue(input as Record<string, unknown>, callId, diag);
}

function parseStringInput(raw: string, callId: string | undefined, diag: CompressParseDiagnostics): ParsedCompressInput {
    diag.rawPrefix = raw.slice(0, 800);
    diag.length = raw.length;
    const cleaned = stripFence(raw.trim());
    const first = parseStringCore(cleaned, callId, diag);
    // Weak local models emit single-quoted args ({'content': [...]}). The
    // salvage regex only recognizes double-quoted "content", so a truncated
    // single-quoted prefix recovers nothing on the first pass. Retry once
    // with the quotes normalized; the retry wins only if it recovers strictly
    // more ranges, so valid input is never rewritten.
    if (first.ranges.length === 0 || first.diagnostics.invalidItems > 0) {
        const normalized = normalizeSingleQuotes(cleaned);
        if (normalized !== undefined) {
            const retryDiag: CompressParseDiagnostics = { ok: false, kind: "ok", invalidItems: 0 };
            retryDiag.rawPrefix = diag.rawPrefix;
            retryDiag.length = diag.length;
            const retry = parseStringCore(normalized, callId, retryDiag);
            if (retry.ranges.length > first.ranges.length) {
                retryDiag.quoteSalvage = true;
                return retry;
            }
        }
    }
    return first;
}

function parseStringCore(cleaned: string, callId: string | undefined, diag: CompressParseDiagnostics): ParsedCompressInput {
    if (cleaned === "") {
        diag.kind = "empty-input";
        return finish([], diag);
    }

    let value: unknown = tryParseLenient(cleaned);
    // One level of double-stringification: the host wrapped an already
    // stringified argument in another JSON string.
    if (typeof value === "string") {
        const inner = tryParseLenient(stripFence(value));
        if (inner !== undefined) value = inner;
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return parseObjectValue(value as Record<string, unknown>, callId, diag);
    }
    if (value !== undefined) {
        // Parsed, but not to an object: bare array, number, boolean, null.
        diag.kind = "not-object";
        return finish([], diag);
    }

    // Unparseable prefix: salvage the complete content-array entries.
    const entries = salvageContentEntries(cleaned);
    return finishSalvage(entries, callId, diag, looksTruncated(cleaned));
}

function parseObjectValue(value: Record<string, unknown>, callId: string | undefined, diag: CompressParseDiagnostics): ParsedCompressInput {
    diag.keys = Object.keys(value);
    const content = value["content"];
    if (content === undefined) {
        // Model drift: a single range at the top level (no content array).
        // The proxy defends against this shape; the kernel now owns it.
        const single = validateEntry(value, callId);
        if ("range" in single) {
            diag.kind = "ok";
            return finish([single.range], diag);
        }
        diag.kind = "missing-content";
        return finish([], diag);
    }

    let entries: unknown[];
    let salvaged = false;

    if (Array.isArray(content)) {
        entries = content;
    } else if (typeof content === "string") {
        // Stringified content array: vLLM-style gateways stringify nested
        // arrays, so `content` arrives as a JSON string of the array.
        const parsed = parseContentArray(content);
        if (parsed === null) {
            diag.kind = "content-not-array";
            return finish([], diag);
        }
        entries = parsed.entries;
        salvaged = parsed.salvaged;
        if (parsed.quoteRepaired) diag.quoteSalvage = true;
    } else {
        diag.kind = "content-not-array";
        return finish([], diag);
    }

    const { ranges, invalid, reasons } = validateEntries(entries, callId);
    // Top-level fallbacks: topic and summaryMaxChars apply to every range
    // that does not specify its own (omp/pi schemas define both at the top
    // level; per-entry values win).
    const topTopic = stringOr(value["topic"]);
    const topMaxChars = value["summaryMaxChars"];
    const hasTopMaxChars = typeof topMaxChars === "number" && Number.isFinite(topMaxChars);
    if (topTopic !== undefined || hasTopMaxChars) {
        for (const r of ranges) {
            if (r.topic === undefined && topTopic !== undefined) r.topic = topTopic;
            if (r.summaryMaxChars === undefined && hasTopMaxChars) r.summaryMaxChars = topMaxChars;
        }
    }
    diag.invalidItems = invalid;
    if (reasons.length > 0) diag.invalidReasons = reasons;
    diag.kind = salvaged ? "truncated" : ranges.length > 0 ? "ok" : "no-valid-ranges";
    return finish(ranges, diag);
}

function parseContentArray(s: string): { entries: unknown[]; salvaged: boolean; quoteRepaired?: boolean } | null {
    const cleaned = stripFence(s.trim());
    const direct = parseContentArrayCore(cleaned);
    if (direct !== null && direct.entries.length > 0) return direct;
    // Single-quoted array (weak local models): normalize once and re-run;
    // the retry is adopted only if it recovers strictly more entries.
    const normalized = normalizeSingleQuotes(cleaned);
    if (normalized !== undefined) {
        const retry = parseContentArrayCore(normalized);
        if (retry !== null && retry.entries.length > 0) return { ...retry, quoteRepaired: true };
    }
    return direct;
}

function parseContentArrayCore(s: string): { entries: unknown[]; salvaged: boolean } | null {
    let value: unknown = s === "" ? undefined : tryParseLenient(s);
    if (typeof value === "string") {
        value = tryParseLenient(stripFence(value));
    }
    if (Array.isArray(value)) {
        return { entries: value, salvaged: false };
    }
    if (value === undefined) {
        // Unparseable (usually truncated): recover the complete entries.
        const entries = salvageContentEntries('{"content": ' + s);
        return { entries, salvaged: entries.length > 0 };
    }
    return null;
}

function finish(ranges: CompressRangeSpec[], diag: CompressParseDiagnostics): ParsedCompressInput {
    diag.ok = ranges.length > 0;
    return { ranges, diagnostics: diag };
}

function finishSalvage(entries: unknown[], callId: string | undefined, diag: CompressParseDiagnostics, truncatedShape: boolean): ParsedCompressInput {
    const { ranges, invalid, reasons } = validateEntries(entries, callId);
    diag.invalidItems = invalid;
    if (reasons.length > 0) diag.invalidReasons = reasons;
    diag.kind = entries.length > 0 || truncatedShape ? "truncated" : "malformed-json";
    return finish(ranges, diag);
}

function validateEntries(entries: unknown[], callId: string | undefined): { ranges: CompressRangeSpec[]; invalid: number; reasons: string[] } {
    const ranges: CompressRangeSpec[] = [];
    const reasons: string[] = [];
    let invalid = 0;
    for (let i = 0; i < entries.length; i++) {
        const outcome = validateEntry(entries[i], callId);
        if ("range" in outcome) ranges.push(outcome.range);
        else {
            invalid++;
            reasons.push(`entry ${i}: ${outcome.reason}`);
        }
    }
    return { ranges, invalid, reasons };
}

type EntryOutcome = { range: CompressRangeSpec } | { reason: string };

function validateEntry(entry: unknown, callId: string | undefined): EntryOutcome {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { reason: "not an object" };
    const e = entry as Record<string, unknown>;
    // Field-name variants: startRef/endRef are canonical; startId/endId is
    // model drift (and the legacy rebuild.ts spelling); messageId is the
    // startId-less messageRef from the historical API.
    const start = stringOr(e["startRef"]) ?? stringOr(e["startId"]) ?? stringOr(e["messageId"]);
    const end = stringOr(e["endRef"]) ?? stringOr(e["endId"]) ?? stringOr(e["messageId"]);
    if (start === undefined || end === undefined) {
        return { reason: "missing range bounds (need startRef/startId and endRef/endId)" };
    }
    const summary = stringOr(e["summary"]);
    if (summary === undefined) return { reason: "missing summary" };
    const range: CompressRangeSpec = { startRef: start, endRef: end, summary };
    const topic = stringOr(e["topic"]);
    if (topic !== undefined) range.topic = topic;
    const maxChars = e["summaryMaxChars"];
    if (typeof maxChars === "number" && Number.isFinite(maxChars)) range.summaryMaxChars = maxChars;
    if (callId !== undefined) range.compressCallId = callId;
    return { range };
}

function stringOr(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

// --- tolerant JSON parsing -------------------------------------------------

function tryParseLenient(s: string): unknown {
    if (s === "") return undefined;
    try {
        return JSON.parse(s);
    } catch {
        // keep trying the repaired variants below
    }
    const noTrailingCommas = stripTrailingCommas(s);
    if (noTrailingCommas !== s) {
        try {
            return JSON.parse(noTrailingCommas);
        } catch {
            // keep trying
        }
    }
    const fixed = escapeRawNewlinesInStrings(noTrailingCommas);
    if (fixed !== noTrailingCommas) {
        try {
            return JSON.parse(fixed);
        } catch {
            // fall through to salvage
        }
    }
    return undefined;
}

// State machine that converts single-quoted strings to double-quoted ones.
// Apostrophes inside double-quoted strings are data and are copied verbatim;
// control characters inside single-quoted regions become JSON escapes.
// Returns undefined when nothing was converted (input unchanged).
// Ported from billion-context compress-tool.ts (#603/#610): pure text repair —
// it never invents structure, so anything it cannot make into valid JSON
// simply stays unrecovered.
function normalizeSingleQuotes(raw: string): string | undefined {
    if (!raw.includes("'") || (!raw.includes("{") && !raw.includes("["))) return undefined;
    let out = "";
    let changed = false;
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw.charAt(i);
        if (inDouble) {
            out += ch;
            if (ch === "\\" && i + 1 < raw.length) {
                out += raw.charAt(i + 1);
                i++;
            } else if (ch === '"') {
                inDouble = false;
            }
            continue;
        }
        if (inSingle) {
            if (ch === "\\" && i + 1 < raw.length) {
                const next = raw.charAt(i + 1);
                out += next === "'" ? "'" : "\\" + next;
                i++;
                continue;
            }
            if (ch === "'") {
                out += '"';
                inSingle = false;
                changed = true;
                continue;
            }
            if (ch === '"') {
                out += '\\"';
                continue;
            }
            if (ch === "\n") {
                out += "\\n";
                continue;
            }
            if (ch === "\r") {
                out += "\\r";
                continue;
            }
            if (ch === "\t") {
                out += "\\t";
                continue;
            }
            out += ch;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            out += ch;
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            out += '"';
            changed = true;
            continue;
        }
        out += ch;
    }
    return changed ? out : undefined;
}

function stripFence(s: string): string {
    if (!s.startsWith("```")) return s;
    const firstNewline = s.indexOf("\n");
    if (firstNewline === -1) return s;
    const bodyStart = firstNewline + 1;
    const end = s.lastIndexOf("```");
    return end > bodyStart ? s.slice(bodyStart, end).trim() : s.slice(bodyStart).trim();
}

// Drop commas that sit immediately before a closing brace/bracket
// (outside string literals).
function stripTrailingCommas(s: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < s.length && (s.charAt(j) === " " || s.charAt(j) === "\t" || s.charAt(j) === "\n" || s.charAt(j) === "\r")) j++;
            if (j < s.length && (s.charAt(j) === "}" || s.charAt(j) === "]")) continue;
        }
        out += ch;
    }
    return out;
}

// Raw \n, \r, \t inside string literals are invalid JSON; escape them.
// Outside strings they are legal whitespace and left alone.
function escapeRawNewlinesInStrings(s: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        if (!inString) {
            if (ch === '"') inString = true;
            out += ch;
            continue;
        }
        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            out += ch;
            escaped = true;
            continue;
        }
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") { out += "\\r"; continue; }
        if (ch === "\t") { out += "\\t"; continue; }
        if (ch === '"') inString = false;
        out += ch;
    }
    return out;
}

// Unbalanced brackets or an unterminated string at end of input is the
// signature of a mid-stream cutoff (as opposed to balanced garbage).
function looksTruncated(s: string): boolean {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
    }
    return depth > 0 || inString;
}

/**
 * Recover the complete entries of the `content` array from a truncated JSON
 * prefix. Walks the prefix with a small state machine (string / escape /
 * bracket depth); every object that opens and closes at depth 1 is
 * re-parsed leniently and kept only if it still parses. Partial entries are
 * dropped — the parser never invents model content.
 */
function salvageContentEntries(raw: string): unknown[] {
    const match = /"content"\s*:\s*\[/.exec(raw);
    if (match === null) return [];
    const arrayStart = match.index + match[0].length - 1;
    const entries: unknown[] = [];
    let depth = 0; // brackets nested inside the content array
    let inString = false;
    let escaped = false;
    let entryStart = -1;
    for (let i = arrayStart + 1; i < raw.length; i++) {
        const ch = raw.charAt(i);
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{" || ch === "[") {
            if (depth === 0 && ch === "{" && entryStart === -1) entryStart = i;
            depth++;
            continue;
        }
        if (ch === "}" || ch === "]") {
            depth--;
            if (depth < 0) break; // the content array itself closed
            if (depth === 0 && entryStart !== -1) {
                const entrySlice = raw.slice(entryStart, i + 1);
                entryStart = -1;
                const parsed = tryParseLenient(entrySlice);
                if (parsed !== undefined) entries.push(parsed);
            }
        }
    }
    return entries;
}
