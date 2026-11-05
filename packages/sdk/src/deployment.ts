import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { tokenLinks } from "./links.js";
import { poolId } from "./v4math.js";

/** The chains gage for agents serves: the testnet (D222), and mainnet since the founder opened Steward and Builders there (D260). */
export const TESTNET = 46630;
export const MAINNET = 4663;
export type ChainId = typeof TESTNET | typeof MAINNET;

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
/**
 * A pool leverage may buy a token through: a hookless Uniswap v4 pool by its key (`LoopRouter.loop`), or a Uniswap V3
 * pool by its address and fee tier (`loopV3`, D242), which the router finds again as its V3 factory's pool of the token,
 * USDG and that fee.
 */
export type LoopPool = { kind: "v4"; key: PoolKey } | { kind: "v3"; pool: Address; fee: number };
/**
 * A core: its registry and rewards, and the router a loan on it cashes out through (D245); null where none is named.
 * `registryRewards`: an unbridged core whose own registry quotes its listings' sGAGE and whose ledger pays them from a
 * treasury-funded budget (R2 option C, a stablecoin lend market's: `engine.bridged` false and `engine.rewardTerms`
 * "registry" in the release); absent on every other core, USDG's bridged one included.
 */
export interface Engine { engine: Address; registry: Address; rewards: Address; name: string; cashoutRouter: Address | null; registryRewards?: boolean }
export interface Asset { token: Address; symbol: string; name: string; decimals: number; lane: string }
/** What a generation lends (D251, Intent D55): USDG, or another asset at its own decimals (6 to 18). */
export interface LendAsset { token: Address; symbol: string; decimals: number; stable: boolean }
/**
 * One generation of partner vaults (D251): the asset it lends, its core (an engine whose `USDG()` is that asset) and its
 * factory. The USDG generation (`intentV1`) comes first and is the only `primary` one of `generations`: leverage, 1-day
 * loans, sGAGE rewards and loan sales are its alone (a retained USDG generation is `primary` too, for its figures). A lend-asset generation (`intentV1Assets`) lends against the tokens of its own
 * `collateral` list (D249), through its own registry.
 */
export interface Generation {
  /** "USDG", or the lend asset's key in `intentV1Assets` (its symbol on this chain). */
  id: string;
  primary: boolean;
  lendAsset: LendAsset;
  core: Engine;
  factory: Address;
  /** The tokens a lend-asset generation lends against, as the release names them; empty for USDG's, which lends against `assets`. */
  collateral: { token: Address; symbol: string; category: string }[];
  /** The router that rolls this generation's loans over (D285), its core's alone; null where the release names none. */
  rolloverRouter: Address | null;
  /**
   * The router leverage loops through on this generation's core (D240, D242): `intentV1.loopRouter` for USDG's; a lend
   * asset's own `loopRouter`, built on its fill router, through which its puts open (docs/api.md "Puts on lend-asset
   * generations"). Null where the release names none.
   */
  loopRouter: Address | null;
  /** Its put router (`PutRouter`): a loan on its core closes and rolls paying only in its collateral token; null where none is named. */
  putRouter: Address | null;
  /**
   * The exit desk the release names for its factory (Intent D57: `intentV1.exitDesk`, `intentV1Assets.<SYM>.exitDesk`);
   * null where it names none. Which desk the factory names now is read on chain.
   */
  exitDesk: Address | null;
  /**
   * Every pool a loop on this core may buy each of its collateral tokens through, paid in its lend asset (lowercase
   * token): USDG's are the deployment's `loopPools`; a lend asset's, the hookless v4 and V3 rows pairing it with a token
   * of its own list, from its `cashoutPools`, then the manifest's `pools`, `nativeV2.routingPools` and
   * `nativeV2.cashoutPools`. A put router buys the repayment back through the same pools.
   */
  loopPools: ReadonlyMap<string, LoopPool[]>;
  /** An earlier generation the release keeps for its positions (`Deployment.retired`): read from its own index. */
  retired?: { indexerUrl: string };
  /**
   * The index the release names for a current generation (D403): a lend asset's own `indexerUrl`, else the manifest's
   * `intentV1IndexerUrl`, which a generation found on chain shares too. Absent where it names neither: the network's
   * index (`indexerUrl` of the options) then serves it.
   */
  indexerUrl?: string;
}

/**
 * The position formats the LP lane takes: `UniV3PositionAdapter` (Uniswap v3, and forks that keep its position manager,
 * SushiSwap v3 among them), `RamsesV3PositionAdapter`, `UniV4PositionAdapter` (Uniswap v4) and `FablesPositionAdapter`
 * (Fables receipts wrapped as NFTs by `FablesPositionWrapper`, in Fables' hooked Uniswap v4 pools).
 */
export type LpAdapterKind = "uniswap-v3" | "ramses-v3" | "uniswap-v4" | "fables";
/** The formats whose pools are Uniswap v4 pools, named by their ids, and whose position manager cannot list a holder's positions. */
export const LP_V4_KINDS: readonly LpAdapterKind[] = ["uniswap-v4", "fables"];
/** An LP vault: USDG deposits that fund the lane's loans, by the name the release gives it. */
export interface LpVault { address: Address; name: string }
/**
 * A position format: its adapter, the ERC-721 position manager it reads and operates, and that manager's pool factory
 * (the v3 kinds) or its PoolManager (the v4 kinds); the other is null. A Fables adapter names the Fables hook its
 * wrapped receipts are of (`hook`, null for every other kind).
 */
