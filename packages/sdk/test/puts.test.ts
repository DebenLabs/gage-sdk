/**
 * Puts on a lend-asset generation (docs/api.md "Puts on lend-asset generations"): GLDx lent against USDG, opened through
 * GLDx's own loop router, closed and rolled through its put router, paying only in USDG. The fixture (`putManifest`)
 * names both routers on GLDx's generation, lists USDG among its collateral and its USDG pools among its exits: a
 * hookless v4 pool at 0.01% (`PUT_POOL`) and a V3 pool at 0.05% (`V3_POOL`), GLDx at 200 USDG in both.
 */
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Address, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { engineAbi, loopRouterAbi, partnerVaultAbi, putRouterAbi } from "../src/abi.js";
import type { Call } from "../src/chain.js";
import { gageFrom } from "../src/client.js";
import { parseDeployment, parseLoopPools, putGenerations } from "../src/deployment.js";
import { ApiError, refusalOf } from "../src/errors.js";
import { actionsOn } from "../src/networks.js";
import { prepareNext } from "../src/prepare.js";
import { loopPayout, loopSpendable } from "../src/loopSources.js";
import { principalFor, putBuy, rankSwaps, spendBound, swapOf } from "../src/puts.js";
import { assets, capabilities, LEND_ASSET_RULE, leverageQuote, loan as readLoan, portfolio, PUT_RULE, putQuote } from "../src/reads.js";
import { run } from "../src/run.js";
import { gageTools } from "../src/tools.js";
import {
  A, assetManifest, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_LOOP, GLD_PUT, GLD_V3_POOL, GLD_VAULT, GLDX, KEEPER, loan, loopQuote,
  manifest, NOW, OTHER, position, preview, PUT_KEY, PUT_POOL, putManifest, registryRewarded, rollQuote, SCHIFFY, USDG, V3_POOL, VAULT, WALLET,
} from "../src/testing.js";

const E18 = 10n ** 18n;
const GLD = { token: GLDX, symbol: "GLDx", decimals: 18 };
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const d = () => parseDeployment(putManifest());
/** A chain whose v4 pool is GLDx's (USDG first, at 200 USDG), and anything else in order. */
const chainOf = (over: Record<string, unknown> = {}) => fakeChain({ poolState: () => Promise.resolve(PUT_POOL), ...over });

describe("a put's arithmetic", () => {
  it("buys size times the margin less the margin, and borrows the least whose payout keeps 25 bp spare over the purchase's most", () => {
    expect(putBuy(100_000_000n, 4)).toBe(300_000_000n);
    expect(putBuy(100_000_000n, 1.25)).toBe(25_000_000n);
    for (const [bound, fee] of [[MAX_COST, 100], [403_210_000n, 100], [1n, 0], [10n ** 24n + 7n, 37]] as const) {
      const p = principalFor(bound, fee);
      expect(loopSpendable(p, loopPayout(p, fee))).toBeGreaterThanOrEqual(bound);
      expect(loopSpendable(p - 1n, loopPayout(p - 1n, fee))).toBeLessThan(bound);
    }
    expect(principalFor(MAX_COST, 100)).toBe(PRINCIPAL);
  });

  it("holds a purchase to its quote plus the room asked, rounded up to the last place shown", () => {
    expect(spendBound(301_236_540n, 50, 10_000n)).toBe(302_750_000n);
    expect(spendBound(301_236_540n, 0, 1n)).toBe(301_236_540n);
    expect(spendBound(10_000n, 0, 10_000n)).toBe(10_000n);
  });

  it("swaps through a v4 pool by its key and a V3 pool by its fee tier, the cheapest first, a v4 pool first at equal cost", () => {
    const v4 = swapOf({ kind: "v4", key: PUT_KEY }), v3 = swapOf({ kind: "v3", pool: GLD_V3_POOL, fee: 500 });
    expect(v4).toEqual({ venue: 0, key: PUT_KEY, v3Fee: 0 });
    expect(v3).toEqual({ venue: 1, key: { currency0: A(0), currency1: A(0), fee: 0, tickSpacing: 0, hooks: A(0) }, v3Fee: 500 });
    expect(rankSwaps([{ swap: v3, cost: 5n }, null, { swap: v4, cost: 5n }, { swap: v3, cost: 4n }]).map((q) => [q.swap.venue, q.cost])).toEqual([[1, 4n], [0, 5n], [1, 5n]]);
  });
});

describe("a deployment with puts", () => {
  it("carries GLDx's loop and put routers, USDG among its collateral, and the pools its loop buys USDG through", () => {
    const g = d().generations[1]!;
    expect(g).toMatchObject({ id: "GLDx", loopRouter: GLD_LOOP, putRouter: getAddress(GLD_PUT) });
    expect(g.collateral.map((x) => x.symbol)).toEqual(["SCHIFFYx", "USDG"]);
    // Its own exits first, in their order: the v4 pool by its key, the V3 pool by its address; SCHIFFYx has no USDG-free pool to loop through.
    expect([...g.loopPools.entries()]).toEqual([[USDG.toLowerCase(), [{ kind: "v4", key: { ...PUT_KEY, hooks: A(0) } }, { kind: "v3", pool: GLD_V3_POOL, fee: 500 }]]]);
    expect(putGenerations(d()).map((x) => x.id)).toEqual(["GLDx"]);
    // The USDG generation's pools are leverage's, as before.
    const x = d();
    expect(x.generations[0]!.loopPools).toBe(x.loopPools);
    expect([...x.loopPools.entries()]).toEqual([...parseLoopPools(putManifest()).entries()]);
  });

  it("names no routers where the release names none, and refuses a router named twice", () => {
    const g = parseDeployment(assetManifest()).generations[1]!;
    expect(g).toMatchObject({ loopRouter: null, putRouter: null });
    expect(putGenerations(parseDeployment(assetManifest()))).toEqual([]);
    const m = putManifest();
    expect(() => parseDeployment({ ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, putRouter: GLD_LOOP } } })).toThrow(/router twice/);
    expect(() => parseDeployment({ ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, loopRouter: m.intentV1.loopRouter } } })).toThrow(/router twice/);
  });

  it("serves the put actions it can carry out: opening where a generation offers puts, closing and rolling where one names a put router", () => {
    const PUTS = ["put_open", "put_close", "put_roll", "put_auto_roll", "put_cancel_auto_roll"];
    expect(actionsOn(d()).filter((a) => PUTS.includes(a))).toEqual(PUTS);
    expect(actionsOn(parseDeployment({ ...putManifest(), rolloverExecutor: undefined })).filter((a) => PUTS.includes(a))).toEqual(["put_open", "put_close", "put_roll", "put_cancel_auto_roll"]);
    const m = putManifest(), { loopRouter: _, ...noLoop } = m.intentV1Assets.GLDx;
    expect(actionsOn(parseDeployment({ ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: noLoop } })).filter((a) => PUTS.includes(a))).toEqual(["put_close", "put_roll", "put_auto_roll", "put_cancel_auto_roll"]);
    expect(actionsOn(parseDeployment(assetManifest())).filter((a) => PUTS.includes(a))).toEqual([]);
  });

  it("lists the routers among GLDx's capabilities, says what a put is, and leaves USDG on GLDx's core to put_open, never leverage", async () => {
    const caps = await capabilities(ctx({ d: d() }));
    expect(caps.lendAssets?.[0]).toMatchObject({ token: GLDX, loopRouter: GLD_LOOP, putRouter: getAddress(GLD_PUT) });
    expect(caps.rules).toEqual(expect.arrayContaining([LEND_ASSET_RULE, PUT_RULE]));
    expect(caps.actions).toContain("put_open");
    const rows = (await assets(ctx({ d: d() }))).assets;
    expect(rows.map((r) => [r.symbol, (r as { asset?: { symbol: string } }).asset?.symbol, r.leverage])).toEqual([["NVDAx", "USDG", true], ["SCHIFFYx", "GLDx", false], ["USDG", "GLDx", false]]);
    // A tool quotes puts where they open, and nowhere else; a signer carries each put action out.
    expect(gageTools(gageFrom(ctx({ d: d() }))).map((t) => t.name)).toContain("gage_put_quote");
    expect(gageTools(gageFrom(ctx({ d: d() })), { signer: fakeSigner() }).filter((t) => t.annotations.destructiveHint && t.name.startsWith("gage_put_")).map((t) => t.name))
      .toEqual(["gage_put_open", "gage_put_close", "gage_put_roll", "gage_put_auto_roll", "gage_put_cancel_auto_roll"]);
    expect(gageTools(gageFrom(ctx({ d: parseDeployment(assetManifest()) }))).map((t) => t.name)).not.toContain("gage_put_quote");
  });
});

