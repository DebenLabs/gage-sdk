/**
 * Short links (D290), as gage.cash makes them (shared/link-name.mjs, web/src/borrow/tokenLinks.ts): a name becomes a
 * link, the first claim keeps it for good, and a later claim of the same link takes the first characters of its own
 * address. The cases are the web's own (web/src/test/linkName.test.ts, web/src/test/shortLinks.test.tsx).
 */
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseDeployment } from "../src/deployment.js";
import { assignLinks, linkName, tokenLinks, TOKEN_RESERVED, VAULT_RESERVED } from "../src/links.js";
import { A, assetManifest, manifest } from "../src/testing.js";

const A1 = "0x2132aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B1 = "0x4f2abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C1 = "0x4f2a91cccccccccccccccccccccccccccccccccc";

describe("linkName", () => {
  it("keeps letters and digits, lower-case, one dash between words", () => {
    expect(linkName("SILICON")).toBe("silicon");
    expect(linkName("Utility Underwriter")).toBe("utility-underwriter");
    expect(linkName("$AI Only (Artificial Inu)")).toBe("ai-only-artificial-inu");
    expect(linkName("  Crème brûlée  vault ")).toBe("creme-brulee-vault");
  });

  it("gives no link for a name with no letters or digits it can keep", () => {
    expect(linkName("富贵")).toBeNull();
    expect(linkName("🪶")).toBeNull();
    expect(linkName("")).toBeNull();
    expect(linkName(undefined)).toBeNull();
  });

  it("stops at 40 characters, never on a dash", () => {
    const link = linkName("a".repeat(39) + " b and more words")!;
    expect(link).toBe("a".repeat(39));
    expect(link.length).toBeLessThanOrEqual(40);
  });
});

describe("assignLinks", () => {
  it("lets the first claim keep a name, and gives a later one the start of its address", () => {
    const links = assignLinks([{ address: A1, name: "Silicon" }, { address: B1, name: "SILICON" }]);
    expect(links.get(A1.toLowerCase())).toBe("silicon");
    expect(links.get(B1.toLowerCase())).toBe("silicon-4f2a");
  });

  it("takes more of the address when the shorter link is already someone's", () => {
    const links = assignLinks([
      { address: A1, name: "silicon" },
      { address: B1, name: "silicon 4f2a" },
      { address: C1, name: "Silicon" },
    ]);
    expect(links.get(B1.toLowerCase())).toBe("silicon-4f2a");
    expect(links.get(C1.toLowerCase())).toBe("silicon-4f2a91");
  });

  it("keeps an address's first link: a later name it took never moves it, nor frees the first", () => {
    const links = assignLinks([
      { address: A1, name: "Silicon" },
      { address: A1, name: "Silicon Prime" },
      { address: B1, name: "Silicon" },
    ]);
    expect(links.get(A1.toLowerCase())).toBe("silicon");
    expect(links.get(B1.toLowerCase())).toBe("silicon-4f2a");
  });

  it("never hands out a reserved word or a link that reads as an address", () => {
    const links = assignLinks([{ address: A1, name: "Gage" }, { address: B1, name: "0x12" }], VAULT_RESERVED);
    expect(links.get(A1.toLowerCase())).toBe("gage-2132");
    expect(links.get(B1.toLowerCase())).toBe("0x12-4f2a");
    expect(TOKEN_RESERVED).toEqual(["private", "zap"]);
  });

  it("leaves out a claim whose name gives no link", () => {
    expect(assignLinks([{ address: A1, name: "🪶" }]).size).toBe(0);
  });
});

// The release's tokens Borrow lends against: BONER, two CATs (the first no longer admitted), a ticker that is Borrow's
// own page, a ticker with no letters, and a lend asset's own meme listed after them.
const T = {
  boner: "0x98096d17e191b3da1d5f99a6d7b3584351b11e18",
  oldCat: "0xc0a7000000000000000000000000000000000001",
  cat: "0x4f2a000000000000000000000000000000000002",
  priv: "0x9111000000000000000000000000000000000003",
  feather: "0xa870000000000000000000000000000000000004",
  ai: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
};
/** The release of web/src/test/shortLinks.test.tsx, as a manifest: its tokens, then GLDx's own list naming AI and BONER. */
const linkedRelease = () => {
  const m = assetManifest();
  const meme = (token: string, symbol: string, over: Record<string, unknown> = {}) => ({ token, symbol, name: symbol, decimals: 18, lane: "MEME", ...over });
  return {
    ...m,
    nativeV2: { ...m.nativeV2, assets: [
      meme(getAddress(T.boner), "BONER"), meme(T.oldCat, "CAT", { allowed: false }), meme(T.cat, "Cat"), meme(T.priv, "PRIVATE"), meme(T.feather, "🪶"),
    ] },
    intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, collateral: [{ symbol: "AI", token: T.ai, category: "MEME" }, { symbol: "BONER", token: T.boner, category: "MEME" }] } },
  };
};

describe("a token's short link", () => {
  it("gives each admitted token its ticker, in the release's order, the first claim keeping it, and none to a ticker with no letters", () => {
    const links = tokenLinks([
      { token: "0x98096D17E191B3DA1D5F99A6D7B3584351B11E18", symbol: "BONER", allowed: true }, { token: T.oldCat, symbol: "CAT", allowed: false },
      { token: T.cat, symbol: "Cat", allowed: true }, { token: T.priv, symbol: "PRIVATE", allowed: true }, { token: T.feather, symbol: "🪶", allowed: true },
      { token: T.ai, symbol: "AI", allowed: true }, { token: T.boner, symbol: "BONER", allowed: true },
    ]);
    expect([T.boner, T.cat, T.priv, T.feather, T.ai].map((t) => links.get(t) ?? null)).toEqual(["boner", "cat-4f2a", "private-9111", null, "ai"]);
    // The CAT no longer admitted keeps the link it claimed first, and serves none.
    expect(links.has(T.oldCat)).toBe(false);
    expect([...links.values()]).not.toContain("cat");
  });

  it("is the deployment's: the release's tokens, then each public lend asset's own, admitted ones only", () => {
    const d = parseDeployment(linkedRelease());
    expect(Object.fromEntries(d.tokenLinks)).toEqual({ [T.boner]: "boner", [T.cat]: "cat-4f2a", [T.priv]: "private-9111", [T.ai]: "ai" });
    // A lend asset's list is not the app's while its generation is hidden.
    const hidden = parseDeployment({ ...linkedRelease(), intentV1Assets: { ...linkedRelease().intentV1Assets, GLDx: { ...linkedRelease().intentV1Assets.GLDx, public: false } } });
    expect(hidden.tokenLinks.has(T.ai)).toBe(false);
    expect(parseDeployment(manifest()).tokenLinks.get(A(0x11))).toBe("nvdax");
  });
});
