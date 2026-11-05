/**
 * Park and unpark (D334). An LP whose Uniswap v3 or v4, SushiSwap v3, Ramses or Fables position is out of range pulls its
 * liquidity out on its own DEX and deposits the side it holds (USDG, or a token a lend-asset vault lends) into a gage
 * partner vault, usually the DEX's own; later it withdraws and opens a new position in a range it picks. Both run from
 * the LP's own wallet as an ordered list of calls, one batch where the wallet sends one (EIP-5792), with no gage contract
 * between: the DEX's position manager and the vault are called as the wallet would call them itself.
 *
 * Positions are read straight from each DEX (a v3-style position manager's `positions`, a v4 PositionManager's pool key
 * and packed range, a Fables hook's receipts), never through gage's LP lane, whose switch does not matter here: the pools
 * served are the lane's (`Deployment.parkPools`) and those a caller adds (`createGage({ parkPools })`), hooked v4 pools
 * among them. A position parks only while out of range, when its liquidity is one token alone: that amount is then fixed,
 * and it is the pull's own minimum, so a price back in the range first reverts the batch and nothing moves. Only the
 * liquidity's amount is deposited; its fees come to the wallet. ETH is not parked: no gage vault takes it yet.
 */
import { concatHex, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, maxUint128, numberToHex, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { fablesLiquidityAbi, partnerVault4626Abi, partnerVaultAbi, permit2Abi, ramsesManagerAbi, v3ManagerAbi, v4ManagerAbi } from "./abi.js";
import type { DexPosition } from "./chain.js";
import { accounting, allPartnerVaults, indexerOf, previewAnswer, vaultName } from "./data.js";
import type { ParkPool, PoolKey } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import * as f from "./format.js";
import { bookGas } from "./gas.js";
import { indexedPositions, MAX_LP_POSITIONS, positionAmounts, tokenRefs } from "./lp.js";
import {
  approval, assetScale, inAsset, MIN_DEPOSIT, partner, plan, refOf, refusalWords, sameVaultAsset, settleFirst, VIRTUAL_SHARES, vaultRefusal,
  type Ctx, type Plan, type Row, type Step, type TokenRef, type Tx, type View,
} from "./plans.js";
import { parseInput, type ActionInput } from "./schemas.js";
import { MAX_TICK, MIN_TICK, poolId, sqrtPriceAtTick } from "./v4math.js";

/** How long a park's or an unpark's calls stay good once planned (their DEX deadline, a Permit2 approval's expiry). */
export const PARK_DEADLINE = 1_800;
/**
 * How long after a Ramses position's liquidity last changed pulling it out waits: the liquidity change claims its rewards
 * for the owner, and Ramses forfeits a claim made within about 100 seconds of the last one (D321's three minutes).
 */
export const RAMSES_CLAIM_DELAY = 180;
/** What park and unpark are (D334), said once where they are served. */
export const PARK_RULE =
  "Park (park) pulls an out-of-range liquidity position out on its own DEX and deposits the one token it holds (USDG, or a token a lend-asset vault lends; ETH is not parked yet) into a partner vault that takes it, from the wallet itself, with no gage contract between; unpark withdraws from the vault, up to what it can pay now, and opens a new position in a range the wallet picks. Both are one ordered list of calls, sent as one batch where the wallet can.";
/** The words every park and unpark says once: no liquidation, as a gage loan never closes early because a price moves. */
const LENDS = "lends it at a fixed cost, with no liquidation: a loan is never closed early because a price moves";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tx = (to: Address, data: Hex, value = 0n): Tx => ({ to, data, value });
const call = (label: string, to: Address, data: Hex, final = false, value = 0n): Step => ({ label, kind: "action", final, build: () => Promise.resolve(tx(to, data, value)) });
const slip = (quoted: bigint, maxBps = 50) => quoted - (quoted * BigInt(maxBps)) / 10_000n;
const newestFirst = (a: bigint, b: bigint) => (a === b ? 0 : b > a ? 1 : -1);
const keyOf = (p: Pick<ParkPool, "manager" | "id">) => `${p.manager}:${p.id}`.toLowerCase();

// ---- Pools --------------------------------------------------------------------------------------------------------

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an 0x address");
const fee = z.number().int().min(0).max(0xff_ffff);
const spacing = z.number().int().min(1).max(32_767);
/**
 * A pool a DEX adds for its own LPs (`createGage({ parkPools })`): a v3-style pool by its address, tokens, fee tier and
 * tick spacing at its position manager; a Uniswap v4 pool by its key (hooks included) at its PositionManager, priced by
 * the StateView of its PoolManager; or a Fables pool by its key at its hook (`manager`, which holds its receipts).
 */
export const parkPoolInput = z.union([
  z.object({
    kind: z.enum(["uniswap-v3", "ramses-v3"]), name: z.string().min(1).max(64), manager: hexAddress, pool: hexAddress, token0: hexAddress, token1: hexAddress, fee, tickSpacing: spacing,
  }).strict(),
  z.object({
    kind: z.enum(["uniswap-v4", "fables"]), name: z.string().min(1).max(64), manager: hexAddress,
    key: z.object({ currency0: hexAddress, currency1: hexAddress, fee, tickSpacing: spacing, hooks: hexAddress }).strict(), stateView: hexAddress,
  }).strict(),
]);
export type ParkPoolInput = z.input<typeof parkPoolInput>;

/** A pool a DEX adds, checked: its tokens in their own order, a Fables pool's key naming its hook, which holds its receipts. */
export function parkPoolFrom(input: unknown): ParkPool {
  const p = parseInput(parkPoolInput, input);
  if ("pool" in p) {
    const token0 = getAddress(p.token0), token1 = getAddress(p.token1);
    requireThat(BigInt(token0) < BigInt(token1), "INVALID_INPUT", "A pool's token0 sorts before its token1", 400);
    return { kind: p.kind, name: p.name, manager: getAddress(p.manager), id: getAddress(p.pool), key: null, token0, token1, fee: p.fee, tickSpacing: p.tickSpacing, stateView: null, indexedBy: null };
  }
  const key: PoolKey = { currency0: getAddress(p.key.currency0), currency1: getAddress(p.key.currency1), fee: p.key.fee, tickSpacing: p.key.tickSpacing, hooks: getAddress(p.key.hooks) };
  requireThat(BigInt(key.currency0) < BigInt(key.currency1), "INVALID_INPUT", "A pool key's currency0 sorts before its currency1", 400);
  requireThat(p.kind !== "fables" || same(key.hooks, p.manager), "INVALID_INPUT", "A Fables pool's manager is its hook, which its key names", 400);
  return {
    kind: p.kind, name: p.name, manager: getAddress(p.manager), id: poolId(key), key, token0: key.currency0, token1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing,
    stateView: getAddress(p.stateView), indexedBy: null,
  };
}

/** The pools served: the deployment's (its LP lane's, whatever the lane's switch), then the caller's, each once by its manager and id. */
export function parkPoolsIn(c: Pick<Ctx, "d" | "parkPools">): ParkPool[] {
  return [...new Map([...c.d.parkPools, ...(c.parkPools ?? [])].map((p) => [keyOf(p), p])).values()];
}

/** A pool as `capabilities()` and a review name it: what it is, where its positions are held, and its pair. */
export const poolRow = (p: ParkPool) => ({
  kind: p.kind, name: p.name, manager: p.manager, pool: p.id, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing,
  ...(p.key ? { hooks: p.key.hooks } : {}),
});

/** Whether `token` is ETH's side of a pool: native ETH (the zero address) or the release's WETH. */
const isEth = (c: Pick<Ctx, "d">, token: Address) => BigInt(token) === 0n || (c.d.weth !== null && same(token, c.d.weth));

/** Each token's symbol and decimals as a review draws them, native ETH as ETH. */
async function refsOf(c: Pick<Ctx, "d" | "chain">, tokens: readonly Address[]): Promise<Map<string, TokenRef>> {
  const refs = await tokenRefs(c, tokens.filter((t) => BigInt(t) !== 0n));
  if (tokens.some((t) => BigInt(t) === 0n)) refs.set(zeroAddress, { token: zeroAddress, symbol: "ETH", decimals: 18 });
  return refs;
}
const refIn = (refs: Map<string, TokenRef>, token: Address): TokenRef => refs.get(token.toLowerCase()) ?? { token, symbol: "tokens", decimals: 18 };

// ---- Positions ----------------------------------------------------------------------------------------------------

/** A position read from its DEX: its pool, its id (a position NFT's, or a Fables range's), its range and its liquidity. */
export interface Held { pool: ParkPool; id: bigint; tickLower: number; tickUpper: number; liquidity: bigint }

/** Whether a v3-style position is in `pool`: the same pair, and the same fee tier (or, at Ramses, tick spacing). */
const inPool = (p: ParkPool, x: DexPosition) => same(p.token0, x.token0) && same(p.token1, x.token1) && (x.fee !== null ? p.fee === x.fee : p.tickSpacing === x.tickSpacing);

/**
 * The wallet's positions with liquidity in the pools served, and whether every one was read. A v3-style position manager
 * lists the wallet's own (newest MAX_LP_POSITIONS); a v4 PositionManager and a Fables hook cannot, so their ids come from
 * gage's index for the LP lane's pools (`GET /lp/positions`) and from `also` (a DEX's own frontend knows its LPs'), each
 * checked on chain to be the wallet's now.
 */
async function heldBy(c: Ctx, wallet: Address, also: readonly { manager: Address; id: bigint }[]): Promise<{ held: Held[]; complete: boolean }> {
  const pools = parkPoolsIn(c);
  const managers = [...new Map(pools.map((p) => [p.manager.toLowerCase(), p])).values()];
  const indexed = pools.some((p) => p.indexedBy) ? await indexedPositions(c, wallet) : null;
  let complete = indexed === null || indexed.complete;
  const named = (m: Address) => also.filter((x) => same(x.manager, m)).map((x) => x.id);
  const fromIndex = (of: ParkPool[], which: "ids" | "ranges") => of.flatMap((p) => (p.indexedBy ? indexed?.[which].get(p.indexedBy.toLowerCase()) ?? [] : []));
  const found = await Promise.all(managers.map(async ({ manager: m, kind }): Promise<Held[]> => {
    const of = pools.filter((p) => same(p.manager, m));
    if (kind === "fables") {
      const ranges = [...new Set([...fromIndex(of, "ranges"), ...named(m)])].slice(0, MAX_LP_POSITIONS);
      const reads = await Promise.all(ranges.map((r) => c.chain.fablesReceipts(m, wallet, r, zeroAddress)));
      return ranges.flatMap((id, n) => {
        const r = reads[n]!, pool = r.set && r.shares > 0n ? of.find((p) => same(p.id, poolId(r.key))) : undefined;
        return pool ? [{ pool, id, tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity: r.shares }] : [];
      });
    }
    let ids: bigint[];
    if (kind === "uniswap-v4") {
      const listed = [...new Set([...fromIndex(of, "ids"), ...named(m)])].sort(newestFirst);
      if (listed.length > MAX_LP_POSITIONS) complete = false;
      const asked = listed.slice(0, MAX_LP_POSITIONS);
      const owners = asked.length ? await c.chain.positionOwners(m, asked) : [];
      ids = asked.filter((_, n) => typeof owners[n] === "string" && same(owners[n], wallet));
      const read = await c.chain.v4Positions(m, ids);
      return ids.flatMap((id, n) => {
        const x = read[n], pool = x ? of.find((p) => same(p.id, poolId(x.key))) : undefined;
        return x && pool && x.liquidity > 0n ? [{ pool, id, tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: x.liquidity }] : [];
      });
    }
    const owned = await c.chain.ownedPositions(m, wallet, MAX_LP_POSITIONS);
    if (!owned.enumerable || owned.total > BigInt(owned.ids.length)) complete = false;
    const extra = named(m).filter((id) => !owned.ids.includes(id));
    const owners = extra.length ? await c.chain.positionOwners(m, extra) : [];
    ids = [...owned.ids, ...extra.filter((_, n) => typeof owners[n] === "string" && same(owners[n], wallet))];
    const read = await c.chain.dexPositions(m, kind === "ramses-v3", ids);
    return ids.flatMap((id, n) => {
      const x = read[n], pool = x ? of.find((p) => inPool(p, x)) : undefined;
      return x && pool && x.liquidity > 0n ? [{ pool, id, tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: x.liquidity }] : [];
    });
  }));
  return { held: found.flat(), complete };
}

/** One position of the wallet's, in a pool served at `manager`: refused when there is none, or it is another's. */
async function heldOne(c: Ctx, wallet: Address, manager: string, id: bigint): Promise<Held> {
  const of = parkPoolsIn(c).filter((p) => same(p.manager, manager));
  requireThat(of.length, "UNKNOWN_POOL", "gage parks no pool held at this position manager: gage_park_positions lists the wallet's", 404);
  const m = of[0]!.manager, kind = of[0]!.kind;
  const notServed = "gage parks no pool of this position: gage_park_positions lists the wallet's";
  if (kind === "fables") {
    const r = await c.chain.fablesReceipts(m, wallet, id, zeroAddress);
    requireThat(r.set && r.shares > 0n, "POSITION_NOT_FOUND", "This wallet holds no Fables receipts of this range", 404);
    const pool = of.find((p) => same(p.id, poolId(r.key)));
    requireThat(pool, "UNKNOWN_POOL", notServed, 404);
    return { pool, id, tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity: r.shares };
  }
  const owner = await c.chain.positionOwner(m, id);
  requireThat(owner, "POSITION_NOT_FOUND", "No position has this id at this position manager", 404);
  requireThat(same(owner, wallet), "NOT_OWNER", "This wallet does not hold this position");
  if (kind === "uniswap-v4") {
    const [x] = await c.chain.v4Positions(m, [id]);
    const pool = x ? of.find((p) => same(p.id, poolId(x.key))) : undefined;
    requireThat(x && pool, "UNKNOWN_POOL", notServed, 404);
    return { pool, id, tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: x.liquidity };
  }
  const [x] = await c.chain.dexPositions(m, kind === "ramses-v3", [id]);
  requireThat(x, "POSITION_NOT_FOUND", "No position has this id at this position manager", 404);
  const pool = of.find((p) => inPool(p, x));
  requireThat(pool, "UNKNOWN_POOL", notServed, 404);
  return { pool, id, tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: x.liquidity };
}

/** A pool's price now: a v3-style pool's `slot0`, a v4 (or Fables) pool's from its StateView by its id; null for a v4 pool without one. */
export async function priceOf(c: Pick<Ctx, "chain">, pool: ParkPool): Promise<{ sqrtPriceX96: bigint; tick: number } | null> {
  if (!pool.key) return c.chain.clPoolPrice(pool.id);
  if (!pool.stateView) return null;
  const s = await c.chain.poolState(pool.stateView, pool.id);
  return { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick };
}

/**
 * What a position's liquidity holds at a price (the amounts the pull returns, rounded down as the pool rounds them), and,
 * out of range, the one token it holds (`side` 0 or 1) and how much; `side` null while in range, or for dust that holds
 * nothing.
 */
export function holdingOf(h: Pick<Held, "tickLower" | "tickUpper" | "liquidity">, sqrtPriceX96: bigint) {
  const { amount0, amount1 } = positionAmounts(sqrtPriceX96, h.tickLower, h.tickUpper, h.liquidity);
  const inRange = amount0 > 0n && amount1 > 0n;
  const side = inRange ? null : amount0 > 0n ? 0 : amount1 > 0n ? 1 : null;
  return { amount0, amount1, inRange, side, amount: side === 0 ? amount0 : side === 1 ? amount1 : 0n };
}

/** The partner vaults that take each asset now, by its address in lower case (current generations, those taking deposits). */
async function vaultsByAsset(c: Ctx): Promise<Map<string, { vault: Address; name: string }[]>> {
  const out = new Map<string, { vault: Address; name: string }[]>();
  for (const { v, g } of await allPartnerVaults(c)) {
    if (!v.fundingEnabled || g.retired) continue;
    const key = g.lendAsset.token.toLowerCase();
    out.set(key, [...(out.get(key) ?? []), { vault: getAddress(v.address), name: vaultName(v, c.d) }]);
  }
  return out;
}

/**
 * The wallet's out-of-range positions in the pools served (docs/api.md "Park and unpark"): each one's pool, range,
 * liquidity and the one token it holds now, with the partner vaults that take that token and, where none can, why
 * (ETH_NOT_SUPPORTED: no gage vault takes ETH yet; NO_VAULT: none takes that token). Positions in range earn their pool's
 * fees and are only counted (`inRange`). `also` names positions a v4 PositionManager or a Fables hook cannot list (a
 * DEX's frontend knows its LPs' ids); the LP lane's pools' are found through gage's index.
 */
export async function parkPositions(c: Ctx, wallet: Address, also: readonly { manager: string; id: string }[] = []) {
  const { held, complete } = await heldBy(c, wallet, also.map((x) => ({ manager: getAddress(x.manager), id: BigInt(x.id) })));
  const pools = [...new Map(held.map((h) => [keyOf(h.pool), h.pool])).values()];
  const [prices, refs, vaults] = await Promise.all([
    Promise.all(pools.map(async (p) => [keyOf(p), await priceOf(c, p)] as const)).then((r) => new Map(r)),
    refsOf(c, pools.flatMap((p) => [p.token0, p.token1])),
    // The vaults are a list to choose from: an index that cannot answer leaves it empty, and says so.
    vaultsByAsset(c).catch(() => null),
  ]);
  let inRange = 0;
  const positions = held.sort((a, b) => (same(a.pool.manager, b.pool.manager) ? newestFirst(a.id, b.id) : a.pool.manager < b.pool.manager ? -1 : 1)).flatMap((h) => {
    const price = prices.get(keyOf(h.pool));
    if (!price) return [];
    const x = holdingOf(h, price.sqrtPriceX96);
    if (x.inRange) inRange += 1;
    if (x.side === null) return [];
    const token = x.side === 0 ? h.pool.token0 : h.pool.token1;
    const takers = isEth(c, token) ? [] : vaults?.get(token.toLowerCase()) ?? [];
    const refusal = isEth(c, token) ? "ETH_NOT_SUPPORTED" : vaults !== null && !takers.length ? "NO_VAULT" : null;
    return [{
      kind: h.pool.kind, manager: h.pool.manager, id: h.id.toString(), pool: h.pool.id, poolName: h.pool.name,
      token0: refIn(refs, h.pool.token0), token1: refIn(refs, h.pool.token1), tickLower: h.tickLower, tickUpper: h.tickUpper, tick: price.tick, liquidity: h.liquidity.toString(),
      holds: { ...refIn(refs, token), amount: x.amount.toString() }, parkable: refusal === null && vaults !== null, refusal, vaults: takers,
    }];
  });
  return {
    wallet, positions, inRange,
    note: [
      "This wallet's out-of-range positions in the pools gage parks from, amounts raw (each token its own decimals). Out of range, a position holds one token (holds) and earns no fees: park pulls its liquidity out on its own DEX and deposits that token into a partner vault that takes it (vaults; usually the DEX's own), all from this wallet. Its fees come to the wallet. inRange counts the positions earning fees now, which are not parked.",
      ...(positions.some((p) => p.refusal === "ETH_NOT_SUPPORTED") ? ["A position that holds ETH (or WETH) does not park: no gage vault takes ETH yet."] : []),
      ...(vaults === null ? ["gage's index could not list the partner vaults now: ask again shortly before parking."] : []),
      ...(complete ? [] : ["Some positions may be missing: a position manager could not list them all now, or this wallet holds more than were read. Name one by its id (also) to read it."]),
    ].join(" "),
  };
}

// ---- Pulling out and minting, per DEX -----------------------------------------------------------------------------

/** Uniswap v4's action codes (v4-periphery `Actions`), as the LP lane's adapter sends them. */
export const V4_ACTION = { DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, SETTLE_PAIR: 0x0d, TAKE_PAIR: 0x11, SWEEP: 0x14 } as const;
/** `abi.encode(actions, params)`, the `unlockData` of a v4 PositionManager's `modifyLiquidities`. */
export const unlockData = (actions: readonly number[], params: readonly Hex[]): Hex =>
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [concatHex(actions.map((a) => numberToHex(a, { size: 1 }))), params]);
const KEY_TYPE = {
  type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }],
} as const;

