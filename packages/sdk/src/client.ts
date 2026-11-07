/**
 * The SDK's one entry (D224): `createGage()` reads gage, prepares unsigned transactions and, given the caller's own
 * signer, carries actions out. Every default is mainnet's (D260, D311): Robinhood Chain and gage.cash's own services, so
 * it serves real data with no setup; `createGage({ network: "testnet" })` is gage on Robinhood Chain testnet (D222).
 */
import type { Address } from "viem";
import { createChain } from "./chain.js";
import { foundGenerationsRefresher } from "./discovery.js";
import { parseDeployment, type Deployment } from "./deployment.js";
import { ApiError, requireThat, withoutUrls } from "./errors.js";
import { waitForFill, type FillOutcome, type WaitOptions } from "./fill.js";
import { MAINNET_MANIFEST } from "./deployments/mainnet.js";
import { TESTNET_MANIFEST } from "./deployments/testnet.js";
import { actionsOn, defaultsFor, networkNamed, type Network } from "./networks.js";
import type { Ctx } from "./plans.js";
import * as lp from "./lp.js";
import { parkBatch, parkPoolFrom, parkPoolsIn, parkPositions, type ParkBatch, type ParkPoolInput } from "./park.js";
import * as pools from "./pools.js";
import { prepareNext, type Prepared } from "./prepare.js";
import * as reads from "./reads.js";
import { run, type RunOptions, type RunResult } from "./run.js";
import {
  ACTIONS, actionInput, address, borrowQuoteInput, createVaultInput, leverageQuoteInput, loanInput, lpQuoteInput, parkId, parseInput, putQuoteInput, vaultInput, vaultOnChainInput, type ActionInput, type ActionName, type ActionRequest,
} from "./schemas.js";
import type { Signer } from "./signer.js";
import { createUpstream, type Upstream } from "./upstream.js";
import * as vaults from "./vaults.js";

export interface GageOptions {
  /**
   * The network: "mainnet" (Robinhood Chain, the default since D311) or "testnet". It picks the manifest bundled with
   * the SDK and every default below; a manifest passed in must be that network's.
   */
  network?: Network;
  /**
   * A live manifest, as gage.cash's `/api/deployment` answers it (its earlier generations then read at the network's
   * retained index, its current ones at `indexerUrl`); the network's snapshot bundled with the SDK when omitted.
   */
  manifest?: unknown;
  rpcUrl?: string;
  indexerUrl?: string;
  ratesUrl?: string;
  /**
   * A Rates API key (D382), sent to the rates service only. Without one, borrowing and lending work as ever, under the
   * service's ceiling for callers without a key; with one, its own ceiling and the model's whole quote.
   */
  apiKey?: string;
  /**
   * gage's valuation service: leverage also asks it for an aggregator's route (`GET /quote/loop-buy`, D243), KyberSwap's
   * on mainnet and, on the testnet, gage's stand-in for it (D245), and buys through it when that is cheapest and the
   * loop router admits its executor. The network's own when omitted; `null` leaves it out, and leverage then buys
   * through the manifest's pools only.
   */
  valuationUrl?: string | null;
  /** The fetch used for the indexer, the rates service and the valuation service. */
  fetch?: typeof fetch;
  /** Unix seconds; the system clock when omitted. */
  now?: () => number;
  /** The actions this Gage serves, every one when omitted; any other is refused (ACTION_NOT_SERVED). */
  actions?: readonly ActionName[];
  /**
   * Pools park and unpark serve besides the release's (D334): a DEX's own, a Uniswap v4 pool by its key (hooked ones too)
   * and the StateView that prices it, a v3-style pool by its address, tokens, fee tier and tick spacing. Each is checked;
   * one that is not refuses the Gage (INVALID_INPUT).
   */
  parkPools?: readonly ParkPoolInput[];
}
/** What a Gage built over a caller's context serves: every action unless it names fewer. */
export interface GageScope {
  actions?: readonly ActionName[];
  /** Brings `ctx.d` up to date before each method (lend generations found since the release: src/discovery.ts). */
  refresh?: (force?: boolean) => Promise<void>;
}

type Input<T extends (c: Ctx, i: never) => unknown> = Parameters<T>[1];
type Answer<T extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>;

