import { splitDemotedThinking } from "./demoted-thinking.js";
import { hashId } from "./util.js";
import { ClusterCounter, deriveMessageId } from "./message-id.js";
import { parseDataUrl, type BiliMessage } from "./bili-message.js";

export type OpenAIContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: string; [k: string]: unknown };

export type OpenAIToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

export type OpenAIMessage = {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content?: string | null | OpenAIContentPart[];
    reasoning_content?: string | null;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    name?: string;
};

export type OpenAITool = {
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
};

export type OpenAIRequestBody = {
    model?: string;
    messages: OpenAIMessage[];
    tools?: OpenAITool[];
    stream?: boolean;
    [key: string]: unknown;
};

type Flat = { msgs: BiliMessage[] };

export function openaiToCore(body: OpenAIRequestBody): Flat {
    const msgs: BiliMessage[] = [];
    const clusters = new ClusterCounter();
    for (const m of body.messages) {
        switch (m.role) {
            case "system":
            case "developer": {
                const base = deriveMessageId(m.role, "text", stringContent(m.content));
                msgs.push({ id: clusters.next(base), role: "system", contentType: "text", text: stringContent(m.content), originalRole: m.role });
                break;
            }
            case "user": {
                const text = stringContent(m.content);
                const imgs = allImageParts(m.content);
                const firstImg = imgs[0];
                const firstUrl = firstImg ? firstImg.image_url.url : undefined;
                const firstParsed = firstUrl ? parseDataUrl(firstUrl) : undefined;
                const base = deriveMessageId("user", "text", text);
                msgs.push({
                    id: clusters.next(base),
                    role: "user",
                    contentType: "text",
                    text,
                    ...(imgs.length === 1 && firstParsed
                        ? { rawOpenaiContent: imgs[0], imageMediaType: firstParsed.mediaType, imageBase64: firstParsed.base64 }
                        : imgs.length > 1
                            ? { rawOpenaiContentParts: imgs }
                            : {}),
                });
                break;
            }
            case "assistant": {
                const fieldReasoning = typeof m.reasoning_content === "string" ? m.reasoning_content : "";
                let reasoning = fieldReasoning;
                let text = stringContent(m.content);
                if (!reasoning) {
                    // Hosts that cannot replay prior-turn reasoning as a
                    // structured field inline it into content wrapped in a
                    // dialect tag (<think>, <thinking>, ```thinking). Split
                    // it back out BEFORE identity derivation so the inline
                    // form and the reasoning_content field form of one turn
                    // land in a single core-id/fingerprint space (issue #64
                    // demoted variant).
                    const split = splitDemotedThinking(text);
                    if (split) {
                        reasoning = split.reasoning;
                        text = split.text;
                    }
                }
                if (reasoning) {
                    const base = deriveMessageId("assistant", "reasoning", reasoning);
                    msgs.push({
                        id: clusters.next(base),
                        role: "assistant",
                        contentType: "reasoning",
                        text: reasoning,
                        reasoningContent: reasoning,
                    });
                }
                if (text) {
                    const base = deriveMessageId("assistant", "text", text);
                    msgs.push({ id: clusters.next(base), role: "assistant", contentType: "text", text });
                }
                if (Array.isArray(m.tool_calls)) {
                    for (const tc of m.tool_calls) {
                        const base = deriveMessageId("assistant", "tool-call", tc.function.arguments ?? "", {
                            toolCallId: tc.id,
                            toolName: tc.function.name,
                        });
                        msgs.push({
                            id: clusters.next(base),
                            role: "assistant",
                            contentType: "tool-call",
                            toolName: tc.function.name,
                            toolCallId: tc.id,
                            text: tc.function.arguments ?? "",
                        });
                    }
                }
                break;
            }
            case "tool": {
                const base = deriveMessageId("tool", "tool-result", stringContent(m.content), {
                    toolCallId: m.tool_call_id ?? "",
                });
                msgs.push({
                    id: clusters.next(base),
                    role: "tool",
                    contentType: "tool-result",
                    toolCallId: m.tool_call_id ?? "",
                    text: stringContent(m.content),
                });
                break;
            }
        }
    }
    return { msgs };
}

