import { describe, expect, it } from "vitest";
import { partnerOnIndex } from "../src/data.js";
import { earnVaults } from "../src/reads.js";
import { ctx, fakeUpstream, WALLET } from "../src/testing.js";

/** A vault as the index serves it. */
const row = (n: number, core: string) => ({ address: `0x${n.toString(16).padStart(40, "0")}`, creator: WALLET, curator: WALLET, core, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [], fundingEnabled: true });
const books = { pricing: { totalAssets: "1", totalSupply: "1", assetsPerShare: "1" }, liquidity: { free: "1" } };
const VAULT_A = "0x00000000000000000000000000000000000000a1";

describe("a list that stops at the most it reads", () => {
  it("says so, as partial, naming the factory", async () => {
    const base = ctx(), g = base.d.generations[0]!;
    let n = 0;
    const indexer = fakeUpstream({
      "/intent/partners/links": { links: [] },
      "/intent/partners/vaults?": () => ({ status: 200, body: { items: Array.from({ length: 50 }, () => row(++n, g.core.engine)), nextCursor: `0x${n.toString(16).padStart(40, "0")}` } }),
      "/intent/partners/vaults/": books,
    });
    const answer = await earnVaults(ctx({ d: base.d, indexer }));
    expect(answer.vaults).toHaveLength(1_000);
    expect(answer.status).toBe("partial");
    expect(answer.unread?.[0]).toContain(g.factory);
  });

  it("says nothing of it while the list is whole", async () => {
    const base = ctx(), g = base.d.generations[0]!;
    const indexer = fakeUpstream({ "/intent/partners/links": { links: [] }, "/intent/partners/vaults?": { items: [row(1, g.core.engine)], nextCursor: null }, "/intent/partners/vaults/": books });
    const answer = await earnVaults(ctx({ d: base.d, indexer }));
    expect(answer.status).toBeUndefined();
    expect(answer.unread).toBeUndefined();
  });
});

describe("a vault looked up by its address", () => {
  it("reads no list, however long it is", async () => {
    const base = ctx(), g = base.d.generations[0]!;
    const asked: string[] = [], answer = row(0xa1, g.core.engine);
    const indexer = { raw: (path: string) => { asked.push(path); return Promise.resolve({ status: 200, body: answer }); }, get: () => Promise.reject(new Error("no list is read")) } as never;
    expect((await partnerOnIndex(indexer, base.d, g, VAULT_A))?.address).toBe(answer.address);
    expect(asked).toEqual([`/intent/partners/vaults/${VAULT_A}`]);
  });

  it("falls back on the list where the index cannot say", async () => {
    const base = ctx(), g = base.d.generations[0]!;
    const list = { raw: () => Promise.resolve({ status: 503, body: {} }), get: () => Promise.resolve({ items: [row(0xa1, g.core.engine)], nextCursor: null }) } as never;
    expect((await partnerOnIndex(list, base.d, g, VAULT_A))?.address).toBe(VAULT_A);
  });

  it("takes no vault of another core", async () => {
    const base = ctx(), g = base.d.generations[0]!;
    const other = { raw: () => Promise.resolve({ status: 200, body: row(0xa1, "0x00000000000000000000000000000000000000ff") }), get: () => Promise.resolve({ items: [], nextCursor: null }) } as never;
    expect(await partnerOnIndex(other, base.d, g, VAULT_A)).toBeUndefined();
  });
});