export interface Gage {
  readonly ctx: Ctx;
  readonly deployment: Deployment;
  /** The actions it prepares and carries out, as `capabilities()` lists them. */
  readonly actions: readonly ActionName[];
  /** Chain, contracts, allowed terms, fees and the rules. */
  capabilities(): Promise<Answer<typeof reads.capabilities>>;
  /** Tokens gage admits as collateral now: each one's minimum, its most per loan where one is set, whether leverage buys it, how many partner vaults lend against it, and its gage.cash link. */
  assets(): Promise<Answer<typeof reads.assets>>;
  /** The largest loan the partner vaults fund now for at most `maxCollateral`, or one exact loan (`collateral`, `principal`), with a `prepare` object. */
  borrowQuote(input: Input<typeof reads.borrowQuote>): Promise<Answer<typeof reads.borrowQuote>>;
  /** A leveraged loop's amounts, cost and the most the purchase costs; signs nothing. */
  leverageQuote(input: Input<typeof reads.leverageQuote>): Promise<Answer<typeof reads.leverageQuote>>;
  /** A put's pledge, purchase, loan, repayment, cost and the most the purchase costs, with a `prepare` object; signs nothing. */
  putQuote(input: Input<typeof reads.putQuote>): Promise<Answer<typeof reads.putQuote>>;
  /**
   * One loan's state, amounts, deadlines, what can be done with it now (here, or on gage.cash for an action this Gage
   * does not serve), its standing instruction to roll and what closed it; a private loan reads as unknown.
   */
  loan(input: Input<typeof reads.loan>): Promise<Answer<typeof reads.loan>>;
  /** A wallet's loans (each one's sGAGE and whether it rolls by itself), Earn holdings and USDG credit. */
  portfolio(wallet: string): Promise<Answer<typeof reads.portfolio>>;
  /** The partner vaults: tokens, fee, size, free cash, share value and gage.cash link. */
  earnVaults(): Promise<Answer<typeof reads.earnVaults>>;
  /**
   * One partner vault's free cash (D335): what withdrawals are paid from now, what comes back to it as its loans end
   * (`schedule`, by day; `settling`, what the next settle books), only if their borrowers repay, and `bufferBps`, the
   * share of the vault a new loan must leave free ("Cash kept free").
   */
  vaultFreeCash(input: Input<typeof reads.vaultFreeCash>): Promise<Answer<typeof reads.vaultFreeCash>>;
  /** A wallet's ETH for gas, USDG and collateral tokens. */
  balances(wallet: string): Promise<Answer<typeof reads.balances>>;
  /**
   * The LP lane (docs/api.md "LP lane"), where the release makes it public (`deployment.lpLane`; LP_CLOSED elsewhere): a
   * wallet's Uniswap v3 and v4, SushiSwap v3, Ouro v3 and Ramses positions in a pool the lane lends against, with their worth at
   * the pool's price (its Uniswap v4 positions named by gage's index, each checked on chain).
   */
  lpPositions(wallet: string): Promise<Answer<typeof lp.lpPositions>>;
  /** A fixed-cost USDG loan against one position, signed for the wallet for five minutes at most, with a `prepare` object for lp_borrow. */
  lpQuote(input: Input<typeof lp.lpQuote>): Promise<Answer<typeof lp.lpQuote>>;
  /** A wallet's LP loans, what can be done with each now, and its credits on the lane's core. */
  lpLoans(wallet: string): Promise<Answer<typeof lp.lpLoans>>;
  /** The LP vaults: size, free cash, loans out, share value, fee and whether they take deposits and pay out now. */
  lpVaults(): Promise<Answer<typeof lp.lpVaults>>;
  /**
   * A DEX pool's vaults, one for each pool token gage lends, each on its own generation (D333): the calls that create
   * them from the curator, for one wallet batch, and the same as a Safe's Transaction Builder file. Simulated now; signs
   * nothing.
   */
  createPoolVaults(input: Input<typeof pools.createPoolVaults>): Promise<Answer<typeof pools.createPoolVaults>>;
  /** The pools among the partner vaults, a curator's alone where one is named: each one's two sides, a vault or none. */
  poolVaults(input?: Input<typeof pools.poolVaults>): Promise<Answer<typeof pools.poolVaults>>;
  /**
   * One partner vault, with a free name: the call that creates it from the curator, simulated now, and the same as a
   * Safe's Transaction Builder file. Signs nothing; `run({ action: "create_vault", … }, signer)` carries it out.
   */
  createVault(input: Input<typeof vaults.createVault>): Promise<Answer<typeof vaults.createVault>>;
  /**
   * One partner vault read from the chain alone, gage's index not asked: its book, its manager's settings and what waits,
   * and with `wallet` what the vault can pay it now and the call that withdraws that.
   */
  vaultOnChain(input: Input<typeof vaults.vaultOnChain>): Promise<Answer<typeof vaults.vaultOnChain>>;
  /**
   * A wallet's out-of-range positions in the pools park serves (D334): each one's pool, range and the one token it holds,
   * with the partner vaults that take it. `also` names positions a v4 PositionManager or a Fables hook cannot list.
   */
  parkPositions(wallet: string, also?: readonly { manager: string; id: string }[]): Promise<Answer<typeof parkPositions>>;
  /** A park as one batch of calls for the wallet (EIP-5792), simulated whole first; `prepare` and `run` take it as action `park`. */
  parkCalls(input: unknown): Promise<ParkBatch>;
  /** An unpark as one batch of calls for the wallet (EIP-5792), simulated whole first; `prepare` and `run` take it as action `unpark`. */
  unparkCalls(input: unknown): Promise<ParkBatch>;
  /** The next unsigned transaction of an action (simulated now) and the steps after it. Prepare again after each one. */
  prepare(input: unknown): Promise<Prepared>;
  /** Carries an action out with the caller's signer, for the signer's own wallet. */
  run(input: ActionRequest, signer: Signer, options?: RunOptions): Promise<RunResult>;
  /** Waits for a listing to be funded (`run`'s `loan`); then `collect` sends its payout to the wallet. */
  waitForFill(input: { loanId: string; engine?: string }, options?: WaitOptions): Promise<FillOutcome>;
  /** Asks gage's indexer now for the lend generations found since the release; every other method asks at most once a minute. */
  refreshGenerations(): Promise<void>;
}

