import type { Config, CoreMessage } from "./types.js";

export interface TruncateOptions {
    minOutputTokens?: number;
    keepPrefixChars?: number;
    keepSuffixChars?: number;
    protectRecentMessages?: number;
}

export interface TruncateResult {
    messages: CoreMessage[];
    truncatedCount: number;
    savedTokens: number;
}

export interface ToolResultCapResult {
    messages: CoreMessage[];
    cappedCount: number;
    capTokens: number;
}

const TRUNCATION_MARKER = "[truncated for context space]";
const CAP_MARKER_PREFIX = "[acp: tool-result truncated";
const MAX_TOOL_RESULT_CAP = 16384;
const AUTO_CAP_LIMIT_RATIO = 0.1;
const MIN_KEEP_CHARS = 64;
const DEFAULTS = {
    minOutputTokens: 1000,
    keepPrefixChars: 2000,
    keepSuffixChars: 2000,
    protectRecentMessages: 3,
} as const;

/** Effective per-tool-result token cap. `maxToolResultTokens` null (default)
 *  means auto: min(10% of the model context limit, 16384). 0 disables. When
 *  the context limit is unknown (<= 0), auto falls back to the absolute
 *  ceiling — the cap is the one valve that must still fire. */
export function resolveToolResultCap(config: Config): number {
    const configured = config.truncate.maxToolResultTokens;
    if (configured != null) {
        return configured <= 0 ? 0 : Math.floor(configured);
    }
    if (config.modelContextLimit <= 0) return MAX_TOOL_RESULT_CAP;
    return Math.min(
        MAX_TOOL_RESULT_CAP,
        Math.floor(config.modelContextLimit * AUTO_CAP_LIMIT_RATIO),
    );
}

/** Hard per-message guard: no single tool-result may exceed the cap in the
 *  outgoing context, regardless of total usage and regardless of recency
 *  (recent/protected messages included). Byte-based host limits and the
 *  usage-gated emergency truncation both missed the 2026-08-23 incident — a
 *  31K-token tool-result under every byte cap while usage read 51.8%. */
export function capLargeToolResults(
    messages: CoreMessage[],
    config: Config,
    countTokens: (text: string) => number,
): ToolResultCapResult {
    const cap = resolveToolResultCap(config);
    if (cap <= 0) return { messages, cappedCount: 0, capTokens: cap };

    const edits = new Map<number, string>();
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        if (message.contentType !== "tool-result") continue;
        const text = message.text ?? "";
        if (text.length === 0 || text.includes(CAP_MARKER_PREFIX)) continue;
        const tokens = countTokens(text);
        if (tokens <= cap) continue;
        edits.set(index, capToTokens(text, tokens, cap, countTokens));
    }

    if (edits.size === 0) return { messages, cappedCount: 0, capTokens: cap };
    const updated = messages.map((message, index) =>
        edits.has(index) ? { ...message, text: edits.get(index)! } : message,
    );
    return { messages: updated, cappedCount: edits.size, capTokens: cap };
}

/** Head+tail rewrite that fits the token cap. The initial per-side char
 *  budget assumes ~4 chars/token; CJK-dense text (1 char/token) overshoots,
 *  so the loop halves until the CJK-aware count fits. */
function capToTokens(
    text: string,
    tokens: number,
    cap: number,
    countTokens: (text: string) => number,
): string {
    const marker =
        `\n\n...${CAP_MARKER_PREFIX}, original ~${tokens} tokens]...\n\n`;
    let keepChars = Math.max(
        MIN_KEEP_CHARS,
        Math.floor(((cap - countTokens(marker)) / 2) * 4),
    );
    while (keepChars >= MIN_KEEP_CHARS) {
        const replacement =
            text.slice(0, keepChars) + marker + text.slice(-keepChars);
        if (countTokens(replacement) <= cap) return replacement;
        keepChars = Math.floor(keepChars / 2);
    }
    return marker;
}

export function truncateLargeToolOutputs(
    messages: CoreMessage[],
    tokenCount: number,
    config: Config,
    countTokens: (text: string) => number,
    options: TruncateOptions = {},
): TruncateResult {
    const opts = { ...DEFAULTS, ...options };
    if (config.modelContextLimit <= 0) return { messages, truncatedCount: 0, savedTokens: 0 };

    const threshold = config.truncate.threshold * config.modelContextLimit;
    if (tokenCount < threshold) return { messages, truncatedCount: 0, savedTokens: 0 };

    // Collect ALL tool-result messages as candidates — including the most recent
    // ones. The old hard protection of the last N messages was counterproductive
    // when the most recent messages were the largest (e.g. decompress inline
    // results): it prevented truncating the very messages causing the overflow.
    // Instead, the size-based sort below naturally preserves small recent
    // messages and truncates large ones regardless of recency. `protectRecentMessages`
    // is kept in the API for backward compatibility but no longer hard-excludes
    // recent messages from candidacy.
    const candidates: Array<{ index: number; tokens: number }> = [];

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        if (message.contentType !== "tool-result") continue;
        const text = message.text ?? "";
        if (
            text.length === 0 ||
            text.includes(TRUNCATION_MARKER) ||
            text.includes(CAP_MARKER_PREFIX)
        )
            continue;
        const tokens = countTokens(text);
        if (tokens < opts.minOutputTokens) continue;
        candidates.push({ index, tokens });
    }

    if (candidates.length === 0) return { messages, truncatedCount: 0, savedTokens: 0 };
    candidates.sort((left, right) => right.tokens - left.tokens);

    const targetTokens = threshold * 0.9;
    let savedTokens = 0;
    const edits = new Map<number, string>();
    let truncatedCount = 0;

    for (const candidate of candidates) {
        if (tokenCount - savedTokens <= targetTokens) break;
        const original = messages[candidate.index]!.text ?? "";
        if (original.length <= opts.keepPrefixChars + opts.keepSuffixChars) continue;

        const prefix = original.slice(0, opts.keepPrefixChars);
        const suffix = original.slice(-opts.keepSuffixChars);
        const replacement =
            prefix +
            `\n\n...${TRUNCATION_MARKER} — original ~${candidate.tokens} tokens]...\n\n` +
            suffix;
        edits.set(candidate.index, replacement);
        savedTokens += candidate.tokens - countTokens(replacement);
        truncatedCount++;
    }

    if (truncatedCount === 0) return { messages, truncatedCount: 0, savedTokens: 0 };

    const updated = messages.map((message, index) =>
        edits.has(index) ? { ...message, text: edits.get(index)! } : message,
    );
    return { messages: updated, truncatedCount, savedTokens };
}
