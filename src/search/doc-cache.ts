/**
 * Per-doc derived features, memoized across search calls.
 *
 * A search over the compressed history re-scores the SAME immutable docs on
 * every call — compressed block summaries and folded message text never
 * change. Without this cache, every search_context call re-tokenized the
 * entire corpus (segmenter CJK pass ≈ 0.3s/MB cold) plus re-lowercased it
 * and rebuilt the bigram set for each channel: a 5MB session cost ~3s PER
 * CALL, growing linearly with session length. With the cache the corpus is
 * processed once; later searches are O(docs × query-terms).
 *
 * Keyed by doc text (immutable). Bounded by total cached source chars —
 * oldest docs are evicted when the cap is exceeded, so a long-lived
 * process serving many sessions cannot grow unboundedly. Hosts that want to
 * release the memory eagerly on session shutdown/switch can call
 * clearDocFeatures() (optional: the cap already bounds it).
 */

import { charBigrams, tfMap } from "./tokenizer.js";

export interface DocFeatures {
    /** Stemmed term frequencies (BM25 channel). */
    tf: Map<string, number>;
    /** Total term count (BM25 length normalization). */
    len: number;
    /** Lower-cased text (substring + fuzzy channels). */
    lower: string;
    /** Unique char bigrams of `lower` (fuzzy channel). */
    grams: Set<string>;
}

const DEFAULT_CAP_CHARS = 8 * 1024 * 1024;
let capChars = DEFAULT_CAP_CHARS;
const cache = new Map<string, DocFeatures>();
let cachedChars = 0;

function build(text: string): DocFeatures {
    const tf = tfMap(text, true);
    let len = 0;
    for (const v of tf.values()) len += v;
    const lower = text.toLowerCase();
    return { tf, len, lower, grams: new Set(charBigrams(lower)) };
}

export function docFeatures(text: string): DocFeatures {
    const hit = cache.get(text);
    if (hit) return hit;
    const f = build(text);
    if (text.length > 0 && text.length <= capChars) {
        while (cachedChars + text.length > capChars && cache.size > 0) {
            const k = cache.keys().next().value as string;
            cachedChars -= k.length;
            cache.delete(k);
        }
        cache.set(text, f);
        cachedChars += text.length;
    }
    return f;
}

/** Drop all cached features (e.g. on session shutdown/switch). */
export function clearDocFeatures(): void {
    cache.clear();
    cachedChars = 0;
}

/**
 * Set the cache cap in source chars. Docs larger than the cap are never
 * cached. Also used by tests to exercise eviction.
 */
export function setDocCacheCap(chars: number): void {
    capChars = Math.max(1, chars);
    while (cachedChars > capChars && cache.size > 0) {
        const k = cache.keys().next().value as string;
        cachedChars -= k.length;
        cache.delete(k);
    }
}

/** Cache occupancy — for diagnostics. */
export function docCacheInfo(): { entries: number; chars: number } {
    return { entries: cache.size, chars: cachedChars };
}
