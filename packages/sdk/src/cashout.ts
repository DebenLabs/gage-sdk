/**
 * A loan's cash-out through an aggregator's sale (D245): `GageV2CashoutRouter.cashOutVia` sells the loan's whole
 * collateral through one executor its owner admits (KyberSwap's routers on mainnet, the testnet's stand-in for them),
 * repays the loan from a flash loan of its cap, keeps 0.5% of what remains and pays the holder the rest. gage's
 * valuation service builds the sale (`GET /quote/cashout-sale`, docs/api.md, "Cash-out sale through an aggregator"),
 * and the SDK takes it only as the app does (web/src/v2/cashoutSale.ts): for this loan's whole collateral, sold by
 * this core's router inside the router's 15 minutes, covering the repayment, with a call that makes exactly that sale
 * (`aggregatorCallOk`), and the net it signs for never more than the bps asked below the quote (`minimumNetOf`). The
 * quote and the call's least output come from one answer, so the sale is also weighed against gage's own route before
 * it is sent, as the app weighs it (`pickCashout`), and a caller may name the least it accepts (the audit of
 * 18 October 2026).
 */
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { aggregatorCallOk } from "./aggregatorCall.js";
import type { CashoutExit, CashoutRoute, Chain } from "./chain.js";
import type { LoopPool } from "./deployment.js";
import type { Upstream } from "./upstream.js";

/** `GageV2CashoutRouter.MAX_EXECUTION_WINDOW`: an exit's deadline is at most this many seconds out. */
const CASHOUT_WINDOW = 15 * 60;
/** `GageV2CashoutRouter.CASHOUT_FEE_BPS`: gage's fee on what the sale leaves after the cap and the flash fee. */
const CASHOUT_FEE_BPS = 50n;
/** The valuation service's least call slippage (`MIN_CALL_SLIPPAGE_BPS`): a call allows its sale at least this much room. */
const MIN_CALL_SLIPPAGE_BPS = 5;
/** How far below gage's own route's net an aggregator's sale may pay and still be sent: a quote a few seconds old, not a worse sale. */
export const ROUTE_MARGIN_BPS = 100n;
const BPS = 10_000n, PIPS = 1_000_000n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** A sale `cashOutVia` can make, read from the valuation service's answer. */
export interface CashoutSale {
  source: string | null;
  executor: Address;
  data: Hex;
  /** The build's quoted output, and the least the call accepts (`ExitVia.minUsdgOut`), raw units of the core's asset. */
  amountOut: bigint;
  minOut: bigint;
  flashToken: Address;
  flashFee: number;
  /** What the lending pool charges for the cap: `ExitVia.maxFinanceFee`. */
  maxFinanceFee: bigint;
  /**
   * The holder's net at the quote, on the router's rounding, and the least it signs for (`ExitVia.minimumNet`): the quote's
   * net less the bps asked, or the call's own least output's net where that is higher.
   */
  netAtQuote: bigint;
  minimumNet: bigint;
  deadline: number;
}

/** What the sale must be: this loan's whole collateral on this chain, sold for the core's asset by its router, live at `now`. */
export interface CashoutWant { chainId: number; engine: Address; router: Address; loanId: bigint; token: Address; collateral: bigint; cap: bigint; asset: Address; slippageBps: number; now: number }

/** The holder's net from a sale returning `out`, on the router's own rounding; null when it does not cover the cap and fee. */
export function netOf(out: bigint, cap: bigint, financeFee: bigint): bigint | null {
  const remainder = out - cap - financeFee;
  if (remainder <= 0n) return null;
  return remainder - (remainder * CASHOUT_FEE_BPS) / BPS;
}

const digits = z.string().regex(/^\d{1,78}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const count = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,15}$/).transform(Number)]);
const saleSchema = z.object({
  schema: z.literal("gage-cashout-sale-v1"),
  chainId: count, source: z.string().optional(), engine: address, router: address, loanId: digits, token: address,
  amountIn: digits, cap: digits, amountOut: digits, minOut: digits, executor: address, data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),
  lender: z.object({ flashToken: address, flashFee: count }).loose(),
  flashFee: digits, netAtQuote: digits, netAtMinimum: digits, callSlippageBps: count, deadline: count,
}).loose();

const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

