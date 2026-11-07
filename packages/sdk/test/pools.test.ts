/**
 * Pool vaults (D333), as gage.cash makes and reads them (shared/pool-vaults.mjs, web/src/test/poolVaults.test.ts): one
 * vault for each pool token gage lends, each on its own generation's factory, both carrying one name that ends in the
 * pool's tag. `createPoolVaults` answers the calls for one wallet batch and the same as a Safe's Transaction Builder
 * file, each checked against the chain and simulated from the curator; `poolVaults` groups the partner vaults back.
 */
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { factoryAbi } from "../src/abi.js";
import { createGage, gageFrom, type Gage } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { MAINNET_MANIFEST } from "../src/deployments/mainnet.js";
import { ApiError } from "../src/errors.js";
import { NAME_MAX_BYTES, parsePoolName, poolsOf, poolTag, poolVaultName } from "../src/pools.js";
import { batchChecksum } from "../src/safe.js";
import { poolVaultTools } from "../src/tools.js";
import {
  A, assetManifest, CORE, ctx, fakeChain, fakeUpstream, FACTORY, GLD_CORE, GLD_FACTORY, GLD_VAULT, GLDX, manifest, NVDA, putManifest, SCHIFFY, USDG, VAULT,
} from "../src/testing.js";

const FABLES = A(0xfab1e);
const MEME = A(0x16);
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const gage = (over: Parameters<typeof fakeChain>[0] = {}, m: unknown = assetManifest()) => {
  const chain = fakeChain(over);
  return { chain, gage: gageFrom(ctx({ d: parseDeployment(m), chain })) };
};
const create = (args: [Record<string, unknown>, boolean, number, string]) => args;
const decoded = (data: Hex) => create(decodeFunctionData({ abi: factoryAbi, data }).args as unknown as [Record<string, unknown>, boolean, number, string]);
/** A pool's creation as a caller writes it; a test's own fields replace these, wrong ones included. */
const input = (over: Record<string, unknown> = {}) => ({
  curator: FABLES, name: "Fables", pool: ["GLDx", "USDG"], term: 604_800, feeBps: 1_000,
  sides: [{ token: "GLDx", maxLoan: "5000000000000000000" }, { token: "USDG", maxLoan: "1500000000", cashKeptFreeBps: 2_500 }],
  ...over,
}) as Parameters<Gage["createPoolVaults"]>[0];

describe("the rule", () => {
  it("joins the pool's two symbols after the label, within the factory's 48 bytes", () => {
    expect(poolTag(["NVDA", "USDG"])).toBe("NVDA/USDG");
    expect(poolTag(["USDG", "usdg"])).toBeNull();
    expect(poolVaultName("  Fables   deep ", ["frxUSD", "USDG"])).toBe("Fables deep frxUSD/USDG");
    expect(poolVaultName("", ["GLD", "USDG"])).toBe("GLD/USDG");
    expect(poolVaultName("x".repeat(NAME_MAX_BYTES - 10), ["NVDA", "USDG"])).toHaveLength(NAME_MAX_BYTES);
    expect(poolVaultName("x".repeat(NAME_MAX_BYTES - 9), ["NVDA", "USDG"])).toBeNull();
  });

  it("reads a pool only in a name that ends in a tag, never in the names vaults carry today", () => {
    expect(parsePoolName("Fables NVDA/USDG")).toEqual({ label: "Fables", tokens: ["NVDA", "USDG"] });
    for (const name of ["SILICON", "Utility Underwriter", "$AI Only (Artificial Inu)", "GLDx against SCHIFFYx", "Tech 50/50", "Fables NVDA/USDG pool", ""])
      expect(parsePoolName(name)).toBeNull();
  });

  it("pairs one curator's sides of one name, a side taken twice opening a second pool", () => {
    const v = (address: string, name: string, asset: string, curator = FABLES) => ({ address, curator, name, asset });
    const pools = poolsOf([
      v("0x01", "Fables NVDA/USDG", "USDG"), v("0x02", "Fables usdg/nvda", "NVDA"), v("0x03", "Fables NVDA/USDG", "USDG"),
      v("0x04", "Fables NVDA/USDG", "NVDA", A(2)), v("0x05", "Fables NVDA/USDG", "GLD"),
    ]);
    expect(pools.map((p) => [p.curator, p.tokens, p.sides.map((s) => s?.address ?? null)])).toEqual([
      [FABLES, ["NVDA", "USDG"], ["0x02", "0x01"]],
      [FABLES, ["NVDA", "USDG"], [null, "0x03"]],
      [A(2), ["NVDA", "USDG"], ["0x04", null]],
    ]);
  });
});

