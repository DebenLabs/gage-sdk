/**
 * A release that lends GLDx beside USDG (D251, Intent D55): an 18-decimal stock token's generation, public, with its own
 * core, registry, factory and vault, lending against SCHIFFYx; and NVDAx's, hidden. gage-sdk serves the public one only,
 * counts every amount in its asset, checks on chain that the core or vault pays in it before any write, keeps leverage
 * USDG's, and never sends a full-balance redemption an 18-decimal vault cannot pay after a loss.
 */
import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { engineAbi, partnerVaultAbi } from "../src/abi.js";
import { engineOf, lendsMore, parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { redeemableShares } from "../src/plans.js";
import { prepareNext } from "../src/prepare.js";
import { assets, borrowQuote, capabilities, earnVaults, LEND_ASSET_RULE, leverageQuote, loan, portfolio, PRIVATE_RULE } from "../src/reads.js";
import { run } from "../src/run.js";
import {
  A, assetManifest, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_REG, GLD_VAULT, GLDX, loan as chainLoan, manifest, NOW, NVDA, position,
  preview, SCHIFFY, USDG, VAULT, WALLET,
} from "../src/testing.js";

const E18 = 10n ** 18n;
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? `${e.code}: ${e.message}` : String(e); } };
const d = () => parseDeployment(assetManifest());
const GLD = { token: GLDX, symbol: "GLDx", decimals: 18 };
const vault = (address: string, core: string) => ({ address, creator: A(1), curator: A(1), core, categoryMask: 6, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [SCHIFFY], fundingEnabled: true });
/** The indexer's vault lists, by generation: GLDx's when its factory is named, USDG's otherwise. */
const lists = (path: string) => ({
  status: 200,
  body: path.includes(`factory=${GLD_FACTORY}`) ? { items: [vault(GLD_VAULT, GLD_CORE)], nextCursor: null } : { items: [vault(VAULT, CORE)], nextCursor: null },
});

describe("the deployment", () => {
  it("serves GLDx's public generation after USDG's, never the hidden NVDAx one, and keeps its core apart from the USDG engines", () => {
    const x = d();
    expect(x.generations.map((g) => g.id)).toEqual(["USDG", "GLDx"]);
    expect(x.generations[1]).toMatchObject({ primary: false, lendAsset: { token: GLDX, symbol: "GLDx", decimals: 18, stable: false }, factory: GLD_FACTORY, core: { engine: GLD_CORE, registry: GLD_REG } });
    expect(x.generations[1]!.collateral).toEqual([{ token: SCHIFFY, symbol: "SCHIFFYx", category: "MEME" }]);
    expect(lendsMore(x)).toBe(true);
    expect(x.engines.map((e) => e.engine)).not.toContain(GLD_CORE);
    expect(engineOf(x, GLD_CORE)?.registry).toBe(GLD_REG);
    expect(engineOf(x, A(0x23))).toBeNull();
  });

  it("reads as before without a public lend asset: today's release, a hidden one, or the network's switch off", () => {
    for (const m of [manifest(), assetManifest({ public: false }), { ...assetManifest(), intentV1: { ...manifest().intentV1, public: false } }]) {
      const x = parseDeployment(m);
      expect(x.generations.map((g) => g.id)).toEqual(["USDG"]);
      expect(lendsMore(x)).toBe(false);
    }
  });

  it("refuses an entry it cannot read rather than guess", () => {
    const m = assetManifest();
    expect(() => parseDeployment({ ...m, intentV1Assets: { GLDx: { ...m.intentV1Assets.GLDx, lendAsset: { ...m.intentV1Assets.GLDx.lendAsset, decimals: 19 } } } })).toThrow(/6 to 18/);
    expect(() => parseDeployment({ ...m, intentV1Assets: { GLD: m.intentV1Assets.GLDx } })).toThrow(/another symbol/);
    expect(() => parseDeployment({ ...m, intentV1Assets: { GLDx: { ...m.intentV1Assets.GLDx, core: CORE } } })).toThrow(/twice/);
  });
});