/** A Gage over a context its caller built: the hosted service builds its own from the live manifest; tests pass fakes. */
export function gageFrom(ctx: Ctx, scope: GageScope = {}): Gage {
  const wallet = (value: string) => parseInput(address, value) as Address;
  // Only what the deployment can carry out (`actionsOn`): rating gage (D302) where gage has an ERC-8004 entry, rolling
  // over where a generation has its router, cashing out where a core has one, whatever the scope names.
  const actions = (scope.actions ?? ACTIONS).filter((a) => actionsOn({ ...ctx.d, parkPools: parkPoolsIn(ctx) }).includes(a));
  // An action this Gage does not serve is refused before anything is read.
  const served = <T extends ActionInput>(input: T): T => {
    requireThat(actions.includes(input.action), "ACTION_NOT_SERVED", `This service does not serve ${input.action}; it serves ${actions.join(", ")}`, 400);
    return input;
  };
  // Every method is async, so a refused input rejects its promise rather than throwing at the call.
  const gage: Gage = {
    ctx, get deployment() { return ctx.d; }, actions,
    capabilities: async () => reads.capabilities(ctx, actions),
    assets: async () => reads.assets(ctx),
    borrowQuote: async (input) => reads.borrowQuote(ctx, parseInput(borrowQuoteInput, input)),
    leverageQuote: async (input) => reads.leverageQuote(ctx, parseInput(leverageQuoteInput, input)),
    putQuote: async (input) => reads.putQuote(ctx, parseInput(putQuoteInput, input)),
    loan: async (input) => reads.loan(ctx, parseInput(loanInput, input), actions),
    portfolio: async (w) => reads.portfolio(ctx, wallet(w), actions),
    earnVaults: async () => reads.earnVaults(ctx),
    vaultFreeCash: async (input) => reads.vaultFreeCash(ctx, parseInput(vaultInput, input)),
    balances: async (w) => reads.balances(ctx, wallet(w)),
    lpPositions: async (w) => lp.lpPositions(ctx, wallet(w)),
    lpQuote: async (input) => lp.lpQuote(ctx, parseInput(lpQuoteInput, input)),
    lpLoans: async (w) => lp.lpLoans(ctx, wallet(w), actions),
    lpVaults: async () => lp.lpVaults(ctx),
    createPoolVaults: async (input) => pools.createPoolVaults(ctx, parseInput(pools.createPoolVaultsInput, input)),
    poolVaults: async (input) => pools.poolVaults(ctx, parseInput(pools.poolVaultsInput, input ?? {})),
    createVault: async (input) => vaults.createVault(ctx, parseInput(createVaultInput, input)),
    vaultOnChain: async (input) => vaults.vaultOnChain(ctx, parseInput(vaultOnChainInput, input)),
    parkPositions: async (w, also = []) => parkPositions(ctx, wallet(w), also.map((x) => ({ manager: parseInput(address, x.manager), id: parseInput(parkId, x.id) }))),
    parkCalls: async (input) => parkBatch(ctx, served(parseInput(actionInput, { ...(input as object), action: "park" })) as Extract<ActionInput, { action: "park" }>),
    unparkCalls: async (input) => parkBatch(ctx, served(parseInput(actionInput, { ...(input as object), action: "unpark" })) as Extract<ActionInput, { action: "unpark" }>),
    prepare: async (input) => prepareNext(ctx, served(parseInput(actionInput, input))),
    run: async (input, signer, options) => {
      // The signer's own wallet acts: an input naming another one is refused rather than overridden.
      const named = (input as { wallet?: unknown }).wallet;
      requireThat(named === undefined || (typeof named === "string" && named.toLowerCase() === signer.address.toLowerCase()), "WALLET_MISMATCH", "The signer is not the wallet this action is for", 400);
      return run(ctx, served(parseInput(actionInput, { ...input, wallet: signer.address })), signer, options);
    },
    waitForFill: async (input, options) => waitForFill(ctx, parseInput(loanInput, input), options),
    refreshGenerations: async () => { await scope.refresh?.(true); },
  };
  // Lend generations found since the release: each method reads the latest deployment, asked for at most once a minute. And
  // what is no refusal of the SDK's own (an RPC's failure, whose words can carry its URL) reaches a caller as one fixed
  // answer, what failed its cause without any URL (D221). A caller's own bug, which asking again cannot clear, says so.
  const refresh = scope.refresh;
  for (const [name, method] of Object.entries(gage)) {
    if (typeof method !== "function") continue;
    Object.assign(gage, {
      [name]: async (...args: unknown[]) => {
        try {
          if (refresh && name !== "refreshGenerations") await refresh();
          return await (method as (...a: unknown[]) => unknown)(...args);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (error instanceof TypeError || error instanceof ReferenceError) throw new ApiError("INVALID_CALL", "This call cannot work as written: its cause says why", 400, false, { cause: error });
          throw new ApiError("UNAVAILABLE", "gage could not answer this now", 503, true, { cause: withoutUrls(error) });
        }
      },
    });
  }
  return gage;
}

