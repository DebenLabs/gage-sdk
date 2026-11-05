/**
 * Puts on a lend-asset generation (docs/api.md "Puts on lend-asset generations"): a loan of the generation's asset (NVDA
 * on Robinhood Chain) against USDG, so the position gains as the asset falls and its loss stops at the USDG put in, with
 * no liquidation. A put opens through the generation's loop router, whose loan buys more USDG and pledges it with the
 * margin, and closes and rolls through its put router, which pays only in the pledge's token: a close buys the repayment
 * back with the pledge and returns the rest, a roll buys what the new payout leaves short with the wallet's USDG. Pure:
 * the caller reads the chain and asks gage's services (plans.ts `putOpen`, `putClose`, `putRoll`, `putAutoRoll`).
 */
import { zeroAddress } from "viem";
import type { LoopPool, PoolKey } from "./deployment.js";
import { LOOP_HEADROOM_BPS, loopPayout, loopSpendable } from "./loopSources.js";

/** A purchase through the put router (`PutRouter.Swap`): venue 0 buys through a hookless v4 pool by its key, 1 through the V3 factory's pool at `v3Fee`. */
export interface PutSwap { venue: 0 | 1; key: PoolKey; v3Fee: number }
/** The key a V3 purchase carries, which the router never reads. */
const NO_KEY: PoolKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress };
/** The put router's swap through `p`: the pool's key for a v4 pool, its fee tier for a V3 one, which the router finds again by it. */
export const swapOf = (p: LoopPool): PutSwap => (p.kind === "v4" ? { venue: 0, key: p.key, v3Fee: 0 } : { venue: 1, key: NO_KEY, v3Fee: p.fee });

/** What a purchase through one pool costs now, in the pledge's token, as its own exact-output swap would charge it. */
export interface SwapQuote { swap: PutSwap; cost: bigint }
/** The pools that quoted, cheapest first; at equal cost a v4 pool, then a V3 pool, each in the manifest's order. */
export function rankSwaps(quotes: readonly (SwapQuote | null | undefined)[]): SwapQuote[] {
  return quotes.filter((q): q is SwapQuote => Boolean(q)).sort((a, b) => (a.cost === b.cost ? a.swap.venue - b.swap.venue : a.cost < b.cost ? -1 : 1));
}

/**
 * The most a purchase quoted at `cost` may spend when it is sent: `bps` over the quote, rounded up to `step` (the
 * token's last place shown, so an "at most" said in it stays true).
 */
export function spendBound(cost: bigint, bps: number, step: bigint): bigint {
  const over = (cost * (10_000n + BigInt(bps)) + 9_999n) / 10_000n;
  return ((over + step - 1n) / step) * step;
}

/** The USDG a put's loan buys: `size` times the margin `own`, less the margin, the size read to the hundredth. */
export function putBuy(own: bigint, size: number): bigint {
  const hundredths = BigInt(Math.round(size * 100));
  return (own * (hundredths - 100n)) / 100n;
}

/**
 * The least principal whose payout, less the core's fee, keeps LOOP_HEADROOM_BPS of it spare over `bound`, the most the
 * purchase may cost (D271): what a put borrows so that its loan buys its purchase and next to nothing lands besides.
 */
export function principalFor(bound: bigint, feeBps: number): bigint {
  const keep = 10_000n - BigInt(feeBps) - LOOP_HEADROOM_BPS;
  if (keep <= 0n) throw new RangeError("The fee leaves no payout to buy with");
  // Within a raw unit or two of the answer: the fee is rounded down and the spare up, each by less than one.
  const keeps = (p: bigint) => loopSpendable(p, loopPayout(p, feeBps)) >= bound;
  let principal = (bound * 10_000n + keep - 1n) / keep;
  while (!keeps(principal)) principal += 1n;
  while (principal > 1n && keeps(principal - 1n)) principal -= 1n;
  return principal;
}
