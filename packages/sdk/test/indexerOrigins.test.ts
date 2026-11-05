import { describe, expect, it } from "vitest";
import { indexerOf, walletLoans } from "../src/data.js";
import { parseDeployment } from "../src/deployment.js";
import { prepareNext } from "../src/prepare.js";
import { earnVaults } from "../src/reads.js";
import { A, assetManifest, CORE, ctx, FACTORY, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_VAULT, NVDA, OLD, SCHIFFY, VAULT, WALLET } from "../src/testing.js";

/**
 * One indexer origin per generation (D403): every read of a current generation goes to the origin its release names
 * for it, a lend asset's own `indexerUrl`, else `intentV1IndexerUrl`, as the app's partner pages and gage's keeper read
 * it, never to the network's index the caller configured (`indexerUrl`). Only a release that names neither leaves a
 * generation on the network's index.
 */
const CURRENT = "https://current-indexer.example", GLD_OWN = "https://gld-indexer.example", RETAINED = "https://retained-indexer.example";
const E18 = 10n ** 18n;
const NVDA_CORE = A(0x23), NVDA_FACTORY = A(0x52), NVDA_VAULT = A(0x72);

/** The fixture release with both lend assets public: the USDG generation's and NVDAx's on `CURRENT`, GLDx's on its own. */
function release(origins: { usdg?: string; gld?: string } = { usdg: CURRENT, gld: GLD_OWN }) {
  const m = assetManifest();
  const assets = { GLDx: { ...m.intentV1Assets.GLDx, ...(origins.gld ? { indexerUrl: origins.gld } : {}) }, NVDAx: { ...m.intentV1Assets.NVDAx, public: true } };
  return { ...m, ...(origins.usdg ? { intentV1IndexerUrl: origins.usdg } : {}), intentV1Assets: assets };
}

const row = (address: string, core: string, assets: string[]) => ({ address, creator: A(1), curator: A(1), core, categoryMask: 2, feeBps: 1000, maxLoanTerm: 1_814_400, assets, fundingEnabled: true });
/** An index serving the vaults of `rows` by factory, a list naming no factory being USDG's (`FACTORY`); any other is unknown. */
function index(rows: Record<string, ReturnType<typeof row>> = {}) {
  return fakeUpstream({
    "/intent/partners/vaults?": (path: string) => {
      const vault = rows[/factory=(0x[0-9a-f]{40})/.exec(path)?.[1] ?? FACTORY];
      return vault ? { status: 200, body: { items: [vault], nextCursor: null } } : { status: 404, body: { error: { code: "UNKNOWN_GENERATION" } } };
    },
    "/intent/partners/vaults/": (path: string) => ({ status: 200, body: path.includes("/accounting")
      ? { pricing: { totalAssets: "1000000", totalSupply: String(E18), assetsPerShare: "1000000" }, liquidity: { free: "1000000" } }
      : { kind: "DEPOSIT", assets: String(5n * E18), shares: String(5n * E18), refusal: null, availableNow: null } }),
    "/intent/partners/links": { links: [] },
    "/v2/positions?": { items: [], nextCursor: null },
  });
}

/** The network's index and one index per origin, which `indexerAt` hands out as createGage's does. */
function world(m: object) {
  const network = index(), current = index({ [FACTORY]: row(VAULT, CORE, [NVDA]), [NVDA_FACTORY]: row(NVDA_VAULT, NVDA_CORE, [A(0x15)]) });
  const gld = index({ [GLD_FACTORY]: row(GLD_VAULT, GLD_CORE, [SCHIFFY]) }), retained = index();
  const origins: Record<string, ReturnType<typeof index>> = { [CURRENT]: current, [GLD_OWN]: gld, [RETAINED]: retained };
  const c = { ...ctx({ d: parseDeployment(m), indexer: network }), indexerAt: (url: string) => origins[url]! };
  return { c, network, current, gld, retained };
}

describe("a current generation's index (D403)", () => {
  it("is the origin its release names: a lend asset's own, else intentV1IndexerUrl", () => {
    const d = parseDeployment(release());
    expect(d.generations.map((g) => [g.id, g.indexerUrl])).toEqual([["USDG", CURRENT], ["GLDx", GLD_OWN], ["NVDAx", CURRENT]]);
    // Only a release that names neither leaves a generation on the network's index.
    expect(parseDeployment(release({})).generations.map((g) => g.indexerUrl)).toEqual([undefined, undefined, undefined]);
    expect(parseDeployment(release({ gld: GLD_OWN })).generations.map((g) => g.indexerUrl)).toEqual([undefined, GLD_OWN, undefined]);
    // An origin is an HTTPS origin, as a retained one is.
    for (const bad of ["http://current-indexer.example", "https://current-indexer.example/api", "https://u:p@current-indexer.example"]) {
      expect(() => parseDeployment(release({ usdg: bad }))).toThrow(/HTTPS origin/);
      expect(() => parseDeployment(release({ usdg: CURRENT, gld: bad }))).toThrow(/HTTPS origin/);
    }
  });

  it("serves its vaults and their accounting, whatever the network's index", async () => {
    const { c, network, current, gld } = world(release());
    const { vaults } = await earnVaults(c);
    expect(vaults.map((v) => v.vault)).toEqual([VAULT, GLD_VAULT, NVDA_VAULT]);
    expect(current.asked.sort()).toEqual(["/intent/partners/vaults?limit=50", `/intent/partners/vaults?limit=50&factory=${NVDA_FACTORY}`,
      `/intent/partners/vaults/${NVDA_VAULT}/accounting`, `/intent/partners/vaults/${VAULT}/accounting`].sort());
    expect(gld.asked).toEqual([`/intent/partners/vaults?limit=50&factory=${GLD_FACTORY}`, `/intent/partners/vaults/${GLD_VAULT}/accounting`]);
    // The network's index keeps what is no one generation's: the links table.
    expect(network.asked).toEqual(["/intent/partners/links"]);
  });

  it("serves its core's loans, where an earlier engine's stay on the network's index", async () => {
    const { c, network, current, gld } = world(release());
    for (const engine of [CORE, GLD_CORE, OLD]) await walletLoans(c, engine, WALLET);
    const page = (engine: string) => `/v2/positions?engine=${engine}&account=${WALLET.toLowerCase()}&limit=100`;
    expect([current.asked, gld.asked, network.asked]).toEqual([[page(CORE)], [page(GLD_CORE)], [page(OLD)]]);
  });

  it("previews a deposit at the vault's own origin", async () => {
    const { c, network, gld } = world(release());
    await prepareNext(c, { action: "earn_deposit", wallet: WALLET, vault: GLD_VAULT, amount: String(5n * E18) });
    expect(gld.asked).toContain(`/intent/partners/vaults/${GLD_VAULT}/preview?deposit=${5n * E18}`);
    expect(network.asked).toEqual([]);
  });

  it("leaves a retained generation on its retained origin, and a release naming none on the network's index", () => {
    const old = { ...assetManifest().intentV1Assets.GLDx, factory: A(0x5b), core: A(0x2b), engine: { ...assetManifest().intentV1Assets.GLDx.engine, registry: A(0x3b), rewards: A(0x4b) } };
    const { c, retained, gld } = world({ ...release(), intentV1AssetsPrevious: { GLDx: [{ entry: old, indexerUrl: RETAINED }] } });
    expect(indexerOf(c, c.d.retired[0]!)).toBe(retained);
    expect(indexerOf(c, c.d.generations[1]!)).toBe(gld);
    const bare = world(release({}));
    for (const g of bare.c.d.generations) expect(indexerOf(bare.c, g)).toBe(bare.network);
  });
});
