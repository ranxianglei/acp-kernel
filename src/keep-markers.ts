import { refForRaw } from "./refs.js";
import type { CompressionState, CoreMessage } from "./types.js";

const KEEP_REGEX = /\[\[KEEP:(m\d+)\]\]/g;
const REF_REGEX = /\[\[REF:(m\d+)\|([^\]]+)\]\]/g;

export interface KeepMarkerResult {
    summary: string;
    expandedCount: number;
    refCount: number;
    unresolvedRefs: string[];
}

export function resolveKeepMarkers(
    summary: string,
    messages: CoreMessage[],
    state: CompressionState,
    maxChars = 2000,
): KeepMarkerResult {
    const messageByRef = new Map<string, CoreMessage>();
    for (const message of messages) {
        const ref = refForRaw(state.messageRefs, message.id);
        if (ref) messageByRef.set(ref, message);
    }

    let expandedCount = 0;
    let refCount = 0;
    const unresolvedRefs: string[] = [];

    const expanded = summary
        .replace(KEEP_REGEX, (match, ref: string) => {
            const normalized = normalizeRef(ref);
            const message = normalized ? messageByRef.get(normalized) : undefined;
            if (!message) {
                unresolvedRefs.push(ref);
                return match;
            }
            expandedCount++;
            return formatKeptMessage(message, normalized!, maxChars);
        })
        .replace(REF_REGEX, (_match, ref: string, desc: string) => {
            const normalized = normalizeRef(ref);
            const message = normalized ? messageByRef.get(normalized) : undefined;
            if (!message) {
                unresolvedRefs.push(ref);
                return _match;
            }
            refCount++;
            return `[→ ${normalized}: ${desc.trim()}]`;
        });

    return { summary: expanded, expandedCount, refCount, unresolvedRefs };
}

function normalizeRef(ref: string): string | null {
    const match = /^m0*(\d{1,5})$/.exec(ref.trim().toLowerCase());
    if (!match || match[1] === undefined) return null;
    return `m${match[1].padStart(5, "0")}`;
}

function formatKeptMessage(message: CoreMessage, ref: string, maxChars: number): string {
    const label = labelFor(message);
    const body = truncate(message.text ?? "[empty message]", maxChars);
    return `\n--- [${ref}: ${label}] ---\n${body}\n--- end ---\n`;
}

function labelFor(message: CoreMessage): string {
    if (message.contentType === "tool-call" || message.contentType === "tool-result") {
        return message.toolName ?? "tool";
    }
    return message.role;
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + `\n... [truncated, ${text.length} chars total]`;
}
