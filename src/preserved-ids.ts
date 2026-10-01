import type { CoreMessage } from "./types.js";

/** One verbatim-identifier extractor (#481): a machine label plus a global
 *  pattern whose matches are preserved byte-for-byte into a compression block
 *  appendix so they survive folding regardless of what the model summary
 *  writes. `pattern` must be global; exec state is cloned per call. */
export interface FidelityExtractor {
  label: string;
  pattern: RegExp;
}

/** Active extractors, deliberately narrow per #481 direction: only opencode
 *  subagent session ids for now. Commit-hash / PR-number extractors can join
 *  this list later — the appendix format already carries the label. */
export const DEFAULT_FIDELITY_EXTRACTORS: readonly FidelityExtractor[] = [
  { label: "subagent-session", pattern: /\bses_[A-Za-z0-9]+\b/g },
];

/** Texts that can carry dispatch-pair identifiers (#481): tool-call and
 *  tool-result messages only. User/assistant prose is out of scope — the
 *  directed fix targets the subagent dispatch pair shape, not free text. */
export function fidelitySourceTexts(messages: CoreMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message.text) continue;
    if (
      message.contentType !== "tool-call" &&
      message.contentType !== "tool-result"
    )
      continue;
    texts.push(message.text);
  }
  return texts;
}

/** Extract deduped identifiers from folded texts, grouped by extractor label.
 *  First-occurrence order is preserved within each label. */
export function extractFidelityIds(
  texts: Iterable<string>,
  extractors: readonly FidelityExtractor[] = DEFAULT_FIDELITY_EXTRACTORS,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const extractor of extractors) {
    const pattern = new RegExp(
      extractor.pattern.source,
      extractor.pattern.flags.replace("g", "") + "g",
    );
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const text of texts) {
      if (!text) continue;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const id = match[0];
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
        if (match.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }
    if (ids.length > 0) out.set(extractor.label, ids);
  }
  return out;
}

function idPresentIn(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/** Machine appendix lines for extracted ids missing from the model summary;
 *  "" when nothing was extracted or every id is already present verbatim.
 *  One line per label — the format stays extensible as extractors are added. */
export function buildFidelityAppendix(
  summary: string,
  idsByLabel: Map<string, string[]>,
): string {
  if (idsByLabel.size === 0) return "";
  const lines: string[] = [];
  for (const [label, ids] of idsByLabel) {
    const missing = ids.filter((id) => !idPresentIn(summary, id));
    if (missing.length > 0) {
      lines.push(`[acp-preserved:${label}] ${missing.join(", ")}`);
    }
  }
  if (lines.length === 0) return "";
  return `\n${lines.join("\n")}`;
}