/** The sale in the answer, or null for anything `cashOutVia` should not be sent with (the module's rule above). */
export function parseCashoutSale(body: unknown, want: CashoutWant): CashoutSale | null {
  const parsed = saleSchema.safeParse(body);
  if (!parsed.success) return null;
  const q = parsed.data;
  const amountOut = BigInt(q.amountOut), minOut = BigInt(q.minOut), maxFinanceFee = BigInt(q.flashFee), flashFee = q.lender.flashFee, slippage = q.callSlippageBps;
  const ok = q.chainId === want.chainId && same(q.engine, want.engine) && same(q.router, want.router) && BigInt(q.loanId) === want.loanId
    && same(q.token, want.token) && BigInt(q.amountIn) === want.collateral && BigInt(q.cap) === want.cap
    && q.deadline > want.now && q.deadline <= want.now + CASHOUT_WINDOW
    && BigInt(q.executor) !== 0n && BigInt(q.lender.flashToken) !== 0n && flashFee > 0 && flashFee < 1_000_000
    && maxFinanceFee === (want.cap * BigInt(flashFee) + PIPS - 1n) / PIPS
    && slippage >= 1 && slippage <= Math.max(want.slippageBps, MIN_CALL_SLIPPAGE_BPS) && minOut === (amountOut * (BPS - BigInt(slippage))) / BPS
    && aggregatorCallOk(q.data as Hex, { tokenIn: want.token, amountIn: want.collateral, tokenOut: want.asset, recipient: want.router, minOut });
  if (!ok) return null;
  const callFloor = netOf(minOut, want.cap, maxFinanceFee) ?? 0n, netAtQuote = netOf(amountOut, want.cap, maxFinanceFee) ?? 0n;
  if (callFloor <= 0n || BigInt(q.netAtMinimum) !== callFloor) return null;
  // The net falls at most the bps asked below the quote, as the input says: where the cap is close to the sale, the
  // call's least output alone leaves the net far more room (306 bps under 50 on the fixture loan).
  const tolerated = (netAtQuote * (BPS - BigInt(want.slippageBps)) + BPS - 1n) / BPS;
  const minimumNet = tolerated > callFloor ? tolerated : callFloor;
  return {
    // Which aggregator answered, kept only as a short name: it reaches an agent's view (the audit of 18 October 2026).
    source: q.source !== undefined && /^[a-z0-9][a-z0-9-]{0,31}$/.test(q.source) ? q.source : null, executor: getAddress(q.executor), data: q.data as Hex, amountOut, minOut, flashToken: getAddress(q.lender.flashToken), flashFee,
    maxFinanceFee, netAtQuote, minimumNet, deadline: q.deadline,
  };
}

/**
 * gage's own ways out for the collateral that the sale is weighed against: one swap of the whole pledge into the core's
 * asset through each direct pool the release lists for it (`loopPools`, USDG's), which the router takes where it admits
 * that pool. The app also tries paths of two swaps (web/src/v2/cashoutRoutes.ts); a collateral with no direct pool has no
 * route here, and its sale is weighed against nothing but the caller's least.
 */
export function directRoutes(token: Address, asset: Address, pools: readonly LoopPool[]): CashoutRoute[] {
  return pools.map((p) => (p.kind === "v4"
    ? { kind: 0, tokenIn: token, tokenOut: asset, v3Fee: 0, key: p.key, minOut: 1n }
    : { kind: 1, tokenIn: token, tokenOut: asset, v3Fee: p.fee, key: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO }, minOut: 1n }));
}

/**
 * The most gage's own routes pay the holder now, each simulated alone through `cashOutDetailed` (the right must already
 * be approved to the router); null when none goes through. Its least net is 1 and its finance fee bounded by the cap:
 * only the net it reads is used.
 */
export async function routeNet(chain: Chain, router: Address, loanId: bigint, holder: Address, cap: bigint, now: number, routes: readonly CashoutRoute[]): Promise<bigint | null> {
  const exit = (route: CashoutRoute): CashoutExit => ({
    loanId, recipient: holder, minimumNet: 1n, maxFinanceFee: cap, minUnderlying0: 0n, minUnderlying1: 0n, deadline: BigInt(now + 300), routes: [route],
  });
  const nets = await Promise.all(routes.map((r) => chain.cashoutRouteNet(router, exit(r), holder)));
  return nets.reduce<bigint | null>((best, n) => (n !== null && (best === null || n > best) ? n : best), null);
}

/**
 * The sale now, through all of the aggregator's liquidity or (`pools`) its on-chain pools only; null when the service
 * answers none or one `parseCashoutSale` refuses. Its quote lives 120 seconds.
 */
export async function askCashoutSale(valuation: Upstream, want: CashoutWant, sources: "all" | "pools" = "all"): Promise<CashoutSale | null> {
  try {
    const r = await valuation.raw(`/quote/cashout-sale?engine=${want.engine.toLowerCase()}&loanId=${want.loanId}&slippageBps=${want.slippageBps}${sources === "pools" ? "&sources=pools" : ""}`);
    return r.status === 200 ? parseCashoutSale(r.body, want) : null;
  } catch { return null; }
}