export interface LpAdapter {
  kind: LpAdapterKind; address: Address; positionManager: Address; factory: Address | null; poolManager: Address | null; hook: Address | null;
}
/**
 * How a vault sells one token a defaulted position delivered: one v3-style pool holding USDG, two in a row, or one
 * hookless Uniswap v4 pool (D318: `pools[0]` its id's low 160 bits, `poolId` its id; null for the other kinds).
 */
export interface LpExecutor { address: Address; token: Address; kind: "one-pool" | "two-hop" | "v4-one-pool"; pools: Address[]; poolId: Hex | null }
/**
 * A pool the lane lends against under one adapter, as the app lists positions in it. A Uniswap v4 pool has no address:
 * `pool` is its id's low 160 bits (the key the core and the registry use), `poolId` its id, where its price is read,
 * `native` whether its ETH is native (booked as WETH, its `token0`) and `hooks` its hooks; a v3 pool's are null, false
 * and null.
 */
export interface LpPool {
  adapter: Address; pool: Address; token0: Address; token1: Address; fee: number; tickSpacing: number; name: string; poolId: Hex | null; native: boolean; hooks: Address | null;
}
/**
 * The LP lane (docs/api.md "LP lane", D314, D315): fixed-cost USDG loans against Uniswap v3, SushiSwap v3, Ramses V3 and
 * Uniswap v4 positions, through its own core, registry, vaults, position adapters and sale executors, never an Intent
 * generation.
 */
export interface LpLane {
  startBlock: number; core: Address; registry: Address;
  /** The LPVaultFactory whose vaults curators open (D318), or null where the release names none. */
  vaultFactory: Address | null;
  vaults: LpVault[]; adapters: LpAdapter[]; executors: LpExecutor[]; pools: LpPool[];
}

/**
 * How a pool's positions are held, as park and unpark (D334) pull them out and mint them: a Uniswap v3 position manager
 * or a fork that keeps it (SushiSwap v3's: pools by fee tier), Ramses V3's (pools by tick spacing), a Uniswap v4
 * PositionManager (its pools hooked or not), or a Fables hook's receipts.
 */
export type ParkKind = LpAdapterKind;
/**
 * A pool an out-of-range position can be parked from and a new one unparked into (D334), read straight from its DEX,
 * never through gage's LP lane. `manager` holds its positions: the v3-style or v4 position manager, or the Fables hook
 * whose receipts are its liquidity. `id` is a v3-style pool's address, or a v4 pool's id; `key` a v4 pool's key (its
 * hooks included, its native ETH the zero address), null for a v3-style pool. `token0` and `token1` are the pool's own
 * currencies. `stateView` is where a v4 pool's price is read; `indexedBy` the LP lane adapter gage's index names its
 * positions by (`GET /lp/positions`), as a v4 PositionManager and a Fables hook cannot list a holder's.
 */
export interface ParkPool {
  kind: ParkKind; name: string; manager: Address; id: Hex; key: PoolKey | null; token0: Address; token1: Address; fee: number; tickSpacing: number;
  stateView: Address | null; indexedBy: Address | null;
}

/**
 * The LP lane's pools as park pools (D334), whatever the lane's switch: a position in one is pulled out and minted on its
 * own DEX, so parking needs nothing of the lane but the pool's address. A native v4 pool's ETH, which the lane books as
 * WETH, is its key's zero address here, as the wallet receives and pays it.
 */
export function parkPoolsOf(lane: LpLane, stateView: Address | null): ParkPool[] {
  return lane.pools.map((p): ParkPool => {
    const a = lane.adapters.find((x) => x.address === p.adapter)!;
    if (!LP_V4_KINDS.includes(a.kind)) {
      return { kind: a.kind, name: p.name, manager: a.positionManager, id: p.pool, key: null, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, stateView: null, indexedBy: null };
    }
    const key: PoolKey = { currency0: p.native ? zeroAddress : p.token0, currency1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks ?? zeroAddress };
    return {
      kind: a.kind, name: p.name, manager: a.kind === "fables" ? a.hook! : a.positionManager, id: p.poolId!, key, token0: key.currency0, token1: p.token1,
      fee: p.fee, tickSpacing: p.tickSpacing, stateView, indexedBy: a.address,
    };
  });
}

