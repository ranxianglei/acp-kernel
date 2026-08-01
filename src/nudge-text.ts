import type { NudgeDecision, CompressibleRange, ContextBreakdown, CompressionBlock } from "./types.js";
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

function formatRanges(compressible: CompressibleRange[]): string {
  if (compressible.length === 0) {
    return "[No specific ranges detected — compress any consumed content.]";
  }

  // List compressible ranges oldest-first (by numeric ref). The model reads
  // context chronologically and compresses from old to new; listing in size
  // order made ranges jump around (m02466 before m01466) and disagree with
  // acp_status, which preserves source order. This keeps them aligned and
  // scannable.
  const refNum = (ref: string): number => {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const sorted = [...compressible].sort((a, b) => refNum(a.startRef) - refNum(b.startRef));
  const lines = sorted.map((e) => {
    const suffix = e.dangerous ? "  ⚠️ NOT recommended unless you are certain." : "";
    return `  ${e.startRef}–${e.endRef}  ${e.count} msgs  ${formatK(e.tokens)} [tool ${e.toolPct}% | text ${e.textPct}%]${suffix}`;
  });
  return `Compressible ranges (${compressible.length}, oldest first):\n${lines.join("\n")}`;
}

export function renderNudgeText(decision: NudgeDecision): RenderedNudge {
  const breakdownStr = formatBreakdown(decision.contextBreakdown);
  const rangesStr = formatRanges(decision.compressibleRanges);

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
          ? `Your tier-1 compression summaries have accumulated. Distill them into a single denser tier-2 summary. Use block IDs as boundaries.`
          : `Your tier-2 compression summaries have accumulated. Condense them further into a tier-3 ultra-condensed summary. Use block IDs as boundaries.`,
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
