import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function defaultCountTokens(text: string): number {
  if (!text) return 0;
  const ascii = text.match(/[a-zA-Z][a-zA-Z0-9_'-]*/g);
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  return (ascii?.length ?? 0) + (cjk?.length ?? 0);
}

export function estimateMessageTokens(text: string | undefined): number {
  return defaultCountTokens(text ?? "");
}

export function estimateTokensFast(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type TokenCountFn = (text: string) => number;

export function createBpeTokenizer(): TokenCountFn {
  try {
    const mod = require("@anthropic-ai/tokenizer");
    const bpeCount = mod.countTokens ?? mod.default?.countTokens;
    if (typeof bpeCount !== "function") return defaultCountTokens;
    return (text: string) => {
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
