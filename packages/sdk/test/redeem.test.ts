/**
 * Withdrawing everything never leaves shares out with nothing behind them. Shares out with a zero `totalAssets()` make a
 * partner vault refuse every deposit and redemption after (`IntentVault._requireHealthy`, `Impaired`): the r9 e2e of
 * 15 October 2026, where Max paid the NVDAx vault's only holder every raw unit and left 1,798,642,962 shares. Sized on
 * the vault's own book at its own conversion (`convertToAssets`: `ASSET_SCALE` virtual assets over 10^12 virtual shares,
 * rounded down), as the app sizes it (web/src/intent/partners/figures.ts): its only holder redeems every share when
 * nothing is lent and the free cash pays them all; otherwise the most the free cash pays that leaves a raw unit behind.
 */
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { partnerVaultAbi } from "../src/abi.js";
import type { VaultBook } from "../src/chain.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { redeemableShares } from "../src/plans.js";
import { prepareNext } from "../src/prepare.js";
import { A, assetManifest, CORE, ctx, fakeChain, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_VAULT, GLDX, VAULT, WALLET } from "../src/testing.js";

const E18 = 10n ** 18n;
const VIRTUAL = 10n ** 12n;
const scaleOf = (decimals: number) => 10n ** BigInt(decimals - 6);
const toAssets = (book: VaultBook, shares: bigint, decimals: number) => (shares * (book.totalAssets + scaleOf(decimals))) / (book.totalSupply + VIRTUAL);

/**
 * A redemption as the vault runs it (`IntentVault.redeem`): the whole supply is refused while a loan is out
 * (`OutstandingLoans`), a payment beyond the free cash is refused (`InsufficientLiquidity`), and otherwise it pays
 * `convertToAssets`. What it leaves is healthy with no share out, or with something behind them.
 */
function redeemOnChain(book: VaultBook, shares: bigint, decimals: number) {
  if (shares === book.totalSupply && book.performing !== 0n) return null;
  const paid = toAssets(book, shares, decimals);
  if (paid > book.free) return null;
  return { paid, totalAssets: book.totalAssets - paid, totalSupply: book.totalSupply - shares };
}
const healthy = (after: { totalAssets: bigint; totalSupply: bigint }) => after.totalSupply === 0n || after.totalAssets > 0n;
const sized = (held: bigint, book: VaultBook, decimals: number) => redeemableShares(held, toAssets(book, held, decimals), { decimals }, book);

/** The r9 e2e's book, read on the testnet at block 135,337,002: NVDAx vault 0xe374…d591, wallet B its only holder. */
const E2E: VaultBook = { totalAssets: 1_996_409_170_896_825_396n, totalSupply: 2n * E18, free: 1_996_409_170_896_825_396n, performing: 0n };