/** What the SDK acts on, read from the live manifest (`launch/live/<chainId>.json`), never from a request. */
export interface Deployment {
  chainId: ChainId;
  usdg: Address;
  /** The Intent core: the engine new loans are listed on, funded only by partner vaults. */
  core: Engine;
  /** Every engine of the manifest, oldest first: a wallet's closed loans and credits can sit on any of them. */
  engines: Engine[];
  factory: Address;
  loopRouter: Address | null;
  assets: Asset[];
  /** Each token's hookless USDG v4 pool, the first v4 pool of its `loopPools` (lowercase token). */
  pools: Map<string, PoolKey>;
  /** Every pool leverage may buy each token through, in the manifest's order (lowercase token; `parseLoopPools`). */
  loopPools: Map<string, LoopPool[]>;
  /** The StateView of the PoolManager those pools live in, where leverage prices its purchase; null without one. */
  stateView: Address | null;
  /**
   * The generations an agent may use (D251): USDG's first, then each lend-asset generation the release makes public, in
   * its order (`intentV1Assets`, shown only while its own `public` and `intentV1`'s switch are both on). USDG's alone for
   * a release that names no lend asset. A lend-asset core is never one of `engines`, whose amounts are USDG.
   */
  generations: Generation[];
  /**
   * The earlier generations the release keeps for their positions (`intentV1Previous`, `intentV1AssetsPrevious`), each
   * served by its own retained index (docs/api.md "Historical service retention"): holdings, redemptions, claims and
   * their loans only, never a deposit, a borrow or a new vault.
   */
  retired: Generation[];
  /** gage's keeper, the only account a standing roll instruction lets roll (`rolloverExecutor`, D285); null where none is named. */
  rolloverExecutor: Address | null;
  /**
   * The private lane's routers by the core they list on, its address in lower case (D201, D248; docs/api.md "Private
   * lane"): the current core's (`intentV1.privateRouter`, then the `retiredPrivateRouters` it replaced) and each earlier
   * core's (`intentV1.previousPrivateLanes`). A loan one of them opened stays private for good, so every loan gage-sdk
   * serves on such a core is asked of them on chain (the audit of 18 October 2026, M7). A core none lists on has no
   * private loans; a release without the lane names none, and a lend-asset generation never has one.
   */
  privateRouters: ReadonlyMap<string, readonly Address[]>;
  /**
   * Each admitted token's link on gage.cash's Borrow (`/borrow/<link>`, D290), by its address in lower case, as the app
   * gives them (`tokenLinks`): by ticker, in the release's order (`assets`, then each public lend asset's own list), the
   * tokens the release lists as no longer admitted (`allowed: false`) claiming theirs without being served one.
   */
  tokenLinks: ReadonlyMap<string, string>;
  /**
   * The LP lane (D314, D315) while the release makes it public (`lpLane.public`), as the app serves it; null otherwise,
   * and then no LP read or action is served. The block is checked whole whenever it is there, hidden or not, by the
   * rules of shared/lp-lane.mjs.
   */
  lpLane: LpLane | null;
  /** The pools park and unpark serve (D334): the LP lane's, whether or not its switch is on; none without a lane. */
  parkPools: ParkPool[];
  /** The release's WETH (`WETH`), whose side of a pool is ETH's: no gage vault takes it yet (D334). Null where it names none. */
  weth: Address | null;
}