// The model's curve for 400 USDG pledged in GLDx (2 GLDx of value): 20 bps up to 1 GLDx, 40 bps up to 1.79.
const curve = { status: "preview", costBps: 40, collateralValueRaw: String(2n * E18), sizing: { curve: [
  { principalRaw: String(E18), repaymentRaw: "1002000000000000000", costBps: 20 }, { principalRaw: "1790000000000000000", repaymentRaw: "1797160000000000000", costBps: 40 },
] } };
const putRates = (over: Record<string, unknown> = {}) => fakeUpstream({ "/rates/suggest": curve, "/intent/preview/": preview(), "/intent/loop/quotes/": loopQuote(GLD_LOOP), ...over });
const opening = { action: "put_open" as const, wallet: WALLET, lendAsset: GLDX, margin: "100000000", size: 4, term: 604_800, maxCostBps: 100 };
// 300 USDG at 200 through the 0.01% pool costs 1.50015 GLDx; 0.5% over it, to the cent, 1.50768274785736 GLDx. The loan
// is the least whose payout, less the 1% fee and 25 bp kept spare, buys that: 1.526767… GLDx, repaying 0.40% more.
const PRINCIPAL = 1_526_767_339_602_389_873n, CAP = 1_532_874_408_960_799_433n, MAX_COST = 1_507_682_747_857_360_000n;

describe("a put's quote", () => {
  it("pledges the margin and what the loan buys, sized so the loan buys its purchase with 25 bp spare, priced on the whole pledge", async () => {
    const rates = putRates();
    const q = await putQuote(ctx({ d: d(), rates, chain: chainOf() }), { lendAsset: GLDX, margin: "100000000", size: 4, term: 604_800 });
    expect(q).toMatchObject({
      margin: "100000000", buy: "300000000", pledge: "400000000", principal: String(PRINCIPAL), repay: String(CAP), costBps: 40, ltvBps: 7633,
      maxPurchaseCost: String(MAX_COST), pledgeValue: String(2n * E18), asset: GLD,
      prepare: { action: "put_open", lendAsset: GLDX, margin: "100000000", size: 4, term: 604_800, maxCostBps: 40 },
    });
    expect(q.summary).toBe("Put in 100.00 USDG, hold 400.00 USDG for a loan of 1.526767 GLDx, repay 1.532875 GLDx within 7 days");
    // USDG takes a stock's lane on GLDx (90% of its value), and the model prices it in GLDx (`asset`).
    expect(rates.asked[0]).toBe(`/rates/suggest?chainId=46630&term=604800&engine=${GLD_CORE}&token=${USDG}&collateral=400000000&maxRepaymentBps=9000&asset=${GLDX}`);
    expect(rates.asked[1]).toMatch(new RegExp(`^/intent/preview/${GLD_CORE}\\?token=${USDG}&collateral=400000000&principal=${PRINCIPAL}&cap=${CAP}&`));
  });

  it("refuses a size the pledge cannot support, an asset with no puts, and a margin too small to buy anything", async () => {
    const r = await (async () => { try { await putQuote(ctx({ d: d(), rates: putRates(), chain: chainOf() }), { lendAsset: GLDX, margin: "100000000", size: 10, term: 604_800 }); return null; } catch (e) { return e as ApiError; } })();
    expect(r).toMatchObject({ code: "SIZE_TOO_HIGH", details: { maxPrincipal: "1790000000000000000" } });
    expect(r?.message).toMatch(/^A 10× put borrows 4\.\d+ GLDx, more than its pledge supports now \(at most 1\.79 GLDx\); try a smaller size$/);
    expect(await code(putQuote(ctx({ d: parseDeployment(assetManifest()), rates: putRates() }), { lendAsset: GLDX, margin: "100000000", size: 4, term: 604_800 }))).toBe("PUT_CLOSED");
    expect(await code(putQuote(ctx({ d: d(), rates: putRates() }), { lendAsset: USDG, margin: "100000000", size: 4, term: 604_800 }))).toBe("PUT_CLOSED");
    expect(await code(putQuote(ctx({ d: d(), rates: putRates(), chain: chainOf() }), { lendAsset: GLDX, margin: "5", size: 1.1, term: 604_800 }))).toBe("INVALID_TERMS");
    expect(await code(putQuote(ctx({ d: d(), rates: putRates(), chain: chainOf() }), { lendAsset: GLDX, margin: "100000000", size: 4, term: 86_400 }))).toBe("TERM_NOT_ALLOWED");
  });
});