describe("what withdrawing everything redeems, on the vault's book", () => {
  it("never leaves shares out with nothing behind them: the r9 e2e's NVDAx vault and its only holder", () => {
    expect(healthy(redeemOnChain(E2E, 1_999_999_998_201_357_038n, 18)!)).toBe(false);
    expect(redeemOnChain(E2E, E2E.totalSupply, 18)).toBeNull();
    const shares = sized(E2E.totalSupply, E2E, 18);
    expect(shares).toBe(1_999_999_998_201_357_037n);
    expect(redeemOnChain(E2E, shares, 18)).toMatchObject({ totalAssets: 1n, totalSupply: 1_798_642_963n });
  });

  it("redeems every share from its only holder whenever the vault can pay them all: no loss, and six decimals after one", () => {
    for (const [decimals, supply, assets] of [
      [18, 4n * E18, 42n * E18 / 10n], [18, 2n * E18, 2n * E18], [6, 2_000n * E18, 2_036_787_733n], [6, 2_000n * E18, 1_036_787_733n],
    ] as const) {
      const book = { totalAssets: assets, totalSupply: supply, free: assets, performing: 0n };
      expect(sized(supply, book, decimals)).toBe(supply);
      expect(redeemOnChain(book, supply, decimals)).toMatchObject({ totalSupply: 0n });
    }
  });

  // Someone kept 1,000 shares, and half the vault was lost: at six decimals the rest's whole balance converts to exactly
  // the cash left, so redeeming all of it would leave those 1,000 shares with nothing behind them.
  it("leaves a raw unit behind other holders' leftover shares: the last real holder after a loss, at six and 18 decimals", () => {
    for (const decimals of [6, 18]) {
      const supply = 200n * E18, assets = 100n * 10n ** BigInt(decimals), mine = supply - 1_000n;
      const book = { totalAssets: assets, totalSupply: supply, free: assets, performing: 0n };
      if (decimals === 6) expect(healthy(redeemOnChain(book, mine, 6)!)).toBe(false);
      const after = redeemOnChain(book, sized(mine, book, decimals), decimals);
      expect(after).not.toBeNull();
      expect(healthy(after!)).toBe(true);
    }
  });

  it("is paid on chain and leaves the vault healthy at 6, 7, 12 and 18 decimals, after gains and losses, alone or not, lent or not", () => {
    for (const decimals of [6, 7, 12, 18]) {
      const unit = 10n ** BigInt(decimals);
      for (const leftPerMille of [1500n, 1000n, 999n, 998n, 963n, 500n, 1n]) {
        for (const others of [0n, 1n, 1_000n, 10n ** 12n, 3n * E18]) {
          for (const [lent, illiquid] of [[0n, 0n], [300n, 0n], [0n, 300n]] as const) {
            const mine = 2n * E18, supply = mine + others;
            // Everyone came in at the start (10^18 shares a whole unit), then the vault gained or lost.
            const assets = (supply * unit * leftPerMille) / (1000n * E18);
            const performing = (assets * lent) / 1000n;
            const book = { totalAssets: assets, totalSupply: supply, free: assets - performing - (assets * illiquid) / 1000n, performing };
            const shares = sized(mine, book, decimals);
            const what = `${decimals} decimals, ${leftPerMille}‰ left, ${others} other shares, ${lent}‰ lent, ${illiquid}‰ illiquid`;
            if (shares === 0n) continue;
            const after = redeemOnChain(book, shares, decimals);
            expect(after, what).not.toBeNull();
            expect(healthy(after!), what).toBe(true);
            // Its only holder is never kept from what the vault could pay and stay healthy.
            if (others === 0n && shares < supply) {
              const more = redeemOnChain(book, shares + 1n, decimals);
              expect(more === null || !healthy(more), what).toBe(true);
            }
          }
        }
      }
    }
  });

  it("keeps the rule for whoever turns out last without a book", () => {
    const supply = 5n * E18, assets = 42n * E18 / 10n;
    const book = { totalAssets: assets, totalSupply: supply, free: assets, performing: 0n };
    const mine = 3n * E18, value = toAssets(book, mine, 18);
    expect(redeemableShares(mine, value, { decimals: 18 }, book)).toBe(redeemableShares(mine, value, { decimals: 18 }));
    expect(redeemableShares(mine, value, { decimals: 18 })).toBeLessThan(mine);
  });
});

