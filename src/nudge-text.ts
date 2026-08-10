import type { NudgeDecision, CompressibleRange, ProtectedRange, ContextBreakdown, CompressionBlock } from "./types.js";
import { COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES } from "./compression-rules.js";

export type NudgeVoice = "gentle" | "emergency";

export interface RenderedNudge {
  voice: NudgeVoice;
  text: string;
}

const EFFICIENCY_NOTE = `This is an efficiency nudge to compress early and keep context lean — not an overflow warning. A separate, stronger alert will appear if the context is actually full.\n\n${COMPRESS_PHILOSOPHY}`;

const EMERGENCY_HEADER = `⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.\n\n${COMPRESS_PHILOSOPHY}`;

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function formatBreakdown(bd?: ContextBreakdown): string {
  if (!bd) return "";
  const parts: string[] = [];
  if (bd.system > 0) parts.push(`${formatK(bd.system)} system`);
  if (bd.tool > 0) parts.push(`${formatK(bd.tool)} tool`);
  if (bd.summaries > 0) parts.push(`${formatK(bd.summaries)} summaries`);
  if (bd.code > 0) parts.push(`${formatK(bd.code)} code`);
  if (bd.text > 0) parts.push(`${formatK(bd.text)} text`);
  const growth = bd.growth > 0 ? `\n+${formatK(bd.growth)} since last nudge` : "";
  return `Context breakdown: ${parts.join(" | ")}${growth}`;
}



function formatTierTargetBlocks(blocks: CompressionBlock[]): string {
  if (blocks.length === 0) {
    return "Target blocks: (none — no tier blocks found)";
  }
  const lines = blocks.map((b) => {
    const summaryTokens = Math.ceil((b.summary ?? "").length / 4);
    const topic = b.topic ? `  "${b.topic}"` : "";
    return `  ${b.blockId}  ${b.effectiveMessageIds.length} msgs  ${formatK(b.compressedTokens)}→${formatK(summaryTokens)}${topic}`;
  });
  return `Target ${blocks[0]!.tier === 1 ? "tier-1" : "tier-2"} blocks to distill (${blocks.length}):\n${lines.join("\n")}`;
}

export function formatRanges(compressible: CompressibleRange[], protectedRanges: ProtectedRange[]): string {
  if (compressible.length === 0 && protectedRanges.length === 0) {
    return "[No specific ranges detected — compress any consumed content.]";
  }

  // Merge compressible + protected into a single oldest-first list, mirroring
  // opencode-acp's formatCompressibleRanges. Splitting them into two sections
  // lost the time order and hid overlaps; a range can be partly compressible
  // and partly protected, which only the merged view shows correctly.
  interface Merged {
    startRef: string; endRef: string; startNum: number; endNum: number;
    count: number; tokens: number;
    compressibleTokens: number; compressibleCount: number;
    protectedTokens: number; protectedCount: number; protectedTools: string[];
    toolPct: number; textPct: number; dangerous: boolean;
  }
  const refNum = (ref: string): number => {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const entries: Merged[] = [];
  for (const r of compressible) {
    entries.push({
      startRef: r.startRef, endRef: r.endRef, startNum: refNum(r.startRef), endNum: refNum(r.endRef),
      count: r.count, tokens: r.tokens, toolPct: r.toolPct, textPct: r.textPct,
      compressibleTokens: r.tokens, compressibleCount: r.count,
      protectedTokens: 0, protectedCount: 0, protectedTools: [], dangerous: r.dangerous ?? false,
    });
  }
  for (const r of protectedRanges) {
    entries.push({
      startRef: r.startRef, endRef: r.endRef, startNum: refNum(r.startRef), endNum: refNum(r.endRef),
      count: r.count, tokens: r.tokens, toolPct: 0, textPct: 0,
      compressibleTokens: 0, compressibleCount: 0,
      protectedTokens: r.tokens, protectedCount: r.count, protectedTools: [...r.tools], dangerous: false,
    });
  }
  entries.sort((a, b) => a.startNum - b.startNum);
  // Merge adjacent/overlapping ranges (gap ≤ 1 ref).
  const merged: Merged[] = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && e.startNum <= last.endNum + 1) {
      last.endRef = e.endRef;
      last.endNum = Math.max(last.endNum, e.endNum);
      last.count += e.count;
      last.tokens += e.tokens;
      last.compressibleTokens += e.compressibleTokens;
      last.compressibleCount += e.compressibleCount;
      last.protectedTokens += e.protectedTokens;
      last.protectedCount += e.protectedCount;
      if (e.dangerous) last.dangerous = true;
      for (const t of e.protectedTools) {
        if (!last.protectedTools.includes(t)) last.protectedTools.push(t);
      }
    } else {
      merged.push({ ...e });
    }
  }
  const lines = merged.map((e) => {
    const suffix = e.dangerous && e.compressibleTokens > 0 ? "  ⚠️ NOT recommended unless you are certain." : "";
    if (e.protectedTokens > 0 && e.compressibleTokens === 0) {
      return `  ${e.startRef}–${e.endRef}  ${e.count} msgs  ${formatK(e.tokens)} [PROTECTED: ${e.protectedTools.join(", ")} — not compressible]${suffix}`;
    }
    if (e.protectedTokens > 0 && e.compressibleTokens > 0) {
      return `  ${e.startRef}–${e.endRef}  ${e.count} msgs  ${formatK(e.tokens)} [${formatK(e.compressibleTokens)} compressible | ${formatK(e.protectedTokens)} protected: ${e.protectedTools.join(", ")}]${suffix}`;
    }
    return `  ${e.startRef}–${e.endRef}  ${e.count} msgs  ${formatK(e.tokens)} [tool ${e.toolPct}% | text ${e.textPct}%]${suffix}`;
  });
  return `Compressible ranges (${merged.length}, oldest first):\n${lines.join("\n")}`;
}

