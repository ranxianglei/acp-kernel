import type { CompressionState, CoreMessage } from "./types.js";

const KEEP_LAST_ORPHANED = 2;

export interface HideConsumedResult {
    messages: CoreMessage[];
    hidden: number;
}

// Keep active-block compress calls + the most recent orphaned calls; hide the rest.
export function hideConsumedCompressCalls(
    state: CompressionState,
    messages: CoreMessage[],
): HideConsumedResult {
    const activeCallIds = new Set<string>();
    const allBlockCallIds = new Set<string>();
    for (const block of state.blocks) {
        if (block.compressCallId) {
            allBlockCallIds.add(block.compressCallId);
            if (block.active) activeCallIds.add(block.compressCallId);
        }
    }

    const lastOrphanedCallIds: string[] = [];
    for (let i = messages.length - 1; i >= 0 && lastOrphanedCallIds.length < KEEP_LAST_ORPHANED; i--) {
        const message = messages[i]!;
        if (message.toolName !== "compress" || message.contentType !== "tool-call") continue;
        const callId = message.toolCallId;
        if (callId && !allBlockCallIds.has(callId)) {
            lastOrphanedCallIds.push(callId);
        }
    }

    const keepCallIds = new Set([...activeCallIds, ...lastOrphanedCallIds]);

    const hiddenCallIds = new Set<string>();
    for (const message of messages) {
        if (
            message.toolName === "compress" &&
            message.contentType === "tool-call" &&
            (!message.toolCallId || !keepCallIds.has(message.toolCallId))
        ) {
            if (message.toolCallId) hiddenCallIds.add(message.toolCallId);
        }
    }

    let hidden = 0;
    const result: CoreMessage[] = [];
    for (const message of messages) {
        if (
            message.toolName === "compress" &&
            message.contentType === "tool-call" &&
            (!message.toolCallId || !keepCallIds.has(message.toolCallId))
        ) {
            hidden++;
            continue;
        }
        if (
            message.contentType === "tool-result" &&
            message.toolCallId &&
            hiddenCallIds.has(message.toolCallId)
        ) {
            hidden++;
            continue;
        }
        result.push(message);
    }

    return { messages: result, hidden };
}
