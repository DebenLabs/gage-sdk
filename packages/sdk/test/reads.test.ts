/**
 * The reads an agent decides from: what can be done with a loan now and where (this Gage, or gage.cash), the standing
 * instruction to roll it, the sGAGE each loan owes the wallet, a token's limits, and the short links gage.cash gives
 * partner vaults and tokens (D290).
 */
import { getAddress, maxUint256, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { gageFrom } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { assets, earnVaults, loan, portfolio } from "../src/reads.js";
import type { ActionName } from "../src/schemas.js";
import {
  A, assetManifest, CASHOUT, CORE, ctx, FACTORY, fakeChain, fakeUpstream, KEEPER, loan as chainLoan, mainnetManifest, manifest, NOW, NVDA, OLD, OTHER, position, REWARDS,
  ROLL_ROUTER, VAULT, WALLET,
} from "../src/testing.js";

const indexer = () => fakeUpstream({ "/v2/positions/": position("7") });
/** gage's valuation service, which a cash-out's sale comes from. */
const valuation = () => fakeUpstream({});
const standing = (borrower: Address = WALLET) => ({
  borrower, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 3, withRewards: false, until: NOW + 10 ** 7, maxCost: 40_000_000n, maxTopUp: 45_000_000n,
});
/** The hosted service's actions: those its review page draws (D301, D302). */
const HOSTED: ActionName[] = ["borrow", "leverage", "cancel", "reclaim", "earn_deposit", "earn_redeem", "collect", "feedback"];
const REPAY = "reclaim (holder of the reclaim right, before endsAt)";
const CASH_OUT = "cash_out (holder of the reclaim right, before endsAt)";
const ROLL = "roll (holder of the reclaim right, before endsAt)";
const AUTO = "auto_roll (holder of the reclaim right)";

describe("a running loan's actions", () => {
  it("are every way it can end or go on where the network has it: repay, cash out, roll, and roll by itself", async () => {
    const l = await gageFrom(ctx({ indexer: indexer(), valuation: valuation() })).loan({ loanId: "7" });
    expect(l.actions).toEqual([REPAY, CASH_OUT, ROLL, AUTO]);
    expect(l).toMatchObject({ state: "ACTIVE", closedBy: null, autoRoll: null });
  });

  it("carry the standing instruction to roll, as the router keeps it, and the way to end it", async () => {
    const asked: unknown[] = [];
    const chain = fakeChain({ autoRoll: (router: Address, id: bigint) => { asked.push([router, id]); return Promise.resolve(standing()); } });
    const l = await gageFrom(ctx({ indexer: indexer(), valuation: valuation(), chain })).loan({ loanId: "7" });
    expect(asked).toEqual([[getAddress(ROLL_ROUTER), 7n]]);
    expect(l.autoRoll).toEqual({
      borrower: WALLET, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 3, withRewards: false, until: NOW + 10 ** 7, maxCost: "40000000", maxTopUp: "45000000",
    });
    expect(l.actions).toEqual([REPAY, CASH_OUT, ROLL, AUTO, "cancel_auto_roll (the wallet that left the instruction)"]);
  });

  it("say which are done on gage.cash where this Gage does not serve them, as the hosted service does not", async () => {
    const hosted = gageFrom(ctx({ d: parseDeployment(mainnetManifest()), indexer: indexer(), valuation: valuation(), chain: fakeChain({ autoRoll: () => Promise.resolve(standing()) }) }), { actions: HOSTED });
    expect((await hosted.loan({ loanId: "7" })).actions).toEqual([
      REPAY,
      "cash_out on gage.cash (holder of the reclaim right, before endsAt)",
      "roll on gage.cash (holder of the reclaim right, in the loan's last day)",
      "auto_roll on gage.cash (holder of the reclaim right)",
      "cancel_auto_roll on gage.cash (the wallet that left the instruction)",
    ]);
  });

  it("leave out what the network or the loan's core does not have, and what is closed now", async () => {
    const actions = async (over: Parameters<typeof ctx>[0] = {}, input: { loanId: string; engine?: string } = { loanId: "7" }) =>
      (await loan(ctx({ indexer: indexer(), valuation: valuation(), ...over }), input)).actions;
    // No rollover router, or no keeper to run an instruction.
    expect(await actions({ d: parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, rolloverRouter: A(0) } }) })).toEqual([REPAY, CASH_OUT]);
    expect(await actions({ d: parseDeployment({ ...manifest(), rolloverExecutor: undefined }) })).toEqual([REPAY, CASH_OUT, ROLL]);
    // Rolling paused: an instruction standing can still be ended.
    expect(await actions({ chain: fakeChain({ rolloverPaused: () => Promise.resolve(true), autoRoll: () => Promise.resolve(standing()) }) }))
      .toEqual([REPAY, CASH_OUT, "cancel_auto_roll (the wallet that left the instruction)"]);
    // A cash-out router from before sales through an aggregator, or no valuation service: gage.cash's own routes.
    const onApp = "cash_out on testnet.gage.cash (holder of the reclaim right, before endsAt)";
    expect(await actions({ chain: fakeChain({ cashoutExecutorAllowed: () => Promise.resolve(null) }) })).toEqual([REPAY, onApp, ROLL, AUTO]);
    expect(await loan(ctx({ indexer: indexer() }), { loanId: "7" }).then((l) => l.actions)).toEqual([REPAY, onApp, ROLL, AUTO]);
    // A pledge of the asset the loan is repaid in is repaid, never sold.
    expect(await actions({ chain: fakeChain({ loan: () => Promise.resolve(chainLoan({ token: getAddress(A(0x10)) })) }) })).toEqual([REPAY, ROLL, AUTO]);
    // An earlier engine with neither router.
    expect(await actions({}, { loanId: "7", engine: OLD })).toEqual([REPAY]);
    // Past its end the lenders keep the collateral: nothing is left to do.
    expect(await actions({ chain: fakeChain({ loan: () => Promise.resolve(chainLoan({ fundedAt: NOW - 604_800 })) }) })).toEqual([]);
  });
});

