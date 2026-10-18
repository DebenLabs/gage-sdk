/**
 * Where leverage buys its purchase (D242, D243), modelled on the app's cash-out chooser (web/src/v2/cashoutRoutes.ts
 * `bestCashout`). Each hookless Uniswap v4 pool and each Uniswap V3 pool pairing the token with USDG quotes the exact
 * purchase as its own swap would charge it, across every initialized tick it reaches; KyberSwap, through gage's
 * valuation service, quotes a route with its effective cost for exactly that amount. They are ranked cheapest first.
 * The wallet approves one bound, the best source's (`chooseSource`); once its approvals are in place, each source the
 * approval covers is tried in rank order, and one whose loop would revert is passed over for the next, whose own bound
 * may need a larger approval. When the loop is sent every source is quoted again, and the router buys through the first
 * one, in rank order, that fits under the approved bound and whose loop simulates (`firstRunnable`). The bound is never
 * more than the loan pays out, and a multiple is prepared only while it keeps LOOP_HEADROOM_BPS of the loan spare under
 * that (D271). Pure: the caller reads the chain, asks the services and simulates.
 */
import { aggregatorCallOk } from "./aggregatorCall.js";
import { getAddress, type Address, type ContractFunctionArgs, type Hex } from "viem";
import { z } from "zod";
import type { loopRouterAbi } from "./abi.js";
import type { PoolKey } from "./deployment.js";
import type { SignedPlan } from "./intent.js";
import { maxPurchaseCost } from "./v4math.js";

/** A whole cent of USDG (6 decimals): a pool's bound on the purchase is stated, and approved, in cents, as the app does. */
export const CENT = 10_000n;

/**
 * How much of the loan a loop keeps spare, basis points of the loan (D271, the app's LOOP_HEADROOM_BPS in
 * web/src/borrow/loop.ts): a multiple is prepared only while the most its purchase may cost is at most what the loan pays
 * out less this, so a move of the price before the loop runs still leaves the purchase within the payout.
 */
export const LOOP_HEADROOM_BPS = 25n;

/**
 * What a loan of `principal` pays out: the principal less the core's origination fee on it, rounded down as the core
 * takes it. The router takes the purchase's cost back from it, and from the wallet past it.
 */
export const loopPayout = (principal: bigint, feeBps: bigint | number): bigint => principal - (principal * BigInt(feeBps)) / 10_000n;

/**
 * Whether a purchase bound at `maxCost` keeps LOOP_HEADROOM_BPS of a loan of `principal` spare under what the loan pays
 * out (`payout`), the headroom rounded up.
 */
export function keepsHeadroom(maxCost: bigint, principal: bigint, payout: bigint): boolean {
  return maxCost <= loopSpendable(principal, payout);
}

/** The most a loop's purchase may cost and keep LOOP_HEADROOM_BPS of a loan of `principal` spare under its `payout`. */
export const loopSpendable = (principal: bigint, payout: bigint): bigint => payout - (principal * LOOP_HEADROOM_BPS + 9_999n) / 10_000n;

/** KyberSwap's route for the purchase, as `LoopRouter.loopVia` takes it (D243). */
export interface ViaRoute {
  /** The aggregator's router, which the loop router's owner must admit, and the call it is made with. */
  executor: Address;
  data: Hex;
  /** The V3 pool of USDG, `flashToken` and the fee tier `flashFee` that lends `spend` for the call. */
  flashToken: Address;
  flashFee: number;
  /** The USDG the route spends, flash-borrowed. */
  spend: bigint;
  /** The most the route may cost: what it spends and the flash fee. */
  maxCost: bigint;
}

/**
 * One way to buy the purchase and what buying exactly that amount costs (`cost`): a pool's exact-output quote now, or
 * KyberSwap's effective cost (its route's cost scaled to the purchase, with the flash fee).
 */
export type LoopQuote =
  | { kind: "v4"; key: PoolKey; cost: bigint }
  | { kind: "v3"; pool: Address; fee: number; cost: bigint }
  | ({ kind: "via"; cost: bigint } & ViaRoute);

const TIE = { v4: 0, v3: 1, via: 2 } as const;

/** The sources that quoted, cheapest first for exactly the purchase; at equal cost a v4 pool, then a V3 pool, then KyberSwap. */
export function rankLoopQuotes(quotes: readonly (LoopQuote | null | undefined)[]): LoopQuote[] {
  return quotes.filter((q): q is LoopQuote => Boolean(q))
    .sort((a, b) => (a.cost === b.cost ? TIE[a.kind] - TIE[b.kind] : a.cost < b.cost ? -1 : 1));
}