describe("a loan in GLDx", () => {
  const input = { action: "borrow" as const, wallet: WALLET, token: SCHIFFY, collateral: String(100n * E18), principal: String(E18 / 2n), cap: "504000000000000000", term: 604_800, lendAsset: GLDX };

  it("is listed on GLDx's core after the exact pledge approval, its figures and words in GLDx", async () => {
    const rates = fakeUpstream({ "/intent/preview/": preview() });
    const p = await prepareNext(ctx({ d: d(), rates }), input);
    expect(p.status).toBe("approval_required");
    expect(p.next?.transaction.to.toLowerCase()).toBe(SCHIFFY);
    expect(decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args).toEqual([GLD_CORE, 100n * E18]);
    expect(rates.asked.some((path) => path.startsWith(`/intent/preview/${GLD_CORE}?`))).toBe(true);
    expect(p.summary.title).toBe("Borrow 0.5 GLDx against 100 SCHIFFYx");
    expect(p.summary.rows).toContainEqual({ label: "You receive", value: "0.495 GLDx after the 1% fee" });
    expect(p.summary.rows).toContainEqual({ label: "You repay within 7 days of funding", value: "0.504 GLDx" });
    expect(p.notes).toContain("You repay in GLDx. In dollars, what you repay moves with GLDx's price.");
    expect(p.view).toMatchObject({ action: "borrow", symbol: "SCHIFFYx", asset: GLD, engine: GLD_CORE, valueUSDG: null });
    const ready = await prepareNext(ctx({ d: d(), rates, chain: fakeChain({ allowance: () => Promise.resolve(10n ** 30n) }) }), input);
    expect(ready.next?.transaction.to.toLowerCase()).toBe(GLD_CORE);
    const list = decodeFunctionData({ abi: engineAbi, data: ready.next!.transaction.data });
    expect(list.functionName).toBe("list");
    expect(list.args.slice(1, 4)).toEqual([E18 / 2n, 504_000_000_000_000_000n, 604_800]);
  });

  it("refuses an asset gage does not lend, a token GLDx's vaults do not take, and a core that no longer pays in GLDx", async () => {
    expect(await code(prepareNext(ctx({ d: d() }), { ...input, lendAsset: A(0x99) }))).toMatch(/^UNKNOWN_LEND_ASSET/);
    expect(await code(prepareNext(ctx({ d: d() }), { ...input, token: NVDA }))).toBe("UNSUPPORTED_COLLATERAL: gage does not lend GLDx against this token");
    expect(await code(prepareNext(ctx({ d: d(), chain: fakeChain({ coreAsset: () => Promise.resolve(USDG) }) }), input))).toMatch(/^ASSET_CHANGED/);
    // Leverage is USDG's alone (D251).
    const loop = { action: "leverage" as const, wallet: WALLET, token: NVDA, own: String(E18), multiple: 2, term: 604_800, maxCostBps: 500, lendAsset: GLDX };
    expect(await code(prepareNext(ctx({ d: d() }), loop))).toMatch(/^LEVERAGE_CLOSED: Leverage lends USDG only/);
    expect(await code(leverageQuote(ctx({ d: d() }), { token: NVDA, own: String(E18), multiple: 2, term: 604_800, lendAsset: GLDX }))).toMatch(/^LEVERAGE_CLOSED/);
  });

  it("names USDG as the asset of a USDG loan once a lend asset is public, and nothing in today's release", async () => {
    const usdg = { action: "borrow" as const, wallet: WALLET, token: NVDA, collateral: String(5n * E18), principal: "1000000000", cap: "1010000000", term: 604_800 };
    const now = await prepareNext(ctx({ d: d() }), usdg);
    expect(now.view).toMatchObject({ asset: { token: USDG, symbol: "USDG", decimals: 6 }, engine: CORE });
    expect(now.summary.title).toBe("Borrow 1,000.00 USDG against 5 NVDAx");
    const today = await prepareNext(ctx(), usdg);
    expect(today.view).not.toHaveProperty("asset");
    expect(today.view).not.toHaveProperty("engine");
  });

  it("is repaid in GLDx: the exact GLDx approval to its core, rounded up where it is shown, then the repayment", async () => {
    const indexer = fakeUpstream({ "/v2/positions/": position("4", { engine: GLD_CORE }) });
    const running = () => Promise.resolve(chainLoan({ token: SCHIFFY, principal: E18 / 2n, cap: 504_000_000_000_000_001n, collateral: 100n * E18 }));
    const chain = fakeChain({ loan: running });
    const p = await prepareNext(ctx({ d: d(), indexer, chain }), { action: "reclaim", wallet: WALLET, loanId: "4", engine: GLD_CORE });
    expect(p.next?.transaction.to.toLowerCase()).toBe(GLDX);
    expect(decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args).toEqual([GLD_CORE, 504_000_000_000_000_001n]);
    expect(p.then).toEqual(["Repay", "Receive collateral"]);
    expect(p.summary.rows[0]).toEqual({ label: "You pay", value: "0.504001 GLDx" });
    expect(p.summary.title).toBe("Repay loan #4 and take back 100 SCHIFFYx");
    expect(p.view).toMatchObject({ action: "reclaim", symbol: "SCHIFFYx", asset: GLD, engine: GLD_CORE });
    const poor = fakeChain({ loan: running, balance: (token: string) => Promise.resolve(token.toLowerCase() === GLDX ? 0n : 10n ** 30n) });
    expect(await code(prepareNext(ctx({ d: d(), indexer, chain: poor }), { action: "reclaim", wallet: WALLET, loanId: "4", engine: GLD_CORE })))
      .toBe("INSUFFICIENT_BALANCE: Repaying takes 0.504001 GLDx; the wallet holds less");
    const moved = fakeChain({ loan: running, coreAsset: () => Promise.resolve(USDG) });
    expect(await code(prepareNext(ctx({ d: d(), indexer, chain: moved }), { action: "reclaim", wallet: WALLET, loanId: "4", engine: GLD_CORE }))).toMatch(/^ASSET_CHANGED/);
  });
});

