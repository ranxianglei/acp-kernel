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
 * Benchmark (32 blocks, 48 mixed EN/CJK queries):
 *   substring  MRR 0.786  R@1 0.771  R@3 0.792
 *   bm25       MRR 0.818  R@1 0.813  R@3 0.813
 *   fuzzy      MRR 0.683  R@1 0.604  R@3 0.771
 *   hybrid     MRR 0.883  R@1 0.854  R@3 0.896   ← best on MRR and R@1
 * The weight ratio is robust: 0.6–0.8 for BM25 all score within 0.001 MRR.
 */

const W_BM25 = 0.7;
const W_FUZZY = 0.3;

export const hybridAlgorithm: SearchAlgorithm = {
    name: "hybrid",
    description: "Weighted BM25(stem) + fuzzy n-gram. Default — best precision + recall.",
    score(docs: SearchDoc[], query: string): ScoredBlock[] {
        const bm = bm25Algorithm.score(docs, query);
        const fz = fuzzyAlgorithm.score(docs, query);
        const maxBm = Math.max(...bm.map((r) => r.score), 1e-9);
        const maxFz = Math.max(...fz.map((r) => r.score), 1e-9);
        const bmMap = new Map(bm.map((r) => [r.ref, r.score / maxBm]));
        const fzMap = new Map(fz.map((r) => [r.ref, r.score / maxFz]));
        return docs.map((d) => ({
            ref: d.ref,
            score: W_BM25 * (bmMap.get(d.ref) ?? 0) + W_FUZZY * (fzMap.get(d.ref) ?? 0),
        }));
    },
};