describe("a listing's actions", () => {
  it("are cancelling it and, where this Gage serves it, leaving it to roll by itself", async () => {
    const chain = () => fakeChain({ loan: () => Promise.resolve(chainLoan({ state: 1, fundedAt: 0 })) });
    expect((await gageFrom(ctx({ indexer: indexer(), chain: chain() })).loan({ loanId: "7" })).actions).toEqual(["cancel (borrower)", AUTO]);
    // gage.cash leaves a loan to roll only from its Borrow ticket or once it runs.
    expect((await gageFrom(ctx({ indexer: indexer(), chain: chain() }), { actions: HOSTED }).loan({ loanId: "7" })).actions).toEqual(["cancel (borrower)"]);
  });
});

describe("a closed loan", () => {
  const closed = async (over: Partial<ReturnType<typeof chainLoan>>, released = false) =>
    loan(ctx({ indexer: indexer(), chain: fakeChain({ loan: () => Promise.resolve(chainLoan({ state: 3, ...over })), released: () => Promise.resolve(released) }) }), { loanId: "7" });

  it("repaid by a roll or a cash-out says so, and offers no collateral back: the pledge went to the new loan, or was sold", async () => {
    expect(await closed({ collateralBeneficiary: ROLL_ROUTER })).toMatchObject({ state: "REPAID", closedBy: "roll", actions: [] });
    expect(await closed({ collateralBeneficiary: CASHOUT })).toMatchObject({ state: "REPAID", closedBy: "cash_out", actions: [] });
  });

  it("repaid by hand offers its collateral back until it is taken", async () => {
    expect(await closed({ collateralBeneficiary: WALLET })).toMatchObject({ closedBy: null, actions: ["collect (collateral back to the borrower)"] });
    expect(await closed({ collateralBeneficiary: WALLET }, true)).toMatchObject({ closedBy: null, actions: [] });
  });
});

describe("a wallet's portfolio", () => {
  const rows = () => fakeUpstream({
    "/v2/positions?": (path: string) => ({ status: 200, body: { items: path.includes(`engine=${CORE}`) ? [position("7", {}, { borrowerReward: "5" }), position("8"), position("9")] : [], nextCursor: null } }),
    "/intent/partners/vaults?": { items: [], nextCursor: null },
  });

  it("counts each loan's sGAGE at its engine's rewards contract, raw, and flags a loan left to roll by itself", async () => {
    const asked: unknown[] = [];
    const chain = fakeChain({
      loanRewards: (rewards: Address, id: bigint, wallet: Address) => { asked.push([rewards, id, wallet]); return Promise.resolve(3n * 10n ** 18n); },
      autoRoll: (_router: Address, id: bigint) => Promise.resolve(id === 7n ? standing() : id === 9n ? standing(OTHER) : null),
    });
    const p = await portfolio(ctx({ indexer: rows(), chain }), WALLET);
    expect(p.loans.map((l) => [l.loanId, l.sgageClaimable, l.autoRoll])).toEqual([["7", "3000000000000000000", true], ["8", "0", false], ["9", "0", false]]);
    // A loan with no reward allocated owes none: only the one with rewards is read.
    expect(asked).toEqual([[getAddress(REWARDS), 7n, WALLET]]);
  });
});

