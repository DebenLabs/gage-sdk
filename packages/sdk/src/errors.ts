/**
 * A refusal with a fixed code and fixed words: no upstream or RPC text ever reaches an agent (D221), and a service's own
 * code only when gage-sdk knows it. `details` carries figures a caller can act on, computed here (a minimum pledge,
 * raw), never another service's text.
 */
export class ApiError extends Error {
  readonly details: Record<string, unknown> | undefined;
  constructor(public readonly code: string, message: string, public readonly status = 409, public readonly retryable = false, options?: ErrorOptions & { details?: Record<string, unknown> }) {
    super(message, options);
    this.details = options?.details;
  }
}
export function requireThat(condition: unknown, code: string, message: string, status = 409, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new ApiError(code, message, status, false, details ? { details } : undefined);
}
/** What an agent is told of any failure: a refusal's own code, words and details, anything else one fixed answer. */
export function refusalOf(error: unknown): { code: string; message: string; retryable: boolean; details?: Record<string, unknown> } {
  if (!(error instanceof ApiError)) return { code: "UNAVAILABLE", message: "gage could not answer this now", retryable: true };
  return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) };
}
