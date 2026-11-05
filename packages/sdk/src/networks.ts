/**
 * Where gage runs: Robinhood Chain (4663) since D260, and its testnet (46630, D222). Each network has its public RPC,
 * gage's own services there and the app. Mainnet is the default since D311: the testnet is chosen by name (`network:
 * "testnet"`) or by a testnet manifest.
 */
import type { Address } from "viem";
import { MAINNET, putGenerations, TESTNET, type ChainId, type Deployment } from "./deployment.js";
import { ApiError } from "./errors.js";
import { ACTIONS, type ActionName } from "./schemas.js";

export type Network = "mainnet" | "testnet";

/**
 * gage's own entry in ERC-8004 (D291): its agent id, the Identity Registry that holds it (owned by the owner Safe) and
 * the Reputation Registry where an agent that used gage may rate it (D302).
 */
export interface Beacon { readonly agentId: number; readonly identityRegistry: Address; readonly reputationRegistry: Address }

export interface NetworkDefaults {
  readonly network: Network;
  readonly chainId: ChainId;
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly ratesUrl: string;
  /** Where leverage asks for an aggregator's route (D243): KyberSwap's on mainnet, gage's stand-in for it on the testnet (D245). */
  readonly valuationUrl: string;
  /** The app: review links open there. */
  readonly appUrl: string;
  /** gage's faucet: gas and test tokens for a new wallet (Valet, D225). The testnet's only. */
  readonly faucetUrl: string | null;
  /** gage's entry in ERC-8004 (D291, D302). Mainnet's only: gage has none on the testnet, so nothing is rated there. */
  readonly beacon: Beacon | null;
}

/** The hosted testnet: its public RPC and gage's own services there. */
export const TESTNET_DEFAULTS = {
  network: "testnet",
  chainId: TESTNET,
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  indexerUrl: "https://indexer-rehearsal.up.railway.app",
  ratesUrl: "https://rates-rehearsal.up.railway.app",
  valuationUrl: "https://valuation-rehearsal.up.railway.app",
  appUrl: "https://testnet.gage.cash",
  faucetUrl: "https://faucet-rehearsal.up.railway.app",
  beacon: null,
} as const satisfies NetworkDefaults;

/**
 * Mainnet: the public RPC wallets get and the services gage.cash reads (launch/mainnet.release.json). No faucet. gage is
 * agent #8845 in ERC-8004's canonical registries on Robinhood Chain (D291).
 */
