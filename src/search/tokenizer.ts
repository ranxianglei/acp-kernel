/**
 * Search tokenizer.
 *
 * Handles mixed Latin + CJK content — the single biggest quality lever
 * over plain substring search. Latin is split on non-word boundaries;
 * CJK (no spaces) is decomposed into overlapping bigrams so a query like
 * "身份验证" still scores against doc text "身份验证流程".
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const CJK_RUN = new RegExp(`${CJK.source}+`, "g");
const LATIN_WORD = /[a-z][a-z0-9_]*[a-z0-9]|[a-z0-9]/g;

import { stem } from "./stemmer.js";

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
        if (run.length === 1) {
            tokens.push(run);
        } else {
            for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
            for (const ch of run) tokens.push(ch);
        }
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
