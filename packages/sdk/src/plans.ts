/**
 * Each action as what is left to send from the wallet's current state: the approvals it still needs (exact amounts,
 * never unlimited), then the call. Re-planning after each transaction is how both an agent and a review link advance,
 * so every plan reads the chain fresh and nothing is remembered between calls. Every figure and word of a summary is
 * computed here from the chain and gage's own services; nothing an agent wrote is ever shown (D222).
 */
import { encodeFunctionData, erc20Abi, getAddress, parseEventLogs, zeroHash, type Address, type Hex, type Log } from "viem";
import { cashoutRouterAbi, engineAbi, loopRouterAbi, partnerVaultAbi, reputationAbi, rewardsAbi, rolloverRouterAbi } from "./abi.js";
import { askCashoutSale, directRoutes, ROUTE_MARGIN_BPS, routeNet, type CashoutSale, type CashoutWant } from "./cashout.js";
import type { Chain, TickSource, VaultBook } from "./chain.js";
import { accounting, allPartnerVaults, claimablePockets, holding, loanRecord, partnerVaults, previewAnswer, vaultName, walletLoans, type PartnerVault } from "./data.js";
import { assetOf, engineOf, lendAssetOf, lendsMore, rolloverRouterOf, type Asset, type Deployment, type Engine, type Generation, type LendAsset, type LoopPool } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import { boundUnder, chooseSource, firstRunnable, fitsCap, loopSpendable, loopCall, loopCap, loopPayout, parseLoopBuy, rankLoopQuotes, type LoopBase, type LoopQuote } from "./loopSources.js";
import { LOOP_SLIPPAGE_BPS, poolId, quoteExactOut, swapFeePips, type TickReader } from "./v4math.js";
import * as f from "./format.js";
import { defaultsFor, offeredTerms } from "./networks.js";
import { allocate, instant, loopPlan, preview, rollFigures, rollPlan, type Terms } from "./intent.js";
import type { ActionInput } from "./schemas.js";
import type { Upstream } from "./upstream.js";

export interface Ctx {
  d: Deployment; chain: Chain; indexer: Upstream; rates: Upstream; now: () => number;
  /**
   * gage's valuation service, where leverage asks an aggregator's route for its purchase (D243): KyberSwap's, or on the
   * testnet gage's stand-in for its router (D245); without it, pools only.
   */
  valuation?: Upstream;
}
export interface Row { label: string; value: string }
export interface Summary { title: string; rows: Row[] }
export interface Tx { to: Address; data: Hex; value: bigint }
/**
 * One transaction still to send. `final`: the action itself, sent once (a listing, a loop, a deposit, a redemption).
 * `extraGas`: gas added to the estimate, for a call whose estimate runs short (a vault's settle books each loan).
 */
export interface Step { label: string; kind: "approve" | "action"; final: boolean; build: () => Promise<Tx>; extraGas?: bigint }
/** A token as the review page draws it: its logo by address, its amounts in its own decimals. */
export interface TokenRef { token: Address; symbol: string; decimals: number }
/**
 * The asset a view's loan or vault amounts are in (D251), and for a loan the core it is on: added once the release makes
 * a lend asset public, USDG's on the USDG generation; absent before, so every view reads as it did.
 */
export interface InAsset { asset?: TokenRef; engine?: Address }
/**
 * The figures the review page draws each action from (D222), raw amounts as decimal strings. The page keeps its own
 * words, as every page of the app does; an agent reads `summary`.
 */
export type View =
  | ({ action: "borrow" } & TokenRef & InAsset & { collateral: string; principal: string; fee: string; cap: string; term: number; feeBps: number; valueUSDG: string | null; fundsNow: boolean; listingEnds: number })
  | ({ action: "leverage" } & TokenRef & {
    own: string; buy: string; multiple: number; principal: string; fee: string; cap: string; term: number; feeBps: number; costBps: number; maxCostBps: number;
    maxCost: string; ownValueUSDG: string; cashUSDG: string;
  })
  | ({ action: "cancel" } & TokenRef & { loanId: string; collateral: string })
  | ({ action: "reclaim" } & TokenRef & InAsset & { loanId: string; collateral: string; cap: string; endsAt: number })
  | ({ action: "cash_out" } & TokenRef & InAsset & {
    loanId: string; collateral: string; cap: string; gross: string; financeFee: string; fee: string; net: string; minimumNet: string; source: string | null;
  })
  | ({ action: "roll" } & TokenRef & InAsset & {
    loanId: string; collateral: string; oldPrincipal: string; oldCap: string; endsAt: number;
    principal: string; cap: string; term: number; fee: string; feeBps: number; payout: string; topUp: string; surplus: string;
  })
  | ({ action: "auto_roll" } & TokenRef & InAsset & {
    loanId: string; principal: string; term: number; maxCost: string; maxTopUp: string; rolls: number; window: number; until: number; allowance: string; executor: Address;
  })
  | ({ action: "cancel_auto_roll" } & TokenRef & { loanId: string; rollsLeft: number })
  | ({ action: "earn_deposit"; vault: Address; name: string; amount: string; minShares: string; feeBps: number } & InAsset)
  | ({ action: "earn_redeem"; vault: Address; name: string; shares: string; assets: string; minAssets: string; all: boolean } & InAsset)
  | {
    action: "collect"; usdg: string; collateral: (TokenRef & { amount: string })[]; earnings: string; sgage: string;
    /** Each lend asset's cash from loans and vault earnings, beside USDG's and never added to them (D251). */
    others?: (TokenRef & { cash: string; earnings: string })[];
  }
  /** A rating of gage (D302): its ERC-8004 agent id, the Reputation Registry it goes to and the score, 0 to 100. */
  | { action: "feedback"; agentId: number; registry: Address; score: number };
/** The loan an action opened, read from its own receipt: a listing's id, a loop's, a roll's new loan. */
export interface Made { engine: Address; loanId: string }
export interface Plan {
  summary: Summary; view: View; steps: Step[]; notes: string[];
  /** For an action that opens a loan: its id from the final step's logs, or null when they name none for this wallet. */
  made?: (logs: readonly Log[]) => Made | null;
  /** The steps come first, then the action is planned again from the chain: a vault's settle before a deposit. */
  again?: true;
}
/** The first log of `abi`'s `eventName` that `address` emitted and `match` accepts, among a receipt's logs. */
function eventOf<const A extends readonly unknown[]>(abi: A, eventName: string, address: Address, logs: readonly Log[], match: (args: Record<string, unknown>) => boolean) {
  const own = logs.filter((l) => same(l.address, address));
  const parsed = parseEventLogs({ abi: abi as never, eventName, logs: own }) as unknown as { args: Record<string, unknown> }[];
  return parsed.find((l) => match(l.args))?.args ?? null;
}

/** Listings stay open to the partner vaults for a day, as the borrow card's (BorrowView `list`). */
const LISTING_SECONDS = 86_400;
const MAX_CLAIM_POCKETS = 64;
/** The most claims one collect plans: what one review asks the wallet to confirm, and the simulations one prepare spends. */
const MAX_COLLECT_CLAIMS = 20;
/** sGAGE under a millionth of one is not worth a transaction, and a bridged loan's last raw units can wait on rounding for good. */
const SGAGE_DUST = 10n ** 12n;
const NO_LIQUIDATION = (what: string) => `The lenders keep the ${what}. Nothing else is taken, and the loan is never closed early.`;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tx = (to: Address, data: Hex): Tx => ({ to, data, value: 0n });
const call = (label: string, to: Address, data: Hex, final = false): Step => ({ label, kind: "action", final, build: () => Promise.resolve(tx(to, data)) });

async function approval(c: Ctx, token: Address, symbol: string, wallet: Address, spender: Address, amount: bigint): Promise<Step[]> {
  if (amount === 0n || await c.chain.allowance(token, wallet, spender) >= amount) return [];
  return [{ label: `Approve ${symbol}`, kind: "approve", final: false, build: () => Promise.resolve(tx(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }))) }];
}
function asset(c: Ctx, token: string): Asset {
  const a = assetOf(c.d, token);
  requireThat(a, "UNSUPPORTED_COLLATERAL", "gage does not take this token as collateral");
  return a;
}
/** A loan's collateral as the page draws it; a token the manifest no longer lists keeps its address. */
const tokenRef = (c: Ctx, token: Address): TokenRef => {
  const a = assetOf(c.d, token);
  return { token, symbol: a?.symbol ?? "tokens", decimals: a?.decimals ?? 18 };
};
/**
 * The same for a loan of any generation: a token a lend-asset generation names outside the release's asset list (D249)
 * by the symbol the release gives it and the decimals the token says.
 */
async function collateralRef(c: Ctx, token: Address): Promise<TokenRef> {
  if (assetOf(c.d, token)) return tokenRef(c, token);
  const named = c.d.generations.flatMap((g) => g.collateral).find((x) => same(x.token, token));
  if (!named) return tokenRef(c, token);
  try { return { token, symbol: named.symbol, decimals: (await c.chain.tokenInfo(named.token)).decimals }; } catch { return tokenRef(c, token); }
}
export const refOf = (a: LendAsset): TokenRef => ({ token: a.token, symbol: a.symbol, decimals: a.decimals });
/** The asset fields a view adds once the release makes a lend asset public (D251); none before, so it reads as it did. */
const inAsset = (c: Ctx, a: LendAsset, engine?: Address): InAsset => (lendsMore(c.d) ? { asset: refOf(a), ...(engine ? { engine } : {}) } : {});
/** What repaying in a stock lend asset means, said once beside the loan (D251). */
const REPAY_IN = (a: LendAsset) => `You repay in ${a.symbol}. In dollars, what you repay moves with ${a.symbol}'s price.`;

/**
 * The generation a loan is borrowed from (D251): USDG's when `lendAsset` is omitted or names USDG, else the public
 * generation lending that asset; refused when none does, never read as USDG.
 */
export function generationFor(c: Ctx, lendAsset?: string): Generation {
  const usdg = c.d.generations[0]!;
  if (!lendAsset || same(lendAsset, usdg.lendAsset.token)) return usdg;
  const g = c.d.generations.find((x) => same(x.lendAsset.token, lendAsset));
  requireThat(g, "UNKNOWN_LEND_ASSET", "gage lends no such asset now; gage_capabilities lists the ones it lends", 400);
  return g;
}
/**
 * A token a generation lends against: the release's asset list for USDG's; a lend-asset generation's own list (D249),
 * its decimals read from the token where the release does not list it.
 */
