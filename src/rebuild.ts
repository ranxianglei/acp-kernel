import { createCore } from "./compress.js";
import { assignRefs, highestUsedIndex } from "./refs.js";
import { defaultCountTokens } from "./tokenize.js";
import type { CompressionState, CoreMessage } from "./types.js";

export interface CompressInputEntry {
    startId?: string;
    endId?: string;
    messageId?: string;
    summary: string;
    topic?: string;
}

export interface RebuildResult {
    state: CompressionState;
    blocksRebuilt: number;
}

export interface RebuildPorts {
    countTokens?: (text: string) => number;
}

/**
 * Fork-recovery: reconstruct compression state by replaying historical
 * `compress` tool-call messages. Message refs (mNNNNN) are assigned by
 * message order, so they are fork-stable — a ref in a historical compress
 * input points to the same logical message after a fork regenerates IDs.
 * The rebuilt state is an approximation: only raw model summaries are
 * replayed (no protected-content enrichments).
 */
export function rebuildCompressionState(
    state: CompressionState,
    messages: CoreMessage[],
    config: import("./types.js").Config,
    ports: RebuildPorts = {},
): RebuildResult {
    const core = createCore({ countTokens: ports.countTokens ?? defaultCountTokens });
    const refResult = assignRefs(messages, {
        existing: state.messageRefs,
        nextIndex: highestUsedIndex(state.messageRefs) + 1,
    });
    let working: CompressionState = { ...state, messageRefs: refResult.map };

    const invocations = collectCompressInvocations(messages);
    let blocksRebuilt = 0;

    for (const invocation of invocations) {
        const ranges = extractRanges(invocation.input, invocation.callId);
        if (ranges.length === 0) continue;
        const result = core.applyCompression({ ranges, messages, state: working, config });
        working = result.state;
        blocksRebuilt += result.result.blocksCreated;
    }

    return { state: working, blocksRebuilt };
}

interface CompressInvocation {
    callId: string | undefined;
    input: unknown;
}

function collectCompressInvocations(messages: CoreMessage[]): CompressInvocation[] {
    const invocations: CompressInvocation[] = [];
    for (const message of messages) {
        if (message.toolName !== "compress" || message.contentType !== "tool-call") continue;
        let input: unknown;
        try {
            input = JSON.parse(message.text ?? "");
        } catch {
            continue;
        }
        invocations.push({ callId: message.toolCallId, input });
    }
    return invocations;
}

function extractRanges(
    input: unknown,
    callId: string | undefined,
): Array<{
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
}> {
    const content = (input as { content?: unknown[] })?.content;
    if (!Array.isArray(content)) return [];
    const ranges = [];
    for (const entry of content) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as CompressInputEntry;
        if (typeof e.summary !== "string") continue;
        const start = e.startId ?? e.messageId;
        const end = e.endId ?? e.messageId;
        if (typeof start !== "string" || typeof end !== "string") continue;
        ranges.push({
            startRef: start,
            endRef: end,
            summary: e.summary,
            topic: typeof e.topic === "string" ? e.topic : undefined,
            compressCallId: callId,
        });
    }
    return ranges;
}
