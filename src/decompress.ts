import type { CompressionBlock, CompressionState, CoreMessage } from "./types.js";

export function parseBlockIdArg(arg: string): string | null {
    const normalized = arg.trim().toLowerCase();
    const refMatch = /^b0*(\d+)$/.exec(normalized);
    if (refMatch && refMatch[1] !== undefined) return `b${refMatch[1]}`;
    const numMatch = /^(\d+)$/.exec(normalized);
    if (numMatch && numMatch[1] !== undefined) return `b${numMatch[1]}`;
    return null;
}

export function findBlocksOverlappingMessages(
    state: CompressionState,
    messageIds: Set<string>,
): CompressionBlock[] {
    if (messageIds.size === 0) return [];
    const matched: CompressionBlock[] = [];
    for (const block of state.blocks) {
        if (!block.active) continue;
        if (block.effectiveMessageIds.some((id) => messageIds.has(id))) {
            matched.push(block);
        }
    }
    return matched.sort((a, b) => numericPart(a.blockId) - numericPart(b.blockId));
}

export function findActiveAncestor(state: CompressionState, blockId: string): string | null {
    const start = state.blocks.find((b) => b.blockId === blockId);
    if (!start) return null;
    const queue: string[] = [...start.directBlockIds];
    const visited = new Set<string>();
    while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        const current = state.blocks.find((b) => b.blockId === currentId);
        if (!current) continue;
        if (current.active) return current.blockId;
        for (const ancestorId of current.directBlockIds) {
            if (!visited.has(ancestorId)) queue.push(ancestorId);
        }
    }
    return null;
}

export interface DeactivateOptions {
    deep?: boolean;
}

export function deactivateBlock(
    state: CompressionState,
    blockIds: string[],
    options: DeactivateOptions = {},
): CompressionState {
    const targets = new Set(blockIds);

    const updated = state.blocks.map((block) => {
        if (!targets.has(block.blockId) || !block.active) return block;
        return {
            ...block,
            active: false,
            durationMs: block.durationMs,
            createdAt: block.createdAt,
        };
    });

    let final = updated;
    if (options.deep) {
        const visited = new Set<string>();
        const queue: string[] = [];
        for (const id of blockIds) {
            const block = updated.find((b) => b.blockId === id);
            if (block) queue.push(...block.directBlockIds);
        }
        while (queue.length > 0) {
            const id = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            final = final.map((block) => {
                if (block.blockId !== id) return block;
                queue.push(...block.directBlockIds);
                return block.active ? { ...block, active: false } : block;
            });
        }
    }

    return { ...state, blocks: final };
}

export interface RestoredPreviewResult {
    preview: string;
    restoredCount: number;
}

export function buildRestoredContentPreview(
    messages: CoreMessage[],
    beforeActiveMessageIds: Set<string>,
    state: CompressionState,
): RestoredPreviewResult {
    const restored: CoreMessage[] = [];
    for (const message of messages) {
        if (!beforeActiveMessageIds.has(message.id)) continue;
        const stillCovered = state.blocks.some(
            (b) => b.active && b.effectiveMessageIds.includes(message.id),
        );
        if (!stillCovered) restored.push(message);
    }

    if (restored.length === 0) return { preview: "", restoredCount: 0 };

    const lines: string[] = [];
    let totalLength = 0;
    const MAX_PREVIEW = 2000;
    const MAX_PER_MESSAGE = 200;

    for (const message of restored) {
        if (totalLength >= MAX_PREVIEW) break;
        const text = message.text ?? "";
        const truncated = text.length > MAX_PER_MESSAGE ? text.slice(0, MAX_PER_MESSAGE) + "..." : text;
        const label =
            message.toolName && message.contentType !== "text"
                ? `${message.toolName}: ${truncated}`
                : `[${message.role}] ${truncated}`;
        lines.push(label);
        totalLength += label.length + 1;
    }

    return { preview: lines.join("\n"), restoredCount: restored.length };
}

function numericPart(blockId: string): number {
    const match = /^b(\d+)$/.exec(blockId);
    return match && match[1] !== undefined ? Number(match[1]) : 0;
}