describe("the tokens gage takes", () => {
  it("name no most per loan where the registry sets none (D276), and keep the least and any limit it sets", async () => {
    const uncapped = fakeChain({ tokenConfig: () => Promise.resolve({ allowed: true, lane: 1, minAmount: 10n ** 18n, maxDealRaw: maxUint256, maxOpenRaw: maxUint256 }) });
    expect((await assets(ctx({ chain: uncapped }))).assets[0]).toMatchObject({ minAmount: "1000000000000000000", maxPerLoan: null });
    expect((await assets(ctx())).assets[0]).toMatchObject({ minAmount: "1000000000000000000", maxPerLoan: "1000000000000000000000" });
  });

  it("carry each one's gage.cash link by ticker (D290), none for one the release no longer admits", async () => {
    const m = assetManifest();
    const release = { ...m, nativeV2: { ...m.nativeV2, assets: [...m.nativeV2.assets,
      { token: A(0x16), symbol: "CAT", name: "Cat", decimals: 18, lane: "MEME", allowed: false }, { token: A(0x17), symbol: "Cat", name: "Cat", decimals: 18, lane: "MEME" }] } };
    const rows = (await assets(ctx({ d: parseDeployment(release) }))).assets.map((r) => [r.symbol, r.link]);
    expect(rows).toEqual([
      ["NVDAx", "https://testnet.gage.cash/borrow/nvdax"], ["CAT", null], ["Cat", "https://testnet.gage.cash/borrow/cat-0000"],
      ["SCHIFFYx", "https://testnet.gage.cash/borrow/schiffyx"],
    ]);
    expect((await assets(ctx({ d: parseDeployment(mainnetManifest()) }))).assets[0]).toMatchObject({ token: NVDA, link: "https://gage.cash/borrow/nvdax" });
  });
});

describe("a partner vault's short link (D290)", () => {
  const row = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true };
  const index = (links: unknown) => fakeUpstream({
    "/v2/positions?": { items: [], nextCursor: null },
    "/intent/partners/vaults?": { items: [row, { ...row, address: A(0x72) }], nextCursor: null },
    "/intent/partners/vaults/": (path: string) => ({ status: 200, body: path.endsWith("/accounting")
      ? { pricing: { totalAssets: "1", totalSupply: "1", assetsPerShare: "1" }, liquidity: { free: "1" } }
      : { shares: "1000000000000000000", value: "1000000", withdrawableNow: "1000000", rewards: "0", pockets: [] } }),
    ...(links === undefined ? {} : { "/intent/partners/links": links }),
  });
  const table = { schemaVersion: 1, chainId: 46630, asOf: NOW, links: [{ link: "silicon", vault: VAULT, factory: FACTORY, name: "Silicon Prime" }] };

  it("is the index's, on the network's own app, and none for a vault without one", async () => {
    expect((await earnVaults(ctx({ indexer: index(table) }))).vaults.map((v) => v.link)).toEqual(["https://testnet.gage.cash/v/silicon", null]);
    expect((await earnVaults(ctx({ d: parseDeployment(mainnetManifest()), indexer: index(table) }))).vaults[0]!.link).toBe("https://gage.cash/v/silicon");
    expect((await portfolio(ctx({ indexer: index(table) }), WALLET)).earn.map((e) => e.link)).toEqual(["https://testnet.gage.cash/v/silicon", null]);
  });

  it("is none while the index cannot say: a table not built yet, or an index without the route", async () => {
    const down = () => ({ status: 503, body: { error: { code: "LINKS_UNAVAILABLE" } } });
    expect((await earnVaults(ctx({ indexer: index(down) }))).vaults.map((v) => v.link)).toEqual([null, null]);
    expect((await earnVaults(ctx({ indexer: index(undefined) }))).vaults.map((v) => v.link)).toEqual([null, null]);
  });
});
