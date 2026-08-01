# Search

Block search finds compressed (invisible) content by keyword — the core value
of ACP as conversations grow. This module is a **pluggable algorithm registry**:
one stable interface, multiple strategies, zero runtime dependencies.

## Quick start

```ts
import { searchBlocks } from "acp-kernel";

const results = searchBlocks(state, "auth token", { limit: 5 });
// → [{ blockId: "b3", tier: 1, score: 0.92, topic: "...", preview: "...match context...", block }]
```

## Why the default is "hybrid"

The default algorithm is `hybrid` (BM25+stem ⊕ fuzzy n-gram). On a 30-block
mixed EN/CJK benchmark with 45 queries, against the original substring counter:

| algorithm   | MRR   | R@1   | R@3   |
|-------------|-------|-------|-------|
| substring   | 0.821 | 0.804 | 0.826 |
| bm25        | 0.812 | 0.804 | 0.826 |
| fuzzy       | 0.691 | 0.630 | 0.761 |
| **hybrid**  | **0.879** | **0.848** | **0.913** |

The wins come from three fixes to plain substring matching:

1. **CJK bigram tokenization** — Chinese/Japanese has no spaces, so `"登录"`
   tokenizes into overlapping bigrams that match inside `"登录认证流程"`.
2. **English stemming** — `compressed`/`compression`/`compressing` collapse to a
   common root (lightweight Porter-inspired suffix stripper, no deps).
3. **Character n-gram fuzzy recall** — typo-tolerant (`tokan`≈`token`),
   script-agnostic; BM25 supplies precision, fuzzy supplies recall.

Previews are **match-context snippets**, not arbitrary prefixes — the result
shows the sentence around the hit so the user sees *why* a block matched.

## Options

```ts
interface SearchOptions {
  algorithm?: string;     // "hybrid" (default) | "bm25" | "fuzzy" | "substring" | <custom>
  limit?: number;         // default 10
  previewLength?: number; // default 200
  minScore?: number;      // default 0.01
}
```

## Built-in algorithms

| name        | strengths                                         | when to use                      |
|-------------|---------------------------------------------------|----------------------------------|
| `hybrid`    | best all-rounder (default)                        | always                           |
| `bm25`      | IR-standard, IDF + length norm + stemming         | precision on long corpora        |
| `fuzzy`     | typo-tolerant, cross-script                       | recall on messy input            |
| `substring` | exact, deterministic, occurrence count            | backward compat / debugging      |

## Adding a custom algorithm

Register any algorithm and select it by name:

```ts
import { registerSearchAlgorithm, searchBlocks } from "acp-kernel";

registerSearchAlgorithm({
  name: "prefix-only",
  description: "scores by whether summary starts with the query",
  score(docs, query) {
    const q = query.toLowerCase();
    return docs.map((d) => ({
      blockId: d.blockId,
      score: d.summary.toLowerCase().startsWith(q) ? 1 : 0,
    }));
  },
});

searchBlocks(state, "auth", { algorithm: "prefix-only" });
```

## Optional: semantic (embedding) search

Lexical algorithms can't bridge synonyms or cross-language pairs
(`login`↔`登录`, `cache`↔`缓存`, `credentials`→auth). For those, plug in an
embedding backend via the reference `semantic` algorithm. **acp-kernel stays
zero-deps** — you supply the `embed` function and pick the backend.

```ts
import { registerSearchAlgorithm, searchBlocksAsync } from "acp-kernel";
import { createSemanticAlgorithm } from "acp-kernel/search/algorithms/semantic";

const semantic = createSemanticAlgorithm({
  // any backend: @huggingface/transformers (local), OpenAI, Voyage, a local server…
  embed: async (texts) => myEmbeddingApi.embed(texts),  // → number[][]
});
registerSearchAlgorithm(semantic);

// semantic score() is async → use searchBlocksAsync (searchBlocks throws a clear error)
const results = await searchBlocksAsync(state, "credentials", { algorithm: "semantic" });
```

`embeddings` are memoized by content hash — docs only re-embed when their
summary changes; the query embeds fresh each call. Embedding docs + query in a
single batch keeps it to one round-trip per search.

## Module layout

```
src/search/
├── types.ts              SearchAlgorithm, AsyncSearchAlgorithm, SearchOptions, SearchResult
├── tokenizer.ts          Latin words + CJK bigram tokenization
├── stemmer.ts            lightweight English stemmer
├── registry.ts           register / get / list algorithms
├── algorithms/
│   ├── substring.ts      baseline (exact occurrence count)
│   ├── bm25.ts           BM25 + stem + CJK tokenization
│   ├── fuzzy.ts          character n-gram Jaccard
│   ├── hybrid.ts         default: 0.7·BM25 + 0.3·fuzzy
│   └── semantic.ts       reference embedding algorithm (host supplies embed fn)
└── index.ts              searchBlocks (sync) + searchBlocksAsync
```