describe("opening a put", () => {
  /** Approvals in place, so the next step is the put itself; each loop simulated is recorded by the function it calls. */
  const approved = (over: Record<string, unknown> = {}, refuse: string[] = []) => {
    const tried: string[] = [];
    const chain = chainOf({
      allowance: () => Promise.resolve(10n ** 30n),
      simulate: (call: Call) => {
        const fn = decodeFunctionData({ abi: loopRouterAbi, data: call.data }).functionName;
        tried.push(fn);
        return refuse.includes(fn) ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n);
      },
      ...over,
    });
    return Object.assign(chain, { tried });
  };

  it("approves the margin in USDG and the purchase's most in GLDx to GLDx's loop router, figures and words in each", async () => {
    const p = await prepareNext(ctx({ d: d(), rates: putRates(), chain: chainOf() }), opening);
    expect(p.status).toBe("approval_required");
    expect(p.next?.transaction.to.toLowerCase()).toBe(USDG);
    expect(decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args).toEqual([getAddress(GLD_LOOP), 100_000_000n]);
    expect(p.then).toEqual(["Approve GLDx", "Open put"]);
    expect(p.summary.title).toBe("Open a 4× put on GLDx");
    expect(p.summary.rows).toEqual([
      { label: "You put in", value: "100.00 USDG" },
      { label: "The loan buys", value: "300.00 USDG" },
      { label: "Held for the loan", value: "400.00 USDG" },
      { label: "You borrow", value: "1.526767 GLDx, which buys it" },
      { label: "You repay within 7 days", value: "1.532875 GLDx" },
      { label: "Loan cost", value: "0.40%, under the 1% limit set" },
      { label: "The purchase costs at most", value: "1.507683 GLDx" },
      { label: "The most you can lose", value: "100.00 USDG, what you put in" },
      { label: "If you don't repay", value: "The lenders keep the 400.00 USDG. Nothing else is taken, and the loan is never closed early." },
    ]);
    expect(p.view).toMatchObject({
      action: "put_open", token: USDG, symbol: "USDG", decimals: 6, margin: "100000000", buy: "300000000", size: 4, principal: String(PRINCIPAL), cap: String(CAP),
      maxCost: String(MAX_COST), cash: "3816918349005975", asset: GLD, engine: GLD_CORE,
    });
    const asset = await prepareNext(ctx({ d: d(), rates: putRates(), chain: chainOf({ allowance: (token: string) => Promise.resolve(token.toLowerCase() === USDG ? 10n ** 30n : 0n) }) }), opening);
    expect(asset.next?.transaction.to.toLowerCase()).toBe(GLDX);
    expect(decodeFunctionData({ abi: erc20Abi, data: asset.next!.transaction.data }).args).toEqual([getAddress(GLD_LOOP), MAX_COST]);
  });

  it("loops through the cheaper v4 pool on GLDx's core with the plan signed for its loop router, never asking for an aggregator's route", async () => {
    const valuation = fakeUpstream({});
    const rates = putRates();
    const chain = approved();
    const p = await prepareNext(ctx({ d: d(), rates, chain, valuation }), opening);
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "Open put", final: true });
    expect(p.next!.transaction.to.toLowerCase()).toBe(GLD_LOOP);
    const call = decodeFunctionData({ abi: loopRouterAbi, data: p.next!.transaction.data });
    expect(call.functionName).toBe("loop");
    expect(call.args[0]).toEqual({ key: { ...PUT_KEY, hooks: A(0) }, own: 100_000_000n, buy: 300_000_000n, maxCost: MAX_COST, fundingDeadline: NOW + 86_400, withRewards: false, pricing: `0x${"ef".repeat(32)}` });
    expect(call.args[1]).toMatchObject({ engine: GLD_CORE, filler: GLD_LOOP, token: USDG, collateral: 400_000_000n, principal: PRINCIPAL, cap: CAP });
    expect(rates.asked.some((path) => path.startsWith(`/intent/loop/quotes/${GLD_CORE}?token=${USDG}&collateral=400000000&principal=${PRINCIPAL}&cap=${CAP}&`))).toBe(true);
    expect(valuation.asked).toEqual([]);
  });

  it("is sized on its cheapest pool: another is bought through only while the loan pays for it, else the put is prepared again", async () => {
    // The V3 pool's 0.05% tier costs more than the loan sized on the 0.01% pool pays for: its loop is never tried.
    const dear = approved({}, ["loop"]);
    expect(await code(prepareNext(ctx({ d: d(), rates: putRates(), chain: dear }), opening))).toBe("SIMULATION_FAILED");
    expect(dear.tried).toEqual(["loop"]);
    // At the same tier both quote alike, and the V3 pool buys when the v4 pool's loop would revert.
    const even = approved({ poolState: () => Promise.resolve({ ...PUT_POOL, lpFee: 500 }) }, ["loop"]);
    const v3 = await prepareNext(ctx({ d: d(), rates: putRates(), chain: even }), opening);
    const call = decodeFunctionData({ abi: loopRouterAbi, data: v3.next!.transaction.data });
    expect(call.functionName).toBe("loopV3");
    expect(call.args[0]).toMatchObject({ fee: 500, own: 100_000_000n, buy: 300_000_000n });
    expect(even.tried).toEqual(["loop", "loopV3", "loopV3"]);
  });

  it("is refused above the cost limit, without the margin, on a core that no longer lends GLDx, or for an asset with no puts", async () => {
    expect(await code(prepareNext(ctx({ d: d(), rates: putRates(), chain: chainOf() }), { ...opening, maxCostBps: 30 }))).toBe("PRICE_ABOVE_LIMIT");
    expect(await code(prepareNext(ctx({ d: d(), rates: putRates(), chain: chainOf({ balance: () => Promise.resolve(0n) }) }), opening))).toBe("INSUFFICIENT_BALANCE");
    expect(await code(prepareNext(ctx({ d: d(), rates: putRates(), chain: chainOf({ coreAsset: () => Promise.resolve(USDG) }) }), opening))).toBe("ASSET_CHANGED");
    expect(await code(prepareNext(ctx({ d: d(), rates: putRates(), chain: chainOf() }), { ...opening, lendAsset: A(0x99) }))).toBe("PUT_CLOSED");
    expect(await code(gageFrom(ctx({ d: parseDeployment(assetManifest()) })).prepare(opening))).toBe("ACTION_NOT_SERVED");
  });

  it("is carried out by run(), and names the put from the loop's own receipt", async () => {
    const looped: Log = {
      address: GLD_LOOP, removed: false, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null,
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint32" }],
        [100_000_000n, 300_000_000n, 1_500_150_000_000_000_000n, PRINCIPAL, CAP, 604_800]),
      topics: encodeEventTopics({ abi: loopRouterAbi, eventName: "Looped", args: { id: 9n, borrower: WALLET, token: USDG } }) as [Hex, ...Hex[]],
    };
    const signer = fakeSigner();
    const chain = chainOf({ sent: () => Promise.resolve({ from: WALLET, to: GLD_LOOP, input: "0x", success: true, logs: [looped] }) });
    const r = await run(ctx({ d: d(), rates: putRates(), chain }), opening, signer, { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "done", loan: { engine: GLD_CORE, loanId: "9" } });
    expect(signer.sent.map((t) => t.to)).toEqual([USDG, GLDX, GLD_LOOP]);
  });
});

describe("leverage on a lend asset's generation", () => {
  const input = { action: "leverage" as const, wallet: WALLET, token: USDG, own: "100000000", multiple: 2, term: 604_800, maxCostBps: 100, lendAsset: GLDX };
  const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as ApiError; } };

  it("is refused before anything is asked: a lend asset's loop router opens puts, with put_open, sized as a put", async () => {
    const rates = fakeUpstream({});
    expect(await refusal(prepareNext(ctx({ d: d(), rates, chain: chainOf() }), input))).toMatchObject({
      code: "LEVERAGE_CLOSED", message: "Leverage lends USDG only; borrow GLDx against USDG with put_open, or in another asset with gage_prepare_borrow" });
    expect(await code(leverageQuote(ctx({ d: d(), rates, chain: chainOf() }), { token: USDG, own: "100000000", multiple: 2, term: 604_800, lendAsset: GLDX }))).toBe("LEVERAGE_CLOSED");
    expect(rates.asked).toEqual([]);
    // A lend asset no put opens on, and a release whose lend generation names no loop router.
    expect((await refusal(prepareNext(ctx({ d: d() }), { ...input, lendAsset: A(0x99) })))?.message).toBe("Leverage lends USDG only; borrow in another asset with gage_prepare_borrow");
    expect(await code(prepareNext(ctx({ d: parseDeployment(assetManifest()) }), input))).toBe("LEVERAGE_CLOSED");
  });
});