const addr = (value: unknown, what: string): Address => {
  if (typeof value !== "string" || !isAddress(value) || BigInt(value) === 0n) throw new Error(`Manifest ${what} is not an address`);
  return getAddress(value);
};
const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Manifest ${what} is missing`);
  return value as Record<string, unknown>;
};
const nonzero = (value: unknown): value is Address => typeof value === "string" && isAddress(value) && BigInt(value) !== 0n;
/** An optional address of the manifest: absent or zero is none, anything else must be an address. */
const optional = (value: unknown, what: string): Address | null => (value === undefined || value === null || (typeof value === "string" && /^0x0{40}$/i.test(value)) ? null : addr(value, what));
const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
/** Every pool row of the manifest's own lists, in its order: `pools`, `nativeV2.routingPools`, `nativeV2.cashoutPools`. */
const manifestPools = (m: Record<string, unknown>): unknown[] => {
  const v2 = record(m.nativeV2, "nativeV2");
  return [...Object.values(record(m.pools ?? {}, "pools")), ...list(v2.routingPools), ...list(v2.cashoutPools)];
};

/**
 * The pools leverage may buy each listed token through (D242), from every pool list of the manifest: `pools`,
 * `nativeV2.routingPools` and `nativeV2.cashoutPools`. Every row pairing USDG with a token of `nativeV2.assets` is kept
 * once (a v4 pool by its id, a V3 pool by its address), in the manifest's order. A row marked `protocol: "v3"` is a
 * Uniswap V3 pool named by `poolAddress` (its `poolId` is that address, padded): it carries a v4 key's fields too, and is
 * never read as one. Any other row is a v4 PoolKey, kept only without hooks and only when the `poolId` it states, if
 * any, is its key's hash. An ETH pool (a zero currency) is never a leverage pool.
 */
export function parseLoopPools(raw: unknown): Map<string, LoopPool[]> {
  const m = record(raw, "root");
  const usdg = addr(m.USDG, "USDG");
  const v2 = record(m.nativeV2, "nativeV2");
  const listed = new Set((Array.isArray(v2.assets) ? v2.assets : []).map((a: unknown, i: number) => addr(record(a, `asset ${i}`).token, "asset token")));
  return loopPoolsOf(manifestPools(m), usdg, listed);
}

/**
 * The rows of `rows` a loop may buy through with `cash`, by token: each pairing `cash` with one of `listed`, kept once
 * (a v4 pool by its id, a V3 pool by its address), in their order, by `parseLoopPools`' rules. `cash` is USDG for the
 * USDG generation, a lend asset for its own (a put buys USDG with it).
 */
function loopPoolsOf(rows: readonly unknown[], cash: Address, listed: ReadonlySet<Address>): Map<string, LoopPool[]> {
  const found = new Map<string, LoopPool[]>();
  const seen = new Set<string>();
  const keep = (token: Address, id: string, pool: LoopPool) => {
    if (seen.has(id)) return;
    seen.add(id);
    const t = token.toLowerCase();
    found.set(t, [...(found.get(t) ?? []), pool]);
  };
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const k = row as Record<string, unknown>;
    if (!nonzero(k.currency0) || !nonzero(k.currency1)) continue;
    const c0 = getAddress(k.currency0), c1 = getAddress(k.currency1);
    const token = c0 === cash ? c1 : c1 === cash ? c0 : null;
    if (!token || !listed.has(token)) continue;
    if (k.protocol === "v3") {
      if (!nonzero(k.poolAddress) || !whole(k.fee) || k.fee <= 0 || k.fee >= 1_000_000) continue;
      const pool = getAddress(k.poolAddress);
      keep(token, pool.toLowerCase(), { kind: "v3", pool, fee: k.fee });
    } else if (k.protocol === undefined || k.protocol === "v4") {
      if (!(typeof k.hooks === "string" && isAddress(k.hooks) && BigInt(k.hooks) === 0n) || !whole(k.fee) || !whole(k.tickSpacing)) continue;
      const key: PoolKey = { currency0: c0, currency1: c1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: zeroAddress };
      const id = poolId(key);
      if (k.poolId !== undefined && (typeof k.poolId !== "string" || k.poolId.toLowerCase() !== id)) continue;
      keep(token, id, { kind: "v4", key });
    }
  }
  return found;
}

/**
 * The release's public lend-asset generations (`intentV1Assets`, D251), in its order, after `usdg`'s. Only the fields
 * the SDK reads are checked here; the release tooling checks the rest (shared/intent-generations.mjs). An entry is kept
 * while its `public` is true and `intentV1`'s switch is on (absent counts as on, on the testnet). Each is read from its
 * own `indexerUrl`, else from `current`, the manifest's `intentV1IndexerUrl` (D403).
 */
function parseGenerations(m: Record<string, unknown>, usdg: Generation, engines: readonly Engine[], current: string | undefined): Generation[] {
  if (m.intentV1Assets === undefined) return [usdg];
  const entries = record(m.intentV1Assets, "intentV1Assets");
  const on = record(m.intentV1, "intentV1").public !== false;
  const out: Generation[] = [usdg];
  for (const [key, value] of Object.entries(entries)) {
    const at = `intentV1Assets.${key}`;
    const x = record(value, at);
    if (typeof x.public !== "boolean") throw new Error(`Manifest ${at}.public is not a boolean`);
    if (!x.public || !on) continue;
    const indexerUrl = x.indexerUrl === undefined ? current : origin(x.indexerUrl, `${at}.indexerUrl`);
    out.push({ ...assetGeneration(key, x, at, m), ...(indexerUrl ? { indexerUrl } : {}) });
  }
  // A lend-asset core is never one of the USDG engines nor another generation's, and its asset is never USDG.
  const cores = out.map((g) => g.core.engine);
  if (new Set(cores).size !== cores.length || out.slice(1).some((g) => engines.some((e) => e.engine === g.core.engine) || g.lendAsset.token === usdg.lendAsset.token)) {
    throw new Error("Manifest intentV1Assets names a core or an asset twice");
  }
  return out;
}

/**
 * One lend-asset generation's entry (`intentV1Assets.<SYM>`, or a retained one's), with its loop and put routers and the
 * pools a loop or a put router on its core buys through (`loopPools`, from its `cashoutPools` and the manifest `m`'s lists).
 */
function assetGeneration(key: string, x: Record<string, unknown>, at: string, m: Record<string, unknown>): Generation {
  const la = record(x.lendAsset, `${at}.lendAsset`);
  if (la.symbol !== key) throw new Error(`Manifest ${at} lends another symbol`);
  if (!whole(la.decimals) || la.decimals < 6 || la.decimals > 18) throw new Error(`Manifest ${at} has 6 to 18 decimals`);
  if (typeof la.stable !== "boolean") throw new Error(`Manifest ${at}.lendAsset.stable is not a boolean`);
  const e = record(x.engine, `${at}.engine`);
  const core: Engine = {
    engine: addr(x.core, `${at}.core`), registry: addr(e.registry, `${at}.engine.registry`), rewards: addr(e.rewards, `${at}.engine.rewards`), name: `${key} lending`,
    cashoutRouter: optional(e.cashoutRouter, `${at}.engine.cashoutRouter`),
    ...(e.bridged === false && e.rewardTerms === "registry" ? { registryRewards: true } : {}),
  };
  const collateral = (Array.isArray(x.collateral) ? x.collateral : []).map((c: unknown, i: number) => {
    const r = record(c, `${at}.collateral ${i}`);
    return { token: addr(r.token, `${at}.collateral token`), symbol: String(r.symbol), category: String(r.category) };
  });
  const lendAsset: LendAsset = { token: addr(la.token, `${at}.lendAsset.token`), symbol: key, decimals: la.decimals, stable: la.stable };
  // What a loop on its core buys its collateral through, paid in its asset: its own exits first (D249), then the
  // manifest's lists where they pair the two.
  const loopPools = loopPoolsOf([...list(x.cashoutPools), ...manifestPools(m)], lendAsset.token, new Set(collateral.map((t) => t.token)));
  return {
    id: key, primary: false, lendAsset, core, factory: addr(x.factory, `${at}.factory`), collateral, rolloverRouter: optional(x.rolloverRouter, `${at}.rolloverRouter`),
    loopRouter: optional(x.loopRouter, `${at}.loopRouter`), putRouter: optional(x.putRouter, `${at}.putRouter`), loopPools,
    exitDesk: optional(x.exitDesk, `${at}.exitDesk`),
  };
}

/** A generation's index, current or retained: an HTTPS origin, without credentials, path, query or fragment (shared reader's rule). */
const origin = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value)) throw new Error(`Manifest ${what} is not an HTTPS origin`);
  return value;
};

/**
 * The generations the release keeps for their positions: USDG's (`intentV1Previous`, whose cores stay among `engines`)
 * and each lend asset's (`intentV1AssetsPrevious`), each with its retained index.
 */
function parseRetired(m: Record<string, unknown>, usdg: LendAsset, engines: readonly Engine[], loopPools: ReadonlyMap<string, LoopPool[]>): Generation[] {
  const out: Generation[] = [];
  const previous = m.intentV1Previous === undefined ? [] : m.intentV1Previous;
  if (!Array.isArray(previous)) throw new Error("Manifest intentV1Previous is not a list");
  for (const [i, value] of previous.entries()) {
    const at = `intentV1Previous ${i}`;
    const x = record(value, at), block = record(x.intentV1, `${at}.intentV1`);
    const engine = addr(block.core, `${at}.intentV1.core`);
    const core = engines.find((e) => e.engine === engine);
    if (!core) throw new Error(`Manifest ${at} lends on an engine nativeV2.engines does not list`);
    out.push({
      id: "USDG", primary: true, lendAsset: usdg, core, factory: addr(block.factory, `${at}.intentV1.factory`), collateral: [], rolloverRouter: null,
      // USDG's lends USDG: no put router (D313); no loop opens on a retained core, so it names no loop router either.
      loopRouter: null, putRouter: null, loopPools, exitDesk: optional(block.exitDesk, `${at}.intentV1.exitDesk`),
      retired: { indexerUrl: origin(x.intentV1IndexerUrl, `${at}.intentV1IndexerUrl`) },
    });
  }
  const assets = m.intentV1AssetsPrevious === undefined ? {} : record(m.intentV1AssetsPrevious, "intentV1AssetsPrevious");
  for (const [key, rows] of Object.entries(assets)) {
    if (!Array.isArray(rows)) throw new Error(`Manifest intentV1AssetsPrevious.${key} is not a list`);
    for (const [i, row] of rows.entries()) {
      const at = `intentV1AssetsPrevious.${key} ${i}`;
      const r = record(row, at);
      out.push({ ...assetGeneration(key, record(r.entry, `${at}.entry`), `${at}.entry`, m), retired: { indexerUrl: origin(r.indexerUrl, `${at}.indexerUrl`) } });
    }
  }
  return out;
}

/**
 * The private lane's routers by core, as gage's index reads them (services/indexer `privateLanes`): the current core's
 * while the release names any router of it, then each earlier core's lane, its routers merged where a core comes twice.
 * A router or a lane it cannot read is refused, never guessed: a router left out would let its loans through.
 */
function parsePrivateRouters(intent: Record<string, unknown>, core: Address): Map<string, Address[]> {
  const list = (value: unknown, what: string): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`Manifest ${what} is not a list`);
    return value as unknown[];
  };
  const routers = (value: unknown, what: string) => list(value, what).map((r, i) => addr(r, `${what} ${i}`));
  const lanes = [
    { core, routers: [...(intent.privateRouter === undefined ? [] : [addr(intent.privateRouter, "intentV1.privateRouter")]), ...routers(intent.retiredPrivateRouters, "intentV1.retiredPrivateRouters")] },
    ...list(intent.previousPrivateLanes, "intentV1.previousPrivateLanes").map((value, i) => {
      const at = `intentV1.previousPrivateLanes ${i}`;
      const lane = record(value, at);
      const named = routers(lane.routers, `${at} routers`);
      if (!named.length) throw new Error(`Manifest ${at} names no router`);
      return { core: addr(lane.core, `${at} core`), routers: named };
    }),
  ];
  const out = new Map<string, Address[]>();
  for (const lane of lanes.filter((l) => l.routers.length)) {
    const key = lane.core.toLowerCase();
    out.set(key, [...new Set([...(out.get(key) ?? []), ...lane.routers])]);
  }
  return out;
}

const LP_ADAPTER_KINDS: readonly string[] = ["uniswap-v3", "ramses-v3", "uniswap-v4", "fables"];
const LP_EXECUTOR_KINDS: readonly string[] = ["one-pool", "two-hop", "v4-one-pool"];
const LP_KEYS = {
  lane: ["public", "startBlock", "core", "registry", "vaultFactory", "vaults", "adapters", "executors", "pools"],
  vault: ["address", "name"],
  adapter: ["kind", "address", "positionManager", "factory", "poolManager", "hook"],
  executor: ["address", "token", "kind", "pools", "poolId"],
  pool: ["adapter", "pool", "token0", "token1", "fee", "tickSpacing", "name", "poolId", "native", "hooks"],
  v4Pool: ["poolId", "native", "hooks"],
} as const;

/**
 * The manifest's LP lane (`lpLane`, docs/api.md "LP lane"), checked by the rules of shared/lp-lane.mjs, the reader every
 * service and the app share: an unknown key, a pool's tokens out of order, a token sold through two executors, an
 * address the lane owns twice and a pool named twice under one adapter are refused, as is anything it cannot read. A
 * Uniswap v4 or Fables adapter names its PoolManager instead of a factory (a Fables one its hook too), and its pools
 * their id (the pool's `pool` must be its low 160 bits), whether their ETH is native and their hooks (a Fables pool's
 * its adapter's hook). A v4-one-pool sale executor names its pool's id, its one pool the id's low 160 bits, and the
 * lane may name its vault factory (D318). The whole block is checked whenever it is there; it is served only while `public` is true, as
 * the app serves it, so a hidden lane reads as none. Addresses are checksummed.
 */
export function parseLpLane(m: Record<string, unknown>): LpLane | null {
  const block = lpLaneBlock(m);
  return block?.public ? block.lane : null;
}

/** The manifest's LP lane checked whole (`parseLpLane`), with its switch: what park reads of a hidden one too (D334). */
export function lpLaneBlock(m: Record<string, unknown>): { lane: LpLane; public: boolean } | null {
  if (m.lpLane === undefined) return null;
  const invalid = (what: string): never => { throw new Error(`Invalid LP lane in the deployment manifest: ${what}`); };
  const rec = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const only = (value: Record<string, unknown>, keys: readonly string[], at: string) => {
    const extra = Object.keys(value).find((k) => !keys.includes(k));
    if (extra !== undefined) invalid(`${at} has an unknown key ${JSON.stringify(extra)}`);
  };
  const address = (value: unknown, at: string): Address =>
    (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && BigInt(value) !== 0n ? getAddress(value) : invalid(`${at} is not a nonzero address`));
  const listOf = (value: unknown, at: string): unknown[] => (Array.isArray(value) ? value as unknown[] : invalid(`${at} is not a list`));
  const raw = m.lpLane;
  if (!rec(raw)) return invalid("lpLane is not an object");
  only(raw, LP_KEYS.lane, "lpLane");
  if (typeof raw.public !== "boolean") invalid("lpLane.public is not a boolean");
  if (!Number.isSafeInteger(raw.startBlock) || (raw.startBlock as number) < 1) invalid("lpLane.startBlock is not a block number");
  // The release names no vault of its own (D319): the factory's are read on chain, so `vaults` may be empty or absent.
  const vaults = (raw.vaults === undefined ? [] : listOf(raw.vaults, "lpLane.vaults")).map((v, i): LpVault => {
    const at = `lpLane.vaults[${i}]`;
    if (!rec(v)) return invalid(`${at} is not a vault`);
    only(v, LP_KEYS.vault, at);
    if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 64) invalid(`${at}.name is not a name`);
    return { address: address(v.address, `${at}.address`), name: v.name as string };
  });
  const adapters = listOf(raw.adapters, "lpLane.adapters").map((a, i): LpAdapter => {
    const at = `lpLane.adapters[${i}]`;
    if (!rec(a)) return invalid(`${at} is not an adapter`);
    only(a, LP_KEYS.adapter, at);
    if (typeof a.kind !== "string" || !LP_ADAPTER_KINDS.includes(a.kind)) invalid(`${at}.kind is not one of ${LP_ADAPTER_KINDS.join(", ")}`);
    const kind = a.kind as LpAdapterKind, v4 = LP_V4_KINDS.includes(kind), fables = kind === "fables";
    if (v4 && a.factory !== undefined) invalid(`${at} is a ${kind} adapter naming a factory`);
    if (!v4 && a.poolManager !== undefined) invalid(`${at} is a ${kind} adapter naming a PoolManager`);
    if (!fables && a.hook !== undefined) invalid(`${at} is a ${kind} adapter naming a hook`);
    return {
      kind, address: address(a.address, `${at}.address`), positionManager: address(a.positionManager, `${at}.positionManager`),
      factory: v4 ? null : address(a.factory, `${at}.factory`), poolManager: v4 ? address(a.poolManager, `${at}.poolManager`) : null,
      hook: fables ? address(a.hook, `${at}.hook`) : null,
    };
  });
  if (!adapters.length) invalid("lpLane.adapters is empty");
  const executors = listOf(raw.executors, "lpLane.executors").map((e, i): LpExecutor => {
    const at = `lpLane.executors[${i}]`;
    if (!rec(e)) return invalid(`${at} is not an executor`);
    only(e, LP_KEYS.executor, at);
    if (typeof e.kind !== "string" || !LP_EXECUTOR_KINDS.includes(e.kind)) invalid(`${at}.kind is not one of ${LP_EXECUTOR_KINDS.join(", ")}`);
    const pools = listOf(e.pools, `${at}.pools`).map((p, j) => address(p, `${at}.pools[${j}]`));
    if (pools.length !== (e.kind === "two-hop" ? 2 : 1)) invalid(`${at} is a ${String(e.kind)} executor naming ${pools.length} pool(s)`);
    let poolId: Hex | null = null;
    if (e.kind === "v4-one-pool") {
      if (typeof e.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(e.poolId)) invalid(`${at}.poolId is not a pool id`);
      poolId = (e.poolId as string).toLowerCase() as Hex;
      if (pools[0]!.toLowerCase() !== `0x${poolId.slice(-40)}`) invalid(`${at}.pools[0] is not its pool id's low 160 bits`);
    } else if (e.poolId !== undefined) {
      invalid(`${at} is a ${String(e.kind)} executor naming a pool id`);
    }
    return { address: address(e.address, `${at}.address`), token: address(e.token, `${at}.token`), kind: e.kind as LpExecutor["kind"], pools, poolId };
  });
  const tokens = executors.map((e) => e.token);
  if (new Set(tokens).size !== tokens.length) invalid("lpLane.executors names a token twice: each recovered token sells through one executor");
  const pools = listOf(raw.pools, "lpLane.pools").map((p, i): LpPool => {
    const at = `lpLane.pools[${i}]`;
    if (!rec(p)) return invalid(`${at} is not a pool`);
    only(p, LP_KEYS.pool, at);
    const adapter = address(p.adapter, `${at}.adapter`);
    const of = adapters.find((a) => a.address === adapter);
    if (!of) return invalid(`${at}.adapter is not one of lpLane.adapters`);
    const token0 = address(p.token0, `${at}.token0`), token1 = address(p.token1, `${at}.token1`);
    // In the pool's own currency order: a native v4 pool's currency 0 is ETH (the zero address, first whatever it pairs
    // with), booked as WETH (token0), whose address may sort above its pair's (the testnet's WETH does above USDG).
    const nativeEth = LP_V4_KINDS.includes(of.kind) && p.native === true;
    if (token0 === token1 || BigInt(nativeEth ? 0 : token0) >= BigInt(token1)) invalid(`${at} names its tokens out of order`);
    if (!Number.isSafeInteger(p.fee) || (p.fee as number) < 0 || (p.fee as number) > 0xffffff) invalid(`${at}.fee is not a uint24`);
    if (!Number.isSafeInteger(p.tickSpacing) || (p.tickSpacing as number) < 1 || (p.tickSpacing as number) > 32_767) invalid(`${at}.tickSpacing is not a positive int24`);
    if (typeof p.name !== "string" || !p.name.trim()) invalid(`${at}.name is empty`);
    const shape = { adapter, pool: address(p.pool, `${at}.pool`), token0, token1, fee: p.fee as number, tickSpacing: p.tickSpacing as number, name: p.name as string };
    if (!LP_V4_KINDS.includes(of.kind)) {
      if (LP_KEYS.v4Pool.some((k) => p[k] !== undefined)) invalid(`${at} is a v3 pool naming a v4 key`);
      return { ...shape, poolId: null, native: false, hooks: null };
    }
    // A v4 pool has no address: the lane names it by its id's low 160 bits; a native pool's ETH is booked as WETH (token0).
    if (typeof p.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.poolId)) invalid(`${at}.poolId is not a pool id`);
    const poolId = (p.poolId as string).toLowerCase() as Hex;
    if (shape.pool.toLowerCase() !== `0x${poolId.slice(-40)}`) invalid(`${at}.pool is not its id's low 160 bits`);
    if (typeof p.native !== "boolean") invalid(`${at}.native is not a boolean`);
    if (typeof p.hooks !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.hooks)) invalid(`${at}.hooks is not an address`);
    const hooks = getAddress(p.hooks as string);
    if (of.kind === "fables" && hooks !== of.hook) invalid(`${at} is not its Fables adapter's hook's`);
    return { ...shape, poolId, native: p.native as boolean, hooks };
  });
  const vaultFactory = raw.vaultFactory === undefined ? null : address(raw.vaultFactory, "lpLane.vaultFactory");
  // A lane funds loans through vaults: its own (none since D319) or those curators open through its factory.
  if (!vaults.length && !vaultFactory) invalid("lpLane names no vault and no vault factory");
  const lane: LpLane = {
    startBlock: raw.startBlock as number, core: address(raw.core, "lpLane.core"), registry: address(raw.registry, "lpLane.registry"), vaultFactory, vaults, adapters, executors, pools,
  };
  // Every contract the lane deploys is its own, named once.
  const owned: [string, Address][] = [["core", lane.core], ["registry", lane.registry], ...(vaultFactory ? [["vaultFactory", vaultFactory] as [string, Address]] : []),
    ...vaults.map((v, i): [string, Address] => [`vaults[${i}]`, v.address]),
    ...adapters.map((a, i): [string, Address] => [`adapters[${i}]`, a.address]), ...executors.map((e, i): [string, Address] => [`executors[${i}]`, e.address])];
  const seen = new Map<Address, string>();
  for (const [name, value] of owned) {
    if (seen.has(value)) invalid(`lpLane.${name} is also its ${seen.get(value)!}`);
    seen.set(value, name);
  }
  const keys = pools.map((p) => `${p.adapter}:${p.pool}`);
  if (new Set(keys).size !== keys.length) invalid("lpLane.pools names a pool twice under one adapter");
  return { lane, public: raw.public as boolean };
}