export async function collateralOf(c: Ctx, g: Generation, token: string): Promise<Asset> {
  if (g.primary) return asset(c, token);
  const named = g.collateral.find((x) => same(x.token, token));
  requireThat(named, "UNSUPPORTED_COLLATERAL", `gage does not lend ${g.lendAsset.symbol} against this token`);
  const listed = assetOf(c.d, named.token);
  if (listed) return listed;
  const { decimals } = await c.chain.tokenInfo(named.token);
  return { token: named.token, symbol: named.symbol, name: named.symbol, decimals, lane: "MEME" };
}
/** Before any write (Intent D55): the core still pays and is repaid in the asset the plan counts in. */
async function sameCoreAsset(c: Ctx, core: Address, a: LendAsset) {
  requireThat(same(await c.chain.coreAsset(core), a.token), "ASSET_CHANGED", `This core is not paid in ${a.symbol}; read it again before acting`);
}
/** Leverage lends USDG only (D251): a loop in a lend asset is refused in fixed words. */
export function usdgOnly(c: Ctx, lendAsset?: string) {
  requireThat(!lendAsset || same(lendAsset, c.d.usdg), "LEVERAGE_CLOSED", "Leverage lends USDG only; borrow in another asset with gage_prepare_borrow");
}
/** What the pledge is worth now: the rates service's instant answer for it, scaled to the pledge; null without one. */
async function pledgeValue(c: Ctx, core: Address, token: Address, collateral: bigint, term: number, wallet: Address): Promise<bigint | null> {
  try {
    const q = await instant(c.rates, core, token, collateral, term, wallet);
    return q.collateral > 0n ? (q.valueUSDG * collateral) / q.collateral : null;
  } catch { return null; }
}
const costBps = (principal: bigint, cap: bigint) => Number(((cap - principal) * 10_000n) / principal);

/** The terms a registry allows that gage offers on this chain (`offeredTerms`): mainnet's 7 and 21 days. */
export const termsOf = async (c: Ctx, registry: Address) => offeredTerms(c.d.chainId, await c.chain.terms(registry));
/** A pledge under the token's minimum, refused with the minimum in words (rounded up) and in raw units. */
export function aboveMinimum(a: Pick<Asset, "token" | "symbol" | "decimals">, collateral: bigint, minimum: bigint) {
  requireThat(collateral >= minimum, "COLLATERAL_BELOW_MINIMUM", `The least ${a.symbol} one loan takes is ${f.tokenUp(minimum, a.decimals, a.symbol)}`, 409,
    { minimum: { token: a.token, symbol: a.symbol, decimals: a.decimals, raw: minimum.toString() } });
}

/** The core's listing rules for these terms, as `GageV2Vault._list` checks them, on the generation's own registry. */
async function listable(c: Ctx, g: Generation, a: Asset, collateral: bigint, principal: bigint, cap: bigint, term: number) {
  const reg = g.core.registry;
  const [cfg, terms, paused, feeBps] = await Promise.all([c.chain.tokenConfig(reg, a.token), termsOf(c, reg), c.chain.paused(reg), c.chain.feeBps(reg)]);
  requireThat(!paused, "LISTINGS_PAUSED", "New loans are paused");
  requireThat(cfg.allowed, "UNSUPPORTED_COLLATERAL", "gage does not take this token as collateral now");
  requireThat(terms.includes(term), "TERM_NOT_ALLOWED", `Allowed terms: ${terms.map(f.days).join(", ")}`);
  requireThat(principal >= 4n && cap > principal, "INVALID_TERMS", "The repayment must be above the amount borrowed");
  aboveMinimum(a, collateral, cfg.minAmount);
  requireThat(cfg.maxDealRaw === 0n || collateral <= cfg.maxDealRaw, "COLLATERAL_ABOVE_MAXIMUM", `The most ${a.symbol} one loan takes is ${f.token(cfg.maxDealRaw, a.decimals, a.symbol)}`);
  return { feeBps };
}

