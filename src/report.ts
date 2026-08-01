import { refForRaw } from "./refs.js";
import type { CompressionBlock, CompressionState, CoreMessage } from "./types.js";

function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function pct(n: number, total: number): number {
    if (n <= 0 || total <= 0) return 0;
    return Math.max(1, Math.round((n / total) * 100));
}

function numericPart(blockId: string): number {
    const match = /^b(\d+)$/.exec(blockId);
    return match && match[1] !== undefined ? Number(match[1]) : 0;
}

function summaryTokensOf(block: CompressionBlock, countTokens: (t: string) => number): number {
    return countTokens(block.summary);
}

function effectiveCompressedTokens(
    block: CompressionBlock,
    _state: CompressionState,
    _countTokens: (t: string) => number,
): number {
    // block.compressedTokens already records the full input token count of the
    // operation that created this block: for a tier-1 block that is the raw
    // messages; for a tier-2 block it is the tier-1 summaries + the new
    // messages it spans. Recursing into directBlockIds and summing children's
    // compressedTokens double-counts the consumed children, so we return the
    // block's own value directly. (The previous recursion inflated tier-2+
    // "original" figures and mis-ordered the status report.)
    return block.compressedTokens;
}

function tierLabel(block: CompressionBlock): string {
    return `T${block.tier}`;
}

function tierBreakdown(
    blocks: CompressionBlock[],
    countTokens: (t: string) => number,
): string | null {
    const tierTokens: Record<number, number> = {};
    for (const block of blocks) {
        tierTokens[block.tier] = (tierTokens[block.tier] ?? 0) + summaryTokensOf(block, countTokens);
    }
    const tiers = Object.keys(tierTokens).map(Number);
    if (tiers.length <= 1) return null;
    const parts: string[] = [];
    for (const tier of [1, 2, 3]) {
        if (tierTokens[tier]) parts.push(`T${tier}: ${formatTokens(tierTokens[tier])}`);
    }
    return parts.join(" | ");
}

interface VisibleMessageInfo {
    ref: string;
    tokens: number;
    tool: string;
    index: number;
}

function collectVisible(
    messages: CoreMessage[],
    state: CompressionState,
    countTokens: (t: string) => number,
): { visible: VisibleMessageInfo[]; summaryTokens: number } {
    const coveredIds = new Set<string>();
    for (const block of state.blocks) {
        if (!block.active) continue;
        for (const id of block.effectiveMessageIds) coveredIds.add(id);
    }
    let summaryTokens = 0;
    for (const block of state.blocks) {
        if (block.active) summaryTokens += summaryTokensOf(block, countTokens);
    }
    const visible: VisibleMessageInfo[] = [];
    messages.forEach((message, index) => {
        if (coveredIds.has(message.id)) return;
        const ref = refForRaw(state.messageRefs, message.id);
        if (!ref) return;
        const tokens = countTokens(message.text ?? "");
        const tool = message.toolName ?? "text";
        if (tokens > 0) visible.push({ ref, tokens, tool, index });
    });
    return { visible, summaryTokens };
}

export interface StatusReportOptions {
    scope?: "compressed" | "uncompressed";
    view?: "ranges" | "messages";
    tool?: string;
    sort?: "size" | "time" | "tool" | "age";
    limit?: number;
}

export function buildStatusReport(
    state: CompressionState,
    messages: CoreMessage[],
    countTokens: (t: string) => number,
    options: StatusReportOptions = {},
): string {
    const scope = options.scope;
    const view = options.view ?? "ranges";
    const toolFilter = options.tool;
    const sort = options.sort ?? "size";
    const limit = options.limit ?? 30;

    const activeBlocks = state.blocks
        .filter((b) => b.active)
        .sort((a, b) => numericPart(a.blockId) - numericPart(b.blockId));

    if (scope === "compressed") {
        return renderCompressedDrilldown(activeBlocks, state, sort, limit, countTokens);
    }

    const { visible, summaryTokens } = collectVisible(messages, state, countTokens);

    if (scope === "uncompressed") {
        if (view === "messages") {
            return renderMessageDrilldown(visible, toolFilter, sort, limit);
        }
        return renderUncompressedRanges(visible);
    }

    return renderOverview(visible, summaryTokens, activeBlocks, state, countTokens, limit);
}

