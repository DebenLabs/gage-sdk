import { existsSync, readFileSync } from "node:fs";
import { getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { parseDeployment, parseLoopPools, type Deployment, type PoolKey } from "../src/deployment.js";
import { MAINNET_MANIFEST } from "../src/deployments/mainnet.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { poolId } from "../src/v4math.js";

const flat = (d: Deployment) => ({ ...d, pools: [...d.pools.entries()], loopPools: [...d.loopPools.entries()] });
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as unknown;
/** gage's main repository, where the live manifests are: gage-sdk's public mirror (D308) has only the bundled ones. */
const LIVE = new URL("../../../launch/live/", import.meta.url);

describe("the bundled manifests", () => {
  it.skipIf(!existsSync(LIVE))("are the live manifests' (after a new generation on either chain: pnpm --filter gage-sdk sync-deployment)", () => {
    expect(flat(parseDeployment(TESTNET_MANIFEST))).toEqual(flat(parseDeployment(json("../../../launch/live/46630.json"))));
    expect(flat(parseDeployment(MAINNET_MANIFEST))).toEqual(flat(parseDeployment(json("../../../launch/live/4663.json"))));
  });

  it("put mainnet on its own chain, lending through the public Intent core (D257, D260)", () => {
    const d = parseDeployment(MAINNET_MANIFEST);
    expect(d.chainId).toBe(4663);
    expect(d.core.engine).toBe(getAddress(MAINNET_MANIFEST.intentV1.core));
    expect(d.loopRouter).toBe(getAddress(MAINNET_MANIFEST.intentV1.loopRouter));
    expect(d.generations[0]!.id).toBe("USDG");
  });

  it("carry the private lane's routers by core, so a loan one opened is told from the chain (the audit of 18 October 2026, M7)", () => {
    // The current generation's router, then each replaced generation's (r9's since r13, 4 November 2026).
    const { core, privateRouter, previousPrivateLanes = [] } = MAINNET_MANIFEST.intentV1 as {
      core: string; privateRouter: string; previousPrivateLanes?: readonly { readonly core: string; readonly routers: readonly string[] }[];
    };
    expect([...parseDeployment(MAINNET_MANIFEST).privateRouters]).toEqual([
      [core.toLowerCase(), [getAddress(privateRouter)]],
      ...previousPrivateLanes.map((p) => [p.core.toLowerCase(), p.routers.map((r) => getAddress(r))]),
    ]);
  });
});

// scripts/sync-deployment.mjs bundles a public LP lane field for field as src/deployment.ts reads it: what the SDK reads of
// the bundle must be what it reads of the live manifest, or createGage() refuses the whole network once its lane is public.
// It runs in gage's main repository alone, as the live manifests and the shared readers it checks them with are there.
const SYNC = new URL("../scripts/sync-deployment.mjs", import.meta.url);
type Sync = { trim: (live: unknown, readers: unknown) => unknown; sharedReaders: () => Promise<unknown> };
type Live = Record<string, unknown> & {
  USDG: string; WETH: string; NVDAx: string; FlashPool: string; V3Manager: string; V3Factory: string; PositionManager: string; PoolManager: string;
  pools: { nvdaxUsdg: { poolId: string } };
};
describe.skipIf(!existsSync(LIVE))("sync-deployment's bundle of a public LP lane", () => {
  const live = () => json("../../../launch/live/46630.json") as Live;
  const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  /**
   * A public lane as the testnet's release publishes it (D319): its vault factory and no vault of its own, a Uniswap v3
   * and a v4 adapter, the WETH/USDG v3 pool and a hookless v4 pool by its id, and the WETH sale executor.
   */
  const lane = (m: Live) => {
    const id = m.pools.nvdaxUsdg.poolId;
    return {
      public: true, startBlock: 1, core: A(0x9001), registry: A(0x9002), vaultFactory: A(0x9003), vaults: [] as { address: string; name: string }[],
      adapters: [
        { kind: "uniswap-v3", address: A(0x9004), positionManager: m.V3Manager, factory: m.V3Factory },
        { kind: "uniswap-v4", address: A(0x9005), positionManager: m.PositionManager, poolManager: m.PoolManager },
      ],
      executors: [{ address: A(0x9006), token: m.WETH, kind: "one-pool", pools: [m.FlashPool] }] as Record<string, unknown>[],
      pools: [
        { adapter: A(0x9004), pool: m.FlashPool, token0: m.USDG, token1: m.WETH, fee: 500, tickSpacing: 10, name: "Uniswap v3 WETH/USDG (testnet)" },
        { adapter: A(0x9005), pool: `0x${id.slice(-40)}`, token0: m.NVDAx, token1: m.USDG, fee: 3000, tickSpacing: 60, name: "Uniswap v4 NVDAx/USDG 0.3% (testnet)", poolId: id, native: false, hooks: zeroAddress },
      ],
    };
  };
  const bundled = async (m: unknown) => {
    const sync = await import(SYNC.href) as Sync;
    return sync.trim(m, await sync.sharedReaders());
  };
  const same = async (m: Live) => expect(parseDeployment(await bundled(m)).lpLane).toEqual(parseDeployment(m).lpLane);

  it("keeps the lane's vault factory, its only source of vaults since D319", async () => {
    const m = live();
    await same({ ...m, lpLane: lane(m) });
    expect(parseDeployment(await bundled({ ...m, lpLane: lane(m) })).lpLane?.vaultFactory).toBe(getAddress(A(0x9003)));
  });

  it("keeps a v4 sale executor's pool id (D318)", async () => {
    const m = live(), l = lane(m), id = m.pools.nvdaxUsdg.poolId;
    l.vaults = [{ address: A(0x9008), name: "A curator's vault" }];
    l.executors.push({ address: A(0x9007), token: m.NVDAx, kind: "v4-one-pool", pools: [`0x${id.slice(-40)}`], poolId: id });
    await same({ ...m, lpLane: l });
  });

  it("bundles a lane that names no list of vaults at all, as shared/lp-lane.mjs reads one", async () => {
    const m = live(), { vaults: _, ...l } = lane(m);
    await same({ ...m, lpLane: l });
  });
});

// The exit desk (Intent D57) is read of every generation, current or retained: the exit actions are served where a
// current one names it (src/networks.ts), and what its sales paid is collected from each (src/earnExit.ts). A bundle
// without it offers no exit now where the live release does.
describe.skipIf(!existsSync(LIVE))("sync-deployment's bundle of the exit desk", () => {
  it("keeps the desk each generation names, current or retained", async () => {
    type Manifest = Record<string, unknown> & { intentV1: Record<string, unknown>; nativeV2: { engines: { engine: string }[] }; intentV1Assets: Record<string, Record<string, unknown>>; intentV1AssetsPrevious?: Record<string, { entry: { exitDesk?: string } }[]> };
    const m = json("../../../launch/live/46630.json") as Manifest, desk = `0x${"de5c".repeat(10)}`;
    const named: Manifest = {
      ...m,
      intentV1: { ...m.intentV1, mandateVersion: 13, exitDesk: desk },
      // GLDx and NVDAx public, as the live ones are once activated (a generation deployed with funding closed is not served yet).
      intentV1Assets: {
        ...m.intentV1Assets,
        GLDx: { ...m.intentV1Assets.GLDx, public: true, mandateVersion: 13, exitDesk: desk },
        NVDAx: { ...m.intentV1Assets.NVDAx, public: true, mandateVersion: 13, exitDesk: desk },
      },
      // An earlier USDG generation kept for its positions, on an earlier engine the manifest lists.
      intentV1Previous: [{ intentV1: { core: m.nativeV2.engines.at(-2)!.engine, factory: `0x${"fa".repeat(20)}`, mandateVersion: 13, exitDesk: desk }, intentV1IndexerUrl: "https://indexer.example" }],
    };
    const sync = await import(SYNC.href) as Sync;
    const bundled = parseDeployment(sync.trim(named, await sync.sharedReaders())), read = parseDeployment(named);
    expect(read.generations.map((g) => [g.id, g.exitDesk])).toEqual([["USDG", getAddress(desk)], ["GLDx", getAddress(desk)], ["NVDAx", getAddress(desk)]]);
    const retainedAssetDesks = Object.values(named.intentV1AssetsPrevious ?? {}).flatMap((rows) => rows.map(({ entry }) => entry.exitDesk ? getAddress(entry.exitDesk) : undefined));
    expect(read.retired.map((g) => g.exitDesk)).toEqual([getAddress(desk), ...retainedAssetDesks]);
    expect(bundled.generations.map((g) => g.exitDesk)).toEqual(read.generations.map((g) => g.exitDesk));
    expect(bundled.retired.map((g) => g.exitDesk)).toEqual(read.retired.map((g) => g.exitDesk));
  });
});

// One indexer origin per generation (D403): the bundle reads each current generation at the origin the release names
// for it, as the live manifest does. A bundle without them reads every generation at the network's index (MAINNET_DEFAULTS),
// which at a cutover is another origin than the app's and the keeper's.
describe.skipIf(!existsSync(LIVE))("sync-deployment's bundle of the indexer origins", () => {
  it("keeps intentV1IndexerUrl and each lend asset's own origin", async () => {
    type Manifest = Record<string, unknown> & { intentV1Assets: Record<string, Record<string, unknown>> };
    const m = json("../../../launch/live/46630.json") as Manifest, { indexerUrl: _inherits, ...nvdax } = m.intentV1Assets.NVDAx!;
    const named: Manifest = {
      ...m, intentV1IndexerUrl: "https://current.example",
      intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, public: true, indexerUrl: "https://gldx.example" }, NVDAx: { ...nvdax, public: true } },
    };
    const sync = await import(SYNC.href) as Sync;
    const trimmed = sync.trim(named, await sync.sharedReaders()) as Manifest;
    expect(trimmed.intentV1IndexerUrl).toBe("https://current.example");
    expect([trimmed.intentV1Assets.GLDx!.indexerUrl, trimmed.intentV1Assets.NVDAx!.indexerUrl]).toEqual(["https://gldx.example", undefined]);
    expect(parseDeployment(trimmed).generations.map((g) => [g.id, g.indexerUrl])).toEqual([["USDG", "https://current.example"], ["GLDx", "https://gldx.example"], ["NVDAx", "https://current.example"]]);
  });
});