export function renderNudgeText(decision: NudgeDecision): RenderedNudge {
  const breakdownStr = formatBreakdown(decision.contextBreakdown);
  const rangesStr = formatRanges(decision.compressibleRanges, decision.protectedRanges ?? []);

  if (decision.tier !== null && decision.tier >= 2) {
    const isT2 = decision.tier === 2;
    const targets = decision.tierTargetBlocks ?? [];
    const blockList = formatTierTargetBlocks(targets);
    const startId = targets[0]?.blockId ?? "b1";
    const endId = targets[targets.length - 1]?.blockId ?? "b5";
    return {
      voice: "gentle",
      text: [
        EFFICIENCY_NOTE,
        "",
        breakdownStr,
        "",
        `[TIER ${decision.tier} ${isT2 ? "DISTILLATION" : "CONDENSATION"} TRIGGER]`,
        isT2
          ? `Your tier-1 compression summaries have accumulated. Distill them into a single denser tier-2 summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-2 block as well — apply HOW TO COMPRESS to those raw messages and the TIER 2 distillation rules to the existing summaries, so the whole span is covered and nothing is lost.`
          : `Your tier-2 compression summaries have accumulated. Condense them further into a tier-3 ultra-condensed summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-3 block as well — apply HOW TO COMPRESS to those raw messages and the TIER 3 condensation rules to the existing summaries, so the whole span is covered and nothing is lost.`,
        blockList,
        `Example: compress({ content: [{ startId: "${startId}", endId: "${endId}", summary: "..." }] })`,
        "",
        HOW_TO_COMPRESS_RULES,
        "",
        isT2 ? TIER2_DISTILL_RULES : TIER3_CONDENSE_RULES,
      ].join("\n"),
    };
  }

  const isEmergency = !!decision.breakdown?.emergencyOverride;

  if (isEmergency) {
    return {
      voice: "emergency",
      text: [
        EMERGENCY_HEADER,
        "",
        breakdownStr,
        "",
        HOW_TO_COMPRESS_RULES,
        "",
        `{ "topic": "...", "content": [{ "startId": "<ID>", "endId": "<ID>", "summary": "..." }] }`,
        "Only use IDs from visible messages above. Compress older work first.",
        "",
        rangesStr,
      ].join("\n"),
    };
  }

  return {
    voice: "gentle",
    text: [
      EFFICIENCY_NOTE,
      "",
      breakdownStr,
      "",
      HOW_TO_COMPRESS_RULES,
      "",
      rangesStr,
      "",
      `💡 Compress all ranges in one call (pass multiple content entries: \`content: [{...}, {...}]\`).`,
    ].join("\n"),
  };
}
