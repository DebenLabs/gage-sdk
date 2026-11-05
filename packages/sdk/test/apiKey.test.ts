import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGage } from "../src/client.js";
import { ApiError } from "../src/errors.js";
import { suggestCurve } from "../src/intent.js";
import { CORE, fakeUpstream, NVDA } from "../src/testing.js";
import { createUpstream } from "../src/upstream.js";

/**
 * A Rates API key (D382): sent to the rates service only, and never needed to borrow. The quotes are the rates service's
 * own answer to one request, whole (a key's bearer) and slim (a caller without one, once the service limits them).
 */
/** The app's fixture of those quotes, in gage's main repository; gage-sdk's public mirror (D308) has no web/. */
const FIXTURE = new URL("../../../web/src/test/fixtures/ratesSlimQuote.json", import.meta.url);
const QUOTES = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<"automatic", { full: unknown; slim: unknown }> : null;
const KEY = "a".repeat(40);
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? `${e.code}${e.retryable ? " (retry)" : ""}` : String(e); } };
/** A fetch that answers `{}` and keeps each request's URL and Authorization header. */
function recording(status = 200) {
  const seen: [string, string | null][] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    seen.push([url, new Headers(init?.headers).get("authorization")]);
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  return { seen, fetcher };
}

describe("a Rates API key", () => {
  it("is sent as a bearer to the upstream it is given to, and nothing is sent without one", async () => {
    const { seen, fetcher } = recording();
    await createUpstream("https://rates.test", fetcher, { apiKey: ` ${KEY} ` }).raw("/rates/suggest?x=1");
    await createUpstream("https://rates.test", fetcher).raw("/rates/suggest?x=1");
    expect(seen).toEqual([["https://rates.test/rates/suggest?x=1", `Bearer ${KEY}`], ["https://rates.test/rates/suggest?x=1", null]]);
    expect(() => createUpstream("https://rates.test", fetcher, { apiKey: "two words" })).toThrow("one word");
  });

  it("goes to the rates service only, never to the indexer or the valuation service", async () => {
    const { seen, fetcher } = recording();
    const gage = createGage({ network: "testnet", apiKey: KEY, fetch: fetcher });
    await Promise.all([gage.ctx.rates.raw("/health"), gage.ctx.indexer.raw("/health"), gage.ctx.valuation?.raw("/health")]);
    const by = Object.fromEntries(seen.map(([url, auth]) => [new URL(url).host, auth]));
    expect(Object.values(by)).toHaveLength(3);
    for (const [host, auth] of Object.entries(by)) expect([host, auth]).toEqual([host, host.startsWith("rates") ? `Bearer ${KEY}` : null]);
  });

  it("is not needed to borrow: a 429 is RATE_LIMITED and retryable, never a refusal of the terms", async () => {
    const { fetcher } = recording(429);
    expect(await code(createUpstream("https://rates.test", fetcher).raw("/rates/suggest"))).toBe("RATE_LIMITED (retry)");
    expect(await code(createUpstream("https://rates.test", fetcher).get("/intent/partners/vaults", {} as never))).toBe("RATE_LIMITED (retry)");
  });

  it.skipIf(QUOTES === null)("is not needed to size a loan: the slim quote's curve is the whole quote's", async () => {
    const a = { chainId: 46630, engine: CORE, token: NVDA, collateral: 10n ** 9n, term: 604800, maxRepaymentBps: 7000 };
    const full = await suggestCurve(fakeUpstream({ "/rates/suggest": QUOTES!.automatic.full }), a);
    const slim = await suggestCurve(fakeUpstream({ "/rates/suggest": QUOTES!.automatic.slim }), a);
    expect(slim.curve.length).toBeGreaterThan(10);
    expect(slim).toEqual(full);
  });
});
