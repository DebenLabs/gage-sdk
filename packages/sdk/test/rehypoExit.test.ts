/**
 * A rehypo pool's exit now (root D357): an LP whose share of a source is more than it can pay now asks it to commit its
 * vault shares at the exit desk (`GageRehypoSource.exitNow(id)`), the holding listed chosen as gage's app chooses it.
 */
import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { partnerVaultAbi, rehypoSourceAbi } from "../src/abi.js";
import type { ExitAsk, ExitRecord } from "../src/exitChoice.js";
import { MAINNET_MANIFEST } from "../src/deployments/mainnet.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { actionsOn } from "../src/networks.js";
import { prepareNext } from "../src/prepare.js";
import { A, assetManifest, CORE, ctx, fakeChain, fakeUpstream, manifest, NOW, NVDA, USDG, VAULT, WALLET } from "../src/testing.js";

const SOURCE = A(0x160), HOOK = A(0x161), DESK = A(0x162), MARKET = A(0x163);
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof ApiError ? { code: e.code, retryable: e.retryable } : String(e); } };
const row = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true };
/** A loan of the vault, an hour into its week, that earns `interest` over it (the index's accounting row). */
const LOAN = (id: string, interest: string) => ({ id, state: "PERFORMING", principal: "1000000000", interest, maturity: NOW - 3600 + 604_800, start: NOW - 3600 });
/** The vault's accounting: 10,000 shares out, its two loans 5 and 7 earning, as the index answers it at `NOW`. */
const indexer = (settleable: string[] = [], over: Record<string, unknown> = {}) => fakeUpstream({
  "/intent/partners/vaults?": { items: [row], nextCursor: null },
  "/intent/partners/vaults/": {
    pricing: { totalAssets: "10000000000", totalSupply: "10000000000", assetsPerShare: "1" }, liquidity: { free: "1" }, settlement: { due: settleable.length > 0, settleable },
    asOf: NOW, loans: [LOAN("5", "20000000"), LOAN("7", "5000000")], ...over,
  },
});

/** A running holding of 1,000 USDG, an hour into its week, that earns `interest` over it. */
const record = (interest: bigint): ExitRecord => ({
  maturity: NOW - 3600 + 604_800, withdrawn: false, settled: false, principal: 1_000_000_000n, interest, rate: (interest * 10n ** 18n) / 604_800n, clockStart: NOW - 3600,
});
const RECORDS: Record<string, ExitRecord> = { "5": record(20_000_000n), "7": record(5_000_000n), "9": { ...record(4_000_000n), principal: 200_000_000n } };

/** The source's exit at the desk: none unless a test opens one, the desk's request lasting a day. */
const exit = (e: Partial<{ shares: bigint; id: bigint; nonce: bigint; committedAt: number; life: number }> = {}) =>
  () => Promise.resolve({ shares: 0n, id: 0n, nonce: 0n, committedAt: 0, life: 86_400, ...e });
/** The vault's book for `shares` the source commits, each worth one USDG: 1,900 USDG free, 5,000 lent of 10,000. */
const book = (free = 1_900_000_000n, seen: bigint[] = []) => (_vault: unknown, shares: bigint) => {
  seen.push(shares);
  return Promise.resolve({ claim: shares, free, held: free, loans: 5_000_000_000n, supply: 10_000_000_000n });
};

/**
 * The source of 10,000 USDG, 600 of it its float and 1,000 payable now, the wallet holding 30% of the hook's LP shares,
 * so it commits 2,400 USDG of vault shares, of which the vault cannot pay 500 now; the vault's holdings 5 and 7 of
 * about 1,000 USDG each, 7 with less still to earn, both listable.
 */
