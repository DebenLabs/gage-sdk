import type { z } from "zod";
import { ApiError } from "./errors.js";

/** One of gage's own read services (indexer, rates), read with a timeout, a size limit and no redirect. */
export interface Upstream {
  /** The body and status, whatever the status: the rates service refuses in a JSON body with fixed codes. */
  raw(path: string): Promise<{ status: number; body: unknown }>;
  get<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>>;
}

/** The most of an answer read, in bytes. */
const LIMIT = 4_000_000;
/** How long an answer may take, body included, from its request. */
const TIMEOUT_MS = 25_000;

const unavailable = () => new ApiError("UPSTREAM_UNAVAILABLE", "A gage data service did not answer", 503, true);
const tooLarge = () => new ApiError("UPSTREAM_TOO_LARGE", "A gage data service answered more than this API passes on", 503);

/**
 * The body as text, read up to LIMIT bytes and before `deadline`: past either, the read is cancelled. The whole body
 * was buffered before its size was checked, in characters, and a request's abort signal stops reaching a body once
 * garbage is collected, so one that trickled in was read without end (the audit of 18 October 2026).
 */
async function bodyOf(response: Response, deadline: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, late = false;
  const timer = setTimeout(() => { late = true; void reader.cancel().catch(() => undefined); }, Math.max(0, deadline - Date.now()));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    throw error instanceof ApiError ? error : unavailable();
  } finally {
    clearTimeout(timer);
  }
  if (late) throw unavailable();
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function createUpstream(baseUrl: string, fetcher: typeof fetch = globalThis.fetch, options: { timeoutMs?: number } = {}): Upstream {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Upstream must be an HTTP(S) URL without credentials, query or fragment");
  const root = base.href.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const raw = async (path: string) => {
    const deadline = Date.now() + timeoutMs;
    let response: Response;
    try {
      response = await fetcher(`${root}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { Accept: "application/json" } });
    } catch { throw unavailable(); }
    const text = await bodyOf(response, deadline);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* a non-JSON answer is read as no body */ }
    return { status: response.status, body };
  };
  return {
    raw,
    async get(path, schema) {
      const { status, body } = await raw(path);
      if (status === 404) throw new ApiError("NOT_FOUND", "gage has no record of that", 404);
      if (status !== 200) throw new ApiError("UPSTREAM_UNAVAILABLE", "A gage data service could not answer", 503, true);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new ApiError("UPSTREAM_INVALID", "A gage data service answered in an unexpected shape", 503);
      return parsed.data;
    },
  };
}
