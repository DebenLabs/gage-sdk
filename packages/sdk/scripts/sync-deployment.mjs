#!/usr/bin/env node
// Writes src/deployments/testnet.ts from launch/live/46630.json and src/deployments/mainnet.ts from launch/live/4663.json:
// only the fields the SDK reads (D224), so the SDK works outside this repository: rollover's routers and keeper (D285),
// the private lane's routers (the audit of 18 October 2026, M7), each generation's loop and put routers, the exit desk
// it names (Intent D57) and the index the release names for it (`intentV1IndexerUrl`, a lend asset's `indexerUrl`,
// D403) among them.
// Run it after a contract generation changes either manifest; test/deployment.test.ts fails until it is run. A mainnet
// manifest is bundled only once its Intent core is public (D257, D260), as the SDK reads it. The LP lane (`lpLane`,
// D314, D315) is checked whole by the reader every service shares (shared/lp-lane.mjs) and bundled whatever its switch:
// a hidden lane leaves no lending surface in the SDK (src/deployment.ts reads it as none), but its pools are the pools
// park and unpark serve (D334), and the release's WETH says which side of them is ETH's.
// Imported, it writes nothing: test/deployment.test.ts holds `trim` to the SDK's own reader.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("../../../", import.meta.url);

/**
 * The readers every service shares (shared/intent-generations.mjs, shared/lp-lane.mjs), from gage's main repository,
 * which holds the release manifests too; null in gage-sdk's public mirror (D308), where the bundled deployments stay as
 * that repository wrote them.
 */
