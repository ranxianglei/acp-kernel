/**
 * Search — re-exports from the modular src/search/ implementation.
 * Kept as a shim so existing `import { ... } from "./search.js"` callers
 * (and the public acp-kernel entry) keep working unchanged.
 */
export { searchBlocks, searchBlocksAsync } from "./search/index.js";
export type { SearchResult, SearchOptions } from "./search/types.js";
export type { SearchAlgorithm, SearchDoc, ScoredBlock } from "./search/types.js";
export { DEFAULT_ALGORITHM } from "./search/types.js";
export { registerSearchAlgorithm, getSearchAlgorithm, listSearchAlgorithms } from "./search/registry.js";