function renderOverview(
    visible: VisibleMessageInfo[],
    summaryTokens: number,
    blocks: CompressionBlock[],
    state: CompressionState,
    countTokens: (t: string) => number,
    limit: number,
): string {
    const lines: string[] = [];
    const toolTypeMap = new Map<string, number>();
    for (const message of visible) {
        toolTypeMap.set(message.tool, (toolTypeMap.get(message.tool) ?? 0) + message.tokens);
    }
    const topTool = [...toolTypeMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    const totalTool = visible
        .filter((m) => m.tool !== "text")
        .reduce((sum, m) => sum + m.tokens, 0);
    const totalText = visible
        .filter((m) => m.tool === "text")
        .reduce((sum, m) => sum + m.tokens, 0);
    const total = summaryTokens + totalTool + totalText;

    lines.push("CONTEXT BREAKDOWN");
    lines.push(
        `  ${formatTokens(totalTool)} tool (${pct(totalTool, total)}%) | ${formatTokens(totalText)} text (${pct(totalText, total)}%) | ${formatTokens(summaryTokens)} summaries (${pct(summaryTokens, total)}%)`,
    );
    const topTypes = [...toolTypeMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
    if (topTypes.length > 0) {
        lines.push(`  Top tools: ${topTypes.map(([t, n]) => `${t} (${pct(n, total)}%)`).join(", ")}`);
    }

    lines.push("");
    if (blocks.length === 0) {
        lines.push("COMPRESSED BLOCKS");
        lines.push("  No compressed blocks.");
    } else {
        const totalSummary = blocks.reduce((s, b) => s + summaryTokensOf(b, countTokens), 0);
        const totalEffective = blocks.reduce(
            (s, b) => s + effectiveCompressedTokens(b, state, countTokens),
            0,
        );
        lines.push(
            `COMPRESSED BLOCKS — ${blocks.length} active (${formatTokens(totalSummary)} summary, ${formatTokens(totalEffective)} original)`,
        );
        const breakdown = tierBreakdown(blocks, countTokens);
        if (breakdown) lines.push(`  Tier usage: ${breakdown}`);
        lines.push("");
        const sorted = [...blocks].sort(
            (a, b) =>
                effectiveCompressedTokens(b, state, countTokens) -
                    effectiveCompressedTokens(a, state, countTokens) ||
                b.createdAt - a.createdAt,
        );
        for (const block of sorted.slice(0, limit)) {
            const topic = block.topic ?? "(no topic)";
            const eff = effectiveCompressedTokens(block, state, countTokens);
            lines.push(
                `  ${block.blockId} (${tierLabel(block)})  ${formatTokens(eff)}→${formatTokens(summaryTokensOf(block, countTokens))}  ${block.effectiveMessageIds.length} msgs  "${topic}"`,
            );
        }
    }

    lines.push("");
    lines.push(
        `Tip: buildStatusReport({scope:"uncompressed", view:"messages", tool:"${topTool ?? "bash"}"}) for per-message listing`,
    );
    return lines.join("\n");
}

function renderUncompressedRanges(visible: VisibleMessageInfo[]): string {
    const lines: string[] = [];
    const totalTokens = visible.reduce((s, m) => s + m.tokens, 0);
    lines.push(`UNCOMPRESSED — ${formatTokens(totalTokens)} | ${visible.length} visible messages`);
    lines.push("");
    if (visible.length === 0) {
        lines.push("  (no uncompressed messages)");
        return lines.join("\n");
    }
    // Merge consecutive messages into ranges (by numeric ref), aggregating
    // token counts and dominant tool so the view reads as blocks, not a
    // per-message firehose — mirroring the Compressible Ranges output.
    interface Merged { startRef: string; endRef: string; startNum: number; count: number; tokens: number; tool: string; }
    const refNum = (ref: string): number => {
        const m = ref.match(/\d+/);
        return m ? parseInt(m[0], 10) : 0;
    };
    const merged: Merged[] = [];
    for (const m of visible) {
        const num = refNum(m.ref);
        const last = merged[merged.length - 1];
        if (last && num === last.startNum + last.count) {
            last.endRef = m.ref;
            last.count += 1;
            last.tokens += m.tokens;
        } else {
            merged.push({ startRef: m.ref, endRef: m.ref, startNum: num, count: 1, tokens: m.tokens, tool: m.tool });
        }
    }
    for (const r of merged.slice(0, 30)) {
        const range = r.count === 1 ? r.startRef : `${r.startRef}–${r.endRef}`;
        lines.push(`  ${range}  (${r.count} msgs, ${formatTokens(r.tokens)}${r.count > 1 ? ` (${Math.round(r.tokens / r.count)}/msg)` : ""}) ${r.tool}`);
    }
    if (merged.length > 30) {
        lines.push(`  ... and ${merged.length - 30} more ranges`);
    }
    return lines.join("\n");
}

function renderMessageDrilldown(
    visible: VisibleMessageInfo[],
    toolFilter: string | undefined,
    sort: string,
    limit: number,
): string {
    let filtered = visible;
    if (toolFilter) filtered = filtered.filter((m) => m.tool === toolFilter);

    if (sort === "time") filtered.sort((a, b) => a.index - b.index);
    else if (sort === "tool") filtered.sort((a, b) => a.tool.localeCompare(b.tool) || b.tokens - a.tokens);
    else filtered.sort((a, b) => b.tokens - a.tokens);

    const totalTokens = filtered.reduce((s, m) => s + m.tokens, 0);
    const allTokens = visible.reduce((s, m) => s + m.tokens, 0);
    const header = toolFilter
        ? `UNCOMPRESSED — ${toolFilter}: ${formatTokens(totalTokens)} | ${filtered.length} msgs | ${pct(totalTokens, allTokens)}% of visible`
        : `UNCOMPRESSED — ${formatTokens(totalTokens)} | ${filtered.length} msgs`;
    const lines = [header, `Sorted by ${sort}`, ""];
    const shown = filtered.slice(0, limit);
    for (const message of shown) {
        lines.push(`  ${message.ref} (${formatTokens(message.tokens)}) ${message.tool}`);
    }
    if (filtered.length > shown.length) {
        lines.push("");
        lines.push(`${shown.length} of ${filtered.length} shown.`);
    }
    return lines.join("\n");
}

function renderCompressedDrilldown(
    blocks: CompressionBlock[],
    state: CompressionState,
    sort: string,
    limit: number,
    countTokens: (t: string) => number,
): string {
    let sorted = [...blocks];
    if (sort === "time") sorted.sort((a, b) => a.createdAt - b.createdAt);
    else if (sort === "age") sorted.sort((a, b) => b.survivedCount - a.survivedCount);
    else
        sorted.sort(
            (a, b) =>
                effectiveCompressedTokens(b, state, countTokens) -
                    effectiveCompressedTokens(a, state, countTokens) ||
                b.createdAt - a.createdAt,
        );

    const totalSummary = sorted.reduce((s, b) => s + summaryTokensOf(b, countTokens), 0);
    const totalEffective = sorted.reduce(
        (s, b) => s + effectiveCompressedTokens(b, state, countTokens),
        0,
    );
    const lines = [
        `COMPRESSED — ${sorted.length} blocks | ${formatTokens(totalEffective)} original → ${formatTokens(totalSummary)} summary`,
    ];
    const breakdown = tierBreakdown(sorted, countTokens);
    if (breakdown) lines.push(`Tier usage: ${breakdown}`);
    lines.push("");
    const shown = sorted.slice(0, limit);
    for (const block of shown) {
        const nested = block.directBlockIds.length > 0 ? ` nested=[${block.directBlockIds.join(",")}]` : "";
        const topic = block.topic ?? "(no topic)";
        const eff = effectiveCompressedTokens(block, state, countTokens);
        lines.push(
            `  ${block.blockId} (${tierLabel(block)})  ${formatTokens(eff)}→${formatTokens(summaryTokensOf(block, countTokens))}  ${block.effectiveMessageIds.length} msgs  age=${block.survivedCount} ${block.generation}${nested}`,
        );
        lines.push(`    "${topic}"`);
    }
    if (sorted.length > shown.length) {
        lines.push("");
        lines.push(`${shown.length} of ${sorted.length} shown.`);
    }
    return lines.join("\n");
}

export function buildRecap(
    state: CompressionState,
    blockId?: string,
): string {
    const activeBlocks = state.blocks
        .filter((b) => b.active)
        .sort((a, b) => numericPart(a.blockId) - numericPart(b.blockId));

    if (blockId !== undefined) {
        const block = state.blocks.find((b) => b.blockId === blockId);
        if (!block) {
            const activeList = activeBlocks.map((b) => b.blockId).join(", ");
            return `Block ${blockId} not found. Active blocks: ${activeList}`;
        }
        if (!block.active) {
            return `Block ${blockId} is inactive (deactivated by nested compression).`;
        }
        const range = `${block.effectiveMessageIds.length} messages`;
        return `[Compressed conversation section]\n${block.summary}\n\n[${blockId} | ${range} | topic: "${block.topic ?? "(none)"}"]`;
    }

    if (activeBlocks.length === 0) return "No active compression blocks.";

    const lines = [`Active compression blocks (${activeBlocks.length}):`];
    for (const block of activeBlocks) {
        const range = `${block.effectiveMessageIds.length} messages`;
        const preview = block.summary.slice(0, 200);
        lines.push(`\n${block.blockId} | ${range} | "${block.topic ?? "(none)"}"`);
        lines.push(`  ${preview}${block.summary.length > 200 ? "..." : ""}`);
    }
    lines.push(`\nCall with blockId to get the full summary.`);
    return lines.join("\n");
}