/** gage-sdk's `earn_redeem`, as the hosted agent service runs it: the vault's book read on chain, the preview from the indexer. */
describe("earn_redeem", () => {
  const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? `${e.code}: ${e.message}` : String(e); } };
  const d = () => parseDeployment(assetManifest());
  const vault = (address: string, core: string) => ({ address, creator: A(1), curator: A(1), core, categoryMask: 6, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [A(0x13)], fundingEnabled: true });
  /** The indexer: each generation's vault list, and a redemption previewed as the vault would answer it on `book`. */
  const indexer = (book: VaultBook, decimals: number) => fakeUpstream({
    "/intent/partners/vaults?": (path: string) => ({ status: 200, body: { items: [path.includes(`factory=${GLD_FACTORY}`) ? vault(GLD_VAULT, GLD_CORE) : vault(VAULT, CORE)], nextCursor: null } }),
    "/intent/partners/vaults/": (path: string) => {
      const n = BigInt(new URL(path, "http://indexer.test").searchParams.get("redeem")!);
      const assets = toAssets(book, n, decimals);
      const refusal = n === book.totalSupply && book.performing !== 0n ? "OUTSTANDING_LOANS" : assets > book.free ? "INSUFFICIENT_LIQUIDITY" : null;
      return { status: 200, body: { kind: "REDEEM", assets: String(assets), shares: String(n), refusal, availableNow: refusal === "INSUFFICIENT_LIQUIDITY" ? String(book.free) : null } };
    },
  });
  const chain = (book: VaultBook, held: bigint) => fakeChain({ vaultShares: () => Promise.resolve(held), vaultBook: () => Promise.resolve(book) });
  const redeem = async (book: VaultBook, held: bigint, decimals: number, over: { vault?: string; shares?: bigint } = {}) => {
    const p = await prepareNext(ctx({ d: d(), indexer: indexer(book, decimals), chain: chain(book, held) }),
      { action: "earn_redeem", wallet: WALLET, vault: over.vault ?? (decimals === 18 ? GLD_VAULT : VAULT), ...(over.shares === undefined ? {} : { shares: String(over.shares) }) });
    return { p, shares: decodeFunctionData({ abi: partnerVaultAbi, data: p.next!.transaction.data }).args[0] as bigint };
  };

  it("leaves the r9 e2e's vault a raw unit behind its last shares, and says what stays", async () => {
    const { p, shares } = await redeem(E2E, E2E.totalSupply, 18);
    expect(shares).toBe(1_999_999_998_201_357_037n);
    expect(healthy(redeemOnChain(E2E, shares, 18)!)).toBe(true);
    expect(p.summary.rows[0]!.value).toMatch(/\(all the vault can pay\)$/);
    expect(p.notes.join(" ")).toMatch(/A millionth of a GLDx at most stays in the vault/);
    expect(p.view).toMatchObject({ action: "earn_redeem", shares: String(shares), all: true, asset: { token: GLDX } });
  });

  it("redeems every share of a vault that lost nothing, from its only holder", async () => {
    const book = { totalAssets: 42n * E18 / 10n, totalSupply: 4n * E18, free: 42n * E18 / 10n, performing: 0n };
    const { p, shares } = await redeem(book, book.totalSupply, 18);
    expect(shares).toBe(book.totalSupply);
    expect(p.summary.rows[0]!.value).toMatch(/\(all\)$/);
    expect(p.notes).toEqual([]);
  });

  it("keeps a raw unit behind someone's leftover shares in a USDG vault after a loss", async () => {
    const book = { totalAssets: 100_000_000n, totalSupply: 200n * E18, free: 100_000_000n, performing: 0n };
    const held = book.totalSupply - 1_000n;
    const { shares } = await redeem(book, held, 6);
    expect(shares).toBeLessThan(held);
    expect(healthy(redeemOnChain(book, shares, 6)!)).toBe(true);
  });

  it("takes from its only holder what the free cash pays while a loan is out, never the last share", async () => {
    for (const decimals of [6, 18]) {
      const unit = 10n ** BigInt(decimals);
      const book = { totalAssets: 5n * unit, totalSupply: 5n * E18, free: 2n * unit, performing: 3n * unit };
      const { p, shares } = await redeem(book, book.totalSupply, decimals);
      expect(shares).toBeLessThan(book.totalSupply);
      expect(redeemOnChain(book, shares, decimals)!.totalAssets).toBeGreaterThanOrEqual(3n * unit);
      expect(p.notes.join(" ")).toMatch(/stays in the vault until it has the (USDG|GLDx) free to pay it/);
    }
  });

  it("cuts a part asked for that would leave the shares that stay with nothing behind them", async () => {
    // A USDG vault after half was lost, this wallet its only holder: every share but ten converts to the whole cash.
    const book = { totalAssets: 1_000_000n, totalSupply: 2n * E18, free: 1_000_000n, performing: 0n };
    expect(healthy(redeemOnChain(book, book.totalSupply - 10n, 6)!)).toBe(false);
    const { shares } = await redeem(book, book.totalSupply, 6, { shares: book.totalSupply - 10n });
    expect(shares).toBeLessThan(book.totalSupply - 10n);
    expect(healthy(redeemOnChain(book, shares, 6)!)).toBe(true);
    // A part that keeps the vault whole is sent as asked.
    expect((await redeem(book, book.totalSupply, 6, { shares: E18 })).shares).toBe(E18);
  });

  it("says what is left is too small to withdraw once only those last shares are held", async () => {
    const left = { totalAssets: 1n, totalSupply: 1_798_642_963n, free: 1n, performing: 0n };
    expect(await code(prepareNext(ctx({ d: d(), indexer: indexer(left, 18), chain: chain(left, left.totalSupply) }), { action: "earn_redeem", wallet: WALLET, vault: GLD_VAULT })))
      .toBe("TOO_SMALL: What is left is too small to withdraw: under a millionth of a GLDx");
  });
});
