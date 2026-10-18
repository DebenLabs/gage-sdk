import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { cashoutRouterAbi, engineAbi } from "../src/abi.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { prepareNext } from "../src/prepare.js";
import { run } from "../src/run.js";
import { A, CASHOUT, cashoutSale, ctx, fakeChain, fakeSigner, fakeUpstream, loan, manifest, NOW, NVDA, OTHER, position, USDG, WALLET } from "../src/testing.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const indexer = () => fakeUpstream({ "/v2/positions/": position("7") });
type Route = (path: string) => { status: number; body: unknown };
const valuation = (route: Route = cashoutSale()) => fakeUpstream({ "/quote/cashout-sale": route });
const input = { action: "cash_out" as const, wallet: WALLET, loanId: "7" };
const approved = (over: Parameters<typeof fakeChain>[0] = {}) => fakeChain({ approvedFor: () => Promise.resolve(CASHOUT), ...over });

describe("cash_out", () => {
  it("approves the right to the cash-out router, then sells the whole pledge, repays the loan and pays the rest to the wallet", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), valuation: valuation() }), input);
    expect(p.status).toBe("approval_required");
    expect(decodeFunctionData({ abi: engineAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "approve", args: [getAddress(CASHOUT), 7n] });
    expect(p.then).toEqual(["Cash out"]);
    expect(p.view).toMatchObject({
      action: "cash_out", loanId: "7", collateral: "5000000000000000000", cap: "1010000000", gross: "1100000000", financeFee: "101000",
      net: "89449505", minimumNet: "89002258", source: "kyberswap",
    });
    expect(p.summary.rows).toContainEqual({ label: "You receive", value: "About 89.44 USDG, at least 89.00 USDG" });
    expect(p.summary.rows).toContainEqual({ label: "Repaid to the lenders", value: "1,010.00 USDG" });
  });

  it("sends cashOutVia for the wallet, held to the sale's least output and the net it guarantees", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), valuation: valuation(), chain: approved() }), input);
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "Cash out", final: true });
    const call = decodeFunctionData({ abi: cashoutRouterAbi, data: p.next!.transaction.data });
    expect(call.functionName).toBe("cashOutVia");
    expect(call.args[0]).toMatchObject({
      loanId: 7n, recipient: getAddress(WALLET), minimumNet: 89_002_258n, maxFinanceFee: 101_000n, deadline: BigInt(NOW + 120), executor: getAddress(A(0xe8)),
      flashToken: getAddress(A(0xea)), flashFee: 100, minUsdgOut: 1_097_250_000n,
    });
  });

  it("is refused where it cannot run: no router or no valuation service, no sale, a router before D245, a loan not running or not the wallet's", async () => {
    const c = (over: Parameters<typeof fakeChain>[0] = {}, route: Route = cashoutSale()) => ctx({ indexer: indexer(), valuation: valuation(route), chain: approved(over) });
    expect(await code(prepareNext(ctx({ indexer: indexer(), chain: approved() }), input))).toBe("CASHOUT_CLOSED");
    const routerless = parseDeployment({ ...manifest(), nativeV2: { ...manifest().nativeV2, engines: manifest().nativeV2.engines.map((e) => ({ ...e, cashoutRouter: undefined })) } });
    expect(await code(prepareNext(ctx({ d: routerless, indexer: indexer(), valuation: valuation() }), input))).toBe("CASHOUT_CLOSED");
    expect(await code(prepareNext(c({ cashoutExecutorAllowed: () => Promise.resolve(null) }), input))).toBe("CASHOUT_CLOSED");
    expect(await code(prepareNext(c({ cashoutExecutorAllowed: () => Promise.resolve(false) }), input))).toBe("NO_SALE");
    expect(await code(prepareNext(c({}, cashoutSale({ status: 404 })), input))).toBe("NO_SALE");
    // A call that pays the sale to anyone but the router is no sale at all.
    expect(await code(prepareNext(c({}, cashoutSale({ recipient: OTHER })), input))).toBe("NO_SALE");
    expect(await code(prepareNext(c({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0 })) }), input))).toBe("NOT_RUNNING");
    expect(await code(prepareNext(c({ loan: () => Promise.resolve(loan({ fundedAt: NOW - 604_800 })) }), input))).toBe("TERM_ENDED");
    expect(await code(prepareNext(c({ ownerOf: () => Promise.resolve(OTHER), loan: () => Promise.resolve(loan({ originator: OTHER })) }), input))).toBe("NOT_YOUR_LOAN");
  });

  it("stops before sending a sale that pays less than planned", async () => {
    let asked = 0;
    const lower: Route = (path) => cashoutSale({ amountOut: (asked += 1) > 1 ? 1_090_000_000n : 1_100_000_000n })(path);
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: indexer(), valuation: valuation(lower), chain: approved() }), input, signer);
    expect(r).toMatchObject({ status: "stopped", error: { code: "PRICE_MOVED" } });
    expect(signer.sent).toHaveLength(0);
  });

  it("sells through the aggregator's pools only when the sale through all its liquidity would revert", async () => {
    const asked: string[] = [];
    const route: Route = (path) => { asked.push(path); return cashoutSale({ executor: path.includes("sources=pools") ? A(0xe7) : A(0xe8) })(path); };
    let simulated = 0;
    const chain = approved({ simulate: () => ((simulated += 1) === 1 ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n)) });
    const p = await prepareNext(ctx({ indexer: indexer(), valuation: valuation(route), chain }), input);
    expect(asked.at(-1)).toMatch(/sources=pools$/);
    expect(decodeFunctionData({ abi: cashoutRouterAbi, data: p.next!.transaction.data }).args[0]).toMatchObject({ executor: getAddress(A(0xe7)) });
  });

  // The audit of 18 October 2026 (H2): on a loan whose cap is close to its sale, the call's own least output let the net
  // fall 306 bps under the 50 asked. The net is held to the bps asked, as the app holds it (`minimumNetOf`).
  it("never lets the net fall more than the bps asked below the quote, whatever the call's least output allows", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), valuation: valuation(), chain: approved() }), input);
    expect(p.view).toMatchObject({ net: "89449505", minimumNet: "89002258" });
    expect(decodeFunctionData({ abi: cashoutRouterAbi, data: p.next!.transaction.data }).args[0]).toMatchObject({ minimumNet: 89_002_258n, minUsdgOut: 1_097_250_000n });
    // Under the valuation service's 5 bps floor of call slippage, the net is still held to the 2 bps asked.
    const tight = await prepareNext(ctx({ indexer: indexer(), valuation: valuation(cashoutSale({ callSlippageBps: 5 })), chain: approved() }), { ...input, maxSlippageBps: 2 });
    expect(tight.view).toMatchObject({ minimumNet: String((89_449_505n * 9_998n + 9_999n) / 10_000n) });
  });

  // The audit of 18 October 2026 (H1): the sale's price and least output both come from one answer, so a wrong or hostile
  // one could sell the pledge for little. The caller may name the least it accepts, and gage's own route weighs the sale.
  it("holds the sale to the least the caller names", async () => {
    expect(await code(prepareNext(ctx({ indexer: indexer(), valuation: valuation(), chain: approved() }), { ...input, minNet: "89449506" }))).toBe("BELOW_MIN_NET");
    const p = await prepareNext(ctx({ indexer: indexer(), valuation: valuation(), chain: approved() }), { ...input, minNet: "89400000" });
    expect(p.view).toMatchObject({ minimumNet: "89400000" });
    expect(decodeFunctionData({ abi: cashoutRouterAbi, data: p.next!.transaction.data }).args[0]).toMatchObject({ minimumNet: 89_400_000n });
  });

  it("weighs the sale against gage's own route once the right is approved, and refuses one that pays clearly less", async () => {
    const asked: unknown[][] = [];
    const routed = (net: bigint | null) => approved({ cashoutRouteNet: (...args: unknown[]) => { asked.push(args); return Promise.resolve(net); } });
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: indexer(), valuation: valuation(), chain: routed(95_000_000n) }), input, signer);
    expect(r).toMatchObject({ status: "stopped", error: { code: "SALE_BELOW_ROUTE" } });
    expect(signer.sent).toHaveLength(0);
    // The release's NVDAx/USDG pool, one swap of the whole pledge into USDG, simulated from the wallet through cashOutDetailed.
    type Swap = { kind: number; tokenIn: string; tokenOut: string; minOut: bigint; key: { currency0: string; currency1: string; fee: number } };
    const [router, exit, from] = asked[0] as [string, { loanId: bigint; recipient: string; minimumNet: bigint; routes: Swap[] }, string];
    expect([router, from, exit.recipient].map((x) => getAddress(x))).toEqual([getAddress(CASHOUT), getAddress(WALLET), getAddress(WALLET)]);
    expect(exit).toMatchObject({ loanId: 7n, minimumNet: 1n });
    expect(exit.routes.map((s) => [s.kind, getAddress(s.tokenIn), getAddress(s.tokenOut), s.minOut, getAddress(s.key.currency0), getAddress(s.key.currency1), s.key.fee]))
      .toEqual([[0, getAddress(NVDA), getAddress(USDG), 1n, getAddress(NVDA), getAddress(USDG), 3000]]);
    // Within 1% of the route's net (89.45 against 90.00 USDG), or with no route that goes through, the sale is sent.
    expect((await prepareNext(ctx({ indexer: indexer(), valuation: valuation(), chain: routed(90_000_000n) }), input)).status).toBe("ready");
    expect((await prepareNext(ctx({ indexer: indexer(), valuation: valuation(), chain: routed(null) }), input)).status).toBe("ready");
  });

  it("says so where gage has no route of its own for the collateral, and weighs nothing then", async () => {
    let routes = 0;
    const d = parseDeployment({ ...manifest(), pools: {} });
    const chain = approved({ cashoutRouteNet: () => { routes += 1; return Promise.resolve(10n ** 12n); } });
    const p = await prepareNext(ctx({ d, indexer: indexer(), valuation: valuation(), chain }), input);
    expect(p.status).toBe("ready");
    expect(routes).toBe(0);
    expect(p.notes.join(" ")).toMatch(/minNet/);
  });
});