/** A running put on GLDx's core: 400 USDG pledged for 1.5 GLDx, repaying 1.506 (40 bps). */
const putLoan = (over: Parameters<typeof loan>[0] = {}) => loan({ token: USDG, collateral: 400_000_000n, principal: 3n * E18 / 2n, cap: 1_506_000_000_000_000_000n, originationFee: 15n * 10n ** 15n, ...over });
const thisPut = () => position("7", { engine: GLD_CORE }, { token: USDG, collateral: "400000000", principal: "1500000000000000000", cap: "1506000000000000000" });
/** The index: this put, and the wallet's loans on the core (this put alone: no other rolls by itself). */
const indexer = () => fakeUpstream({ "/v2/positions/": thisPut(), "/v2/positions?": { items: [thisPut()], nextCursor: null } });
const putChain = (over: Record<string, unknown> = {}) => chainOf({ loan: () => Promise.resolve(putLoan()), ...over });
const closing = { action: "put_close" as const, wallet: WALLET, loanId: "7", engine: GLD_CORE };

describe("closing a put out of its pledge", () => {
  it("approves the right to GLDx's put router, then buys the repayment back with the pledged USDG and returns the rest", async () => {
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain() }), closing);
    expect(p.status).toBe("approval_required");
    expect(p.next!.transaction.to.toLowerCase()).toBe(GLD_CORE);
    expect(decodeFunctionData({ abi: engineAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "approve", args: [getAddress(GLD_PUT), 7n] });
    expect(p.then).toEqual(["Close"]);
    // 1.506 GLDx at 200 USDG through the 0.01% pool: 301.236540 USDG, 0.5% over it to the cent 302.75 at most.
    expect(p.view).toMatchObject({ action: "put_close", symbol: "USDG", cap: "1506000000000000000", spend: "301236540", maxSpend: "302750000", back: "98763460", minBack: "97250000", asset: GLD, engine: GLD_CORE });
    expect(p.summary.rows).toEqual([
      { label: "Repaid to the lenders", value: "1.506 GLDx" },
      { label: "Bought back with", value: "About 301.23 USDG of the 400.00 USDG pledged, at most 302.75 USDG" },
      { label: "Back to your wallet", value: "About 98.76 USDG, at least 97.25 USDG" },
    ]);
    const ready = await prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ approvedFor: () => Promise.resolve(GLD_PUT) }) }), closing);
    expect(ready.next).toMatchObject({ label: "Close", final: true });
    expect(ready.next!.transaction.to.toLowerCase()).toBe(GLD_PUT);
    expect(decodeFunctionData({ abi: putRouterAbi, data: ready.next!.transaction.data })).toMatchObject({
      functionName: "close", args: [{ loanId: 7n, swap: { venue: 0, key: { ...PUT_KEY, hooks: A(0) }, v3Fee: 0 }, maxSpend: 302_750_000n, minBack: 97_250_000n, recipient: WALLET }],
    });
  });

  it("is carried out by run(): the right approved to the put router, then the close, sent once", async () => {
    const signer = fakeSigner();
    const r = await run(ctx({ d: d(), indexer: indexer(), chain: putChain() }), closing, signer, { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "done", sent: [{ label: "Approve the close of loan #7", outcome: "succeeded" }, { label: "Close", outcome: "succeeded" }], loan: null });
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([GLD_CORE, GLD_PUT]);
    expect(decodeFunctionData({ abi: putRouterAbi, data: signer.sent[1]!.data }).functionName).toBe("close");
  });

  it("holds the close to the least the caller names, and to its own when that is higher", async () => {
    const at = (minBack: string) => prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain() }), { ...closing, minBack });
    expect((await at("98000000")).view).toMatchObject({ minBack: "98000000", maxSpend: "302000000" });
    expect((await at("90000000")).view).toMatchObject({ minBack: "97250000" });
    const refused = await (async () => { try { await at("99000000"); return null; } catch (e) { return e as ApiError; } })();
    expect(refused).toMatchObject({ code: "BELOW_MIN_BACK", details: { back: "98763460" } });
  });

  it("buys through the V3 pool when the v4 pool's close would revert, and refuses to send one that spends more than planned", async () => {
    const swaps: number[] = [];
    const chain = putChain({
      approvedFor: () => Promise.resolve(GLD_PUT),
      simulate: (call: Call) => {
        const venue = (decodeFunctionData({ abi: putRouterAbi, data: call.data }).args[0] as { swap: { venue: number } }).swap.venue;
        swaps.push(venue);
        return venue === 0 ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n);
      },
    });
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(), chain }), closing);
    expect(decodeFunctionData({ abi: putRouterAbi, data: p.next!.transaction.data }).args[0]).toMatchObject({ swap: { venue: 1, v3Fee: 500 } });
    expect(swaps).toEqual([0, 1, 1]);
    // GLDx up 2% when it is sent: the repayment costs about 307 USDG, above the 302.75 planned.
    let reads = 0;
    const dearer = putChain({ approvedFor: () => Promise.resolve(GLD_PUT), poolState: () => Promise.resolve(reads++ === 0 ? PUT_POOL : { ...PUT_POOL, sqrtPriceX96: (PUT_POOL.sqrtPriceX96 * 99n) / 100n }),
      v3PoolState: () => Promise.resolve({ ...V3_POOL, sqrtPriceX96: (V3_POOL.sqrtPriceX96 * 99n) / 100n }) });
    const signer = fakeSigner();
    const r = await run(ctx({ d: d(), indexer: indexer(), chain: dearer }), closing, signer, { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "stopped", error: { code: "PRICE_MOVED" } });
    expect(signer.sent).toHaveLength(0);
  });

  it("is refused where it cannot run: a pledge short of the repayment, a paused router, a loan not running or on a core without one", async () => {
    // GLDx at about 300 USDG: buying the 1.506 back costs about 452 USDG of the 400 pledged.
    const short = putChain({ poolState: () => Promise.resolve({ ...PUT_POOL, sqrtPriceX96: (PUT_POOL.sqrtPriceX96 * 82n) / 100n }), v3PoolState: () => Promise.resolve({ ...V3_POOL, sqrtPriceX96: (V3_POOL.sqrtPriceX96 * 82n) / 100n }) });
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: short }), closing))).toBe("PLEDGE_SHORT");
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ rolloverPaused: () => Promise.resolve(true) }) }), closing))).toBe("PUT_PAUSED");
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ loan: () => Promise.resolve(putLoan({ state: 1, fundedAt: 0 })) }) }), closing))).toBe("NOT_RUNNING");
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ loan: () => Promise.resolve(putLoan({ fundedAt: NOW - 604_800 })) }) }), closing))).toBe("TERM_ENDED");
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ ownerOf: () => Promise.resolve(OTHER), loan: () => Promise.resolve(putLoan({ originator: OTHER })) }) }), closing))).toBe("NOT_YOUR_LOAN");
    // A loan pledging the asset itself, and one on the USDG core, which names no put router.
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ loan: () => Promise.resolve(putLoan({ token: GLDX })) }) }), closing))).toBe("PUT_CLOSED");
    const usdgCore = fakeUpstream({ "/v2/positions/": position("7") });
    expect(await code(prepareNext(ctx({ d: d(), indexer: usdgCore, chain: putChain() }), { ...closing, engine: CORE }))).toBe("PUT_CLOSED");
  });
});

