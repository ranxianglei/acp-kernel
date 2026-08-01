/**
 * searchBlocks — public search entry point.
 *
 * Selects an algorithm by name (default "hybrid"), scores all active
 * blocks, sorts by score desc, and returns the top results with a
 * match-context preview (snippet around the first hit, not just the
 * head — so the user sees WHY a block matched).
 *
 * Two entry points:
 *  - searchBlocks()      — sync. Works for all lexical algorithms.
 *  - searchBlocksAsync() — async. Also supports embedding-based semantic
 *                          algorithms whose score() returns a Promise.
 */

import type { CompressionState, CompressionBlock } from "../types.js";
import { getSearchAlgorithm } from "./registry.js";
import type { SearchDoc, ScoredBlock } from "./types.js";
import type { SearchResult, SearchOptions } from "./types.js";
import { DEFAULT_ALGORITHM } from "./types.js";

function runSearch(
    state: CompressionState,
    query: string,
    options: SearchOptions,
): SearchResult[] | Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const previewLength = options.previewLength ?? 200;
    const minScore = options.minScore ?? 0.01;
    const algoName = options.algorithm ?? DEFAULT_ALGORITHM;

    const algo = getSearchAlgorithm(algoName);
    if (!algo) return [];

    const active = state.blocks.filter((b: CompressionBlock) => b.active);
    if (active.length === 0) return [];

    const docs: SearchDoc[] = active.map((b) => ({
        blockId: b.blockId,
        topic: b.topic ?? "",
        summary: b.summary ?? "",
        block: b,
    }));

    const scoredOrPromise = algo.score(docs, query);

    const buildResults = (scored: ScoredBlock[]): SearchResult[] => {
        const results: SearchResult[] = active.map((b) => {
            const s = scored.find((x) => x.blockId === b.blockId);
            return {
                blockId: b.blockId,
                tier: b.tier ?? 1,
                score: s?.score ?? 0,
                topic: b.topic ?? "(no topic)",
                preview: makePreview(b.summary ?? "", b.topic ?? "", query, previewLength),
                block: b,
            };
        });
        return results
            .filter((r) => r.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    };

    if (scoredOrPromise instanceof Promise) {
        return scoredOrPromise.then(buildResults);
    }
    return buildResults(scoredOrPromise);
}

export function searchBlocks(
    state: CompressionState,
    query: string,
    options: SearchOptions = {},
): SearchResult[] {
    const result = runSearch(state, query, options);
    if (result instanceof Promise) {
        throw new Error(
            `searchBlocks: algorithm "${options.algorithm ?? DEFAULT_ALGORITHM}" is async (e.g. semantic). Use searchBlocksAsync() instead.`,
        );
    }
    return result;
}

export async function searchBlocksAsync(
    state: CompressionState,
    query: string,
    options: SearchOptions = {},
): Promise<SearchResult[]> {
    return await runSearch(state, query, options);
}

/**
 * Build a preview that centers on the first query-term hit (case-insensitive).
 * Falls back to the summary head when no term hits. Makes search results
 * self-explaining: the user sees the matching context, not an arbitrary prefix.
 */
function makePreview(summary: string, topic: string, query: string, len: number): string {
    const text = summary || topic || "";
    if (!text) return "";
    const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 1);
    if (terms.length === 0) return text.slice(0, len);

    const lower = text.toLowerCase();
    let hitIdx = -1;
    for (const term of terms) {
        const idx = lower.indexOf(term);
        if (idx >= 0) {
            hitIdx = idx;
            break;
        }
    }

    if (hitIdx < 0) return text.slice(0, len);

    const half = Math.max(0, Math.floor(len / 2) - 10);
    const start = Math.max(0, hitIdx - half);
    const end = Math.min(text.length, start + len);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return prefix + text.slice(start, end).trim() + suffix;
}
