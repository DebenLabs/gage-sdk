/**
 * The LP lane (docs/api.md "LP lane", D314, D315): fixed-cost USDG loans against a Uniswap v3, SushiSwap v3, Ouro v3 or Ramses V3
 * WETH/USDG position, or a Uniswap v4 ETH/USDG one, through the lane's own core, registry, vaults and position adapters,
 * never an Intent generation. There is no liquidation: a loan is never closed early because a price moves, and one not
 * repaid by its end is settled by unwinding the position for its lenders. Served only where the release makes the lane
 * public (`Deployment.lpLane`). Its reads come from the chain, where that is simple (the core's loans by id, newest
 * first, a v3-style position manager's positions by index), Uniswap v4 positions' ids from gage's index (its
 * PositionManager cannot list them), and its quotes from gage's rates service, checked field by field before use.
 */
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { LpFacts, LpLoan, LpMandatePool, LpReserveState } from "./chain.js";
import { LP_V4_KINDS, lpAdapterOf, lpPoolOf, lpVaultOf, type LpAdapter, type LpAdapterKind, type LpLane, type LpPool, type PoolKey } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import * as f from "./format.js";
import { lpShareUnit } from "./lpShares.js";
import { defaultsFor } from "./networks.js";
import type { Ctx, TokenRef } from "./plans.js";
import type { ActionName } from "./schemas.js";
import { poolId, sqrtPriceAtTick } from "./v4math.js";

/** An LP loan's state as its core stores it (`LoanState`): ROLLED, repaid by a new loan on the same position (D317). */
export const LP_STATE = ["NONE", "ACTIVE", "REPAID", "DEFAULTED", "ABANDONED", "ROLLED"] as const;
export const lpStateName = (s: number) => LP_STATE[s] ?? "UNKNOWN";
/** The most LP loans one answer reads of the core, newest first: a hundred to a call. */
export const MAX_LP_LOANS = 2_000;
/** The most positions read of each position manager for a wallet, newest first. */
export const MAX_LP_POSITIONS = 100;
/** A quote planned is sent as it is while it has this long left (seconds); past that, the borrow is quoted again. */
export const QUOTE_MARGIN = 60;

/**
 * The position formats the lane takes, in plain words: its adapters' (SushiSwap v3's and Ouro v3's positions on the Uniswap v3
 * adapter; Fables receipts once wrapped as a position, D316).
 */
export const LP_FORMATS = "Uniswap v3 or v4, SushiSwap v3, Ouro v3, Ramses or Fables";
/** What the LP lane is, said once its switch is on, with no liquidation's definition (the design brief's words). */
export const LP_RULE =
  `An LP loan (lp_borrow) lends USDG at a fixed cost against an ETH/USDG or stock/USDG liquidity position on ${LP_FORMATS}, in a pool the lane lists, which waits in its own escrow while the loan runs (Fables receipts are wrapped into a position first). There is no liquidation: the loan is never closed early because a price moves. Before its end it may be repaid, or rolled into a new loan on the same position (lp_roll). If it is not repaid by its end, the position is unwound for its lenders, and nothing else is taken from the borrower.`;

/**
 * What pledging a position does besides, in plain words, where its format does more: Uniswap v4's PositionManager
 * unsubscribes a position it moves (a rewards program that tracks it stops counting it), and a native ETH pool's fees
 * are collected as WETH. None for a Uniswap v3, SushiSwap v3, Ouro v3 or Ramses position.
 */
