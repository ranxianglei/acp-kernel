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

const TRUNCATION_MARKER = "[truncated for context space]";
const DEFAULTS = {
    minOutputTokens: 1000,
    keepPrefixChars: 2000,
    keepSuffixChars: 2000,
    protectRecentMessages: 3,
} as const;

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
        if (text.length === 0 || text.includes(TRUNCATION_MARKER)) continue;
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