/** A manifest as it was given: gage.cash's `/api/deployment` answers one under `deployment`. */
const manifestIn = (given: unknown): unknown => {
  const inner = given && typeof given === "object" ? (given as { deployment?: unknown }).deployment : undefined;
  return inner && typeof inner === "object" ? inner : given;
};
/** A manifest read as `createGage` takes it: what it cannot read is refused with a code, in the reader's own words. */
function readManifest(raw: unknown): Deployment {
  try {
    return parseDeployment(raw);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_MANIFEST", error instanceof Error ? error.message : "This manifest cannot be read", 400, false, { cause: error });
  }
}

/**
 * A Gage on mainnet (the default since D311), on the hosted testnet (`network: "testnet"`), or wherever the options
 * point. A manifest given without a network decides it.
 */
export function createGage(options: GageOptions = {}): Gage {
  const named = options.network === undefined ? undefined : networkNamed(options.network);
  const bundled = named?.network === "testnet" ? TESTNET_MANIFEST : MAINNET_MANIFEST;
  const raw = manifestIn(options.manifest ?? bundled);
  const d = readManifest(raw);
  if (named && named.chainId !== d.chainId) throw new ApiError("NETWORK_MISMATCH", `The manifest is not the ${named.network}'s`, 400);
  const n = defaultsFor(d.chainId);
  const valuationUrl = options.valuationUrl === undefined ? n.valuationUrl : options.valuationUrl;
  const indexes = new Map<string, Upstream>();
  const ctx: Ctx = {
    d, chain: createChain(options.rpcUrl ?? n.rpcUrl, d.chainId),
    indexer: createUpstream(options.indexerUrl ?? n.indexerUrl, options.fetch),
    rates: createUpstream(options.ratesUrl ?? n.ratesUrl, options.fetch, options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    // A generation's own index, current or retained, from the manifest (D403), read with the caller's fetch.
    indexerAt: (url) => indexes.get(url) ?? indexes.set(url, createUpstream(url, options.fetch)).get(url)!,
    ...(valuationUrl ? { valuation: createUpstream(valuationUrl, options.fetch) } : {}),
    ...(options.parkPools?.length ? { parkPools: options.parkPools.map(parkPoolFrom) } : {}),
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
  };
  // The release adds the lend generations its GenerationDeployer deployed since, from gage's indexer.
  return gageFrom(ctx, { ...(options.actions ? { actions: options.actions } : {}), refresh: foundGenerationsRefresher(ctx, raw) });
}
