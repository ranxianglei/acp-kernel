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

// Adapters (pi) persist the rendered ref tag in front of the tool-call text,
// so the JSON args no longer start at index 0. Locate the first "{" instead of
// parsing the raw text — the prefix is preserved on output.
function parseCallText(text: string | undefined): { prefix: string; obj: Record<string, unknown>; content: unknown[] } | null {
    const raw = text ?? "";
    const start = raw.indexOf("{");
    if (start < 0) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.slice(start));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.content) || obj.content.length === 0) return null;
    return { prefix: raw.slice(0, start), obj, content: obj.content };
}

function rewriteCompressText(text: string | undefined, liveKeys: Set<string>): string | null {
    const parsed = parseCallText(text);
    if (!parsed) return null;
    const { prefix, obj, content } = parsed;

    const kept = content.filter((entry): entry is Record<string, unknown> => {
        if (!entry || typeof entry !== "object") return false;
        const e = entry as Record<string, unknown>;
        const s = typeof e.startId === "string" ? e.startId : typeof e.messageId === "string" ? e.messageId : "";
        const end = typeof e.endId === "string" ? e.endId : typeof e.messageId === "string" ? e.messageId : "";
        return liveKeys.has(rangeKey(s, end));
    });

    if (kept.length === 0) return null;

    return prefix + serializeCompacted(obj, kept).text;
}

// Live compress-call args duplicate every range's full summary text while the
// rendered acp_summary message already carries it — on long sessions the
// duplication alone measured ~22K tokens (billion-context-pi #336). Keep a
// leading stub for recall; the block remains the durable record.
const SUMMARY_STUB_CHARS = 200;

function compactEntry(entry: unknown): unknown {
    if (!entry || typeof entry !== "object") return entry;
    const e = entry as Record<string, unknown>;
    if (typeof e.summary !== "string" || e.summary.length <= SUMMARY_STUB_CHARS) return entry;
    return { ...e, summary: `${e.summary.slice(0, SUMMARY_STUB_CHARS - 1)}…` };
}

function serializeCompacted(obj: Record<string, unknown>, content: unknown[]): { text: string; changed: boolean } {
    let changed = false;
    const compacted = content.map((entry) => {
        const out = compactEntry(entry);
        if (out !== entry) changed = true;
        return out;
    });
    return { text: JSON.stringify({ ...obj, content: compacted }), changed };
}

function compactCompressText(text: string | undefined): string | null {
    const parsed = parseCallText(text);
    if (!parsed) return null;
    const { prefix, obj, content } = parsed;
    const { text: out, changed } = serializeCompacted(obj, content);
    return changed ? prefix + out : null;
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
            const compacted = compactCompressText(message.text);
            if (compacted !== null) {
                result.push({ ...message, text: compacted });
                continue;
            }
        }
        result.push(message);
    }

    return { messages: result, hidden };
}