/**
 * The calls that pull a position's whole liquidity out to the wallet, with `min0` and `min1` as its own minimums, as
 * the LP lane's adapters do (contracts/src/lp/adapters): a v3-style manager's `decreaseLiquidity` then `collect` of
 * everything owed (its fees too); a v4 PositionManager's DECREASE_LIQUIDITY then TAKE_PAIR (its native ETH as ETH); a
 * Fables hook's `withdraw` of the receipts, which unstakes them first where it must (their fees stay claimable there).
 */
export function pullCalls(pool: ParkPool, h: Pick<Held, "id" | "tickLower" | "tickUpper" | "liquidity">, wallet: Address, min0: bigint, min1: bigint, deadline: bigint): Step[] {
  if (pool.kind === "fables") {
    return [call("Withdraw the Fables receipts", pool.manager, encodeFunctionData({
      abi: fablesLiquidityAbi, functionName: "withdraw", args: [pool.key!, h.tickLower, h.tickUpper, h.liquidity, wallet, min0, min1, deadline],
    }))];
  }
  if (pool.kind === "uniswap-v4") {
    const key = pool.key!;
    const data = unlockData([V4_ACTION.DECREASE_LIQUIDITY, V4_ACTION.TAKE_PAIR], [
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [h.id, h.liquidity, min0, min1, "0x"]),
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [key.currency0, key.currency1, wallet]),
    ]);
    return [call(`Pull position #${h.id} out`, pool.manager, encodeFunctionData({ abi: v4ManagerAbi, functionName: "modifyLiquidities", args: [data, deadline] }))];
  }
  return [
    call(`Pull position #${h.id} out`, pool.manager, encodeFunctionData({
      abi: v3ManagerAbi, functionName: "decreaseLiquidity", args: [{ tokenId: h.id, liquidity: h.liquidity, amount0Min: min0, amount1Min: min1, deadline }],
    })),
    call(`Collect position #${h.id}`, pool.manager, encodeFunctionData({
      abi: v3ManagerAbi, functionName: "collect", args: [{ tokenId: h.id, recipient: wallet, amount0Max: maxUint128, amount1Max: maxUint128 }],
    })),
  ];
}

