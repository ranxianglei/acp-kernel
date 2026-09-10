import type { CoreMessage } from "./types.js";

function isAssistantAct(msg: CoreMessage): boolean {
  return (
    msg.role === "assistant" &&
    (msg.contentType === "text" || msg.contentType === "tool-call")
  );
}

/**
 * Atomic turn groups for compression integrity (#684).
 *
 * A turn is a reasoning run, the assistant text/tool-call burst that follows
 * it, and every tool-result paired (by toolCallId) to the burst's calls.
 * Strict-echo thinking providers (DeepSeek: "The `reasoning_content` in the
 * thinking mode must be passed back to the API") reject a rebuilt request
 * whose assistant tool-call turn survives without its reasoning, and every
 * OpenAI-wire provider rejects a result whose call is gone. Turns are
 * therefore atomic for folding: all members fold together, or none do.
 *
 * Grouping is adjacency-based, mirroring {@link adjustBoundariesForReasoningPairs}:
 * a reasoning run pairs with the assistant burst immediately following it.
 * Bursts without a preceding reasoning run still group with their sibling
 * calls and results. Messages belonging to no turn (user messages, system,
 * orphan reasoning, summaries) get no group — they carry no pairing
 * constraint. Groups are disjoint.
 *
 * @returns disjoint member-id arrays; a message appears in at most one group.
 */
export function computeTurnGroups(messages: CoreMessage[]): string[][] {
  const resultIdByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (
      msg.contentType === "tool-result" &&
      typeof msg.toolCallId === "string" &&
      msg.id
    ) {
      if (!resultIdByCallId.has(msg.toolCallId))
        resultIdByCallId.set(msg.toolCallId, msg.id);
    }
  }

  const grouped = new Set<string>();
  const groups: string[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!msg.id || grouped.has(msg.id)) continue;
    if (!(msg.contentType === "reasoning" || isAssistantAct(msg))) continue;

    let reasoningStart = i;
    if (msg.contentType === "reasoning") {
      while (
        reasoningStart > 0 &&
        messages[reasoningStart - 1]!.contentType === "reasoning"
      ) {
        reasoningStart--;
      }
    } else {
      let s = i;
      while (s > 0 && isAssistantAct(messages[s - 1]!)) s--;
      reasoningStart = s;
      while (
        reasoningStart > 0 &&
        messages[reasoningStart - 1]!.contentType === "reasoning"
      ) {
        reasoningStart--;
      }
    }
    const burstStart = (() => {
      let s = reasoningStart;
      while (s < messages.length && messages[s]!.contentType === "reasoning")
        s++;
      return s;
    })();
    if (burstStart >= messages.length || !isAssistantAct(messages[burstStart]!)) {
      // Orphan reasoning run (no companion burst): no pairing constraint.
      continue;
    }
    let burstEnd = burstStart;
    while (
      burstEnd + 1 < messages.length &&
      isAssistantAct(messages[burstEnd + 1]!)
    ) {
      burstEnd++;
    }

    const members = new Set<string>();
    for (let k = reasoningStart; k <= burstEnd; k++) {
      const m = messages[k]!;
      if (!m.id) continue;
      members.add(m.id);
      if (
        m.role === "assistant" &&
        m.contentType === "tool-call" &&
        typeof m.toolCallId === "string"
      ) {
        const rid = resultIdByCallId.get(m.toolCallId);
        if (rid) members.add(rid);
      }
    }
    for (const id of members) grouped.add(id);
    groups.push([...members]);
  }
  return groups;
}
