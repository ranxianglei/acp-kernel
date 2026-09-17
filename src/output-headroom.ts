/** Default cap on the output-headroom reservation, as a fraction of the
 *  context window. Reserving the FULL registered max output halves the
 *  effective input budget on models whose max_tokens is a large share of the
 *  window (e.g. 131072 on a 262144 window), while real per-turn replies rarely
 *  approach it. Capping at 25% keeps the guarantee where it matters — any
 *  single-turn reply up to the reserved amount still fits at the emergency
 *  threshold — while bounding the budget loss. A reply longer than the
 *  reservation overflows once; host-side overflow self-heal recovers it on the
 *  next turn. */
export const DEFAULT_OUTPUT_HEADROOM_MAX_PCT = 0.25;

/** Resolve a user-configured `outputHeadroomMaxPct` (ratio or "N%" string) to
 *  a numeric cap, falling back to DEFAULT_OUTPUT_HEADROOM_MAX_PCT when unset.
 *  Shared by every headroom call site so they all measure against the SAME
 *  capped limit. Hosts keep their own config parsing/validation strictness —
 *  this only normalizes an already-accepted value. A non-numeric string yields
 *  NaN, which reserveOutputHeadroom treats as "not provided" (legacy full
 *  reservation). */
export function resolveOutputHeadroomCap(value: number | string | undefined): number {
  if (value === undefined) return DEFAULT_OUTPUT_HEADROOM_MAX_PCT;
  if (typeof value === "number") return value;
  const s = value.trim();
  return s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
}

/** Reserve the model's OUTPUT budget from the context window so the nudge and
 *  truncate bands (a fraction of the window) sit below (window - reserved) and
 *  a context+output overflow can't happen on a small window. Returns the
 *  effective window to hand to the kernel. No-op unless maxOutput is a positive
 *  finite number that leaves a usable window (maxOutput < window) — a request
 *  whose output budget is >= the whole window is degenerate and host-side
 *  overflow self-heal handles the resulting overflow instead.
 *  `capPct` bounds the reservation as a fraction of the window:
 *  reserved = min(maxOutput, capPct × window). Semantics: <= 0 → no
 *  reservation; (0,1) → capped reservation; >= 1 or non-finite → legacy
 *  full-capability reservation (input + a response using its ENTIRE output
 *  budget always fits — what strict backends like SGLang/vLLM enforce). */
export function reserveOutputHeadroom(window: number, maxOutput: number, capPct: number = 1): number {
  if (Number.isFinite(window) && window > 0 && Number.isFinite(maxOutput) && maxOutput > 0 && maxOutput < window) {
    const cap = Number.isFinite(capPct) ? Math.max(0, Math.min(capPct, 1)) : 1;
    const reserved = Math.min(maxOutput, cap * window);
    return reserved > 0 ? window - reserved : window;
  }
  return window;
}

const ANTHROPIC_PROTOCOLS = new Set(["anthropic", "anthropicmessages"]);

function normalizeProtocol(protocol: string): string {
  return protocol.trim().toLowerCase().replace(/[-_\s]/g, "");
}

/** Whether the OUTPUT budget should be reserved from the context window at all.
 *  Anthropic's Messages API enforces the input limit INDEPENDENTLY of
 *  max_tokens (the output budget is separate — input up to the window works
 *  with any max_tokens), so reserving it would shift the nudge/truncate bands
 *  down by maxOutput on every session with no safety gain. OpenAI-family APIs
 *  count output against the window, so the reservation is needed there.
 *  Unknown/other protocols reserve (conservative — a missed reservation at
 *  worst overflows once and host-side self-heal corrects it). Hosts pass their
 *  own protocol identifiers ("anthropic", "anthropic-messages", …); matching is
 *  case- and separator-insensitive. */
export function shouldReserveOutputHeadroom(protocol: string | undefined): boolean {
  if (protocol === undefined) return true;
  return !ANTHROPIC_PROTOCOLS.has(normalizeProtocol(protocol));
}

/** Apply the output-headroom reservation to any config carrying a
 *  modelContextLimit. Returns a NEW object when the reservation changes the
 *  limit, the same object otherwise. No model or exempt protocol → unchanged. */
export function applyOutputHeadroom<T extends { modelContextLimit: number }>(
  config: T,
  model: { maxTokens?: number; api?: string } | undefined,
  capPct: number = 1,
): T {
  const maxOutput = model?.maxTokens ?? 0;
  if (shouldReserveOutputHeadroom(model?.api)) {
    const reserved = reserveOutputHeadroom(config.modelContextLimit, maxOutput, capPct);
    if (reserved !== config.modelContextLimit) return { ...config, modelContextLimit: reserved };
  }
  return config;
}
