/**
 * Block search — find compressed (invisible) content by keyword.
 *
 * This is the core value of ACP: as conversations grow, most history becomes
 * invisible (compressed into summary blocks). Search is the only way to
 * retrieve specific information from that invisible content.
 *
 * Current implementation: substring counting (simple but effective for
 * dozens of blocks). Future: TF-IDF, fuzzy matching, CJK tokenization,
 * semantic search.
 */

import type { CompressionState, CompressionBlock } from "./types.js";

export interface SearchResult {
    blockId: string;
    tier: number;
    score: number;
    topic: string;
    preview: string;
    block: CompressionBlock;
}

export interface SearchOptions {
    limit?: number;
    previewLength?: number;
    minScore?: number;
}

export function searchBlocks(
    state: CompressionState,
    query: string,
    options: SearchOptions = {},
): SearchResult[] {
    const limit = options.limit ?? 10;
    const previewLength = options.previewLength ?? 200;
    const minScore = options.minScore ?? 1;

    const terms = query
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);

    if (terms.length === 0) return [];

    const active = state.blocks.filter((b: CompressionBlock) => b.active);

    const scored: SearchResult[] = [];
    for (const block of active) {
        const text = (block.summary || "").toLowerCase();
        const topic = (block.topic || "").toLowerCase();
        const haystack = topic + " " + text;

        let score = 0;
        for (const term of terms) {
            score += countOccurrences(haystack, term);
        }

        if (score >= minScore) {
            scored.push({
                blockId: block.blockId,
                tier: block.tier ?? 1,
                score,
                topic: block.topic ?? "(no topic)",
                preview: (block.summary || "").slice(0, previewLength),
                block,
            });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    return haystack.split(needle).length - 1;
}
