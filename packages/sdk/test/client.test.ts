import { describe, expect, it } from "vitest";
import { createGage } from "../src/client.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { MAINNET_DEFAULTS, TESTNET_DEFAULTS } from "../src/networks.js";

/** A fetch that records every URL it is asked for and answers 404, as a service without the route does. */
function recording() {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 }));
  };
  return { urls, fetch };
}
const LOOP_BUY = "/quote/loop-buy?token=0x0000000000000000000000000000000000000011&buy=1&slippageBps=50";

// Leverage asks gage's valuation service for an aggregator's route (D243): on mainnet KyberSwap's, on the testnet, from
// r7, the route of gage's stand-in for KyberSwap's router (D245). Without the service it never sees one.
describe("the valuation service", () => {
  it("is the network's own when none is named, as every other default", async () => {
    const { urls, fetch } = recording();
    await createGage({ fetch }).ctx.valuation?.raw(LOOP_BUY);
    await createGage({ fetch, network: "testnet" }).ctx.valuation?.raw(LOOP_BUY);
    expect(urls).toEqual([`https://valuation-production-2d79.up.railway.app${LOOP_BUY}`, `https://valuation-rehearsal.up.railway.app${LOOP_BUY}`]);
    expect(TESTNET_DEFAULTS.valuationUrl).toBe("https://valuation-rehearsal.up.railway.app");
  });

  it("is the one named, and none when it is null: leverage then buys through the manifest's pools only", async () => {
    const { urls, fetch } = recording();
    await createGage({ fetch, valuationUrl: "https://valuation.example" }).ctx.valuation?.raw(LOOP_BUY);
    expect(urls).toEqual([`https://valuation.example${LOOP_BUY}`]);
    expect(createGage({ fetch, valuationUrl: null }).ctx.valuation).toBeUndefined();
  });
});

// Mainnet (D260, D311): the default, the bundled mainnet manifest with every default mainnet's; nothing points at the
// testnet unless it is named or a testnet manifest is given.
describe("the network", () => {
  it("is mainnet unless the testnet is named, or a manifest says otherwise", () => {
    expect(createGage().deployment.chainId).toBe(4663);
    expect(createGage({ network: "testnet" }).deployment.chainId).toBe(46630);
    expect(createGage({ manifest: TESTNET_MANIFEST }).deployment.chainId).toBe(46630);
  });

  it("named mainnet, is Robinhood Chain with gage.cash's own services", async () => {
    const { urls, fetch } = recording();
    const gage = createGage({ network: "mainnet", fetch });
    expect(gage.deployment.chainId).toBe(4663);
    await gage.ctx.valuation?.raw(LOOP_BUY);
    await gage.ctx.indexer.raw("/health/indexer").catch(() => undefined);
    await gage.ctx.rates.raw("/health").catch(() => undefined);
    expect(urls).toEqual([
      `https://valuation-production-2d79.up.railway.app${LOOP_BUY}`,
      "https://indexer-production-a5e5.up.railway.app/health/indexer",
      "https://rates-mainnet.up.railway.app/health",
    ]);
    expect(MAINNET_DEFAULTS).toMatchObject({ network: "mainnet", chainId: 4663, appUrl: "https://gage.cash", faucetUrl: null });
  });

  it("refuses a manifest of the other network, or a network it does not know", () => {
    expect(() => createGage({ network: "mainnet", manifest: TESTNET_MANIFEST })).toThrow(/mainnet/);
    expect(() => createGage({ network: "Mainnet" as "mainnet" })).toThrow(/Unknown network/);
  });
});