export function parseDeployment(raw: unknown): Deployment {
  const m = record(raw, "root");
  if (m.chainId !== TESTNET && m.chainId !== MAINNET) throw new Error("gage for agents serves Robinhood Chain (4663) and its testnet (46630) only");
  const chainId: ChainId = m.chainId;
  const v2 = record(m.nativeV2, "nativeV2");
  const intent = record(m.intentV1, "intentV1");
  // Mainnet's partner vaults lend only once the release makes the Intent core public (D257), as the app shows them.
  if (chainId === MAINNET && intent.public !== true) throw new Error("The Intent core is not public on mainnet yet");
  const usdg = addr(m.USDG, "USDG");
  if (!Array.isArray(v2.engines) || v2.engines.length === 0) throw new Error("Manifest nativeV2.engines is empty");
  const engines = v2.engines.map((e: unknown, i: number) => {
    const x = record(e, `engine ${i}`);
    return {
      engine: addr(x.engine, "engine"), registry: addr(x.registry, "registry"), rewards: addr(x.rewards, "rewards"), name: typeof x.name === "string" ? x.name : `Engine ${i}`,
      cashoutRouter: optional(x.cashoutRouter, `engine ${i} cashoutRouter`),
    };
  });
  const coreAddress = addr(intent.core, "intentV1.core");
  const core = engines.at(-1)!;
  // New loans go to the newest engine, and it must be the Intent core the vaults fund (web/src/v2/config.ts).
  if (core.engine !== coreAddress) throw new Error("The newest engine is not the Intent core");
  const listed = (Array.isArray(v2.assets) ? v2.assets : []).map((a: unknown, i: number) => {
    const x = record(a, `asset ${i}`);
    return { token: addr(x.token, "asset token"), symbol: String(x.symbol), name: String(x.name ?? x.symbol), decimals: Number(x.decimals), lane: String(x.lane), allowed: x.allowed !== false };
  });
  const assets: Asset[] = listed.map(({ allowed: _, ...a }) => a);
  const loopPools = parseLoopPools(m);
  const pools = new Map<string, PoolKey>();
  for (const [token, candidates] of loopPools) {
    const v4 = candidates.find((p) => p.kind === "v4");
    if (v4) pools.set(token, v4.key);
  }
  const factory = addr(intent.factory, "intentV1.factory");
  const loopRouter = intent.loopRouter ? addr(intent.loopRouter, "intentV1.loopRouter") : null;
  // The index the release names for its current generations (D403), USDG's and each lend asset's that names none.
  const current = m.intentV1IndexerUrl === undefined ? undefined : origin(m.intentV1IndexerUrl, "intentV1IndexerUrl");
  const primary: Generation = {
    id: "USDG", primary: true, lendAsset: { token: usdg, symbol: "USDG", decimals: 6, stable: true }, core, factory, collateral: [],
    rolloverRouter: optional(intent.rolloverRouter, "intentV1.rolloverRouter"),
    // USDG's own generation lends USDG: a put there would borrow USDG against USDG, so it names no put router (D313).
    loopRouter, putRouter: null, loopPools, exitDesk: optional(intent.exitDesk, "intentV1.exitDesk"),
    ...(current ? { indexerUrl: current } : {}),
  };
  const generations = parseGenerations(m, primary, engines, current);
  // A rollover, loop or put router serves the one core its fill router names: never two generations, nor two roles.
  const routers = generations.flatMap((g) => [g.rolloverRouter, g.loopRouter, g.putRouter]).filter((r): r is Address => r !== null);
  if (new Set(routers).size !== routers.length) throw new Error("Manifest names a router twice");
  const retired = parseRetired(m, primary.lendAsset, engines, loopPools);
  const stateView = m.StateView === undefined ? null : addr(m.StateView, "StateView");
  const lane = lpLaneBlock(m);
  return {
    chainId, usdg, core, engines, factory,
    loopRouter, assets, pools, loopPools,
    stateView,
    generations, retired,
    rolloverExecutor: optional(m.rolloverExecutor, "rolloverExecutor"),
    tokenLinks: tokenLinks([...listed, ...generations.flatMap((g) => g.collateral.map((x) => ({ token: x.token, symbol: x.symbol, allowed: true })))]),
    privateRouters: parsePrivateRouters(intent, coreAddress),
    lpLane: lane?.public ? lane.lane : null,
    parkPools: lane ? parkPoolsOf(lane.lane, stateView) : [],
    weth: optional(m.WETH, "WETH"),
  };
}

