import type { SearchAlgorithm, SearchDoc, ScoredBlock } from "../types.js";
import { bm25Algorithm } from "./bm25.js";
import { fuzzyAlgorithm } from "./fuzzy.js";

/**
 * Hybrid: normalized BM25(stem) + fuzzy n-gram, weighted 0.7 / 0.3.
 *
 * BM25 supplies precision on real terms (with morphology + IDF + length
 * norm); fuzzy supplies recall on typos, partials, and cross-script.
 * Each component is max-normalized to [0,1] before weighting so their
 * scales are comparable regardless of corpus size.
 *
 * Benchmark (32 blocks, 48 mixed EN/CJK queries, final code — segmenter
 * tokenizer + CJK fuzzy gate):
 *   substring  MRR 0.797  R@1 0.792  R@3 0.792
 *   bm25       MRR 0.833  R@1 0.833  R@3 0.833
 *   fuzzy      MRR 0.795  R@1 0.708  R@3 0.875
 *   hybrid     MRR 0.898  R@1 0.875  R@3 0.917   ← best on every metric
 * The weight ratio is robust: 0.6–0.8 for BM25 all score within 0.001 MRR.
 */

const W_BM25 = 0.7;
const W_FUZZY = 0.3;

/**
 * Max of the scores with a floor, in loop form. `Math.max(...scores)` spreads
 * the whole array into call arguments, which throws `RangeError: Maximum call
 * stack size exceeded` once the doc count exceeds the V8 argument limit
 * (~125K–130K on Node 22) — a 160K-doc corpus crashed the search instead of
 * returning results (ranxianglei/acp-kernel#227).
 */
function maxScore(results: ScoredBlock[], floor: number): number {
    let max = floor;
    for (const r of results) {
        if (r.score > max) max = r.score;
    }
    return max;
}

export const hybridAlgorithm: SearchAlgorithm = {
    name: "hybrid",
    description: "Weighted BM25(stem) + fuzzy n-gram. Default — best precision + recall.",
    score(docs: SearchDoc[], query: string): ScoredBlock[] {
        const bm = bm25Algorithm.score(docs, query);
        const fz = fuzzyAlgorithm.score(docs, query);
        const maxBm = maxScore(bm, 1e-9);
        const maxFz = maxScore(fz, 1e-9);
        const bmMap = new Map(bm.map((r) => [r.ref, r.score / maxBm]));
        const fzMap = new Map(fz.map((r) => [r.ref, r.score / maxFz]));
        return docs.map((d) => ({
            ref: d.ref,
            score: W_BM25 * (bmMap.get(d.ref) ?? 0) + W_FUZZY * (fzMap.get(d.ref) ?? 0),
        }));
    },
};