/** The rates service's roll of the put through the put router: the same 1.5 GLDx on the same 400 USDG, repaying 1.506 again. */
const putRoll = (over: Parameters<typeof rollQuote>[0] = {}) => rollQuote({ engine: GLD_CORE, router: GLD_PUT, token: USDG, collateral: 400_000_000n, principal: 3n * E18 / 2n, cap: 1_506_000_000_000_000_000n, oldCap: 1_506_000_000_000_000_000n, ...over });
const rolling = { action: "put_roll" as const, wallet: WALLET, loanId: "7", engine: GLD_CORE };

describe("rolling a put over through its put router", () => {
  it("asks for the put router's plans, then approves the right, the payout's pass in GLDx and the top-up's USDG, exactly", async () => {
    const rates = fakeUpstream({ "/intent/roll/quotes/": putRoll() });
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(), rates, chain: putChain() }), rolling);
    expect(rates.asked).toEqual([`/intent/roll/quotes/${GLD_CORE}?loan=7&borrower=${WALLET.toLowerCase()}&term=604800&count=3&router=put`]);
    expect(p.then).toEqual(["Approve GLDx", "Approve USDG", "Roll over"]);
    // The new payout, 1.485 GLDx, leaves 0.021 short of the old 1.506: 4.200423 USDG through the 0.01% pool, 4.23 at most.
    expect(p.view).toMatchObject({ action: "put_roll", payout: "1485000000000000000", topUp: "21000000000000000", spend: "4200423", maxSpend: "4230000", asset: GLD, engine: GLD_CORE });
    expect(p.summary.rows).toContainEqual({ label: "From your wallet", value: "About 4.20 USDG, at most 4.23 USDG, buying the 0.021 GLDx the new loan leaves short" });
    expect(p.notes).toContain("The new loan's payout, 1.485 GLDx, passes through your wallet and straight back towards this loan's repayment.");
    const approving = (allowed: Record<string, bigint>) => prepareNext(ctx({ d: d(), indexer: indexer(), rates, chain: putChain({ approvedFor: () => Promise.resolve(GLD_PUT), allowance: (t: string) => Promise.resolve(allowed[t.toLowerCase()] ?? 0n) }) }), rolling);
    const pass = await approving({});
    expect(pass.next!.transaction.to.toLowerCase()).toBe(GLDX);
    expect(decodeFunctionData({ abi: erc20Abi, data: pass.next!.transaction.data }).args).toEqual([getAddress(GLD_PUT), 1_485_000_000_000_000_000n]);
    const spend = await approving({ [GLDX]: 10n ** 30n });
    expect(spend.next!.transaction.to.toLowerCase()).toBe(USDG);
    expect(decodeFunctionData({ abi: erc20Abi, data: spend.next!.transaction.data }).args).toEqual([getAddress(GLD_PUT), 4_230_000n]);
  });

  it("rolls with the service's plans, through the cheapest pool, held to the spend approved", async () => {
    const rates = fakeUpstream({ "/intent/roll/quotes/": putRoll() });
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(), rates, chain: putChain({ approvedFor: () => Promise.resolve(GLD_PUT), allowance: () => Promise.resolve(10n ** 30n) }) }), rolling);
    expect(p.status).toBe("ready");
    const roll = decodeFunctionData({ abi: putRouterAbi, data: p.next!.transaction.data });
    expect(roll.functionName).toBe("roll");
    const [r, plans, signatures, shares] = roll.args as unknown as [{ loanId: bigint; swap: { venue: number }; maxSpend: bigint; withRewards: boolean }, { listingId: bigint; filler: Address }[], string[], bigint[]];
    expect(r).toMatchObject({ loanId: 7n, swap: { venue: 0 }, maxSpend: 4_230_000n, withRewards: false });
    expect(plans.map((x) => [x.listingId, x.filler])).toEqual([[9n, getAddress(GLD_PUT)], [10n, getAddress(GLD_PUT)], [11n, getAddress(GLD_PUT)]]);
    expect(signatures).toHaveLength(3);
    expect(shares).toEqual([7n]);
  });

  it("stops before sending a roll that costs more than planned, and names the new loan from the put router's receipt", async () => {
    let asked = 0;
    const dearer = (path: string) => putRoll({ cap: (asked += 1) > 1 ? 1_508_000_000_000_000_000n : 1_506_000_000_000_000_000n })(path);
    const ready = { approvedFor: () => Promise.resolve(GLD_PUT), allowance: () => Promise.resolve(10n ** 30n) };
    const signer = fakeSigner();
    const r = await run(ctx({ d: d(), indexer: indexer(), rates: fakeUpstream({ "/intent/roll/quotes/": dearer }), chain: putChain(ready) }), rolling, signer, { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "stopped", error: { code: "PRICE_MOVED" } });
    expect(signer.sent).toHaveLength(0);
    const rolled: Log = {
      address: GLD_PUT, removed: false, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null,
      data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256" }],
        [WALLET, 1_506_000_000_000_000_000n, 3n * E18 / 2n, 1_506_000_000_000_000_000n, 604_800, 21_000_000_000_000_000n, 4_200_423n]),
      topics: encodeEventTopics({ abi: putRouterAbi, eventName: "Rolled", args: { oldId: 7n, newId: 12n, borrower: WALLET } }) as [Hex, ...Hex[]],
    };
    const done = await run(ctx({ d: d(), indexer: indexer(), rates: fakeUpstream({ "/intent/roll/quotes/": putRoll() }), chain: putChain({ ...ready, sent: () => Promise.resolve({ from: WALLET, to: GLD_PUT, input: "0x", success: true, logs: [rolled] }) }) }), rolling, fakeSigner());
    expect(done).toMatchObject({ status: "done", loan: { engine: GLD_CORE, loanId: "12" } });
  });

  it("is refused without the USDG the top-up costs, or where the rates service names no put router", async () => {
    const rates = fakeUpstream({ "/intent/roll/quotes/": putRoll() });
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), rates, chain: putChain({ balance: () => Promise.resolve(0n) }) }), rolling))).toBe("INSUFFICIENT_BALANCE");
    const closed = () => ({ status: 409, body: { schema: "gage-intent-roll-quote-v1", status: "refused", refusal: { code: "PUT_CLOSED", reason: "No put router" }, unsigned: null, router: null, terms: null, wallet: null, authorization: null } });
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), rates: fakeUpstream({ "/intent/roll/quotes/": closed }), chain: putChain() }), rolling))).toBe("PUT_CLOSED");
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), rates, chain: putChain() }), { ...rolling, term: 86_400 }))).toBe("TERM_NOT_ALLOWED");
  });
});