export const assetOf = (d: Deployment, token: string) => d.assets.find((a) => a.token.toLowerCase() === token.toLowerCase()) ?? null;
/** A published engine by its address: one of `engines`, or a lend-asset generation's core (D251), current or retained. */
export const engineOf = (d: Deployment, engine: string) =>
  d.engines.find((e) => e.engine.toLowerCase() === engine.toLowerCase()) ?? [...d.generations, ...d.retired].find((g) => !g.primary && g.core.engine.toLowerCase() === engine.toLowerCase())?.core ?? null;
/** The generation whose core is `engine`, current then retained; null for an earlier USDG engine, whose loans are paid in USDG all the same. */
export const generationOfCore = (d: Deployment, engine: string) => [...d.generations, ...d.retired].find((g) => g.core.engine.toLowerCase() === engine.toLowerCase()) ?? null;
/**
 * Whether `engine` is the core of a generation the release keeps for its positions alone (`retired`): gage's keeper rolls
 * through current generations' routers only and the rates service quotes no roll of a retained one, so nothing rolls
 * its loans over, by hand or by itself. Its routers still end an instruction left on them and close a put.
 */
export const retiredCore = (d: Deployment, engine: string): boolean => Boolean(generationOfCore(d, engine)?.retired);
/** What an engine's loans are paid in: its generation's asset; USDG for every engine of `engines`. */
export const lendAssetOf = (d: Deployment, engine: string): LendAsset => generationOfCore(d, engine)?.lendAsset ?? d.generations[0]!.lendAsset;
/**
 * Whether the release makes a lend asset besides USDG public (D251): then every answer that serves amounts names their
 * asset (`asset`, USDG's on the USDG generation), as gage's services do; without one, every answer reads as before.
 */