describe("a GLDx vault", () => {
  const deposit = { action: "earn_deposit" as const, wallet: WALLET, vault: GLD_VAULT, amount: String(5n * E18) };

  it("takes GLDx: the exact GLDx approval, then the deposit, asked of GLDx's own vault list", async () => {
    const indexer = fakeUpstream({ "/intent/partners/vaults?": lists, "/intent/partners/vaults/": { kind: "DEPOSIT", assets: String(5n * E18), shares: String(5n * E18), refusal: null, availableNow: null } });
    const p = await prepareNext(ctx({ d: d(), indexer }), deposit);
    expect(indexer.asked).toContain(`/intent/partners/vaults?limit=50&factory=${GLD_FACTORY}`);
    expect(p.next?.transaction.to.toLowerCase()).toBe(GLDX);
    expect(decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args).toEqual([GLD_VAULT, 5n * E18]);
    expect(p.summary.title).toMatch(/^Deposit 5 GLDx into /);
    expect(p.summary.rows).toContainEqual({ label: "Taking it out", value: "Any time, in GLDx, up to the vault's free GLDx" });
    expect(p.view).toMatchObject({ action: "earn_deposit", vault: GLD_VAULT, amount: String(5n * E18), asset: GLD });
  });

  it("says its smallest deposit in GLDx, and refuses a vault that no longer takes GLDx", async () => {
    const refused = fakeUpstream({ "/intent/partners/vaults?": lists, "/intent/partners/vaults/": { kind: "DEPOSIT", assets: "1", shares: "1", refusal: "BELOW_MINIMUM", availableNow: null } });
    expect(await code(prepareNext(ctx({ d: d(), indexer: refused }), deposit))).toBe("BELOW_MINIMUM: The least a deposit takes is 1 GLDx");
    const indexer = fakeUpstream({ "/intent/partners/vaults?": lists, "/intent/partners/vaults/": { kind: "DEPOSIT", assets: String(5n * E18), shares: String(5n * E18), refusal: null, availableNow: null } });
    expect(await code(prepareNext(ctx({ d: d(), indexer, chain: fakeChain({ vaultAsset: () => Promise.resolve(USDG) }) }), deposit))).toMatch(/^ASSET_CHANGED/);
  });
});

/**
 * After a loss, an 18-decimal vault prices its last holder's whole balance above what it has, by less than a millionth
 * of a token: redeeming every share reverts while the rest pays (the contracts stream, 14 October 2026). The indexer
 * previews as the vault converts: `ASSET_SCALE` virtual assets over 10^12 virtual shares. The vault's book is read on
 * chain, and a withdrawal of everything leaves a raw unit behind the shares that stay (test/redeem.test.ts).
 */