export function positionNotes(kind: LpAdapterKind, pool: Pick<LpPool, "native"> | null): string[] {
  return [
    ...(kind === "uniswap-v4" ? ["Moving a Uniswap v4 position into its escrow ends any subscription it has: a rewards program that tracks it stops counting it until it is back and subscribed again."] : []),
    ...(kind === "fables" ? ["A wrapped Fables position's receipts are unstaked: they earn its swap fees, not Fables' emissions, and its fees are claimed from the Fables hook, which keeps its claim fee."] : []),
    ...(pool?.native ? ["Its fees are collected as WETH, not ETH."] : []),
  ];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const rawStr = (v: bigint) => v.toString();
const orNull = (v: bigint | null) => (v === null ? null : rawStr(v));

/** The public LP lane, refused where the release names none or keeps it hidden. */
export function laneOf(c: Pick<Ctx, "d">): LpLane {
  requireThat(c.d.lpLane, "LP_CLOSED", "gage's LP lane is not open on this deployment", 404);
  return c.d.lpLane;
}
export function adapterOf(lane: LpLane, adapter: string): LpAdapter {
  const a = lpAdapterOf(lane, adapter);
  requireThat(a, "UNKNOWN_ADAPTER", "This is not a position adapter of gage's LP lane", 404);
  return a;
}
/** A vault of the lane: one the manifest names (by its name there) or one its factory opened (D318, by `nameOf`). */
export interface LaneVault { address: Address; name: string; factory: boolean }

/**
 * Every vault of the lane: the manifest's, then every vault its factory opened (D318), oldest first, those the registry
 * removed included, as a wallet's holdings and loans are read against them. No window: the factory's 65th vault is the
 * lane's as its first is (D319).
 */
export async function laneVaults(c: Pick<Ctx, "chain">, lane: LpLane): Promise<LaneVault[]> {
  const own = lane.vaults.map((v): LaneVault => ({ address: v.address, name: v.name, factory: false }));
  if (!lane.vaultFactory) return own;
  const made = (await c.chain.lpFactoryVaults(lane.vaultFactory)).filter((v) => !own.some((o) => same(o.address, v.address)));
  return [...own, ...made.map((v): LaneVault => ({ address: getAddress(v.address), name: v.name || getAddress(v.address), factory: true }))];
}

/** The lane's vaults that may still lend (D319): every one the registry allows (`vaultAllowed`), however many the factory opened. */
export async function lendingVaults(c: Pick<Ctx, "chain">, lane: LpLane): Promise<LaneVault[]> {
  const all = await laneVaults(c, lane);
  const allowed = await c.chain.lpVaultsAllowed(lane.registry, all.map((v) => v.address));
  return all.filter((_, n) => allowed[n] === true);
}
/** `vault` as a vault of the lane (the manifest's, or its factory's: `isVault`), or null for any other address. */
export async function vaultIn(c: Pick<Ctx, "chain">, lane: LpLane, vault: string): Promise<LaneVault | null> {
  const own = lpVaultOf(lane, vault);
  if (own) return { address: own.address, name: own.name, factory: false };
  if (!lane.vaultFactory || !/^0x[0-9a-fA-F]{40}$/.test(vault)) return null;
  const address = getAddress(vault), name = await c.chain.lpFactoryVault(lane.vaultFactory, address);
  return name === null ? null : { address, name: name || address, factory: true };
}
/** `vault` as a vault of the lane; UNKNOWN_VAULT for any other address. */
export async function vaultOf(c: Pick<Ctx, "chain">, lane: LpLane, vault: string): Promise<LaneVault> {
  const v = await vaultIn(c, lane, vault);
  requireThat(v, "UNKNOWN_VAULT", "This is not a vault of gage's LP lane", 404);
  return v;
}

// ---- Liquidity arithmetic (Uniswap v3's LiquidityAmounts, as both position managers use it) ---------------------

const Q96 = 1n << 96n;

/**
 * What a position's liquidity holds of each token at the pool's price (LiquidityAmounts.getAmountsForLiquidity,
 * rounded down): all token0 below its range, all token1 above it, both inside. Uncollected fees are not counted.
 */
export function positionAmounts(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  // TickMath's price at each end, as v4's port computes it to the bit (`sqrtPriceAtTick`).
  const a = sqrtPriceAtTick(tickLower), b = sqrtPriceAtTick(tickUpper);
  const amount0 = (lo: bigint, hi: bigint) => ((liquidity << 96n) * (hi - lo)) / hi / lo;
  const amount1 = (lo: bigint, hi: bigint) => (liquidity * (hi - lo)) / Q96;
  if (liquidity === 0n || a >= b) return { amount0: 0n, amount1: 0n };
  if (sqrtPriceX96 <= a) return { amount0: amount0(a, b), amount1: 0n };
  if (sqrtPriceX96 >= b) return { amount0: 0n, amount1: amount1(a, b) };
  return { amount0: amount0(sqrtPriceX96, b), amount1: amount1(a, sqrtPriceX96) };
}

/**
 * What `amount0` of token0 and `amount1` of token1 are worth in USDG at the pool's price, raw, rounded down: the other
 * token priced in USDG by `sqrtPriceX96` (token1 per token0, raw units). Null for a pool without USDG.
 */
export function valueInUsdg(usdg: Address, token0: Address, token1: Address, amount0: bigint, amount1: bigint, sqrtPriceX96: bigint): bigint | null {
  if (sqrtPriceX96 === 0n) return null;
  const q192 = 1n << 192n;
  if (same(token1, usdg)) return amount1 + (amount0 * sqrtPriceX96 * sqrtPriceX96) / q192;
  if (same(token0, usdg)) return amount0 + (amount1 * q192) / (sqrtPriceX96 * sqrtPriceX96);
  return null;
}

// ---- Tokens -------------------------------------------------------------------------------------------------------

/** Each token's symbol and decimals as a review draws them: USDG's known, any other's read from the token. */
export async function tokenRefs(c: Pick<Ctx, "d" | "chain">, tokens: readonly Address[]): Promise<Map<string, TokenRef>> {
  const distinct = [...new Map(tokens.map((t) => [t.toLowerCase(), t])).values()];
  const refs = await Promise.all(distinct.map(async (token): Promise<TokenRef> => {
    if (same(token, c.d.usdg)) return { token, symbol: "USDG", decimals: 6 };
    try {
      const { symbol, decimals } = await c.chain.tokenInfo(token);
      return { token, symbol: f.plainSymbol(symbol) || "tokens", decimals };
    } catch { return { token, symbol: "tokens", decimals: 18 }; }
  }));
  return new Map(refs.map((r) => [r.token.toLowerCase(), r]));
}
/** An amount of a token as a summary writes it: USDG in cents, any other token to four places. */
export const amountText = (r: TokenRef, raw: bigint) => (r.symbol === "USDG" && r.decimals === 6 ? f.usdg(raw) : f.token(raw, r.decimals, r.symbol));

/**
 * Every token the LP lane may credit a wallet (`LPCore.credit`): USDG, its pools' and executors' tokens, and what each
 * adapter's DEX pays as rewards, read from the adapters, as gage's index reads them (`/lp/credits`). Each once, in that
 * order.
 */
export async function creditTokens(c: Pick<Ctx, "d" | "chain">, lane: LpLane): Promise<Address[]> {
  const rewards = await Promise.all(lane.adapters.map((a) => c.chain.lpRewardTokens(a.address)));
  const all = [c.d.usdg, ...lane.pools.flatMap((p) => [p.token0, p.token1]), ...lane.executors.map((e) => e.token), ...rewards.flat()].map((t) => getAddress(t));
  return [...new Map(all.map((t) => [t.toLowerCase(), t])).values()];
}

/** The tokens a wallet has a credit of on the LP core, with the amounts, in `creditTokens`' order. */
export async function walletCredits(c: Pick<Ctx, "d" | "chain">, lane: LpLane, wallet: Address, tokens?: readonly Address[]) {
  const list = tokens ?? await creditTokens(c, lane);
  const amounts = await c.chain.lpCredits(lane.core, wallet, list);
  const held = list.flatMap((token, n) => (amounts[n]! > 0n ? [{ token, amount: amounts[n]! }] : []));
  const refs = await tokenRefs(c, held.map((h) => h.token));
  return held.map((h) => ({ ...refs.get(h.token.toLowerCase())!, amount: h.amount }));
}

// ---- Loans --------------------------------------------------------------------------------------------------------

/**
 * The core's loans, newest first, read by id (1 to `nextLoanId` − 1) a hundred to a call, at most MAX_LP_LOANS of them:
 * `complete` says whether every loan was read. The lane names no index route the SDK depends on.
 */
export async function scanLoans(c: Pick<Ctx, "chain">, lane: LpLane): Promise<{ loans: LpLoan[]; complete: boolean }> {
  const last = (await c.chain.lpNextLoanId(lane.core)) - 1n;
  if (last < 1n) return { loans: [], complete: true };
  const count = last < BigInt(MAX_LP_LOANS) ? Number(last) : MAX_LP_LOANS;
  const ids = Array.from({ length: count }, (_, k) => last - BigInt(k));
  return { loans: (await c.chain.lpLoans(lane.core, ids)).filter((l) => l.state !== 0), complete: last <= BigInt(MAX_LP_LOANS) };
}

/** One LP loan of the core, refused when there is none. */
export async function loanById(c: Pick<Ctx, "chain">, lane: LpLane, id: string): Promise<LpLoan> {
  const [l] = await c.chain.lpLoans(lane.core, [BigInt(id)]);
  requireThat(l && l.state !== 0, "LOAN_NOT_FOUND", "No LP loan has this id", 404);
  return l;
}

/** A position as a review draws it: its adapter and kind, its id, its pool and the pool's name in the release. */
export interface LpPositionRef { adapter: Address; kind: LpAdapter["kind"] | null; tokenId: string; pool: Address; poolName: string }
export const positionRef = (lane: LpLane, adapter: Address, pool: Address, tokenId: bigint): LpPositionRef => ({
  adapter, kind: lpAdapterOf(lane, adapter)?.kind ?? null, tokenId: tokenId.toString(), pool, poolName: lpPoolOf(lane, adapter, pool)?.name ?? "an LP pool",
});
/** A loan's cost in basis points of its principal, to a tenth. */
export const lpCostBps = (principal: bigint, repayment: bigint) => (principal > 0n ? Number(((repayment - principal) * 100_000n) / principal) / 10 : null);

// ---- Quotes (rates service) -------------------------------------------------------------------------------------

/**
 * The rates service's refusals of an LP quote gage-sdk passes on, in its own words (docs/api.md "LP lane", Quotes).
 * Neither another code nor any text the service sends reaches an agent.
 */
const REFUSALS: Record<string, string> = {
  LP_CLOSED: "gage's LP lane is not open now",
  ADAPTER_NOT_ALLOWED: "gage's LP lane does not take positions of this kind now",
  POOL_NOT_ALLOWED: "gage's LP lane does not lend against this position's pool now",
  RANGE_TOO_NARROW: "The position's range is narrower than its pool's least",
  EMPTY_POSITION: "The position holds no liquidity",
  NOT_OWNER: "This wallet does not hold the position",
  TERM_NOT_ALLOWED: "The LP lane does not lend for this term",
  LOANS_PAUSED: "New LP loans are paused",
  BELOW_MINIMUM_LOAN: "The loan this position supports is under its pool's least loan",
  ABOVE_LOAN_CAP: "The loan would be over its pool's most for one loan",
  ABOVE_POOL_CAP: "Loans against this pool are at their limit now",
  ABOVE_DAILY_CAP: "The LP lane has lent its most for today",
  // D318: a vault funds only the pools of its mandate, a pool its curator added three hours after.
  VAULT_CANNOT_FUND: "No LP vault whose mandate funds this pool now can fund this loan whole (a vault named that does not fund it is refused so too)",
  // A stock position is priced only while its market is open and its price feed is fresh.
  PRICING_UNAVAILABLE: "gage's rates model cannot price this now (a stock position only while its market is open); try again shortly",
  NOT_REGISTRY_SIGNER: "gage's rates service cannot sign LP loans now; try again later",
  // A roll's own (LPCore.roll): the loan running, before its end, the wallet its borrower, the position its own.
  NOT_ACTIVE: "The LP loan is not running: only a running loan rolls",
  PAST_TERM: "The LP loan has reached its end, or ends too soon to roll: repay it",
  NOT_BORROWER: "This wallet did not borrow this LP loan",
  NOT_SAME_POSITION: "The position named is not this LP loan's",
};
const RETRYABLE = new Set(["PRICING_UNAVAILABLE", "NOT_REGISTRY_SIGNER", "VAULT_CANNOT_FUND", "ABOVE_DAILY_CAP"]);

const digits = z.string().regex(/^\d{1,78}$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** A small whole number as the service writes integers (a decimal string), or as a number. */
const whole = z.union([z.string().regex(/^-?\d{1,20}$/), z.number().int()]).transform((v) => Number(v));
const quoteSchema = z.object({
  schema: z.literal("gage-lp-quote-v1"),
  valuation: z.object({ collateralValue: digits }).loose(),
  terms: z.object({ principal: digits, repayment: digits, feeBps: whole }).loose(),
  quote: z.object({
    borrower: addr, vault: addr, adapter: addr, tokenId: digits, liquidity: digits, tickLower: whole, tickUpper: whole, collateralValue: digits,
    principal: digits, repayment: digits, term: whole, feeBps: whole, deadline: digits,
  }).loose(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  expiresAt: z.number().int(),
  // A roll's quote (`loan=`): the old loan's repayment, and what the borrower is credited (positive) or pays (negative).
  roll: z.object({ loanId: digits, owed: digits, net: z.string().regex(/^-?\d{1,78}$/) }).loose().optional(),
}).loose();

/** `LPCore.LoanQuote`, as the core takes it. */
export interface LoanQuote {
  borrower: Address; vault: Address; adapter: Address; tokenId: bigint; liquidity: bigint; tickLower: number; tickUpper: number;
  collateralValue: bigint; principal: bigint; repayment: bigint; term: number; feeBps: number; deadline: bigint;
}
/**
 * A signed LP quote, checked against what was asked and the position on chain; for a roll, what it settles: the old
 * loan's repayment (`owed`) and what the borrower is credited (`net` positive) or pays (negative), as `LPCore.roll` moves it.
 */
export interface SignedLpQuote { quote: LoanQuote; signature: Hex; expiresAt: number; facts: LpFacts; pool: LpPool; roll: { owed: bigint; net: bigint } | null; vault: LaneVault }
/**
 * What a quote is asked for: the position (its adapter and id), the borrower, the term and, if named, the vault; for a
 * roll, the running loan it rolls (`loan=`), whose position it must be.
 */
export interface LpAsk { adapter: LpAdapter; tokenId: bigint; borrower: Address; term: number; vault: Address | null; rolling?: LpLoan }

const U128 = 1n << 128n;
function quoteRefusal(got: { status: number; body: unknown }): ApiError {
  const body = (got.body && typeof got.body === "object" ? got.body : {}) as { error?: { code?: unknown } | null; refusal?: { code?: unknown } | null; code?: unknown };
  const code = [body.error?.code, body.refusal?.code, body.code].find((x): x is string => typeof x === "string");
  if (code !== undefined && Object.hasOwn(REFUSALS, code)) {
    return new ApiError(code, REFUSALS[code]!, code === "NOT_REGISTRY_SIGNER" || code === "PRICING_UNAVAILABLE" ? 503 : got.status === 400 ? 400 : 409, RETRYABLE.has(code));
  }
  if (got.status === 404) return new ApiError("RATES_UNAVAILABLE", "The rates service does not offer LP quotes", 503);
  if (got.status >= 500) return new ApiError("RATES_UNAVAILABLE", "The rates service could not answer", 503, true);
  if (got.status === 200) return new ApiError("UPSTREAM_INVALID", "A gage data service answered in an unexpected shape", 503);
  return new ApiError("RATES_REFUSED", "The rates service quoted no LP loan for this position", 409);
}

/**
 * A signed LP quote from gage's rates service (`GET /lp/quote/:core`, `gage-lp-quote-v1`), checked before anything is
 * built on it: it must be for exactly this borrower, position, term and vault (one of the lane's), for the position's
 * range as it is on chain and no more liquidity than it holds, at the registry's fee (`feeBps`), lending something and
 * repaying no less, within the registry's loan cap (`ltvCapBps` of the value signed), and not expired; the body's terms
 * must be the quote's. Its vault is the manifest's or the lane factory's (D318). Anything else is PLAN_MISMATCH, nothing
 * prepared on it. The core checks the signature and its
 * pool's caps; a position in a pool the release does not list for its adapter is refused (POOL_NOT_ALLOWED), as the app
 * lists none there.
 */
export async function askQuote(c: Pick<Ctx, "d" | "chain" | "rates" | "now">, lane: LpLane, ask: LpAsk, registry: { feeBps: number; ltvCapBps: number }): Promise<SignedLpQuote> {
  const q = `adapter=${ask.adapter.address.toLowerCase()}&tokenId=${ask.tokenId}&borrower=${ask.borrower.toLowerCase()}&term=${ask.term}`
    + `${ask.vault ? `&vault=${ask.vault.toLowerCase()}` : ""}${ask.rolling ? `&loan=${ask.rolling.id}` : ""}`;
  const [got, facts] = await Promise.all([c.rates.raw(`/lp/quote/${lane.core.toLowerCase()}?${q}`), c.chain.lpFacts(ask.adapter.address, [ask.tokenId])]);
  if (got.status !== 200) throw quoteRefusal(got);
  const parsed = quoteSchema.safeParse(got.body);
  if (!parsed.success) throw quoteRefusal(got);
  const b = parsed.data, x = b.quote;
  const vault = await vaultIn(c, lane, x.vault);
  const quote: LoanQuote = {
    borrower: getAddress(x.borrower), vault: getAddress(x.vault), adapter: getAddress(x.adapter), tokenId: BigInt(x.tokenId), liquidity: BigInt(x.liquidity),
    tickLower: x.tickLower, tickUpper: x.tickUpper, collateralValue: BigInt(x.collateralValue), principal: BigInt(x.principal), repayment: BigInt(x.repayment),
    term: x.term, feeBps: x.feeBps, deadline: BigInt(x.deadline),
  };
  const f0 = facts[0] ?? null;
  const pool = f0 ? lpPoolOf(lane, ask.adapter.address, f0.pool) : null;
  const mismatch = () => new ApiError("PLAN_MISMATCH", "The signed quote is not the loan asked for; nothing was prepared", 409);
  if (!f0) throw new ApiError("POSITION_NOT_FOUND", "No position has this id at this position manager", 404);
  // The position's pool must be one the release lists for its adapter, as the app lists positions only there.
  if (!pool) throw new ApiError("POOL_NOT_ALLOWED", REFUSALS.POOL_NOT_ALLOWED!, 409);
  const fits = same(quote.borrower, ask.borrower) && same(quote.adapter, ask.adapter.address) && quote.tokenId === ask.tokenId && quote.term === ask.term
    && (!ask.vault || same(quote.vault, ask.vault)) && vault !== null
    && quote.tickLower === f0.tickLower && quote.tickUpper === f0.tickUpper && quote.liquidity > 0n && quote.liquidity <= f0.liquidity
    && quote.feeBps === registry.feeBps && quote.principal > 0n && quote.repayment >= quote.principal
    && [quote.liquidity, quote.collateralValue, quote.principal, quote.repayment].every((v) => v < U128) && quote.deadline < 1n << 64n
    && quote.principal * 10_000n <= quote.collateralValue * BigInt(registry.ltvCapBps)
    && BigInt(b.terms.principal) === quote.principal && BigInt(b.terms.repayment) === quote.repayment && b.terms.feeBps === quote.feeBps
    && BigInt(b.valuation.collateralValue) === quote.collateralValue && b.expiresAt <= Number(quote.deadline);
  if (!fits || !vault) throw mismatch();
  // A roll's settlement, as LPCore.roll moves it: the new principal less its fee, over the old loan's repayment.
  let roll: SignedLpQuote["roll"] = null;
  if (ask.rolling) {
    const r = b.roll, owed = ask.rolling.repayment, net = quote.principal - feeOf(quote.principal, quote.feeBps) - owed;
    if (!r || BigInt(r.loanId) !== ask.rolling.id || BigInt(r.owed) !== owed || BigInt(r.net) !== net || BigInt((await c.chain.head()).timestamp) >= BigInt(ask.rolling.end)) throw mismatch();
    roll = { owed, net };
  } else if (b.roll) throw mismatch();
  requireThat(quote.deadline > BigInt(c.now()), "PRICING_EXPIRED", "The quote expired before it was used; prepare again");
  return { quote, signature: b.signature as Hex, expiresAt: b.expiresAt, facts: f0, pool, roll, vault };
}

/** Whether a quote's cost, its repayment over its principal, is within `maxCostBps`, exactly. */
export const costWithin = (q: Pick<LoanQuote, "principal" | "repayment">, maxCostBps: number) => (q.repayment - q.principal) * 10_000n <= BigInt(maxCostBps) * q.principal;
/** The whole basis points a quote's cost rounds up to, at least one: the `maxCostBps` that takes this very quote. */
export const costCeiling = (q: Pick<LoanQuote, "principal" | "repayment">) => {
  const bps = ((q.repayment - q.principal) * 10_000n + q.principal - 1n) / q.principal;
  return Math.max(1, Number(bps));
};
/** The core's origination fee on a principal (`borrow`: rounded down) and what is credited to the borrower. */
export const feeOf = (principal: bigint, feeBps: number) => (principal * BigInt(feeBps)) / 10_000n;

/** The terms the LP registry allows, shortest first, as a refusal names them. */
export const termsText = (terms: readonly number[]) => [...terms].sort((a, b) => a - b).map(f.days).join(", ");

// ---- Reads --------------------------------------------------------------------------------------------------------

/** The lane as `capabilities()` names it: its contracts, pools and the registry's settings now. */
export async function lpCapabilities(c: Pick<Ctx, "d" | "chain">) {
  const lane = laneOf(c);
  const reg = await c.chain.lpRegistry(lane.registry);
  return {
    core: lane.core, registry: lane.registry,
    vaults: lane.vaults.map((v) => ({ address: v.address, name: v.name })),
    adapters: lane.adapters.map((a) => ({ kind: a.kind, address: a.address, positionManager: a.positionManager })),
    // A Uniswap v4 pool by its id too, and whether its ETH is native (booked as WETH, its token0).
    pools: lane.pools.map((p) => ({
      name: p.name, adapter: p.adapter, pool: p.pool, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing,
      ...(p.poolId ? { poolId: p.poolId, native: p.native } : {}),
    })),
    terms: [...reg.terms].sort((a, b) => a - b).map((t) => ({ seconds: t, days: t / 86_400 })),
    originationFeeBps: reg.feeBps, ltvCapBps: reg.ltvCapBps, newLoansPaused: reg.newLoansPaused,
  };
}

/** A pool's price, as a position's figures are read at it: `slot0`'s first two fields, or a v4 pool's from its StateView. */
type PoolPrice = { sqrtPriceX96: bigint; tick: number };

/**
 * A position's figures at its pool's price now: its amounts, whether the price is in its range and its worth in USDG;
 * each null where the price cannot be read.
 */
function figures(c: Pick<Ctx, "d">, fx: LpFacts, price: PoolPrice | null) {
  if (!price) return { inRange: null, amount0: null, amount1: null, valueUSDG: null };
  const { amount0, amount1 } = positionAmounts(price.sqrtPriceX96, fx.tickLower, fx.tickUpper, fx.liquidity);
  const value = valueInUsdg(c.d.usdg, fx.token0, fx.token1, amount0, amount1, price.sqrtPriceX96);
  return { inRange: fx.tickLower <= price.tick && price.tick < fx.tickUpper, amount0: rawStr(amount0), amount1: rawStr(amount1), valueUSDG: value === null ? null : rawStr(value) };
}

/**
 * A lane pool's price now: a v3-style pool's own `slot0` (Uniswap v3, SushiSwap v3, Ramses V3); a Uniswap v4 pool's from
 * the release's StateView by its id (`getSlot0`), never at the address the lane names it by, which holds no contract.
 * A native pool's price is ETH's, which its WETH (token0) is booked at. Null for a v4 pool where the release names no
 * StateView.
 */
export async function poolPrice(c: Pick<Ctx, "d" | "chain">, pool: Pick<LpPool, "pool" | "poolId">): Promise<PoolPrice | null> {
  if (pool.poolId === null) return c.chain.clPoolPrice(pool.pool);
  if (!c.d.stateView) return null;
  const { sqrtPriceX96, tick } = await c.chain.poolState(c.d.stateView, pool.poolId);
  return { sqrtPriceX96, tick };
}

/** What gage's index answers of a wallet's LP positions (`GET /lp/positions?owner=`): of each, only its adapter and id are taken. */
const indexedSchema = z.object({
  owner: addr.optional(),
  chainId: z.number().int().optional(),
  positions: z.array(z.object({ adapter: addr, tokenId: digits }).loose()),
  // The wallet's Fables receipts not wrapped yet: of each, only its adapter and range are taken.
  fablesReceipts: z.array(z.object({ adapter: addr, rangeId: digits }).loose()).optional(),
  incomplete: z.boolean(),
}).loose();

/** What gage's index names of a wallet's positions: their ids and its unwrapped Fables receipts' ranges, by adapter. */
export interface Indexed { ids: Map<string, bigint[]>; ranges: Map<string, bigint[]>; complete: boolean }

/**
 * The ids of the wallet's positions gage's index names (`GET /lp/positions?owner=`, docs/api.md "LP lane"), by adapter
 * (lower case), with the ranges of its Fables receipts not yet wrapped (`fablesReceipts`), and whether it named them
 * all: Uniswap v4's PositionManager and Fables' wrapper cannot list a holder's positions, so the index finds them
 * itself: v4 positions from the PoolManager's `ModifyLiquidity` logs, the wrapper's by reading every id's owner, and
 * Fables receipts from the hook's `Transfer` logs (no explorer). Only the ids and ranges are taken; each is read on chain after. An index that cannot
 * answer, answers for another wallet or chain, or says it missed some is `complete: false`.
 */
export async function indexedPositions(c: Pick<Ctx, "d" | "indexer">, wallet: Address): Promise<Indexed> {
  const ids = new Map<string, bigint[]>(), ranges = new Map<string, bigint[]>();
  const got = await c.indexer.raw(`/lp/positions?owner=${wallet.toLowerCase()}`).catch(() => null);
  const parsed = got?.status === 200 ? indexedSchema.safeParse(got.body) : null;
  if (!parsed?.success) return { ids, ranges, complete: false };
  const { owner, chainId, positions, fablesReceipts, incomplete } = parsed.data;
  if ((owner !== undefined && !same(owner, wallet)) || (chainId !== undefined && chainId !== c.d.chainId)) return { ids, ranges, complete: false };
  const add = (to: Map<string, bigint[]>, adapter: string, id: string) => to.set(adapter.toLowerCase(), [...(to.get(adapter.toLowerCase()) ?? []), BigInt(id)]);
  for (const p of positions) add(ids, p.adapter, p.tokenId);
  for (const r of fablesReceipts ?? []) add(ranges, r.adapter, r.rangeId);
  return { ids, ranges, complete: !incomplete };
}

/** A Fables range's pool as the lane names it: the low 160 bits of its key's id. */
export const fablesPoolOf = (key: PoolKey): Address => getAddress(`0x${poolId(key).slice(-40)}`);

/** Newest first: a higher id was minted later. */
const newestFirst = (a: bigint, b: bigint) => (a === b ? 0 : b > a ? 1 : -1);

/**
 * The wallet's positions in a pool the LP lane lends against (docs/api.md "LP lane", App). A v3-style position manager
 * (Uniswap v3's, SushiSwap v3's, Ramses V3's) is asked for the wallet's positions (`balanceOf`, `tokenOfOwnerByIndex`);
 * Uniswap v4's PositionManager (and Fables' position wrapper) cannot list them, so gage's index names them
 * (`indexedPositions`) and each is checked on chain to be the wallet's now (`ownerOf`). At most MAX_LP_POSITIONS of each
 * position manager, newest first, each read through its adapter (`facts`), and those in a pool the release lists for
 * that adapter kept, with their amounts and worth in USDG at the pool's price now (`poolPrice`: a v4 pool's by its id),
 * and whether the registry takes one now (its pool admitted, its range wide enough, liquidity in it). Where the index
 * cannot say it named every such position, the note says some may be missing. A position pledged to a loan sits in
 * that loan's escrow, so it is among `lpLoans`, not here.
 */
export async function lpPositions(c: Pick<Ctx, "d" | "chain" | "indexer">, wallet: Address) {
  const lane = laneOf(c);
  const unlisted = new Set<string>(), partial = new Set<string>();
  const served = lane.adapters.filter((a) => lane.pools.some((p) => same(p.adapter, a.address)));
  const indexed = served.some((a) => LP_V4_KINDS.includes(a.kind)) ? await indexedPositions(c, wallet) : null;
  /** The ids of the adapter's positions the wallet holds now, newest first, at most MAX_LP_POSITIONS. */
  const held = async (adapter: LpAdapter): Promise<bigint[]> => {
    if (LP_V4_KINDS.includes(adapter.kind)) {
      const named = [...new Set(indexed?.ids.get(adapter.address.toLowerCase()) ?? [])].sort(newestFirst);
      if (named.length > MAX_LP_POSITIONS) partial.add(adapter.kind);
      const asked = named.slice(0, MAX_LP_POSITIONS);
      const owners = asked.length ? await c.chain.positionOwners(adapter.positionManager, asked) : [];
      return asked.filter((_, n) => { const o = owners[n]; return typeof o === "string" && same(o, wallet); });
    }
    const owned = await c.chain.ownedPositions(adapter.positionManager, wallet, MAX_LP_POSITIONS);
    if (!owned.enumerable) { unlisted.add(adapter.kind); return []; }
    if (owned.total > BigInt(owned.ids.length)) partial.add(adapter.kind);
    return owned.ids;
  };
  const found = (await Promise.all(served.map(async (adapter) => {
    const ids = await held(adapter);
    const facts = await c.chain.lpFacts(adapter.address, ids);
    return ids.flatMap((tokenId, n) => {
      const fx = facts[n];
      const pool = fx ? lpPoolOf(lane, adapter.address, fx.pool) : null;
      return fx && pool ? [{ adapter, tokenId, fx, pool }] : [];
    });
  }))).flat();
  // Fables receipts not wrapped yet: each range the index names read on chain (the wallet's receipts, how many are
  // staked, its pool key), kept while the wallet holds some in a pool the lane lists for that adapter. Its receipts are
  // its liquidity, 1:1.
  const receipts = (await Promise.all(served.filter((a) => a.kind === "fables" && a.hook).map(async (adapter) => {
    const named = [...new Set(indexed?.ranges.get(adapter.address.toLowerCase()) ?? [])].slice(0, MAX_LP_POSITIONS);
    const read = await Promise.all(named.map((rangeId) => c.chain.fablesReceipts(adapter.hook!, wallet, rangeId, adapter.positionManager)));
    return named.flatMap((rangeId, n) => {
      const r = read[n]!;
      const pool = r.set && r.shares > 0n ? lpPoolOf(lane, adapter.address, fablesPoolOf(r.key)) : null;
      if (!pool) return [];
      const fx: LpFacts = { pool: pool.pool, token0: pool.token0, token1: pool.token1, tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity: r.shares };
      return [{ adapter, rangeId, staked: r.staked, fx, pool }];
    });
  }))).flat();
  const key = (x: { adapter: LpAdapter; pool: LpPool }) => `${x.adapter.address}:${x.pool.pool}`.toLowerCase();
  const pools = [...new Map([...found, ...receipts].map((x) => [key(x), x])).values()];
  const [prices, configs, refs] = await Promise.all([
    Promise.all(pools.map(async (x) => [key(x), await poolPrice(c, x.pool)] as const)).then((r) => new Map(r)),
    Promise.all(pools.map(async (x) => [key(x), await c.chain.lpPoolConfig(lane.registry, x.adapter.address, x.pool.pool)] as const)).then((r) => new Map(r)),
    tokenRefs(c, [...found, ...receipts].flatMap((x) => [x.fx.token0, x.fx.token1])),
  ]);
  /** A position's (or receipts') figures and whether the registry takes it now. */
  const assess = (x: { adapter: LpAdapter; pool: LpPool; fx: LpFacts }) => {
    const { fx } = x, cfg = configs.get(key(x))!;
    const refusal = fx.liquidity === 0n ? "EMPTY_POSITION" : !cfg.allowed ? "POOL_NOT_ALLOWED"
      : cfg.minHalfWidthTicks > 0 && fx.tickUpper - fx.tickLower < 2 * cfg.minHalfWidthTicks ? "RANGE_TOO_NARROW" : null;
    return {
      token0: refs.get(fx.token0.toLowerCase())!, token1: refs.get(fx.token1.toLowerCase())!, tickLower: fx.tickLower, tickUpper: fx.tickUpper,
      ...figures(c, fx, prices.get(key(x)) ?? null), borrowable: refusal === null, refusal,
    };
  };
  const positions = found.map((x) => ({
    adapter: x.adapter.address, kind: x.adapter.kind, positionManager: x.adapter.positionManager, tokenId: rawStr(x.tokenId), pool: x.pool.pool, poolName: x.pool.name,
    liquidity: rawStr(x.fx.liquidity), ...assess(x),
  }));
  const fablesReceipts = receipts.map((x) => ({
    adapter: x.adapter.address, kind: x.adapter.kind, hook: x.adapter.hook, rangeId: rawStr(x.rangeId), pool: x.pool.pool, poolName: x.pool.name,
    shares: rawStr(x.fx.liquidity), staked: rawStr(x.staked), ...assess(x),
  }));
  return {
    wallet, positions,
    ...(receipts.length ? { fablesReceipts } : {}),
    note: [
      "Positions this wallet holds in a pool gage's LP lane lends against, each adapter's newest first; amounts are raw (each token its own decimals) at the pool's price now, uncollected fees left out. gage_lp_quote prices a loan against one; a position pledged to a loan is in gage_lp_loans.",
      ...(receipts.length ? ["fablesReceipts are Fables LP receipts not wrapped yet (shares are their liquidity; staked ones earn Fables' emissions): lp_borrow with { adapter, rangeId } wraps them into a position, unstaking any staked first, then borrows against it; lp_wrap only wraps them."] : []),
      ...(partial.size ? [`Only the newest ${MAX_LP_POSITIONS} positions of each position manager were read (${[...partial].join(", ")}).`] : []),
      ...(unlisted.size ? [`A position manager could not list this wallet's positions (${[...unlisted].join(", ")}): quote one by its id.`] : []),
      ...(indexed && !indexed.complete ? ["Some of this wallet's Uniswap v4 positions may be missing: gage's index could not list them all now. Quote one by its id, or ask again shortly."] : []),
    ].join(" "),
  };
}

/**
 * A fixed-cost USDG loan against one position, from gage's rates service, checked (`askQuote`) and re-shaped as a
 * borrow quote is: what is pledged, what the wallet receives and repays, its cost and loan-to-value, and a `prepare`
 * object for lp_borrow, without its action, whose `maxCostBps` takes this very quote.
 */
export async function lpQuote(c: Pick<Ctx, "d" | "chain" | "rates" | "now">, i: { adapter: string; tokenId: string; wallet: string; term: number; vault?: string | undefined }) {
  const lane = laneOf(c), adapter = adapterOf(lane, i.adapter), vault = i.vault ? await vaultOf(c, lane, i.vault) : null, borrower = i.wallet as Address;
  const reg = await c.chain.lpRegistry(lane.registry);
  requireThat(!reg.newLoansPaused, "LOANS_PAUSED", REFUSALS.LOANS_PAUSED!);
  requireThat(reg.terms.includes(i.term), "TERM_NOT_ALLOWED", `Allowed terms: ${termsText(reg.terms)}`);
  const s = await askQuote(c, lane, { adapter, tokenId: BigInt(i.tokenId), borrower, term: i.term, vault: vault?.address ?? null }, reg);
  const q = s.quote, fee = feeOf(q.principal, q.feeBps), payout = q.principal - fee;
  return {
    summary: `Pledge position #${i.tokenId} (${s.pool.name}), receive ${f.usdg(payout)}, repay ${f.owed(q.repayment)} within ${f.days(i.term)}`,
    position: { adapter: adapter.address, kind: adapter.kind, tokenId: i.tokenId, pool: s.pool.pool, poolName: s.pool.name, tickLower: s.facts.tickLower, tickUpper: s.facts.tickUpper, liquidity: rawStr(s.facts.liquidity) },
    collateralValueUSDG: rawStr(q.collateralValue), principal: rawStr(q.principal), receive: rawStr(payout), originationFee: rawStr(fee), feeBps: q.feeBps,
    repay: rawStr(q.repayment), costBps: lpCostBps(q.principal, q.repayment), ltvBps: q.collateralValue > 0n ? Number((q.principal * 10_000n) / q.collateralValue) : null,
    term: i.term, vault: q.vault, vaultName: s.vault.name, expiresAt: s.expiresAt,
    prepare: { action: "lp_borrow", adapter: adapter.address, tokenId: i.tokenId, term: i.term, maxCostBps: costCeiling(q), ...(vault ? { vault: vault.address } : {}) },
    note: [
      "Signed for this wallet for five minutes at most. gage_prepare_lp_borrow asks for it again when it is sent if it has run out, and refuses above maxCostBps. There is no liquidation: the loan is never closed early because a price moves; if it is not repaid by its end, the position goes to the lenders and nothing else is taken.",
      ...positionNotes(adapter.kind, s.pool),
    ].join(" "),
  };
}

/** An LP loan as the reads answer it, what can be done with it now (here, or on the app), and its position now. */
function loanRow(c: Pick<Ctx, "d"> & { chainNow: number }, lane: LpLane, l: LpLoan, served: readonly ActionName[], position: ReturnType<typeof figures> | null, vaults: readonly LaneVault[]) {
  const host = new URL(defaultsFor(c.d.chainId).appUrl).host;
  const way = (action: ActionName, who: string) => (served.includes(action) ? `${action} (${who})` : `${action} on ${host} (${who})`);
  const running = l.state === 1 && c.chainNow < l.end;
  return {
    loanId: rawStr(l.id), state: lpStateName(l.state), borrower: l.borrower, vault: l.vault, vaultName: vaults.find((v) => same(v.address, l.vault))?.name ?? null,
    ...positionRef(lane, l.adapter, l.pool, l.tokenId), principal: rawStr(l.principal), repay: rawStr(l.repayment), costBps: lpCostBps(l.principal, l.repayment),
    start: l.start, endsAt: l.end, term: l.end - l.start, positionReturned: l.positionReturned,
    actions: running ? [way("lp_repay", "borrower, before endsAt"), way("lp_roll", "borrower, before endsAt"), way("lp_collect", "borrower, before endsAt")]
      : l.state === 2 && !l.positionReturned ? [way("lp_return_position", "borrower")] : [],
    position,
  };
}

/** Each loan's position now, for the loans whose position still waits in its escrow (running, or repaid and not taken back). */
async function positionsNow(c: Pick<Ctx, "d" | "chain">, lane: LpLane, loans: readonly LpLoan[]) {
  const held = loans.filter((l) => l.state === 1 || (l.state === 2 && !l.positionReturned));
  const facts = await Promise.all(held.map(async (l) => (await c.chain.lpFacts(l.adapter, [l.tokenId]))[0] ?? null));
  // Each pool's price once: a listed pool's as `poolPrice` reads it (a v4 pool's by its id), an unlisted v3-style pool's
  // slot0; an unlisted v4 pool's address holds no contract, so it has none.
  const key = (l: LpLoan) => `${l.adapter}:${l.pool}`.toLowerCase();
  const priceOf = async (l: LpLoan): Promise<PoolPrice | null> => {
    const listed = lpPoolOf(lane, l.adapter, l.pool);
    if (listed) return poolPrice(c, listed);
    const kind = lpAdapterOf(lane, l.adapter)?.kind;
    return kind && LP_V4_KINDS.includes(kind) ? null : c.chain.clPoolPrice(l.pool);
  };
  const prices = new Map(await Promise.all([...new Map(held.map((l) => [key(l), l])).values()].map(async (l) => [key(l), await priceOf(l)] as const)));
  return new Map(held.map((l, n) => {
    const fx = facts[n], price = prices.get(key(l));
    return [rawStr(l.id), fx && price ? figures(c, fx, price) : null] as const;
  }));
}

/** A wallet's LP loans, newest first, and its credits on the lane's core (USDG from a loan, fees, rewards), each token apart. */
export async function lpLoans(c: Pick<Ctx, "d" | "chain" | "now">, wallet: Address, served: readonly ActionName[]) {
  const lane = laneOf(c);
  const [{ loans, complete }, credits, vaults] = await Promise.all([scanLoans(c, lane), walletCredits(c, lane, wallet), laneVaults(c, lane)]);
  const own = loans.filter((l) => same(l.borrower, wallet));
  const [now, head] = await Promise.all([positionsNow(c, lane, own), c.chain.head()]);
  return {
    wallet, loans: own.map((l) => loanRow({ d: c.d, chainNow: head.timestamp }, lane, l, served, now.get(rawStr(l.id)) ?? null, vaults)),
    credits: credits.map((x) => ({ ...x, amount: rawStr(x.amount) })),
    note: [
      "LP loans this wallet borrowed, newest first, in raw USDG (6 decimals); a running loan's position is valued at its pool's price now. credits are what the lane's core holds for the wallet: lp_withdraw takes them.",
      ...(complete ? [] : [`Only the newest ${MAX_LP_LOANS} loans of the lane were read.`]),
    ].join(" "),
  };
}

/**
 * The LP part of a wallet's portfolio: its loans and credits (`lpLoans`), and each LP vault it holds shares of or may
 * claim a bonus from: its shares (`balanceOf`: an ERC-20 since D319, so shares it received by transfer count), what
 * they redeem for now, and each defaulted loan's bonus it may claim, past lenders included (`bonusClaimable`).
 */
export async function lpHoldings(c: Pick<Ctx, "d" | "chain" | "now">, wallet: Address, served: readonly ActionName[]) {
  const lane = laneOf(c);
  const [{ loans, complete }, credits, lane_] = await Promise.all([scanLoans(c, lane), walletCredits(c, lane, wallet), laneVaults(c, lane)]);
  const own = loans.filter((l) => same(l.borrower, wallet));
  const [now, head] = await Promise.all([positionsNow(c, lane, own), c.chain.head()]);
  const vaults = (await Promise.all(lane_.map(async (v) => {
    // A bonus arrives from a defaulted loan's sales; an abandoned loan's, once its position is recovered (gage's index asks both).
    const defaulted = loans.filter((l) => (l.state === 3 || l.state === 4) && same(l.vault, v.address));
    const [shares, bonuses] = await Promise.all([c.chain.lpShares(v.address, wallet), c.chain.lpBonuses(v.address, defaulted.map((l) => l.id), wallet)]);
    // D454: a reserve vault's sGAGE, which stays the wallet's once its shares are gone, and its worth, null while its
    // reserve's conversion fails (its previews then revert, where an LPVault's never do).
    const companion = await c.chain.lpCompanion(v.address);
    const sgage = companion ? await c.chain.lpRewardClaimable(companion, wallet).catch(() => null) : null;
    const value = shares > 0n ? await c.chain.lpPreviewRedeem(v.address, shares).catch((e: unknown) => { if (companion) return null; throw e; }) : 0n;
    const claimable = defaulted.flatMap((l, n) => (bonuses[n]! > 0n ? [{ loanId: rawStr(l.id), claimable: rawStr(bonuses[n]!) }] : []));
    return shares > 0n || claimable.length || (sgage ?? 0n) > 0n ? [{
      vault: v.address, name: v.name, shares: rawStr(shares), shareDecimals: (await lpShareUnit(c.chain, v.address)).decimals, valueUSDG: orNull(value), bonuses: claimable,
      ...(companion ? { sgageClaimable: orNull(sgage) } : {}),
    }] : [];
  }))).flat();
  return {
    loans: own.map((l) => loanRow({ d: c.d, chainNow: head.timestamp }, lane, l, served, now.get(rawStr(l.id)) ?? null, lane_)),
    credits: credits.map((x) => ({ ...x, amount: rawStr(x.amount) })),
    vaults, complete,
  };
}

/**
 * An LP vault's mandate (D318) in plain words: the pools it funds new loans in now, and those a curator added that fund
 * from a later time (three hours after they were added).
 */
export function mandateWords(lane: LpLane, mandate: readonly LpMandatePool[] | null, now: number): string {
  if (mandate === null) return "It names no mandate: it funds loans in any pool the lane lists.";
  const name = (p: LpMandatePool) => lpPoolOf(lane, p.adapter, p.pool)?.name ?? `the pool ${p.pool} (not one the release lists)`;
  const live = mandate.filter((p) => p.activeAt !== 0 && p.activeAt <= now), later = mandate.filter((p) => p.activeAt > now);
  const list = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "");
  return [
    live.length ? `It funds new loans against positions in ${list(live.map(name))}.` : "It funds no pool now.",
    ...later.map((p) => `It funds ${name(p)} from ${new Date(p.activeAt * 1000).toISOString()}.`),
  ].join(" ");
}

/** A reserve vault's companion as `lpVaults` answers it (docs/api.md "LP lane", Reserve vaults): raw amounts, null where a read failed. */
const reserveRow = (r: LpReserveState) => ({
  companion: r.companion, token: r.token, shares: orNull(r.shares), value: orNull(r.value), payable: orNull(r.payable), freeLiquidity: orNull(r.freeLiquidity),
  bufferBps: r.bufferBps, minCostBpsPerYear: r.minCostBpsPerYear, closed: r.closed, rewardsAccounted: orNull(r.rewardsAccounted),
});
/** What `lpVaults` says of every vault. */
const LP_VAULTS_NOTE = "Raw USDG (6 decimals). Each vault is an ERC-4626 whose shares are an ERC-20 (gLP) that moves between wallets, counted in the vault's own shareDecimals (18, or 12 for a vault opened before 24 October 2026): usdgPerShare is what one whole share (10^shareDecimals raw, one USDG's worth when the vault opened) redeems for now, and a bonus belongs to whichever wallet held the shares while its loan ran. A vault funds loans only in the pools of its mandate (funds says which, and from when: a pool its curator adds funds three hours later); factory vaults were opened by a curator the registry allows (curator). A vault is impaired while a loan past its end is not settled or tokens a defaulted position delivered wait to be sold: it then takes no deposit and pays nothing out. Its deposits close while value it wrote off may still come back. Only the vaults the registry still allows are listed, however many curators opened: one it removed takes no new loans, its open ones running to their ends, and a wallet holding its shares finds it in its portfolio and redeems with lp_redeem. lp_deposit and lp_redeem act on one; its curator changes its pools with lp_vault_add_pool and lp_vault_remove_pool.";
/** What `lpVaults` says of its reserve vaults, where it lists one. */
const RESERVE_NOTE = "A reserve vault (one with a reserve here) keeps its cash past its curator's buffer in an outside ERC-4626 (reserve.token), counted in its assets, and draws on it for loans and withdrawals: freeCashUSDG is its cash alone, reserve.value what its reserve shares are worth, reserve.payable what the reserve can pay of them now, and reserve.freeLiquidity what the vault can pay out now, cash and reserve. Those are null, as totalAssetsUSDG and usdgPerShare may be, while the reserve cannot be read; it then takes no deposit and pays nothing out. reserve.minCostBpsPerYear is the least a loan must cost it, a year at its rate. Its holders also share sGAGE from its loans, outside the share price: gage_portfolio's lp.vaults says what a wallet may claim (sgageClaimable, raw, 18 decimals), and lp_claim_rewards claims it. What the reserve returns moves, and carries that reserve's own risk.";

/**
 * The LP vaults that may lend, the manifest's and those curators opened through the lane's factory (D318), every one the
 * registry allows (D319: one it removed is not listed; a wallet holding its shares finds it in its portfolio): their
 * size, free cash, loans out, share value, fee and switches now, raw USDG; each one's curator and its mandate (the pools
 * it funds, each from when, said in `funds`); a reserve vault's liquidity, reserve and least cost (D454, `reserve`, left
 * out for an LPVault, whose row stays as it was). A reserve vault whose reserve cannot be read stays listed, its figures
 * null; no other vault's read waits on it.
 */
export async function lpVaults(c: Pick<Ctx, "d" | "chain" | "now">) {
  const lane = laneOf(c), vaults = await lendingVaults(c, lane), now = c.now();
  const rows = await Promise.all(vaults.map(async (v) => {
    const [st, share] = await Promise.all([c.chain.lpVault(v.address), lpShareUnit(c.chain, v.address)]);
    // A reserve vault's previews and totalAssets revert while its reserve's conversion fails; an LPVault's never do.
    const perShare = await c.chain.lpPreviewRedeem(v.address, share.one).catch((e: unknown) => { if (st.reserve) return null; throw e; });
    const priced = st.totalAssets !== null;
    // Every vault listed is one the registry allows (`allowed`, kept for the answer's shape).
    return {
      vault: v.address, name: v.name, factory: v.factory, curator: st.curator, allowed: true,
      takesDeposits: !st.impaired && !st.depositsClosed && priced, paysOut: !st.impaired && priced, lends: !st.impaired && !st.fundingPaused,
      mandate: st.mandate?.map((p) => ({
        adapter: p.adapter, pool: p.pool, poolName: lpPoolOf(lane, p.adapter, p.pool)?.name ?? null, activeAt: p.activeAt, funding: p.activeAt !== 0 && p.activeAt <= now,
      })) ?? null,
      funds: mandateWords(lane, st.mandate, now),
      totalAssetsUSDG: orNull(st.totalAssets), freeCashUSDG: rawStr(st.freeCash), outstandingPrincipalUSDG: rawStr(st.outstandingPrincipal), totalShares: rawStr(st.totalShares),
      shareDecimals: share.decimals, usdgPerShare: orNull(perShare),
      performanceFeeBps: st.performanceFeeBps, maxLoanPrincipalUSDG: rawStr(st.maxLoanPrincipal), openLoans: st.openLoans, bonusHeldUSDG: rawStr(st.bonusHeld),
      impaired: st.impaired, depositsClosed: st.depositsClosed, fundingPaused: st.fundingPaused,
      ...(st.reserve ? { reserve: reserveRow(st.reserve) } : {}),
    };
  }));
  return {
    vaults: rows,
    note: `${LP_VAULTS_NOTE}${rows.some((r) => "reserve" in r) ? ` ${RESERVE_NOTE}` : ""}`,
  };
}