const Q96 = 1n << 96n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Uniswap's LiquidityAmounts: the liquidity `amount` of token0 buys between two prices, rounded down. */
const liquidityFor0 = (lo: bigint, hi: bigint, amount: bigint) => (amount * ((lo * hi) / Q96)) / (hi - lo);
/** The same for `amount` of token1. */
const liquidityFor1 = (lo: bigint, hi: bigint, amount: bigint) => (amount * Q96) / (hi - lo);
/** SqrtPriceMath: what `liquidity` takes of token0 between two prices, rounded up as a mint pays it. */
const amount0Up = (lo: bigint, hi: bigint, liquidity: bigint) => ceilDiv(ceilDiv((liquidity << 96n) * (hi - lo), hi), lo);
/** The same of token1. */
const amount1Up = (lo: bigint, hi: bigint, liquidity: bigint) => ceilDiv(liquidity * (hi - lo), Q96);

/**
 * A new position in [lower, upper] at the price now, built from `amount` of one token (token0 when `assetIs0`): the
 * liquidity it buys, and what it takes of the other token (`other`, rounded up) when the range is around the price. Null
 * where the range holds only the other token at this price, which the amount buys none of.
 */
export function mintFigures(sqrtPriceX96: bigint, lower: number, upper: number, assetIs0: boolean, amount: bigint) {
  const a = sqrtPriceAtTick(lower), b = sqrtPriceAtTick(upper);
  const below = sqrtPriceX96 <= a, above = sqrtPriceX96 >= b;
  if (assetIs0 ? above : below) return null;
  const liquidity = assetIs0 ? liquidityFor0(below ? a : sqrtPriceX96, b, amount) : liquidityFor1(a, above ? b : sqrtPriceX96, amount);
  const around = !below && !above;
  const other = around ? (assetIs0 ? amount1Up(a, sqrtPriceX96, liquidity) : amount0Up(sqrtPriceX96, b, liquidity)) : 0n;
  return { liquidity, other, around };
}