export function coreToOpenai(messages: BiliMessage[]): OpenAIMessage[] {
    const out: OpenAIMessage[] = [];
    let pending: { text: string | null; toolCalls: OpenAIToolCall[]; reasoning: string | null } | null = null;
    const flush = () => {
        if (!pending) return;
        const reasoning = pending.reasoning !== null && pending.reasoning.length > 0 ? pending.reasoning : undefined;
        if (pending.toolCalls.length > 0) {
            out.push({
                role: "assistant",
                content: pending.text ?? null,
                tool_calls: pending.toolCalls,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
            });
        } else if (pending.text !== null) {
            out.push({ role: "assistant", content: pending.text, ...(reasoning ? { reasoning_content: reasoning } : {}) });
        } else if (reasoning) {
            out.push({ role: "assistant", content: null, reasoning_content: reasoning });
        }
        pending = null;
    };
    for (const m of messages) {
        if (m.role === "assistant") {
            if (!pending) pending = { text: null, toolCalls: [], reasoning: null };
            if (m.contentType === "reasoning") {
                pending.reasoning = (pending.reasoning ?? "") + (m.reasoningContent ?? m.text ?? "");
            } else if (m.contentType === "text") {
                pending.text = (pending.text ?? "") + (m.text ?? "");
            } else if (m.contentType === "tool-call") {
                pending.toolCalls.push({
                    id: m.toolCallId ?? `call_${m.id}`,
                    type: "function",
                    function: { name: m.toolName ?? "unknown", arguments: m.text ?? "" },
                });
            }
        } else {
            flush();
            if (m.role === "system") {
                out.push({ role: m.originalRole === "developer" ? "developer" : "system", content: m.text ?? "" });
            } else if (m.role === "user") {
                if (m.rawOpenaiContent || m.imageBase64 || m.rawOpenaiContentParts) {
                    const parts: OpenAIContentPart[] = [];
                    if (m.text) parts.push({ type: "text", text: m.text });
                    if (m.rawOpenaiContentParts && m.rawOpenaiContentParts.length > 0) {
                        for (const part of m.rawOpenaiContentParts) parts.push(part as OpenAIContentPart);
                    } else if (m.rawOpenaiContent) {
                        parts.push(m.rawOpenaiContent as OpenAIContentPart);
                    } else if (m.imageBase64 && m.imageMediaType) {
                        parts.push({ type: "image_url", image_url: { url: `data:${m.imageMediaType};base64,${m.imageBase64}` } });
                    }
                    out.push({ role: "user", content: parts });
                } else {
                    out.push({ role: "user", content: m.text ?? "" });
                }
            } else if (m.role === "tool") {
                out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.text ?? "" });
            }
        }
    }
    flush();
    return out;
}

export function injectOpenaiSystem(messages: OpenAIMessage[], parts: string[]): OpenAIMessage[] {
    if (parts.length === 0) return messages;
    const extra = parts.join("\n\n");
    if (messages.length > 0 && (messages[0]?.role === "system" || messages[0]?.role === "developer")) {
        const head = messages[0] as OpenAIMessage;
        const base = stringContent(head.content);
        const merged = base ? `${base}\n\n---\n\n${extra}` : extra;
        return [{ ...head, content: merged }, ...messages.slice(1)];
    }
    return [{ role: "system", content: extra }, ...messages];
}

/** Extract the conversation dimension for OpenAI Chat: a client-provided
 *  session header if present, else a content fingerprint of the first user
 *  message. See conversationSignalAnthropic for the full rationale. */
export function conversationSignalOpenai(body: OpenAIRequestBody, headerValue?: string): string {
    if (headerValue && headerValue.trim()) return headerValue.trim();
    const firstUser = body.messages.find((m) => m.role === "user");
    const seed = firstUser ? stringContent(firstUser.content) : "default";
    return hashId(seed);
}

function stringContent(content: OpenAIMessage["content"]): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => (typeof p === "string" ? p : p.type === "text" ? (p as { text?: string }).text ?? "" : ""))
            .join("\n");
    }
    return "";
}

type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };

/** Collect ALL data-URL image parts in a user content array, in wire order.
 *  (firstImagePart only kept the first, which silently dropped images 2..N
 *  on the coreToOpenai rebuild.) */
function allImageParts(content: OpenAIMessage["content"]): OpenAIImagePart[] {
    if (!Array.isArray(content)) return [];
    const out: OpenAIImagePart[] = [];
    for (const p of content) {
        if (typeof p !== "object" || p === null) continue;
        if (!("type" in p) || p.type !== "image_url" || !("image_url" in p)) continue;
        // The union's index-signature member leaves image_url as `unknown`, so
        // narrow via a named const before reading the url.
        const imagePart = p as { image_url: { url?: unknown } };
        const url = imagePart.image_url.url;
        if (typeof url === "string" && parseDataUrl(url)) out.push(p as OpenAIImagePart);
    }
    return out;
}
