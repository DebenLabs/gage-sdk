/**
 * Each action as what is left to send from the wallet's current state: the approvals it still needs (exact amounts,
 * never unlimited), then the call. Re-planning after each transaction is how both an agent and a review link advance,
 * so every plan reads the chain fresh and nothing is remembered between calls. Every figure and word of a summary is
 * computed here from the chain and gage's own services; nothing an agent wrote is ever shown (D222).
 */
import { encodeFunctionData, erc20Abi, getAddress, parseEventLogs, zeroHash, type Address, type Hex, type Log } from "viem";
import { cashoutRouterAbi, engineAbi, loopRouterAbi, partnerVaultAbi, putRouterAbi, reputationAbi, rewardsAbi, rolloverRouterAbi } from "./abi.js";
import { askCashoutSale, directRoutes, ROUTE_MARGIN_BPS, routeNet, type CashoutSale, type CashoutWant } from "./cashout.js";
import type { AutoRollState, Chain, TickSource, VaultBook } from "./chain.js";
import { accounting, claimablePockets, eachRead, everyPartnerVault, holding, indexerOf, indexSilent, loanProven, loanRecord, partnerOnIndex, previewAnswer, vaultName, walletLoans, walletRights, type PartnerVault } from "./data.js";
import {
  assetOf, engineOf, generationOfCore, lendAssetOf, lendsMore, putGenerations, retiredCore, rolloverRouterOf,
  type Asset, type Deployment, type Engine, type Generation, type LendAsset, type LoopPool, type ParkKind, type ParkPool,
} from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import { bookGas, recordGas } from "./gas.js";
import { boundUnder, chooseSource, firstRunnable, fitsCap, loopSpendable, loopCall, loopCap, loopPayout, parseLoopBuy, rankLoopQuotes, type LoopBase, type LoopQuote } from "./loopSources.js";
import { principalFor, putBuy, rankSwaps, spendBound, swapOf, type PutSwap, type SwapQuote } from "./puts.js";
import { LOOP_SLIPPAGE_BPS, poolId, quoteExactOut, swapFeePips, type TickReader } from "./v4math.js";
import * as f from "./format.js";
import { defaultsFor, offeredTerms } from "./networks.js";
import { allocate, cheapestWhole, instant, loopPlan, preview, rollFigures, rollPlan, suggestCurve, type Allocation, type SignedRoll, type Terms } from "./intent.js";
import { lpPlan, type LpView } from "./lpPlans.js";
import { parkPlan } from "./park.js";
import { earnExitCancel, earnExitCollect, earnExitList, earnExitNow, exitCollectStep, exitOwed } from "./earnExit.js";
import { createVaultPlan, manageVaultPlan, type VaultView } from "./vaults.js";
import { rehypoExitNow } from "./rehypo.js";
import { listsWithRewards } from "./rewards.js";
import type { Preview } from "./preview.js";
import type { ActionInput } from "./schemas.js";
import type { Upstream } from "./upstream.js";

export interface Ctx {
  d: Deployment; chain: Chain; indexer: Upstream; rates: Upstream; now: () => number;
  /**
   * gage's valuation service, where leverage asks an aggregator's route for its purchase (D243): KyberSwap's, or on the
   * testnet gage's stand-in for its router (D245); without it, pools only.
   */
  valuation?: Upstream;
  /**
   * The index at a generation's own origin (D403): a current one's the release names, a retained one's
   * (`Deployment.retired`); without it, one read with the global fetch.
   */
  indexerAt?: (origin: string) => Upstream;
  /** Pools a caller adds to the deployment's for park and unpark (D334, `createGage({ parkPools })`): a DEX's own. */
  parkPools?: readonly ParkPool[];
  /** gage's index has not answered which generations were found since the release (src/discovery.ts): an engine not named yet may be one. */
  generationsUnread?: boolean;
}
export interface Row { label: string; value: string }
export interface Summary { title: string; rows: Row[] }
export interface Tx { to: Address; data: Hex; value: bigint }
/**
 * One transaction still to send. `final`: the action itself, sent once (a listing, a loop, a deposit, a redemption).
 * `extraGas`: gas added to the estimate, for a call whose estimate runs short: a vault's settle books each loan, and a
 * deposit or redemption claims for each of the vault's open reward records (src/gas.ts).
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
  /** A loop's amounts; on a lend asset's generation (`asset`), the loan's, the purchase's and what lands are in that asset. */
  | ({ action: "leverage" } & TokenRef & InAsset & {
    own: string; buy: string; multiple: number; principal: string; fee: string; cap: string; term: number; feeBps: number; costBps: number; maxCostBps: number;
    maxCost: string; ownValueUSDG: string; cashUSDG: string;
  })
  /** `collateralPaused`: the token cannot move now (D213), so the plan ends with the cancellation or repayment, and the pickup waits. */
  | ({ action: "cancel" } & TokenRef & { loanId: string; collateral: string; collateralPaused?: true })
  | ({ action: "reclaim" } & TokenRef & InAsset & { loanId: string; collateral: string; cap: string; endsAt: number; collateralPaused?: true })
  | ({ action: "cash_out" } & TokenRef & InAsset & {
    loanId: string; collateral: string; cap: string; gross: string; financeFee: string; fee: string; net: string; minimumNet: string; source: string | null;
  })
  | ({ action: "roll" } & TokenRef & InAsset & {
    loanId: string; collateral: string; oldPrincipal: string; oldCap: string; endsAt: number;
    principal: string; cap: string; term: number; fee: string; feeBps: number; payout: string; topUp: string; surplus: string;
    /** The approval: this loan's repayment and what the wallet's `otherAutoRolls` other loans rolling by themselves through the router still need. */
    allowance: string; otherAutoRolls: number;
  })
  | ({ action: "auto_roll" } & TokenRef & InAsset & {
    loanId: string; principal: string; term: number; maxCost: string; maxTopUp: string; rolls: number; window: number; until: number;
    /** The approval: this loan's four rolls and what the wallet's `otherAutoRolls` other loans rolling by themselves through the router still need. */
    allowance: string; otherAutoRolls: number; executor: Address;
  })
  | ({ action: "cancel_auto_roll" } & TokenRef & { loanId: string; rollsLeft: number })
  /**
   * A put opened (docs/api.md "Puts on lend-asset generations"): the pledge's token (USDG) and its `margin`, `buy` and
   * `pledgeValue` in it; the loan, its fee, the purchase's most (`maxCost`) and what lands besides (`cash`) in `asset`.
   */
  | ({ action: "put_open" } & TokenRef & InAsset & {
    margin: string; buy: string; size: number; principal: string; fee: string; cap: string; term: number; feeBps: number; costBps: number; maxCostBps: number;
    maxCost: string; cash: string; pledgeValue: string;
  })
  /** A loan closed out of its pledge: the repayment (`cap`) in `asset`; what buys it back (`spend`, at most `maxSpend`) and what comes back (`back`, at least `minBack`) in the pledge's token. */
  | ({ action: "put_close" } & TokenRef & InAsset & { loanId: string; collateral: string; cap: string; endsAt: number; spend: string; maxSpend: string; back: string; minBack: string })
  /** A put rolled over: a roll's figures in `asset`, and the pledge's token that buys the top-up (`spend`, at most `maxSpend`). */
  | ({ action: "put_roll" } & TokenRef & InAsset & {
    loanId: string; collateral: string; oldPrincipal: string; oldCap: string; endsAt: number;
    principal: string; cap: string; term: number; fee: string; feeBps: number; payout: string; topUp: string; surplus: string; spend: string; maxSpend: string;
  })
  /** A put left to roll by itself: its ceiling (`maxCost`) and the payouts passed back (`passThrough`) in `asset`, each roll's spend (`maxSpend`) and `allowance` in the pledge's token. */
  | ({ action: "put_auto_roll" } & TokenRef & InAsset & {
    loanId: string; principal: string; term: number; maxCost: string; maxSpend: string; rolls: number; window: number; until: number;
    /** The approvals: this put's four rolls and what the wallet's `otherAutoRolls` other puts rolling by themselves still need. */
    allowance: string; passThrough: string; otherAutoRolls: number; executor: Address;
  })
  | ({ action: "put_cancel_auto_roll" } & TokenRef & { loanId: string; rollsLeft: number })
  | ({ action: "earn_deposit"; vault: Address; name: string; manager: string; amount: string; minShares: string; feeBps: number } & InAsset)
  | ({ action: "earn_redeem"; vault: Address; name: string; shares: string; assets: string; minAssets: string; all: boolean } & InAsset)
  | {
    action: "collect"; usdg: string; collateral: (TokenRef & { amount: string })[]; earnings: string; sgage: string;
    /** Each lend asset's cash from loans and vault earnings, beside USDG's and never added to them (D251). */
    others?: (TokenRef & { cash: string; earnings: string })[];
    /** Collateral the vaults recovered from loans written off, by token: a vault's pocket in any token but its own asset. */
    recovered?: (TokenRef & { amount: string })[];
    /**
     * Backing anyone added to loans the vaults wrote off (`recapitalize`, D329), by asset, never counted as earnings:
     * what this collect's claims take, each loan's next claim (the oldest 64 of its pockets) as the index sums it by
     * loan (D414), or a vault's pocket in its own asset that an older index names `RECAPITALIZATION`.
     */
    backing?: (TokenRef & { amount: string })[];
    /** What exit now sales paid the wallet (Intent D57), by asset: the exit desk's to withdraw, where a release names one. */
    exits?: (TokenRef & { amount: string })[];
  }
  /** A rating of gage (D302): its ERC-8004 agent id, the Reputation Registry it goes to and the score, 0 to 100. */
  | { action: "feedback"; agentId: number; registry: Address; score: number }
  /**
   * A position parked (D334): pulled out on its own DEX at `manager`, the one token it held (`token`, `amount`)
   * deposited into a partner vault.
   */
  | ({ action: "park"; kind: ParkKind; manager: Address; id: string; pool: Hex; poolName: string; vault: Address; name: string; amount: string; feeBps: number } & TokenRef & InAsset)
  /**
   * A position unparked (D334): `amount` of the vault's asset (`token`) withdrawn, and a position minted in
   * [tickLower, tickUpper] with `liquidity`, taking `other` from the wallet too where the range is around the price.
   */
  | ({
    action: "unpark"; vault: Address; name: string; amount: string; kind: ParkKind; manager: Address; pool: Hex; poolName: string; tickLower: number; tickUpper: number;
    liquidity: string; other: (TokenRef & { amount: string }) | null;
  } & TokenRef & InAsset)
  /**
   * A rehypo pool's exit now (root D357): the wallet's share of what `source` holds (`claim`) and what it can pay now
   * (`payableNow`), in its vault's asset, and the holding the exit desk lists (`loanId`; null while the source's own
   * listing is live), with where the desk would stop its price now (`floorBps`, SEC-01: null with `loanId`, or where the
   * share views answer no `exitShare`).
   */
  | ({
    action: "rehypo_exit_now"; source: Address; vault: Address; name: string; loanId: string | null; claim: string; payableNow: string; need: string | null;
    floorBps: number | null; endsAt: number; lapsed: boolean;
  } & TokenRef & InAsset)
  /**
   * A partner vault's exit now (Intent D57): the wallet's `shares` committed at the chain's exit desk and what they are
   * worth at today's share value (`assets`; `all`, every share), of which the vault can pay `payableNow`; the holding
   * the desk lists (`loanId`) and what the vault cannot pay of them (`need`), both null while a settle comes first; where
   * the desk would stop its price for this exit now (`floorBps`, SEC-01: in basis points of what the loan has still to earn
   * kept above book value; null with `loanId`, or where the share views answer no `exitShare`); when this request lapses
   * (`lapsesAt`); and whether it renews one that had (`lapsed`).
   */
  | ({
    action: "earn_exit_now"; vault: Address; name: string; shares: string; assets: string; all: boolean; payableNow: string; loanId: string | null; need: string | null;
    floorBps: number | null; lapsesAt: number; lapsed: boolean;
  } & InAsset)
  /**
   * An open exit's next listing: the `shares` it commits, the holding listed (`loanId`), what the vault cannot pay of it
   * (`need`) and where the desk would stop its price (`floorBps`, as `earn_exit_now`'s), all null while a settle comes first.
   */
  | ({ action: "earn_exit_list"; vault: Address; name: string; shares: string; loanId: string | null; need: string | null; floorBps: number | null; lapsesAt: number } & InAsset)
  /** An exit withdrawn: the `shares` it committed, and the holding of its listing still live (`listed`), which stays until it ends and no longer sells for this exit; another exit may take it over and sell it (ED2). */
  | ({ action: "earn_exit_cancel"; vault: Address; name: string; shares: string; listed: string | null; lapsed: boolean } & InAsset)
  /** What the exit desks owe the wallet from its exits' sales, by desk and asset. */
  | { action: "earn_exit_collect"; owed: (TokenRef & { desk: Address; amount: string })[] }
  /** The LP lane's actions (docs/api.md "LP lane"), all in USDG: lpPlans.ts. */
  | LpView
  /** A partner vault created and managed: vaults.ts. */
  | VaultView;
/** The loan an action opened, read from its own receipt: a listing's id, a loop's, a roll's new loan. */
export interface Made { engine: Address; loanId: string }
export interface Plan {
  summary: Summary; view: View; steps: Step[]; notes: string[];
  /** For an action that opens a loan: its id from the final step's logs, or null when they name none for this wallet. */
  made?: (logs: readonly Log[]) => Made | null;
  /** For an action that creates a partner vault: its address from the final step's logs, or null when they name none for this wallet. */
  vault?: (logs: readonly Log[]) => Address | null;
  /** The steps come first, then the action is planned again from the chain: a vault's settle before a deposit. */
  again?: true;
  /** Part of what the plan reads did not answer: what it lists stands, and more may be ready once it answers. */
  partial?: true;
  /**
   * Every step is built from one reading of the chain and they go together (park and unpark, D334): in order, each once
   * the one before is mined, or as one batch (EIP-5792). Planned again between them, the action would read a position
   * already pulled out, or a vault already withdrawn from.
   */
  batch?: true;
  /** What the action does for the wallet over time, as numbers to draw (`renderPreview`, gage-sdk/visual). */
  preview?: Preview;
}
/** The first log of `abi`'s `eventName` that `address` emitted and `match` accepts, among a receipt's logs. */
export function eventOf<const A extends readonly unknown[]>(abi: A, eventName: string, address: Address, logs: readonly Log[], match: (args: Record<string, unknown>) => boolean) {
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
/** The chain's clock, which judges a loan's end: the machine asking may be ahead of it or behind. */
const chainNow = async (c: Ctx) => (await c.chain.head()).timestamp;
const tx = (to: Address, data: Hex): Tx => ({ to, data, value: 0n });
const call = (label: string, to: Address, data: Hex, final = false): Step => ({ label, kind: "action", final, build: () => Promise.resolve(tx(to, data)) });

export async function approval(c: Ctx, token: Address, symbol: string, wallet: Address, spender: Address, amount: bigint): Promise<Step[]> {
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
  // A put's pledge (docs/api.md "Puts on lend-asset generations"): USDG, at its own decimals.
  if (same(token, c.d.usdg)) return refOf(c.d.generations[0]!.lendAsset);
  const named = c.d.generations.flatMap((g) => g.collateral).find((x) => same(x.token, token));
  // Named or not, its decimals are the token's own: a token listed nowhere still counts in them.
  try { return { token, symbol: named?.symbol ?? "tokens", decimals: (await c.chain.tokenInfo(token)).decimals }; } catch { return tokenRef(c, token); }
}
export const refOf = (a: LendAsset): TokenRef => ({ token: a.token, symbol: a.symbol, decimals: a.decimals });
/** The asset fields a view adds once the release makes a lend asset public (D251); none before, so it reads as it did. */
export const inAsset = (c: Ctx, a: LendAsset, engine?: Address): InAsset => (lendsMore(c.d) ? { asset: refOf(a), ...(engine ? { engine } : {}) } : {});
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
  if (!g && c.generationsUnread) throw new ApiError("UNAVAILABLE", "gage's index has not said which assets it lends yet; try again shortly", 503, true);
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
  // USDG, a put's pledge, takes a stock's lane on a lend asset (docs/api.md "Puts on lend-asset generations"): its value
  // in the asset moves as the asset does. Every other token a non-stable asset lends against is a meme (D249).
  if (same(named.token, c.d.usdg)) return { token: named.token, symbol: named.symbol, name: named.symbol, decimals: c.d.generations[0]!.lendAsset.decimals, lane: "STOCK" };
  const { decimals } = await c.chain.tokenInfo(named.token);
  return { token: named.token, symbol: named.symbol, name: named.symbol, decimals, lane: "MEME" };
}
/** Before any write (Intent D55): the core still pays and is repaid in the asset the plan counts in. */
async function sameCoreAsset(c: Ctx, core: Address, a: LendAsset) {
  requireThat(same(await c.chain.coreAsset(core), a.token), "ASSET_CHANGED", `This core is not paid in ${a.symbol}; read it again before acting`);
}
/**
 * The generation `leverage` borrows from: USDG's, when `lendAsset` is omitted or names USDG; any other asset is refused
 * in fixed words (D251). A lend asset's loop router opens puts alone (D313), and a put opens with `put_open`, sized as a
 * put (`putTerms`): one way to open each position.
 */