/** A tick as the price of `base` in `quote` (token1 per token0, each token's decimals taken out). */
const tickPrice = (tick: number, d0: number, d1: number, baseIs0: boolean) => {
  const p = 1.0001 ** tick * 10 ** (d0 - d1);
  return baseIs0 ? p : 1 / p;
};
const priceText = (x: number) => (!Number.isFinite(x) || x <= 0 ? "∞" : x >= 100 ? Math.round(x).toLocaleString("en-US") : x >= 1 ? x.toFixed(2) : x.toPrecision(4));
/**
 * A range in words: the price of the pool's other token in USDG where one side is USDG (`ETH from 2,214 to 2,707
 * USDG`), else of token0 in token1.
 */
export function rangeText(c: Pick<Ctx, "d">, pool: ParkPool, refs: Map<string, TokenRef>, lower: number, upper: number): string {
  const r0 = refIn(refs, pool.token0), r1 = refIn(refs, pool.token1);
  const baseIs0 = !same(pool.token0, c.d.usdg);
  const [base, quote] = baseIs0 ? [r0, r1] : [r1, r0];
  const at = (t: number) => tickPrice(t, r0.decimals, r1.decimals, baseIs0);
  const [lo, hi] = baseIs0 ? [at(lower), at(upper)] : [at(upper), at(lower)];
  return `${base.symbol} from ${priceText(lo)} to ${priceText(hi)} ${quote.symbol}`;
}