function chain(over: Record<string, unknown> = {}, source: Record<string, unknown> = {}) {
  return fakeChain({
    rehypoSource: () => Promise.resolve({
      vault: VAULT, earliestMaturity: NOW + 86_400, asset: USDG, depositor: HOOK, totalAssets: 10_000_000_000n, float: 600_000_000n, payableNow: 1_000_000_000n, lpBalance: 30n,
      lpSupply: 100n, hold: 3600, ...source,
    }),
    exitDeskOf: () => Promise.resolve(DESK),
    lenderMarket: () => Promise.resolve(MARKET),
    exitOf: exit(),
    exitOwed: () => Promise.resolve(0n),
    vaultPreviewWithdraw: (_vault: unknown, assets: bigint) => Promise.resolve(assets),
    vaultShares: () => Promise.resolve(9_400_000_000n),
    exitVaultBook: book(),
    exitRecords: () => Promise.resolve([5n, 7n, 7n]),
    exitRecord: (_vault: unknown, id: bigint) => Promise.resolve(RECORDS[id.toString()]!),
    accrualEnd: () => Promise.resolve(BigInt(NOW)),
    saleSlots: () => Promise.resolve(4),
    withinAverage: () => Promise.resolve(true),
    ...over,
  });
}
const input = { action: "rehypo_exit_now", wallet: WALLET, source: SOURCE } as const;
const exitId = (data: `0x${string}`) => decodeFunctionData({ abi: rehypoSourceAbi, data }).args?.[0];