export function loopGenerationFor(c: Ctx, lendAsset?: string): Generation {
  const usdg = c.d.generations[0]!;
  if (!lendAsset || same(lendAsset, usdg.lendAsset.token)) return usdg;
  const puts = putGenerations(c.d).find((x) => same(x.lendAsset.token, lendAsset));
  throw new ApiError("LEVERAGE_CLOSED", puts
    ? `Leverage lends USDG only; borrow ${puts.lendAsset.symbol} against USDG with put_open, or in another asset with gage_prepare_borrow`
    : "Leverage lends USDG only; borrow in another asset with gage_prepare_borrow");
}
/**
 * The generation a put opens on (`putGenerations`): a public lend asset's that lends against USDG through its loop and
 * put routers; any other asset is refused in fixed words.
 */
export function putGenerationFor(c: Ctx, lendAsset: string): Generation {
  const offered = putGenerations(c.d);
  const g = offered.find((x) => same(x.lendAsset.token, lendAsset));
  requireThat(g, "PUT_CLOSED", offered.length ? `Puts are offered on ${offered.map((x) => x.lendAsset.symbol).join(", ")} only` : "Puts are not offered on this deployment");
  return g;
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

/** How much of a pledge's value a loan may repay, as the model is asked (70% for memes, 90% for stocks and ETH, and USDG on a lend asset). */
export const repaymentLimitBps = (lane: string) => (lane === "MEME" ? 7_000 : 9_000);
/** A cost in tenths of a basis point, as the vaults' floors read it, applied to a principal: the repayment, rounded up. */
export const capAt = (principal: bigint, tenths: number) => principal + (principal * BigInt(tenths) + 99_999n) / 100_000n;

/** D384: gage's quotes never price a loan under grade D, half the model's cost of it, though a vault with no rate grade takes any. */
const LOWEST_GRADE_PCT = 50;
/**
 * D384: the fall in a pledge's worth a cheaper cost must survive while its listing waits for gage's keeper, bps: a meme's
 * 2%, a stock's or ETH's 0.5%. A vault's floor is its grade's share of the model's cost of the loan, which rises as the
 * pledge falls: a meme's by about 4–5% for each 1% it falls (mainnet, 2 November 2026).
 */
const cushionBps = (lane: string) => (lane === "MEME" ? 200 : 50);
type Reading = Awaited<ReturnType<typeof preview>>;

/** A reading, or null where the rates service refused or could not answer it: a cheaper cost then goes unchecked. */
export const checked = (reading: Promise<Reading>) => reading.catch((error: unknown) => { if (error instanceof ApiError) return null; throw error; });

/**
 * The lowest fixed cost the vaults funding a loan accept and still accept once its pledge has fallen by its cushion while
 * the listing waits for gage's keeper (D384), from terms the preview funds whole at `from.tenths`: the cheapest floor at
 * which the vaults would take all four quarters of the same loan on that smaller pledge (`cheapestWhole`), checked with
 * the preview on the loan's own terms at that cost. A roll is funded as it is listed and keeps no cushion (D285).
 * Never under grade D of the model's cost nor a tenth of a basis point, never over `from.tenths`: a reading that refuses,
 * fails or does not fund the loan whole, the smaller pledge's included, leaves `from`.
 */
export async function lowestCost(c: Ctx, core: Address, t: Omit<Terms, "cap">, lane: string, borrower: Address, from: { tenths: number; reading: Reading }) {
  const model = from.reading.modelBps;
  if (model === null) return from;
  const fallen = await checked(preview(c.rates, core, { ...t, collateral: (t.collateral * BigInt(10_000 - cushionBps(lane))) / 10_000n, cap: capAt(t.principal, from.tenths) }, borrower));
  const floor = fallen?.fills ? cheapestWhole(fallen.vaults) : null;
  if (floor === null) return from;
  const next = Math.max(floor, Math.ceil((model * LOWEST_GRADE_PCT) / 10), 1);
  if (next >= from.tenths) return from;
  const reading = await checked(preview(c.rates, core, { ...t, cap: capAt(t.principal, next) }, borrower));
  return reading?.fills ? { tenths: next, reading } : from;
}

/**
 * One exact loan priced as the borrow card prices an amount (D261), on a generation's core: its cost is the model's for
 * that amount on this pledge (the size curve's first point at or above it), raised to the model's cost of these exact
 * terms when that is higher, and to the lowest cost at which the vaults' settings take the loan whole when they refuse it
 * at this one, in at most three readings of the funding preview. `value` is the pledge's worth in the generation's
 * asset; `tooHigh(most)` is the refusal when the pledge supports less than `principal`. A borrow quote prices an
 * amount so (reads.ts `exactQuote`), and a put its loan. A borrow quote's `how` (D384): `cost`, the borrower's own in
 * tenths of a basis point, is read as it is; `lowest` raises the cost only while the vaults do not fund the loan whole,
 * then lowers it to the lowest cost those funding it accept (`lowestCost`). A put asks for neither.
 */
export async function priceExact(
  c: Ctx, g: Generation, a: Pick<Asset, "token" | "lane">, collateral: bigint, principal: bigint, term: number, borrower: Address, tooHigh: (most: bigint) => ApiError,
  how: { cost?: number; lowest?: boolean } = {},
) {
  const core = g.core.engine;
  const sized = await suggestCurve(c.rates, { chainId: c.d.chainId, engine: core, token: a.token, collateral, term, maxRepaymentBps: repaymentLimitBps(a.lane), ...(g.primary ? {} : { asset: g.lendAsset.token }) });
  const at = sized.curve.find((p) => p.principal >= principal);
  if (!at) throw tooHigh(sized.curve.at(-1)?.principal ?? 0n);
  const t = { token: a.token, collateral, principal, term };
  let tenths = how.cost ?? at.costBps * 10;
  let p = await preview(c.rates, core, { ...t, cap: capAt(principal, tenths) }, borrower);
  for (let pass = 1; how.cost === undefined && !(how.lowest && p.fills) && pass < 3; pass += 1) {
    const model = p.modelBps === null ? 0 : p.modelBps * 10, floor = p.accepts === false ? p.acceptFloorTenths ?? 0 : 0;
    const raised = Math.max(model, floor);
    if (raised <= tenths || raised > 50_000) break;
    tenths = raised;
    p = await preview(c.rates, core, { ...t, cap: capAt(principal, tenths) }, borrower);
  }
  if (how.lowest && how.cost === undefined && p.fills) ({ tenths, reading: p } = await lowestCost(c, core, t, a.lane, borrower, { tenths, reading: p }));
  return { cap: capAt(principal, tenths), tenths, value: sized.value, preview: p };
}

/**
 * Terms no partner vault's settings take (D247), refused with the change the borrow card offers: a smaller loan the vaults
 * accepting this cost take, else the cost at which they take this one; both in the details, null where there is none.
 */
function notAccepted(p: { acceptFloorTenths: number | null; acceptMaxPrincipal: bigint | null }, cash: LendAsset): never {
  const largest = p.acceptMaxPrincipal !== null && p.acceptMaxPrincipal > 0n ? p.acceptMaxPrincipal : null;
  const words = largest !== null ? `No partner vault's settings take a loan this large at this cost: borrow up to ${f.money(largest, cash)}`
    : p.acceptFloorTenths !== null ? `No partner vault's settings take this loan at this cost: raise it to at least ${f.bpsTenths(p.acceptFloorTenths)}`
      : "No partner vault lends against this token for this term now";
  throw new ApiError("TERMS_NOT_ACCEPTED", words, 409, false,
    { details: { lowestCostBps: p.acceptFloorTenths === null ? null : p.acceptFloorTenths / 10, largestPrincipal: largest?.toString() ?? null } });
}

/**
 * What a listing's preview answers when its model withholds a cost: the pledge's own curve says when that is a loan larger
 * than the pledge supports, which asking again never clears, and the most it does; otherwise that refusal stands.
 */
async function tooThin(c: Ctx, g: Generation, a: Asset, collateral: bigint, principal: bigint, term: number, error: unknown): Promise<never> {
  if (error instanceof ApiError && error.code === "PRICING_UNAVAILABLE") {
    const sized = await suggestCurve(c.rates, { chainId: c.d.chainId, engine: g.core.engine, token: a.token, collateral, term, maxRepaymentBps: repaymentLimitBps(a.lane), ...(g.primary ? {} : { asset: g.lendAsset.token }) }).catch(() => null);
    const most = sized?.curve.at(-1)?.principal;
    if (most !== undefined && most < principal) {
      throw new ApiError("PRINCIPAL_TOO_HIGH", `This pledge supports a loan of at most ${f.money(most, g.lendAsset)} now; borrow less or pledge more`, 409, false, { details: { maxPrincipal: most.toString() } });
    }
  }
  throw error;
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
  const [funded, value] = await Promise.all([
    preview(c.rates, core, terms, wallet).catch((error: unknown) => tooThin(c, g, a, collateral, principal, i.term, error)),
    g.primary ? pledgeValue(c, core, a.token, collateral, i.term, wallet) : null,
  ]);
  // D247 in gage-sdk (D384): never a listing no partner vault's settings take; one that fits a vault without the cash now lists.
  if (funded.accepts === false) notAccepted(funded, cash);
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
      // Its sGAGE is asked for only where the core's ledger can pay it when the listing is sent (R2 option C, src/rewards.ts).
      { label: "Borrow", kind: "action", final: true, build: async () => tx(core, encodeFunctionData({ abi: engineAbi, functionName: "list",
        args: [{ kind: 0, token: a.token, amountOrTokenId: collateral }, principal, cap, i.term, deadline, await listsWithRewards(c.chain, g.core, i.term, principal)] })) },
    ],
    made: (logs) => {
      const listed = eventOf(engineAbi, "Listed", core, logs, (x) => same(String(x.borrower), wallet));
      return listed ? { engine: core, loanId: String(listed.id) } : null;
    },
    notes: [
      `The partner vaults fund the listing; it stays open for them until ${f.date(deadline)}, then the collateral can be taken back.`,
      ...(funded.fills ? [] : [funded.accepts
        ? "No partner vault has the cash or room for all of this loan now: it waits, listed, until one does."
        : "The partner vaults would not fund all of this loan right now: it may stay unfunded. gage_borrow_quote gives terms they fund."]),
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
 * What buying exactly `amount` of `out` through one pool costs now, paid in `pay`, the pool's other token, as its own
 * exact-output swap would charge it: from the active range and across every initialized tick the swap reaches
 * (`quoteExactOut`); null where it cannot sell that much. A V3 pool (D242) sorts its tokens by address and prices as a v4
 * pool does, its fee tier all the swapper pays; one whose fee is not the manifest's is not the pool a router would find.
 * A loop buys its collateral token with the loan's asset; a put router buys the loan's asset with the pledge's token.
 */
async function exactOutCost(c: Ctx, p: LoopPool, pay: Address, out: Address, amount: bigint): Promise<bigint | null> {
  if (p.kind === "v4") {
    if (!c.d.stateView) return null;
    const payZero = same(p.key.currency0, pay), id = poolId(p.key);
    const s = await c.chain.poolState(c.d.stateView, id);
    const pool = { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: s.liquidity, feePips: swapFeePips(s.lpFee, s.protocolFee, payZero), tickSpacing: p.key.tickSpacing };
    return quoteExactOut(pool, amount, payZero, tickReader(c, { kind: "v4", stateView: c.d.stateView, poolId: id }));
  }
  const s = await c.chain.v3PoolState(p.pool);
  if (s.fee !== p.fee) return null;
  const payZero = BigInt(pay) < BigInt(out);
  const pool = { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: s.liquidity, feePips: BigInt(s.fee), tickSpacing: s.tickSpacing };
  return quoteExactOut(pool, amount, payZero, tickReader(c, { kind: "v3", pool: p.pool }));
}

/** What buying exactly `buy` of `a` with `cash`, the loan's asset, costs through one pool now (`exactOutCost`). */
async function poolQuote(c: Ctx, cash: Address, a: Asset, p: LoopPool, buy: bigint): Promise<LoopQuote | null> {
  const cost = await exactOutCost(c, p, cash, a.token, buy);
  if (cost === null) return null;
  return p.kind === "v4" ? { kind: "v4", key: p.key, cost } : { kind: "v3", pool: p.pool, fee: p.fee, cost };
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
 * Every source of the purchase quoted now, cheapest first (`rankLoopQuotes`): the token's pools on the generation's
 * core (`loopPools`), V3 ones only when the router buys through V3 (one built before D242 has no V3 factory), and
 * KyberSwap for USDG's generation, whose loops alone the valuation service routes. A pool whose read fails is left out,
 * unless every one fails and nothing else quotes: then that failure is the answer.
 */
async function loopQuotes(c: Ctx, g: Generation, a: Asset, buy: bigint, router: Address, via: ViaAsk = {}): Promise<LoopQuote[]> {
  const all = g.loopPools.get(a.token.toLowerCase()) ?? [];
  const v3 = all.some((p) => p.kind === "v3") && await c.chain.loopV3Factory(router) !== null;
  const pools = all.filter((p) => p.kind === "v4" || v3);
  const [direct, routed] = await Promise.all([
    Promise.allSettled(pools.map((p) => poolQuote(c, g.lendAsset.token, a, p, buy))), g.primary ? viaQuote(c, a, buy, router, via) : null,
  ]);
  const ranked = rankLoopQuotes([...direct.map((r) => (r.status === "fulfilled" ? r.value : null)), routed]);
  const failed = direct.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (!ranked.length && failed && direct.every((r) => r.status === "rejected")) throw failed.reason;
  return ranked;
}

/**
 * Leverage's terms, as the borrow card works them out (BorrowView `leverV2`): the instant loan for the pledge, times the
 * multiple. `via` is what KyberSwap's route is asked for with (a wallet's approval already in place). `g` is the
 * generation the loan is borrowed from: USDG's, or a lend asset's that names its loop router, whose loan buys the
 * collateral with that asset through its own pools (`loopGenerationFor`).
 */
export async function leverageTerms(c: Ctx, token: string, own: bigint, multiple: number, term: number, wallet?: Address, via: ViaAsk = {}, g: Generation = c.d.generations[0]!) {
  const router = g.loopRouter, cash = g.lendAsset;
  requireThat(router, "LEVERAGE_CLOSED", "Leverage is not open on this deployment");
  const a = await collateralOf(c, g, token);
  requireThat(g.loopPools.get(a.token.toLowerCase())?.length, "NO_LEVERAGE_POOL", `Leverage does not buy ${a.symbol}`);
  // With no wallet yet, read as a listing's own preview reads it: the router is a filler, which no vault funds.
  const borrower = wallet ?? g.core.engine;
  const offered = await termsOf(c, g.core.registry);
  requireThat(offered.includes(term), "TERM_NOT_ALLOWED", `Allowed terms: ${offered.map(f.days).join(", ")}`);
  const q = await instant(c.rates, g.core.engine, a.token, own, term, wallet);
  const t = BigInt(Math.round(multiple * 10_000));
  const pledge = q.collateral, buy = (pledge * (t - 10_000n)) / 10_000n;
  const principal = (q.principal * t) / 10_000n, cap = (q.cap * t) / 10_000n;
  // The most the purchase may cost, as a quote states it: the cheapest source's bound now, a pool's exact-output quote
  // plus the slippage the router allows, as the app prices it (web/src/borrow/loop.ts `loopMaxCost`), or KyberSwap's
  // own bound (D243); a prepare holds the loop to the bound of the source it is planned through (`chooseSource`). 4 October 2026: a bound of 4% over the tokens' value with 0.6% shown let a wallet pay
  // about 3.4% of the purchase more than the plan said.
  requireThat(c.d.stateView, "LEVERAGE_CLOSED", "Leverage is not open on this deployment");
  const quoted = await loopQuotes(c, g, a, buy, router, via);
  requireThat(quoted.length, "POOL_TOO_THIN", `No ${a.symbol} pool can sell that much now; try a lower multiple`);
  const feeBps = await c.chain.feeBps(g.core.registry);
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
    `Buying the ${a.symbol} costs up to ${f.owedIn(least, cash)}, more than the loan pays out with a quarter of a percent of it spare; try a lower multiple`);
  const maxCost = loopCap(sources[0]!);
  const terms: Terms = { token: a.token, collateral: pledge + buy, principal, cap, term };
  const funded = await preview(c.rates, g.core.engine, terms, borrower);
  const allocation = funded.fills ? allocate(funded.vaults) : null;
  requireThat(allocation, "INSUFFICIENT_CAPACITY", "The partner vaults cannot fund this loop whole now; try a lower multiple or a smaller pledge");
  // What lands besides the tokens, at the least: the loan less its fee and the most the purchase may cost (the app's `cash`).
  const lands = principal - fee > maxCost ? principal - fee - maxCost : 0n;
  return {
    g, a, router, own: pledge, pledge, buy, principal, cap, maxCost, fee, feeBps, cash: lands, spendable, costBps: costBps(principal, cap), valueUSDG: q.valueUSDG, terms,
    allocation, expiresAt: q.expiresAt, sources,
  };
}

/** What a loop's plan is built from, a leverage's (`leverageTerms`) or a put's (`putTerms`). */
interface LoopTerms {
  g: Generation; a: Asset; router: Address; own: bigint; buy: bigint; principal: bigint; fee: bigint; spendable: bigint;
  terms: Terms; allocation: Allocation[]; sources: LoopQuote[];
}
/** How a loop's refusals name it: a leverage's loop and multiple, a put and its size, and the code for a purchase the loan cannot pay. */
interface LoopWords { noun: "loop" | "put"; knob: "multiple" | "size"; unaffordable: string }
const LEVERAGE_WORDS: LoopWords = { noun: "loop", knob: "multiple", unaffordable: "MULTIPLE_TOO_HIGH" };
const PUT_WORDS: LoopWords = { noun: "put", knob: "size", unaffordable: "SIZE_TOO_HIGH" };

/**
 * Which source a loop is planned through, and the loan's asset approved for it (D243), a leverage's or a put's alike:
 * the most the purchase may cost when the loop runs is what the loan pays out, its principal less its fee, less the
 * spare kept (D271), never the wallet's own funds or its credit on the core besides. Once the pledge is approved
 * (`approved.own`), each source the asset's approval (`approved.cash`) covers is tried, cheapest first: one whose loop
 * would revert is passed over, and the next one's own bound is approved when it is above the approval. `build` sends it:
 * every source quoted again under the bound approved (KyberSwap's route kept at the spend quoted for the plan while it
 * still buys the purchase), the plan signed, then the first source that fits and simulates encoded; a loop already
 * tried here is sent as it was, once.
 */
async function loopThrough(c: Ctx, x: LoopTerms, wallet: Address, approved: { own: bigint; cash: bigint }, w: LoopWords): Promise<{ maxCost: bigint; build: () => Promise<Tx> }> {
  const { g, router } = x, cash = g.lendAsset;
  // The plan for the loop, signed for the core's next listing (it does not depend on the source, and lives 30 seconds).
  const sign = async (): Promise<LoopBase> => {
    const deadline = c.now() + LISTING_SECONDS;
    const signed = await loopPlan(c.rates, { engine: g.core.engine, router, borrower: wallet, terms: x.terms, deadline, allocations: x.allocation, now: c.now() });
    // The loop lists and fills its loan at once: its sGAGE only where the core's ledger pays it (R2 option C).
    const withRewards = await listsWithRewards(c.chain, g.core, x.terms.term, x.terms.principal);
    return {
      own: x.own, buy: x.buy, fundingDeadline: deadline, withRewards, pricing: signed.pricing, plan: signed.plan, signature: signed.signature,
      maxReserveShares: signed.plan.allocations.map((al) => al.maxReserveShares),
    };
  };
  const built = (base: LoopBase, q: LoopQuote, bound: bigint) => tx(router, encodeFunctionData({ abi: loopRouterAbi, ...loopCall(q, base, bound) }));
  const funds = x.spendable;
  const room = approved.cash < funds ? approved.cash : funds;
  // Signed before the walk, so that a plan the rates service does not sign is its own refusal, never a source's revert.
  const base = approved.own >= x.own && x.sources.some((q) => boundUnder(q, room) !== null) ? await sign() : null;
  let tried: Tx | null = null;
  const choice = await chooseSource(x.sources, approved.cash, funds, base
    ? async (q, bound) => {
      const t = built(base, q, bound);
      await c.chain.simulate({ from: wallet, ...t });
      tried = t;
    }
    : undefined);
  requireThat(choice.kind !== "unaffordable", w.unaffordable,
    `Buying the ${x.a.symbol} costs at least ${f.owedIn(x.sources[0]!.cost, cash)}, more than the loan pays out; try a lower ${w.knob}`);
  if (choice.kind === "reverts") {
    throw new ApiError("SIMULATION_FAILED", `The ${w.noun} would revert now through every source of the ${x.a.symbol}; prepare it again shortly`, 409);
  }
  const maxCost = choice.bound;
  const planned = x.sources.find((q): q is Extract<LoopQuote, { kind: "via" }> => q.kind === "via");
  const build = async (): Promise<Tx> => {
    if (tried) {
      const t: Tx = tried;
      tried = null;
      return t;
    }
    const sources = await loopQuotes(c, g, x.a, x.buy, router, { hint: planned?.spend, room: maxCost });
    const signed = await sign();
    const chosen = await firstRunnable(sources, maxCost, (q, bound) => c.chain.simulate({ from: wallet, ...built(signed, q, bound) }));
    if (chosen) return built(signed, chosen.q, chosen.bound);
    requireThat(sources.length, "POOL_TOO_THIN", `No ${x.a.symbol} pool can sell that much now; prepare the ${w.noun} again with a lower ${w.knob}`);
    requireThat(sources.some((q) => fitsCap(q, maxCost)), "PRICE_MOVED", `Buying the ${x.a.symbol} costs more now than the ${f.owedIn(maxCost, cash)} approved for it; prepare the ${w.noun} again`);
    throw new ApiError("SIMULATION_FAILED",
      `The ${w.noun} would revert now through every source under its approved cost; prepare it again: a source that keeps reverting is passed over for the next one, which may need a larger ${cash.symbol} approval`, 409);
  };
  return { maxCost, build };
}

async function leverage(c: Ctx, i: Extract<ActionInput, { action: "leverage" }>): Promise<Plan> {
  const g = loopGenerationFor(c, i.lendAsset), cash = g.lendAsset;
  const wallet = i.wallet as Address;
  // The asset the wallet has already approved the router for: KyberSwap's route is asked to fit it while it can.
  const cashApproved = g.loopRouter ? await c.chain.allowance(cash.token, wallet, g.loopRouter) : 0n;
  const x = await leverageTerms(c, i.token, BigInt(i.own), i.multiple, i.term, wallet, { room: cashApproved }, g);
  const router = x.router;
  requireThat(x.costBps <= i.maxCostBps, "PRICE_ABOVE_LIMIT", `The loop costs ${f.bps(x.costBps)} now, above the ${f.bps(i.maxCostBps)} limit set`);
  const [tokens, ownApproved] = await Promise.all([c.chain.balance(x.a.token, wallet), c.chain.allowance(x.a.token, wallet, router)]);
  requireThat(tokens >= x.pledge, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.token(x.pledge, x.a.decimals, x.a.symbol)}`);
  // A lend asset's core still lends it, before any write (Intent D55).
  if (!g.primary) await sameCoreAsset(c, g.core.engine, cash);
  const held = f.token(x.pledge + x.buy, x.a.decimals, x.a.symbol);
  const { maxCost, build } = await loopThrough(c, x, wallet, { own: ownApproved, cash: cashApproved }, LEVERAGE_WORDS);
  const lands = x.principal - x.fee > maxCost ? x.principal - x.fee - maxCost : 0n;
  return {
    view: {
      action: "leverage", token: x.a.token, symbol: x.a.symbol, decimals: x.a.decimals, own: x.pledge.toString(), buy: x.buy.toString(), multiple: i.multiple,
      principal: x.principal.toString(), fee: x.fee.toString(), cap: x.cap.toString(), term: i.term, feeBps: x.feeBps, costBps: x.costBps, maxCostBps: i.maxCostBps,
      maxCost: maxCost.toString(), ownValueUSDG: x.valueUSDG.toString(), cashUSDG: lands.toString(), ...(g.primary ? {} : inAsset(c, cash, g.core.engine)),
    },
    summary: {
      title: `Open a ${i.multiple}× loop on ${x.a.symbol}`,
      rows: [
        { label: "You put in", value: f.token(x.pledge, x.a.decimals, x.a.symbol) },
        { label: "The loan buys", value: f.token(x.buy, x.a.decimals, x.a.symbol) },
        { label: "Held for the loan", value: held },
        { label: `You repay within ${f.days(i.term)}`, value: f.owedIn(x.cap, cash) },
        { label: "Loan cost", value: `${f.bps(x.costBps)}, under the ${f.bps(i.maxCostBps)} limit set` },
        { label: "The purchase costs at most", value: f.owedIn(maxCost, cash) },
        { label: "If you don't repay", value: NO_LIQUIDATION(held) },
      ],
    },
    steps: [
      ...await approval(c, x.a.token, x.a.symbol, wallet, router, x.pledge),
      ...await approval(c, cash.token, cash.symbol, wallet, router, maxCost),
      { label: "Open loop", kind: "action", final: true, build },
    ],
    notes: ["The loop's price is signed for 30 seconds when its transaction is prepared: send it at once, or prepare again.", ...(cash.stable ? [] : [REPAY_IN(cash)])],
    made: (logs) => {
      const looped = eventOf(loopRouterAbi, "Looped", router, logs, (x) => same(String(x.borrower), wallet));
      return looped ? { engine: g.core.engine, loanId: String(looped.id) } : null;
    },
  };
}

/**
 * The engine a caller names, the current core when none is; refused only where the release says so: while the generations
 * found since it could not be read, an engine it does not name may be one of theirs.
 */
export function engineNamed(c: Ctx, engineAddress?: string): Engine {
  if (!engineAddress) return c.d.core;
  const engine = engineOf(c.d, engineAddress);
  if (!engine && c.generationsUnread) throw new ApiError("UNAVAILABLE", "gage's index has not said whether this engine is gage's yet; try again shortly", 503, true);
  requireThat(engine, "UNKNOWN_ENGINE", "This engine is not gage's", 404);
  return engine;
}

/**
 * A loan of the wallet's, private loans refused as unknown, whether the index marks them or only the chain tells (M7); on
 * the current core unless another engine is named. `record` says it may be shown: gage's index, unless a plan passes another.
 */
async function ownLoan(c: Ctx, wallet: Address, id: string, engineAddress?: string, record: (engine: Engine) => Promise<unknown> = (e) => loanRecord(c, e.engine, id)): Promise<{ engine: Engine; loan: Awaited<ReturnType<Chain["loan"]>> }> {
  const engine = engineNamed(c, engineAddress);
  await record(engine);
  const loan = await c.chain.loan(engine.engine, BigInt(id));
  requireThat(same(loan.originator, wallet) || same(loan.collateralBeneficiary, wallet) || same(await c.chain.ownerOf(engine.engine, BigInt(id)) ?? "0x", wallet),
    "NOT_YOUR_LOAN", "This wallet did not borrow this loan", 403);
  return { engine, loan };
}

const takeBack = (engine: Engine, id: bigint, wallet: Address) =>
  call("Receive collateral", engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "withdrawCollateral", args: [id, wallet] }));

/**
 * Whether `token` is paused now (D213, D447): it cannot move, so the core refuses every step that moves it while a
 * repayment or a cancellation, which moves none of it, still goes through. A step that takes it back is then left out of
 * the plan: a wallet sending a plan's steps as one batch would otherwise fail all of them, and with no grace a repayment
 * that could not be sent costs the pledge. A read that fails is no pause: the step it would leave out only reverts by
 * itself, and nothing is refused on it. A Stock Token's alone, as the release lists them: another token's `paused()` may
 * mean anything, and would hide its pickup from every plan.
 */
export const pausedNow = async (c: Ctx, token: Address) => assetOf(c.d, token)?.lane === "STOCK" && (await c.chain.tokensPaused([token]).catch(() => [false]))[0] === true;
const PAUSED_STAYS = (what: string) => `The token is paused, so ${what} stays in the loan's account, still yours, until it resumes. Reclaim it, or collect, then.`;
/** The refusal of a step that would move a paused token, which may be asked again once it resumes. */
function refusePaused(paused: boolean, what: string) {
  requireThat(!paused, "TOKEN_PAUSED", `The token is paused, so ${what} cannot move now; ask again once it resumes`);
}

async function cancel(c: Ctx, i: Extract<ActionInput, { action: "cancel" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const ref = await collateralRef(c, loan.token), known = ref.symbol !== "tokens" || assetOf(c.d, loan.token);
  const what = known ? f.token(loan.collateral, ref.decimals, ref.symbol) : "collateral";
  const steps: Step[] = [], notes: string[] = [];
  let held = false;
  if (loan.state === 1) {
    requireThat(same(loan.originator, wallet), "NOT_YOUR_LOAN", "Only the borrower cancels a listing", 403);
    held = await pausedNow(c, loan.token);
    steps.push(call("Cancel listing", engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "cancelFunding", args: [id] }), held), ...(held ? [] : [takeBack(engine, id, wallet)]));
    if (held) notes.push(PAUSED_STAYS(what));
  } else {
    requireThat(loan.state === 5, "NOT_CANCELLABLE", "Only a loan still waiting for funding can be cancelled");
    if (same(loan.collateralBeneficiary, wallet) && !await c.chain.released(loan.account)) {
      refusePaused(await pausedNow(c, loan.token), what);
      steps.push(takeBack(engine, id, wallet));
    }
  }
  return {
    view: { action: "cancel", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), ...(held ? { collateralPaused: true as const } : {}) },
    summary: { title: `Cancel loan #${i.loanId} and take back ${what}`, rows: [
      { label: "Loan", value: `#${i.loanId}, waiting for funding` },
      { label: "Back to your wallet", value: what },
      { label: "Lenders' contributions", value: "Returned to them" },
    ] },
    steps, notes,
  };
}

async function reclaim(c: Ctx, i: Extract<ActionInput, { action: "reclaim" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  // A term runs out whether gage's index answers or not: with it silent, the chain's proof serves (D439).
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine, (e) => loanProven(c, e, i.loanId));
  const ref = await collateralRef(c, loan.token), known = ref.symbol !== "tokens" || assetOf(c.d, loan.token);
  const what = known ? f.token(loan.collateral, ref.decimals, ref.symbol) : "collateral";
  // Repaid in the asset the loan's core pays in (D251): USDG, or its generation's lend asset.
  const pay = lendAssetOf(c.d, engine.engine);
  let ends = loan.fundedAt + loan.term;
  const steps: Step[] = [], notes: string[] = [];
  let held = false;
  if (loan.state === 2) {
    requireThat(same(await c.chain.ownerOf(engine.engine, id) ?? "0x", wallet), "NOT_YOUR_LOAN", "This wallet does not hold the loan's reclaim right", 403);
    const now = await chainNow(c);
    // The chain takes the repayment until term + GRACE (`GageV2Vault._windowEnd`). Inside the term a read that fails costs
    // nothing, the term's end being the earlier; past it, only the chain's answer says the lenders keep the collateral.
    const grace = await (now < ends ? c.chain.coreGrace(engine.engine).catch(() => 0) : c.chain.coreGrace(engine.engine));
    const pastTerm = now >= ends;
    ends += grace;
    requireThat(now < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
    if (pastTerm) notes.push(`The term has ended, but this core still takes the repayment until ${f.date(ends)}. After that the lenders keep the collateral.`);
    await sameCoreAsset(c, engine.engine, pay);
    requireThat(await c.chain.balance(pay.token, wallet) >= loan.cap, "INSUFFICIENT_BALANCE", `Repaying takes ${f.owedIn(loan.cap, pay)}; the wallet holds less`);
    const approve = await approval(c, pay.token, pay.symbol, wallet, engine.engine, loan.cap);
    // Never refused on this: the chain takes a repayment to its last second, and a refusal here would cost the pledge.
    if (approve.length && ends - now < 60) notes.push("This loan ends in under a minute: send the approval and the repayment at once. The repayment must be mined before the term ends, or the lenders keep the collateral.");
    held = await pausedNow(c, loan.token);
    steps.push(...approve,
      call("Repay", engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "reclaim", args: [id, wallet] }), held), ...(held ? [] : [takeBack(engine, id, wallet)]));
    if (held) notes.push(PAUSED_STAYS(what));
  } else {
    requireThat(loan.state === 3, "NOT_REPAYABLE", loan.state === 4 ? "The term ended unpaid: the lenders keep the collateral" : "This loan is not running");
    if (same(loan.collateralBeneficiary, wallet) && !await c.chain.released(loan.account)) {
      refusePaused(await pausedNow(c, loan.token), what);
      steps.push(takeBack(engine, id, wallet));
    }
  }
  return {
    view: { action: "reclaim", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), cap: loan.cap.toString(), endsAt: ends, ...inAsset(c, pay, engine.engine), ...(held ? { collateralPaused: true as const } : {}) },
    summary: { title: `Repay loan #${i.loanId} and take back ${what}`, rows: [
      { label: "You pay", value: f.owedIn(loan.cap, pay) },
      { label: "Back to your wallet", value: what },
      ...(loan.fundedAt > 0 ? [{ label: "Repay before", value: `${f.date(ends)} (the loan's last day)` }] : []),
    ] },
    steps, notes,
  };
}

