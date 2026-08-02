import type { SearchAlgorithm, SearchDoc, ScoredBlock } from "../types.js";
import { charBigrams } from "../tokenizer.js";

/**
 * Fuzzy character-bigram matching (Jaccard-style).
 *
 * Decomposes the query into character bigrams and measures overlap with
 * each doc. Robust to typos (tokan≈token), partial words, and works
 * uniformly across all scripts (CJK benefits most). Only considers query
 * tokens of length >= 4 to avoid noise from short common-character pairs.
 *
 * On benchmark: highest recall@3 (0.913) of any single algorithm — it is
 * the recall boost in the hybrid default.
 */
export const fuzzyAlgorithm: SearchAlgorithm = {
    name: "fuzzy",
    description: "Character bigram overlap. Typo-tolerant, script-agnostic, high recall.",
    score(docs: SearchDoc[], query: string): ScoredBlock[] {
        const qTokens = query.toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 4);
        if (qTokens.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));

        const qGrams = new Set<string>();
        for (const t of qTokens) for (const g of charBigrams(t)) qGrams.add(g);
        if (qGrams.size === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));

        return docs.map((d) => {
            const haystack = d.text.toLowerCase();
            const docGrams = new Set(charBigrams(haystack));
            let hits = 0;
            for (const g of qGrams) if (docGrams.has(g)) hits++;
            return { ref: d.ref, score: hits / qGrams.size };
        });
    },
};