describe("withdrawing everything from an 18-decimal vault after a loss", () => {
  const VIRTUAL = 10n ** 12n, SCALE = 10n ** 12n;
  // Five GLDx came in at the start (10^18 shares a token); 4.2 are left, all of it cash; this wallet is the only holder.
  const book = (supply: bigint, total: bigint) => {
    const toAssets = (n: bigint) => (n * (total + SCALE)) / (supply + VIRTUAL);
    return {
      toAssets,
      onChain: { totalAssets: total, totalSupply: supply, free: total, performing: 0n },
      route: (path: string) => {
        const n = BigInt(new URL(path, "http://indexer.test").searchParams.get("redeem")!);
        const assets = toAssets(n);
        const refusal = assets > total ? "INSUFFICIENT_LIQUIDITY" : null;
        return { status: 200, body: { kind: "REDEEM", assets: String(assets), shares: String(n), refusal, availableNow: refusal ? String(total) : null } };
      },
    };
  };
  const supply = 5n * E18, total = 42n * E18 / 10n;
  const lost = book(supply, total);
  const indexer = () => fakeUpstream({ "/intent/partners/vaults?": lists, "/intent/partners/vaults/": lost.route });
  const chain = () => fakeChain({ vaultShares: () => Promise.resolve(supply), vaultBook: () => Promise.resolve(lost.onChain) });
  const redeemed = (data: `0x${string}`) => decodeFunctionData({ abi: partnerVaultAbi, data }).args[0] as bigint;

  it("is the edge itself: the whole balance asks for more than the vault holds", () => {
    expect(lost.toAssets(supply)).toBeGreaterThan(total);
    expect(lost.toAssets(supply) - total).toBeLessThan(SCALE);
  });

  it("never sends the full balance: all but what leaves a raw unit of GLDx behind the shares that stay", async () => {
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(), chain: chain() }), { action: "earn_redeem", wallet: WALLET, vault: GLD_VAULT });
    const shares = redeemed(p.next!.transaction.data);
    expect(shares).toBeLessThan(supply);
    expect(shares).toBe(redeemableShares(supply, lost.toAssets(supply), { decimals: 18 }, lost.onChain));
    expect(total - lost.toAssets(shares)).toBe(1n);
    expect(p.summary.rows[0]!.value).toMatch(/\(all the vault can pay\)$/);
    expect(p.notes.join(" ")).toMatch(/A millionth of a GLDx at most stays in the vault/);
    expect(p.view).toMatchObject({ action: "earn_redeem", shares: String(shares), all: true, asset: GLD });
    // Naming the whole balance is read the same way; a smaller part is redeemed as asked.
    const named = await prepareNext(ctx({ d: d(), indexer: indexer(), chain: chain() }), { action: "earn_redeem", wallet: WALLET, vault: GLD_VAULT, shares: String(supply) });
    expect(redeemed(named.next!.transaction.data)).toBe(shares);
    const part = await prepareNext(ctx({ d: d(), indexer: indexer(), chain: chain() }), { action: "earn_redeem", wallet: WALLET, vault: GLD_VAULT, shares: String(E18) });
    expect(redeemed(part.next!.transaction.data)).toBe(E18);
  });

  it("never sends it from a signer either", async () => {
    const signer = fakeSigner();
    const r = await run(ctx({ d: d(), indexer: indexer(), chain: chain() }), { action: "earn_redeem", wallet: WALLET, vault: GLD_VAULT }, signer, { sleep: () => Promise.resolve() });
    expect(r.status).toBe("done");
    expect(signer.sent).toHaveLength(1);
    expect(redeemed(signer.sent[0]!.data)).toBeLessThan(supply);
  });

  it("redeems every share where nothing was lost, and in a six-decimal vault always", async () => {
    const whole = book(4n * E18, total);
    const even = fakeUpstream({ "/intent/partners/vaults?": lists, "/intent/partners/vaults/": whole.route });
    const p = await prepareNext(ctx({ d: d(), indexer: even, chain: fakeChain({ vaultShares: () => Promise.resolve(4n * E18), vaultBook: () => Promise.resolve(whole.onChain) }) }),
      { action: "earn_redeem", wallet: WALLET, vault: GLD_VAULT });
    expect(redeemed(p.next!.transaction.data)).toBe(4n * E18);
    expect(p.summary.rows[0]!.value).toMatch(/\(all\)$/);
    expect(redeemableShares(2_000n * E18, 1_036_787_733n, { decimals: 6 })).toBe(2_000n * E18);
  });

  it("says what is left is too small to withdraw once only those last shares are held", async () => {
    const shares = redeemableShares(supply, lost.toAssets(supply), { decimals: 18 }, lost.onChain), kept = supply - shares;
    const rest = book(kept, total - lost.toAssets(shares));
    const left = fakeUpstream({ "/intent/partners/vaults?": lists, "/intent/partners/vaults/": rest.route });
    expect(await code(prepareNext(ctx({ d: d(), indexer: left, chain: fakeChain({ vaultShares: () => Promise.resolve(kept), vaultBook: () => Promise.resolve(rest.onChain) }) }),
      { action: "earn_redeem", wallet: WALLET, vault: GLD_VAULT })))
      .toBe("TOO_SMALL: What is left is too small to withdraw: under a millionth of a GLDx");
  });
});

