/**
 * Search tokenizer.
 *
 * Handles mixed Latin + CJK content — the single biggest quality lever
 * over plain substring search. Latin is split on non-word boundaries;
 * CJK (no spaces) is word-segmented via Intl.Segmenter (CLDR dictionary),
 * falling back to overlapping bigrams on out-of-vocabulary text so a query
 * like "身份验证" still scores against doc text "身份验证流程".
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const CJK_RUN = new RegExp(`${CJK.source}+`, "g");
const LATIN_WORD = /[a-z][a-z0-9_]*[a-z0-9]|[a-z0-9]/g;

import { stem } from "./stemmer.js";

const cjkSegmenter = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * CJK run → tokens. Intl.Segmenter (CLDR dictionary) does word segmentation:
 * multi-char words are kept as whole terms, so "国际化" matches "国际化" and
 * "试验证明" no longer scores against "验证" through accidental char runs.
 * When the dictionary finds no multi-char word at all (all-OOV text) we fall
 * back to overlapping bigrams + single chars so recall is preserved — this
 * also covers single-char queries like "验".
 */
function cjkTokens(run: string): string[] {
    const words: string[] = [];
    for (const seg of cjkSegmenter.segment(run)) {
        const w = seg.segment;
        if (w.length >= 2) words.push(w);
    }
    if (words.length > 0) return words;
    const out: string[] = [];
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    for (const ch of run) out.push(ch);
    return out;
}

export interface TokenizeOptions {
    stem?: boolean;
}

export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
    const lower = text.toLowerCase();
    const tokens: string[] = [];

    const latin = lower.match(LATIN_WORD) ?? [];
    for (let w of latin) {
        if (w.length >= 2) {
            if (opts.stem) w = stem(w);
            tokens.push(w);
        }
    }

    const cjkRuns = lower.match(CJK_RUN) ?? [];
    for (const run of cjkRuns) {
        tokens.push(...cjkTokens(run));
    }

    return tokens;
}

/** Character bigrams over arbitrary text — used by fuzzy matching. */
export function charBigrams(text: string): string[] {
    const grams: string[] = [];
    for (let i = 0; i < text.length - 1; i++) {
        const pair = text.slice(i, i + 2);
        if (pair.trim().length === pair.length) grams.push(pair);
    }
    return grams;
}

/** Term-frequency map. */
export function tfMap(text: string, stem: boolean): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of tokenize(text, { stem })) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
}