describe("leaving a put to roll by itself", () => {
  const input = { action: "put_auto_roll" as const, wallet: WALLET, loanId: "7", engine: GLD_CORE };

  it("lets the put router follow the wallet's loans, approves four payouts' pass and four top-ups, then leaves the instruction for gage's keeper", async () => {
    const rates = fakeUpstream({ "/intent/roll/quotes/": putRoll() });
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(), rates, chain: putChain() }), input);
    expect(decodeFunctionData({ abi: engineAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "setApprovalForAll", args: [getAddress(GLD_PUT), true] });
    expect(p.then).toEqual(["Approve GLDx", "Approve USDG", "Turn on rolling by itself"]);
    // A roll costs 0.021 GLDx now (0.006 of fixed cost, the 0.015 fee): the ceiling is twice that, and each roll may spend
    // twice what its largest top-up, 0.042 GLDx, costs in USDG now (8.400…), to the cent.
    expect(p.view).toMatchObject({ action: "put_auto_roll", maxCost: "42000000000000000", maxSpend: "16810000", rolls: 4, allowance: "67240000", passThrough: String(6n * E18), executor: getAddress(KEEPER) });
    expect(rates.asked).toEqual([`/intent/roll/quotes/${GLD_CORE}?loan=7&borrower=${WALLET.toLowerCase()}&term=604800&count=3&router=put`]);
    const set = await prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ approvedForAll: () => Promise.resolve(true), allowance: () => Promise.resolve(10n ** 30n) }) }), { ...input, maxCost: "30000000000000000", maxSpend: "20000000" });
    const end = NOW - 3600 + 604_800;
    expect(decodeFunctionData({ abi: putRouterAbi, data: set.next!.transaction.data })).toMatchObject({
      functionName: "setAutoRoll", args: [7n, getAddress(KEEPER), 604_800, 21_600, 30_000_000_000_000_000n, 20_000_000n, 4, false, end + 4 * 604_800 + 86_400],
    });
    expect(set.next!.final).toBe(true);
  });

  it("holds a named spend to the loan's pledge, and is refused where no keeper runs it", async () => {
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain() }), { ...input, maxCost: "30000000000000000", maxSpend: "400000001" }))).toBe("MAX_SPEND_TOO_HIGH");
    // r12 review C8: limits no roll could meet, a zero spend and a ceiling below the 0.015 GLDx fee every roll pays.
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain() }), { ...input, maxCost: "30000000000000000", maxSpend: "0" }))).toBe("MAX_SPEND_ZERO");
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain() }), { ...input, maxCost: "14999999999999999", maxSpend: "20000000" }))).toBe("MAX_COST_TOO_LOW");
    const keeperless = parseDeployment({ ...putManifest(), rolloverExecutor: undefined });
    expect(await code(prepareNext(ctx({ d: keeperless, indexer: indexer(), chain: putChain() }), input))).toBe("AUTO_ROLL_CLOSED");
  });
});

/**
 * The wallet's loans on GLDx's core as the index lists them (fix 9): this put (#7), another put rolling by itself with two
 * rolls left (#8), and loans whose instructions need nothing more: one repaid (#9), one whose instruction another wallet
 * left (#10), one whose rolls are spent (#11), one past its date (#12) and a loan pledging GLDx (#13), not USDG.
 */
const walletPuts = () => {
  const put = (id: string, loanOver: Record<string, unknown> = {}) =>
    position(id, { engine: GLD_CORE }, { token: USDG, collateral: "400000000", principal: "1500000000000000000", cap: "1506000000000000000", ...loanOver });
  return { items: [put("7"), put("8"), put("9", { state: 3 }), put("10"), put("11"), put("12"), put("13", { token: GLDX })], nextCursor: null };
};
const standingOn = (router: string, id: bigint) => {
  if (router.toLowerCase() !== GLD_PUT) return Promise.resolve(null);
  const left = { borrower: WALLET, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 2, withRewards: false, until: NOW + 10 ** 7, maxCost: 1n, maxTopUp: 16_810_000n };
  const by: Record<string, typeof left> = {
    "7": { ...left, rollsLeft: 4 }, "8": left, "9": left, "10": { ...left, borrower: OTHER }, "11": { ...left, rollsLeft: 0 }, "12": { ...left, until: NOW - 1 }, "13": left,
  };
  return Promise.resolve(by[String(id)] ?? null);
};
const sharing = () => fakeUpstream({
  "/v2/positions/": position("7", { engine: GLD_CORE }, { token: USDG, collateral: "400000000", principal: "1500000000000000000", cap: "1506000000000000000" }),
  "/v2/positions?": walletPuts(),
});
/**
 * The core as it holds the wallet's loans, whose word counts (the class of F18): each right's holder by id, none once
 * burnt at a loan's close, every loan a put at `putLoan`'s figures unless `figures` says otherwise, and how many rights
 * the wallet holds there.
 */
const holding = (owners: Record<string, Address | null>, figures: Record<string, Parameters<typeof putLoan>[0]> = {}) => ({
  ownerOf: (_engine: Address, id: bigint) => Promise.resolve(owners[String(id)] ?? null),
  loan: (_engine: Address, id: bigint) => Promise.resolve(putLoan(figures[String(id)])),
  rights: () => Promise.resolve(BigInt(Object.values(owners).filter((o) => o === WALLET).length)),
});
/** `walletPuts`' loans as the core holds them: #9's right burnt at its repayment, #13 pledging GLDx. */
const LISTED = holding({ 7: WALLET, 8: WALLET, 9: null, 10: WALLET, 11: WALLET, 12: WALLET, 13: WALLET }, { 13: { token: GLDX } });

// Fix 9: an approval sets the allowance whole, so a put's approval that left out the wallet's other puts rolling by
// themselves took their budget: their later rolls missed with `allowance_short`.
describe("a put's approvals beside the wallet's other puts rolling by themselves", () => {
  it("approves this put's four rolls on top of what the other puts' instructions on the put router still need", async () => {
    const p = await prepareNext(ctx({ d: d(), indexer: sharing(), rates: fakeUpstream({ "/intent/roll/quotes/": putRoll() }), chain: putChain({ ...LISTED, autoRoll: standingOn }) }),
      { action: "put_auto_roll", wallet: WALLET, loanId: "7", engine: GLD_CORE });
    // Its own: four payouts' pass of 1.5 GLDx and four top-ups of 16.81 USDG; #8's: two of each.
    expect(p.view).toMatchObject({ passThrough: String(9n * E18), allowance: "100860000", otherAutoRolls: 1 });
    expect(p.notes).toContain("The approvals also cover the rolls your 1 other put rolling by itself still needs: an approval replaces the one before it.");
    const approving = await prepareNext(ctx({ d: d(), indexer: sharing(), rates: fakeUpstream({ "/intent/roll/quotes/": putRoll() }),
      chain: putChain({ ...LISTED, autoRoll: standingOn, approvedForAll: () => Promise.resolve(true), allowance: (t: string) => Promise.resolve(t.toLowerCase() === GLDX ? 9n * E18 : 67_240_000n) }) }),
    { action: "put_auto_roll", wallet: WALLET, loanId: "7", engine: GLD_CORE });
    // GLDx already covers both; USDG covers this put's four alone, so it is approved again for all six.
    expect(approving.next!.transaction.to.toLowerCase()).toBe(USDG);
    expect(decodeFunctionData({ abi: erc20Abi, data: approving.next!.transaction.data }).args).toEqual([getAddress(GLD_PUT), 100_860_000n]);
  });

  it("approves a roll by hand on top of the other puts' budgets, its own instruction ending with it", async () => {
    const rates = fakeUpstream({ "/intent/roll/quotes/": putRoll() });
    const approving = (allowed: Record<string, bigint>) => prepareNext(ctx({ d: d(), indexer: sharing(), rates,
      chain: putChain({ ...LISTED, autoRoll: standingOn, approvedFor: () => Promise.resolve(GLD_PUT), allowance: (t: string) => Promise.resolve(allowed[t.toLowerCase()] ?? 0n) }) }), rolling);
    // The 1.485 GLDx payout's pass beside #8's two rolls of 1.5; #7's own four end with this roll.
    const pass = await approving({ [GLDX]: 3n * E18 });
    expect(decodeFunctionData({ abi: erc20Abi, data: pass.next!.transaction.data }).args).toEqual([getAddress(GLD_PUT), 4_485_000_000_000_000_000n]);
    const spend = await approving({ [GLDX]: 10n ** 30n, [USDG]: 33_620_000n });
    expect(decodeFunctionData({ abi: erc20Abi, data: spend.next!.transaction.data }).args).toEqual([getAddress(GLD_PUT), 37_850_000n]);
    const ready = await approving({ [GLDX]: 10n ** 30n, [USDG]: 37_850_000n });
    expect(ready.status).toBe("ready");
    expect(decodeFunctionData({ abi: putRouterAbi, data: ready.next!.transaction.data }).functionName).toBe("roll");
    expect(ready.notes).toContain("The approvals also cover the rolls your 1 other put rolling by itself still needs: an approval replaces the one before it.");
  });

  it("prepares nothing while the wallet's loans cannot be read: an approval sized without them would take their budget", async () => {
    const down = fakeUpstream({ "/v2/positions/": position("7", { engine: GLD_CORE }, { token: USDG, collateral: "400000000", principal: "1500000000000000000", cap: "1506000000000000000" }),
      "/v2/positions?": () => ({ status: 503, body: { error: { code: "INDEXER_BUSY" } } }) });
    expect(await code(prepareNext(ctx({ d: d(), indexer: down, rates: fakeUpstream({ "/intent/roll/quotes/": putRoll() }), chain: putChain({ autoRoll: standingOn }) }),
      { action: "put_auto_roll", wallet: WALLET, loanId: "7", engine: GLD_CORE }))).toBe("UPSTREAM_UNAVAILABLE");
  });
});

