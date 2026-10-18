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
    const { core, privateRouter } = MAINNET_MANIFEST.intentV1 as { core: string; privateRouter: string };
    expect([...parseDeployment(MAINNET_MANIFEST).privateRouters]).toEqual([[core.toLowerCase(), [getAddress(privateRouter)]]]);
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