describe("the chains served", () => {
  const live = MAINNET_MANIFEST as unknown as { intentV1: Record<string, unknown> };

  it("are Robinhood Chain and its testnet, nothing else", () => {
    expect(() => parseDeployment({ ...live, chainId: 1 })).toThrow(/4663.*46630/);
  });

  it("take a mainnet manifest only once its Intent core is public", () => {
    expect(() => parseDeployment({ ...live, intentV1: { ...live.intentV1, public: false } })).toThrow(/not public/);
    const { public: _, ...unswitched } = live.intentV1;
    expect(() => parseDeployment({ ...live, intentV1: unswitched })).toThrow(/not public/);
  });
});

type Row = { protocol?: string; poolAddress?: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
interface Fixture { USDG: string; pools: Record<string, Row>; nativeV2: { assets: { token: string; symbol: string }[]; routingPools: Row[]; cashoutPools: Row[] } }

// Every pool row of MSTR, AMC and RDDT in main's mainnet manifest (test/fixtures/mainnet-loop-pools.json): each has a V3
// USDG pool in `pools` and again in `nativeV2.routingPools`, its v4 USDG pools in `nativeV2.cashoutPools`, and MSTR a
// V3 pool with WETH. Today's app reads one v4 key per token from `pools` alone, so none of the three can loop there.
describe("leverage's pools (D242)", () => {
  const m = json("./fixtures/mainnet-loop-pools.json") as Fixture;
  const pools = parseLoopPools(m);
  const usdg = getAddress(m.USDG);
  const token = (symbol: string) => getAddress(m.nativeV2.assets.find((a) => a.symbol === symbol)!.token);
  const v4 = (currency0: Address, currency1: Address, fee: number, tickSpacing: number) => ({ kind: "v4", key: { currency0, currency1, fee, tickSpacing, hooks: zeroAddress } });
  const v3 = (pool: string, fee: number) => ({ kind: "v3", pool: getAddress(pool), fee });

  it("are every USDG pool of a listed token in every pool list, V3 and v4, once each and in the manifest's order", () => {
    const [mstr, amc, rddt] = [token("MSTR"), token("AMC"), token("RDDT")];
    expect(pools.get(mstr.toLowerCase())).toEqual([
      v3("0x17578c0e0d15da44f31677263114f71ae76653ea", 10_000), v4(usdg, mstr, 2500, 25), v4(usdg, mstr, 2400, 24),
    ]);
    expect(pools.get(amc.toLowerCase())).toEqual([v3("0xaa34fea710a1a737840329051d81d3b0b7c564d5", 3000), v4(amc, usdg, 1000, 10)]);
    expect(pools.get(rddt.toLowerCase())).toEqual([v3("0xa8744e76aed23b05f0126335e7bd38f7935d19fe", 10_000), v4(rddt, usdg, 2900, 29)]);
    expect([...pools.keys()].sort()).toEqual([amc, mstr, rddt].map((t) => t.toLowerCase()).sort());
  });

  it("never read a V3 row as a v4 key, although it carries a key's fields", () => {
    const rows = [...Object.values(m.pools), ...m.nativeV2.routingPools, ...m.nativeV2.cashoutPools].filter((r) => r.protocol === "v3");
    expect(rows).toHaveLength(7);
    const keyOf = (r: Row): PoolKey => ({ currency0: getAddress(r.currency0), currency1: getAddress(r.currency1), fee: r.fee, tickSpacing: r.tickSpacing, hooks: zeroAddress });
    const v4Ids = [...pools.values()].flat().flatMap((p) => (p.kind === "v4" ? [poolId(p.key)] : []));
    for (const r of rows) expect(v4Ids).not.toContain(poolId(keyOf(r)));
    // Nor does a V3 row that lost its `protocol`: the `poolId` it states (the padded address) is not its key's hash.
    const { protocol: _, ...bare } = m.pools.rddtUsdgV3!;
    expect(parseLoopPools({ ...m, pools: { rddtUsdgV3: bare }, nativeV2: { ...m.nativeV2, routingPools: [], cashoutPools: [] } }).size).toBe(0);
  });

});