describe("createPoolVaults", () => {
  it("answers one call per token gage lends, each on its own factory, from the curator, with the shared terms once", async () => {
    const { chain, gage: g } = gage();
    const made = await g.createPoolVaults(input({ buyLoans: { extraBps: 300 }, priorityFeeBps: 1_500, minRateGrade: 2 }));
    expect(made.name).toBe("Fables GLDx/USDG");
    expect(made.calls.map((c) => [c.to, c.value])).toEqual([[GLD_FACTORY, "0"], [FACTORY, "0"]]);
    const [gld, usdg] = made.calls.map((c) => decoded(c.data));
    expect([gld![3], usdg![3]]).toEqual(["Fables GLDx/USDG", "Fables GLDx/USDG"]);
    // The stock's vault lends against its memes (D249) and buys no loans (D251); USDG's opens on stocks and buys them.
    expect(gld![0]).toMatchObject({ curator: getAddress(FABLES), assets: [getAddress(SCHIFFY)], categoryWeights: [0, 10_000, 10_000, 0], maxLoanPrincipal: 5n * 10n ** 18n, bufferBps: 1_000 });
    expect(usdg![0]).toMatchObject({ assets: [getAddress(NVDA)], categoryWeights: [10_000, 0, 0, 10_000], maxLoanPrincipal: 1_500_000_000n, bufferBps: 2_500 });
    for (const [m] of [gld!, usdg!]) expect(m).toMatchObject({ maxLoanTerm: 604_800, feeBps: 1_000, minGrade: 0, minRateGrade: 2, maxAssetBps: 10_000, executionCapBps: 1_500 });
    expect([gld![1], gld![2], usdg![1], usdg![2]]).toEqual([false, 0, true, 300]);
    expect(made.sides.map((s) => [s.symbol, s.created])).toEqual([["GLDx", true], ["USDG", true]]);
    // Each simulated from the curator, before anything is handed over.
    expect(chain.simulated).toEqual(made.calls.map((c) => ({ from: FABLES, to: c.to, data: c.data, value: 0n })));
  });

  it("answers the same calls as a Safe's Transaction Builder file, checksummed as Safe{Wallet} verifies it", async () => {
    const made = await gage().gage.createPoolVaults(input());
    const batch = made.safeBatch;
    expect(batch).toMatchObject({ version: "1.0", chainId: "46630", meta: { createdFromSafeAddress: getAddress(FABLES), txBuilderVersion: "1.17.0" } });
    expect(batch.transactions.map((t) => [t.to, t.data, t.value, t.contractMethod])).toEqual(made.calls.map((c) => [getAddress(c.to), c.data.toLowerCase(), "0", null]));
    expect(batch.meta.checksum).toBe(batchChecksum(batch));
  });

  it("creates only the vault of a pool's token gage lends, and says why the other has none", async () => {
    const frx = A(0xe1);
    const { gage: g } = gage({ tokenInfo: () => Promise.resolve({ symbol: "frxUSD", decimals: 18 }) });
    const made = await g.createPoolVaults(input({ name: "Zia", pool: ["USDG", frx], sides: [{ token: "USDG", maxLoan: "1500000000" }] }));
    expect(made.name).toBe("Zia USDG/frxUSD");
    expect(made.calls.map((c) => c.to)).toEqual([FACTORY]);
    expect(made.sides[1]).toMatchObject({ token: frx, symbol: "frxUSD", created: false, reason: "NOT_LENT" });
    expect(made.notes.join(" ")).toContain("gage lends no vault of frxUSD");
    expect(made.safeBatch.transactions).toHaveLength(1);
  });

  it("leaves out a side its curator is no partner on, and refuses a pool it is a partner on neither side of", async () => {
    const partner = (factories: string[]) => ({
      intentFactory: (factory: Address) => Promise.resolve({ core: factory === GLD_FACTORY ? GLD_CORE : CORE, mandateVersion: 12, isCreator: factories.includes(factory), categories: [0] }),
    });
    const one = await gage(partner([FACTORY])).gage.createPoolVaults(input({ sides: [{ token: "USDG", maxLoan: "1500000000" }] }));
    expect(one.calls.map((c) => c.to)).toEqual([FACTORY]);
    expect(one.sides[0]).toMatchObject({ symbol: "GLDx", created: false, reason: "NOT_A_PARTNER" });
    expect(await code(gage(partner([])).gage.createPoolVaults(input()))).toBe("NOT_A_PARTNER");
  });

  it("creates for any curator on a factory whose creation is open (Intent D43; mainnet since 5 November 2026)", async () => {
    // The fake's own factories and categories, the curator admitted nowhere, creation open on `factories` alone.
    const base = fakeChain();
    const open = (factories: string[]) => ({
      intentFactory: (factory: Address, account: Address, tokens: readonly Address[]) => base.intentFactory(factory, account, tokens)
        .then((state) => ({ ...state, isCreator: false, openCreation: factories.includes(factory) })),
    });
    const both = await gage(open([FACTORY, GLD_FACTORY])).gage.createPoolVaults(input());
    expect(both.calls.map((c) => c.to)).toEqual([GLD_FACTORY, FACTORY]);
    expect(both.sides.every((s) => s.created)).toBe(true);
    const one = await gage(open([FACTORY])).gage.createPoolVaults(input({ sides: [{ token: "USDG", maxLoan: "1500000000" }] }));
    expect(one.calls.map((c) => c.to)).toEqual([FACTORY]);
    expect(one.sides[0]).toMatchObject({ symbol: "GLDx", created: false, reason: "NOT_A_PARTNER" });
  });

  it("refuses what the factories would refuse, in fixed words", async () => {
    const g = gage().gage;
    const memes = { ...manifest(), nativeV2: { ...manifest().nativeV2, assets: [...manifest().nativeV2.assets, { token: MEME, symbol: "MEMEx", name: "A meme", decimals: 18, lane: "MEME" }] } };
    const mixed = gage({ intentFactory: (_f: Address, _a: Address, tokens: readonly Address[]) => Promise.resolve({ core: CORE, mandateVersion: 12, isCreator: true, categories: tokens.map((t) => (t === NVDA ? 0 : 1)) }) }, memes).gage;
    expect(await code(g.createPoolVaults(input({ pool: ["USDG", USDG] })))).toBe("POOL_TOKENS_SAME");
    expect(await code(g.createPoolVaults(input({ name: "x".repeat(40) })))).toBe("NAME_TOO_LONG");
    expect(await code(g.createPoolVaults(input({ pool: ["FRX", "USDG"] })))).toBe("UNKNOWN_TOKEN");
    expect(await code(g.createPoolVaults(input({ sides: [{ token: "USDG", maxLoan: "1500000000" }] })))).toBe("SIDE_NEEDED");
    expect(await code(g.createPoolVaults(input({ sides: [{ token: "NVDA", maxLoan: "1" }] })))).toBe("INVALID_INPUT");
    expect(await code(g.createPoolVaults(input({ sides: [{ token: "GLDx", maxLoan: "1" }, { token: "USDG", maxLoan: "1000000000000001" }] })))).toBe("MAX_LOAN_TOO_HIGH");
    expect(await code(g.createPoolVaults(input({ sides: [{ token: "GLDx", maxLoan: "1" }, { token: "USDG", maxLoan: "1", collateral: [SCHIFFY] }] })))).toBe("UNSUPPORTED_COLLATERAL");
    expect(await code(mixed.createPoolVaults(input({ pool: ["USDG", A(0xe1)], sides: [{ token: "USDG", maxLoan: "1", collateral: [NVDA, MEME] }] })))).toBe("MIXED_COLLATERAL");
    expect(await code(g.createPoolVaults(input({ term: 86_400 })))).toBe("INVALID_INPUT");
    expect(await code(g.createPoolVaults(input({ feeBps: 400 })))).toBe("INVALID_INPUT");
    const changed = gage({ intentFactory: () => Promise.resolve({ core: CORE, mandateVersion: 11, isCreator: true, categories: [1] }) }).gage;
    expect(await code(changed.createPoolVaults(input()))).toBe("FACTORY_CHANGED");
    const reverts = gage({ simulate: () => Promise.reject(new ApiError("SIMULATION_FAILED", "The transaction would revert now", 409)) }).gage;
    expect(await code(reverts.createPoolVaults(input()))).toBe("SIMULATION_FAILED");
  });

  it("leaves the pool's own two tokens out of each vault's collateral, and takes one only where named with allowPoolTokens", async () => {
    // GLDx's generation lends against USDG beside SCHIFFYx (as the testnet's NVDAx does), and USDG's admits GLDx as a
    // stock beside NVDAx: by default neither vault lends against a token of its own pool, so a fall in one does not
    // reach the pool twice.
    const m = putManifest();
    const both = { ...m, nativeV2: { ...m.nativeV2, assets: [...m.nativeV2.assets, { token: GLDX, symbol: "GLDx", name: "Gold (testnet)", decimals: 18, lane: "STOCK" }] } };
    const g = gage({
      intentFactory: (factory: Address, _a: Address, tokens: readonly Address[]) => Promise.resolve({
        core: factory === GLD_FACTORY ? GLD_CORE : CORE, mandateVersion: 12, isCreator: true,
        categories: tokens.map((t) => (t === NVDA || t === GLDX ? 0 : t === SCHIFFY ? 1 : t === USDG ? 2 : null)),
      }),
    }, both).gage;
    const assets = (made: Awaited<ReturnType<Gage["createPoolVaults"]>>) => made.calls.map((c) => decoded(c.data)[0].assets);
    const made = await g.createPoolVaults(input());
    expect(assets(made)).toEqual([[getAddress(SCHIFFY)], [getAddress(NVDA)]]);
    expect(made.sides.map((s) => (s.created ? s.collateral.map((t) => t.symbol) : null))).toEqual([["SCHIFFYx"], ["NVDAx"]]);
    // Named, a pool token is refused, unless allowPoolTokens says it is meant; the default leaves them out either way.
    expect(await code(g.createPoolVaults(input({ sides: [{ token: "GLDx", maxLoan: "1", collateral: [SCHIFFY, USDG] }, { token: "USDG", maxLoan: "1" }] })))).toBe("POOL_TOKEN_COLLATERAL");
    expect(await code(g.createPoolVaults(input({ sides: [{ token: "GLDx", maxLoan: "1" }, { token: "USDG", maxLoan: "1", collateral: [GLDX] }] })))).toBe("POOL_TOKEN_COLLATERAL");
    const meant = await g.createPoolVaults(input({ allowPoolTokens: true, sides: [{ token: "GLDx", maxLoan: "1", collateral: [SCHIFFY, USDG] }, { token: "USDG", maxLoan: "1", collateral: [NVDA, GLDX] }] }));
    expect(assets(meant)).toEqual([[getAddress(SCHIFFY), getAddress(USDG)], [getAddress(NVDA), getAddress(GLDX)]]);
    expect(assets(await g.createPoolVaults(input({ allowPoolTokens: true })))).toEqual([[getAddress(SCHIFFY)], [getAddress(NVDA)]]);
  });

  it("refuses a side whose collateral by default would be the pool's own token alone, so the caller names it", async () => {
    // NVDAx is the one stock USDG's generation admits: the USDG vault of an NVDAx pool has nothing else to start on.
    const { gage: g } = gage({ tokenInfo: () => Promise.resolve({ symbol: "NVDAx", decimals: 18 }) });
    const pool = input({ pool: [NVDA, "USDG"], sides: [{ token: "USDG", maxLoan: "1500000000" }] });
    expect(await code(g.createPoolVaults(pool))).toBe("UNSUPPORTED_COLLATERAL");
    expect(await code(g.createPoolVaults({ ...pool, sides: [{ token: "USDG", maxLoan: "1500000000", collateral: [NVDA] }] }))).toBe("POOL_TOKEN_COLLATERAL");
  });

  it("is on mainnet by default, where USDG's and each public lend asset's factories create, a hidden or retained one's never", () => {
    const live = createGage({ fetch: () => Promise.reject(new Error("offline")) });
    const factories = live.deployment.generations.map((x) => x.factory);
    expect(new Set(factories).size).toBe(factories.length);
    // r13 (4 November 2026): GLD's, NVDA's and HIMS's new generations went public once activated (5 November), and the
    // three r3 generations they replace are retained for their positions alone.
    expect(live.deployment.generations.map((g) => g.id)).toEqual(["USDG", "GLD", "NVDA", "HIMS"]);
    const assets = MAINNET_MANIFEST.intentV1Assets as unknown as Record<string, { public: boolean; factory: string }>;
    const hidden = Object.values(assets).filter((g) => !g.public).map((g) => getAddress(g.factory));
    const retained = live.deployment.retired.filter((g) => !g.primary).map((g) => g.factory);
    expect([hidden.length, retained.length]).toEqual([0, 3]);
    for (const f of [...hidden, ...retained]) expect(factories).not.toContain(f);
  });
});