export const MAINNET_DEFAULTS = {
  network: "mainnet",
  chainId: MAINNET,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  indexerUrl: "https://indexer-production-a5e5.up.railway.app",
  ratesUrl: "https://rates-mainnet.up.railway.app",
  valuationUrl: "https://valuation-production-2d79.up.railway.app",
  appUrl: "https://gage.cash",
  faucetUrl: null,
  beacon: {
    agentId: 8845,
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
} as const satisfies NetworkDefaults;

/**
 * The loan terms gage offers on a chain, of those its registry allows, in seconds: on mainnet the product's 7 and 21
 * days alone (a registry may allow more, such as a 1-day term, which no vault there lends for and the rates service does
 * not price), on the testnet every one its registry allows (web/src/lib/terms.ts).
 */
export const MAINNET_TERMS: readonly number[] = [7 * 86_400, 21 * 86_400];
export const offeredTerms = (chainId: ChainId, allowed: readonly number[]): number[] =>
  (chainId === MAINNET ? MAINNET_TERMS.filter((t) => allowed.includes(t)) : [...allowed]);

/** The defaults of a chain gage runs on. */
export const defaultsFor = (chainId: ChainId): NetworkDefaults => (chainId === MAINNET ? MAINNET_DEFAULTS : TESTNET_DEFAULTS);

/** A network by name; anything else is refused rather than read as the testnet. */
export function networkNamed(name: unknown): NetworkDefaults {
  if (name === "mainnet") return MAINNET_DEFAULTS;
  if (name === "testnet") return TESTNET_DEFAULTS;
  throw new ApiError("UNKNOWN_NETWORK", 'Unknown network: use "mainnet" or "testnet"', 400);
}

/**
 * The actions gage serves on a deployment: every one it can carry out there. Rating gage (`feedback`, D302) only where
 * gage has an ERC-8004 entry; rolling over (D285) only where a current generation has its rollover router, and by itself
 * only with the keeper the release names (`rolloverExecutor`); a cash-out (D245) only where a core has its cash-out
 * router. A put opens only where a lend asset's generation offers puts (`putGenerations`: USDG among its collateral, its
 * loop and put routers named), and closes and rolls wherever a current generation names its put router, by itself with
 * the keeper. A generation the release keeps for its positions alone (`retired`) rolls nothing, since gage's keeper and
 * rates service serve current generations only; where one names a rollover or put router, an instruction left there is
 * still ended (`cancel_auto_roll`, `put_cancel_auto_roll`) and a put on it closed (`put_close`).
 * The LP lane's actions (D314, D315) only where the release makes the lane public (`lpLane`), as the app serves it, its
 * roll (D317) with them, and wrapping Fables receipts into a position and back only where it names a Fables adapter (D316).
 * The testnet's release names no rollover router, so it serves no roll. Park and unpark (D334) where there is a pool to
 * serve: the release's LP lane's, whatever its switch, or one the caller added (`parkPools`). A rehypo pool's exit now
 * (root D357), and a partner vault's with its next listing, its cancel and what its sales paid, where a current
 * generation names its exit desk (Intent D57).
 */
export function actionsOn(d: Pick<Deployment, "chainId" | "usdg" | "engines" | "generations" | "rolloverExecutor"> & Partial<Pick<Deployment, "lpLane" | "retired" | "parkPools">>): ActionName[] {
  const rolls = d.generations.some((g) => g.rolloverRouter !== null);
  const sells = [...d.engines, ...d.generations.map((g) => g.core)].some((e) => e.cashoutRouter !== null);
  const puts = d.generations.some((g) => g.putRouter !== null);
  // What a retained generation's routers still do: end the instructions left on them, and close a put.
  const kept = d.retired ?? [];
  const ends = rolls || kept.some((g) => g.rolloverRouter !== null), closes = puts || kept.some((g) => g.putRouter !== null);
  const lp = Boolean(d.lpLane), fables = Boolean(d.lpLane?.adapters.some((a) => a.kind === "fables")), curators = Boolean(d.lpLane?.vaultFactory);
  const desk = d.generations.some((g) => g.exitDesk !== null);
  const served: Record<ActionName, boolean> = {
    borrow: true, leverage: true, cancel: true, reclaim: true, cash_out: sells, roll: rolls, auto_roll: rolls && d.rolloverExecutor !== null,
    cancel_auto_roll: ends, earn_deposit: true, earn_redeem: true, collect: true, feedback: defaultsFor(d.chainId).beacon !== null,
    put_open: putGenerations(d).length > 0, put_close: closes, put_roll: puts, put_auto_roll: puts && d.rolloverExecutor !== null, put_cancel_auto_roll: closes,
    lp_borrow: lp, lp_repay: lp, lp_return_position: lp, lp_collect: lp, lp_withdraw: lp, lp_deposit: lp, lp_redeem: lp, lp_claim_bonus: lp, lp_roll: lp,
    lp_wrap: fables, lp_unwrap: fables, lp_create_vault: curators, lp_vault_add_pool: lp, lp_vault_remove_pool: lp,
    park: (d.parkPools?.length ?? 0) > 0, unpark: (d.parkPools?.length ?? 0) > 0,
    rehypo_exit_now: desk, earn_exit_now: desk, earn_exit_list: desk, earn_exit_cancel: desk, earn_exit_collect: desk,
  };
  return ACTIONS.filter((a) => served[a]);
}
