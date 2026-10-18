/**
 * The SDK's one entry (D224): `createGage()` reads gage, prepares unsigned transactions and, given the caller's own
 * signer, carries actions out. Every default is the hosted testnet (D222), so it serves real data with no setup;
 * `createGage({ network: "mainnet" })` is gage on Robinhood Chain (D260), with mainnet's own defaults.
 */
import type { Address } from "viem";
import { createChain } from "./chain.js";
import { parseDeployment, type Deployment } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import { waitForFill, type FillOutcome, type WaitOptions } from "./fill.js";
import { MAINNET_MANIFEST } from "./deployments/mainnet.js";
import { TESTNET_MANIFEST } from "./deployments/testnet.js";
import { actionsOn, defaultsFor, networkNamed, type Network } from "./networks.js";
import type { Ctx } from "./plans.js";
import { prepareNext, type Prepared } from "./prepare.js";
import * as reads from "./reads.js";
import { run, type RunOptions, type RunResult } from "./run.js";
import { ACTIONS, actionInput, address, borrowQuoteInput, leverageQuoteInput, loanInput, parseInput, type ActionInput, type ActionName, type ActionRequest } from "./schemas.js";
import type { Signer } from "./signer.js";
import { createUpstream } from "./upstream.js";

export interface GageOptions {
  /**
   * The network: "testnet" (the default) or "mainnet" (Robinhood Chain, D260). It picks the manifest bundled with the
   * SDK and every default below; a manifest passed in must be that network's.
   */
  network?: Network;
  /** A live manifest (`launch/live/<chainId>.json`); the network's snapshot bundled with the SDK when omitted. */
  manifest?: unknown;
  rpcUrl?: string;
  indexerUrl?: string;
  ratesUrl?: string;
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
}
/** What a Gage built over a caller's context serves: every action unless it names fewer. */
export interface GageScope { actions?: readonly ActionName[] }

type Input<T extends (c: Ctx, i: never) => unknown> = Parameters<T>[1];
type Answer<T extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>;

export interface Gage {
  readonly ctx: Ctx;
  readonly deployment: Deployment;
  /** The actions it prepares and carries out, as `capabilities()` lists them. */
  readonly actions: readonly ActionName[];
  /** Chain, contracts, allowed terms, fees and the rules. */
  capabilities(): Promise<Answer<typeof reads.capabilities>>;
  /** Tokens gage takes as collateral now: each one's minimum, its most per loan where one is set, whether leverage buys it, and its gage.cash link. */
  assets(): Promise<Answer<typeof reads.assets>>;
  /** The largest loan the partner vaults fund now for at most `maxCollateral`, or one exact loan (`collateral`, `principal`), with a `prepare` object. */
  borrowQuote(input: Input<typeof reads.borrowQuote>): Promise<Answer<typeof reads.borrowQuote>>;
  /** A leveraged loop's amounts, cost and the most the purchase costs; signs nothing. */
  leverageQuote(input: Input<typeof reads.leverageQuote>): Promise<Answer<typeof reads.leverageQuote>>;
  /**
   * One loan's state, amounts, deadlines, what can be done with it now (here, or on gage.cash for an action this Gage
   * does not serve), its standing instruction to roll and what closed it; a private loan reads as unknown.
   */
  loan(input: Input<typeof reads.loan>): Promise<Answer<typeof reads.loan>>;
  /** A wallet's loans (each one's sGAGE and whether it rolls by itself), Earn holdings and USDG credit. */
  portfolio(wallet: string): Promise<Answer<typeof reads.portfolio>>;
  /** The partner vaults: tokens, fee, size, free cash, share value and gage.cash link. */
  earnVaults(): Promise<Answer<typeof reads.earnVaults>>;
  /** A wallet's ETH for gas, USDG and collateral tokens. */
  balances(wallet: string): Promise<Answer<typeof reads.balances>>;
  /** The next unsigned transaction of an action (simulated now) and the steps after it. Prepare again after each one. */
  prepare(input: unknown): Promise<Prepared>;
  /** Carries an action out with the caller's signer, for the signer's own wallet. */
  run(input: ActionRequest, signer: Signer, options?: RunOptions): Promise<RunResult>;
  /** Waits for a listing to be funded (`run`'s `loan`); then `collect` sends its payout to the wallet. */
  waitForFill(input: { loanId: string; engine?: string }, options?: WaitOptions): Promise<FillOutcome>;
}

