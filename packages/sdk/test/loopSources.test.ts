import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { loopRouterAbi } from "../src/abi.js";
import { boundUnder, chooseSource, firstRunnable, fitsCap, keepsHeadroom, LOOP_HEADROOM_BPS, loopCall, loopCap, loopPayout, parseLoopBuy, rankLoopQuotes, type LoopBase, type LoopQuote } from "../src/loopSources.js";
import { A, CORE, NOW, NVDA, ROUTER, swapCall, USDG, VAULT } from "../src/testing.js";

const key = { currency0: NVDA, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const EXECUTOR = getAddress(A(0xc0)), LENDER_TOKEN = getAddress(A(0xd0)), POOL_V3 = getAddress(A(0xb0));
const v4 = (cost: bigint): LoopQuote => ({ kind: "v4", key, cost });
const v3 = (cost: bigint): LoopQuote => ({ kind: "v3", pool: POOL_V3, fee: 500, cost });
const via = (cost: bigint, maxCost: bigint): LoopQuote => ({
  kind: "via", cost, maxCost, spend: maxCost - 40_000n, executor: EXECUTOR, data: "0xdeadbeef", flashToken: LENDER_TOKEN, flashFee: 100,
});
const kinds = (qs: (LoopQuote | null)[]) => qs.map((q) => q && [q.kind, q.cost]);

describe("ranking the sources", () => {
  it("drops those that did not quote and puts the cheapest first; at equal cost a v4 pool, then a V3 pool, then KyberSwap", () => {
    expect(kinds(rankLoopQuotes([null, via(400n, 402n), v3(401n), undefined, v4(400n), v3(400n)]))).toEqual([
      ["v4", 400n], ["v3", 400n], ["via", 400n], ["v3", 401n],
    ]);
    expect(rankLoopQuotes([null, undefined])).toEqual([]);
  });
});

describe("the approved cap", () => {
  it("is a pool's quote plus 0.5%, rounded up to the cent, or KyberSwap's own most", () => {
    // 401.203612 USDG quoted: 0.5% over it is 403.2096..., 403.21 USDG.
    expect(loopCap(v4(401_203_612n))).toBe(403_210_000n);
    expect(loopCap(v3(401_203_612n))).toBe(403_210_000n);
    expect(loopCap(via(399_000_000n, 402_500_001n))).toBe(402_500_001n);
  });
  it("holds a pool to its quote, the room for a move being the cap's, and KyberSwap to all it may spend", () => {
    expect(fitsCap(v4(403_210_000n), 403_210_000n)).toBe(true);
    expect(fitsCap(v3(403_210_001n), 403_210_000n)).toBe(false);
    expect(fitsCap(via(390_000_000n, 403_210_001n), 403_210_000n)).toBe(false);
  });
});

describe("the bound a source is held to", () => {
  it("is its own under room enough, the room when that is less but the source still fits, else none", () => {
    expect(boundUnder(v4(401_203_612n), 10n ** 30n)).toBe(403_210_000n);
    expect(boundUnder(v4(401_203_612n), 402_000_000n)).toBe(402_000_000n);
    expect(boundUnder(v4(401_203_612n), 401_203_611n)).toBeNull();
    expect(boundUnder(via(399_000_000n, 402_000_000n), 405_000_000n)).toBe(402_000_000n);
    expect(boundUnder(via(399_000_000n, 402_000_000n), 401_999_999n)).toBeNull();
  });
});

// 17 October 2026 (mainnet loan 12, D271): the app's most leverage stood where the purchase's bound met what the loan paid
// out, and the loop failed as soon as the price moved. A multiple is prepared only while its bound keeps 25 bp of the loan
// spare under what the loan pays out, as the app offers it.
describe("the headroom a loop keeps", () => {
  it("is 25 bp of the loan under what it pays out, its principal less the core's fee rounded down", () => {
    expect(LOOP_HEADROOM_BPS).toBe(25n);
    expect(loopPayout(408_320_000n, 100)).toBe(404_236_800n);
    expect(loopPayout(1_000_000_099n, 100)).toBe(990_000_099n);
    // 404.2368 paid out less 1.0208 kept spare: 403.216 at most.
    expect(keepsHeadroom(403_216_000n, 408_320_000n, 404_236_800n)).toBe(true);
    expect(keepsHeadroom(403_216_001n, 408_320_000n, 404_236_800n)).toBe(false);
  });
});

describe("the source a loop is planned through", () => {
  const ranked = [v3(400_211_421n), v4(404_040_000n)];
  const plenty = 10n ** 30n;
  it("is the cheapest, under its own bound, when nothing is approved yet: that bound is approved first", async () => {
    expect(await chooseSource(ranked, 0n, plenty)).toMatchObject({ kind: "approve", q: { kind: "v3" }, bound: 402_220_000n });
  });
  it("is tried once the approval covers it, and passed over when its loop would revert: the next one's bound is approved", async () => {
    const tried: string[] = [];
    const simulate = (q: LoopQuote) => { tried.push(q.kind); return q.kind === "v3" ? Promise.reject(new Error("revert")) : Promise.resolve(); };
    expect(await chooseSource(ranked, 402_220_000n, plenty, simulate)).toMatchObject({ kind: "approve", q: { kind: "v4" }, bound: 406_070_000n });
    expect(await chooseSource(ranked, 406_070_000n, plenty, simulate)).toMatchObject({ kind: "ready", q: { kind: "v4" }, bound: 406_070_000n, tried: true });
    expect(tried).toEqual(["v3", "v3", "v4"]);
    expect(await chooseSource(ranked, plenty, plenty, () => Promise.reject(new Error("revert")))).toEqual({ kind: "reverts" });
  });
  it("is ready untried when the approval covers it but the loop cannot be tried yet (the pledge is not approved)", async () => {
    expect(await chooseSource(ranked, 405_000_000n, plenty)).toMatchObject({ kind: "ready", q: { kind: "v3" }, bound: 402_220_000n, tried: false });
  });
  it("is held to what the loan pays out, skips a source it does not pay for, and is none when it pays for none", async () => {
    expect(await chooseSource(ranked, 0n, 401_000_000n)).toMatchObject({ kind: "approve", q: { kind: "v3" }, bound: 401_000_000n });
    const pricey = [via(399_000_000n, 410_000_000n), v4(404_040_000n)];
    expect(await chooseSource(pricey, 0n, 405_000_000n)).toMatchObject({ kind: "approve", q: { kind: "v4" }, bound: 405_000_000n });
    expect(await chooseSource(ranked, plenty, 400_000_000n)).toEqual({ kind: "unaffordable" });
  });
});

describe("the first runnable source when the loop is sent", () => {
  const cap = 403_210_000n;
  it("skips a KyberSwap route whose most is above the approved cap, without simulating it", async () => {
    const tried: string[] = [];
    const r = await firstRunnable([via(399_000_000n, 404_000_000n), v4(401_203_612n)], cap, (s) => { tried.push(s.kind); return Promise.resolve(); });
    expect(r).toMatchObject({ q: { kind: "v4" }, bound: 403_210_000n });
    expect(tried).toEqual(["v4"]);
  });
  it("falls back, in rank order, when a source's loop would revert, each held to its bound under the cap, and is null when none runs", async () => {
    const ranked = [via(399_000_000n, 402_000_000n), v3(400_211_421n), v4(401_203_612n)];
    const tried: [string, bigint][] = [];
    const r = await firstRunnable(ranked, cap, (s, bound) => { tried.push([s.kind, bound]); return s.kind === "via" ? Promise.reject(new Error("revert")) : Promise.resolve(); });
    expect(r).toMatchObject({ q: { kind: "v3" }, bound: 402_220_000n });
    expect(tried).toEqual([["via", 402_000_000n], ["v3", 402_220_000n]]);
    expect(await firstRunnable(ranked, cap, () => Promise.reject(new Error("revert")))).toBeNull();
    expect(await firstRunnable([], cap, () => Promise.resolve())).toBeNull();
  });
});

describe("the router call", () => {
  const plan: LoopBase["plan"] = {
    engine: CORE, listingId: 9n, filler: ROUTER, token: NVDA, kind: 0, collateral: 4n * 10n ** 18n, principal: 600_000_000n, cap: 606_000_000n, term: 604_800,
    costBps: 100, feePolicy: 0, epoch: 1n, issuedAt: NOW, expiry: NOW + 30, evidence: `0x${"ab".repeat(32)}`,
    allocations: [{ vault: VAULT, units: 4, principal: 600_000_000n, interest: 6_000_000n, minimum: 0n, executionFee: 0n, maxReserveShares: 7n, minRateGrade: 0, capBps: 0, managerBps: 0 }],
  };
  const base: LoopBase = {
    own: 2n * 10n ** 18n, buy: 2n * 10n ** 18n, fundingDeadline: NOW + 86_400, withRewards: false, pricing: `0x${"ef".repeat(32)}`, plan,
    signature: `0x${"cd".repeat(65)}`, maxReserveShares: [7n],
  };
  const cap = 403_210_000n;
  const decoded = (q: LoopQuote) => decodeFunctionData({ abi: loopRouterAbi, data: encodeFunctionData({ abi: loopRouterAbi, ...loopCall(q, base, cap) }) });
  const loop = { own: base.own, buy: base.buy, maxCost: cap, fundingDeadline: base.fundingDeadline, withRewards: false, pricing: base.pricing };

  it("is `loop`, `loopV3` or `loopVia` for the source, each held to the approved cap, with the same plan", () => {
    const a = decoded(v4(401_203_612n)), b = decoded(v3(400_211_421n)), c = decoded(via(399_000_000n, 402_000_000n));
    expect([a.functionName, b.functionName, c.functionName]).toEqual(["loop", "loopV3", "loopVia"]);
    expect(a.args[0]).toEqual({ key, ...loop });
    expect(b.args[0]).toEqual({ fee: 500, ...loop });
    // KyberSwap's route: its executor, call, lending pool and spend; the pledge is the plan's purchase, the rest the borrower's.
    expect(c.args[0]).toEqual({ executor: EXECUTOR, data: "0xdeadbeef", flashToken: LENDER_TOKEN, flashFee: 100, spend: 401_960_000n, ...loop });
    for (const call of [a, b, c]) expect(call.args.slice(1)).toEqual([plan, base.signature, base.maxReserveShares]);
  });
});

describe("KyberSwap's quote (GET /quote/loop-buy)", () => {
  // The call makes exactly the purchase: 400.8 USDG for at least 2 NVDAx, to the loop router.
  const DATA = swapCall({ tokenIn: USDG, amountIn: 400_800_000n, tokenOut: NVDA, recipient: ROUTER, minOut: 2n * 10n ** 18n });
  const body = (over: Record<string, unknown> = {}) => ({
    schema: "gage-loop-buy-v1", chainId: 46630, source: "kyberswap", token: NVDA.toLowerCase(), buy: "2000000000000000000", spend: "400800000",
    amountOut: "2004000000000000000", minOut: "2000000000000000000", executor: EXECUTOR, data: DATA, lender: { pool: A(0xe0), flashToken: LENDER_TOKEN, flashFee: 100 },
    flashFee: "40080", maxCost: "400840080", effectiveCost: "400040000", deadline: NOW + 600, quotedAt: NOW, ...over,
  });
  const want = { chainId: 46630, token: NVDA, buy: 2n * 10n ** 18n, usdg: USDG, router: ROUTER, now: NOW };

  it("is read into the router's loopVia terms, ranked by its effective cost", () => {
    // ⌈400.8 × 2 / 2.004⌉ + 0.04008 USDG for exactly the purchase.
    expect(parseLoopBuy(body(), want)).toEqual({
      kind: "via", cost: 400_040_080n, maxCost: 400_840_080n, spend: 400_800_000n, executor: EXECUTOR, data: DATA, flashToken: LENDER_TOKEN, flashFee: 100,
    });
    expect(parseLoopBuy(body({ lender: { pool: A(0xe0), flashToken: LENDER_TOKEN, flashFee: "100" } }), want)).toMatchObject({ flashFee: 100 });
  });

  // D245: the testnet answers through gage's stand-in for KyberSwap's router (`source: "testnet-aggregator"`), and a client
  // takes any source (docs/api.md): the loop router's admission of the route's executor decides, read by the caller.
  it("is read the same whichever aggregator answered: the testnet's stand-in, one to come, or none named", () => {
    const standin = A(0xf0), json = (o: object) => JSON.parse(JSON.stringify(o)) as unknown;
    for (const source of ["testnet-aggregator", "an-aggregator-to-come", undefined]) {
      // A 0.05% lender: 0.2004 USDG of flash fee, its most 401.0004.
      const answer = json(body({ source, executor: standin, lender: { pool: A(0xe1), flashToken: LENDER_TOKEN, flashFee: 500 }, flashFee: "200400", maxCost: "401000400" }));
      expect(parseLoopBuy(answer, want), String(source)).toEqual({
        kind: "via", cost: 400_200_400n, maxCost: 401_000_400n, spend: 400_800_000n, executor: getAddress(standin), data: DATA, flashToken: LENDER_TOKEN, flashFee: 500,
      });
    }
  });

  // The audit of 18 October 2026 (M5): the answer's own effectiveCost ranked the route, so a wrong or hostile one could
  // claim a cost of 1 and win over a cheaper pool. The cost is the SDK's own, from what the chain holds the route to.
  it("is ranked by the cost its spend, flash fee and output give, whatever cost it claims", () => {
    const claimed = parseLoopBuy(body({ effectiveCost: "1" }), want);
    // ⌈400.8 × 2 / 2.004⌉ + 0.04008 USDG: 400.04008 USDG.
    expect(claimed).toMatchObject({ cost: 400_040_080n });
    expect(kinds(rankLoopQuotes([claimed, v4(400_000_000n)]))).toEqual([["v4", 400_000_000n], ["via", 400_040_080n]]);
  });

  it("is no source when its most is not its spend and flash fee, or it claims more than 1% over its least output", () => {
    expect(parseLoopBuy(body({ maxCost: "400840081" }), want)).toBeNull();
    expect(parseLoopBuy(body({ maxCost: "500000000" }), want)).toBeNull();
    expect(parseLoopBuy(body({ amountOut: "2030000000000000000" }), want)).toBeNull();
  });

  it("is no source for another chain, token or amount, a route short of the purchase, costs out of order or a passed deadline", () => {
    for (const over of [
      { chainId: 4663 }, { token: USDG }, { buy: "1" }, { amountOut: "1999999999999999999" }, { spend: "0" }, { deadline: NOW },
      { schema: "gage-loop-buy-v2" }, { data: "0x" }, { executor: zeroAddress }, { lender: { pool: A(0xe0), flashToken: LENDER_TOKEN, flashFee: 0 } },
      // A least output under the purchase, or a call that is not exactly this purchase for the loop router (D245, D246).
      { minOut: "1999999999999999999" }, { data: "0xdeadbeef" },
      { data: swapCall({ tokenIn: USDG, amountIn: 400_800_000n, tokenOut: NVDA, recipient: A(0x99), minOut: 2n * 10n ** 18n }) },
      { data: swapCall({ tokenIn: USDG, amountIn: 400_800_001n, tokenOut: NVDA, recipient: ROUTER, minOut: 2n * 10n ** 18n }) },
      { data: swapCall({ tokenIn: USDG, amountIn: 400_800_000n, tokenOut: NVDA, recipient: ROUTER, minOut: 10n ** 18n }) },
    ]) expect(parseLoopBuy(body(over), want), JSON.stringify(over)).toBeNull();
    expect(parseLoopBuy({ error: { code: "AGGREGATOR_UNAVAILABLE", message: "x" } }, want)).toBeNull();
  });
});