// ---- Park ---------------------------------------------------------------------------------------------------------

/**
 * Parking one out-of-range position (D334): its whole liquidity pulled out to the wallet on its own DEX (`pullCalls`),
 * the one token it held as the pull's own minimum, then that amount deposited into the partner vault named, which must
 * take that token (USDG in a USDG vault, a lend asset in its own). A vault of a native ERC-4626 generation takes
 * `deposit(assets, receiver)`; an earlier one `deposit(assets, minShares)`, its least shares what the amount buys now
 * less `maxSlippageBps`. Refused in range (IN_RANGE), for ETH (ETH_NOT_SUPPORTED), for a vault of another asset
 * (VAULT_ASSET_MISMATCH), under the vault's least deposit, and within three minutes of a Ramses position's last liquidity
 * change (RAMSES_WAIT: pulling it out claims its rewards, which Ramses would forfeit). A vault due a settlement is
 * settled first and the park planned again (`again`). Every call is built from one reading (`batch`).
 */
async function park(c: Ctx, i: Extract<ActionInput, { action: "park" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.id);
  const h = await heldOne(c, wallet, i.manager, id), pool = h.pool;
  requireThat(h.liquidity > 0n, "NOTHING_TO_PARK", "The position holds no liquidity: there is nothing to park");
  const price = await priceOf(c, pool);
  requireThat(price, "PRICE_UNAVAILABLE", "This pool's price cannot be read here, so its range cannot be told", 503);
  const x = holdingOf(h, price.sqrtPriceX96);
  requireThat(!x.inRange, "IN_RANGE", "The position is in range: it earns its pool's fees now. Park it once the price leaves its range");
  requireThat(x.side !== null, "NOTHING_TO_PARK", "The position holds too little to pull out");
  const token = x.side === 0 ? pool.token0 : pool.token1, amount = x.amount;
  if (isEth(c, token)) throw new ApiError("ETH_NOT_SUPPORTED", "The position holds ETH now, and no gage vault takes ETH yet: it parks once it holds USDG, or a token a gage vault lends", 409);
  const refs = await refsOf(c, [pool.token0, pool.token1]);
  const { address: vault, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset, held = refIn(refs, token);
  requireThat(same(cash.token, token), "VAULT_ASSET_MISMATCH", `This vault takes ${cash.symbol}, and the position holds ${held.symbol} now: park it into a vault that takes ${held.symbol}`);
  requireThat(!g.retired && v.fundingEnabled, "FUNDING_CLOSED", "This vault takes no deposit now");
  if (pool.kind === "ramses-v3") {
    const changed = await c.chain.ramsesLastModified(pool.manager, id);
    const from = changed + RAMSES_CLAIM_DELAY;
    if (c.now() < from) {
      throw new ApiError("RAMSES_WAIT", `Pulling a Ramses position out claims its rewards, which Ramses forfeits within minutes of its last liquidity change: park it from ${new Date(from * 1000).toISOString()}`, 409, true);
    }
  }
  const least = MIN_DEPOSIT * assetScale(cash);
  requireThat(amount >= least, "BELOW_MINIMUM", `Too little to park: the vault takes at least ${f.money(least, cash)}`);
  const name = vaultName(v, c.d), full = `${name} (${f.short(vault)})`;
  const view: View = {
    action: "park", kind: pool.kind, manager: pool.manager, id: i.id, pool: pool.id, poolName: pool.name, vault, name, amount: amount.toString(), feeBps: v.feeBps,
    ...refOf(cash), ...inAsset(c, cash),
  };
  const title = `Park ${f.money(amount, cash)} from position #${i.id} (${pool.name}) in ${full}`;
  // The vault's own generation's index (D403), which listed it.
  const index = indexerOf(c, g);
  const p = await index.get(`/intent/partners/vaults/${vault.toLowerCase()}/preview?deposit=${amount}`, previewAnswer);
  if (p.refusal === "SETTLEMENT_DUE") return settleFirst(c, vault, view, title, name, index);
  requireThat(!p.refusal, vaultRefusal(p.refusal), refusalWords(p.refusal, cash, g.primary) ?? "The vault refuses this deposit");
  // A native ERC-4626 vault answers `maxWithdraw`; an earlier generation's does not, and takes its slippage-held deposit.
  const native = (await c.chain.vaultMaxWithdraw(vault, wallet)) !== null;
  const minShares = slip(BigInt(p.shares), i.maxSlippageBps);
  requireThat(native || minShares > 0n, "ZERO_SHARES", "Too small to buy a share");
  await sameVaultAsset(c, vault, cash);
  const claims = await bookGas(c.chain, vault, v.mandateVersion);
  const deadline = BigInt(c.now() + PARK_DEADLINE);
  const deposit = native
    ? encodeFunctionData({ abi: partnerVault4626Abi, functionName: "deposit", args: [amount, wallet] })
    : encodeFunctionData({ abi: partnerVaultAbi, functionName: "deposit", args: [amount, minShares] });
  const steps: Step[] = [
    ...pullCalls(pool, h, wallet, x.side === 0 ? amount : 0n, x.side === 1 ? amount : 0n, deadline),
    ...await approval(c, cash.token, cash.symbol, wallet, vault, amount),
    { ...call("Deposit", vault, deposit, true), extraGas: claims },
  ];
  const rows: Row[] = [
    { label: "You pull out", value: `Position #${i.id}, ${pool.name}: ${f.money(amount, cash)}, all its liquidity holds while out of range` },
    { label: "Into", value: `${full}, which ${LENDS}` },
    ...(native ? [] : [{ label: "You receive at least", value: f.shares(minShares) }]),
    { label: "Performance fee", value: `${f.bps(v.feeBps)} of what the vault's loans return` },
    { label: "Its fees", value: pool.kind === "fables" ? "Stay claimable on Fables" : "Come to your wallet" },
    { label: "Back to a position", value: "Unpark: withdraw from the vault, up to its free cash, and open a new position in a range you pick" },
  ];
  return {
    view, steps, batch: true,
    summary: { title, rows },
    notes: [
      "Every call is built from one reading of the chain: send them in order, or as one batch (EIP-5792); do not prepare again between them. If the price comes back into the position's range first, the pull reverts and nothing moves.",
      ...(pool.kind === "ramses-v3" ? ["Pulling a Ramses position out pays its rewards to the wallet."] : []),
      ...(pool.key && BigInt(pool.key.hooks) !== 0n && pool.kind === "uniswap-v4" ? ["This pool has a hook: should it take part of what leaves, the pull reverts at its minimum and nothing moves."] : []),
      ...(cash.stable ? [] : [`The vault counts in ${cash.symbol}: what you withdraw is ${cash.symbol}.`]),
    ],
  };
}

// ---- Unpark -------------------------------------------------------------------------------------------------------

/**
 * The approvals a mint needs to pull `amount` of `token` from the wallet: an exact ERC-20 approval of the spender (a
 * v3-style manager, a Fables hook); for a v4 PositionManager, which settles through Permit2, the token's approval of
 * Permit2 and Permit2's of the PositionManager until the deadline, each only where it falls short. Native ETH needs none.
 */
async function mintApprovals(c: Ctx, pool: ParkPool, wallet: Address, ref: TokenRef, amount: bigint, deadline: number): Promise<Step[]> {
  if (amount === 0n || BigInt(ref.token) === 0n) return [];
  if (pool.kind !== "uniswap-v4") return approval(c, ref.token, ref.symbol, wallet, pool.manager, amount);
  const permit2 = await c.chain.permit2Of(pool.manager);
  const [toPermit2, allowed] = await Promise.all([c.chain.allowance(ref.token, wallet, permit2), c.chain.permit2Allowance(permit2, wallet, ref.token, pool.manager)]);
  return [
    ...(toPermit2 >= amount ? [] : [{
      label: `Approve ${ref.symbol} to Permit2`, kind: "approve" as const, final: false,
      build: () => Promise.resolve(tx(ref.token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [permit2, amount] }))),
    }]),
    ...(allowed.amount >= amount && allowed.expiration >= deadline ? [] : [{
      label: `Let the position manager take ${ref.symbol}`, kind: "approve" as const, final: false,
      build: () => Promise.resolve(tx(permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [ref.token, pool.manager, amount, deadline] }))),
    }]),
  ];
}