async function borrow(c: Ctx, i: Extract<ActionInput, { action: "borrow" }>): Promise<Plan> {
  // The generation the loan is borrowed from (D251): its core lists it, its registry admits it, its asset pays it out.
  const wallet = i.wallet as Address, g = generationFor(c, i.lendAsset), cash = g.lendAsset, core = g.core.engine;
  const a = await collateralOf(c, g, i.token);
  const collateral = BigInt(i.collateral), principal = BigInt(i.principal), cap = BigInt(i.cap);
  const { feeBps } = await listable(c, g, a, collateral, principal, cap, i.term);
  requireThat(await c.chain.balance(a.token, wallet) >= collateral, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.token(collateral, a.decimals, a.symbol)}`);
  await sameCoreAsset(c, core, cash);
  const terms: Terms = { token: a.token, collateral, principal, cap, term: i.term };
  // The pledge's worth in USDG draws the review page's curve: a loan in another asset draws none, so asks none.
  const [funded, value] = await Promise.all([preview(c.rates, core, terms, wallet), g.primary ? pledgeValue(c, core, a.token, collateral, i.term, wallet) : null]);
  const fee = (principal * BigInt(feeBps)) / 10_000n, what = f.token(collateral, a.decimals, a.symbol);
  const deadline = c.now() + LISTING_SECONDS;
  return {
    view: {
      action: "borrow", token: a.token, symbol: a.symbol, decimals: a.decimals, collateral: i.collateral, principal: i.principal, fee: fee.toString(), cap: i.cap,
      term: i.term, feeBps, valueUSDG: value?.toString() ?? null, fundsNow: funded.fills, listingEnds: deadline, ...inAsset(c, cash, core),
    },
    summary: {
      title: `Borrow ${f.money(principal, cash)} against ${what}`,
      rows: [
        { label: "You pledge", value: what },
        { label: "You receive", value: `${f.money(principal - fee, cash)} after the ${f.bps(feeBps)} fee` },
        { label: `You repay within ${f.days(i.term)} of funding`, value: f.owedIn(cap, cash) },
        { label: "Loan cost", value: f.bps(costBps(principal, cap)) },
        { label: "If you don't repay", value: NO_LIQUIDATION(what) },
      ],
    },
    steps: [
      ...await approval(c, a.token, a.symbol, wallet, core, collateral),
      call("Borrow", core, encodeFunctionData({ abi: engineAbi, functionName: "list", args: [{ kind: 0, token: a.token, amountOrTokenId: collateral }, principal, cap, i.term, deadline, false] }), true),
    ],
    made: (logs) => {
      const listed = eventOf(engineAbi, "Listed", core, logs, (x) => same(String(x.borrower), wallet));
      return listed ? { engine: core, loanId: String(listed.id) } : null;
    },
    notes: [
      `The partner vaults fund the listing; it stays open for them until ${f.date(deadline)}, then the collateral can be taken back.`,
      ...(funded.fills ? [] : ["The partner vaults would not fund all of this loan right now: it may stay unfunded. gage_borrow_quote gives terms they fund."]),
      ...(cash.stable ? [] : [REPAY_IN(cash)]),
    ],
  };
}

/** A pool's initialized ticks, read from the chain as the purchase's swap reaches them. */
const tickReader = (c: Ctx, source: TickSource): TickReader => ({
  bitmap: (word) => c.chain.tickBitmap(source, word),
  liquidityNet: (tick) => c.chain.tickLiquidityNet(source, tick),
});

/**
 * What buying exactly `buy` of `a` costs through one pool now, as its own exact-output swap would charge it: from the
 * active range and across every initialized tick the swap reaches (`quoteExactOut`); null where it cannot sell that much.
 * A V3 pool (D242) sorts its tokens by address and prices as a v4 pool does, its fee tier all the swapper pays; one
 * whose fee is not the manifest's is not the pool the router would find.
 */
async function poolQuote(c: Ctx, a: Asset, p: LoopPool, buy: bigint): Promise<LoopQuote | null> {
  if (p.kind === "v4") {
    if (!c.d.stateView) return null;
    const usdgIsZero = same(p.key.currency1, a.token), id = poolId(p.key);
    const s = await c.chain.poolState(c.d.stateView, id);
    const pool = { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: s.liquidity, feePips: swapFeePips(s.lpFee, s.protocolFee, usdgIsZero), tickSpacing: p.key.tickSpacing };
    const cost = await quoteExactOut(pool, buy, usdgIsZero, tickReader(c, { kind: "v4", stateView: c.d.stateView, poolId: id }));
    return cost === null ? null : { kind: "v4", key: p.key, cost };
  }
  const s = await c.chain.v3PoolState(p.pool);
  if (s.fee !== p.fee) return null;
  const usdgIsZero = BigInt(c.d.usdg) < BigInt(a.token);
  const pool = { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: s.liquidity, feePips: BigInt(s.fee), tickSpacing: s.tickSpacing };
  const cost = await quoteExactOut(pool, buy, usdgIsZero, tickReader(c, { kind: "v3", pool: p.pool }));
  return cost === null ? null : { kind: "v3", pool: p.pool, fee: p.fee, cost };
}

/**
 * What KyberSwap's route is asked for with (docs/api.md, `GET /quote/loop-buy`): `hint`, a spend to keep while it still
 * buys the whole purchase, such as the route quoted when the loop was planned; `room`, the USDG already approved for it.
 */
interface ViaAsk { hint?: bigint | undefined; room?: bigint | undefined }

/**
 * KyberSwap's route for the purchase, from gage's valuation service when one is configured (D243); on the testnet, from
 * r7, the route of gage's stand-in for KyberSwap's router (D245). Null when no service is configured, when it does not
 * answer a route (a testnet generation without the stand-in), or when the router does not admit the route's executor:
 * whichever aggregator answered, the router's `executorAllowed` decides, and no aggregator's address is pinned here.
 * Without a hint the service sizes the spend from a fresh price probe, so a price up by a wei sizes it above a bound
 * approved for an earlier route although that route's spend would still buy the purchase. A route above `room` that
 * could buy the purchase within it is asked once more at the spend `room` pays for with that route's flash fee, and
 * taken when it fits.
 */
async function viaQuote(c: Ctx, a: Asset, buy: bigint, router: Address, { hint, room }: ViaAsk = {}): Promise<LoopQuote | null> {
  const valuation = c.valuation;
  if (!valuation) return null;
  const ask = async (spend?: bigint) => {
    try {
      const r = await valuation.raw(`/quote/loop-buy?token=${a.token.toLowerCase()}&buy=${buy}&slippageBps=${LOOP_SLIPPAGE_BPS}${spend ? `&hint=${spend}` : ""}`);
      const q = r.status === 200 ? parseLoopBuy(r.body, { chainId: c.d.chainId, token: a.token, buy, usdg: c.d.usdg, router, now: c.now() }) : null;
      return q?.kind === "via" ? q : null;
    } catch { return null; }
  };
  let q = await ask(hint);
  if (q && room !== undefined && q.maxCost > room && q.cost <= room) {
    const spend = (room * 1_000_000n) / (1_000_000n + BigInt(q.flashFee));
    const again = spend > 0n && spend !== hint ? await ask(spend) : null;
    if (again && again.maxCost <= room) q = again;
  }
  try {
    return q && await c.chain.loopExecutorAllowed(router, q.executor) ? q : null;
  } catch { return null; }
}

/**
 * Every source of the purchase quoted now, cheapest first (`rankLoopQuotes`): the token's pools, V3 ones only when the
 * router buys through V3 (one built before D242 has no V3 factory), and KyberSwap. A pool whose read fails is left out,
 * unless every one fails and nothing else quotes: then that failure is the answer.
 */
async function loopQuotes(c: Ctx, a: Asset, buy: bigint, router: Address, via: ViaAsk = {}): Promise<LoopQuote[]> {
  const all = c.d.loopPools.get(a.token.toLowerCase()) ?? [];
  const v3 = all.some((p) => p.kind === "v3") && await c.chain.loopV3Factory(router) !== null;
  const pools = all.filter((p) => p.kind === "v4" || v3);
  const [direct, routed] = await Promise.all([Promise.allSettled(pools.map((p) => poolQuote(c, a, p, buy))), viaQuote(c, a, buy, router, via)]);
  const ranked = rankLoopQuotes([...direct.map((r) => (r.status === "fulfilled" ? r.value : null)), routed]);
  const failed = direct.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (!ranked.length && failed && direct.every((r) => r.status === "rejected")) throw failed.reason;
  return ranked;
}

/**
 * Leverage's terms, as the borrow card works them out (BorrowView `leverV2`): the instant loan for the pledge, times the
 * multiple. `via` is what KyberSwap's route is asked for with (a wallet's approval already in place).
 */
export async function leverageTerms(c: Ctx, token: string, own: bigint, multiple: number, term: number, wallet?: Address, via: ViaAsk = {}) {
  const router = c.d.loopRouter;
  requireThat(router, "LEVERAGE_CLOSED", "Leverage is not open on this deployment");
  const a = asset(c, token);
  requireThat(c.d.loopPools.get(a.token.toLowerCase())?.length, "NO_LEVERAGE_POOL", `Leverage does not buy ${a.symbol}`);
  const borrower = wallet ?? router;
  const q = await instant(c.rates, c.d.core.engine, a.token, own, term, wallet);
  const t = BigInt(Math.round(multiple * 10_000));
  const pledge = q.collateral, buy = (pledge * (t - 10_000n)) / 10_000n;
  const principal = (q.principal * t) / 10_000n, cap = (q.cap * t) / 10_000n;
  // The most the purchase may cost, as a quote states it: the cheapest source's bound now, a pool's exact-output quote
  // plus the slippage the router allows, as the app prices it (web/src/borrow/loop.ts `loopMaxCost`), or KyberSwap's
  // own bound (D243); a prepare holds the loop to the bound of the source it is planned through (`chooseSource`). 4 October 2026: a bound of 4% over the tokens' value with 0.6% shown let a wallet pay
  // about 3.4% of the purchase more than the plan said.
  requireThat(c.d.stateView, "LEVERAGE_CLOSED", "Leverage is not open on this deployment");
  const quoted = await loopQuotes(c, a, buy, router, via);
  requireThat(quoted.length, "POOL_TOO_THIN", `No ${a.symbol} pool can sell that much now; try a lower multiple`);
  const feeBps = await c.chain.feeBps(c.d.core.registry);
  const fee = principal - loopPayout(principal, feeBps);
  // D271: a source is bought through only while its own bound keeps LOOP_HEADROOM_BPS of the loan spare under what the
  // loan pays out, as the app offers its leverage: the purchase is never paid past the payout, from the wallet's own USDG.
  // Every source alike, whichever is cheapest or tried after one that reverted (the audit of 18 October 2026: the spare
  // was asked of the cheapest alone, so a route that broke it refused a pool that kept it, and a fallback could spend the
  // whole payout).
  const spendable = loopSpendable(principal, principal - fee);
  const sources = quoted.filter((q) => loopCap(q) <= spendable);
  const least = quoted.map(loopCap).reduce((m, b) => (b < m ? b : m));
  requireThat(sources.length, "MULTIPLE_TOO_HIGH",
    `Buying the ${a.symbol} costs up to ${f.owed(least)}, more than the loan pays out with a quarter of a percent of it spare; try a lower multiple`);
  const maxCost = loopCap(sources[0]!);
  const terms: Terms = { token: a.token, collateral: pledge + buy, principal, cap, term };
  const funded = await preview(c.rates, c.d.core.engine, terms, borrower);
  const allocation = funded.fills ? allocate(funded.vaults) : null;
  requireThat(allocation, "INSUFFICIENT_CAPACITY", "The partner vaults cannot fund this loop whole now; try a lower multiple or a smaller pledge");
  // What lands besides the tokens, at the least: the loan less its fee and the most the purchase may cost (the app's `cash`).
  const cash = principal - fee > maxCost ? principal - fee - maxCost : 0n;
  return { a, router, pledge, buy, principal, cap, maxCost, fee, feeBps, cash, spendable, costBps: costBps(principal, cap), valueUSDG: q.valueUSDG, terms, allocation, expiresAt: q.expiresAt, sources };
}

async function leverage(c: Ctx, i: Extract<ActionInput, { action: "leverage" }>): Promise<Plan> {
  usdgOnly(c, i.lendAsset);
  const wallet = i.wallet as Address;
  // The USDG the wallet has already approved the router for: KyberSwap's route is asked to fit it while it can.
  const usdgApproved = c.d.loopRouter ? await c.chain.allowance(c.d.usdg, wallet, c.d.loopRouter) : 0n;
  const x = await leverageTerms(c, i.token, BigInt(i.own), i.multiple, i.term, wallet, { room: usdgApproved });
  const router = x.router;
  requireThat(x.costBps <= i.maxCostBps, "PRICE_ABOVE_LIMIT", `The loop costs ${f.bps(x.costBps)} now, above the ${f.bps(i.maxCostBps)} limit set`);
  const [tokens, ownApproved] = await Promise.all([c.chain.balance(x.a.token, wallet), c.chain.allowance(x.a.token, wallet, router)]);
  requireThat(tokens >= x.pledge, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.token(x.pledge, x.a.decimals, x.a.symbol)}`);
  const held = f.token(x.pledge + x.buy, x.a.decimals, x.a.symbol);
  // The plan for the loop, signed for the core's next listing (it does not depend on the source, and lives 30 seconds).
  const sign = async (): Promise<LoopBase> => {
    const deadline = c.now() + LISTING_SECONDS;
    const signed = await loopPlan(c.rates, { engine: c.d.core.engine, router, borrower: wallet, terms: x.terms, deadline, allocations: x.allocation, now: c.now() });
    return {
      own: x.pledge, buy: x.buy, fundingDeadline: deadline, withRewards: false, pricing: signed.pricing, plan: signed.plan, signature: signed.signature,
      maxReserveShares: signed.plan.allocations.map((al) => al.maxReserveShares),
    };
  };
  const built = (base: LoopBase, q: LoopQuote, bound: bigint) => tx(router, encodeFunctionData({ abi: loopRouterAbi, ...loopCall(q, base, bound) }));
  // Which source, and the USDG approved for it (D243). The most the purchase may cost when the loop runs: what the loan
  // pays out, its principal less its fee, less the spare kept (D271), never the wallet's own USDG or its credit on the
  // core besides. Once the pledge is approved, each source the USDG approval covers is tried, cheapest first: one whose
  // loop would revert is passed over, and the next one's own bound is approved when it is above the approval.
  const funds = x.spendable;
  const room = usdgApproved < funds ? usdgApproved : funds;
  // Signed before the walk, so that a plan the rates service does not sign is its own refusal, never a source's revert.
  const base = ownApproved >= x.pledge && x.sources.some((q) => boundUnder(q, room) !== null) ? await sign() : null;
  let tried: Tx | null = null;
  const choice = await chooseSource(x.sources, usdgApproved, funds, base
    ? async (q, bound) => {
      const t = built(base, q, bound);
      await c.chain.simulate({ from: wallet, ...t });
      tried = t;
    }
    : undefined);
  requireThat(choice.kind !== "unaffordable", "MULTIPLE_TOO_HIGH",
    `Buying the ${x.a.symbol} costs at least ${f.owed(x.sources[0]!.cost)}, more than the loan pays out; try a lower multiple`);
  if (choice.kind === "reverts") {
    throw new ApiError("SIMULATION_FAILED", `The loop would revert now through every source of the ${x.a.symbol}; prepare it again shortly`, 409);
  }
  const maxCost = choice.bound;
  const cash = x.principal - x.fee > maxCost ? x.principal - x.fee - maxCost : 0n;
  // Every source again when the loop is sent, under the bound approved: quoted first (KyberSwap's route kept at the spend
  // quoted for the plan while it still buys the purchase), then the plan is signed, then the first source that fits and
  // simulates is encoded. A loop already tried above is sent as it was, once.
  const planned = x.sources.find((q): q is Extract<LoopQuote, { kind: "via" }> => q.kind === "via");
  const loop = async (): Promise<Tx> => {
    if (tried) {
      const t: Tx = tried;
      tried = null;
      return t;
    }
    const sources = await loopQuotes(c, x.a, x.buy, router, { hint: planned?.spend, room: maxCost });
    const signed = await sign();
    const chosen = await firstRunnable(sources, maxCost, (q, bound) => c.chain.simulate({ from: wallet, ...built(signed, q, bound) }));
    if (chosen) return built(signed, chosen.q, chosen.bound);
    requireThat(sources.length, "POOL_TOO_THIN", `No ${x.a.symbol} pool can sell that much now; prepare the loop again with a lower multiple`);
    requireThat(sources.some((q) => fitsCap(q, maxCost)), "PRICE_MOVED", `Buying the ${x.a.symbol} costs more now than the ${f.owed(maxCost)} approved for it; prepare the loop again`);
    throw new ApiError("SIMULATION_FAILED",
      "The loop would revert now through every source under its approved cost; prepare it again: a source that keeps reverting is passed over for the next one, which may need a larger USDG approval", 409);
  };
  return {
    view: {
      action: "leverage", token: x.a.token, symbol: x.a.symbol, decimals: x.a.decimals, own: x.pledge.toString(), buy: x.buy.toString(), multiple: i.multiple,
      principal: x.principal.toString(), fee: x.fee.toString(), cap: x.cap.toString(), term: i.term, feeBps: x.feeBps, costBps: x.costBps, maxCostBps: i.maxCostBps,
      maxCost: maxCost.toString(), ownValueUSDG: x.valueUSDG.toString(), cashUSDG: cash.toString(),
    },
    summary: {
      title: `Open a ${i.multiple}× loop on ${x.a.symbol}`,
      rows: [
        { label: "You put in", value: f.token(x.pledge, x.a.decimals, x.a.symbol) },
        { label: "The loan buys", value: f.token(x.buy, x.a.decimals, x.a.symbol) },
        { label: "Held for the loan", value: held },
        { label: `You repay within ${f.days(i.term)}`, value: f.owed(x.cap) },
        { label: "Loan cost", value: `${f.bps(x.costBps)}, under the ${f.bps(i.maxCostBps)} limit set` },
        { label: "The purchase costs at most", value: f.owed(maxCost) },
        { label: "If you don't repay", value: NO_LIQUIDATION(held) },
      ],
    },
    steps: [
      ...await approval(c, x.a.token, x.a.symbol, wallet, router, x.pledge),
      ...await approval(c, c.d.usdg, "USDG", wallet, router, maxCost),
      { label: "Open loop", kind: "action", final: true, build: loop },
    ],
    notes: ["The loop's price is signed for 30 seconds when its transaction is prepared: send it at once, or prepare again."],
    made: (logs) => {
      const looped = eventOf(loopRouterAbi, "Looped", router, logs, (x) => same(String(x.borrower), wallet));
      return looped ? { engine: c.d.core.engine, loanId: String(looped.id) } : null;
    },
  };
}

