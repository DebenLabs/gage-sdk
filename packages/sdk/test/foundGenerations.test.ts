import { existsSync } from "node:fs";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { FoundGenerationRead } from "../src/chain.js";
import { gageFrom } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { foundGenerationsRefresher, foundProblem, mergeFoundGenerations, proveFoundGenerations } from "../src/discovery.js";
import type { Ctx } from "../src/plans.js";
import { ctx as testCtx, fakeChain, fakeUpstream } from "../src/testing.js";

/**
 * Lend generations found on chain (r13; docs/api.md, "Lend generations found on chain"): a stablecoin market a Safe batch
 * deploys through the release's GenerationDeployer reaches gage-sdk from the indexer's `GET /intent/generations`, with no
 * new SDK release, once read on chain as one that deployer built, as served. The bundled manifest's own generations never
 * depend on that answer.
 */
/**
 * gage.cash's own reasons for refusing a found market (shared/generation-discovery.mjs), from gage's main repository;
 * gage-sdk's public mirror (D308) has no shared/, and leaves out the case held to them.
 */
const SHARED = new URL("../../../shared/generation-discovery.mjs", import.meta.url);
const shared = existsSync(SHARED) ? await import(SHARED.href) as { foundProblem: typeof foundProblem } : null;
const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
// The bundle names the testnet's own deployer since the stable leg (30 October 2026); these cases name a made-up one, and
// `withoutDeployer` stands for a manifest that names none.
const { generationDeployer: _deployer, ...withoutDeployer } = TESTNET_MANIFEST as Record<string, unknown>;
const DEPLOYER = "0xd3910000000000000000000000000000000000d1";
const manifest = { ...withoutDeployer, generationDeployer: { address: DEPLOYER, startBlock: 150_000_000 } };
const chainId = (TESTNET_MANIFEST as { chainId: number }).chainId;
/** A found market's entry as the indexer serves it (shared/generation-discovery.mjs `foundEntry`). */
const entry = (n: number, listed = true) => ({
  lendAsset: { token: at(0xf000_0000 + n * 0x100), symbol: `USDx${n}`, decimals: 18, stable: true }, public: listed, generation: `lend-usdx${n}-r1-20261029`,
  factory: at(0xf000_0001 + n * 0x100), core: at(0xf000_0002 + n * 0x100), reserve: at(0xf000_0005 + n * 0x100), reserveLens: null, reserveKind: "closed",
  mandateVersion: 12, quoteVerifier: at(0xf000_0007 + n * 0x100), fillRouter: at(0xf000_0008 + n * 0x100), gradeRegistry: at(0xf000_0009 + n * 0x100),
  feeProcessor: at(0xf000_0006 + n * 0x100), startBlock: 150_000_001, rolloverRouter: at(0xf000_000b + n * 0x100),
  engine: { registry: at(0xf000_0003 + n * 0x100), registryArtifact: "GageV2TokenRegistry", rewards: at(0xf000_0004 + n * 0x100), cashoutRouter: at(0xf000_000a + n * 0x100),
    flashPool: at(0x9999), startBlock: 150_000_001, grace: 0, terms: [604800, 1814400], bridged: false, rewardTerms: "registry" },
  collateral: [] as unknown[], cashoutPools: [] as unknown[], discovered: true,
});
const body = (generations: Record<string, unknown>, chain = chainId) => ({ schemaVersion: 1, chainId: chain, deployer: manifest.generationDeployer, blockNumber: "1", generations, refused: [] });
/** What the chain records of found market `n`, as its deployer built it. */
const readOf = (n: number, listed = true): FoundGenerationRead => {
  const e = entry(n, listed);
  return {
    deployed: { id: `0x${n.toString(16).padStart(64, "0")}`, asset: e.lendAsset.token, name: e.generation, blockNumber: e.startBlock, factory: e.factory, core: e.core,
      registry: e.engine.registry, rewards: e.engine.rewards, reserve: e.reserve, feeProcessor: e.feeProcessor, quoteVerifier: e.quoteVerifier, fillRouter: e.fillRouter,
      gradeRegistry: e.gradeRegistry, cashoutRouter: e.engine.cashoutRouter, rolloverRouter: e.rolloverRouter },
    recorded: true, listed, exitDesk: null, mandateVersion: 12, symbol: e.lendAsset.symbol, decimals: 18, flashPool: e.engine.flashPool,
  } as FoundGenerationRead;
};
/** A chain whose deployer built the markets `reads` record. */
const chainOf = (...reads: FoundGenerationRead[]) => fakeChain({
  foundGeneration: (_deployer: string, factory: string) => Promise.resolve(reads.find((r) => r.deployed.factory === factory.toLowerCase()) ?? null),
});

