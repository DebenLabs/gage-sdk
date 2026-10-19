/** The examples (packages/sdk/examples) run as written against gage's own fakes, so they keep up with the API. */
import { describe, expect, it, vi } from "vitest";
import { agentTools } from "../examples/agent-tools.js";
import { deposit } from "../examples/deposit.js";
import { quote } from "../examples/quote.js";
import { gageFrom, type Gage } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { A, ctx, fakeSigner, mainnetManifest, NVDA } from "../src/testing.js";

const mainnet = () => gageFrom(ctx({ d: parseDeployment(mainnetManifest()) }));

describe("the examples", () => {
  it("quote: reads the terms and the collateral, then asks for one whole token (or its minimum) over the shortest term", async () => {
    const gage = mainnet();
    const nvda = (await gage.assets()).assets.find((a) => a.token === NVDA)!;
    const borrowQuote = vi.fn(() => Promise.resolve({ summary: "Pledge 1 NVDA…", prepare: { action: "borrow" } }));
    const answer = await quote({ ...gage, borrowQuote } as unknown as Gage, nvda.symbol.toLowerCase());
    const whole = 10n ** BigInt(nvda.decimals), least = BigInt(nvda.minAmount);
    const { terms } = await gage.capabilities();
    expect(borrowQuote).toHaveBeenCalledWith({ token: NVDA, maxCollateral: (least > whole ? least : whole).toString(), term: terms[0]!.seconds });
    expect(answer).toMatchObject({ asset: nvda.symbol, summary: "Pledge 1 NVDA…", terms: terms.map((t) => `${t.days} days`) });
    await expect(quote({ ...gage, borrowQuote } as unknown as Gage, "nothing")).rejects.toThrow("gage takes no nothing as collateral now");
  });

  it("deposit: the first USDG vault that takes deposits, the amount in raw USDG, carried out by the signer", async () => {
    const run = vi.fn(() => Promise.resolve({ status: "done" }));
    const earnVaults = () => Promise.resolve({ vaults: [
      { vault: A(0x71), lends: false, totalAssetsUSDG: "1" },
      { vault: A(0x72), lends: true, totalAssets: "1", asset: { symbol: "GLDx" } },
      { vault: A(0x73), lends: true, totalAssetsUSDG: "5" },
    ] });
    const signer = fakeSigner();
    await deposit({ ...mainnet(), earnVaults, run } as unknown as Gage, signer, "10.5");
    expect(run).toHaveBeenCalledWith({ action: "earn_deposit", vault: A(0x73), amount: "10500000" }, signer);
    const none = () => Promise.resolve({ vaults: [] });
    await expect(deposit({ ...mainnet(), earnVaults: none, run } as unknown as Gage, signer, "1")).rejects.toThrow("No partner vault takes USDG deposits now");
  });

  it("agent-tools: the catalogue without a signer, then capabilities and collateral through execute", async () => {
    const answer = await agentTools(mainnet());
    expect(answer.tools).toHaveLength(19);
    expect(answer.tools[0]).toBe("gage_capabilities: gage capabilities");
    expect(answer.capabilities).toMatchObject({ network: "mainnet", chainId: 4663 });
    expect(answer.collateral).toHaveProperty("assets");
  });
});
