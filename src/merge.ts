import { allocateBlockId, allocateRunId } from "./state.js";
import type { CompressionBlock, CompressionState } from "./types.js";

export interface MergeResult {
    state: CompressionState;
    mergedCount: number;
    savedTokens: number;
}

function numericPart(blockId: string): number {
    const match = /^b(\d+)$/.exec(blockId);
    return match && match[1] !== undefined ? Number(match[1]) : 0;
}

function truncateMergedSummary(merged: string, maxLength: number): string {
    if (merged.length <= maxLength) return merged;
    const blocks = merged.split("\n---\n");
    const headers = blocks
        .map((b) => b.split("\n")[0] ?? "")
        .filter((h) => h.trim().length > 0);
    const marker = "\n...\n[merged and truncated by batch cleanup]";
    const budget = Math.max(0, maxLength - marker.length);
    const headerJoin = headers.join("\n");
    return headerJoin.length <= budget ? headerJoin + marker : headerJoin.slice(0, budget) + marker;
}

export function mergeMarkedBlocks(
    state: CompressionState,
    markedIds: string[],
    maxMergedLength: number,
    countTokens: (text: string) => number,
): MergeResult {
    const sortedIds = [...new Set(markedIds)].sort((a, b) => numericPart(a) - numericPart(b));
    const sourceBlocks = sortedIds
        .map((id) => state.blocks.find((b) => b.blockId === id && b.active))
        .filter((b): b is CompressionBlock => b !== undefined);

    if (sourceBlocks.length < 2) {
        return { state, mergedCount: 0, savedTokens: 0 };
    }

    const next: CompressionState = {
        ...state,
        blocks: state.blocks.map((b) => ({ ...b })),
    };

    const newBlockId = allocateBlockId(next);
    const newRunId = allocateRunId(next);
    const bodies = sourceBlocks.map((block) => block.summary.trim());
    const mergedSummary = truncateMergedSummary(bodies.join("\n---\n"), maxMergedLength);
    const newSummaryTokens = countTokens(mergedSummary);

    const effectiveMessageIds = new Set<string>();
    const directMessageIds = new Set<string>();
    for (const block of sourceBlocks) {
        for (const id of block.effectiveMessageIds) effectiveMessageIds.add(id);
        for (const id of block.directMessageIds) directMessageIds.add(id);
    }
    const sourceIds = sourceBlocks.map((b) => b.blockId);

    const mergedBlock: CompressionBlock = {
        blockId: newBlockId,
        runId: newRunId,
        tier: sourceBlocks.reduce((min, b) => (b.tier < min ? b.tier : min), 3 as 1 | 2 | 3),
        topic: "Batch merge cleanup",
        summary: mergedSummary,
        directMessageIds: [...directMessageIds],
        effectiveMessageIds: [...effectiveMessageIds],
        directBlockIds: [...sourceIds],
        compressedTokens: sourceBlocks.reduce((sum, b) => sum + b.compressedTokens, 0),
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "old",
        active: true,
    };

    for (const block of next.blocks) {
        if (sourceIds.includes(block.blockId)) block.active = false;
    }
    next.blocks.push(mergedBlock);

    const sourceTokens = sourceBlocks.reduce(
        (sum, block) => sum + countTokens(block.summary),
        0,
    );
    const savedTokens = Math.max(0, sourceTokens - newSummaryTokens);

    return { state: next, mergedCount: sourceBlocks.length, savedTokens };
}

export function collectOldGenBlocks(
    state: CompressionState,
    maxOldGenSummaryLength: number,
): CompressionBlock[] {
    return state.blocks
        .filter(
            (b) =>
                b.active &&
                (b.generation === "old" || b.summary.length > maxOldGenSummaryLength),
        )
        .sort((a, b) => numericPart(a.blockId) - numericPart(b.blockId));
}