describe("found generations in gage-sdk", () => {
  it("join the manifest's generations once listed, after its own, each read as the SDK reads any", () => {
    const merged = mergeFoundGenerations(manifest, body({ USDx1: entry(1), USDx2: entry(2, false) }));
    const d = parseDeployment(merged);
    const found = d.generations.find((g) => g.id === "USDx1");
    expect(found).toMatchObject({ primary: false, factory: getAddress(at(0xf000_0101)), lendAsset: { symbol: "USDx1", decimals: 18, stable: true } });
    expect(found!.core.engine).toBe(getAddress(at(0xf000_0102)));
    // Hidden until its owner lists it, as any generation.
    expect(d.generations.some((g) => g.id === "USDx2")).toBe(false);
    expect(d.generations.map((g) => g.id).slice(0, -1)).toEqual(parseDeployment(manifest).generations.map((g) => g.id));
  });

  it("leave the manifest as it is for an answer it cannot use, or without a deployer", async () => {
    for (const bad of [null, "x", { ...body({}), schemaVersion: 2 }, body({ USDx1: entry(1) }, 4663), { ...body({}), generations: [] }]) {
      expect(mergeFoundGenerations(manifest, bad)).toBe(manifest);
      await expect(proveFoundGenerations(chainOf(readOf(1)), manifest, bad)).resolves.toBeNull();
    }
    expect(mergeFoundGenerations(withoutDeployer, body({ USDx1: entry(1) }))).toBe(withoutDeployer);
    await expect(proveFoundGenerations(chainOf(readOf(1)), withoutDeployer, body({ USDx1: entry(1) }))).resolves.toBeNull();
    // An entry the SDK cannot read, or one naming a key the manifest has, is left out alone.
    const broken = { ...entry(3), core: "nope" };
    const d = parseDeployment(mergeFoundGenerations(manifest, body({ USDx1: entry(1), USDx3: broken })));
    expect(d.generations.map((g) => g.id)).toContain("USDx1");
    expect(d.generations.map((g) => g.id)).not.toContain("USDx3");
  });

  it("are proved on chain: one naming a contract the release's deployer did not build, as served, is refused", async () => {
    const reads = [1, 2, 3, 4, 5, 6].map((n) => readOf(n));
    reads[5] = { ...reads[5]!, recorded: false };
    const served = body({
      USDx1: entry(1),
      USDx2: { ...entry(2), core: at(0xbad) },                                                      // another core than its factory's
      USDx3: { ...entry(3), engine: { ...entry(3).engine, cashoutRouter: at(0xbad) } },             // another cash-out router
      USDx4: { ...entry(4), putRouter: at(0xbad) },                                                 // a router no found generation has
      USDx5: { ...entry(5), factory: at(0xbad) },                                                   // a factory the deployer never built
      USDx6: entry(6),                                                                              // one it does not record (isFactory)
    });
    const proven = new Set<string>();
    const proved = await proveFoundGenerations(chainOf(...reads), manifest, served, proven);
    expect(Object.keys(proved!.generations as object)).toEqual(["USDx1"]);
    expect(await proveFoundGenerations(chainOf(readOf(1)), manifest, body({ USDx1: { ...entry(1), testnetAggregator: at(0xbad) } }))).toMatchObject({ generations: { USDx1: entry(1) } });
    expect((proved!.refused as { symbol: string; reason: string }[]).map((r) => [r.symbol, r.reason])).toEqual([
      ["USDx2", "core is not what the chain records"],
      ["USDx3", "engine.cashoutRouter is not what the chain records"],
      ["USDx4", "putRouter is not what the chain records"],
      ["USDx5", "the release's GenerationDeployer logged no deployment of its factory at its startBlock"],
      ["USDx6", "the release's GenerationDeployer has not recorded its factory (isFactory)"],
    ]);
    // Each proof is kept while the indexer serves the entry unchanged: the same answer reads nothing again.
    const silent = fakeChain({ foundGeneration: () => Promise.reject(new Error("read again")) });
    await expect(proveFoundGenerations(silent, manifest, body({ USDx1: entry(1) }), proven).then((b) => Object.keys(b!.generations as object))).resolves.toEqual(["USDx1"]);
    // A chain that cannot answer proves nothing.
    await expect(proveFoundGenerations(silent, manifest, body({ USDx2: entry(2) })).then((b) => Object.keys(b!.generations as object))).resolves.toEqual([]);
  });

  it.skipIf(shared === null)("are refused for the reasons gage.cash refuses them (shared/generation-discovery.mjs)", () => {
    const read = readOf(1);
    const cases: [string, unknown, FoundGenerationRead | null][] = [
      ["USDx1", entry(1), read],
      ["USDx1", entry(1), null],
      ["USDx1", entry(1), { ...read, recorded: false }],
      ["USDx1", entry(1, false), read],
      ["USDx2", entry(1), read],
      ["USDx1", { ...entry(1), core: at(0xbad) }, read],
      ["USDx1", { ...entry(1), lendAsset: { ...entry(1).lendAsset, decimals: 6 } }, read],
      ["USDx1", { ...entry(1), reserveKind: "open" }, read],
      ["USDx1", { ...entry(1), indexerUrl: "https://elsewhere.example" }, read],
      ["USDx1", { ...entry(1), exitDesk: at(0xde5c) }, read],
      ["USDx1", { ...entry(1), mandateVersion: 13, exitDesk: at(0xde5c) }, { ...read, mandateVersion: 13, exitDesk: at(0xde5c) as never }],
      ["USDx1", { ...entry(1), mandateVersion: 13, exitDesk: at(0xbad) }, { ...read, mandateVersion: 13, exitDesk: at(0xde5c) as never }],
      ["USDx1", { ...entry(1), testnetAggregator: at(0xbad) }, read],
      ["USDx1", { ...entry(1), collateral: [{ symbol: "TSLAx", token: at(0x7e51a), category: "STOCK" }] }, read],
      ["USDx1", { ...entry(1), collateral: [{ symbol: "TSLAx", token: at(0x7e51a).toUpperCase().replace("0X", "0x"), category: "STOCK" }] }, read],
      ["USDx1", { ...entry(1), engine: { ...entry(1).engine, grace: 86_400 } }, read],
      ["USDx1", { ...entry(1), startBlock: 150_000_002 }, read],
    ];
    for (const [symbol, served, facts] of cases) expect(foundProblem(symbol, served, facts), JSON.stringify(served)).toBe(shared!.foundProblem(symbol, served, facts));
    // Genuine as served, with its bound exit desk, with a testnet aggregator (never kept), with a lowercase admission.
    expect(cases.filter(([symbol, served, facts]) => foundProblem(symbol, served, facts) === null).length).toBe(4);
  });

  it("are asked for at most once a minute, the last good answer kept", async () => {
    let now = 0, asks = 0, answer: unknown = body({ USDx1: entry(1) });
    const ctx = { d: parseDeployment(manifest), chain: chainOf(readOf(1)), indexer: { raw: (path: string) => {
      asks += 1;
      expect(path).toBe("/intent/generations");
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ status: 200, body: answer });
    } } } as unknown as Ctx;
    const refresh = foundGenerationsRefresher(ctx, manifest, { intervalMs: 60_000, now: () => now });
    await refresh();
    expect(ctx.d.generations.some((g) => g.id === "USDx1")).toBe(true);
    await refresh();
    expect(asks).toBe(1);
    now = 60_000;
    answer = new Error("down");
    await refresh();
    expect(asks).toBe(2);
    expect(ctx.d.generations.some((g) => g.id === "USDx1")).toBe(true);
  });

  it("reach a Gage's reads once proved: its deployment is the latest one asked", async () => {
    let served = body({});
    const ctx = testCtx({ d: parseDeployment(manifest), chain: chainOf(readOf(1)), indexer: fakeUpstream({ "/intent/generations": () => ({ status: 200, body: served }) }) });
    const gage = gageFrom(ctx, { refresh: foundGenerationsRefresher(ctx, manifest) });
    expect(gage.deployment.generations.some((g) => g.id === "USDx1")).toBe(false);
    served = body({ USDx1: { ...entry(1), core: at(0xbad) } });
    await gage.refreshGenerations();
    expect(gage.deployment.generations.some((g) => g.id === "USDx1")).toBe(false);
    served = body({ USDx1: entry(1) });
    await gage.refreshGenerations();
    expect(gage.deployment.generations.some((g) => g.id === "USDx1")).toBe(true);
  });
});