/**
 * Minting a position in [lower, upper] for the wallet with `liquidity`, taking at most `max0` and `max1`: a v3-style
 * manager's `mint` (Uniswap's by fee tier, Ramses' by tick spacing) with its desired amounts and least ones; a v4
 * PositionManager's MINT_POSITION then SETTLE_PAIR, its native ETH sent along and what is left swept back; a Fables hook's
 * `deposit`, which mints its receipts 1:1 with the liquidity.
 */
export function mintCall(pool: ParkPool, wallet: Address, m: {
  tickLower: number; tickUpper: number; liquidity: bigint; amount0: bigint; amount1: bigint; min0: bigint; min1: bigint; deadline: bigint;
}): Step {
  const label = `Open the new ${pool.name} position`;
  if (pool.kind === "uniswap-v3" || pool.kind === "ramses-v3") {
    const common = { token0: pool.token0, token1: pool.token1, tickLower: m.tickLower, tickUpper: m.tickUpper, amount0Desired: m.amount0, amount1Desired: m.amount1, amount0Min: m.min0, amount1Min: m.min1, recipient: wallet, deadline: m.deadline };
    return call(label, pool.manager, pool.kind === "ramses-v3"
      ? encodeFunctionData({ abi: ramsesManagerAbi, functionName: "mint", args: [{ ...common, tickSpacing: pool.tickSpacing }] })
      : encodeFunctionData({ abi: v3ManagerAbi, functionName: "mint", args: [{ ...common, fee: pool.fee }] }), true);
  }
  const key = pool.key!, native = BigInt(key.currency0) === 0n;
  if (pool.kind === "fables") {
    return call(label, pool.manager, encodeFunctionData({
      abi: fablesLiquidityAbi, functionName: "deposit", args: [key, m.tickLower, m.tickUpper, m.liquidity, m.amount0, m.amount1, m.deadline],
    }), true, native ? m.amount0 : 0n);
  }
  const data = unlockData(
    [V4_ACTION.MINT_POSITION, V4_ACTION.SETTLE_PAIR, ...(native ? [V4_ACTION.SWEEP] : [])],
    [
      encodeAbiParameters(
        [KEY_TYPE, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
        [key, m.tickLower, m.tickUpper, m.liquidity, m.amount0, m.amount1, wallet, "0x"],
      ),
      encodeAbiParameters([{ type: "address" }, { type: "address" }], [key.currency0, key.currency1]),
      ...(native ? [encodeAbiParameters([{ type: "address" }, { type: "address" }], [zeroAddress, wallet])] : []),
    ],
  );
  return call(label, pool.manager, encodeFunctionData({ abi: v4ManagerAbi, functionName: "modifyLiquidities", args: [data, m.deadline] }), true, native ? m.amount0 : 0n);
}

/**
 * Unparking (D334): withdrawing from a partner vault, then minting a position in [tickLower, tickUpper] of a pool served
 * that pairs the vault's asset. A native ERC-4626 vault pays exactly `amount` (`withdraw(assets, receiver, owner)`), at
 * most what it can pay the wallet now (`maxWithdraw`: its free cash, nothing at a settlement due), all of that when
 * omitted; an earlier generation's redeems as `earn_redeem` does and the mint takes what that pays. The position takes
 * the amount on the vault asset's side: a range that holds only the other token at the price now is refused
 * (RANGE_WITHOUT_ASSET); one around the price takes the other token too, from the wallet, at most what the price now asks
 * and `maxSlippageBps` more. Approvals are exact (through Permit2 for a v4 PositionManager). What unpark waits on: the
 * vault's free cash, which loans repaying and maturing refill, and a settlement due, which is sent first (`again`).
 */
async function unpark(c: Ctx, i: Extract<ActionInput, { action: "unpark" }>): Promise<Plan> {
  const wallet = i.wallet as Address, bps = i.maxSlippageBps ?? 50;
  const pool = parkPoolsIn(c).find((p) => same(p.manager, i.manager) && same(p.id, i.pool));
  requireThat(pool, "UNKNOWN_POOL", "gage unparks into no such pool: gage_capabilities parkPools lists them", 404);
  requireThat(i.tickLower < i.tickUpper && i.tickLower >= MIN_TICK && i.tickUpper <= MAX_TICK && i.tickLower % pool.tickSpacing === 0 && i.tickUpper % pool.tickSpacing === 0,
    "INVALID_RANGE", `A range is two ticks, the lower under the upper, each a multiple of the pool's tick spacing (${pool.tickSpacing})`, 400);
  const { address: vault, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset, assetIs0 = same(pool.token0, cash.token);
  requireThat(assetIs0 || same(pool.token1, cash.token), "VAULT_ASSET_NOT_IN_POOL", `This vault pays out ${cash.symbol}, which ${pool.name} does not pair`);
  const [price, refs] = await Promise.all([priceOf(c, pool), refsOf(c, [pool.token0, pool.token1])]);
  requireThat(price, "PRICE_UNAVAILABLE", "This pool's price cannot be read here, so the new position cannot be sized", 503);
  const name = vaultName(v, c.d), full = `${name} (${f.short(vault)})`, range = rangeText(c, pool, refs, i.tickLower, i.tickUpper);
  const otherRef = refIn(refs, assetIs0 ? pool.token1 : pool.token0);
  const blank: View = {
    action: "unpark", vault, name, amount: "0", kind: pool.kind, manager: pool.manager, pool: pool.id, poolName: pool.name, tickLower: i.tickLower, tickUpper: i.tickUpper,
    liquidity: "0", other: null, ...refOf(cash), ...inAsset(c, cash),
  };
  const title = `Unpark from ${full} into ${pool.name}, ${range}`;
  // What the vault pays, and the steps that take it out.
  const most = await c.chain.vaultMaxWithdraw(vault, wallet);
  let amount: bigint;
  let out: Step[];
  if (most !== null) {
    if (most === 0n) {
      const acc = await indexerOf(c, g).get(`/intent/partners/vaults/${vault.toLowerCase()}/accounting`, accounting);
      if (acc.settlement?.due) return settleFirst(c, vault, blank, title, name, indexerOf(c, g));
      throw new ApiError("NOTHING_TO_WITHDRAW", "The vault can pay this wallet nothing now: it holds none of the wallet's, or its cash is lent out. Unpark waits for its loans to repay or mature", 409, true);
    }
    amount = i.amount ? BigInt(i.amount) : most;
    requireThat(amount <= most, "INSUFFICIENT_LIQUIDITY", `The vault can pay ${f.money(most, cash)} now`, 409, { availableNow: most.toString() });
    out = [{ ...call(`Withdraw ${f.money(amount, cash)}`, vault, encodeFunctionData({ abi: partnerVault4626Abi, functionName: "withdraw", args: [amount, wallet, wallet] })), extraGas: await bookGas(c.chain, vault, v.mandateVersion) }];
  } else {
    // An earlier generation's vault redeems shares, as earn_redeem sizes them: an amount asked for is the shares it takes
    // at the vault's own price, rounded up (`previewWithdraw`).
    let shares: string | undefined;
    if (i.amount) {
      const book = await c.chain.vaultBook(vault);
      shares = ceilDiv(BigInt(i.amount) * (book.totalSupply + VIRTUAL_SHARES), book.totalAssets + assetScale(cash)).toString();
    }
    const r = await plan(c, { action: "earn_redeem", wallet: i.wallet, vault: i.vault, ...(shares ? { shares } : {}), maxSlippageBps: bps });
    if (r.again) return { ...r, view: blank, summary: { ...r.summary, title } };
    const rv = r.view as Extract<View, { action: "earn_redeem" }>;
    amount = BigInt(rv.assets);
    out = r.steps.map((s) => ({ ...s, final: false }));
  }
  const m = mintFigures(price.sqrtPriceX96, i.tickLower, i.tickUpper, assetIs0, amount);
  requireThat(m, "RANGE_WITHOUT_ASSET", `At the price now this range holds only ${otherRef.symbol}: pick one that holds ${cash.symbol}, ${assetIs0 ? "above" : "below"} the price or around it`);
  requireThat(m.liquidity > 0n, "TOO_SMALL", "Too little to open a position in this range");
  if (pool.kind === "fables" && m.around && BigInt(otherRef.token) === 0n) {
    throw new ApiError("RANGE_NEEDS_ETH", "A Fables range around the price takes ETH too, which gage does not send to Fables: pick a range that holds only the vault's asset, or deposit on Fables", 409);
  }
  // A v3-style mint takes what the desired amounts buy at its price then, held to the least ones; a v4 or Fables mint
  // names its liquidity, so it is cut by the slippage room, and the other side's most is what the full one takes now.
  const v3 = pool.kind === "uniswap-v3" || pool.kind === "ramses-v3";
  const liquidity = v3 ? m.liquidity : slip(m.liquidity, bps);
  const other = m.other;
  const native = BigInt(otherRef.token) === 0n;
  if (other > 0n) {
    const has = native ? await c.chain.nativeBalance(wallet) : await c.chain.balance(otherRef.token, wallet);
    requireThat(has >= other, "INSUFFICIENT_BALANCE", `This range takes ${f.token(other, otherRef.decimals, otherRef.symbol)} too, and the wallet holds less: pick one that holds only ${cash.symbol}, or add ${otherRef.symbol}`);
  }
  const deadline = c.now() + PARK_DEADLINE;
  const [a0, a1] = assetIs0 ? [amount, other] : [other, amount];
  const mint = mintCall(pool, wallet, {
    tickLower: i.tickLower, tickUpper: i.tickUpper, liquidity, amount0: a0, amount1: a1, min0: v3 ? slip(a0, bps) : 0n, min1: v3 ? slip(a1, bps) : 0n, deadline: BigInt(deadline),
  });
  const steps: Step[] = [
    ...out,
    ...await mintApprovals(c, pool, wallet, refOf(cash), amount, deadline),
    ...await mintApprovals(c, pool, wallet, otherRef, other, deadline),
    mint,
  ];
  return {
    view: { ...blank, amount: amount.toString(), liquidity: liquidity.toString(), other: other > 0n ? { ...otherRef, amount: other.toString() } : null },
    steps, batch: true,
    summary: {
      title,
      rows: [
        { label: "You withdraw", value: `${f.money(amount, cash)} from ${full}` },
        { label: "New position", value: `${pool.name}, ${range}` },
        ...(other > 0n ? [{ label: "You add", value: `${f.token(other, otherRef.decimals, otherRef.symbol)} at most, from your wallet` }] : []),
        { label: "While in range", value: "It earns its pool's fees; out of range it holds one token, and parks again" },
      ],
    },
    notes: [
      "Every call is built from one reading of the chain: send them in order, or as one batch (EIP-5792); do not prepare again between them.",
      ...(other > 0n ? [`The range is around the price now, so the position takes ${otherRef.symbol} too: at most what the price now asks, with ${f.bps(bps)} of room.`] : []),
      "Unpark waits on the vault's free cash: what is lent out comes back as loans repay or mature, and a loan past its end is settled first.",
    ],
  };
}

/** The plan of a park or an unpark. */
export function parkPlan(c: Ctx, input: Extract<ActionInput, { action: "park" | "unpark" }>): Promise<Plan> {
  return input.action === "park" ? park(c, input) : unpark(c, input);
}

// ---- Batches ------------------------------------------------------------------------------------------------------

/** One call of a park's or an unpark's batch, in order: what a wallet's `wallet_sendCalls` (EIP-5792) takes, and its label. */
export interface ParkCall { label: string; kind: "approve" | "action"; final: boolean; to: Address; data: Hex; value: bigint }
/**
 * A park or an unpark as one batch: every call in order, built from one reading of the chain, for a wallet that sends
 * several at once (EIP-5792 `wallet_sendCalls`) or sent one by one, each once the one before is mined. `again`: the
 * calls are a vault's settlement, which comes first; once it is mined, ask for the batch again.
 */
export interface ParkBatch { action: "park" | "unpark"; wallet: Address; summary: Plan["summary"]; view: View; calls: ParkCall[]; notes: string[]; again?: true }

/**
 * The batch of a park or an unpark, simulated whole from the wallet first (`eth_simulateV1`, each call seeing the ones
 * before it): a call that would revert refuses it (SIMULATION_FAILED, naming the call). Where the RPC cannot simulate a
 * batch, the wallet simulates it before it signs.
 */
export async function parkBatch(c: Ctx, input: Extract<ActionInput, { action: "park" | "unpark" }>): Promise<ParkBatch> {
  const wallet = input.wallet as Address;
  const p = await parkPlan(c, input);
  const built = await Promise.all(p.steps.map((s) => s.build()));
  const simulated = built.length ? await c.chain.simulateCalls(wallet, built) : [];
  const failed = simulated ? simulated.indexOf(false) : -1;
  if (failed >= 0) throw new ApiError("SIMULATION_FAILED", `${p.steps[failed]!.label} would revert now; check the position, balances and the vault`, 409);
  return {
    action: input.action, wallet, summary: p.summary, view: p.view, notes: p.notes,
    calls: built.map((t, n) => ({ label: p.steps[n]!.label, kind: p.steps[n]!.kind, final: p.steps[n]!.final, to: t.to, data: t.data, value: t.value })),
    ...(p.again ? { again: true as const } : {}),
  };
}
