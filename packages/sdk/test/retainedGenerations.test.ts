import { describe, expect, it } from "vitest";
import { engineOf, lendAssetOf, parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { prepareNext } from "../src/prepare.js";
import { portfolio } from "../src/reads.js";
import { A, assetManifest, ctx, fakeChain, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_REG, GLD_VAULT, GLDX, SCHIFFY, WALLET } from "../src/testing.js";

const E18 = 10n ** 18n;
const NEW_CORE = A(0x2a), NEW_FACTORY = A(0x5a), NEW_REG = A(0x3a), NEW_REWARDS = A(0x4a);
const RETAINED = "https://old-indexer.example";
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

/** The fixture release after GLDx's generation is replaced: the old one is kept with its own index. */
function replaced(indexerUrl = RETAINED) {
  const m = assetManifest();
  const old = m.intentV1Assets.GLDx;
  const current = { ...old, factory: NEW_FACTORY, core: NEW_CORE, engine: { ...old.engine, registry: NEW_REG, rewards: NEW_REWARDS } };
  return { ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: current }, intentV1AssetsPrevious: { GLDx: [{ entry: old, indexerUrl }] } };
}
const vault = { address: GLD_VAULT, creator: A(1), curator: A(1), core: GLD_CORE, categoryMask: 6, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [SCHIFFY], fundingEnabled: true };

describe("retained generations", () => {
  it("keeps a replaced generation for its positions and loans, never as a current one", () => {
    const d = parseDeployment(replaced());
    expect(d.generations.map((g) => g.factory)).not.toContain(GLD_FACTORY);
    expect(d.retired.map((g) => [g.id, g.factory, g.core.engine, g.retired?.indexerUrl])).toEqual([["GLDx", GLD_FACTORY, GLD_CORE, RETAINED]]);
    expect(engineOf(d, GLD_CORE)?.registry).toBe(GLD_REG);
    expect(lendAssetOf(d, GLD_CORE).token).toBe(GLDX);
    expect(() => parseDeployment(replaced("http://old-indexer.example"))).toThrow(/HTTPS origin/);
  });

  it("reads a retained vault's holding from its own index, and refuses a deposit into it", async () => {
    const current = fakeUpstream({ "/intent/partners/vaults?": { items: [], nextCursor: null }, "/v2/positions?": { items: [], nextCursor: null } });
    const retained = fakeUpstream({
      "/intent/partners/vaults?": (path: string) => ({ status: 200, body: { items: path.includes(`factory=${GLD_FACTORY}`) ? [vault] : [], nextCursor: null } }),
      "/intent/partners/vaults/": { shares: String(5n * E18), value: String(42n * E18 / 10n), withdrawableNow: String(E18), rewards: "0", pockets: [] },
      "/v2/positions?": { items: [], nextCursor: null },
    });
    const c = { ...ctx({ d: parseDeployment(replaced()), indexer: current, chain: fakeChain({ isVault: (factory: string) => Promise.resolve(factory.toLowerCase() === GLD_FACTORY), vaultCore: () => Promise.resolve(GLD_CORE) }) }), indexerAt: (url: string) => (url === RETAINED ? retained : current) };
    const p = await portfolio(c, WALLET);
    expect(p.earn).toEqual([expect.objectContaining({ vault: GLD_VAULT, value: String(42n * E18 / 10n), withdrawableNow: String(E18) })]);
    expect(retained.asked.some((path) => path.includes(`/position/${WALLET.toLowerCase()}`))).toBe(true);
    expect(await code(prepareNext(c, { action: "earn_deposit", wallet: WALLET, vault: GLD_VAULT, amount: String(5n * E18) }))).toBe("FUNDING_CLOSED");
  });
});