describe("collecting across generations", () => {
  it("receives GLDx from its core and GLDx earnings from its vault, beside USDG's and never added to them", async () => {
    const indexer = fakeUpstream({
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": lists,
      "/intent/partners/vaults/": (path: string) => ({ status: 200, body: { shares: "0", value: "0", withdrawableNow: "0", rewards: "0", pockets: path.includes(GLD_VAULT)
        ? [{ id: 1, kind: "EARNINGS", token: GLDX, claimable: String(E18 / 10n), private: false }]
        : [{ id: 2, kind: "EARNINGS", token: USDG, claimable: "2000000", private: false }] } }),
    });
    const chain = fakeChain({ cashCredit: (engine: string) => Promise.resolve(engine.toLowerCase() === GLD_CORE ? 3n * E18 / 10n : engine.toLowerCase() === CORE ? 5_000_000n : 0n) });
    const p = await prepareNext(ctx({ d: d(), indexer, chain }), { action: "collect", wallet: WALLET });
    expect(p.summary.rows).toEqual([
      { label: "USDG from loans", value: "5.00 USDG" },
      { label: "GLDx from loans", value: "0.3 GLDx" },
      { label: "Vault earnings", value: "2.00 USDG" },
      { label: "Vault earnings in GLDx", value: "0.1 GLDx" },
    ]);
    expect([p.next!.label, ...p.then]).toEqual(["Receive 5.00 USDG", "Receive 0.3 GLDx", expect.stringMatching(/^Collect from /), expect.stringMatching(/^Collect from /)]);
    expect(p.view).toMatchObject({ action: "collect", usdg: "5000000", earnings: "2000000", others: [{ ...GLD, cash: String(3n * E18 / 10n), earnings: String(E18 / 10n) }] });
  });
});

