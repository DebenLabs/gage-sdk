/*!
 * The tick and price arithmetic in this file follows Uniswap v4-core's TickMath, SqrtPriceMath, SwapMath and TickBitmap
 * libraries, which are released under the MIT License:
 *
 * Copyright 2023 Universal Navigation Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/**
 * Uniswap exact-output arithmetic in BigInt: what buying an exact amount from one pool costs, its fee included, as the
 * pool's own swap works it out (v4-core's Pool.swap, SwapMath, SqrtPriceMath, TickMath and TickBitmap; Uniswap V3's
 * are the same for this). The swap starts in the pool's active range and, when the purchase is larger than that range
 * holds, crosses each initialized tick it reaches, read from the pool's tick bitmap, and goes on with the liquidity
 * past it. Leverage holds the router to that quote plus LOOP_SLIPPAGE_BPS (`maxCost`), so a quote that left out a
 * thinner range beyond the price would set a bound the router's swap cannot meet. A Uniswap V3 pool (D242) prices the
 * same way with slot0's price and tick, `liquidity()` and its fee tier, which is all a V3 swapper pays (V3's protocol
 * fee is a share of it).
 */
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import type { PoolKey } from "./deployment.js";

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const FEE_DENOMINATOR = 1_000_000n;

/**
 * How far over the pool's quote the purchase may cost when the loop runs, basis points (the app's LOOP_SLIPPAGE_BPS,
 * web/src/borrow/loop.ts): all the room the router gets.
 */
export const LOOP_SLIPPAGE_BPS = 50n;

/** TickMath's bounds: the least and greatest tick, and the prices at them. */
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MIN_SQRT_PRICE = 4_295_128_739n;
export const MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

/**
 * The most bitmap words and tick reads one quote makes. A purchase that needs more ranges than that is not quoted:
 * it is far larger than the pool near its price, and each read is a call to the node.
 */
export const MAX_TICK_READS = 32;

/** The pool's price and active liquidity, with the fee a swap in the purchase's direction pays. */
export interface PoolSwapState { sqrtPriceX96: bigint; liquidity: bigint; feePips: bigint }
/** And where the price is among its ticks: slot0's tick and the pool's tick spacing. */
export interface PoolTickState extends PoolSwapState { tick: number; tickSpacing: number }
/** A pool's initialized ticks: its tick bitmap by word (compressed tick >> 8), and the liquidity each tick adds going up. */
export interface TickReader {
  bitmap(word: number): Promise<bigint>;
  liquidityNet(tick: number): Promise<bigint>;
}

const divRoundingUp = (a: bigint, d: bigint) => (a % d === 0n ? a / d : a / d + 1n);
const mulDivRoundingUp = (a: bigint, b: bigint, d: bigint) => divRoundingUp(a * b, d);
const sorted = (a: bigint, b: bigint): [bigint, bigint] => (a > b ? [b, a] : [a, b]);

/** v4's PoolId: the keccak of the abi-encoded key, as `PoolIdLibrary.toId` hashes it. */
export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

/**
 * The fee a swap in one direction pays, from slot0's `lpFee` and packed `protocolFee` (the lower 12 bits apply to
 * zeroForOne, the upper 12 to the other direction), as v4-core's ProtocolFeeLibrary.calculateSwapFee works it out.
 */
export function swapFeePips(lpFee: number, protocolFee: number, zeroForOne: boolean): bigint {
  const protocol = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12;
  return BigInt(protocol + lpFee - Math.floor((protocol * lpFee) / 1_000_000));
}

// TickMath.getSqrtPriceAtTick: for each set bit i of |tick|, 1/sqrt(1.0001^(2^i)) in Q128.128.
const TICK_RATIOS: readonly (readonly [bigint, bigint])[] = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n], [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

/** The price at `tick`, sqrt(1.0001^tick) in Q64.96 rounded up, as TickMath.getSqrtPriceAtTick computes it. */
export function sqrtPriceAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  if (!Number.isInteger(tick) || abs > BigInt(MAX_TICK)) throw new RangeError(`tick ${tick} is outside TickMath's range`);
  let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of TICK_RATIOS) if ((abs & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio + (1n << 32n) - 1n) >> 32n;
}

function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  return roundUp ? divRoundingUp(mulDivRoundingUp(liquidity << 96n, b - a, b), a) : ((liquidity << 96n) * (b - a)) / b / a;
}
function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sorted(sqrtA, sqrtB);
  return roundUp ? mulDivRoundingUp(liquidity, b - a, Q96) : (liquidity * (b - a)) / Q96;
}

/**
 * SqrtPriceMath.getNextSqrtPriceFromOutput: the price once `amountOut` has left the range at `liquidity`, rounded so
 * that at least that much does; null where the pool's own arithmetic reverts.
 */
function priceAfterOutput(sqrtPrice: bigint, liquidity: bigint, amountOut: bigint, zeroForOne: boolean): bigint | null {
  if (zeroForOne) {
    // Out comes currency1: the price falls by amountOut / L, rounded up.
    const step = mulDivRoundingUp(amountOut, Q96, liquidity);
    return sqrtPrice > step ? sqrtPrice - step : null;
  }
  // Out comes currency0: the price rises to L·P / (L − amountOut·P), rounded up.
  const numerator = liquidity << 96n, product = amountOut * sqrtPrice;
  if (product > MAX_UINT256 || numerator <= product) return null;
  return mulDivRoundingUp(numerator, sqrtPrice, numerator - product);
}