/**
 * A source's own bound on the purchase, what the wallet approves to buy through it: a pool's quote plus
 * LOOP_SLIPPAGE_BPS, rounded up to the cent (`maxPurchaseCost`, the room its price may move before the loop runs), or
 * KyberSwap's own `maxCost`.
 */
export const loopCap = (q: LoopQuote): bigint => (q.kind === "via" ? q.maxCost : maxPurchaseCost(q.cost, CENT));

/**
 * Whether a source can buy under the approved `cap` now. A pool's own most is its exact-output quote: the router takes
 * what the swap costs, and the cap already carries the room for a move. KyberSwap's is its `maxCost`: the route spends
 * all of `spend`, and the flash fee is added.
 */
export const fitsCap = (q: LoopQuote, cap: bigint): boolean => (q.kind === "via" ? q.maxCost : q.cost) <= cap;

/**
 * The bound a source is held to under `room`, the USDG the router may take: its own (`loopCap`), or `room` when that is
 * less and the source still fits under it; null when it does not fit.
 */
export function boundUnder(q: LoopQuote, room: bigint): bigint | null {
  if (!fitsCap(q, room)) return null;
  const own = loopCap(q);
  return own < room ? own : room;
}

/**
 * The source a loop is planned through, and its bound:
 * - `ready`: it fits under the USDG the wallet has approved and what the loan pays out, and its loop simulated (`tried`),
 *   or was not tried because the pledge is not approved yet;
 * - `approve`: the cheapest source still to try does not fit under the approval; the wallet approves its bound first;
 * - `reverts`: every source the loan pays for fits under the approval, and none of their loops would run now;
 * - `unaffordable`: what the loan pays out pays for no source.
 */
export type LoopChoice =
  | { kind: "ready"; q: LoopQuote; bound: bigint; tried: boolean }
  | { kind: "approve"; q: LoopQuote; bound: bigint }
  | { kind: "reverts" }
  | { kind: "unaffordable" };

/**
 * Which source a loop is planned through (D243), cheapest first. `approved` is the wallet's USDG allowance for the
 * router and `funds` the most the purchase may cost when the loop runs: what the loan pays out (`loopPayout`), never the
 * wallet's own USDG besides (D271, as the app holds it: 17 October 2026, KyberSwap spent past the payout and the router
 * took the rest from a wallet that held none). A source that fits under both is held to `boundUnder` them and, given
 * `simulate`, tried: one whose loop would revert is passed over for the next. The first source that fits under `funds`
 * but not under the approval ends the walk: its own bound is approved next, and its loop tried once it is. One above
 * `funds` is skipped.
 */
export async function chooseSource(
  ranked: readonly LoopQuote[], approved: bigint, funds: bigint, simulate?: (q: LoopQuote, bound: bigint) => Promise<unknown>,
): Promise<LoopChoice> {
  const room = approved < funds ? approved : funds;
  let reverted = false;
  for (const q of ranked) {
    const bound = boundUnder(q, room);
    if (bound === null) {
      const own = boundUnder(q, funds);
      if (own !== null) return { kind: "approve", q, bound: own };
      continue;
    }
    if (!simulate) return { kind: "ready", q, bound, tried: false };
    try {
      await simulate(q, bound);
      return { kind: "ready", q, bound, tried: true };
    } catch { reverted = true; /* this source would revert now: the next one */ }
  }
  return reverted ? { kind: "reverts" } : { kind: "unaffordable" };
}

/**
 * When the loop is sent: the first source, in rank order, that fits under the approved `cap` and whose loop simulates
 * now, with the bound it is held to (`boundUnder` the cap); null when none does.
 */
export async function firstRunnable(
  ranked: readonly LoopQuote[], cap: bigint, simulate: (q: LoopQuote, bound: bigint) => Promise<unknown>,
): Promise<{ q: LoopQuote; bound: bigint } | null> {
  for (const q of ranked) {
    const bound = boundUnder(q, cap);
    if (bound === null) continue;
    try {
      await simulate(q, bound);
      return { q, bound };
    } catch { /* this source would revert now: the next one */ }
  }
  return null;
}

/** What every loop call shares, whichever source buys: the pledge, the purchase, the listing and the signed plan. */
export interface LoopBase {
  own: bigint;
  buy: bigint;
  fundingDeadline: number;
  withRewards: boolean;
  pricing: Hex;
  plan: SignedPlan["plan"];
  signature: Hex;
  maxReserveShares: readonly bigint[];
}
type Args<N extends "loop" | "loopV3" | "loopVia"> = ContractFunctionArgs<typeof loopRouterAbi, "nonpayable", N>;
/** One loop router call, for `encodeFunctionData({ abi: loopRouterAbi, ...call })`. */
export type LoopCall =
  | { functionName: "loop"; args: Args<"loop"> }
  | { functionName: "loopV3"; args: Args<"loopV3"> }
  | { functionName: "loopVia"; args: Args<"loopVia"> };