describe("a rehypo pool's exit now", () => {
  it("asks the source to exit through the smallest holding that covers what the vault cannot pay", async () => {
    const p = await prepareNext(ctx({ chain: chain(), indexer: indexer() }), input);
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "Exit now", final: true });
    expect(getAddress(p.next!.transaction.to)).toBe(getAddress(SOURCE));
    expect(decodeFunctionData({ abi: rehypoSourceAbi, data: p.next!.transaction.data }).functionName).toBe("exitNow");
    expect(exitId(p.next!.transaction.data)).toBe(7n);
    expect(p.view).toMatchObject({
      action: "rehypo_exit_now", source: SOURCE, vault: VAULT, loanId: "7", claim: "3000000000", payableNow: "1000000000", need: "500000000", endsAt: NOW + 3600, lapsed: false,
    });
    expect(p.summary.rows.map((r) => r.label)).toEqual(["Your share", "The source can pay now", "Sold for you", "You give up", "Remove within"]);
    expect(p.summary.rows[2]!.value).toBe("Loan #7 of RWA · NVDAx: over ten minutes 500.00 USDG of it falls to book value, the rest keeps 99% of what it has still to earn");
  });

  it("previews what the LP receives and gives up, and its hour, as numbers a partner can draw", async () => {
    const p = await prepareNext(ctx({ chain: chain(), indexer: indexer() }), input);
    expect(p.preview).toMatchObject({
      kind: "exit_now", asset: { symbol: "USDG", decimals: 6, stable: true }, receive: "3000000000", now: "1000000000",
      // As the app's exit sheet counts it: the LP's 30% of the source's 9,400 vault shares, of the 10,000 out, of what
      // the loans have still to earn (19.88 and 4.97 USDG): about 7.00 USDG.
      giveUp: "7008035",
      steps: [
        { at: 0, when: "now", what: "You ask" },
        { at: 600, when: "~10 min", what: "Loan sold" },
        { at: 3600, when: "before 1 h", what: "You remove" },
        { at: 3600, when: "1 h", what: "Exit ends" },
      ],
    });
    // An index that cannot say what a loan has still to earn leaves what is given up unknown, never a guess.
    const old = await prepareNext(ctx({ chain: chain(), indexer: indexer([], { loans: [{ ...LOAN("5", "20000000"), start: undefined }] }) }), input);
    expect(old.preview?.giveUp).toBeNull();
    const none = await prepareNext(ctx({ chain: chain(), indexer: indexer([], { loans: undefined, asOf: undefined }) }), input);
    expect(none.preview?.giveUp).toBeNull();
  });

  it("weighs the source as the leaver (SEC-01, root D391): its committed shares of its vault shares, the holding it carried more of first", async () => {
    const seen: unknown[][] = [];
    const exitShares = (_f: unknown, _v: unknown, ids: readonly bigint[], who: unknown) => {
      seen.push([[...ids], who]);
      // 47 of 100 of loan 5's window, 10 of 7's.
      return Promise.resolve(ids.map((id) => ({ exposure: id === 5n ? 47n : 10n, supply: 100n })));
    };
    const p = await prepareNext(ctx({ chain: chain({ exitShares }), indexer: indexer() }), input);
    expect(exitId(p.next!.transaction.data)).toBe(5n);
    expect(seen).toEqual([[[7n, 5n], SOURCE]]);
    // It commits 2,400 of its 9,400 vault shares: 47 × 2,400 / 9,400 = 12 of loan 5's 100, a stake floor of 8712.
    expect(p.view).toMatchObject({ loanId: "5", need: "500000000", floorBps: 8_712 });
    expect(p.summary.rows[2]!.value).toBe("Loan #5 of RWA · NVDAx: over ten minutes its price falls from book value plus 99% of what it has still to earn to book value plus 87.12% of it. A vault buys only if the price falls far enough for it, so it may not sell");
    // The source is the leaver: the discount comes off its share of the sale's earnings claim, which the LPs who stay own.
    expect(p.summary.rows[3]!.value).toBe("Your share of what the vault's loans have still to earn, if they are repaid: you leave at book value. The buyer's discount on loan #5 comes out of the pool's share of what that loan has still to earn, so the LPs who stay pay it, not you");
    // Share views that answer no exitShare: no floor, and the earlier words.
    expect((await prepareNext(ctx({ chain: chain(), indexer: indexer() }), input)).view).toMatchObject({ loanId: "7", floorBps: null });
  });

  it("sizes the holding to the need: the smallest whose book covers it, else the largest", async () => {
    const go = async (free: bigint) => exitId((await prepareNext(ctx({ chain: chain({ exitRecords: () => Promise.resolve([5n, 7n, 9n]), exitVaultBook: book(free) }), indexer: indexer() }), input)).next!.transaction.data);
    // 150 USDG short: the 200 USDG holding covers it, though it has the most still to earn per unit of book value.
    expect(await go(2_250_000_000n)).toBe(9n);
    // 500 short: 9 is too small, and 7 is the smaller of the two that cover it.
    expect(await go(1_900_000_000n)).toBe(7n);
    // 1,200 short (the commitment's part of the vault's loans): none covers it, so the largest, 5, which has earned more.
    expect(await go(0n)).toBe(5n);
  });

  it("weighs what the source commits: the larger of its open commitment and this LP's need, never their sum, at most the shares it holds", async () => {
    const seen: bigint[] = [];
    // The open commitment of 3,000 USDG of shares is larger than this LP's 2,400: it stands, short 1,100, and none covers that.
    const open = await prepareNext(ctx({ chain: chain({ exitOf: exit({ shares: 3_000_000_000n, id: 5n }), exitVaultBook: book(undefined, seen) }), indexer: indexer() }), input);
    expect(seen).toEqual([3_000_000_000n]);
    expect(open.view).toMatchObject({ loanId: "5", need: "1100000000" });
    // A need beyond the holding sells all of it to book.
    expect(open.summary.rows[2]!.value).toBe("Loan #5 of RWA · NVDAx: over ten minutes all of it falls to book value");
    // A source holding 1,000 USDG of shares commits no more: short 500 of them rather than 1,200 of 2,400.
    const held = await prepareNext(ctx({ chain: chain({ vaultShares: () => Promise.resolve(1_000_000_000n), exitVaultBook: book(500_000_000n) }), indexer: indexer() }), input);
    expect(held.view).toMatchObject({ loanId: "7", need: "500000000" });
  });

  it("refuses while the vault's free cash covers what the source would commit: the desk lists nothing then", async () => {
    const covered = chain({ vaultShares: () => Promise.resolve(1_000_000_000n) });
    expect(await refusal(prepareNext(ctx({ chain: covered, indexer: indexer() }), input))).toEqual({ code: "NO_SHORTFALL", retryable: true });
  });

  it("gives the LP the source's hold to remove in, and renews a request the desk let lapse while its listing lives", async () => {
    // The source holds what a sale pays for its LPs `EXIT_HOLD` after the ask; then gage's keeper ends the exit
    // (`endExit`), long before the desk's own day (`EXIT_LIFE`) would drop it.
    const hour = await prepareNext(ctx({ chain: chain({ exitOf: exit({ life: 86_400 }) }), indexer: indexer() }), input);
    expect(hour.view).toMatchObject({ endsAt: NOW + 3600, lapsed: false });
    expect(hour.summary.rows[4]!.value).toBe("1 hour of asking: then gage's keeper ends the exit, and you ask again if you still need to");
    const two = await prepareNext(ctx({ chain: chain({}, { hold: 7200 }), indexer: indexer() }), input);
    expect(two.view).toMatchObject({ endsAt: NOW + 7200 });
    expect(two.summary.rows[4]!.value).toMatch(/^2 hours of asking:/);
    // Its listing lives on, but the desk sells nothing for a request past its life: this ask commits again.
    const ask: ExitAsk = { listedAt: NOW - 100, deadline: NOW + 560, nonce: 3n, exit: true };
    const lapsed = chain({ exitOf: exit({ shares: 1n, id: 5n, nonce: 3n, committedAt: NOW - 7200, life: 7200 }), exitAsk: () => Promise.resolve(ask) });
    const renewed = await prepareNext(ctx({ chain: lapsed, indexer: indexer() }), input);
    expect(exitId(renewed.next!.transaction.data)).toBe(0n);
    expect(renewed.view).toMatchObject({ loanId: null, need: null, lapsed: true });
    expect(renewed.summary.rows[2]!.value).toBe("Through the source's exit listing already open, whose request had lapsed: this renews it");
  });

  it("passes over a holding the desk would refuse: above the vault's average, nothing left to sell, or ending before the listing", async () => {
    const above = await prepareNext(ctx({ chain: chain({ withinAverage: (_d: unknown, _v: unknown, id: bigint) => Promise.resolve(id !== 7n) }), indexer: indexer() }), input);
    expect(exitId(above.next!.transaction.data)).toBe(5n);
    const sold = await prepareNext(ctx({ chain: chain({ saleSlots: (_v: unknown, id: bigint) => Promise.resolve(id === 7n ? 0 : 4) }), indexer: indexer() }), input);
    expect(exitId(sold.next!.transaction.data)).toBe(5n);
    // The listing stands 11 minutes, and the wallet's confirmation five more: a loan ending sooner is not listed.
    const ending = await refusal(prepareNext(ctx({ chain: chain({ loan: () => Promise.resolve({ state: 2, term: 3600 + 900, fundedAt: NOW - 3600 }) }), indexer: indexer() }), input));
    expect(ending).toEqual({ code: "NO_LOAN_TO_LIST", retryable: true });
  });

  it("lists nothing while the source's own exit listing is live: its commitment rises and the listing goes on", async () => {
    const ask: ExitAsk = { listedAt: NOW - 100, deadline: NOW + 560, nonce: 3n, exit: true };
    const live = chain({ exitOf: exit({ shares: 1n, id: 5n, nonce: 3n, committedAt: NOW - 100 }), exitAsk: () => Promise.resolve(ask) });
    const p = await prepareNext(ctx({ chain: live, indexer: indexer() }), input);
    expect(exitId(p.next!.transaction.data)).toBe(0n);
    expect(p.view).toMatchObject({ loanId: null, need: null, lapsed: false });
    // Once it ended, the next holding is listed.
    const ended = chain({ exitOf: exit({ shares: 1n, id: 5n, nonce: 3n, committedAt: NOW - 700 }), exitAsk: () => Promise.resolve({ ...ask, deadline: NOW }) });
    expect(exitId((await prepareNext(ctx({ chain: ended, indexer: indexer() }), input)).next!.transaction.data)).toBe(7n);
  });

  it("settles the vault first while a loan of it is past its end and not booked", async () => {
    const p = await prepareNext(ctx({ chain: chain({}, { earliestMaturity: NOW - 1, payableNow: 0n }), indexer: indexer(["3"]) }), input);
    expect(p.next).toMatchObject({ label: "Settle the vault's loans", final: false });
    expect(p.again).toBe(true);
  });

  it("settles first what the desk waits on before an ask that lists (r13d), and nothing for one that lists none", async () => {
    const pending = () => Promise.resolve([3n, 4n]);
    const p = await prepareNext(ctx({ chain: chain({ pendingSettlements: pending }), indexer: indexer() }), input);
    expect(p.next).toMatchObject({ label: "Settle the vault's loans", final: false });
    expect(getAddress(p.next!.transaction.to)).toBe(getAddress(VAULT));
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "settle", args: [[3n, 4n]] });
    expect(p.again).toBe(true);
    expect(p.view).toMatchObject({ action: "rehypo_exit_now", loanId: null, need: null });
    // While the source's own exit listing is live the ask lists nothing, so the desk refuses nothing.
    const ask: ExitAsk = { listedAt: NOW - 100, deadline: NOW + 560, nonce: 3n, exit: true };
    const live = chain({ pendingSettlements: pending, exitOf: exit({ shares: 1n, id: 5n, nonce: 3n, committedAt: NOW - 100 }), exitAsk: () => Promise.resolve(ask) });
    expect(exitId((await prepareNext(ctx({ chain: live, indexer: indexer() }), input)).next!.transaction.data)).toBe(0n);
  });

  it("refuses what it cannot do, in fixed words", async () => {
    const go = (c: ReturnType<typeof chain>) => refusal(prepareNext(ctx({ chain: c, indexer: indexer() }), input));
    expect(await go(chain({}, { payableNow: 3_000_000_000n }))).toEqual({ code: "NOTHING_TO_EXIT", retryable: false });
    expect(await go(chain({}, { lpBalance: 0n }))).toEqual({ code: "NOTHING_TO_EXIT", retryable: false });
    expect(await go(chain({ exitDeskOf: () => Promise.resolve(null) }))).toEqual({ code: "EXITS_CLOSED", retryable: false });
    expect(await go(chain({ rehypoSource: () => Promise.resolve(null) }))).toEqual({ code: "NOT_A_REHYPO_SOURCE", retryable: false });
    expect(await go(chain({}, { asset: NVDA }))).toEqual({ code: "NOT_A_REHYPO_SOURCE", retryable: false });
    expect(await go(chain({ isVault: () => Promise.resolve(false) }))).toEqual({ code: "UNKNOWN_VAULT", retryable: false });
    expect(await go(chain({ withinAverage: () => Promise.resolve(false) }))).toEqual({ code: "NO_LOAN_TO_LIST", retryable: true });
  });
});

describe("where a rehypo pool's exit now is served", () => {
  it("only where a current generation names its exit desk", () => {
    expect(actionsOn(parseDeployment(manifest()))).not.toContain("rehypo_exit_now");
    const usdg = parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, exitDesk: DESK } });
    expect(usdg.generations[0]!.exitDesk).toBe(getAddress(DESK));
    expect(actionsOn(usdg)).toContain("rehypo_exit_now");
    const m = assetManifest();
    const asset = parseDeployment({ ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, exitDesk: DESK } } });
    expect(asset.generations.map((g) => g.exitDesk)).toEqual([null, getAddress(DESK)]);
    expect(actionsOn(asset)).toContain("rehypo_exit_now");
  });

  it("on a bundled network once its release names a desk: the testnet's from r13, not yet mainnet's", () => {
    for (const m of [MAINNET_MANIFEST, TESTNET_MANIFEST]) {
      const d = parseDeployment(m);
      expect(actionsOn(d).includes("rehypo_exit_now"), String(d.chainId)).toBe(d.generations.some((g) => g.exitDesk !== null));
    }
  });
});