/**
 * The class of F18 (the audit of 1 November 2026): the index only names the wallet's loans. Each is read from the core,
 * its principal, pledge and right's holder the chain's, each once, and the list is held to the core's own count of the
 * wallet's rights: a wrong or compromised index could otherwise inflate a principal, add a loan that is not the
 * wallet's or that pledges another token, repeat one, or leave a put out, and the approvals would follow it.
 */
describe("the loans a put's approvals count", () => {
  const put = (id: string, loanOver: Record<string, unknown> = {}) =>
    position(id, { engine: GLD_CORE }, { token: USDG, collateral: "400000000", principal: "1500000000000000000", cap: "1506000000000000000", ...loanOver });
  const listing = (...items: unknown[]) => fakeUpstream({ "/v2/positions/": put("7"), "/v2/positions?": { items, nextCursor: null } });
  /** An instruction of the wallet's with two rolls left, at 16.81 USDG a roll, on every other loan; this put's own four. */
  const standing = (router: string, id: bigint) => Promise.resolve(router.toLowerCase() !== GLD_PUT ? null
    : { borrower: WALLET, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: id === 7n ? 4 : 2, withRewards: false, until: NOW + 10 ** 7, maxCost: 1n, maxTopUp: 16_810_000n });
  const auto = (indexer: ReturnType<typeof listing>, owners: Record<string, Address | null>, figures: Record<string, Parameters<typeof putLoan>[0]> = {}) =>
    prepareNext(ctx({ d: d(), indexer, rates: fakeUpstream({ "/intent/roll/quotes/": putRoll() }), chain: putChain({ ...holding(owners, figures), autoRoll: standing }) }),
      { action: "put_auto_roll", wallet: WALLET, loanId: "7", engine: GLD_CORE });
  /** This put's four rolls (6 GLDx passing through, 67.24 USDG spent) and another put's two (3 GLDx, 33.62 USDG), `n` of them. */
  const besides = (n: bigint) => ({ passThrough: String(6n * E18 + n * 3n * E18), allowance: String(67_240_000n + n * 33_620_000n), otherAutoRolls: Number(n) });

  it("counts each put at the principal and pledge the core holds, never the index's", async () => {
    // The index inflates #8's principal tenfold, says #13 pledges USDG (it pledges GLDx) and #14 GLDx (it pledges USDG).
    const index = listing(put("7"), put("8", { principal: "15000000000000000000", cap: "15060000000000000000" }), put("13"), put("14", { token: GLDX }));
    const p = await auto(index, { 7: WALLET, 8: WALLET, 13: WALLET, 14: WALLET }, { 13: { token: GLDX } });
    expect(p.view).toMatchObject(besides(2n));
    // The index is asked only which loans to read: the wallet's, waiting for funding or running.
    expect(index.asked).toContain(`/v2/positions?engine=${GLD_CORE}&account=${WALLET.toLowerCase()}&state=funding&limit=100`);
    expect(index.asked).toContain(`/v2/positions?engine=${GLD_CORE}&account=${WALLET.toLowerCase()}&state=active&limit=100`);
  });

  it("leaves out a put whose right another wallet holds, or whose right is burnt, whatever the index says", async () => {
    expect((await auto(listing(put("7"), put("8"), put("10"), put("12")), { 7: WALLET, 8: WALLET, 10: OTHER, 12: null })).view).toMatchObject(besides(1n));
  });

  it("counts a put the index repeats once", async () => {
    expect((await auto(listing(put("7"), put("8"), put("8")), { 7: WALLET, 8: WALLET })).view).toMatchObject(besides(1n));
  });

  it("approves nothing when the index leaves out a loan whose right the core counts for the wallet", async () => {
    // The wallet holds three rights on the core, this put's, #8's and #10's; the index names two.
    const index = listing(put("7"), put("8")), owners = { 7: WALLET, 8: WALLET, 10: WALLET };
    const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return refusalOf(e); } };
    const byHand = prepareNext(ctx({ d: d(), indexer: index, rates: fakeUpstream({ "/intent/roll/quotes/": putRoll() }), chain: putChain({ ...holding(owners), autoRoll: standing, approvedFor: () => Promise.resolve(GLD_PUT) }) }), rolling);
    for (const p of [auto(index, owners), byHand]) {
      expect(await refused(p)).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: "gage's index does not list every loan this wallet holds on the core now, so nothing is approved; try again shortly", retryable: true });
    }
  });

  it("counts the put the plan is for though the index does not list it yet", async () => {
    // The wallet holds this put's right and #8's; the index names #8 alone.
    expect((await auto(listing(put("8")), { 7: WALLET, 8: WALLET })).view).toMatchObject(besides(1n));
  });
});