/**
 * What a roll of a loan on a generation the release keeps for its positions alone (`retiredCore`) is refused with, by
 * hand or by itself: gage's keeper and rates service roll none of its loans, so a roll there would never run.
 */
const RETIRED_ROLL = "This loan's generation retired: gage rolls none of its loans over, by hand or by itself; repay it before it ends";
/** The same through a put router, which still closes the loan out of its pledge. */
const RETIRED_PUT_ROLL = "This loan's generation retired: gage rolls none of its loans over, by hand or by itself; close it with put_close or repay it before it ends";
/**
 * A loan's rollover router (D285): its generation's, refused where the release names none. `rolling`, for a roll by hand
 * or by itself: refused on a retained generation too (`RETIRED_ROLL`), whose router only ends what was left on it.
 */
function rollRouterOf(c: Ctx, engine: Engine, rolling = false): Address {
  const router = rolloverRouterOf(c.d, engine.engine);
  requireThat(router, "ROLLOVER_CLOSED", "Loans on this core cannot be rolled over");
  requireThat(!rolling || !retiredCore(c.d, engine.engine), "ROLLOVER_CLOSED", RETIRED_ROLL);
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
 * Waits, a few seconds at most, for this node's head to reach a signed plan's date (D447). The rates service dates a plan by
 * the block it read, and the chain refuses one dated ahead of its head (`NOT_YET_VALID`): a node a moment behind that
 * one would refuse the simulation of a plan that is good, with no word of why. Past the wait, the simulation says what it says.
 */
async function headReaches(c: Ctx, at: number, tries = 8, waitMs = 500) {
  for (let n = 0; n < tries; n += 1) {
    if ((await c.chain.head()).timestamp >= at) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Rolling a running loan over (D285): the new loan, on the same pledge and of the same size, repays this one in full in
 * one transaction, and the wallet adds what its payout leaves short of this loan's repayment (the top-up), or keeps what
 * is over. The reclaim right is approved to the generation's rollover router for this loan, the old repayment in the
 * loan's asset with what the wallet's other loans rolling by themselves through the router still need (`otherRolls`: an
 * approval replaces the one before it), then the roll, its plans signed for 30 seconds when it is sent
 * and held to the top-up and repayment planned: a dearer roll is refused before it is sent, and the router takes no
 * more than that top-up. A roll by hand ends the loan's instruction to roll by itself.
 */
async function rollOver(c: Ctx, i: Extract<ActionInput, { action: "roll" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const router = rollRouterOf(c, engine, true);
  requireThat(loan.state === 2, "NOT_ROLLABLE", loan.state === 1 ? "The loan is still waiting for funding: nothing to roll yet" : "Only a running loan can be rolled over");
  await holdsRight(c, engine, id, wallet);
  const ends = loan.fundedAt + loan.term, term = i.term ?? loan.term, head = await chainNow(c);
  requireThat(head < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  requireThat(!await c.chain.rolloverPaused(router), "ROLLOVER_PAUSED", "Rolling over is paused now");
  await allowedTerm(c, engine, term);
  // A term gage-sdk does not offer is a 1-day loan's on mainnet: its one approval is its auto-settle (D232), which a roll's would take the place of, so it rolls on the site.
  requireThat((await termsOf(c, engine.registry)).includes(loan.term), "ROLLOVER_CLOSED", "A loan of this term is rolled on gage.cash, where its automatic settlement stays on");
  // A roll moves the pledge from this loan's account to the new one's: repaying still works while the token is paused.
  refusePaused(await pausedNow(c, loan.token), "its pledge");
  const pay = lendAssetOf(c.d, engine.engine);
  await sameCoreAsset(c, engine.engine, pay);
  const ask = { engine: engine.engine, loanId: id, borrower: wallet, term, oldPrincipal: loan.principal, oldCap: loan.cap };
  // This loan's own instruction ends with a roll by hand; the wallet's other loans rolling by themselves keep theirs.
  const [shown, standing, others] = await Promise.all([rollFigures(c.rates, ask), c.chain.autoRoll(router, id), otherRolls(c, engine, router, wallet, id)]);
  const w = shown.wallet, t = shown.terms;
  requireThat(await c.chain.balance(pay.token, wallet) >= w.topUp, "INSUFFICIENT_BALANCE", `Rolling over takes ${f.owedIn(w.topUp, pay)} from the wallet; it holds less`);
  const ref = await collateralRef(c, loan.token), known = ref.symbol !== "tokens" || assetOf(c.d, loan.token);
  const what = known ? f.token(loan.collateral, ref.decimals, ref.symbol) : "collateral";
  // Asked again when it is sent: the plans live 30 seconds, and the roll is held to what was planned.
  const send = async (): Promise<Tx> => {
    const r = await rollPlan(c.rates, { ...ask, router, token: loan.token, collateral: loan.collateral, now: c.now });
    requireThat(r.wallet.topUp <= w.topUp && r.terms.cap <= t.cap, "PRICE_MOVED", "The roll costs more now than when it was prepared; prepare it again");
    await headReaches(c, Math.max(...r.plans.map((p) => p.issuedAt)));
    // The new loan is listed and filled in the roll: its sGAGE only where the core's ledger pays it (R2 option C).
    const withRewards = await listsWithRewards(c.chain, engine, r.terms.term, r.terms.principal);
    return tx(router, encodeFunctionData({ abi: rolloverRouterAbi, functionName: "roll",
      args: [{ loanId: id, maxTopUp: w.topUp, withRewards, pricing: r.pricing }, r.plans, r.signatures, r.plans[0]!.allocations.map((a) => a.maxReserveShares)] }));
  };
  const early = ends - head > 86_400;
  return {
    view: {
      action: "roll", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), oldPrincipal: loan.principal.toString(), oldCap: loan.cap.toString(), endsAt: ends,
      principal: t.principal.toString(), cap: t.cap.toString(), term: t.term, fee: w.fee.toString(), feeBps: w.feeBps, payout: w.payout.toString(),
      topUp: w.topUp.toString(), surplus: w.surplus.toString(), allowance: withOthers(loan.cap, others.need).toString(), otherAutoRolls: others.count, ...inAsset(c, pay, engine.engine),
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
      ...await approval(c, pay.token, pay.symbol, wallet, router, withOthers(loan.cap, others.need)),
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
      ...(others.count ? [rollOthersNote(others.count)] : []),
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
  requireThat(await chainNow(c) < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  // A sale moves the pledge: repaying still works while the token is paused.
  refusePaused(await pausedNow(c, loan.token), "its pledge");
  const pay = lendAssetOf(c.d, engine.engine);
  requireThat(!same(loan.token, pay.token), "CASHOUT_CLOSED", "This loan's pledge is the asset it is repaid in: repay it instead");
  await sameCoreAsset(c, engine.engine, pay);
  // A router with no flash pool (a v4 router) takes another sale than this one builds.
  requireThat(await c.chain.cashoutFlashPool(router) !== null, "CASHOUT_CLOSED", "Loans on this core cash out on gage.cash only");
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
  // What the plan says the wallet gets at least, and what the transaction is held to, however the quote moves before it is sent.
  const planned = sale.minimumNet > least ? sale.minimumNet : least;
  // gage's own direct routes for the collateral, into a USDG core's asset: what the sale is weighed against when sent.
  const routes = same(pay.token, c.d.usdg) ? directRoutes(loan.token, pay.token, c.d.loopPools.get(loan.token.toLowerCase()) ?? []) : [];
  const exit = (x: CashoutSale): Tx => tx(router, encodeFunctionData({ abi: cashoutRouterAbi, functionName: "cashOutVia", args: [{
    loanId: id, recipient: wallet, minimumNet: planned, maxFinanceFee: x.maxFinanceFee, deadline: BigInt(x.deadline), executor: x.executor, data: x.data,
    flashToken: x.flashToken, flashFee: x.flashFee, minUsdgOut: x.minOut,
  }] }));
  // Quoted again when it is sent, never paying less than planned or than the caller's least, nor clearly less than gage's
  // own route, which the app would take instead (`pickCashout`); a sale that would revert gives way to its pools-only one.
  const send = async (): Promise<Tx> => {
    // The right is approved to the router by now, so its routes can be simulated for the wallet.
    const reference = routes.length ? await routeNet(c.chain, router, id, wallet, loan.cap, c.now(), routes) : null;
    let last: Tx | null = null, below = false, answered = false;
    for (const sources of ["all", "pools"] as const) {
      const x = await askCashoutSale(valuation, want(), sources);
      if (!x) continue;
      answered = true;
      // A quote lower than the plan's but still above its floor goes through, held to that floor.
      if (x.netAtQuote < planned || await c.chain.cashoutExecutorAllowed(router, x.executor) !== true) continue;
      if (reference !== null && x.netAtQuote * 10_000n < reference * (10_000n - ROUTE_MARGIN_BPS)) { below = true; continue; }
      last = exit(x);
      try { await c.chain.simulate({ from: wallet, ...last }); return last; } catch { /* the next liquidity */ }
    }
    if (!answered) throw new ApiError("SALE_UNAVAILABLE", "The aggregator did not answer a sale just now; prepare it again shortly", 503, true);
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
      financeFee: sale.maxFinanceFee.toString(), fee: fee.toString(), net: sale.netAtQuote.toString(), minimumNet: planned.toString(), source: sale.source,
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
        { label: "You receive", value: `About ${f.money(sale.netAtQuote, pay)}, at least ${f.money(planned, pay)}` },
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
/**
 * What an instruction with `rollsLeft` rolls still takes back through the rollover router's allowance: its loan's
 * repayment at the next roll, then each new loan's at most, the same principal and the ceiling its cost is held to, to
 * the unit (`maxCost`).
 */
const instructionNeed = (cap: bigint, principal: bigint, rollsLeft: number, maxCost: bigint) =>
  rollsLeft <= 0 ? 0n : cap + BigInt(rollsLeft - 1) * (principal + maxCost);
/**
 * What the wallet's other loans rolling over by themselves through `router` still need of its approval (the staging
 * review's R4, F20 of the first): every loan whose right the wallet holds on the core, read from the core
 * (`walletRights`: the index only names them, the class of F18), but `except`, whose instruction there (`autoRolls`)
 * this wallet left, with rolls left and before its date, each counted by `instructionNeed` at the core's figures. An
 * approval replaces the allowance, and every loan of a wallet on a core rolls through the same router, so a roll's
 * approval is its own need plus these, as a put's are (`otherPutRolls`): sized for one loan alone, it took the others'
 * budgets, and their rolls then missed (`allowance_short`). The wallet's loans unread, or one of its rights left out of
 * the index's list, nothing is prepared.
 */
async function otherRolls(c: Ctx, engine: Engine, router: Address, wallet: Address, except: bigint) {
  const loans = (await walletRights(c, engine.engine, wallet, except)).filter((l) => l.id !== except);
  const standing = await Promise.all(loans.map((l) => c.chain.autoRoll(router, l.id)));
  let count = 0, need = 0n;
  standing.forEach((a, n) => {
    if (!a || !same(a.borrower, wallet) || a.rollsLeft <= 0 || a.until < c.now()) return;
    count += 1;
    need += instructionNeed(loans[n]!.loan.cap, loans[n]!.loan.principal, a.rollsLeft, a.maxCost);
  });
  return { count, need };
}
const rollOthersNote = (n: number) =>
  `The approval also covers the rolls your ${n} other ${n === 1 ? "loan rolling over by itself still needs" : "loans rolling over by themselves still need"}: an approval replaces the one before it.`;
/** An amount rounded up to the asset's last shown place, so an "at most" said in it stays true. */
const shownCeil = (raw: bigint, a: Pick<LendAsset, "decimals" | "stable">) => {
  const step = 10n ** BigInt(Math.max(0, a.decimals - (a.stable ? 2 : 4)));
  return ((raw + step - 1n) / step) * step;
};

/**
 * Rolling over by itself (D285): a standing instruction for gage's keeper, who rolls the loan in its last hours into a
 * new loan of the same size and term, at most `maxCost` each (its fixed cost and fee, held on chain to the unit), up to
 * four times. With `put_auto_roll` alone among the actions here it leaves standing approvals, said in the plan: the router may move every
 * reclaim right of this wallet on this core, so the instruction follows each new loan, and spend the loan's asset for
 * the repayments of all four rolls and of the rolls the wallet's other loans rolling by themselves there still need
 * (`otherRolls`). Set while the loan waits for funding or runs, by the holder of its right.
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
  const router = rollRouterOf(c, engine, true), executor = c.d.rolloverExecutor;
  requireThat(executor, "AUTO_ROLL_CLOSED", "Rolling over by itself is not offered on this deployment");
  requireThat(loan.state === 1 || loan.state === 2, "NOT_ROLLABLE", "Only a loan waiting for funding or running can roll by itself");
  await holdsRight(c, engine, id, wallet);
  // A listing's end is not known until it is funded: the app counts it from its funding window, as here.
  const head = await chainNow(c), end = loan.state === 2 ? loan.fundedAt + loan.term : head + LISTING_SECONDS + loan.term;
  requireThat(head < end, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  requireThat(!await c.chain.rolloverPaused(router), "ROLLOVER_PAUSED", "Rolling over is paused now");
  const pay = lendAssetOf(c.d, engine.engine);
  await sameCoreAsset(c, engine.engine, pay);
  const feeBps = await c.chain.feeBps(engine.registry);
  // This loan's own fixed cost and fee: the least each roll may take from the wallet (the app's `autoLimits`).
  const own = loan.cap - loan.principal + (loan.principal * BigInt(feeBps)) / 10_000n;
  requireThat(!i.maxCost || BigInt(i.maxCost) <= loan.principal, "MAX_COST_TOO_HIGH", `A roll's ceiling may be at most the loan's principal, ${f.money(loan.principal, pay)}`);
  // Every roll pays the origination fee on the same principal: a ceiling below it could never run (r12 review C8).
  const rollFee = (loan.principal * BigInt(feeBps)) / 10_000n;
  requireThat(!i.maxCost || BigInt(i.maxCost) >= rollFee, "MAX_COST_TOO_LOW", `A roll's ceiling must cover at least its origination fee, ${f.owedIn(rollFee, pay)}`);
  // What a roll of this running loan costs now, its new fixed cost and fee, quoted for its own term.
  const today = i.maxCost || loan.state !== 2 ? null : await rollFigures(c.rates, { engine: engine.engine, loanId: id, borrower: wallet, term: loan.term, oldPrincipal: loan.principal, oldCap: loan.cap })
    .then(({ terms, wallet: w }) => terms.cap - terms.principal + w.fee);
  const bound = own * DEFAULT_CEILING_OF_OWN;
  requireThat(today === null || today <= bound, "ROLL_COST_HIGH",
    `A roll of this loan costs ${f.owedIn(today ?? 0n, pay)} now, more than four times its own ${f.owedIn(own, pay)}: name maxCost to leave it a ceiling that high`);
  const most = i.maxCost ? BigInt(i.maxCost) : shownCeil(today === null ? own * 2n : today * 2n < bound ? today * 2n : bound, pay);
  const maxTopUp = own > most ? own : most;
  // Its four rolls on top of what the wallet's other loans rolling by themselves still need: the approval adds up.
  const others = await otherRolls(c, engine, router, wallet, id);
  const allowance = withOthers(instructionNeed(loan.cap, loan.principal, AUTO_ROLLS, most), others.need);
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
      rolls: AUTO_ROLLS, window, until, allowance: allowance.toString(), otherAutoRolls: others.count, executor, ...inAsset(c, pay, engine.engine),
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
      ...(others.count ? [rollOthersNote(others.count)] : []),
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
 * A loan's put router: its generation's, refused where the release names none. The put router answers the rollover
 * router's `paused()` and `autoRolls(id)` (its `maxSpend` in `maxTopUp`'s place) and the loop router's `V3_FACTORY()`,
 * so the chain's reads of those serve it too. `rolling`, for a roll by hand or by itself: refused on a generation the
 * release keeps for its positions alone, whose put router only closes and ends what was left on it (`RETIRED_PUT_ROLL`).
 */
function putRouterFor(c: Ctx, engine: Engine, rolling = false): { g: Generation; router: Address } {
  const g = generationOfCore(c.d, engine.engine), router = g?.putRouter ?? null;
  requireThat(g && router, "PUT_CLOSED", "Loans on this core do not close or roll through a put router");
  requireThat(!rolling || !g.retired, "PUT_CLOSED", RETIRED_PUT_ROLL);
  return { g, router };
}
/** Whether a put router is paused: it then closes and rolls nothing, and every loan stays repayable on its core. */
const putPaused = (c: Ctx, router: Address) => c.chain.rolloverPaused(router);

/**
 * What the wallet's other puts rolling by themselves through `router` still need of its two approvals: every loan whose
 * right the wallet holds on the core, read from the core (`walletRights`: the index only names them, the class of F18),
 * but `except`, pledging `pledge`, whose instruction there (`autoRolls`) this wallet left, with rolls left and before
 * its date. Each of those rolls takes back up to its loan's principal of the asset (the same principal every
 * roll, the core's) and spends up to its `maxSpend` of the pledge. An approval replaces the allowance, so a put's
 * approvals are its own need plus these: sized for itself alone, they took the other puts' budgets for its own rolls,
 * and theirs then missed (`allowance_short`). The wallet's loans unread, or one of its rights left out of the index's
 * list, nothing is prepared.
 */
async function otherPutRolls(c: Ctx, engine: Engine, router: Address, wallet: Address, except: bigint, pledge: Address) {
  const loans = (await walletRights(c, engine.engine, wallet, except)).filter((l) => l.id !== except && same(l.loan.token, pledge));
  const standing = await Promise.all(loans.map((l) => c.chain.autoRoll(router, l.id)));
  let count = 0, asset = 0n, spend = 0n;
  standing.forEach((a, n) => {
    if (!a || !same(a.borrower, wallet) || a.rollsLeft <= 0 || a.until < c.now()) return;
    count += 1;
    asset += BigInt(a.rollsLeft) * loans[n]!.loan.principal;
    spend += BigInt(a.rollsLeft) * a.maxTopUp;
  });
  return { count, asset, spend };
}
/** A put's approval: its own need and, where it needs any, what the other puts rolling by themselves still need. */
const withOthers = (own: bigint, others: bigint) => (own === 0n ? 0n : own + others);
const othersNote = (n: number) =>
  `The approvals also cover the rolls your ${n} other ${n === 1 ? "put rolling by itself still needs" : "puts rolling by themselves still need"}: an approval replaces the one before it.`;
/** An amount of a loan's pledge as a summary writes it: USDG in cents, any other token to four places. */
const pledgeText = (c: Ctx, t: TokenRef, raw: bigint) => (same(t.token, c.d.usdg) ? f.usdg(raw) : f.token(raw, t.decimals, t.symbol));
/** The last place `pledgeText` shows of a token: an "at most" rounded up to it stays true. */
const pledgeStep = (c: Ctx, t: TokenRef) => 10n ** BigInt(Math.max(0, t.decimals - (same(t.token, c.d.usdg) ? 2 : 4)));

/**
 * What buying exactly `amount` of a generation's asset with a loan's pledge `token` costs through each pool its put
 * router may swap in, cheapest first (`rankSwaps`): the generation's hookless v4 and V3 pools pairing the two
 * (`loopPools`), V3 ones only where the router reads its V3 factory. A pool whose read fails is left out, unless every
 * one fails: then that failure is the answer.
 */
async function swapQuotes(c: Ctx, g: Generation, router: Address, token: Address, amount: bigint): Promise<SwapQuote[]> {
  const all = g.loopPools.get(token.toLowerCase()) ?? [];
  const v3 = all.some((p) => p.kind === "v3") && await c.chain.loopV3Factory(router) !== null;
  const pools = all.filter((p) => p.kind === "v4" || v3);
  const read = await Promise.allSettled(pools.map(async (p) => {
    const cost = await exactOutCost(c, p, token, g.lendAsset.token, amount);
    return cost === null ? null : { swap: swapOf(p), cost };
  }));
  const ranked = rankSwaps(read.map((r) => (r.status === "fulfilled" ? r.value : null)));
  const failed = read.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (!ranked.length && failed && read.every((r) => r.status === "rejected")) throw failed.reason;
  return ranked;
}

/**
 * A put's terms (docs/api.md "Puts on lend-asset generations"): `own` USDG of margin and the USDG the loan's asset
 * buys, `size` times the margin in all, pledged in one loan on the lend asset's core. Its principal is the least whose
 * payout buys the purchase through its cheapest source with LOOP_HEADROOM_BPS of it spare (D271, `principalFor`), so
 * next to nothing lands besides and its loan-to-value is about the purchase over the pledge; its cost is priced as an
 * exact loan is (`priceExact`), on the whole pledge, and the vaults must fund it whole now. A put buys through its
 * generation's own pools: the valuation service routes USDG's loops alone.
 */
export async function putTerms(c: Ctx, g: Generation, own: bigint, size: number, term: number, wallet?: Address) {
  const router = g.loopRouter, cash = g.lendAsset;
  requireThat(router, "PUT_CLOSED", "Puts are not offered on this deployment");
  const a = await collateralOf(c, g, c.d.usdg);
  requireThat(g.loopPools.get(a.token.toLowerCase())?.length, "NO_LEVERAGE_POOL", `No pool buys USDG with ${cash.symbol} for a put`);
  const buy = putBuy(own, size), pledge = own + buy;
  requireThat(buy > 0n, "INVALID_TERMS", "The margin is too small for this size to buy anything");
  const terms = await termsOf(c, g.core.registry);
  requireThat(terms.includes(term), "TERM_NOT_ALLOWED", `Allowed terms: ${terms.map(f.days).join(", ")}`);
  const quoted = await loopQuotes(c, g, a, buy, router);
  requireThat(quoted.length, "POOL_TOO_THIN", `No pool can buy that much USDG with ${cash.symbol} now; try a smaller size`);
  const feeBps = await c.chain.feeBps(g.core.registry);
  const principal = principalFor(loopCap(quoted[0]!), feeBps);
  const fee = principal - loopPayout(principal, feeBps), spendable = loopSpendable(principal, principal - fee);
  const priced = await priceExact(c, g, a, pledge, principal, term, wallet ?? g.core.engine, (most) =>
    new ApiError("SIZE_TOO_HIGH", `A ${size}× put borrows ${f.money(principal, cash)}, more than its pledge supports now (at most ${f.money(most, cash)}); try a smaller size`, 409, false,
      { details: { maxPrincipal: most.toString() } }));
  const allocation = priced.preview.fills ? allocate(priced.preview.vaults) : null;
  requireThat(allocation, "INSUFFICIENT_CAPACITY", "The partner vaults cannot fund this put whole now; try a smaller size or margin");
  // The loan pays for its cheapest source, by its sizing, and for any other whose own bound keeps the spare.
  const sources = quoted.filter((q) => loopCap(q) <= spendable);
  const maxCost = loopCap(sources[0]!), cap = priced.cap;
  const loan: Terms = { token: a.token, collateral: pledge, principal, cap, term };
  return {
    g, a, router, own, buy, pledge, principal, cap, fee, feeBps, maxCost, cash: principal - fee - maxCost, spendable, costBps: costBps(principal, cap),
    value: priced.value, terms: loan, allocation, sources,
  };
}

/**
 * Opening a put (docs/api.md "Puts on lend-asset generations"): `margin` USDG of the wallet's and the USDG the loan's
 * asset buys, `size` times the margin in all, pledged in one loan on the lend asset's core through its loop router, in
 * one transaction: the purchase's cost comes back out of the loan's payout, never from the wallet past it (D271). The
 * margin is approved to the router, then the asset at the purchase's most, then the put, its plan signed for 30 seconds
 * when it is sent and bought through the cheapest pool that runs under that approval. The wallet never holds the asset
 * but what lands besides; it closes the put with `put_close`, rolls it with `put_roll`, or repays it in the asset.
 */
async function putOpen(c: Ctx, i: Extract<ActionInput, { action: "put_open" }>): Promise<Plan> {
  const wallet = i.wallet as Address, g = putGenerationFor(c, i.lendAsset), cash = g.lendAsset;
  // The asset the wallet has already approved the loop router for: the purchase's most is taken back in it.
  const cashApproved = await c.chain.allowance(cash.token, wallet, g.loopRouter!);
  const x = await putTerms(c, g, BigInt(i.margin), i.size, i.term, wallet);
  requireThat(x.costBps <= i.maxCostBps, "PRICE_ABOVE_LIMIT", `The put's loan costs ${f.bps(x.costBps)} now, above the ${f.bps(i.maxCostBps)} limit set`);
  const [held, ownApproved] = await Promise.all([c.chain.balance(x.a.token, wallet), c.chain.allowance(x.a.token, wallet, x.router)]);
  requireThat(held >= x.own, "INSUFFICIENT_BALANCE", `The wallet holds less than ${pledgeText(c, x.a, x.own)}`);
  await sameCoreAsset(c, g.core.engine, cash);
  const { maxCost, build } = await loopThrough(c, x, wallet, { own: ownApproved, cash: cashApproved }, PUT_WORDS);
  const lands = x.principal - x.fee > maxCost ? x.principal - x.fee - maxCost : 0n;
  const pledged = pledgeText(c, x.a, x.pledge), margin = pledgeText(c, x.a, x.own);
  return {
    view: {
      action: "put_open", token: x.a.token, symbol: x.a.symbol, decimals: x.a.decimals, margin: x.own.toString(), buy: x.buy.toString(), size: i.size,
      principal: x.principal.toString(), fee: x.fee.toString(), cap: x.cap.toString(), term: i.term, feeBps: x.feeBps, costBps: x.costBps, maxCostBps: i.maxCostBps,
      maxCost: maxCost.toString(), cash: lands.toString(), pledgeValue: x.value.toString(), ...inAsset(c, cash, g.core.engine),
    },
    summary: {
      title: `Open a ${i.size}× put on ${cash.symbol}`,
      rows: [
        { label: "You put in", value: margin },
        { label: "The loan buys", value: pledgeText(c, x.a, x.buy) },
        { label: "Held for the loan", value: pledged },
        { label: "You borrow", value: `${f.money(x.principal, cash)}, which buys it` },
        { label: `You repay within ${f.days(i.term)}`, value: f.owedIn(x.cap, cash) },
        { label: "Loan cost", value: `${f.bps(x.costBps)}, under the ${f.bps(i.maxCostBps)} limit set` },
        { label: "The purchase costs at most", value: f.owedIn(maxCost, cash) },
        { label: "The most you can lose", value: `${margin}, what you put in` },
        { label: "If you don't repay", value: NO_LIQUIDATION(pledged) },
      ],
    },
    steps: [
      ...await approval(c, x.a.token, x.a.symbol, wallet, x.router, x.own),
      ...await approval(c, cash.token, cash.symbol, wallet, x.router, maxCost),
      { label: "Open put", kind: "action", final: true, build },
    ],
    notes: [
      "The put's price is signed for 30 seconds when its transaction is prepared: send it at once, or prepare again.",
      `It gains as ${cash.symbol} falls: what you repay is fixed in ${cash.symbol}. Close it with put_close before it ends, and the pledge buys the repayment back and returns the rest in USDG.`,
      ...(cash.stable ? [] : [REPAY_IN(cash)]),
    ],
    made: (logs) => {
      const looped = eventOf(loopRouterAbi, "Looped", x.router, logs, (l) => same(String(l.borrower), wallet));
      return looped ? { engine: g.core.engine, loanId: String(looped.id) } : null;
    },
  };
}

/**
 * Closing a running loan out of its own pledge through its generation's put router (docs/api.md "Puts on lend-asset
 * generations"): the repayment is fronted, the loan repaid and booked in its vaults, exactly the repayment bought back
 * with the pledged tokens through the cheapest pool the router swaps in, and the rest sent to the wallet, in one
 * transaction (`PutRouter.close`), with no plan and nothing held in the loan's asset. The reclaim right is approved to the
 * router for this loan, then the close, quoted again when it is sent and held to the most planned (`maxSpend`: the
 * quote, `maxSlippageBps` over it) and the least back (`minBack`, never under the caller's). A pledge that cannot buy
 * the repayment back cannot close the loan: it is repaid in its asset, or left to end.
 */
async function putClose(c: Ctx, i: Extract<ActionInput, { action: "put_close" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const { g, router } = putRouterFor(c, engine);
  requireThat(loan.state === 2, "NOT_RUNNING", "Only a running loan can be closed");
  await holdsRight(c, engine, id, wallet);
  const ends = loan.fundedAt + loan.term;
  requireThat(await chainNow(c) < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  requireThat(!await putPaused(c, router), "PUT_PAUSED", "Closing and rolling through the put router is paused now; the loan can still be repaid");
  const pay = g.lendAsset;
  requireThat(!same(loan.token, pay.token), "PUT_CLOSED", "This loan's pledge is the asset it is repaid in: repay it instead");
  await sameCoreAsset(c, engine.engine, pay);
  const ref = await collateralRef(c, loan.token);
  const quotes = await swapQuotes(c, g, router, loan.token, loan.cap);
  requireThat(quotes.length, "POOL_TOO_THIN", `No pool can buy the ${pay.symbol} repayment back with the pledged ${ref.symbol} now; repay it in ${pay.symbol} instead`);
  const spend = quotes[0]!.cost;
  requireThat(spend < loan.collateral, "PLEDGE_SHORT",
    `Buying the ${f.owedIn(loan.cap, pay)} repayment back costs about ${pledgeText(c, ref, spend)}, no less than the ${pledgeText(c, ref, loan.collateral)} pledged: repay it in ${pay.symbol}, or leave it to end`);
  const back = loan.collateral - spend, least = i.minBack ? BigInt(i.minBack) : 0n;
  requireThat(back >= least, "BELOW_MIN_BACK", `The close returns about ${pledgeText(c, ref, back)} now, under the least you named`, 409, { back: back.toString() });
  // The most the purchase may spend, and so the least that comes back: the quote with room for a move, never under the caller's least.
  const bound = spendBound(spend, i.maxSlippageBps ?? 50, pledgeStep(c, ref));
  const floor = bound < loan.collateral ? loan.collateral - bound : 0n;
  const minBack = floor > least ? floor : least, maxSpend = loan.collateral - minBack;
  const closing = (s: PutSwap) => tx(router, encodeFunctionData({ abi: putRouterAbi, functionName: "close", args: [{ loanId: id, swap: s, maxSpend, minBack, recipient: wallet }] }));
  // Quoted again when it is sent: through the cheapest pool that buys the repayment back within `maxSpend` and simulates.
  const send = async (): Promise<Tx> => {
    const now = await swapQuotes(c, g, router, loan.token, loan.cap);
    let fits = false;
    for (const q of now) {
      if (q.cost > maxSpend) continue;
      fits = true;
      const t = closing(q.swap);
      try { await c.chain.simulate({ from: wallet, ...t }); return t; } catch { /* the next pool */ }
    }
    requireThat(now.length, "POOL_TOO_THIN", `No pool can buy the ${pay.symbol} repayment back with the pledged ${ref.symbol} now; repay it in ${pay.symbol} instead`);
    requireThat(fits, "PRICE_MOVED", `Buying the repayment back costs more now than the ${pledgeText(c, ref, maxSpend)} planned; prepare the close again`);
    throw new ApiError("SIMULATION_FAILED", "The close would revert now through every pool; prepare it again shortly", 409);
  };
  const standing = await c.chain.autoRoll(router, id);
  const what = pledgeText(c, ref, loan.collateral);
  return {
    view: {
      action: "put_close", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), cap: loan.cap.toString(), endsAt: ends, spend: spend.toString(),
      maxSpend: maxSpend.toString(), back: back.toString(), minBack: minBack.toString(), ...inAsset(c, pay, engine.engine),
    },
    summary: {
      title: `Close loan #${i.loanId} out of its pledge: buy the ${pay.symbol} repayment back, keep the rest`,
      rows: [
        { label: "Repaid to the lenders", value: f.owedIn(loan.cap, pay) },
        { label: "Bought back with", value: `About ${pledgeText(c, ref, spend)} of the ${what} pledged, at most ${pledgeText(c, ref, maxSpend)}` },
        { label: "Back to your wallet", value: `About ${pledgeText(c, ref, back)}, at least ${pledgeText(c, ref, minBack)}` },
      ],
    },
    steps: [
      ...await rightApproval(c, engine, id, wallet, router, `Approve the close of loan #${i.loanId}`),
      { label: "Close", kind: "action", final: true, build: send },
    ],
    notes: [
      "The purchase is quoted again when it is sent, and refused if it would spend more than this.",
      `Closing ends the loan: the lenders are repaid in full, and what the purchase leaves of the pledge comes back in ${ref.symbol}.`,
      ...(standing ? ["Closing ends this loan's instruction to roll by itself."] : []),
    ],
  };
}

/**
 * Rolling a running loan over through its generation's put router (docs/api.md "Puts on lend-asset generations"): the
 * new loan, on the same pledge and of the same size, repays this one in full in one transaction, as a roll through the
 * rollover router does (D285), but the new payout passes through the wallet and straight back, and the router buys what
 * it leaves short of the old repayment (the top-up) with the pledge's token from the wallet, at most `maxSpend` (the
 * top-up's quote, `maxSlippageBps` over it). The reclaim right is approved to the router for this loan, the payout's
 * pass in the loan's asset and the spend in the pledge's token (exact amounts, as every approval here), then the roll,
 * its plans signed for 30 seconds when it is sent (`router=put`) and held to the top-up and repayment planned.
 */
async function putRoll(c: Ctx, i: Extract<ActionInput, { action: "put_roll" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const { g, router } = putRouterFor(c, engine, true);
  requireThat(loan.state === 2, "NOT_ROLLABLE", loan.state === 1 ? "The loan is still waiting for funding: nothing to roll yet" : "Only a running loan can be rolled over");
  await holdsRight(c, engine, id, wallet);
  const ends = loan.fundedAt + loan.term, term = i.term ?? loan.term, head = await chainNow(c);
  requireThat(head < ends, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  requireThat(!await putPaused(c, router), "PUT_PAUSED", "Closing and rolling through the put router is paused now; the loan can still be repaid");
  await allowedTerm(c, engine, term);
  const pay = g.lendAsset;
  requireThat(!same(loan.token, pay.token), "PUT_CLOSED", "This loan's pledge is the asset it is repaid in: roll it with roll");
  await sameCoreAsset(c, engine.engine, pay);
  const ask = { engine: engine.engine, loanId: id, borrower: wallet, term, oldPrincipal: loan.principal, oldCap: loan.cap, put: true };
  // This loan's own instruction ends with a roll by hand; the wallet's other puts keep theirs.
  const [shown, standing, others] = await Promise.all([rollFigures(c.rates, ask), c.chain.autoRoll(router, id), otherPutRolls(c, engine, router, wallet, id, loan.token)]);
  const w = shown.wallet, t = shown.terms;
  const ref = await collateralRef(c, loan.token);
  // What the top-up costs in the pledge's token now (a roll of the same size always has one: the old cost and the new fee).
  const quotes = w.topUp > 0n ? await swapQuotes(c, g, router, loan.token, w.topUp) : [];
  requireThat(w.topUp === 0n || quotes.length, "POOL_TOO_THIN", `No pool can buy the ${f.owedIn(w.topUp, pay)} top-up with ${ref.symbol} now`);
  const spend = quotes[0]?.cost ?? 0n;
  const maxSpend = w.topUp > 0n ? spendBound(spend, i.maxSlippageBps ?? 50, pledgeStep(c, ref)) : 0n;
  requireThat(await c.chain.balance(loan.token, wallet) >= spend, "INSUFFICIENT_BALANCE", `Rolling over takes about ${pledgeText(c, ref, spend)} from the wallet; it holds less`);
  // The payout the router takes back from the wallet: all of it, up to the old repayment.
  const through = (payout: bigint) => (payout < loan.cap ? payout : loan.cap);
  const passThrough = through(w.payout);
  const rolling = (s: PutSwap, r: SignedRoll, withRewards: boolean) => tx(router, encodeFunctionData({ abi: putRouterAbi, functionName: "roll",
    args: [{ loanId: id, swap: s, maxSpend, withRewards, pricing: r.pricing }, r.plans, r.signatures, r.plans[0]!.allocations.map((a) => a.maxReserveShares)] }));
  // Asked again when it is sent: the plans live 30 seconds, and the roll is held to what was planned.
  const send = async (): Promise<Tx> => {
    const r = await rollPlan(c.rates, { ...ask, router, token: loan.token, collateral: loan.collateral, now: c.now });
    requireThat(r.wallet.topUp <= w.topUp && r.terms.cap <= t.cap && through(r.wallet.payout) <= passThrough, "PRICE_MOVED", "The roll costs more now than when it was prepared; prepare it again");
    // The new loan is listed and filled in the roll: its sGAGE only where the core's ledger pays it (R2 option C).
    const withRewards = await listsWithRewards(c.chain, engine, r.terms.term, r.terms.principal);
    // The router checks the pool before anything moves, so a roll with nothing to buy still names one.
    const now = r.wallet.topUp > 0n ? await swapQuotes(c, g, router, loan.token, r.wallet.topUp) : (g.loopPools.get(loan.token.toLowerCase()) ?? []).map((p) => ({ swap: swapOf(p), cost: 0n }));
    let fits = false;
    for (const q of now) {
      if (q.cost > maxSpend) continue;
      fits = true;
      const sent = rolling(q.swap, r, withRewards);
      try { await c.chain.simulate({ from: wallet, ...sent }); return sent; } catch { /* the next pool */ }
    }
    requireThat(now.length, "POOL_TOO_THIN", `No pool can buy the ${f.owedIn(r.wallet.topUp, pay)} top-up with ${ref.symbol} now`);
    requireThat(fits, "PRICE_MOVED", `Buying the top-up costs more now than the ${pledgeText(c, ref, maxSpend)} approved for it; prepare the roll again`);
    throw new ApiError("SIMULATION_FAILED", "The roll would revert now through every pool; prepare it again shortly", 409);
  };
  const what = pledgeText(c, ref, loan.collateral), early = ends - head > 86_400;
  return {
    view: {
      action: "put_roll", ...ref, loanId: i.loanId, collateral: loan.collateral.toString(), oldPrincipal: loan.principal.toString(), oldCap: loan.cap.toString(), endsAt: ends,
      principal: t.principal.toString(), cap: t.cap.toString(), term: t.term, fee: w.fee.toString(), feeBps: w.feeBps, payout: w.payout.toString(),
      topUp: w.topUp.toString(), surplus: w.surplus.toString(), spend: spend.toString(), maxSpend: maxSpend.toString(), ...inAsset(c, pay, engine.engine),
    },
    summary: {
      title: `Roll loan #${i.loanId} over into a new ${f.days(t.term)} loan`,
      rows: [
        { label: "Still pledged", value: what },
        { label: "Repaid now", value: `${f.owedIn(loan.cap, pay)}, this loan in full` },
        { label: "The new loan", value: `${f.money(t.principal, pay)}, the same size, less its ${f.bps(w.feeBps)} fee` },
        { label: `You repay within ${f.days(t.term)}`, value: f.owedIn(t.cap, pay) },
        w.topUp > 0n
          ? { label: "From your wallet", value: `About ${pledgeText(c, ref, spend)}, at most ${pledgeText(c, ref, maxSpend)}, buying the ${f.owedIn(w.topUp, pay)} the new loan leaves short` }
          : { label: "Back to your wallet", value: f.money(w.surplus, pay) },
        { label: "Loan cost", value: f.bps(costBps(t.principal, t.cap)) },
        { label: "If you don't repay", value: NO_LIQUIDATION(what) },
      ],
    },
    steps: [
      ...await rightApproval(c, engine, id, wallet, router, `Approve the roll of loan #${i.loanId}`),
      ...await approval(c, pay.token, pay.symbol, wallet, router, withOthers(passThrough, others.asset)),
      ...await approval(c, loan.token, ref.symbol, wallet, router, withOthers(maxSpend, others.spend)),
      { label: "Roll over", kind: "action", final: true, build: send },
    ],
    made: (logs) => {
      const rolled = eventOf(putRouterAbi, "Rolled", router, logs, (x) => String(x.oldId) === i.loanId && same(String(x.borrower), wallet));
      return rolled ? { engine: engine.engine, loanId: String(rolled.newId) } : null;
    },
    notes: [
      "The new loan's price is signed for 30 seconds when its transaction is prepared: send it at once, or prepare again.",
      `The new loan's payout, ${f.money(passThrough, pay)}, passes through your wallet and straight back towards this loan's repayment.`,
      ...(early ? [`This loan runs until ${f.date(ends)}: rolling now repays it early, and the new loan's term starts now.`] : []),
      ...(standing ? ["Rolling by hand ends this loan's instruction to roll by itself."] : []),
      ...(others.count ? [othersNote(others.count)] : []),
      ...(pay.stable ? [] : [REPAY_IN(pay)]),
    ],
  };
}

/**
 * Rolling a put over by itself through its generation's put router: a standing instruction for gage's keeper, as for
 * the rollover router (D285), each roll at most `maxCost` (its fixed cost and fee, in the loan's asset, held on chain to
 * the unit), its top-up bought with at most `maxSpend` of the pledge's token from the wallet, up to four times. It leaves
 * standing approvals, said in the plan: the router may move every reclaim right of this wallet on this core, take each
 * roll's payout back and spend the pledge's token for four top-ups. `maxCost` starts as a roll by itself's does
 * (`autoRoll`); `maxSpend`, where none is named, at twice what buying the largest top-up costs now, the price being free
 * to move over the rolls (a named one at most the loan's pledge).
 */
async function putAutoRoll(c: Ctx, i: Extract<ActionInput, { action: "put_auto_roll" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const { g, router } = putRouterFor(c, engine, true), executor = c.d.rolloverExecutor;
  requireThat(executor, "AUTO_ROLL_CLOSED", "Rolling over by itself is not offered on this deployment");
  requireThat(loan.state === 1 || loan.state === 2, "NOT_ROLLABLE", "Only a loan waiting for funding or running can roll by itself");
  await holdsRight(c, engine, id, wallet);
  // A listing's end is not known until it is funded: the app counts it from its funding window, as here.
  const head = await chainNow(c), end = loan.state === 2 ? loan.fundedAt + loan.term : head + LISTING_SECONDS + loan.term;
  requireThat(head < end, "TERM_ENDED", "The term has ended: the lenders keep the collateral");
  requireThat(!await putPaused(c, router), "PUT_PAUSED", "Closing and rolling through the put router is paused now; the loan can still be repaid");
  const pay = g.lendAsset;
  requireThat(!same(loan.token, pay.token), "PUT_CLOSED", "This loan's pledge is the asset it is repaid in: leave it with auto_roll");
  await sameCoreAsset(c, engine.engine, pay);
  const ref = await collateralRef(c, loan.token);
  const feeBps = await c.chain.feeBps(engine.registry);
  // This loan's own fixed cost and fee: the least each roll may take (the app's `autoLimits`), and its first top-up.
  const own = loan.cap - loan.principal + (loan.principal * BigInt(feeBps)) / 10_000n;
  requireThat(!i.maxCost || BigInt(i.maxCost) <= loan.principal, "MAX_COST_TOO_HIGH", `A roll's ceiling may be at most the loan's principal, ${f.money(loan.principal, pay)}`);
  // Every roll pays the origination fee on the same principal: a ceiling below it could never run (r12 review C8).
  const rollFee = (loan.principal * BigInt(feeBps)) / 10_000n;
  requireThat(!i.maxCost || BigInt(i.maxCost) >= rollFee, "MAX_COST_TOO_LOW", `A roll's ceiling must cover at least its origination fee, ${f.owedIn(rollFee, pay)}`);
  requireThat(!i.maxSpend || BigInt(i.maxSpend) <= loan.collateral, "MAX_SPEND_TOO_HIGH", `A roll's spend may be at most the loan's pledge, ${pledgeText(c, ref, loan.collateral)}`);
  // What a roll of this running loan costs now, its new fixed cost and fee, quoted for its own term through the put router.
  const today = i.maxCost || loan.state !== 2 ? null
    : await rollFigures(c.rates, { engine: engine.engine, loanId: id, borrower: wallet, term: loan.term, oldPrincipal: loan.principal, oldCap: loan.cap, put: true })
      .then(({ terms, wallet: w }) => terms.cap - terms.principal + w.fee);
  const bound = own * DEFAULT_CEILING_OF_OWN;
  requireThat(today === null || today <= bound, "ROLL_COST_HIGH",
    `A roll of this loan costs ${f.owedIn(today ?? 0n, pay)} now, more than four times its own ${f.owedIn(own, pay)}: name maxCost to leave it a ceiling that high`);
  const most = i.maxCost ? BigInt(i.maxCost) : shownCeil(today === null ? own * 2n : today * 2n < bound ? today * 2n : bound, pay);
  // The most a roll's top-up may be, in the loan's asset: this loan's first (its own cost and fee), each later one's at the ceiling.
  const topUp = own > most ? own : most;
  let maxSpend: bigint;
  if (i.maxSpend) {
    maxSpend = BigInt(i.maxSpend);
    requireThat(maxSpend > 0n, "MAX_SPEND_ZERO", "A put roll buys its top-up with your collateral: name a spend above zero");
  }
  else {
    const quotes = await swapQuotes(c, g, router, loan.token, topUp);
    requireThat(quotes.length, "POOL_TOO_THIN", `No pool can buy a roll's ${f.owedIn(topUp, pay)} top-up with ${ref.symbol} now`);
    const twice = spendBound(quotes[0]!.cost * 2n, 0, pledgeStep(c, ref));
    maxSpend = twice < loan.collateral ? twice : loan.collateral;
  }
  // Its four rolls on top of what the wallet's other puts rolling by themselves still need: the approvals add up.
  const others = await otherPutRolls(c, engine, router, wallet, id, loan.token);
  const allowance = withOthers(BigInt(AUTO_ROLLS) * maxSpend, others.spend), passThrough = withOthers(BigInt(AUTO_ROLLS) * loan.principal, others.asset);
  const until = end + AUTO_ROLLS * loan.term + 86_400, window = autoWindow(loan.term);
  const operator: Step[] = await c.chain.approvedForAll(engine.engine, wallet, router) ? [] : [{
    label: "Let the put router follow your loans", kind: "approve", final: false,
    build: () => Promise.resolve(tx(engine.engine, encodeFunctionData({ abi: engineAbi, functionName: "setApprovalForAll", args: [router, true] }))),
  }];
  const hours = window % 3_600 === 0 ? `${window / 3_600} hours` : `${Math.floor(window / 60)} minutes`;
  return {
    view: {
      action: "put_auto_roll", ...ref, loanId: i.loanId, principal: loan.principal.toString(), term: loan.term, maxCost: most.toString(), maxSpend: maxSpend.toString(),
      rolls: AUTO_ROLLS, window, until, allowance: allowance.toString(), passThrough: passThrough.toString(), otherAutoRolls: others.count, executor, ...inAsset(c, pay, engine.engine),
    },
    summary: {
      title: `Roll loan #${i.loanId} over by itself`,
      rows: [
        { label: "Each new loan", value: `${f.money(loan.principal, pay)} for ${f.days(loan.term)}, the same as this one` },
        { label: "Each roll costs at most", value: `${f.owedIn(most, pay)}, its fixed cost and fee together` },
        { label: "From your wallet each roll", value: `At most ${pledgeText(c, ref, maxSpend)}, buying what the new loan leaves short` },
        { label: "When", value: `Up to ${AUTO_ROLLS} rolls, each in the last ${hours} of its loan, until ${f.date(until)}` },
        { label: "Approvals that stay", value: `gage's put router may move your loans on this core, take back up to ${f.money(passThrough, pay)} of their payouts and spend up to ${pledgeText(c, ref, allowance)} on their top-ups, until you withdraw them in your wallet` },
        { label: "Turning it off", value: "Any time, with put_cancel_auto_roll" },
      ],
    },
    steps: [
      ...operator,
      ...await approval(c, pay.token, pay.symbol, wallet, router, passThrough),
      ...await approval(c, loan.token, ref.symbol, wallet, router, allowance),
      call("Turn on rolling by itself", router, encodeFunctionData({ abi: putRouterAbi, functionName: "setAutoRoll", args: [id, executor, loan.term, window, most, maxSpend, AUTO_ROLLS, false, until] }), true),
    ],
    notes: [
      "gage's keeper rolls the loan only while the wallet still holds its right, the approvals stand and the wallet holds what the top-up costs; a roll it cannot make leaves the loan as it is.",
      "Each roll keeps the loan's size and term and costs no more than the ceiling, to the unit: the router refuses any other.",
      ...(i.maxCost ? [] : [today === null
        ? `The ceiling is twice what this loan costs: ${f.owedIn(own, pay)}, its fixed cost and fee together. A listing's roll cannot be quoted until it is funded.`
        : today * 2n < bound
          ? `The ceiling is twice what a roll of this loan costs now: ${f.owedIn(today, pay)}, its fixed cost and fee together.`
          : `The ceiling is four times what this loan costs, ${f.owedIn(own, pay)}, its fixed cost and fee together: a roll costs ${f.owedIn(today, pay)} now, and twice that would be more.`]),
      ...(i.maxSpend ? [] : [`Each roll may spend twice what buying its largest top-up, ${f.owedIn(topUp, pay)}, costs in ${ref.symbol} now: the price may move over its rolls.`]),
      ...(others.count ? [othersNote(others.count)] : []),
      ...(pay.stable ? [] : [REPAY_IN(pay)]),
    ],
  };
}

/** Ending a loan's instruction to roll by itself through its put router: one call, by the wallet that left it. */
async function putCancelAutoRoll(c: Ctx, i: Extract<ActionInput, { action: "put_cancel_auto_roll" }>): Promise<Plan> {
  const wallet = i.wallet as Address, id = BigInt(i.loanId);
  const { engine, loan } = await ownLoan(c, wallet, i.loanId, i.engine);
  const { router } = putRouterFor(c, engine);
  const a: AutoRollState | null = await c.chain.autoRoll(router, id);
  requireThat(a && same(a.borrower, wallet), "NO_AUTO_ROLL", "This wallet left no instruction to roll this loan through the put router");
  return {
    view: { action: "put_cancel_auto_roll", ...await collateralRef(c, loan.token), loanId: i.loanId, rollsLeft: a.rollsLeft },
    summary: { title: `Stop rolling loan #${i.loanId} over by itself`, rows: [
      { label: "Loan", value: `#${i.loanId}` },
      { label: "Rolls it would still make", value: String(a.rollsLeft) },
    ] },
    steps: [call("Turn off rolling by itself", router, encodeFunctionData({ abi: putRouterAbi, functionName: "cancelAutoRoll", args: [id] }))],
    notes: ["The put router's approvals stay: withdraw them in your wallet once no loan of this wallet rolls by itself."],
  };
}

/**
 * A partner vault of a current core, re-identified on chain (created by a public generation's factory, lending on that
 * generation's core), with its generation: the USDG one, or a lend asset's (D251); or of a retained generation.
 */
async function vaultOfRelease(c: Ctx, vault: string): Promise<{ address: Address; g: Generation }> {
  const address = vault as Address;
  let g: Generation | undefined;
  for (const x of [...c.d.generations, ...c.d.retired]) if (await c.chain.isVault(x.factory, address)) { g = x; break; }
  requireThat(g && same(await c.chain.vaultCore(address), g.core.engine), "UNKNOWN_VAULT", lendsMore(c.d) ? "This is not a partner vault of one of gage's current cores" : "This is not a partner vault of gage's current core", 404);
  return { address, g };
}
/** The vault's row in its generation's own index. */
async function indexRow(c: Ctx, address: Address, g: Generation): Promise<PartnerVault> {
  const v = await partnerOnIndex(indexerOf(c, g), c.d, g, address);
  requireThat(v, "UNKNOWN_VAULT", "This vault is not indexed yet", 404);
  return v;
}
/** A vault with its index's row, for what only that says: its fee and whether it takes deposits. */
export async function listedPartner(c: Ctx, vault: string): Promise<{ address: Address; v: PartnerVault; g: Generation }> {
  const { address, g } = await vaultOfRelease(c, vault);
  return { address, v: await indexRow(c, address, g), g };
}
/** What a plan to leave a vault says of it. */
export type VaultLabel = Pick<PartnerVault, "address" | "assets" | "categoryMask" | "mandateVersion" | "name" | "settings">;
/**
 * A vault a wallet leaves. With gage's index silent the vault itself says what the plan says of it (D439); a vault from
 * before named limits answers none of that, and goes by its family's name, sized for a full book.
 */
export async function partner(c: Ctx, vault: string): Promise<{ address: Address; v: VaultLabel; g: Generation }> {
  const { address, g } = await vaultOfRelease(c, vault);
  try {
    return { address, v: await indexRow(c, address, g), g };
  } catch (error) {
    if (!indexSilent(error)) throw error;
    const s = await c.chain.vaultManager(address);
    return { address, g, v: { address, assets: [], categoryMask: s?.categoryMask ?? 0, ...(s ? { name: s.name, mandateVersion: s.mandateVersion, settings: { bufferBps: s.bufferBps, paused: s.paused } } : {}) } };
  }
}
/** The vault's virtual shares (`IntentVault.VIRTUAL_SHARES`): one whole token of any asset starts worth 10^18 shares. */
export const VIRTUAL_SHARES = 10n ** 12n;
/** `10^(decimals − 6)`, the vault's `ASSET_SCALE` and virtual assets (Intent D55). */
export const assetScale = (a: Pick<LendAsset, "decimals">) => 10n ** BigInt(a.decimals - 6);
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

/**
 * What a redemption sized to a vault's free cash leaves of it, bps: the share's value grows a little faster than the free
 * cash each second a loan is out, so a redemption sized to the last unit passes only in the second it was read. One basis
 * point held for a day on mainnet's largest vault. An LP vault's withdrawal of everything keeps it too (lpPlans.ts).
 */
export const FREE_CASH_MARGIN_BPS = 1n;

/** The most shares a redemption from `book` may take while shares stay behind it: the largest s whose payment,
 * ⌊s × (totalAssets + ASSET_SCALE) / (totalSupply + VIRTUAL_SHARES)⌋, the free cash covers and leaves a raw unit, less
 * the margin where it is the free cash that binds, short of all the vault holds. */
export function leavingSome(book: VaultBook, scale: bigint): bigint {
  const short = book.free < book.totalAssets - 1n;
  const limit = short ? book.free : book.totalAssets - 1n;
  if (limit < 0n) return 0n;
  const most = ((limit + 1n) * (book.totalSupply + VIRTUAL_SHARES) - 1n) / (book.totalAssets + scale);
  return short ? most - (most * FREE_CASH_MARGIN_BPS) / 10_000n : most;
}

/** A full withdrawal sized without a book: every share at six decimals and while a share is worth what it started at
 * (`value / held >= ASSET_SCALE / VIRTUAL_SHARES`), else all but the shares worth a millionth of a token. */
function lastHolderShares(held: bigint, value: bigint, scale: bigint): bigint {
  if (scale === 1n || held === 0n || value === 0n || value * VIRTUAL_SHARES >= held * scale) return held;
  const dust = (scale * held + value - 1n) / value;
  return held > dust ? held - dust : 0n;
}
export const slip = (quoted: bigint, maxBps = 50) => quoted - (quoted * BigInt(maxBps)) / 10_000n;
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
 * (32 at most), with the gas booking them takes (src/gas.ts: 250,000 a loan and two more), then plans the
 * deposit or redemption again from the chain. Booking a loan past its end unpaid writes it off, which lowers the share
 * price: a deposit then buys more shares, a redemption pays less, and its minimum is computed after.
 */
export async function settleFirst(c: Ctx, vault: Address, view: View, title: string, name: string, g: Generation): Promise<Plan> {
  const ids = await settleable(c, vault, g);
  requireThat(ids.length, "SETTLEMENT_DUE", "A loan of the vault must be settled first, and none can be yet; try again shortly");
  return {
    view, summary: { title, rows: [{ label: "First", value: `Settle ${ids.length} loan${ids.length === 1 ? "" : "s"} of ${name}: a loan past its end must be booked before the vault takes deposits or pays out` }] },
    steps: [{ label: "Settle the vault's loans", kind: "action", final: false, extraGas: recordGas(BigInt(ids.length)),
      build: () => Promise.resolve(tx(vault, encodeFunctionData({ abi: partnerVaultAbi, functionName: "settle", args: [ids] }))) }],
    notes: ["Settling books each loan's outcome: one past its end unpaid is written off, which lowers the share price. Prepare again once it is mined; run() does so itself."],
    again: true,
  };
}

/**
 * The loans a settle books: those gage's index names, or with it silent those the factory's exit desk names on chain
 * (r13d, D439). A desk before r13d, or none, names none, so there is nothing to send until the index answers again.
 */
async function settleable(c: Ctx, vault: Address, g: Generation): Promise<bigint[]> {
  try {
    const acc = await indexerOf(c, g).get(`/intent/partners/vaults/${vault.toLowerCase()}/accounting`, accounting);
    return (acc.settlement?.settleable ?? []).slice(0, MAX_SETTLE).map(BigInt);
  } catch (error) {
    if (!indexSilent(error)) throw error;
    const desk = await c.chain.exitDeskOf(g.factory);
    const ids = desk ? await c.chain.pendingSettlements(desk, vault) : [];
    if (!ids.length) throw new ApiError("SETTLEMENT_DUE", "A loan of the vault must be settled first, and gage's index, which names it, does not answer; try again shortly", 409, true);
    return ids.slice(0, MAX_SETTLE);
  }
}

/**
 * r13d: the exit desk lists nothing while a record of the vault awaits its booking (`pendingSettlements`, the desk's
 * `SettlementPending`), which anyone may call and gage's keeper does each pass. The plan books `ids` first, one settle
 * step per 32 (`MAX_SETTLE`), with the gas booking them takes, then plans the exit again from the chain: a repayment or a
 * refund booked is cash the vault can pay out, and a loan past its end unpaid is written off, which lowers the share price.
 */
export function settleForExit(vault: Address, ids: readonly bigint[], view: View, title: string, name: string): Plan {
  const steps: Step[] = [];
  for (let from = 0; from < ids.length; from += MAX_SETTLE) {
    const batch = ids.slice(from, from + MAX_SETTLE);
    steps.push({ label: "Settle the vault's loans", kind: "action", final: false, extraGas: recordGas(BigInt(batch.length)),
      build: () => Promise.resolve(tx(vault, encodeFunctionData({ abi: partnerVaultAbi, functionName: "settle", args: [batch] }))) });
  }
  return {
    view, summary: { title, rows: [{ label: "First", value: `Settle ${ids.length} loan${ids.length === 1 ? "" : "s"} of ${name}: the exit desk lists none of its loans while one's outcome waits to be booked` }] },
    steps,
    notes: ["Settling books each loan's outcome for every holder: a repayment or a refund becomes cash the vault can pay, and one past its end unpaid is written off, which lowers the share price. Prepare again once it is mined; run() does so itself."],
    again: true,
  };
}

/** The smallest deposit, in six-decimal units (`IntentVault.MIN_DEPOSIT`): one whole token of any asset once scaled. */
export const MIN_DEPOSIT = 1_000_000n;
/** A vault's refusal in fixed words, a lend asset's minimum and free cash named in that asset (D251). */
/** A refusal of the vault's preview gage knows (REFUSALS); any other the index names is VAULT_REFUSED (the audit of 18 October 2026). */
const known = (code: string | null): code is string => code !== null && Object.hasOwn(REFUSALS, code);
export const vaultRefusal = (code: string | null) => (known(code) ? code : "VAULT_REFUSED");
export const refusalWords = (code: string | null, cash: LendAsset, primary: boolean) =>
  !known(code) ? undefined
    : primary ? REFUSALS[code]
      : code === "BELOW_MINIMUM" ? `The least a deposit takes is ${f.money(MIN_DEPOSIT * assetScale(cash), cash)}`
        : code === "INSUFFICIENT_LIQUIDITY" ? `More than the vault's free ${cash.symbol} now` : REFUSALS[code];
/** Before any write (Intent D55): the vault still takes and pays out the asset the plan counts in. */
export async function sameVaultAsset(c: Ctx, vault: Address, a: LendAsset) {
  requireThat(same(await c.chain.vaultAsset(vault), a.token), "ASSET_CHANGED", `This vault does not take ${a.symbol}; read it again before acting`);
}

async function earnDeposit(c: Ctx, i: Extract<ActionInput, { action: "earn_deposit" }>): Promise<Plan> {
  const wallet = i.wallet as Address, amount = BigInt(i.amount);
  // A vault takes and pays out its generation's asset (D251): USDG, or a lend asset.
  const { address, v, g } = await listedPartner(c, i.vault);
  const cash = g.lendAsset;
  requireThat(!g.retired, "FUNDING_CLOSED", "This vault's generation is retired: it takes no deposit, and pays out redemptions and claims");
  requireThat(v.fundingEnabled, "FUNDING_CLOSED", "This vault does not lend yet");
  // The vault's own generation's index (D403), which listed it.
  const index = indexerOf(c, g);
  const p = await index.get(`/intent/partners/vaults/${address.toLowerCase()}/preview?deposit=${amount}`, previewAnswer);
  if (p.refusal === "SETTLEMENT_DUE") {
    requireThat(await c.chain.balance(cash.token, wallet) >= amount, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.money(amount, cash)}`);
    const view: View = { action: "earn_deposit", vault: address, name: vaultName(v, c.d), manager: v.curator, amount: amount.toString(), minShares: "0", feeBps: v.feeBps, ...inAsset(c, cash) };
    return settleFirst(c, address, view, `Deposit ${f.money(amount, cash)} into ${vaultName(v, c.d)} (${f.short(address)})`, vaultName(v, c.d), g);
  }
  requireThat(!p.refusal, vaultRefusal(p.refusal), refusalWords(p.refusal, cash, g.primary) ?? "The vault refuses this deposit");
  const minShares = slip(BigInt(p.shares), i.maxSlippageBps);
  requireThat(minShares > 0n, "ZERO_SHARES", REFUSALS.ZERO_SHARES!);
  await sameVaultAsset(c, address, cash);
  requireThat(await c.chain.balance(cash.token, wallet) >= amount, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.money(amount, cash)}`);
  const name = `${vaultName(v, c.d)} (${f.short(address)})`;
  // The deposit claims for each of the vault's open reward records, whatever its estimate saw (src/gas.ts).
  const claims = await bookGas(c.chain, address, v.mandateVersion);
  return {
    view: { action: "earn_deposit", vault: address, name: vaultName(v, c.d), manager: v.curator, amount: amount.toString(), minShares: minShares.toString(), feeBps: v.feeBps, ...inAsset(c, cash) },
    summary: { title: `Deposit ${f.money(amount, cash)} into ${name}`, rows: [
      { label: "You deposit", value: f.money(amount, cash) },
      { label: "You receive at least", value: f.shares(minShares) },
      { label: "Performance fee", value: `${f.bps(v.feeBps)} of what the vault's loans return` },
      { label: "Taking it out", value: g.primary ? "Any time, up to the vault's free cash" : `Any time, in ${cash.symbol}, up to the vault's free ${cash.symbol}` },
    ] },
    steps: [
      ...await approval(c, cash.token, cash.symbol, wallet, address, amount),
      { ...call("Deposit", address, encodeFunctionData({ abi: partnerVaultAbi, functionName: "deposit", args: [amount, minShares] }), true), extraGas: claims },
    ],
    notes: cash.stable ? [] : [`The vault counts in ${cash.symbol}: what you withdraw is ${cash.symbol}, and in dollars it moves with ${cash.symbol}'s price.`],
  };
}

type Redemption = { assets: string; availableNow: string | null; refusal: string | null };
/**
 * A redemption as the vault would answer it now, for when gage's index is silent (D439): what its own book makes these
 * shares worth, and the refusals the index would name, in its order (services/indexer `intent-partner-accounting`). The
 * sizing above already holds them to the free cash and leaves a share behind a loan out, so those two need no refusal.
 */
async function redemptionOnChain(c: Ctx, vault: Address, wallet: Address, shares: bigint, held: bigint, book: VaultBook, worth: (n: bigint) => bigint): Promise<Redemption> {
  const [earliest, head, most] = await Promise.all([c.chain.earliestMaturity(vault), c.chain.head(), c.chain.vaultMaxRedeem(vault, wallet)]);
  const value = worth(shares), assets = value > book.totalAssets ? book.totalAssets : value;
  const refusal = earliest <= head.timestamp ? "SETTLEMENT_DUE"
    : shares === 0n || shares > book.totalSupply || shares > held ? "EXCEEDS_BALANCE"
      : book.totalAssets === 0n ? "IMPAIRED"
        // `maxRedeem`, which a vault from before ERC-4626 does not have.
        : most !== null && shares > most ? "INSUFFICIENT_LIQUIDITY" : null;
  return { assets: assets.toString(), refusal, availableNow: refusal === "INSUFFICIENT_LIQUIDITY" ? worth(most!).toString() : null };
}

async function earnRedeem(c: Ctx, i: Extract<ActionInput, { action: "earn_redeem" }>): Promise<Plan> {
  const wallet = i.wallet as Address;
  const { address, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset;
  const held = await c.chain.vaultShares(address, wallet);
  const asked = i.shares ? BigInt(i.shares) : held;
  requireThat(asked > 0n && asked <= held, "EXCEEDS_BALANCE", held === 0n ? "This wallet holds no shares of this vault" : REFUSALS.EXCEEDS_BALANCE!);
  const ask = (n: bigint): Promise<Redemption> => indexerOf(c, g).get(`/intent/partners/vaults/${address.toLowerCase()}/preview?redeem=${n}&account=${wallet.toLowerCase()}`, previewAnswer)
    .catch((error: unknown) => { if (indexSilent(error)) return redemptionOnChain(c, address, wallet, n, held, book, worth); throw error; });
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
    return settleFirst(c, address, view, `Withdraw from ${vaultName(v, c.d)} (${f.short(address)})`, vaultName(v, c.d), g);
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
  // As a deposit, the redemption claims for each of the vault's open reward records (src/gas.ts).
  const claims = await bookGas(c.chain, address, v.mandateVersion);
  return {
    view: {
      action: "earn_redeem", vault: address, name: vaultName(v, c.d), shares: shares.toString(), assets: assets.toString(), minAssets: minAssets.toString(),
      all: everything, ...inAsset(c, cash),
    },
    summary: { title: `Withdraw ${f.money(assets, cash)} from ${name}`, rows: [
      { label: "You redeem", value: shares === held ? `${f.shares(shares)} (all)` : everything && kept ? `${f.shares(shares)} (all the vault can pay)` : kept ? `${f.shares(shares)} (the most that leaves something behind your other shares)` : f.shares(shares) },
      { label: "You receive at least", value: f.money(minAssets, cash) },
    ] },
    steps: [{ ...call("Withdraw", address, encodeFunctionData({ abi: partnerVaultAbi, functionName: "redeem", args: [shares, minAssets] }), true), extraGas: claims }],
    notes: note ? [note] : [],
  };
}

/**
 * What is ready to collect here (the Portfolio's Collect all, PortfolioOverview): USDG credits, collateral, earnings,
 * the collateral and backing of loans the vaults wrote off, rewards, and what exit now sales paid, from the exit desk
 * each factory bound (Intent D57), where the release names one. A lend-asset generation's core and vaults are
 * collected too (D251), their cash and earnings counted in their own asset beside USDG's, never added to it. Each claim is simulated before it goes in, and one that would revert now
 * is left out and said, so the steps after it still go out, as the app's Collect all leaves it out (web/src/lib/walletBatch.ts):
 * a bridged sGAGE claim pays nothing while its source awaits an unlock (`GageV2Rewards.claim` reverts NothingToClaim
 * though `claimable` reads more). The first vault's credits and claims, earlier engines' lender recoveries, retired Earn strategies and the
 * GAGE/sGAGE pool's rewards and Drip are gage.cash's to collect.
 */
async function collect(c: Ctx, i: Extract<ActionInput, { action: "collect" }>): Promise<Plan> {
  const wallet = i.wallet as Address, now = await chainNow(c);
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
  const cores = [...c.d.engines, ...[...c.d.generations, ...c.d.retired].filter((g) => !g.primary).map((g) => g.core)];
  // Each core and vault is read on its own: one that does not answer is left out and named, the rest planned (D412). A
  // core's credit is the chain's and its loans the index's, each its own read: an index that does not answer leaves it.
  const [creditReads, loanReads] = await Promise.all([
    eachRead(cores, (e) => c.chain.cashCredit(e.engine, wallet), (e) => `${lendAssetOf(c.d, e.engine).symbol} credit on core ${e.engine}`),
    eachRead(cores, (e) => walletLoans(c, e.engine, wallet), (e) => `${lendAssetOf(c.d, e.engine).symbol} loans on core ${e.engine}`),
  ]);
  let sgage = 0n;
  // A paused token's pickups wait for it (D213): each token asked once, its loans named in the plan's notes.
  const pausedTokens = new Map<string, Promise<boolean>>(), waitingOn = new Set<string>();
  const pausedOf = (token: Address) => {
    const key = token.toLowerCase();
    if (!pausedTokens.has(key)) pausedTokens.set(key, pausedNow(c, token));
    return pausedTokens.get(key)!;
  };
  for (const e of cores) {
    const credit = creditReads.read.find(({ x }) => x === e)?.r ?? 0n, loans = loanReads.read.find(({ x }) => x === e)?.r ?? [];
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
          if (await pausedOf(onChain.token)) waitingOn.add((await collateralRef(c, onChain.token)).symbol);
          else {
            if (expired) steps.push(call(`Cancel unfunded loan #${p.id}`, e.engine, encodeFunctionData({ abi: engineAbi, functionName: "cancelFunding", args: [id] })));
            steps.push(takeBack(e, id, wallet));
            back.set(onChain.token.toLowerCase(), (back.get(onChain.token.toLowerCase()) ?? 0n) + onChain.collateral);
          }
        }
      }
      const owed = BigInt(l.borrowerReward) > 0n || BigInt(l.lenderReward) > 0n ? await c.chain.loanRewards(e.rewards, id, wallet) : 0n;
      if (owed > SGAGE_DUST) {
        claim(call(`Claim sGAGE of loan #${p.id}`, e.rewards, encodeFunctionData({ abi: rewardsAbi, functionName: "claim", args: [id, wallet] })), () => { sgage += owed; });
      }
    }
  }
  // What the exit desk owes the wallet from its exits' sales (Intent D57), one withdrawal a desk and asset, after the cash
  // from loans, as the app's Collect all takes it after the USDG; read only where the release names a desk.
  const exits = await exitOwed(c, wallet);
  for (const x of exits) steps.push(exitCollectStep(x));
  let earned = 0n;
  // Collateral the vaults recovered from loans written off, by token (`recover`'s pockets).
  const recovered = new Map<string, bigint>();
  // Backing added to loans the vaults wrote off, by asset (`recapitalize`'s pockets, D329).
  const backing = new Map<string, { asset: LendAsset; amount: bigint }>();
  const listed = await everyPartnerVault(c);
  const heldReads = await eachRead(listed.vaults, ({ v, g }) => indexerOf(c, g).get(`/intent/partners/vaults/${v.address.toLowerCase()}/position/${wallet.toLowerCase()}`, holding),
    ({ v }) => `the holding in ${vaultName(v, c.d)} (${v.address})`);
  const holdings = heldReads.read.map(({ x: { v, g }, r: h }) => ({ v, g, h }));
  const unread = [...creditReads.unread, ...loanReads.unread, ...listed.unread, ...heldReads.unread];
  const ready = await claimablePockets(c, holdings.map(({ g, h }) => ({ engine: g.core.engine, pockets: h.pockets, backing: h.backing })));
  for (const [n, { v, g, h }] of holdings.entries()) {
    const pockets = ready[n]!.pockets.slice(0, MAX_CLAIM_POCKETS), loans = ready[n]!.backing;
    const vault = v.address as Address;
    const rewards = BigInt(h.rewards) > SGAGE_DUST;
    // A call goes only to a vault the chain bears out as one of the generation's factory, lending on its core, as a
    // deposit's or a withdrawal's does (`partner`): the index names where to look, never what to call.
    if (!pockets.length && !loans.length && !rewards) continue;
    if (!await c.chain.isVault(g.factory, vault) || !same(await c.chain.vaultCore(vault), g.core.engine)) continue;
    // A claim takes at most MAX_CLAIM_POCKETS pockets and counts what those pay; what it leaves is said (D414).
    if (ready[n]!.pockets.length > pockets.length || loans.some((b) => b.pockets > b.next.ids.length)) more += 1;
    const pocketsCall = (ids: readonly number[]) => ids.length === 1
      ? encodeFunctionData({ abi: partnerVaultAbi, functionName: "claimPocket", args: [BigInt(ids[0]!)] })
      : encodeFunctionData({ abi: partnerVaultAbi, functionName: "claimPockets", args: [ids.map(BigInt)] });
    if (pockets.length) {
      claim(call(`Collect from ${vaultName(v, c.d)} (${f.short(vault)})`, vault, pocketsCall(pockets.map((p) => p.id))), () => {
        for (const p of pockets) {
          // A pocket in any token but the vault's own asset is collateral recovered from a loan written off: a USDG pocket
          // of a lend asset's vault is a put's pledge, never earnings. One in the vault's own asset is earnings (Intent
          // D51); backing comes by loan below.
          const amount = BigInt(p.claimable);
          if (!same(p.token, g.lendAsset.token)) recovered.set(p.token.toLowerCase(), (recovered.get(p.token.toLowerCase()) ?? 0n) + amount);
          else if (g.primary) earned += amount;
          else other(g.lendAsset).earnings += amount;
        }
      });
    }
    // Backing `recapitalize` added to a loan written off (D329), in the vault's own asset, summed by loan (D414): one
    // claim a loan, its next claim's pockets, counting what that claim pays.
    for (const b of loans.filter((x) => same(x.token, g.lendAsset.token))) {
      const key = g.lendAsset.token.toLowerCase();
      claim(call(`Collect backing${b.loanId ? ` of loan #${b.loanId}` : ""} from ${vaultName(v, c.d)} (${f.short(vault)})`, vault, pocketsCall(b.next.ids)), () => {
        backing.set(key, { asset: g.lendAsset, amount: (backing.get(key)?.amount ?? 0n) + BigInt(b.next.claimable) });
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
  for (const x of exits) rows.push({ label: same(x.asset.token, c.d.usdg) ? "From your exit now" : `From your exit now in ${x.asset.symbol}`, value: f.money(x.amount, x.asset) });
  const refs = await Promise.all([...back].map(async ([t, amount]) => ({ ...await collateralRef(c, getAddress(t)), amount })));
  if (back.size) rows.push({ label: "Collateral back", value: refs.map((r) => (r.symbol !== "tokens" || assetOf(c.d, r.token) ? f.token(r.amount, r.decimals, r.symbol) : "collateral")).join(", ") });
  if (earned > 0n) rows.push({ label: "Vault earnings", value: f.usdg(earned) });
  for (const o of lent) if (o.earnings > 0n) rows.push({ label: `Vault earnings in ${o.asset.symbol}`, value: f.money(o.earnings, o.asset) });
  const saved = await Promise.all([...recovered].map(async ([t, amount]) => ({ ...await collateralRef(c, getAddress(t)), amount })));
  if (saved.length) rows.push({ label: "Collateral recovered", value: saved.map((r) => (r.symbol !== "tokens" || assetOf(c.d, r.token) ? f.token(r.amount, r.decimals, r.symbol) : "collateral")).join(", ") });
  // USDG's first, then each lend asset's in its own, as the earnings read (D251).
  const backed = [...backing.values()].sort((a, b) => Number(!same(a.asset.token, c.d.usdg)) - Number(!same(b.asset.token, c.d.usdg)));
  for (const { asset, amount } of backed) {
    rows.push({ label: same(asset.token, c.d.usdg) ? "Backing for written-off loans" : `Backing for written-off loans in ${asset.symbol}`, value: f.money(amount, asset) });
  }
  if (sgage > 0n) rows.push({ label: "sGAGE rewards", value: `${f.units(sgage, 18, 2)} sGAGE` });
  const view: View = {
    action: "collect", usdg: cash.toString(), earnings: earned.toString(), sgage: sgage.toString(),
    collateral: refs.map(({ amount, ...r }) => ({ ...r, amount: amount.toString() })),
    ...(lent.length ? { others: lent.map((o) => ({ ...refOf(o.asset), cash: o.cash.toString(), earnings: o.earnings.toString() })) } : {}),
    ...(saved.length ? { recovered: saved.map(({ amount, ...r }) => ({ ...r, amount: amount.toString() })) } : {}),
    ...(backed.length ? { backing: backed.map(({ asset, amount }) => ({ ...refOf(asset), amount: amount.toString() })) } : {}),
    ...(exits.length ? { exits: exits.map((x) => ({ ...refOf(x.asset), amount: x.amount.toString() })) } : {}),
  };
  const notes = [
    ...(steps.length > 1 ? ["Each line is its own transaction."] : []),
    ...(left.length ? [`Left out, as ${left.length === 1 ? "it" : "each"} would revert now: ${left.join("; ")}. Collect again later.`] : []),
    ...(waitingOn.size ? [`Left out while paused: ${[...waitingOn].join(", ")} back from closed loans, which stays yours in each loan's account. Collect again once it resumes.`] : []),
    ...(more ? ["More claims are ready: collect again once these have gone through."] : []),
    ...(unread.length ? [`Not read just now, so not in this plan: ${unread.join("; ")}. Collect again later.`] : []),
  ];
  const title = steps.length ? "Collect what is ready" : unread.length ? "Some of this wallet's loans and vaults could not be read now: collect again shortly" : "Nothing is ready to collect";
  return { view, summary: { title, rows }, steps, notes, ...(unread.length ? { partial: true as const } : {}) };
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
    case "put_open": return putOpen(c, input);
    case "put_close": return putClose(c, input);
    case "put_roll": return putRoll(c, input);
    case "put_auto_roll": return putAutoRoll(c, input);
    case "put_cancel_auto_roll": return putCancelAutoRoll(c, input);
    case "earn_deposit": return earnDeposit(c, input);
    case "earn_redeem": return earnRedeem(c, input);
    case "collect": return collect(c, input);
    case "feedback": return feedback(c, input);
    case "lp_borrow": case "lp_repay": case "lp_return_position": case "lp_collect": case "lp_withdraw": case "lp_deposit": case "lp_redeem": case "lp_claim_bonus": case "lp_claim_rewards":
    case "lp_roll": case "lp_wrap": case "lp_unwrap": case "lp_create_vault": case "lp_vault_add_pool": case "lp_vault_remove_pool":
      return lpPlan(c, input);
    case "park": case "unpark": return parkPlan(c, input);
    case "rehypo_exit_now": return rehypoExitNow(c, input);
    case "earn_exit_now": return earnExitNow(c, input);
    case "earn_exit_list": return earnExitList(c, input);
    case "earn_exit_cancel": return earnExitCancel(c, input);
    case "earn_exit_collect": return earnExitCollect(c, input);
    case "create_vault": return createVaultPlan(c, input);
    case "vault_manage": return manageVaultPlan(c, input);
  }
}
