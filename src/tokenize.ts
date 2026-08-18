import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function defaultCountTokens(text: string): number {
  if (!text) return 0;
  // CJK chars tokenize ~1:1 (chars/4 badly underestimates them). Count them
  // directly, then estimate the non-CJK remainder with chars/4 so digits,
  // punctuation, and symbols in code/JSON are not dropped to zero.
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjk?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

export function estimateMessageTokens(text: string | undefined): number {
  return defaultCountTokens(text ?? "");
}

export function estimateTokensFast(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type TokenCountFn = (text: string) => number;

const BPE_SIZE_GUARD = 100_000;

export function createBpeTokenizer(): TokenCountFn {
  try {
    const mod = require("@anthropic-ai/tokenizer");
    const bpeCount = mod.countTokens ?? mod.default?.countTokens;
    if (typeof bpeCount !== "function") return defaultCountTokens;
    return (text: string) => {
      if (text.length > BPE_SIZE_GUARD) return defaultCountTokens(text);
      try {
        return bpeCount(text);
      } catch {
        return defaultCountTokens(text);
      }
    };
  } catch {
    return defaultCountTokens;
  }
}