describe("poolVaults", () => {
  const row = (address: string, core: string, name: string, curator: string = FABLES) =>
    ({ address, creator: curator, curator, core, categoryMask: 6, feeBps: 1_000, maxLoanTerm: 604_800, assets: [SCHIFFY], fundingEnabled: true, name, mandateVersion: 12 });
  const indexer = (usdg: unknown[], gld: unknown[]) => fakeUpstream({
    "/intent/partners/vaults": (path: string) => ({ status: 200, body: { items: path.includes(`factory=${GLD_FACTORY}`) ? gld : usdg, nextCursor: null } }),
    "/intent/partners/links": { links: [{ link: "fables-gldx-usdg", vault: GLD_VAULT }] },
  });
  const read = (usdg: unknown[], gld: unknown[]) => gageFrom(ctx({ d: parseDeployment(assetManifest()), indexer: indexer(usdg, gld) }));

  it("finds a curator's pool across its generations, each side its vault and page", async () => {
    const g = read([row(VAULT, CORE, "Fables GLDx/USDG"), row(A(0x72), CORE, "Steady")], [row(GLD_VAULT, GLD_CORE, "Fables GLDx/USDG")]);
    const { pools } = await g.poolVaults({ curator: FABLES });
    expect(pools).toEqual([{
      name: "Fables GLDx/USDG", curator: FABLES,
      sides: [
        { symbol: "GLDx", token: GLDX, lent: true, vault: GLD_VAULT, factory: GLD_FACTORY, link: "https://testnet.gage.cash/v/fables-gldx-usdg" },
        { symbol: "USDG", token: USDG, lent: true, vault: VAULT, factory: FACTORY, link: `https://testnet.gage.cash/earn/partners/${VAULT}` },
      ],
    }]);
    expect((await g.poolVaults({ curator: A(2) })).pools).toEqual([]);
  });

  it("keeps a pool gage lends one token of, the other side saying it is not lent", async () => {
    const { pools } = await read([row(VAULT, CORE, "Zia USDG/frxUSD")], []).poolVaults();
    expect(pools[0]!.sides[1]).toEqual({ symbol: "frxUSD", token: null, lent: false, vault: null, factory: null, link: null });
  });

  it("comes with the vault tools that never sign: gage_pool_vaults, gage_create_pool_vaults and one vault's", async () => {
    const tools = poolVaultTools(gage().gage);
    expect(tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([["gage_pool_vaults", true], ["gage_create_pool_vaults", true], ["gage_create_partner_vault", true], ["gage_vault_on_chain", true]]);
    // The create tool says its vaults leave the pool's own tokens out, and how a caller who means one says so.
    expect(Object.keys(tools[1]!.inputSchema.shape)).toContain("allowPoolTokens");
    expect(tools[1]!.description).toContain("allowPoolTokens");
    const made = await tools[1]!.execute(input());
    expect((made.calls as unknown[]).length).toBe(2);
    expect(JSON.stringify(made)).not.toMatch(/"\d+n"/);
  });
});