/**
 * A loan of the wallet's, private loans refused as unknown, whether the index marks them or only the chain tells (M7); on
 * the current core unless another engine is named.
 */
async function ownLoan(c: Ctx, wallet: Address, id: string, engineAddress?: string): Promise<{ engine: Engine; loan: Awaited<ReturnType<Chain["loan"]>> }> {
  const engine = engineAddress ? engineOf(c.d, engineAddress) : c.d.core;
  requireThat(engine, "UNKNOWN_ENGINE", "This engine is not gage's", 404);
  await loanRecord(c, engine.engine, id);
  const loan = await c.chain.loan(engine.engine, BigInt(id));
  requireThat(same(loan.originator, wallet) || same(loan.collateralBeneficiary, wallet) || same(await c.chain.ownerOf(engine.engine, BigInt(id)) ?? "0x", wallet),
    "NOT_YOUR_LOAN", "This wallet did not borrow this loan", 403);
  return { engine, loan };
}

const takeBack = (engine: Engine, id: bigint, wallet: Address) =>
  call("Receive collateral", engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "withdrawCollateral", args: [id, wallet] }));

async function cancel(c: Ctx, i: Extract<ActionInput, { action: "cancel" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const ref = await collateralRef(c, loan.token), known = ref.symbol !== "tokens" || assetOf(c.d, loan.token);
  const what = known ? f.token(loan.collateral, ref.decimals, ref.symbol) : "collateral";
  const steps: Step[] = [];
  if (loan.state === 1) {
    requireThat(same(loan.originator, wallet), "NOT_YOUR_LOAN", "Only the borrower cancels a listing", 403);
    steps.push(call("Cancel listing", engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "cancelFunding", args: [id] })), takeBack(engine, id, wallet));
  } else {
    requireThat(loan.state === 5, "NOT_CANCELLABLE", "Only a loan still waiting for funding can be cancelled");
    if (same(loan.collateralBeneficiary, wallet) && !await c.chain.released(loan.account)) steps.push(takeBack(engine, id, wallet));
  }
  return {
    view: { action: "cancel", ...ref, loanId: i.loanId, collateral: loan.collateral.toString() },
    summary: { title: `Cancel loan #${i.loanId} and take back ${what}`, rows: [
      { label: "Loan", value: `#${i.loanId}, waiting for funding` },
      { label: "Back to your wallet", value: what },
      { label: "Lenders' contributions", value: "Returned to them" },
    ] },
    steps, notes: [],
  };
}

async function reclaim(c: Ctx, i: Extract<ActionInput, { action: "reclaim" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const ref = await collateralRef(c, loan.token), known = ref.symbol !== "tokens" || assetOf(c.d, loan.token);
  const what = known ? f.token(loan.collateral, ref.decimals, ref.symbol) : "collateral";
  // Repaid in the asset the loan's core pays in (D251): USDG, or its generation's lend asset.
  const pay = lendAssetOf(c.d, engine.engine);
  const ends = loan.fundedAt + loan.term;
  const steps: Step[] = [];
  if (loan.state === 2) {
    requireThat(same(await c.chain.ownerOf(engine.engine, id) ?? "0x", wallet), "NOT_YOUR_LOAN", "This wallet does not hold the loan's reclaim right", 403);
    requireThat(c.now() < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
    await sameCoreAsset(c, engine.engine, pay);
    requireThat(await c.chain.balance(pay.token, wallet) >= loan.cap, "INSUFFICIENT_BALANCE", `Repaying takes ${f.owedIn(loan.cap, pay)}; the wallet holds less`);
    steps.push(...await approval(c, pay.token, pay.symbol, wallet, engine.engine, loan.cap),
      call("Repay", engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "reclaim", args: [id, wallet] })), takeBack(engine, id, wallet));
  } else {
    requireThat(loan.state === 3, "NOT_REPAYABLE", loan.state === 4 ? "The term ended unpaid: the lenders keep the collateral" : "This loan is not running");
    if (same(loan.collateralBeneficiary, wallet) && !await c.chain.released(loan.account)) steps.push(takeBack(engine, id, wallet));
  }
  return {
    view: { action: "reclaim", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), cap: loan.cap.toString(), endsAt: ends, ...inAsset(c, pay, engine.engine) },
    summary: { title: `Repay loan #${i.loanId} and take back ${what}`, rows: [
      { label: "You pay", value: f.owedIn(loan.cap, pay) },
      { label: "Back to your wallet", value: what },
      ...(loan.fundedAt > 0 ? [{ label: "Repay before", value: `${f.date(ends)} (the loan's last day)` }] : []),
    ] },
    steps, notes: [],
  };
}

/** A loan's rollover router (D285): its generation's, refused where the release names none. */
function rollRouterOf(c: Ctx, engine: Engine): Address {
  const router = rolloverRouterOf(c.d, engine.engine);
  requireThat(router, "ROLLOVER_CLOSED", "Loans on this core cannot be rolled over");
  return router;
}
/** The holder of a loan's reclaim right, refused for any other wallet: only they roll it, or leave it to roll. */
async function holdsRight(c: Ctx, engine: Engine, id: bigint, wallet: Address) {
  requireThat(same(await c.chain.ownerOf(engine.engine, id) ?? "0x", wallet), "NOT_YOUR_LOAN", "This wallet does not hold the loan's reclaim right", 403);
}
/** The reclaim right approved to `router` for one loan, unless the router may move it already (this right, or all). */
async function rightApproval(c: Ctx, engine: Engine, id: bigint, wallet: Address, router: Address, label: string): Promise<Step[]> {
  const [one, all] = await Promise.all([c.chain.approvedFor(engine.engine, id), c.chain.approvedForAll(engine.engine, wallet, router)]);
  if (same(one, router) || all) return [];
  return [{ label, kind: "approve", final: false, build: () => Promise.resolve(tx(engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "approve", args: [router, id] }))) }];
}
/** A term the loan's own registry allows now. */
async function allowedTerm(c: Ctx, engine: Engine, term: number) {
  const terms = await termsOf(c, engine.registry);
  requireThat(terms.includes(term), "TERM_NOT_ALLOWED", `Allowed terms: ${terms.map(f.days).join(", ")}`);
}

/**
 * Rolling a running loan over (D285): the new loan, on the same pledge and of the same size, repays this one in full in
 * one transaction, and the wallet adds what its payout leaves short of this loan's repayment (the top-up), or keeps what
 * is over. The reclaim right is approved to the generation's rollover router for this loan, the old repayment in the
 * loan's asset (exact amounts, as every approval here), then the roll, its plans signed for 30 seconds when it is sent
 * and held to the top-up and repayment planned: a dearer roll is refused before it is sent, and the router takes no
 * more than that top-up. A roll by hand ends the loan's instruction to roll by itself.
 */
