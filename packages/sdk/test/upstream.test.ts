import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { createUpstream } from "../src/upstream.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const MB = 1_000_000;

/** A fetch answering 200 with a body streamed in chunks `next` makes (null ends it), counting the bytes pulled from it. */
function streaming(next: (n: number) => Promise<Uint8Array | null>) {
  const pulled = { bytes: 0 };
  let n = 0;
  const fetcher = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await next(n++);
      if (chunk === null) return controller.close();
      pulled.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }), { status: 200 }))) as typeof fetch;
  return { fetcher, pulled };
}

// The audit of 18 October 2026 (M6): the whole body was buffered before its size was checked, in characters, and the
// request's abort signal stopped reaching a body that trickled in.
describe("an upstream's answer", () => {
  it("is refused once it passes 4 MB, without the rest being read", async () => {
    const { fetcher, pulled } = streaming((n) => Promise.resolve(n < 64 ? new Uint8Array(MB).fill(0x20) : null));
    expect(await code(createUpstream("https://indexer.test", fetcher).raw("/x"))).toBe("UPSTREAM_TOO_LARGE");
    expect(pulled.bytes).toBeLessThanOrEqual(6 * MB);
  });

  it("is measured in bytes, not characters", async () => {
    // 1.5 million three-byte characters: 4.5 MB.
    const body = new TextEncoder().encode(JSON.stringify("€".repeat(1_500_000)));
    const { fetcher } = streaming((n) => Promise.resolve(n === 0 ? body : null));
    expect(await code(createUpstream("https://indexer.test", fetcher).raw("/x"))).toBe("UPSTREAM_TOO_LARGE");
  });

  it("is given up when it trickles past the deadline", async () => {
    const { fetcher } = streaming(() => new Promise((resolve) => setTimeout(() => resolve(new Uint8Array([0x20])), 20)));
    const started = Date.now();
    expect(await code(createUpstream("https://indexer.test", fetcher, { timeoutMs: 200 }).raw("/x"))).toBe("UPSTREAM_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 3_000);

  it("is read whole when it is small and in time", async () => {
    const { fetcher } = streaming((n) => Promise.resolve(n === 0 ? new TextEncoder().encode('{"ok":') : n === 1 ? new TextEncoder().encode("true}") : null));
    expect(await createUpstream("https://indexer.test", fetcher).raw("/x")).toEqual({ status: 200, body: { ok: true } });
  });
});