export async function sharedReaders() {
  if (!existsSync(new URL("launch/live/", root)) || !existsSync(new URL("shared/intent-generations.mjs", root)) || !existsSync(new URL("shared/lp-lane.mjs", root))) return null;
  const { intentGenerations } = await import(new URL("shared/intent-generations.mjs", root).href);
  const { lpLane } = await import(new URL("shared/lp-lane.mjs", root).href);
  return { intentGenerations, lpLane };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
// A pool row as leverage reads it (src/deployment.ts `parseLoopPools`): a v4 key with its id, or a V3 pool (`protocol`,
// `poolAddress`), from every pool list of the manifest.
const pool = (p) => pick(p, ["protocol", "poolAddress", "currency0", "currency1", "fee", "tickSpacing", "hooks", "poolId"]);

/** A live manifest as the SDK bundles it: the fields it reads, each block checked first by the shared `readers`. */
export function trim(live, { intentGenerations, lpLane }) {
  const lists = Object.fromEntries(["routingPools", "cashoutPools"].filter((k) => Array.isArray(live.nativeV2[k])).map((k) => [k, live.nativeV2[k].map(pool)]));
  // Each lend-asset generation (`intentV1Assets`, D251) as src/deployment.ts reads it: its asset, its switch, its core,
  // registry, rewards, factory and collateral, its routers (a loop router opens its puts, a put router closes and rolls
  // them) and its cash-out pools, where its loops buy. The whole block is checked first by the reader every service shares.
  if (live.intentV1Assets !== undefined) intentGenerations(live, { includeHidden: true });
  // A generation's entry, current or retained (`intentV1AssetsPrevious`): the reader requires `cashoutPools` on both.
  const assetEntry = (g) => ({
    lendAsset: pick(g.lendAsset, ["token", "symbol", "decimals", "stable"]),
    public: g.public,
    factory: g.factory,
    core: g.core,
    ...(g.rolloverRouter ? { rolloverRouter: g.rolloverRouter } : {}),
    ...(g.loopRouter ? { loopRouter: g.loopRouter } : {}),
    ...(g.putRouter ? { putRouter: g.putRouter } : {}),
    ...(g.exitDesk ? { exitDesk: g.exitDesk } : {}),
    // Its own index (D403); absent, a current entry is read at `intentV1IndexerUrl`.
    ...(g.indexerUrl ? { indexerUrl: g.indexerUrl } : {}),
    engine: pick(g.engine, ["registry", "rewards", "cashoutRouter"]),
    collateral: g.collateral.map((c) => pick(c, ["symbol", "token", "category"])),
    cashoutPools: g.cashoutPools.map(pool),
  });
  const lendAssets = live.intentV1Assets === undefined ? {} : {
    intentV1Assets: Object.fromEntries(Object.entries(live.intentV1Assets).map(([symbol, g]) => [symbol, assetEntry(g)])),
  };
  // The generations the release keeps for their positions, each with its retained index (src/deployment.ts `retired`).
  const retained = {
    ...(live.intentV1Previous?.length ? { intentV1Previous: live.intentV1Previous.map((p) => ({ intentV1: pick(p.intentV1, ["core", "factory", "exitDesk"]), intentV1IndexerUrl: p.intentV1IndexerUrl })) } : {}),
    ...(live.intentV1AssetsPrevious === undefined ? {} : {
      intentV1AssetsPrevious: Object.fromEntries(Object.entries(live.intentV1AssetsPrevious).map(([symbol, rows]) => [symbol, rows.map((r) => ({ entry: assetEntry(r.entry), indexerUrl: r.indexerUrl }))])),
    }),
  };
  // The private lane's routers by core (D201, D248): the current core's, those it retired and each earlier core's. A loan
  // one of them opened is never served, whatever gage's index says (src/deployment.ts `privateRouters`).
  const lanes = (live.intentV1.previousPrivateLanes ?? []).map((l) => pick(l, ["core", "routers"]));
  // The LP lane as src/deployment.ts reads it (`parseLpLane`), field for field, once shared/lp-lane.mjs has checked it:
  // its vault factory, which since D319 opens every vault (a lane may list none, or name no list), and a v4 sale
  // executor's pool id (D318). A hidden lane too, its switch kept: park reads its pools (D334), nothing else does.
  const lp = lpLane(live, { includeHidden: true });
  const lpBlock = lp ? {
    lpLane: {
      ...pick(live.lpLane, ["public", "startBlock", "core", "registry", "vaultFactory"]),
      vaults: (live.lpLane.vaults ?? []).map((v) => pick(v, ["address", "name"])),
      adapters: live.lpLane.adapters.map((a) => pick(a, ["kind", "address", "positionManager", "factory", "poolManager", "hook"])),
      executors: live.lpLane.executors.map((e) => pick(e, ["address", "token", "kind", "pools", "poolId"])),
      pools: live.lpLane.pools.map((p) => pick(p, ["adapter", "pool", "token0", "token1", "fee", "tickSpacing", "name", "poolId", "native", "hooks"])),
    },
  } : {};
  return {
    chainId: live.chainId,
    USDG: live.USDG,
    ...(live.WETH === undefined ? {} : { WETH: live.WETH }),
    ...(live.StateView === undefined ? {} : { StateView: live.StateView }),
    nativeV2: {
      engines: live.nativeV2.engines.map((e) => pick(e, ["engine", "registry", "rewards", "name", "cashoutRouter"])),
      // `allowed: false` marks a token the release no longer admits: it still claims its Borrow link (D290), unserved.
      assets: (live.nativeV2.assets ?? []).map((a) => pick(a, ["token", "symbol", "name", "decimals", "lane", "allowed"])),
      ...lists,
    },
    intentV1: {
      ...pick(live.intentV1, ["core", "factory", "loopRouter", "rolloverRouter", "public", "privateRouter", "retiredPrivateRouters", "exitDesk"]),
      ...(lanes.length ? { previousPrivateLanes: lanes } : {}),
    },
    // The index of the current generations (D403): USDG's, and each lend asset's that names none of its own.
    ...(live.intentV1IndexerUrl === undefined ? {} : { intentV1IndexerUrl: live.intentV1IndexerUrl }),
    ...lendAssets,
    ...retained,
    // gage's keeper, the one account a standing roll instruction names (D285): rolling by itself is offered only with it.
    ...(live.rolloverExecutor === undefined ? {} : { rolloverExecutor: live.rolloverExecutor }),
    // The release's GenerationDeployer (r13): the SDK adds every lend generation it deployed since from gage's indexer
    // (src/discovery.ts).
    ...(live.generationDeployer === undefined ? {} : { generationDeployer: pick(live.generationDeployer, ["address", "startBlock"]) }),
    pools: Object.fromEntries(Object.entries(live.pools ?? {}).map(([k, p]) => [k, pool(p)])),
    ...lpBlock,
  };
}

const NETWORKS = [
  { chainId: 46630, file: "testnet.ts", name: "TESTNET_MANIFEST", what: "testnet" },
  { chainId: 4663, file: "mainnet.ts", name: "MAINNET_MANIFEST", what: "mainnet (Robinhood Chain)" },
];

async function main() {
  const readers = await sharedReaders();
  if (!readers) {
    console.error("sync-deployment runs in gage's main repository, which holds the release manifests (launch/live/): src/deployments/ is written there.");
    process.exit(1);
  }
  for (const n of NETWORKS) {
    const live = JSON.parse(readFileSync(new URL(`launch/live/${n.chainId}.json`, root), "utf8"));
    if (live.chainId !== n.chainId) throw new Error(`launch/live/${n.chainId}.json names chain ${live.chainId}`);
    if (n.chainId === 4663 && live.intentV1?.public !== true) throw new Error("launch/live/4663.json: the Intent core is not public yet");
    const out = new URL(`../src/deployments/${n.file}`, import.meta.url);
    writeFileSync(out, `// Generated by packages/sdk/scripts/sync-deployment.mjs from launch/live/${n.chainId}.json. Do not edit by hand.
/** The ${n.what} manifest's fields the SDK reads (D224), bundled so it works outside this repository. */
export const ${n.name} = ${JSON.stringify(trim(live, readers), null, 2)} as const;
`);
    console.log(`wrote ${out.pathname}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
