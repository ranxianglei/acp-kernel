/**
 * Search type definitions.
 *
 * A SearchAlgorithm is a stateless scorer: given the active blocks and a
 * query, return per-block scores. Algorithms are registered by name and
 * selected via SearchOptions.algorithm (default: "hybrid").
 *
 * This indirection lets pai-acp (or any host) inject a semantic/embedding
 * algorithm without touching the kernel core — register once at startup,
 * reference by name.
 */

import type { CompressionBlock } from "../types.js";

export interface SearchDoc {
    blockId: string;
    topic: string;
    summary: string;
    block: CompressionBlock;
}

export interface ScoredBlock {
    blockId: string;
    score: number;
}

export interface SearchAlgorithm {
    name: string;
    description: string;
    /** Score every doc against the query; docs with score 0 are dropped by caller. */
    score(docs: SearchDoc[], query: string): ScoredBlock[];
}

/** Async algorithm (e.g. embedding-based semantic search). score() returns a Promise. */
export interface AsyncSearchAlgorithm {
    name: string;
    description: string;
    score(docs: SearchDoc[], query: string): Promise<ScoredBlock[]>;
}

export type AnySearchAlgorithm = SearchAlgorithm | AsyncSearchAlgorithm;

export interface SearchResult {
    blockId: string;
    tier: number;
    score: number;
    topic: string;
    preview: string;
    block: CompressionBlock;
}

export interface SearchOptions {
    /** Algorithm name (registered). Defaults to "hybrid". */
    algorithm?: string;
    limit?: number;
    previewLength?: number;
    minScore?: number;
}

export const DEFAULT_ALGORITHM = "hybrid";