describe("ending a put's instruction to roll by itself", () => {
  const input = { action: "put_cancel_auto_roll" as const, wallet: WALLET, loanId: "7", engine: GLD_CORE };
  const standing = (borrower: Address = WALLET) => ({ borrower, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 3, withRewards: false, until: NOW + 10 ** 7, maxCost: 1n, maxTopUp: 1n });

  it("ends the instruction the wallet left on the put router, in one call, and is refused where it left none", async () => {
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ autoRoll: () => Promise.resolve(standing()) }) }), input);
    expect(p.next!.transaction.to.toLowerCase()).toBe(GLD_PUT);
    expect(decodeFunctionData({ abi: putRouterAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "cancelAutoRoll", args: [7n] });
    expect(p.view).toMatchObject({ action: "put_cancel_auto_roll", loanId: "7", rollsLeft: 3, symbol: "USDG" });
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain() }), input))).toBe("NO_AUTO_ROLL");
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(), chain: putChain({ autoRoll: () => Promise.resolve(standing(OTHER)) }) }), input))).toBe("NO_AUTO_ROLL");
  });

  it("is read on the loan and the portfolio: the put router's actions and its standing instruction", async () => {
    const chain = putChain({ autoRoll: (router: string) => Promise.resolve(router.toLowerCase() === GLD_PUT ? standing() : null) });
    const l = await readLoan(ctx({ d: d(), indexer: indexer(), chain }), { loanId: "7", engine: GLD_CORE });
    expect(l.actions).toEqual(expect.arrayContaining([
      "put_close (holder of the reclaim right, before endsAt)", "put_roll (holder of the reclaim right, before endsAt)",
      "put_auto_roll (holder of the reclaim right)", "put_cancel_auto_roll (the wallet that left the instruction)",
    ]));
    expect(l).toMatchObject({ autoRoll: null, putAutoRoll: { borrower: WALLET, rollsLeft: 3, maxCost: "1", maxSpend: "1" }, asset: GLD });
    // A loan on a core without a put router reads as before.
    const usdg = await readLoan(ctx({ d: d(), indexer: fakeUpstream({ "/v2/positions/": position("7") }) }), { loanId: "7" });
    expect(usdg).not.toHaveProperty("putAutoRoll");
    expect(usdg.actions.some((a) => a.startsWith("put_"))).toBe(false);
    const wallet = fakeUpstream({
      "/v2/positions?": (path: string) => ({ status: 200, body: { items: path.includes(GLD_CORE) ? [position("7", { engine: GLD_CORE }, { token: USDG })] : [], nextCursor: null } }),
      "/intent/partners/vaults?": { items: [], nextCursor: null },
    });
    const p = await portfolio(ctx({ d: d(), indexer: wallet, chain }), WALLET);
    expect(p.loans).toEqual([expect.objectContaining({ engine: GLD_CORE, loanId: "7", symbol: "USDG", autoRoll: true })]);
  });
});

// A put defaulted to its vault leaves its USDG in a pocket for the vault's holders: collateral recovered, never earnings.
describe("collecting a GLDx vault's pockets", () => {
  it("counts a USDG pocket of a GLDx vault as collateral recovered, apart from GLDx earnings", async () => {
    const lists = (path: string) => ({ status: 200, body: { items: path.includes(`factory=${GLD_FACTORY}`)
      ? [{ address: GLD_VAULT, creator: A(1), curator: A(1), core: GLD_CORE, categoryMask: 6, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [SCHIFFY, USDG], fundingEnabled: true }]
      : [{ address: VAULT, creator: A(1), curator: A(1), core: A(0x20), categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [A(0x11)], fundingEnabled: true }], nextCursor: null } });
    const indexer = fakeUpstream({
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": lists,
      "/intent/partners/vaults/": (path: string) => ({ status: 200, body: { shares: "0", value: "0", withdrawableNow: "0", rewards: "0", pockets: path.includes(GLD_VAULT)
        ? [{ id: 1, kind: "RECOVERY", loanId: "3", token: USDG, claimable: "250000000", private: false }, { id: 2, kind: "EARNINGS", token: GLDX, claimable: String(E18 / 10n), private: false }]
        : [{ id: 3, kind: "EARNINGS", token: USDG, claimable: "2000000", private: false }] } }),
    });
    const p = await prepareNext(ctx({ d: d(), indexer }), { action: "collect", wallet: WALLET });
    expect(p.summary.rows).toEqual([
      { label: "Vault earnings", value: "2.00 USDG" },
      { label: "Vault earnings in GLDx", value: "0.1 GLDx" },
      { label: "Collateral recovered", value: "250 USDG" },
    ]);
    expect(p.view).toMatchObject({ action: "collect", earnings: "2000000", others: [{ ...GLD, earnings: String(E18 / 10n) }], recovered: [{ token: USDG, symbol: "USDG", decimals: 6, amount: "250000000" }] });
    const claim = decodeFunctionData({ abi: partnerVaultAbi, data: [p.next!, ...[]].map((n) => n.transaction.data)[0]! });
    expect(claim.functionName).toMatch(/^claimPocket/);
    // Without a recovered pocket, the view names none.
    const plain = await prepareNext(ctx({ d: parseDeployment(manifest()), indexer: fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } }) }), { action: "collect", wallet: WALLET });
    expect(plain.view).not.toHaveProperty("recovered");
  });
});

// R2 option C: on a stablecoin market whose own registry quotes its sGAGE, a put lists with rewards only while its core's
// ledger can pay them, as every listing there does (test/rewards.test.ts).
describe("a put on a lend asset whose registry quotes its sGAGE", () => {
  const stablePuts = () => parseDeployment(registryRewarded(putManifest()));
  /** Answers every reward quote with 20 + 40 sGAGE and every ledger with `budget`, recording the fees quoted. */
  const rewardReads = (budget: bigint, fees: bigint[]) => ({
    rewardsQuote: (_registry: Address, _term: number, fee: bigint) => { fees.push(fee); return Promise.resolve({ borrower: 20n * E18, lender: 40n * E18 }); },
    rewardsBudget: () => Promise.resolve(budget),
  });

  it("opens with rewards while the ledger's budget covers the quote for the loan's fee, and without once it does not", async () => {
    const opened = async (budget: bigint) => {
      const fees: bigint[] = [];
      const chain = chainOf({ allowance: () => Promise.resolve(10n ** 30n), simulate: () => Promise.resolve(100_000n), ...rewardReads(budget, fees) });
      const p = await prepareNext(ctx({ d: stablePuts(), rates: putRates(), chain }), opening);
      expect(p.next).toMatchObject({ label: "Open put", final: true });
      return { loop: decodeFunctionData({ abi: loopRouterAbi, data: p.next!.transaction.data }).args[0] as { withRewards: boolean }, fees };
    };
    const covered = await opened(60n * E18);
    expect(covered.loop.withRewards).toBe(true);
    // The loan's fee at the registry's 1%, rounded down as the core rounds it.
    expect(new Set(covered.fees)).toEqual(new Set([PRINCIPAL / 100n]));
    expect((await opened(60n * E18 - 1n)).loop.withRewards).toBe(false);
    // The fixture's own GLDx quotes no rewards: its puts open as before, reading none.
    const today = await prepareNext(ctx({ d: d(), rates: putRates(), chain: chainOf({ allowance: () => Promise.resolve(10n ** 30n), rewardsQuote: () => Promise.reject(new Error("read")) }) }), opening);
    expect((decodeFunctionData({ abi: loopRouterAbi, data: today.next!.transaction.data }).args[0] as { withRewards: boolean }).withRewards).toBe(false);
  });

  it("rolls over through its put router on the same rule", async () => {
    const rolled = async (budget: bigint) => {
      const fees: bigint[] = [];
      const chain = putChain({ approvedFor: () => Promise.resolve(GLD_PUT), allowance: () => Promise.resolve(10n ** 30n), ...rewardReads(budget, fees) });
      const p = await prepareNext(ctx({ d: stablePuts(), indexer: indexer(), rates: fakeUpstream({ "/intent/roll/quotes/": putRoll() }), chain }), rolling);
      const [r] = decodeFunctionData({ abi: putRouterAbi, data: p.next!.transaction.data }).args as unknown as [{ withRewards: boolean }];
      return { withRewards: r.withRewards, fees };
    };
    const covered = await rolled(60n * E18);
    expect(covered.withRewards).toBe(true);
    expect(covered.fees).toEqual([15n * 10n ** 15n]);
    expect((await rolled(60n * E18 - 1n)).withRewards).toBe(false);
  });
});
