import { getAddress, isAddress, zeroAddress, type Address } from "viem";
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
/** A core: its registry and rewards, and the router a loan on it cashes out through (D245); null where none is named. */
export interface Engine { engine: Address; registry: Address; rewards: Address; name: string; cashoutRouter: Address | null }
export interface Asset { token: Address; symbol: string; name: string; decimals: number; lane: string }
/** What a generation lends (D251, Intent D55): USDG, or another asset at its own decimals (6 to 18). */
export interface LendAsset { token: Address; symbol: string; decimals: number; stable: boolean }
/**
 * One generation of partner vaults (D251): the asset it lends, its core (an engine whose `USDG()` is that asset) and its
 * factory. The USDG generation (`intentV1`) comes first and is the only `primary` one: leverage, 1-day loans, sGAGE
 * rewards and loan sales are its alone. A lend-asset generation (`intentV1Assets`) lends against the tokens of its own
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
  const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
  const rows = [...Object.values(record(m.pools ?? {}, "pools")), ...list(v2.routingPools), ...list(v2.cashoutPools)];
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
    const token = c0 === usdg ? c1 : c1 === usdg ? c0 : null;
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
 * while its `public` is true and `intentV1`'s switch is on (absent counts as on, on the testnet).
 */
function parseGenerations(m: Record<string, unknown>, usdg: Generation, engines: readonly Engine[]): Generation[] {
  if (m.intentV1Assets === undefined) return [usdg];
  const entries = record(m.intentV1Assets, "intentV1Assets");
  const on = record(m.intentV1, "intentV1").public !== false;
  const out: Generation[] = [usdg];
  for (const [key, value] of Object.entries(entries)) {
    const at = `intentV1Assets.${key}`;
    const x = record(value, at);
    if (typeof x.public !== "boolean") throw new Error(`Manifest ${at}.public is not a boolean`);
    if (!x.public || !on) continue;
    const la = record(x.lendAsset, `${at}.lendAsset`);
    if (la.symbol !== key) throw new Error(`Manifest ${at} lends another symbol`);
    if (!whole(la.decimals) || la.decimals < 6 || la.decimals > 18) throw new Error(`Manifest ${at} has 6 to 18 decimals`);
    if (typeof la.stable !== "boolean") throw new Error(`Manifest ${at}.lendAsset.stable is not a boolean`);
    const e = record(x.engine, `${at}.engine`);
    const core: Engine = {
      engine: addr(x.core, `${at}.core`), registry: addr(e.registry, `${at}.engine.registry`), rewards: addr(e.rewards, `${at}.engine.rewards`), name: `${key} lending`,
      cashoutRouter: optional(e.cashoutRouter, `${at}.engine.cashoutRouter`),
    };
    const collateral = (Array.isArray(x.collateral) ? x.collateral : []).map((c: unknown, i: number) => {
      const r = record(c, `${at}.collateral ${i}`);
      return { token: addr(r.token, `${at}.collateral token`), symbol: String(r.symbol), category: String(r.category) };
    });
    const lendAsset: LendAsset = { token: addr(la.token, `${at}.lendAsset.token`), symbol: key, decimals: la.decimals, stable: la.stable };
    out.push({ id: key, primary: false, lendAsset, core, factory: addr(x.factory, `${at}.factory`), collateral, rolloverRouter: optional(x.rolloverRouter, `${at}.rolloverRouter`) });
  }
  // A lend-asset core is never one of the USDG engines nor another generation's, and its asset is never USDG.
  const cores = out.map((g) => g.core.engine);
  if (new Set(cores).size !== cores.length || out.slice(1).some((g) => engines.some((e) => e.engine === g.core.engine) || g.lendAsset.token === usdg.lendAsset.token)) {
    throw new Error("Manifest intentV1Assets names a core or an asset twice");
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
  const primary: Generation = {
    id: "USDG", primary: true, lendAsset: { token: usdg, symbol: "USDG", decimals: 6, stable: true }, core, factory, collateral: [],
    rolloverRouter: optional(intent.rolloverRouter, "intentV1.rolloverRouter"),
  };
  const generations = parseGenerations(m, primary, engines);
  return {
    chainId, usdg, core, engines, factory,
    loopRouter: intent.loopRouter ? addr(intent.loopRouter, "intentV1.loopRouter") : null, assets, pools, loopPools,
    stateView: m.StateView === undefined ? null : addr(m.StateView, "StateView"),
    generations,
    rolloverExecutor: optional(m.rolloverExecutor, "rolloverExecutor"),
    tokenLinks: tokenLinks([...listed, ...generations.flatMap((g) => g.collateral.map((x) => ({ token: x.token, symbol: x.symbol, allowed: true })))]),
    privateRouters: parsePrivateRouters(intent, coreAddress),
  };
}

export const assetOf = (d: Deployment, token: string) => d.assets.find((a) => a.token.toLowerCase() === token.toLowerCase()) ?? null;
/** A published engine by its address: one of `engines`, or a public lend-asset generation's core (D251). */
export const engineOf = (d: Deployment, engine: string) =>
  d.engines.find((e) => e.engine.toLowerCase() === engine.toLowerCase()) ?? d.generations.find((g) => !g.primary && g.core.engine.toLowerCase() === engine.toLowerCase())?.core ?? null;
/** The generation whose core is `engine`; null for an earlier USDG engine, whose loans are paid in USDG all the same. */
export const generationOfCore = (d: Deployment, engine: string) => d.generations.find((g) => g.core.engine.toLowerCase() === engine.toLowerCase()) ?? null;
/** What an engine's loans are paid in: its generation's asset; USDG for every engine of `engines`. */
export const lendAssetOf = (d: Deployment, engine: string): LendAsset => generationOfCore(d, engine)?.lendAsset ?? d.generations[0]!.lendAsset;
/**
 * Whether the release makes a lend asset besides USDG public (D251): then every answer that serves amounts names their
 * asset (`asset`, USDG's on the USDG generation), as gage's services do; without one, every answer reads as before.
 */
export const lendsMore = (d: Deployment) => d.generations.length > 1;
/** The router that rolls loans on `engine` over (D285): its generation's; null for an earlier engine or a generation without one. */
export const rolloverRouterOf = (d: Deployment, engine: string): Address | null => generationOfCore(d, engine)?.rolloverRouter ?? null;
/** The private-lane routers that list on `engine` (D201, M7): none for a core without the lane. */
export const privateRoutersOf = (d: Deployment, engine: string): readonly Address[] => d.privateRouters.get(engine.toLowerCase()) ?? [];