async function rollOver(c: Ctx, i: Extract<ActionInput, { action: "roll" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const router = rollRouterOf(c, engine);
  requireThat(loan.state === 2, "NOT_ROLLABLE", loan.state === 1 ? "The loan is still waiting for funding: nothing to roll yet" : "Only a running loan can be rolled over");
  await holdsRight(c, engine, id, wallet);
  const ends = loan.fundedAt + loan.term, term = i.term ?? loan.term;
  requireThat(c.now() < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  requireThat(!await c.chain.rolloverPaused(router), "ROLLOVER_PAUSED", "Rolling over is paused now");
  await allowedTerm(c, engine, term);
  const pay = lendAssetOf(c.d, engine.engine);
  await sameCoreAsset(c, engine.engine, pay);
  const ask = { engine: engine.engine, loanId: id, borrower: wallet, term, oldPrincipal: loan.principal, oldCap: loan.cap };
  const [shown, standing] = await Promise.all([rollFigures(c.rates, ask), c.chain.autoRoll(router, id)]);
  const w = shown.wallet, t = shown.terms;
  requireThat(await c.chain.balance(pay.token, wallet) >= w.topUp, "INSUFFICIENT_BALANCE", `Rolling over takes ${f.owedIn(w.topUp, pay)} from the wallet; it holds less`);
  const ref = await collateralRef(c, loan.token), known = ref.symbol !== "tokens" || assetOf(c.d, loan.token);
  const what = known ? f.token(loan.collateral, ref.decimals, ref.symbol) : "collateral";
  // Asked again when it is sent: the plans live 30 seconds, and the roll is held to what was planned.
  const send = async (): Promise<Tx> => {
    const r = await rollPlan(c.rates, { ...ask, router, token: loan.token, collateral: loan.collateral, now: c.now });
    requireThat(r.wallet.topUp <= w.topUp && r.terms.cap <= t.cap, "PRICE_MOVED", "The roll costs more now than when it was prepared; prepare it again");
    return tx(router, encodeFunctionData({ abi: rolloverRouterAbi, functionName: "roll",
      args: [{ loanId: id, maxTopUp: w.topUp, withRewards: false, pricing: r.pricing }, r.plans, r.signatures, r.plans[0]!.allocations.map((a) => a.maxReserveShares)] }));
  };
  const early = ends - c.now() > 86_400;
  return {
    view: {
      action: "roll", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), oldPrincipal: loan.principal.toString(), oldCap: loan.cap.toString(), endsAt: ends,
      principal: t.principal.toString(), cap: t.cap.toString(), term: t.term, fee: w.fee.toString(), feeBps: w.feeBps, payout: w.payout.toString(),
      topUp: w.topUp.toString(), surplus: w.surplus.toString(), ...inAsset(c, pay, engine.engine),
    },
    summary: {
      title: `Roll loan #${i.loanId} over into a new ${f.days(t.term)} loan`,
      rows: [
        { label: "Still pledged", value: what },
        { label: "Repaid now", value: `${f.owedIn(loan.cap, pay)}, this loan in full` },
        { label: "The new loan", value: `${f.money(t.principal, pay)}, the same size, less its ${f.bps(w.feeBps)} fee` },
        { label: `You repay within ${f.days(t.term)}`, value: f.owedIn(t.cap, pay) },
        w.topUp > 0n ? { label: "From your wallet", value: f.owedIn(w.topUp, pay) } : { label: "Back to your wallet", value: f.money(w.surplus, pay) },
        { label: "Loan cost", value: f.bps(costBps(t.principal, t.cap)) },
        { label: "If you don't repay", value: NO_LIQUIDATION(what) },
      ],
    },
    steps: [
      ...await rightApproval(c, engine, id, wallet, router, `Approve the roll of loan #${i.loanId}`),
      ...await approval(c, pay.token, pay.symbol, wallet, router, loan.cap),
      { label: "Roll over", kind: "action", final: true, build: send },
    ],
    made: (logs) => {
      const rolled = eventOf(rolloverRouterAbi, "Rolled", router, logs, (x) => String(x.oldId) === i.loanId && same(String(x.borrower), wallet));
      return rolled ? { engine: engine.engine, loanId: String(rolled.newId) } : null;
    },
    notes: [
      "The new loan's price is signed for 30 seconds when its transaction is prepared: send it at once, or prepare again.",
      ...(early ? [`This loan runs until ${f.date(ends)}: rolling now repays it early, and the new loan's term starts now.`] : []),
      ...(standing ? ["Rolling by hand ends this loan's instruction to roll by itself."] : []),
      ...(pay.stable ? [] : [REPAY_IN(pay)]),
    ],
  };
}

/**
 * Cashing a running loan out (D245): its whole collateral is sold through an aggregator by the core's cash-out router,
 * which repays the loan from a flash loan of its cap, keeps 0.5% of what remains and pays the wallet the rest, in one
 * transaction (`cashOutVia`). The reclaim right is approved to the router for this loan, then the sale, quoted again
 * when it is sent (a quote lives 120 seconds) and refused when it would pay less than planned, less than the caller's
 * `minNet`, or more than ROUTE_MARGIN_BPS less than gage's own direct route for the collateral, simulated then (the
 * audit of 18 October 2026: one answer names both the sale's price and its least output). A sale that would revert
 * through all of the aggregator's liquidity is asked again through its pools only, as the app does. Loans on a core
 * whose router predates such sales cash out on gage.cash, through its admitted routes.
 */
async function cashOut(c: Ctx, i: Extract<ActionInput, { action: "cash_out" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const router = engine.cashoutRouter, valuation = c.valuation;
  requireThat(router && valuation, "CASHOUT_CLOSED", "Loans on this core cash out on gage.cash only");
  requireThat(loan.state === 2, "NOT_RUNNING", "Only a running loan can be cashed out");
  await holdsRight(c, engine, id, wallet);
  const ends = loan.fundedAt + loan.term;
  requireThat(c.now() < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  const pay = lendAssetOf(c.d, engine.engine);
  requireThat(!same(loan.token, pay.token), "CASHOUT_CLOSED", "This loan's pledge is the asset it is repaid in: repay it instead");
  await sameCoreAsset(c, engine.engine, pay);
  const want = (): CashoutWant => ({
    chainId: c.d.chainId, engine: engine.engine, router, loanId: id, token: loan.token, collateral: loan.collateral, cap: loan.cap, asset: pay.token,
    slippageBps: i.maxSlippageBps ?? 50, now: c.now(),
  });
  const sale = await askCashoutSale(valuation, want()) ?? await askCashoutSale(valuation, want(), "pools");
  requireThat(sale, "NO_SALE", "No aggregator sells this collateral for the loan's repayment now; try again shortly, or repay instead");
  const admitted = await c.chain.cashoutExecutorAllowed(router, sale.executor);
  requireThat(admitted !== null, "CASHOUT_CLOSED", "This core's cash-out router predates sales through an aggregator: cash out on gage.cash");
  requireThat(admitted, "NO_SALE", "The cash-out router does not admit the aggregator this sale goes through now");
  // The least the caller accepts: the sale is refused under it now, and the transaction reverts under it.
  const least = i.minNet ? BigInt(i.minNet) : 0n;
  requireThat(sale.netAtQuote >= least, "BELOW_MIN_NET", `The sale pays about ${f.money(sale.netAtQuote, pay)} now, under the least you named`, 409, { details: { net: sale.netAtQuote.toString() } });
  const floor = (x: CashoutSale) => (x.minimumNet > least ? x.minimumNet : least);
  // gage's own direct routes for the collateral, into a USDG core's asset: what the sale is weighed against when sent.
  const routes = same(pay.token, c.d.usdg) ? directRoutes(loan.token, pay.token, c.d.loopPools.get(loan.token.toLowerCase()) ?? []) : [];
  const exit = (x: CashoutSale): Tx => tx(router, encodeFunctionData({ abi: cashoutRouterAbi, functionName: "cashOutVia", args: [{
    loanId: id, recipient: wallet, minimumNet: floor(x), maxFinanceFee: x.maxFinanceFee, deadline: BigInt(x.deadline), executor: x.executor, data: x.data,
    flashToken: x.flashToken, flashFee: x.flashFee, minUsdgOut: x.minOut,
  }] }));
  // Quoted again when it is sent, never paying less than planned or than the caller's least, nor clearly less than gage's
  // own route, which the app would take instead (`pickCashout`); a sale that would revert gives way to its pools-only one.
  const send = async (): Promise<Tx> => {
    // The right is approved to the router by now, so its routes can be simulated for the wallet.
    const reference = routes.length ? await routeNet(c.chain, router, id, wallet, loan.cap, c.now(), routes) : null;
    let last: Tx | null = null, below = false;
    for (const sources of ["all", "pools"] as const) {
      const x = await askCashoutSale(valuation, want(), sources);
      if (!x || x.minimumNet < sale.minimumNet || x.netAtQuote < least || await c.chain.cashoutExecutorAllowed(router, x.executor) !== true) continue;
      if (reference !== null && x.netAtQuote * 10_000n < reference * (10_000n - ROUTE_MARGIN_BPS)) { below = true; continue; }
      last = exit(x);
      try { await c.chain.simulate({ from: wallet, ...last }); return last; } catch { /* the next liquidity */ }
    }
    requireThat(last || !below, "SALE_BELOW_ROUTE", "The aggregator's sale pays clearly less than gage's own route for this collateral now: cash out on gage.cash, which sells through it");
    requireThat(last, "PRICE_MOVED", "The sale pays less now than when it was prepared; prepare it again");
    throw new ApiError("SIMULATION_FAILED", "The sale would revert now; prepare it again shortly", 409);
  };
  const ref = await collateralRef(c, loan.token), known = ref.symbol !== "tokens" || assetOf(c.d, loan.token);
  const what = known ? f.token(loan.collateral, ref.decimals, ref.symbol) : "collateral";
  const fee = sale.amountOut - loan.cap - sale.maxFinanceFee - sale.netAtQuote;
  return {
    view: {
      action: "cash_out", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), cap: loan.cap.toString(), gross: sale.amountOut.toString(),
      financeFee: sale.maxFinanceFee.toString(), fee: fee.toString(), net: sale.netAtQuote.toString(), minimumNet: floor(sale).toString(), source: sale.source,
      ...inAsset(c, pay, engine.engine),
    },
    summary: {
      title: `Cash loan #${i.loanId} out: sell ${what}, repay the loan, keep the rest`,
      rows: [
        { label: "You sell", value: `${what}, all of it` },
        { label: "The sale returns about", value: f.money(sale.amountOut, pay) },
        { label: "Repaid to the lenders", value: f.owedIn(loan.cap, pay) },
        { label: "Flash loan fee", value: f.money(sale.maxFinanceFee, pay) },
        { label: "gage's fee", value: `${f.money(fee, pay)}, 0.5% of what remains` },
        { label: "You receive", value: `About ${f.money(sale.netAtQuote, pay)}, at least ${f.money(floor(sale), pay)}` },
      ],
    },
    steps: [
      ...await rightApproval(c, engine, id, wallet, router, `Approve the cash-out of loan #${i.loanId}`),
      { label: "Cash out", kind: "action", final: true, build: send },
    ],
    notes: [
      routes.length
        ? "The sale is quoted again when it is sent (a quote lives two minutes), and refused if it would pay less than this, or more than 1% less than gage's own route."
        : "The sale is quoted again when it is sent (a quote lives two minutes), and refused if it would pay less than this.",
      ...(routes.length ? [] : ["gage has no route of its own for this collateral to weigh the sale against: name minNet, the least you accept, to hold the sale to it."]),
      "Cashing out closes the loan: the lenders are repaid in full, and no collateral comes back.",
      ...(pay.stable ? [] : [`What you receive is ${pay.symbol}.`]),
    ],
  };
}

/** How many rolls one instruction makes, as the app leaves it: about a month of weekly loans. */
const AUTO_ROLLS = 4;
/**
 * The most a default ceiling may be, in this loan's own cost and fee, read from the chain: twice today's quote at most,
 * so a rates answer out of line widens neither the ceiling nor the approvals that stay. A roll that costs more than
 * this now is left to a ceiling the caller names.
 */
const DEFAULT_CEILING_OF_OWN = 4n;
/** How long before a loan's end the keeper may roll it: six hours, never more than an eighth of its term (the router's bound). */
const autoWindow = (term: number) => Math.min(6 * 3_600, Math.floor(term / 8));
/** An amount rounded up to the asset's last shown place, so an "at most" said in it stays true. */
const shownCeil = (raw: bigint, a: Pick<LendAsset, "decimals" | "stable">) => {
  const step = 10n ** BigInt(Math.max(0, a.decimals - (a.stable ? 2 : 4)));
  return ((raw + step - 1n) / step) * step;
};

/**
 * Rolling over by itself (D285): a standing instruction for gage's keeper, who rolls the loan in its last hours into a
 * new loan of the same size and term, at most `maxCost` each (its fixed cost and fee, held on chain to the unit), up to
 * four times. Unlike every other action here it leaves standing approvals, said in the plan: the router may move every
 * reclaim right of this wallet on this core, so the instruction follows each new loan, and spend the loan's asset for
 * the repayments of all four rolls. Set while the loan waits for funding or runs, by the holder of its right.
 *
 * Where no `maxCost` is named it starts where the app starts it: for a running loan, twice what a roll of it costs now,
 * the new loan's fixed cost and fee, from the same quote a roll by hand is priced on (web/src/v2/PositionView.tsx); no
 * quote, no ceiling, and the quote's refusal is the answer. A listing's roll cannot be quoted until it is funded, so its
 * ceiling starts at twice this loan's own fixed cost and fee, as the Borrow ticket starts it (web/src/components/BorrowView.tsx).
 * Unlike the app's, whose owner reads the figure before signing, the default is held to four times this loan's own cost
 * (`DEFAULT_CEILING_OF_OWN`), and a ceiling the caller names to the loan's principal: an agent's ceiling is the
 * borrower's only bound on what gage's services may price each roll at.
 */
async function autoRoll(c: Ctx, i: Extract<ActionInput, { action: "auto_roll" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const router = rollRouterOf(c, engine), executor = c.d.rolloverExecutor;
  requireThat(executor, "AUTO_ROLL_CLOSED", "Rolling over by itself is not offered on this deployment");
  requireThat(loan.state === 1 || loan.state === 2, "NOT_ROLLABLE", "Only a loan waiting for funding or running can roll by itself");
  await holdsRight(c, engine, id, wallet);
  // A listing's end is not known until it is funded: the app counts it from its funding window, as here.
  const end = loan.state === 2 ? loan.fundedAt + loan.term : c.now() + LISTING_SECONDS + loan.term;
  requireThat(c.now() < end, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  requireThat(!await c.chain.rolloverPaused(router), "ROLLOVER_PAUSED", "Rolling over is paused now");
  const pay = lendAssetOf(c.d, engine.engine);
  await sameCoreAsset(c, engine.engine, pay);
  const feeBps = await c.chain.feeBps(engine.registry);
  // This loan's own fixed cost and fee: the least each roll may take from the wallet (the app's `autoLimits`).
  const own = loan.cap - loan.principal + (loan.principal * BigInt(feeBps)) / 10_000n;
  requireThat(!i.maxCost || BigInt(i.maxCost) <= loan.principal, "MAX_COST_TOO_HIGH", `A roll's ceiling may be at most the loan's principal, ${f.money(loan.principal, pay)}`);
  // What a roll of this running loan costs now, its new fixed cost and fee, quoted for its own term.
  const today = i.maxCost || loan.state !== 2 ? null : await rollFigures(c.rates, { engine: engine.engine, loanId: id, borrower: wallet, term: loan.term, oldPrincipal: loan.principal, oldCap: loan.cap })
    .then(({ terms, wallet: w }) => terms.cap - terms.principal + w.fee);
  const bound = own * DEFAULT_CEILING_OF_OWN;
  requireThat(today === null || today <= bound, "ROLL_COST_HIGH",
    `A roll of this loan costs ${f.owedIn(today ?? 0n, pay)} now, more than four times its own ${f.owedIn(own, pay)}: name maxCost to leave it a ceiling that high`);
  const most = i.maxCost ? BigInt(i.maxCost) : shownCeil(today === null ? own * 2n : today * 2n < bound ? today * 2n : bound, pay);
  const maxTopUp = own > most ? own : most;
  const allowance = loan.cap + BigInt(AUTO_ROLLS - 1) * (loan.principal + most);
  const until = end + AUTO_ROLLS * loan.term + 86_400, window = autoWindow(loan.term);
  const ref = await collateralRef(c, loan.token);
  const operator: Step[] = await c.chain.approvedForAll(engine.engine, wallet, router) ? [] : [{
    label: "Let the rollover router follow your loans", kind: "approve", final: false,
    build: () => Promise.resolve(tx(engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "setApprovalForAll", args: [router, true] }))),
  }];
  const hours = window % 3_600 === 0 ? `${window / 3_600} hours` : `${Math.floor(window / 60)} minutes`;
  return {
    view: {
      action: "auto_roll", ...ref, loanId: i.loanId, principal: loan.principal.toString(), term: loan.term, maxCost: most.toString(), maxTopUp: maxTopUp.toString(),
      rolls: AUTO_ROLLS, window, until, allowance: allowance.toString(), executor, ...inAsset(c, pay, engine.engine),
    },
    summary: {
      title: `Roll loan #${i.loanId} over by itself`,
      rows: [
        { label: "Each new loan", value: `${f.money(loan.principal, pay)} for ${f.days(loan.term)}, the same as this one` },
        { label: "Each roll costs at most", value: `${f.owedIn(most, pay)}, its fixed cost and fee together` },
        { label: "From your wallet each roll", value: `At most ${f.owedIn(maxTopUp, pay)}` },
        { label: "When", value: `Up to ${AUTO_ROLLS} rolls, each in the last ${hours} of its loan, until ${f.date(until)}` },
        { label: "Approvals that stay", value: `gage's rollover router may move your loans on this core and spend up to ${f.money(allowance, pay)} for their repayments, until you withdraw them in your wallet` },
        { label: "Turning it off", value: "Any time, with cancel_auto_roll" },
      ],
    },
    steps: [
      ...operator,
      ...await approval(c, pay.token, pay.symbol, wallet, router, allowance),
      call("Turn on rolling by itself", router, encodeFunctionData({ abi: rolloverRouterAbi, functionName: "setAutoRoll", args: [id, executor, loan.term, window, most, maxTopUp, AUTO_ROLLS, false, until] }), true),
    ],
    notes: [
      "gage's keeper rolls the loan only while the wallet still holds its right, the approvals stand and the wallet holds the top-up; a roll it cannot make leaves the loan as it is.",
      "Each roll keeps the loan's size and term and costs no more than the ceiling, to the unit: the router refuses any other.",
      ...(i.maxCost ? [] : [today === null
        ? `The ceiling is twice what this loan costs: ${f.owedIn(own, pay)}, its fixed cost and fee together. A listing's roll cannot be quoted until it is funded.`
        : today * 2n < bound
          ? `The ceiling is twice what a roll of this loan costs now: ${f.owedIn(today, pay)}, its fixed cost and fee together.`
          : `The ceiling is four times what this loan costs, ${f.owedIn(own, pay)}, its fixed cost and fee together: a roll costs ${f.owedIn(today, pay)} now, and twice that would be more.`]),
      ...(pay.stable ? [] : [REPAY_IN(pay)]),
    ],
  };
}

/** Ending a loan's instruction to roll by itself: one call, by the wallet that left it. */
async function cancelAutoRoll(c: Ctx, i: Extract<ActionInput, { action: "cancel_auto_roll" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const router = rollRouterOf(c, engine);
  const a = await c.chain.autoRoll(router, id);
  requireThat(a && same(a.borrower, wallet), "NO_AUTO_ROLL", "This wallet left no instruction to roll this loan");
  return {
    view: { action: "cancel_auto_roll", ...await collateralRef(c, loan.token), loanId: i.loanId, rollsLeft: a.rollsLeft },
    summary: { title: `Stop rolling loan #${i.loanId} over by itself`, rows: [
      { label: "Loan", value: `#${i.loanId}` },
      { label: "Rolls it would still make", value: String(a.rollsLeft) },
    ] },
    steps: [call("Turn off rolling by itself", router, encodeFunctionData({ abi: rolloverRouterAbi, functionName: "cancelAutoRoll", args: [id] }))],
    notes: ["The router's approvals stay: withdraw them in your wallet once no loan of this wallet rolls by itself."],
  };
}

/**
 * A partner vault of a current core, re-identified on chain (created by a public generation's factory, lending on that
 * generation's core), with its generation: the USDG one, or a lend asset's (D251).
 */
async function partner(c: Ctx, vault: string): Promise<{ address: Address; v: PartnerVault; g: Generation }> {
  const address = vault as Address;
  let g: Generation | undefined;
  for (const x of c.d.generations) if (await c.chain.isVault(x.factory, address)) { g = x; break; }
  requireThat(g && same(await c.chain.vaultCore(address), g.core.engine), "UNKNOWN_VAULT", lendsMore(c.d) ? "This is not a partner vault of one of gage's current cores" : "This is not a partner vault of gage's current core", 404);
  const v = (await partnerVaults(c.indexer, c.d, g)).find((x) => same(x.address, address));
  requireThat(v, "UNKNOWN_VAULT", "This vault is not indexed yet", 404);
  return { address, v, g };
}
/** The vault's virtual shares (`IntentVault.VIRTUAL_SHARES`): one whole token of any asset starts worth 10^18 shares. */
const VIRTUAL_SHARES = 10n ** 12n;
/** `10^(decimals − 6)`, the vault's `ASSET_SCALE` and virtual assets (Intent D55). */
const assetScale = (a: Pick<LendAsset, "decimals">) => 10n ** BigInt(a.decimals - 6);
/**
 * The shares a holder redeems for everything it holds (Intent D55), never leaving shares out with nothing behind them:
 * shares out with a zero `totalAssets()` make the vault refuse every deposit and redemption after (`Impaired`; the r9 e2e
 * of 15 October 2026, where a full withdrawal paid the NVDAx vault's only holder every raw unit and left 1,798,642,962
 * shares). The app sizes it the same way (web/src/intent/partners/figures.ts).
 *
 * With the vault's `book`, exactly, at its own conversion (`convertToAssets`, rounded down): its only holder redeems
 * every share when no loan is out and the vault can pay them all, which it always can at six decimals and at more while
 * a share is worth what it started at. Otherwise the redemption is the most the free cash pays that leaves at least one
 * raw unit behind the shares that stay. After a loss in a vault of more than six decimals, a holder beside others also
 * keeps back the shares worth a millionth of a token, as below, whoever turns out last when it is mined.
 *
 * Without a book: every share, except after such a loss, where the vault's virtual assets (`ASSET_SCALE` raw units, a
 * millionth of one token) price the last holder's whole balance above what the vault has, by less than that millionth,
 * and the shares worth that millionth are kept back. `value` is what the `held` shares are worth now.
 */
export function redeemableShares(held: bigint, value: bigint, a: Pick<LendAsset, "decimals">, book?: VaultBook | null): bigint {
  const scale = assetScale(a);
  // A vault with no priced assets refuses every redemption anyway (`Impaired`), and a book older than the holding is no book.
  if (!book || held === 0n || book.totalAssets === 0n || book.totalSupply < held) return lastHolderShares(held, value, scale);
  const paid = (shares: bigint) => (shares * (book.totalAssets + scale)) / (book.totalSupply + VIRTUAL_SHARES);
  if (held === book.totalSupply && book.performing === 0n && paid(held) <= book.free) return held;
  // Never the whole supply here: a loan is out, or the vault cannot pay it all.
  const cap = held === book.totalSupply ? held - 1n : held;
  const most = leavingSome(book, scale);
  const exact = most < cap ? most : cap;
  const lastHolder = held < book.totalSupply ? lastHolderShares(held, paid(held), scale) : held;
  return exact < lastHolder ? exact : lastHolder;
}

/** The most shares a redemption from `book` may take while shares stay behind it: the largest s whose payment,
 * ⌊s × (totalAssets + ASSET_SCALE) / (totalSupply + VIRTUAL_SHARES)⌋, the free cash covers and leaves a raw unit. */
function leavingSome(book: VaultBook, scale: bigint): bigint {
  const limit = book.free < book.totalAssets - 1n ? book.free : book.totalAssets - 1n;
  return limit < 0n ? 0n : ((limit + 1n) * (book.totalSupply + VIRTUAL_SHARES) - 1n) / (book.totalAssets + scale);
}

/** A full withdrawal sized without a book: every share at six decimals and while a share is worth what it started at
 * (`value / held >= ASSET_SCALE / VIRTUAL_SHARES`), else all but the shares worth a millionth of a token. */
function lastHolderShares(held: bigint, value: bigint, scale: bigint): bigint {
  if (scale === 1n || held === 0n || value === 0n || value * VIRTUAL_SHARES >= held * scale) return held;
  const dust = (scale * held + value - 1n) / value;
  return held > dust ? held - dust : 0n;
}
const slip = (quoted: bigint, maxBps = 50) => quoted - (quoted * BigInt(maxBps)) / 10_000n;
const REFUSALS: Record<string, string> = {
  PAUSED: "The vault is paused", SETTLEMENT_DUE: "A loan of the vault must be settled first", IMPAIRED: "The vault is impaired",
  BELOW_MINIMUM: "Below the vault's minimum deposit", CAP_EXCEEDED: "Above the vault's deposit cap", ZERO_SHARES: "Too small to buy a share",
  EXCEEDS_BALANCE: "More shares than the wallet holds", INSUFFICIENT_LIQUIDITY: "More than the vault's free cash now", OUTSTANDING_LOANS: "The vault has loans running",
};

/** The most loans one settle books (`IntentVault.MAX_BATCH`). */
const MAX_SETTLE = 32;
/**
 * A vault due a settlement (a loan past its end not yet booked) takes no deposit or redemption until one books it,
 * which anyone may call and gage's keeper does each pass (Intent D2). The plan settles first, the loans the index names
 * (32 at most), with the gas booking them takes (shared/tx-gas.mjs: 250,000 a loan and two more), then plans the
 * deposit or redemption again from the chain. Booking a loan past its end unpaid writes it off, which lowers the share
 * price: a deposit then buys more shares, a redemption pays less, and its minimum is computed after.
 */
async function settleFirst(c: Ctx, vault: Address, view: View, title: string, name: string): Promise<Plan> {
  const acc = await c.indexer.get(`/intent/partners/vaults/${vault.toLowerCase()}/accounting`, accounting);
  const ids = (acc.settlement?.settleable ?? []).slice(0, MAX_SETTLE).map(BigInt);
  requireThat(ids.length, "SETTLEMENT_DUE", "A loan of the vault must be settled first, and none can be yet; try again shortly");
  return {
    view, summary: { title, rows: [{ label: "First", value: `Settle ${ids.length} loan${ids.length === 1 ? "" : "s"} of ${name}: a loan past its end must be booked before the vault takes deposits or pays out` }] },
    steps: [{ label: "Settle the vault's loans", kind: "action", final: false, extraGas: 250_000n * BigInt(ids.length + 2),
      build: () => Promise.resolve(tx(vault, encodeFunctionData({ abi: partnerVaultAbi, functionName: "settle", args: [ids] }))) }],
    notes: ["Settling books each loan's outcome: one past its end unpaid is written off, which lowers the share price. Prepare again once it is mined; run() does so itself."],
    again: true,
  };
}

/** The smallest deposit, in six-decimal units (`IntentVault.MIN_DEPOSIT`): one whole token of any asset once scaled. */
const MIN_DEPOSIT = 1_000_000n;
/** A vault's refusal in fixed words, a lend asset's minimum and free cash named in that asset (D251). */
/** A refusal of the vault's preview gage knows (REFUSALS); any other the index names is VAULT_REFUSED (the audit of 18 October 2026). */
const known = (code: string | null): code is string => code !== null && Object.hasOwn(REFUSALS, code);
const vaultRefusal = (code: string | null) => (known(code) ? code : "VAULT_REFUSED");
const refusalWords = (code: string | null, cash: LendAsset, primary: boolean) =>
  !known(code) ? undefined
    : primary ? REFUSALS[code]
      : code === "BELOW_MINIMUM" ? `The least a deposit takes is ${f.money(MIN_DEPOSIT * assetScale(cash), cash)}`
        : code === "INSUFFICIENT_LIQUIDITY" ? `More than the vault's free ${cash.symbol} now` : REFUSALS[code];
/** Before any write (Intent D55): the vault still takes and pays out the asset the plan counts in. */
async function sameVaultAsset(c: Ctx, vault: Address, a: LendAsset) {
  requireThat(same(await c.chain.vaultAsset(vault), a.token), "ASSET_CHANGED", `This vault does not take ${a.symbol}; read it again before acting`);
}

async function earnDeposit(c: Ctx, i: Extract<ActionInput, { action: "earn_deposit" }>): Promise<Plan> {
  const wallet = i.wallet as Address, amount = BigInt(i.amount);
  // A vault takes and pays out its generation's asset (D251): USDG, or a lend asset.
  const { address, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset;
  requireThat(v.fundingEnabled, "FUNDING_CLOSED", "This vault does not lend yet");
  const p = await c.indexer.get(`/intent/partners/vaults/${address.toLowerCase()}/preview?deposit=${amount}`, previewAnswer);
  if (p.refusal === "SETTLEMENT_DUE") {
    requireThat(await c.chain.balance(cash.token, wallet) >= amount, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.money(amount, cash)}`);
    const view: View = { action: "earn_deposit", vault: address, name: vaultName(v, c.d), amount: amount.toString(), minShares: "0", feeBps: v.feeBps, ...inAsset(c, cash) };
    return settleFirst(c, address, view, `Deposit ${f.money(amount, cash)} into ${vaultName(v, c.d)} (${f.short(address)})`, vaultName(v, c.d));
  }
  requireThat(!p.refusal, vaultRefusal(p.refusal), refusalWords(p.refusal, cash, g.primary) ?? "The vault refuses this deposit");
  const minShares = slip(BigInt(p.shares), i.maxSlippageBps);
  requireThat(minShares > 0n, "ZERO_SHARES", REFUSALS.ZERO_SHARES!);
  await sameVaultAsset(c, address, cash);
  requireThat(await c.chain.balance(cash.token, wallet) >= amount, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.money(amount, cash)}`);
  const name = `${vaultName(v, c.d)} (${f.short(address)})`;
  return {
    view: { action: "earn_deposit", vault: address, name: vaultName(v, c.d), amount: amount.toString(), minShares: minShares.toString(), feeBps: v.feeBps, ...inAsset(c, cash) },
    summary: { title: `Deposit ${f.money(amount, cash)} into ${name}`, rows: [
      { label: "You deposit", value: f.money(amount, cash) },
      { label: "You receive at least", value: f.shares(minShares) },
      { label: "Performance fee", value: `${f.bps(v.feeBps)} of what the vault's loans return` },
      { label: "Taking it out", value: g.primary ? "Any time, up to the vault's free cash" : `Any time, in ${cash.symbol}, up to the vault's free ${cash.symbol}` },
    ] },
    steps: [
      ...await approval(c, cash.token, cash.symbol, wallet, address, amount),
      call("Deposit", address, encodeFunctionData({ abi: partnerVaultAbi, functionName: "deposit", args: [amount, minShares] }), true),
    ],
    notes: cash.stable ? [] : [`The vault counts in ${cash.symbol}: what you withdraw is ${cash.symbol}, and in dollars it moves with ${cash.symbol}'s price.`],
  };
}

async function earnRedeem(c: Ctx, i: Extract<ActionInput, { action: "earn_redeem" }>): Promise<Plan> {
  const wallet = i.wallet as Address;
  const { address, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset;
  const held = await c.chain.vaultShares(address, wallet);
  const asked = i.shares ? BigInt(i.shares) : held;
  requireThat(asked > 0n && asked <= held, "EXCEEDS_BALANCE", held === 0n ? "This wallet holds no shares of this vault" : REFUSALS.EXCEEDS_BALANCE!);
  const ask = (n: bigint) => c.indexer.get(`/intent/partners/vaults/${address.toLowerCase()}/preview?redeem=${n}&account=${wallet.toLowerCase()}`, previewAnswer);
  // Sized on the vault's own book, read on chain at one block (`redeemableShares`): everything is every share when this
  // wallet alone holds them, nothing is lent and the vault can pay them all; otherwise the most the free cash pays that
  // leaves a raw unit behind the shares that stay, since shares out with nothing behind them make the vault refuse every
  // deposit and redemption after (`Impaired`; the r9 e2e of 15 October 2026). A part asked for is sent as asked unless
  // it would leave the shares that stay with nothing behind them; then it is cut to the most that does not.
  const book = await c.chain.vaultBook(address);
  const scale = assetScale(cash);
  const fits = book.totalAssets > 0n && book.totalSupply >= held;
  const worth = (n: bigint) => (n * (book.totalAssets + scale)) / (book.totalSupply + VIRTUAL_SHARES);
  const all = redeemableShares(held, fits ? worth(held) : BigInt((await ask(held)).assets), cash, book);
  const everything = asked >= all;
  let shares = everything ? all : asked;
  if (everything) requireThat(all > 0n && (!fits || worth(all) > 0n), "TOO_SMALL", `What is left is too small to withdraw: under a millionth of a ${cash.symbol}`);
  else if (fits && shares < book.totalSupply) { const most = leavingSome(book, scale); if (shares > most) shares = most; }
  const kept = shares < asked;
  const p = await ask(shares);
  if (p.refusal === "SETTLEMENT_DUE") {
    // `assets`: what these shares are worth before the settlement books its loans, from the same preview the redemption
    // reads (the index prices it on the vault's book whatever it refuses): a write-off lowers it, so the withdrawal is
    // planned again, and its least amount (`minAssets`, 0 until then, as a deposit's `minShares`) set, once the settle is mined.
    const view: View = { action: "earn_redeem", vault: address, name: vaultName(v, c.d), shares: shares.toString(), assets: p.assets, minAssets: "0", all: everything, ...inAsset(c, cash) };
    return settleFirst(c, address, view, `Withdraw from ${vaultName(v, c.d)} (${f.short(address)})`, vaultName(v, c.d));
  }
  if (p.refusal === "INSUFFICIENT_LIQUIDITY" && p.availableNow) throw new ApiError("INSUFFICIENT_LIQUIDITY", `The vault can pay ${f.money(BigInt(p.availableNow), cash)} now; redeem fewer shares`);
  requireThat(!p.refusal, vaultRefusal(p.refusal), refusalWords(p.refusal, cash, g.primary) ?? "The vault refuses this redemption");
  const assets = BigInt(p.assets), minAssets = slip(assets, i.maxSlippageBps);
  const name = `${vaultName(v, c.d)} (${f.short(address)})`;
  // What stays and why: the free cash is short (a loan out, a reserve not payable now), or a raw unit stays behind the
  // shares left; a part cut short keeps something behind the wallet's other shares.
  const short = book.free + 1n < book.totalAssets;
  const note = !kept ? null
    : !everything ? `This part is cut to the most that leaves something behind your other shares: a vault with shares out and nothing behind them refuses every deposit and redemption.`
      : short ? `The rest stays in the vault until it has the ${cash.symbol} free to pay it.`
        : `A millionth of a ${cash.symbol} at most stays in the vault: after a loss it cannot pay its last holder's whole balance, and it never leaves shares with nothing behind them.`;
  return {
    view: {
      action: "earn_redeem", vault: address, name: vaultName(v, c.d), shares: shares.toString(), assets: assets.toString(), minAssets: minAssets.toString(),
      all: everything, ...inAsset(c, cash),
    },
    summary: { title: `Withdraw ${f.money(assets, cash)} from ${name}`, rows: [
      { label: "You redeem", value: shares === held ? `${f.shares(shares)} (all)` : everything && kept ? `${f.shares(shares)} (all the vault can pay)` : kept ? `${f.shares(shares)} (the most that leaves something behind your other shares)` : f.shares(shares) },
      { label: "You receive at least", value: f.money(minAssets, cash) },
    ] },
    steps: [call("Withdraw", address, encodeFunctionData({ abi: partnerVaultAbi, functionName: "redeem", args: [shares, minAssets] }), true)],
    notes: note ? [note] : [],
  };
}

/**
 * What is ready to collect here (the Portfolio's Collect all, PortfolioOverview): USDG credits, collateral, earnings,
 * rewards. A lend-asset generation's core and vaults are collected too (D251), their cash and earnings counted in their
 * own asset beside USDG's, never added to it. Each claim is simulated before it goes in, and one that would revert now
 * is left out and said, so the steps after it still go out, as the app's Collect all leaves it out (web/src/lib/walletBatch.ts):
 * a bridged sGAGE claim pays nothing while its source awaits an unlock (`GageV2Rewards.claim` reverts NothingToClaim
 * though `claimable` reads more). The first vault's credits and claims, earlier engines' lender recoveries, retired Earn
 * strategies and the GAGE/sGAGE pool's rewards and Drip are gage.cash's to collect.
 */
async function collect(c: Ctx, i: Extract<ActionInput, { action: "collect" }>): Promise<Plan> {
  const wallet = i.wallet as Address, now = c.now();
  const steps: Step[] = [], rows: Row[] = [];
  // A claim with what it adds to the figures, counted only once its simulation passes; past MAX_COLLECT_CLAIMS, said.
  const claims: { step: Step; count: () => void }[] = [];
  let more = 0;
  const claim = (step: Step, count: () => void) => {
    if (claims.length >= MAX_COLLECT_CLAIMS) { more += 1; return; }
    steps.push(step);
    claims.push({ step, count });
  };
  let cash = 0n;
  const back = new Map<string, bigint>();
  // Each lend asset's cash from loans and vault earnings, by token (USDG's stay in `cash` and `earned`).
  const others = new Map<string, { asset: LendAsset; cash: bigint; earnings: bigint }>();
  const other = (a: LendAsset) => {
    const key = a.token.toLowerCase();
    if (!others.has(key)) others.set(key, { asset: a, cash: 0n, earnings: 0n });
    return others.get(key)!;
  };
  const cores = [...c.d.engines, ...c.d.generations.filter((g) => !g.primary).map((g) => g.core)];
  const engines = await Promise.all(cores.map(async (e) => ({ e, credit: await c.chain.cashCredit(e.engine, wallet), loans: await walletLoans(c, e.engine, wallet) })));
  let sgage = 0n;
  for (const { e, credit, loans } of engines) {
    const paid = lendAssetOf(c.d, e.engine);
    if (credit > 0n) {
      if (same(paid.token, c.d.usdg)) cash += credit;
      else other(paid).cash += credit;
      steps.push(call(`Receive ${f.money(credit, paid)}`, e.engine, encodeFunctionData({ abi: engineAbi, functionName: "withdrawUSDG", args: [wallet] })));
    }
    for (const p of loans) {
      const id = BigInt(p.id), l = p.loan;
      // The index says where to look, the chain what is there: a listing is cancelled, and collateral taken back, only as
      // the core has the loan now (a borrower may cancel a listing at any time while it is funded, so a deadline the
      // index got wrong would cancel a live one).
      if ((l.state === 1 && same(l.originator, wallet)) || ((l.state === 3 || l.state === 5) && same(l.collateralBeneficiary, wallet))) {
        const onChain = await c.chain.loan(e.engine, id);
        const expired = onChain.state === 1 && same(onChain.originator, wallet) && now >= onChain.fundingDeadline;
        const waiting = (onChain.state === 3 || onChain.state === 5) && same(onChain.collateralBeneficiary, wallet);
        if ((expired || waiting) && !await c.chain.released(onChain.account)) {
          if (expired) steps.push(call(`Cancel unfunded loan #${p.id}`, e.engine, encodeFunctionData({ abi: engineAbi, functionName: "cancelFunding", args: [id] })));
          steps.push(takeBack(e, id, wallet));
          back.set(onChain.token.toLowerCase(), (back.get(onChain.token.toLowerCase()) ?? 0n) + onChain.collateral);
        }
      }
      const owed = BigInt(l.borrowerReward) > 0n || BigInt(l.lenderReward) > 0n ? await c.chain.loanRewards(e.rewards, id, wallet) : 0n;
      if (owed > SGAGE_DUST) {
        claim(call(`Claim sGAGE of loan #${p.id}`, e.rewards, encodeFunctionData({ abi: rewardsAbi, functionName: "claim", args: [id, wallet] })), () => { sgage += owed; });
      }
    }
  }
  let earned = 0n;
  const vaults = await allPartnerVaults(c.indexer, c.d);
  const holdings = await Promise.all(vaults.map(async ({ v, g }) => ({ v, g, h: await c.indexer.get(`/intent/partners/vaults/${v.address.toLowerCase()}/position/${wallet.toLowerCase()}`, holding) })));
  const ready = await claimablePockets(c, holdings.map(({ g, h }) => ({ engine: g.core.engine, pockets: h.pockets })));
  for (const [n, { v, g, h }] of holdings.entries()) {
    const pockets = ready[n]!.slice(0, MAX_CLAIM_POCKETS);
    const vault = v.address as Address;
    const rewards = BigInt(h.rewards) > SGAGE_DUST;
    // A call goes only to a vault the chain bears out as one of the generation's factory, lending on its core, as a
    // deposit's or a withdrawal's does (`partner`): the index names where to look, never what to call.
    if (!pockets.length && !rewards) continue;
    if (!await c.chain.isVault(g.factory, vault) || !same(await c.chain.vaultCore(vault), g.core.engine)) continue;
    if (pockets.length) {
      claim(call(`Collect from ${vaultName(v, c.d)} (${f.short(vault)})`, vault, pockets.length === 1
        ? encodeFunctionData({ abi: partnerVaultAbi, functionName: "claimPocket", args: [BigInt(pockets[0]!.id)] })
        : encodeFunctionData({ abi: partnerVaultAbi, functionName: "claimPockets", args: [pockets.map((p) => BigInt(p.id))] })), () => {
        for (const p of pockets) {
          if (same(p.token, c.d.usdg)) earned += BigInt(p.claimable);
          else if (!g.primary && same(p.token, g.lendAsset.token)) other(g.lendAsset).earnings += BigInt(p.claimable);
        }
      });
    }
    if (rewards) {
      claim(call(`Claim sGAGE of ${vaultName(v, c.d)} (${f.short(vault)})`, vault, encodeFunctionData({ abi: partnerVaultAbi, functionName: "claimRewards" })), () => { sgage += BigInt(h.rewards); });
    }
  }
  // One at a time, from the wallet at the head: a claim that would revert is left out, any other failure is the answer.
  const left: string[] = [];
  for (const x of claims) {
    try {
      await c.chain.simulate({ from: wallet, ...await x.step.build() });
      x.count();
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "SIMULATION_FAILED")) throw error;
      left.push(x.step.label);
      steps.splice(steps.indexOf(x.step), 1);
    }
  }
  const lent = [...others.values()];
  if (cash > 0n) rows.push({ label: "USDG from loans", value: f.usdg(cash) });
  for (const o of lent) if (o.cash > 0n) rows.push({ label: `${o.asset.symbol} from loans`, value: f.money(o.cash, o.asset) });
  const refs = await Promise.all([...back].map(async ([t, amount]) => ({ ...await collateralRef(c, getAddress(t)), amount })));
  if (back.size) rows.push({ label: "Collateral back", value: refs.map((r) => (r.symbol !== "tokens" || assetOf(c.d, r.token) ? f.token(r.amount, r.decimals, r.symbol) : "collateral")).join(", ") });
  if (earned > 0n) rows.push({ label: "Vault earnings", value: f.usdg(earned) });
  for (const o of lent) if (o.earnings > 0n) rows.push({ label: `Vault earnings in ${o.asset.symbol}`, value: f.money(o.earnings, o.asset) });
  if (sgage > 0n) rows.push({ label: "sGAGE rewards", value: `${f.units(sgage, 18, 2)} sGAGE` });
  const view: View = {
    action: "collect", usdg: cash.toString(), earnings: earned.toString(), sgage: sgage.toString(),
    collateral: refs.map(({ amount, ...r }) => ({ ...r, amount: amount.toString() })),
    ...(lent.length ? { others: lent.map((o) => ({ ...refOf(o.asset), cash: o.cash.toString(), earnings: o.earnings.toString() })) } : {}),
  };
  const notes = [
    ...(steps.length > 1 ? ["Each line is its own transaction."] : []),
    ...(left.length ? [`Left out, as ${left.length === 1 ? "it" : "each"} would revert now: ${left.join("; ")}. Collect again later.`] : []),
    ...(more ? ["More claims are ready: collect again once these have gone through."] : []),
  ];
  return { view, summary: { title: steps.length ? "Collect what is ready" : "Nothing is ready to collect", rows }, steps, notes };
}

/**
 * A rating of gage (D302): the wallet's own score, 0 to 100, for gage's entry in ERC-8004's Reputation Registry, tagged
 * `starred` as 8004scan reads a rating, with no other tag, endpoint or file. Only where gage has an entry (mainnet), once
 * a wallet, and never from a wallet that owns or operates the entry, whose rating the registry refuses.
 */
async function feedback(c: Ctx, i: Extract<ActionInput, { action: "feedback" }>): Promise<Plan> {
  const wallet = i.wallet as Address, b = defaultsFor(c.d.chainId).beacon;
  requireThat(b, "NO_ENTRY", "gage has an ERC-8004 entry on mainnet only: there is nothing to rate here", 404);
  const id = BigInt(b.agentId);
  requireThat(!await c.chain.agentAuthorized(b.identityRegistry, wallet, id), "OWN_ENTRY", "This wallet owns or operates gage's entry; the registry refuses its rating", 403);
  requireThat(await c.chain.feedbackCount(b.reputationRegistry, id, wallet) === 0n, "ALREADY_RATED", "This wallet has rated gage already: one rating a wallet");
  return {
    view: { action: "feedback", agentId: b.agentId, registry: b.reputationRegistry, score: i.score },
    summary: { title: `Rate gage ${i.score} out of 100`, rows: [
      { label: "Your score", value: `${i.score} out of 100` },
      { label: "Entry", value: `gage, agent #${b.agentId} in ERC-8004` },
      { label: "Seen by", value: "Anyone: a rating is public, and only this wallet can revoke it" },
    ] },
    steps: [call("Rate gage", b.reputationRegistry, encodeFunctionData({ abi: reputationAbi, functionName: "giveFeedback", args: [id, BigInt(i.score), 0, "starred", "", "", "", zeroHash] }), true)],
    notes: [],
  };
}

/**
 * The line an action's last transaction carries where gage has an ERC-8004 entry (D302): the agent may rate gage, once a
 * wallet, with its own score. Never on a rating itself, and never more than this line: a rating is optional, and gage
 * offers nothing for one.
 */
export function rateNote(c: Ctx, action: ActionInput["action"]): string | null {
  const b = defaultsFor(c.d.chainId).beacon;
  if (!b || action === "feedback") return null;
  return `Once this has gone through, you may rate gage, agent #${b.agentId} in ERC-8004, with the feedback action: your own score from 0 to 100, once a wallet. It is optional, and gage offers nothing for it.`;
}

export async function plan(c: Ctx, input: ActionInput): Promise<Plan> {
  switch (input.action) {
    case "borrow": return borrow(c, input);
    case "leverage": return leverage(c, input);
    case "cancel": return cancel(c, input);
    case "reclaim": return reclaim(c, input);
    case "cash_out": return cashOut(c, input);
    case "roll": return rollOver(c, input);
    case "auto_roll": return autoRoll(c, input);
    case "cancel_auto_roll": return cancelAutoRoll(c, input);
    case "earn_deposit": return earnDeposit(c, input);
    case "earn_redeem": return earnRedeem(c, input);
    case "collect": return collect(c, input);
    case "feedback": return feedback(c, input);
  }
}
