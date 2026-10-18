/**
 * Where gage runs: Robinhood Chain (4663) since D260, and its testnet (46630, D222). Each network has its public RPC,
 * gage's own services there and the app. Mainnet is the default since D311: the testnet is chosen by name (`network:
 * "testnet"`) or by a testnet manifest.
 */
import type { Address } from "viem";
import { MAINNET, TESTNET, type ChainId, type Deployment } from "./deployment.js";
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
 * gage has an ERC-8004 entry; rolling over (D285) only where a generation has its rollover router, and by itself only
 * with the keeper the release names (`rolloverExecutor`); a cash-out (D245) only where a core has its cash-out router.
 * The testnet's release names no rollover router, so it serves no roll.
 */
export function actionsOn(d: Pick<Deployment, "chainId" | "engines" | "generations" | "rolloverExecutor">): ActionName[] {
  const rolls = d.generations.some((g) => g.rolloverRouter !== null);
  const sells = [...d.engines, ...d.generations.map((g) => g.core)].some((e) => e.cashoutRouter !== null);
  const served: Record<ActionName, boolean> = {
    borrow: true, leverage: true, cancel: true, reclaim: true, cash_out: sells, roll: rolls, auto_roll: rolls && d.rolloverExecutor !== null,
    cancel_auto_roll: rolls, earn_deposit: true, earn_redeem: true, collect: true, feedback: defaultsFor(d.chainId).beacon !== null,
  };
  return ACTIONS.filter((a) => served[a]);
}
