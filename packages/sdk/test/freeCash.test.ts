/**
 * One partner vault's free cash (D335, docs/api.md "Accounting"): what withdrawals are paid from now, what comes back as
 * its loans end, if repaid, and the share of the vault a new loan must leave free (`bufferBps`), through the SDK's read
 * and its tool.
 */
import { describe, expect, it } from "vitest";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { gageFrom } from "../src/client.js";
import { gageTools } from "../src/tools.js";
import { A, assetManifest, CORE, ctx, fakeChain, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_VAULT, GLDX, SCHIFFY, VAULT } from "../src/testing.js";

const E18 = 10n ** 18n;
const row = (address: string, core: string, settings?: unknown) => ({
  address, creator: A(1), curator: A(1), core, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [SCHIFFY], fundingEnabled: true,
  ...(settings === undefined ? {} : { settings }),
});
// SILICON's free cash and its first two days on mainnet, 24 October 2026 (the indexer's test reads all eight loans).
const LIQUIDITY = {
  free: "8119910892",
  schedule: [{ by: 1_793_297_734, amount: "1288940678" }, { by: 1_793_354_661, amount: "414007366" }],
  settling: "0",
};
const index = (liquidity: unknown, settings: unknown = { bufferBps: 1000, maxAssetBps: 10000 }) => fakeUpstream({
  "/intent/partners/vaults?": (path: string) => ({ status: 200, body: { items: path.includes(`factory=${GLD_FACTORY}`) ? [row(GLD_VAULT, GLD_CORE, settings)] : [row(VAULT, CORE, settings)], nextCursor: null } }),
  "/intent/partners/vaults/": {
    pricing: { totalAssets: "10737190156", totalSupply: "10737000000000000000000", assetsPerShare: "1000017" },
    liquidity, settlement: { due: false, settleable: [] },
  },
  "/intent/partners/links": { links: [{ link: "silicon", vault: VAULT }] },
});
const refusal = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

describe("a vault's free cash (D335)", () => {
  it("says what withdrawals are paid from now, what comes back by day if repaid, and the cash kept free, in USDG's names", async () => {
    const c = ctx({ indexer: index(LIQUIDITY) });
    const answer = await gageFrom(c).vaultFreeCash({ vault: VAULT });
    expect(answer).toMatchObject({
      vault: VAULT, link: "https://testnet.gage.cash/v/silicon",
      freeCashUSDG: "8119910892", settlingUSDG: "0", totalAssetsUSDG: "10737190156",
      schedule: [{ by: 1_793_297_734, amountUSDG: "1288940678" }, { by: 1_793_354_661, amountUSDG: "414007366" }],
      bufferBps: 1000, settlementDue: false,
    });
    expect(answer).not.toHaveProperty("freeCash");
    expect(answer.note).toMatch(/^Raw USDG \(6 decimals\)\. freeCashUSDG is what withdrawals are paid from now\./);
    expect(answer.note).toContain("only if their borrowers repay");
    expect(answer.note).toContain("brings back no cash: its collateral goes to the vault's holders");
    expect(answer.note).not.toMatch(/\b(interest|yield)\b/i);
  });

  it("names a lend asset's figures for what they are, in its asset", async () => {
    const c = ctx({ d: parseDeployment(assetManifest()), indexer: index({ free: String(4n * E18), schedule: [{ by: 1_793_297_734, amount: String(E18) }], settling: String(E18 / 2n) }) });
    const answer = await gageFrom(c).vaultFreeCash({ vault: GLD_VAULT });
    expect(answer).toMatchObject({
      vault: GLD_VAULT, freeCash: String(4n * E18), settling: String(E18 / 2n), schedule: [{ by: 1_793_297_734, amount: String(E18) }],
      asset: { token: GLDX, symbol: "GLDx", decimals: 18 },
    });
    expect(answer).not.toHaveProperty("freeCashUSDG");
    expect(answer.note).toMatch(/^Raw units of the vault's asset \(asset, 18 decimals\)\. freeCash is/);
  });

  it("reads an index before D335, or one answering a malformed schedule, as not serving it, never as nothing to come", async () => {
    // The vault list's settings, unread or malformed, leave the cash kept free unknown too.
    for (const [liquidity, settings] of [[{ free: "5" }, null], [{ free: "5", schedule: [{ by: "soon", amount: "1" }], settling: "x" }, { bufferBps: "x" }]] as const) {
      const answer = await gageFrom(ctx({ indexer: index(liquidity, settings) })).vaultFreeCash({ vault: VAULT });
      expect(answer).toMatchObject({ freeCashUSDG: "5", schedule: null, settlingUSDG: null, bufferBps: null });
      expect(answer.note).toContain("this index does not serve them yet");
    }
  });

  it("refuses an address that is not a partner vault of a current core, and a malformed one", async () => {
    const chain = fakeChain({ isVault: () => Promise.resolve(false) });
    expect(await refusal(gageFrom(ctx({ indexer: index(LIQUIDITY), chain })).vaultFreeCash({ vault: VAULT }))).toBe("UNKNOWN_VAULT");
    expect(await refusal(gageFrom(ctx({ indexer: index(LIQUIDITY) })).vaultFreeCash({ vault: "0x12" }))).toBe("INVALID_INPUT");
  });

  it("is a read tool beside gage_earn_vaults", async () => {
    const tools = gageTools(gageFrom(ctx({ indexer: index(LIQUIDITY) })));
    const names = tools.map((t) => t.name);
    expect(names.indexOf("gage_vault_free_cash")).toBe(names.indexOf("gage_earn_vaults") + 1);
    const tool = tools.find((t) => t.name === "gage_vault_free_cash")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(await tool.execute({ vault: VAULT })).toMatchObject({ freeCashUSDG: "8119910892", bufferBps: 1000 });
  });
});