/**
 * The router call that buys through `q`, held to `bound` (its `maxCost`). KyberSwap's pledges the plan's purchase
 * (`buy`) and the router sends the borrower whatever the route returns beyond it.
 */
export function loopCall(q: LoopQuote, base: LoopBase, bound: bigint): LoopCall {
  const loop = { own: base.own, buy: base.buy, maxCost: bound, fundingDeadline: base.fundingDeadline, withRewards: base.withRewards, pricing: base.pricing };
  const rest = [base.plan, base.signature, base.maxReserveShares] as const;
  switch (q.kind) {
    case "v4": return { functionName: "loop", args: [{ key: q.key, ...loop }, ...rest] };
    case "v3": return { functionName: "loopV3", args: [{ fee: q.fee, ...loop }, ...rest] };
    case "via": return {
      functionName: "loopVia",
      args: [{ executor: q.executor, data: q.data, flashToken: q.flashToken, flashFee: q.flashFee, spend: q.spend, ...loop }, ...rest],
    };
  }
}

const digits = z.string().regex(/^\d{1,78}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const count = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,15}$/).transform(Number)]);
const BPS = 10_000n, PIPS = 1_000_000n;
/** The most slippage the valuation service builds a route with (`MAX_LOOP_SLIPPAGE_BPS`): a claimed output is over its least by no more. */
const MAX_ROUTE_SLIPPAGE_BPS = 100n;
const loopBuy = z.object({
  schema: z.literal("gage-loop-buy-v1"),
  chainId: count,
  token: address,
  buy: digits,
  spend: digits,
  amountOut: digits,
  minOut: digits,
  executor: address,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),
  lender: z.object({ flashToken: address, flashFee: count }).loose(),
  maxCost: digits,
  effectiveCost: digits,
  deadline: count,
}).loose();

/**
 * What the aggregator's route is for: exactly `buy` of `token` on `chainId`, paid for in `usdg` and bought for the loop
 * router `router`, a route still live at `now`.
 */
export type LoopBuyWant = { chainId: number; token: Address; buy: bigint; usdg: Address; router: Address; now: number };

/**
 * KyberSwap's route for exactly `buy` of `token`, from the valuation service's answer (`GET /quote/loop-buy`, schema
 * `gage-loop-buy-v1`), as the app reads it (web/src/borrow/loopSources.ts); null for anything else: another shape,
 * chain, token or amount, a route that does not expect to buy the whole purchase or whose least output does not, an
 * effective cost above its own most, a route past its deadline, or a call that does not make exactly that purchase for
 * the loop router (`aggregatorCallOk`: `spend` USDG only to KyberSwap's executor, no fee, the token to the router, at
 * least the least output). The aggregator that answered (`source`) is not read: whether the route can be used is the
 * loop router's admission of its `executor`, which the caller reads.
 */
export function parseLoopBuy(body: unknown, want: LoopBuyWant): LoopQuote | null {
  const parsed = loopBuy.safeParse(body);
  if (!parsed.success) return null;
  const q = parsed.data;
  const spend = BigInt(q.spend), maxCost = BigInt(q.maxCost), amountOut = BigInt(q.amountOut), flashFee = q.lender.flashFee, minOut = BigInt(q.minOut);
  const ok = q.chainId === want.chainId && q.token.toLowerCase() === want.token.toLowerCase() && BigInt(q.buy) === want.buy
    && amountOut >= minOut && minOut >= want.buy && spend > 0n && q.deadline > want.now
    && BigInt(q.executor) !== 0n && BigInt(q.lender.flashToken) !== 0n && flashFee > 0 && flashFee < 1_000_000
    // The output it claims is at most its slippage over the least the call holds it to, as the service builds it.
    && minOut * BPS >= amountOut * (BPS - MAX_ROUTE_SLIPPAGE_BPS)
    && aggregatorCallOk(q.data as Hex, { tokenIn: want.usdg, amountIn: spend, tokenOut: want.token, recipient: want.router, minOut });
  if (!ok) return null;
  // Its cost is the SDK's own, from what the chain holds it to: the spend, the flash fee its lender charges for it, and
  // the output (the router hands the borrower what is over the purchase). The answer's own effectiveCost ranked a route
  // at whatever it claimed (the audit of 18 October 2026); its most must be exactly the spend and the fee.
  const fee = (spend * BigInt(flashFee) + PIPS - 1n) / PIPS;
  if (maxCost !== spend + fee) return null;
  const cost = (spend * want.buy + amountOut - 1n) / amountOut + fee;
  return { kind: "via", cost, maxCost, spend, executor: getAddress(q.executor), data: q.data as Hex, flashToken: getAddress(q.lender.flashToken), flashFee };
}