describe("the reads", () => {
  it("list GLDx among the capabilities, with its core, factory, terms and the rule it brings", async () => {
    const caps = await capabilities(ctx({ d: d() }));
    expect(caps.lendAssets).toEqual([{ token: GLDX, symbol: "GLDx", decimals: 18, stable: false, core: GLD_CORE, factory: GLD_FACTORY, terms: [{ seconds: 604_800, days: 7 }, { seconds: 1_814_400, days: 21 }] }]);
    expect(caps.rules).toContain(LEND_ASSET_RULE);
    const today = await capabilities(ctx());
    expect(today).not.toHaveProperty("lendAssets");
    expect(today.rules).not.toContain(LEND_ASSET_RULE);
    // Mainnet offers no 1-day term (D241), so the rule promises none (D311); the terms each core offers say the rest.
    expect(LEND_ASSET_RULE).not.toMatch(/1-day/);
    // No read or action serves a private loan (D222), and the rules say so.
    for (const rules of [caps.rules, today.rules]) expect(rules).toContain(PRIVATE_RULE);
  });

  it("give one collateral row per asset it is borrowed in, GLDx's from its own registry and never leveraged", async () => {
    const asked: string[] = [];
    const chain = fakeChain({ tokenConfig: (registry: string, token: string) => { asked.push(`${registry}:${token}`); return Promise.resolve({ allowed: true, lane: 1, minAmount: E18, maxDealRaw: 1000n * E18, maxOpenRaw: 0n }); } });
    const rows = (await assets(ctx({ d: d(), chain }))).assets;
    expect(rows.map((r) => [r.symbol, (r as { asset?: { symbol: string } }).asset?.symbol, r.leverage])).toEqual([["NVDAx", "USDG", true], ["SCHIFFYx", "GLDx", false]]);
    expect(asked).toContain(`${GLD_REG}:${SCHIFFY}`);
    expect((await assets(ctx())).assets[0]).not.toHaveProperty("asset");
  });

  it("quote a loan in GLDx from GLDx's core, named in GLDx, with a prepare object that names it", async () => {
    const instant = { schema: "gage-intent-instant-v1", status: "ok", refusal: null, expiresAt: NOW + 30,
      answer: { collateral: String(100n * E18), valueUSDG: String(E18), principal: String(E18 / 2n), cap: "504000000000000000", costBps: 80, ltvBps: 5000, binds: "room", room: "0", vaults: 1 } };
    const rates = fakeUpstream({ "/intent/instant/": instant });
    const q = await borrowQuote(ctx({ d: d(), rates }), { token: SCHIFFY, maxCollateral: String(100n * E18), term: 604_800, lendAsset: GLDX });
    expect(rates.asked[0]).toMatch(new RegExp(`^/intent/instant/${GLD_CORE}\\?`));
    expect(q.summary).toBe("Pledge 100 SCHIFFYx, receive 0.495 GLDx, repay 0.504 GLDx within 7 days");
    expect(q).toMatchObject({ collateralValue: String(E18), asset: GLD, prepare: { action: "borrow", token: SCHIFFY, lendAsset: GLDX } });
    expect(q).not.toHaveProperty("collateralValueUSDG");
  });

  it("read a GLDx loan, a wallet's GLDx holdings and credit, and the GLDx vaults, each named in GLDx", async () => {
    const indexer = fakeUpstream({
      "/v2/positions/": position("4", { engine: GLD_CORE }),
      "/v2/positions?": (path: string) => ({ status: 200, body: { items: path.includes(GLD_CORE) ? [position("4", { engine: GLD_CORE }, { token: SCHIFFY })] : [], nextCursor: null } }),
      "/intent/partners/vaults?": lists,
      "/intent/partners/vaults/": (path: string) => ({ status: 200, body: path.endsWith("/accounting")
        ? { pricing: { totalAssets: String(42n * E18 / 10n), totalSupply: String(5n * E18), assetsPerShare: "840000000000000000" }, liquidity: { free: String(42n * E18 / 10n) } }
        : path.includes(GLD_VAULT) ? { shares: String(5n * E18), value: String(42n * E18 / 10n), withdrawableNow: String(E18), rewards: "0", pockets: [] }
          : { shares: "0", value: "0", withdrawableNow: "0", rewards: "0", pockets: [] } }),
    });
    const chain = fakeChain({ loan: () => Promise.resolve(chainLoan({ token: SCHIFFY })), cashCredit: (engine: string) => Promise.resolve(engine.toLowerCase() === GLD_CORE ? E18 : 0n) });
    const c = ctx({ d: d(), indexer, chain });
    expect(await loan(c, { loanId: "4", engine: GLD_CORE })).toMatchObject({ engine: GLD_CORE, symbol: "SCHIFFYx", asset: GLD });
    const p = await portfolio(c, WALLET);
    expect(p.loans).toEqual([expect.objectContaining({ engine: GLD_CORE, loanId: "4", symbol: "SCHIFFYx", asset: GLD })]);
    expect(p.earn).toEqual([expect.objectContaining({ vault: GLD_VAULT, value: String(42n * E18 / 10n), withdrawableNow: String(E18), asset: GLD })]);
    expect(p.earn[0]).not.toHaveProperty("valueUSDG");
    expect(p).toMatchObject({ usdgCredit: "0", credits: [{ ...GLD, amount: String(E18) }] });
    const v = await earnVaults(c);
    expect(v.vaults.find((x) => x.vault === GLD_VAULT)).toMatchObject({ totalAssets: String(42n * E18 / 10n), freeCash: String(42n * E18 / 10n), assetsPerShare: "840000000000000000", asset: GLD, tokens: ["SCHIFFYx"] });
    expect(v.vaults.find((x) => x.vault === VAULT)).toMatchObject({ asset: { token: USDG, symbol: "USDG", decimals: 6 } });
  });
});