/** A Gage over a context its caller built: the hosted service builds its own from the live manifest; tests pass fakes. */
export function gageFrom(ctx: Ctx, scope: GageScope = {}): Gage {
  const wallet = (value: string) => parseInput(address, value) as Address;
  // Only what the deployment can carry out (`actionsOn`): rating gage (D302) where gage has an ERC-8004 entry, rolling
  // over where a generation has its router, cashing out where a core has one, whatever the scope names.
  const actions = (scope.actions ?? ACTIONS).filter((a) => actionsOn(ctx.d).includes(a));
  // An action this Gage does not serve is refused before anything is read.
  const served = <T extends ActionInput>(input: T): T => {
    requireThat(actions.includes(input.action), "ACTION_NOT_SERVED", `This service does not serve ${input.action}; it serves ${actions.join(", ")}`, 400);
    return input;
  };
  // Every method is async, so a refused input rejects its promise rather than throwing at the call.
  return {
    ctx, deployment: ctx.d, actions,
    capabilities: async () => reads.capabilities(ctx, actions),
    assets: async () => reads.assets(ctx),
    borrowQuote: async (input) => reads.borrowQuote(ctx, parseInput(borrowQuoteInput, input)),
    leverageQuote: async (input) => reads.leverageQuote(ctx, parseInput(leverageQuoteInput, input)),
    loan: async (input) => reads.loan(ctx, parseInput(loanInput, input), actions),
    portfolio: async (w) => reads.portfolio(ctx, wallet(w)),
    earnVaults: async () => reads.earnVaults(ctx),
    balances: async (w) => reads.balances(ctx, wallet(w)),
    prepare: async (input) => prepareNext(ctx, served(parseInput(actionInput, input))),
    run: async (input, signer, options) => {
      // The signer's own wallet acts: an input naming another one is refused rather than overridden.
      const named = (input as { wallet?: unknown }).wallet;
      requireThat(named === undefined || (typeof named === "string" && named.toLowerCase() === signer.address.toLowerCase()), "WALLET_MISMATCH", "The signer is not the wallet this action is for", 400);
      return run(ctx, served(parseInput(actionInput, { ...input, wallet: signer.address })), signer, options);
    },
    waitForFill: async (input, options) => waitForFill(ctx, parseInput(loanInput, input), options),
  };
}

/** A Gage on the hosted testnet, on mainnet (`network: "mainnet"`), or wherever the options point. */
export function createGage(options: GageOptions = {}): Gage {
  const named = options.network === undefined ? undefined : networkNamed(options.network);
  const bundled = named?.network === "mainnet" ? MAINNET_MANIFEST : TESTNET_MANIFEST;
  const d = parseDeployment(options.manifest ?? bundled);
  if (named && named.chainId !== d.chainId) throw new ApiError("NETWORK_MISMATCH", `The manifest is not the ${named.network}'s`, 400);
  const n = defaultsFor(d.chainId);
  const valuationUrl = options.valuationUrl === undefined ? n.valuationUrl : options.valuationUrl;
  return gageFrom({
    d, chain: createChain(options.rpcUrl ?? n.rpcUrl, d.chainId),
    indexer: createUpstream(options.indexerUrl ?? n.indexerUrl, options.fetch),
    rates: createUpstream(options.ratesUrl ?? n.ratesUrl, options.fetch),
    ...(valuationUrl ? { valuation: createUpstream(valuationUrl, options.fetch) } : {}),
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
  }, options.actions ? { actions: options.actions } : {});
}