/** SwapMath.computeSwapStep for an exact output, from `sqrtPrice` toward `target` at `liquidity`. */
function exactOutStep(sqrtPrice: bigint, target: bigint, liquidity: bigint, remaining: bigint, feePips: bigint) {
  const zeroForOne = sqrtPrice >= target;
  const most = zeroForOne ? amount1Delta(target, sqrtPrice, liquidity, false) : amount0Delta(sqrtPrice, target, liquidity, false);
  let next: bigint | null = target, out = most;
  if (remaining < most) {
    out = remaining;
    next = priceAfterOutput(sqrtPrice, liquidity, remaining, zeroForOne);
    if (next === null) return null;
  }
  const paid = zeroForOne ? amount0Delta(next, sqrtPrice, liquidity, true) : amount1Delta(sqrtPrice, next, liquidity, true);
  return { next, out, paid: paid + mulDivRoundingUp(paid, feePips, FEE_DENOMINATOR - feePips) };
}

const msb = (x: bigint) => x.toString(2).length - 1;

/**
 * TickBitmap.nextInitializedTickWithinOneWord: the next initialized tick at or below `tick` (`lte`) or above it, within
 * the bitmap word it is in, else that word's last tick; null once the reads allowed are spent.
 */
async function nextTick(word: (w: number) => Promise<bigint | null>, tick: number, spacing: number, lte: boolean) {
  let compressed = Math.trunc(tick / spacing);
  if (tick < 0 && tick % spacing !== 0) compressed -= 1;
  if (lte) {
    const bit = compressed & 0xff;
    const bits = await word(compressed >> 8);
    if (bits === null) return null;
    const masked = bits & ((1n << BigInt(bit + 1)) - 1n);
    return masked !== 0n ? { next: (compressed - (bit - msb(masked))) * spacing, initialized: true } : { next: (compressed - bit) * spacing, initialized: false };
  }
  const above = compressed + 1, bit = above & 0xff;
  const bits = await word(above >> 8);
  if (bits === null) return null;
  const masked = bits & (MAX_UINT256 ^ ((1n << BigInt(bit)) - 1n));
  return masked !== 0n ? { next: (above + msb(masked & -masked) - bit) * spacing, initialized: true } : { next: (above + 255 - bit) * spacing, initialized: false };
}

/**
 * What buying exactly `amountOut` costs in the other currency, its fee included; `zeroForOne` pays currency0 for
 * currency1. The pool's own exact-output swap, run to the router's price limit (TickMath's bound less one): range by
 * range, crossing each initialized tick it reaches. Null where the pool cannot sell that much before that limit, or
 * where the purchase needs more than `maxReads` bitmap words and ticks read.
 */
export async function quoteExactOut(pool: PoolTickState, amountOut: bigint, zeroForOne: boolean, ticks: TickReader, maxReads = MAX_TICK_READS): Promise<bigint | null> {
  if (amountOut <= 0n) return 0n;
  if (pool.sqrtPriceX96 < MIN_SQRT_PRICE || pool.sqrtPriceX96 >= MAX_SQRT_PRICE || pool.tickSpacing < 1 || pool.feePips >= FEE_DENOMINATOR) return null;
  const limit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  let reads = 0;
  const words = new Map<number, bigint>();
  const word = async (w: number): Promise<bigint | null> => {
    const known = words.get(w);
    if (known !== undefined) return known;
    if (++reads > maxReads) return null;
    const bits = await ticks.bitmap(w);
    words.set(w, bits);
    return bits;
  };
  let price = pool.sqrtPriceX96, tick = pool.tick, liquidity = pool.liquidity, remaining = amountOut, cost = 0n;
  while (remaining > 0n) {
    if (price === limit) return null;
    const step = await nextTick(word, tick, pool.tickSpacing, zeroForOne);
    if (!step) return null;
    const tickNext = Math.min(Math.max(step.next, MIN_TICK), MAX_TICK);
    const priceNext = sqrtPriceAtTick(tickNext);
    const target = zeroForOne ? (priceNext < limit ? limit : priceNext) : (priceNext > limit ? limit : priceNext);
    const s = exactOutStep(price, target, liquidity, remaining, pool.feePips);
    if (!s) return null;
    cost += s.paid;
    remaining -= s.out;
    price = s.next;
    if (price === priceNext) {
      if (step.initialized) {
        if (++reads > maxReads) return null;
        const net = await ticks.liquidityNet(tickNext);
        liquidity += zeroForOne ? -net : net;
        if (liquidity < 0n) return null;
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    }
  }
  return cost;
}

/** The most a purchase quoted at `quote` may cost: plus LOOP_SLIPPAGE_BPS, rounded up to `step` (a whole cent of USDG). */
export function maxPurchaseCost(quote: bigint, step: bigint): bigint {
  return divRoundingUp(mulDivRoundingUp(quote, 10_000n + LOOP_SLIPPAGE_BPS, 10_000n), step) * step;
}
