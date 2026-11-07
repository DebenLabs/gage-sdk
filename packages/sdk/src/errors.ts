/**
 * A refusal with a fixed code and fixed words: no upstream or RPC text ever reaches an agent (D221), and a service's own
 * code only when gage-sdk knows it. `details` carries figures a caller can act on, computed here (a minimum pledge,
 * raw), never another service's text.
 */
/** The refusals asking again can clear, whoever raises them: a price or a quote that moves on, a service that comes back. */
const RETRYABLE: ReadonlySet<string> = new Set([
  "CHAIN_UNAVAILABLE", "NO_SALE", "PRICE_MOVED", "PRICING_EXPIRED", "PRICING_PROVISIONAL", "PRICING_UNAVAILABLE", "SALE_UNAVAILABLE", "TOKEN_PAUSED", "UNAVAILABLE",
]);
export class ApiError extends Error {
  readonly details: Record<string, unknown> | undefined;
  constructor(public readonly code: string, message: string, public readonly status = 409, public readonly retryable = RETRYABLE.has(code), options?: ErrorOptions & { details?: Record<string, unknown> }) {
    super(message, options);
    this.details = options?.details;
  }
}
export function requireThat(condition: unknown, code: string, message: string, status = 409, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new ApiError(code, message, status, undefined, details ? { details } : undefined);
}
/** The read a failure names and what the node answered, as viem names them: an HTTP status, a JSON-RPC error's code. */
export interface FailedCall { contractAddress?: string; functionName?: string; status?: number; code?: number }
/**
 * A failure as a caller's log may keep it: its kind, its one-line summary with any URL taken out, and the read that
 * failed with what the node answered (`FailedCall`), found down its causes. A node's own error spells out the node's URL,
 * a provider's key with it, and every log that follows `cause` prints what it finds there. Its answer, read again, is
 * the same.
 */
export function withoutUrls(error: unknown): Error & FailedCall {
  const from = error instanceof Error ? error : new Error(String(error));
  const { shortMessage, details, contractAddress, functionName } = from as { shortMessage?: unknown; details?: unknown; contractAddress?: unknown; functionName?: unknown };
  const words = typeof shortMessage === "string" ? `${shortMessage}${typeof details === "string" ? ` ${details}` : ""}` : from.message;
  const safe: Error & FailedCall = new Error(words.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").replace(/\s+/g, " ").trim().slice(0, 300));
  safe.name = from.name;
  if (typeof contractAddress === "string" && /^0x[0-9a-f]{40}$/i.test(contractAddress)) safe.contractAddress = contractAddress;
  if (typeof functionName === "string" && /^\w{1,64}$/.test(functionName)) safe.functionName = functionName;
  for (let at: unknown = from, depth = 0; typeof at === "object" && at !== null && depth < 8; at = (at as { cause?: unknown }).cause, depth++) {
    const { status, code } = at as { status?: unknown; code?: unknown };
    if (safe.status === undefined && Number.isInteger(status)) safe.status = status as number;
    if (safe.code === undefined && Number.isInteger(code)) safe.code = code as number;
  }
  return safe;
}
/** What an agent is told of any failure: a refusal's own code, words and details, anything else one fixed answer. */
export function refusalOf(error: unknown): { code: string; message: string; retryable: boolean; details?: Record<string, unknown> } {
  if (!(error instanceof ApiError)) return { code: "UNAVAILABLE", message: "gage could not answer this now", retryable: true };
  return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) };
}
