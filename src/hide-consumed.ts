import type { CompressionState, CoreMessage } from "./types.js";

// Orphaned compress calls (no matching block — failed attempts, or historical
// calls whose blocks predate compressCallId recording) keep their NEWEST two
// call+result pairs visible: failures must stay observable or a deterministic
// model re-issues the same no-op compress forever, pinned at a fixed point
// (billion-context-pi issue #9: 3,849 identical calls over 5h13m under
// KEEP_LAST_ORPHANED=0). Older orphans are hidden, so the residue is bounded
// at two pairs regardless of session length — PR #18's unbounded accumulation
// does not return (its own live check showed the cap: 10 in → 6 out).
const KEEP_LAST_ORPHANED = 2;

export interface HideConsumedResult {
    messages: CoreMessage[];
    hidden: number;
}

function rangeKey(startRef: string, endRef: string): string {
    return `${startRef}::${endRef}`;
}

function rewriteCompressText(text: string | undefined, liveKeys: Set<string>): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text ?? "");
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as { content?: unknown };
    const content = obj.content;
    if (!Array.isArray(content) || content.length === 0) return null;

    const kept = content.filter((entry): entry is Record<string, unknown> => {
        if (!entry || typeof entry !== "object") return false;
        const s = typeof entry.startId === "string" ? entry.startId : typeof entry.messageId === "string" ? entry.messageId : "";
        const e = typeof entry.endId === "string" ? entry.endId : typeof entry.messageId === "string" ? entry.messageId : "";
        return liveKeys.has(rangeKey(s, e));
    });

    if (kept.length === content.length || kept.length === 0) return null;

    return JSON.stringify({ ...obj, content: kept });
}

export function hideConsumedCompressCalls(
    state: CompressionState,
    messages: CoreMessage[],
): HideConsumedResult {
    const allBlockCallIds = new Set<string>();
    const activeCallIds = new Set<string>();
    const liveRangeKeysByCallId = new Map<string, Set<string>>();
    const legacyLiveByCallId = new Set<string>();
    for (const block of state.blocks) {
        if (!block.compressCallId) continue;
        allBlockCallIds.add(block.compressCallId);
        if (!block.active) continue;
        activeCallIds.add(block.compressCallId);
        if (block.startRef === undefined || block.endRef === undefined) {
            legacyLiveByCallId.add(block.compressCallId);
            continue;
        }
        let keys = liveRangeKeysByCallId.get(block.compressCallId);
        if (!keys) {
            keys = new Set<string>();
            liveRangeKeysByCallId.set(block.compressCallId, keys);
        }
        keys.add(rangeKey(block.startRef, block.endRef));
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
        if (
            message.toolName === "compress" &&
            message.contentType === "tool-call" &&
            message.toolCallId &&
            keepCallIds.has(message.toolCallId)
        ) {
            const liveKeys = liveRangeKeysByCallId.get(message.toolCallId);
            if (liveKeys && liveKeys.size > 0 && !legacyLiveByCallId.has(message.toolCallId)) {
                const rewritten = rewriteCompressText(message.text, liveKeys);
                if (rewritten !== null) {
                    result.push({ ...message, text: rewritten });
                    continue;
                }
            }
        }
        result.push(message);
    }

    return { messages: result, hidden };
}
