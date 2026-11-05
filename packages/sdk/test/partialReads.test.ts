import { describe, expect, it } from "vitest";
import { parseDeployment } from "../src/deployment.js";
import { prepareNext } from "../src/prepare.js";
import { portfolio } from "../src/reads.js";
import { A, assetManifest, ctx, fakeChain, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_VAULT, SCHIFFY, WALLET } from "../src/testing.js";

/**
 * One read that fails leaves the rest of a portfolio and of Collect standing (D412): a core whose index does not answer
 * its loans, or a vault whose position does not answer, is named as unread, never shown as empty, and never takes every
 * other core and vault down with it.
 */
const E18 = 10n ** 18n;
const NEW_CORE = A(0x2a), NEW_FACTORY = A(0x5a), NEW_REG = A(0x3a), NEW_REWARDS = A(0x4a), NEW_VAULT = A(0x6a);
const RETAINED = "https://old-indexer.example";

/** The fixture release after GLDx's generation is replaced: the old one is kept with its own index. */
function replaced() {
  const m = assetManifest();
  const old = m.intentV1Assets.GLDx;
  const current = { ...old, factory: NEW_FACTORY, core: NEW_CORE, engine: { ...old.engine, registry: NEW_REG, rewards: NEW_REWARDS } };
  return { ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: current }, intentV1AssetsPrevious: { GLDx: [{ entry: old, indexerUrl: RETAINED }] } };
}
const vault = (address: string, core: string) => ({ address, creator: A(1), curator: A(1), core, categoryMask: 6, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [SCHIFFY], fundingEnabled: true });
const holding = (shares: bigint) => ({ shares: String(shares), value: String(shares), withdrawableNow: "0", rewards: "0", pockets: [] });

/** The current index answers everything; the retained one its vaults and holdings, and its loans only when `loans`. */
function indexes({ loans, retainedHolding = true }: { loans: boolean; retainedHolding?: boolean }) {
  const current = fakeUpstream({
    "/intent/partners/vaults?": (path: string) => ({ status: 200, body: { items: path.includes(`factory=${NEW_FACTORY}`) ? [vault(NEW_VAULT, NEW_CORE)] : [], nextCursor: null } }),
    "/intent/partners/vaults/": holding(3n * E18),
    "/v2/positions?": { items: [], nextCursor: null },
  });
  const retained = fakeUpstream({
    "/intent/partners/vaults?": (path: string) => ({ status: 200, body: { items: path.includes(`factory=${GLD_FACTORY}`) ? [vault(GLD_VAULT, GLD_CORE)] : [], nextCursor: null } }),
    ...(retainedHolding ? { "/intent/partners/vaults/": holding(5n * E18) } : {}),
    ...(loans ? { "/v2/positions?": { items: [], nextCursor: null } } : {}),
  });
  const chain = fakeChain({
    isVault: (factory: string) => Promise.resolve(([GLD_FACTORY, NEW_FACTORY] as string[]).includes(factory.toLowerCase())),
    vaultCore: (v: string) => Promise.resolve(v.toLowerCase() === GLD_VAULT.toLowerCase() ? GLD_CORE : NEW_CORE),
  });
  return { ...ctx({ d: parseDeployment(replaced()), indexer: current, chain }), indexerAt: (url: string) => (url === RETAINED ? retained : current) };
}

describe("a read that fails leaves the rest standing (D412)", () => {
  it("shows a portfolio whose retained core's loans are not answered, and names them as unread", async () => {
    const p = await portfolio(indexes({ loans: false }), WALLET);
    expect(p.earn.map((h) => h.vault)).toEqual(expect.arrayContaining([GLD_VAULT, NEW_VAULT]));
    expect(p.unread).toHaveLength(1);
    expect(p.unread![0]!.toLowerCase()).toContain(GLD_CORE.toLowerCase());
    expect(p.note).toContain("unread");
  });

  it("shows every other holding when one vault's position is not answered", async () => {
    const p = await portfolio(indexes({ loans: true, retainedHolding: false }), WALLET);
    expect(p.earn.map((h) => h.vault)).toEqual([NEW_VAULT]);
    expect(p.unread).toHaveLength(1);
    expect(p.unread![0]!.toLowerCase()).toContain(GLD_VAULT.toLowerCase());
  });

  it("says nothing of unread parts when everything answers", async () => {
    const p = await portfolio(indexes({ loans: true }), WALLET);
    expect(p).not.toHaveProperty("unread");
    expect(p.note).not.toContain("unread");
  });

  it("plans Collect from what answered and says what it could not read", async () => {
    const plan = await prepareNext(indexes({ loans: false, retainedHolding: false }), { action: "collect", wallet: WALLET });
    const notes = plan.notes.join(" ").toLowerCase();
    expect(notes).toContain(GLD_CORE.toLowerCase());
    expect(notes).toContain(GLD_VAULT.toLowerCase());
    expect(plan.notes.join(" ")).toMatch(/Collect again later/);
  });
});