export const lendsMore = (d: Deployment) => d.generations.length > 1;
/**
 * The router that rolls loans on `engine` over (D285): its generation's; null for an earlier engine or a generation without
 * one. A retained generation's (`retiredCore`) only ends the instructions left on it.
 */
export const rolloverRouterOf = (d: Deployment, engine: string): Address | null => generationOfCore(d, engine)?.rolloverRouter ?? null;
/**
 * The put router loans on `engine` close and roll through, paying in their collateral token: its generation's; null
 * without one. A retained generation's (`retiredCore`) closes and ends the instructions left on it, and rolls nothing.
 */
export const putRouterOf = (d: Deployment, engine: string): Address | null => generationOfCore(d, engine)?.putRouter ?? null;
/**
 * The generations a put opens on (docs/api.md "Puts on lend-asset generations"): a lend asset's that lends against
 * USDG and names its loop router, through which a put opens, and its put router, through which it closes and rolls.
 */
export const putGenerations = (d: Pick<Deployment, "usdg" | "generations">): Generation[] =>
  d.generations.filter((g) => !g.primary && g.loopRouter !== null && g.putRouter !== null && g.collateral.some((x) => x.token.toLowerCase() === d.usdg.toLowerCase()));
/** The private-lane routers that list on `engine` (D201, M7): none for a core without the lane. */
export const privateRoutersOf = (d: Deployment, engine: string): readonly Address[] => d.privateRouters.get(engine.toLowerCase()) ?? [];
/** The LP lane's vault at `vault`, in any letter case; null when the lane names none (or there is no public lane). */
export const lpVaultOf = (lane: LpLane | null, vault: string): LpVault | null => lane?.vaults.find((v) => v.address.toLowerCase() === vault.toLowerCase()) ?? null;
/** The LP lane's adapter at `adapter`, in any letter case; null when the lane names none. */
export const lpAdapterOf = (lane: LpLane | null, adapter: string): LpAdapter | null => lane?.adapters.find((a) => a.address.toLowerCase() === adapter.toLowerCase()) ?? null;
/** The pool `pool` as the LP lane lends against it under `adapter`; null when it does not. */
export const lpPoolOf = (lane: LpLane | null, adapter: string, pool: string): LpPool | null =>
  lane?.pools.find((p) => p.adapter.toLowerCase() === adapter.toLowerCase() && p.pool.toLowerCase() === pool.toLowerCase()) ?? null;
