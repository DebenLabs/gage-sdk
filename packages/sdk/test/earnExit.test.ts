/**
 * A partner-vault holder's exit now (Intent D57), as gage's app offers it (web/src/intent/partners/ExitNow.tsx): a holder
 * whose balance is more than the vault can pay now commits its shares at the chain's exit desk, which lists the holding
 * the app would list; the open exit's next listing, its cancel, and what its sales paid, collected from the desk.
 */
import { decodeFunctionData, erc20Abi, getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { exitDeskAbi, partnerVaultAbi } from "../src/abi.js";
import { MAINNET_MANIFEST } from "../src/deployments/mainnet.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { soldFor } from "../src/earnExit.js";
import { exitFit, exitFloor, exitNeedFloor, exitPosition, type ExitAsk, type ExitRecord } from "../src/exitChoice.js";
import { actionsOn } from "../src/networks.js";
import { plan } from "../src/plans.js";
import { prepareNext } from "../src/prepare.js";
import { portfolio } from "../src/reads.js";
import { A, assetManifest, CORE, ctx, fakeChain, fakeUpstream, GLDX, manifest, NOW, NVDA, USDG, VAULT, WALLET } from "../src/testing.js";

const DESK = A(0x162), MARKET = A(0x163);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const E18 = 10n ** 18n;
/** USDG, raw. */
const usd = (n: number) => BigInt(n) * 1_000_000n;
/** The wallet's shares, worth 3,000 USDG: one raw unit of USDG starts at 10^12 shares. */
const HELD = 3_000n * E18;
const EXITS = ["earn_exit_now", "earn_exit_list", "earn_exit_cancel", "earn_exit_collect"] as const;
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof ApiError ? { code: e.code, retryable: e.retryable } : String(e); } };

/** The fixture manifest, its USDG generation naming the chain's exit desk. */
const d = () => parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, exitDesk: DESK } });
const row = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true };
/** A loan of the vault, an hour into its week, that earns `interest` over it (the index's accounting row). */
const LOAN = (id: string, interest: string) => ({ id, state: "PERFORMING", principal: "1000000000", interest, maturity: NOW - 3600 + 604_800, start: NOW - 3600 });
/**
 * gage's index: the vault (`over` its row), its accounting (10,000 USDG of shares out, its loans 5 and 7 earning) and the
 * wallet's position in it (the 3,000 USDG it holds).
 */
function indexer(over: Record<string, unknown> = {}, settleable: string[] = []) {
  return fakeUpstream({
    "/v2/positions?": { items: [], nextCursor: null },
    "/intent/partners/vaults?": { items: [{ ...row, ...over }], nextCursor: null },
    "/intent/partners/vaults/": (path: string) => ({
      status: 200,
      body: path.endsWith("/accounting")
        ? {
          pricing: { totalAssets: "10000000000", totalSupply: String(10_000n * E18), assetsPerShare: "1" }, liquidity: { free: "2250000000" },
          settlement: { due: settleable.length > 0, settleable }, asOf: NOW, loans: [LOAN("5", "20000000"), LOAN("7", "5000000")],
        }
        : { shares: String(HELD), value: "3000000000", withdrawableNow: "2250000000", rewards: "0", pockets: [] },
    }),
  });
}

/** A running holding of 1,000 USDG, an hour into its week, that earns `interest` over it. */
const record = (interest: bigint): ExitRecord => ({
  maturity: NOW - 3600 + 604_800, withdrawn: false, settled: false, principal: 1_000_000_000n, interest, rate: (interest * E18) / 604_800n, clockStart: NOW - 3600,
});
/** Holdings 5 and 7 of about 1,000 USDG each, 7 with less still to earn, and 9 of 200 USDG. */
const RECORDS: Record<string, ExitRecord> = { "5": record(20_000_000n), "7": record(5_000_000n), "9": { ...record(4_000_000n), principal: 200_000_000n } };
/** Another holder, whose exit a listing of the desk may serve. */
const OTHER = A(0x164);
/** The desk's record of holding `id`'s last exit listing: `OTHER`'s exit at `nonce`, none for the other holdings. */
const theirsAt = (id: bigint, nonce: bigint, owner: Address = OTHER) => (_d: unknown, _v: unknown, x: bigint) =>
  Promise.resolve(x === id ? { owner, nonce } : { owner: zeroAddress, nonce: 0n });
/** What the vault cannot pay of `OTHER`'s exit; the wallet's own is the open exit's `short`, none here. */
const shortOf = (theirs: bigint) => (_d: unknown, _v: unknown, owner: Address) => Promise.resolve(owner === OTHER ? theirs : 0n);
/** Where the desk stops a listing of holding `id` for `OTHER`'s exit (`floorOf`, SEC-01). */
const floorsOf = (theirs: number) => (_d: unknown, _v: unknown, _id: bigint, owner: Address) => Promise.resolve(owner === OTHER ? theirs : 9_900);
/** This wallet's floor on holding 7 for an exit short by 750 USDG: the need's, 9900 of the book beyond it (no stake here). */
const MINE_AT_7 = exitNeedFloor(usd(750), exitPosition(7n, RECORDS["7"]!, BigInt(NOW))!.book);
/** The wallet's exit at the desk: none unless a test opens one, a request lasting a day. */
const exit = (e: Partial<{ shares: bigint; id: bigint; nonce: bigint; committedAt: number; life: number }> = {}) =>
  () => Promise.resolve({ shares: 0n, id: 0n, nonce: 0n, committedAt: 0, life: 86_400, ...e });
/** The vault's book for `shares` committed, each 10^12 a raw unit of USDG: 2,250 USDG free, 5,000 lent of 10,000. */
const book = (free = usd(2_250)) => (_vault: unknown, shares: bigint) => Promise.resolve({ claim: shares / 10n ** 12n, free, held: free, loans: usd(5_000), supply: 10_000n * E18 });

/**
 * The chain: the factory names the desk and bound it; the wallet holds 3,000 USDG of the vault's shares, of which the
 * vault can pay 2,250 now, so an exit of all of it is 750 short; holdings 5, 7 and 9 listable.
 */
function chain(over: Record<string, unknown> = {}) {
  return fakeChain({
    exitDeskOf: () => Promise.resolve(DESK),
    boundExitDeskOf: () => Promise.resolve(DESK),
    lenderMarket: () => Promise.resolve(MARKET),
    exitOf: exit(),
    vaultShares: () => Promise.resolve(HELD),
    vaultMaxWithdraw: () => Promise.resolve(usd(2_250)),
    earliestMaturity: () => Promise.resolve(NOW + 86_400),
    exitVaultBook: book(),
    exitRecords: () => Promise.resolve([5n, 7n, 9n]),
    exitRecord: (_vault: unknown, id: bigint) => Promise.resolve(RECORDS[id.toString()]!),
    accrualEnd: () => Promise.resolve(BigInt(NOW)),
    saleSlots: () => Promise.resolve(4),
    withinAverage: () => Promise.resolve(true),
    ...over,
  });
}
const approved = (over: Record<string, unknown> = {}) => chain({ allowance: () => Promise.resolve(HELD), ...over });
const now = (over: Record<string, unknown> = {}) => ({ action: "earn_exit_now", wallet: WALLET, vault: VAULT, ...over }) as const;
const desk = (data: `0x${string}`) => decodeFunctionData({ abi: exitDeskAbi, data });
/** Forty records of the vault the desk waits on (r13d): it lists nothing until they are booked. */
const WAITING = Array.from({ length: 40 }, (_, i) => BigInt(100 + i));
const waiting = () => Promise.resolve(WAITING);
/** Each step of a plan, as the vault calls it settles: the ids it books, in order. */
const settled = async (p: Awaited<ReturnType<typeof plan>>) => Promise.all(p.steps.map(async (s) => {
  const call = decodeFunctionData({ abi: partnerVaultAbi, data: (await s.build()).data });
  expect(call.functionName).toBe("settle");
  return call.args?.[0];
}));

describe("a partner vault's exit now", () => {
  it("approves the desk for exactly the wallet's shares, then commits them and lists the smallest holding that covers what the vault cannot pay", async () => {
    const first = await prepareNext(ctx({ d: d(), chain: chain(), indexer: indexer() }), now());
    expect(first.status).toBe("approval_required");
    expect(getAddress(first.next!.transaction.to)).toBe(getAddress(VAULT));
    expect(decodeFunctionData({ abi: erc20Abi, data: first.next!.transaction.data }).args).toEqual([getAddress(DESK), HELD]);
    expect(first.then).toEqual(["Exit now"]);
    const p = await prepareNext(ctx({ d: d(), chain: approved(), indexer: indexer() }), now());
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "Exit now", final: true });
    expect(getAddress(p.next!.transaction.to)).toBe(getAddress(DESK));
    const call = desk(p.next!.transaction.data);
    expect(call.functionName).toBe("exitNow");
    // 750 USDG short: 7 is the smaller of the two holdings that cover it; 9 is too small.
    expect(call.args).toEqual([getAddress(VAULT), HELD, 7n]);
    expect(p.view).toMatchObject({
      action: "earn_exit_now", vault: VAULT, name: "RWA · NVDAx", shares: String(HELD), assets: "3000000000", all: true, payableNow: "2250000000", loanId: "7",
      need: "750000000", lapsesAt: NOW + 86_400, lapsed: false,
    });
    expect(p.summary.rows.map((r) => r.label)).toEqual(["You receive", "The vault can pay now", "Sold for you", "You give up", "Your request lasts"]);
    expect(p.summary.rows[0]!.value).toBe("3,000.00 USDG (all)");
    expect(p.summary.rows[2]!.value).toBe("Loan #7 of RWA · NVDAx: over ten minutes 750.00 USDG of it falls to book value, the rest keeps 99% of what it has still to earn");
    expect(p.summary.rows[4]!.value).toBe("24 hours: then nothing is listed or paid for it, and you exit again to go on");
  });

  it("takes an amount in the vault's asset, as the app's sheet does: the shares worth it, and the holding sized to what they need", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: approved(), indexer: indexer() }), now({ amount: String(usd(2_400)) }));
    // 2,400 USDG of the 3,000: 150 short, which the 200 USDG holding covers.
    expect(desk(p.next!.transaction.data).args).toEqual([getAddress(VAULT), 2_400n * E18, 9n]);
    expect(p.view).toMatchObject({ shares: String(2_400n * E18), assets: "2400000000", all: false, loanId: "9", need: "150000000" });
    expect(p.summary.rows[0]!.value).toBe("2,400.00 USDG");
    // With no free cash none covers the 1,500 the vault cannot pay of it all, so the largest, 5, sells whole to book.
    const none = await prepareNext(ctx({ d: d(), chain: approved({ vaultMaxWithdraw: () => Promise.resolve(0n), exitVaultBook: book(0n) }), indexer: indexer() }), now());
    expect(desk(none.next!.transaction.data).args?.[2]).toBe(5n);
    expect(none.summary.rows[2]!.value).toBe("Loan #5 of RWA · NVDAx: over ten minutes all of it falls to book value");
  });

  it("previews what the wallet receives, what the vault can pay now, what it gives up and the desk's day, as numbers a partner can draw", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: approved(), indexer: indexer() }), now());
    expect(p.preview).toEqual({
      kind: "exit_now", asset: { token: USDG, symbol: "USDG", decimals: 6, stable: true }, receive: "3000000000", now: "2250000000",
      // As the app's sheet counts it: 30% of the shares, of what the loans have still to earn (19.88 and 4.97 USDG).
      giveUp: "7455357",
      steps: [
        { at: 0, when: "now", what: "You ask" },
        { at: 600, when: "~10 min", what: "Loan sold" },
        { at: 600, when: "any time", what: "You collect" },
        { at: 86_400, when: "24 h", what: "Request ends" },
      ],
    });
    expect(p.summary.rows[3]!.value).toBe("About 7.45 USDG: your share of what the vault's loans have still to earn, if they are repaid");
    // The request lasts as long as the desk says (`EXIT_LIFE`).
    const two = await prepareNext(ctx({ d: d(), chain: approved({ exitOf: exit({ life: 7200 }) }), indexer: indexer() }), now());
    expect(two.preview?.steps[3]).toEqual({ at: 7200, when: "2 h", what: "Request ends" });
    expect(two.view).toMatchObject({ lapsesAt: NOW + 7200 });
    // An index that cannot say what the loans have still to earn leaves it unknown, never a guess.
    const old = await prepareNext(ctx({ d: d(), chain: approved(), indexer: fakeUpstream({ ...indexerRoutes(), "/intent/partners/vaults/": accountingWithout() }) }), now());
    expect(old.preview?.giveUp).toBeNull();
  });

  it("refuses what the vault can pay now, a withdrawal and not an exit, as the app says", async () => {
    const go = (c: ReturnType<typeof chain>, amount?: bigint) => refusal(prepareNext(ctx({ d: d(), chain: c, indexer: indexer() }), now(amount === undefined ? {} : { amount: String(amount) })));
    expect(await go(chain(), usd(2_000))).toEqual({ code: "NOTHING_TO_EXIT", retryable: false });
    expect(await go(chain({ vaultMaxWithdraw: () => Promise.resolve(usd(3_000)) }))).toEqual({ code: "NOTHING_TO_EXIT", retryable: false });
    const words = await prepareNext(ctx({ d: d(), chain: chain(), indexer: indexer() }), now({ amount: String(usd(2_000)) })).catch((e: Error) => e.message);
    expect(words).toBe("The vault can pay 2,250.00 USDG now: withdraw that with earn_redeem, or exit more than that");
  });

  it("refuses what it cannot do, in fixed words", async () => {
    const go = (c: ReturnType<typeof chain>, input = now(), idx = indexer()) => refusal(prepareNext(ctx({ d: d(), chain: c, indexer: idx }), input));
    expect(await go(chain({ vaultShares: () => Promise.resolve(0n) }))).toEqual({ code: "NOTHING_TO_EXIT", retryable: false });
    expect(await go(chain(), now({ amount: String(usd(3_001)) }))).toEqual({ code: "EXCEEDS_BALANCE", retryable: false });
    expect(await go(chain({ exitDeskOf: () => Promise.resolve(null) }))).toEqual({ code: "EXITS_CLOSED", retryable: false });
    expect(await go(chain({ isVault: () => Promise.resolve(false) }))).toEqual({ code: "UNKNOWN_VAULT", retryable: false });
    // The desk lists only for what the vault cannot pay (`NoShortfall`).
    expect(await go(chain({ vaultMaxWithdraw: () => Promise.resolve(usd(1_000)), exitVaultBook: book(usd(3_000)) }))).toEqual({ code: "NO_SHORTFALL", retryable: true });
    // D394: nor for what its reserve holds, at value, while the reserve can pay none of it now: the wallet waits for it.
    const reserveHolds = (_vault: unknown, shares: bigint) => Promise.resolve({ claim: shares / 10n ** 12n, free: 0n, held: usd(3_000), loans: usd(5_000), supply: 10_000n * E18 });
    expect(await go(chain({ vaultMaxWithdraw: () => Promise.resolve(0n), exitVaultBook: reserveHolds }))).toEqual({ code: "NO_SHORTFALL", retryable: true });
    expect(await go(chain({ withinAverage: () => Promise.resolve(false) }))).toEqual({ code: "NO_LOAN_TO_LIST", retryable: true });
    // As the app's card offers it: never while the vault is paused (no loan of it sells), nor beside an open exit.
    expect(await go(chain(), now(), indexer({ settings: { bufferBps: 0, paused: true } }))).toEqual({ code: "PAUSED", retryable: false });
    expect(await go(chain({ exitOf: exit({ shares: 1_000n * E18, id: 7n, nonce: 3n, committedAt: NOW - 100 }) }))).toEqual({ code: "EXIT_OPEN", retryable: false });
    // An amount worth less than a share commits none.
    expect(await go(chain({ vaultShares: () => Promise.resolve(1n), exitVaultBook: () => Promise.resolve({ claim: usd(3_000), free: 0n, held: 0n, loans: usd(5_000), supply: 10_000n * E18 }) }), now({ amount: "1" }))).toEqual({ code: "TOO_SMALL", retryable: false });
  });

  it("passes over a holding the desk would refuse: above the vault's average, nothing left to sell, or ending before the listing and the wallet's confirmation", async () => {
    const id = async (over: Record<string, unknown>) => desk((await prepareNext(ctx({ d: d(), chain: approved(over), indexer: indexer() }), now())).next!.transaction.data).args?.[2];
    expect(await id({ withinAverage: (_d: unknown, _v: unknown, x: bigint) => Promise.resolve(x !== 7n) })).toBe(5n);
    expect(await id({ saleSlots: (_v: unknown, x: bigint) => Promise.resolve(x === 7n ? 0 : 4) })).toBe(5n);
    // Another exit's live listing of 7 holds it while the desk stops it, for that exit, no higher than it would for this
    // one (SEC-01, D391: floorOf); a larger need alone takes nothing over. A desk that answers no floorOf takes none.
    const ask: ExitAsk = { listedAt: NOW - 100, deadline: NOW + 560, nonce: 4n, exit: true };
    for (const theirs of [MINE_AT_7, MINE_AT_7 - 1, 0]) {
      expect(await id({ exitListing: theirsAt(7n, 4n), exitAsk: () => Promise.resolve(ask), exitShortfall: shortOf(usd(100)), exitFloorOf: floorsOf(theirs) })).toBe(5n);
    }
    const ending = await refusal(prepareNext(ctx({ d: d(), chain: chain({ loan: () => Promise.resolve({ state: 2, term: 3600 + 900, fundedAt: NOW - 3600 }) }), indexer: indexer() }), now()));
    expect(ending).toEqual({ code: "NO_LOAN_TO_LIST", retryable: true });
  });

  it("takes over another exit's live listing for a strictly lower floor, or once that exit cancelled, as the desk does (ED2, root D390; SEC-01, D391)", async () => {
    const id = async (over: Record<string, unknown>) => desk((await prepareNext(ctx({ d: d(), chain: approved(over), indexer: indexer() }), now())).next!.transaction.data).args?.[2];
    const ask: ExitAsk = { listedAt: NOW - 100, deadline: NOW + 560, nonce: 4n, exit: true };
    // The desk stops it higher for that exit than it would for this one (SEC-01, D391: floorOf), whatever that exit
    // needs (none at all: 9900): 7 is listed for this one as it stands, once that exit's floor there was read at the desk.
    for (const theirs of [MINE_AT_7 + 1, 9_900]) {
      const asked: unknown[][] = [];
      const floorOf = (...a: unknown[]) => { asked.push(a); return floorsOf(theirs)(a[0], a[1], a[2] as bigint, a[3] as Address); };
      expect(await id({ exitListing: theirsAt(7n, 4n), exitAsk: () => Promise.resolve(ask), exitShortfall: shortOf(usd(5_000)), exitFloorOf: floorOf })).toBe(7n);
      expect(asked).toContainEqual([DESK, getAddress(VAULT), 7n, OTHER]);
    }
    // A cancelled exit's record is gone: its listing still standing is anyone's, whatever its floor.
    expect(await id({ exitAsk: () => Promise.resolve(ask), exitFloorOf: floorsOf(0) })).toBe(7n);
  });

  it("passes over a takeover the desk refuses now (the testnet's r13d desk refuses them all, and a race can) for the next holding, so preparing again never chooses it again", async () => {
    const ask: ExitAsk = { listedAt: NOW - 100, deadline: NOW + 560, nonce: 4n, exit: true };
    const theirs = { exitListing: theirsAt(7n, 4n), exitAsk: (_m: unknown, x: bigint) => Promise.resolve(x === 7n ? ask : { listedAt: 0, deadline: 0, nonce: 0n, exit: false }), exitShortfall: shortOf(usd(100)),
      // SEC-01 (D391): the desk stops that listing higher for that exit than for this one, so it would take it over.
      exitFloorOf: floorsOf(9_900) };
    // The desk refuses the exit's listing of 7: its simulation from the wallet, after the approval where one is needed, fails.
    const batches: string[][] = [];
    const refuses = (_from: unknown, calls: readonly { to: Address; data: `0x${string}` }[]) => {
      batches.push(calls.map((x) => (same(x.to, DESK) ? `${desk(x.data).functionName}:${String(desk(x.data).args?.[2])}` : "approve")));
      return Promise.resolve(calls.map((x) => !(same(x.to, DESK) && desk(x.data).args?.[2] === 7n)));
    };
    const ready = await prepareNext(ctx({ d: d(), chain: approved({ ...theirs, simulateCalls: refuses }), indexer: indexer() }), now());
    expect(desk(ready.next!.transaction.data).args).toEqual([getAddress(VAULT), HELD, 5n]);
    expect(ready.view).toMatchObject({ loanId: "5" });
    // Only the takeover is simulated before it is chosen: 5 stands under no listing.
    expect(batches).toEqual([["exitNow:7"]]);
    batches.length = 0;
    const approving = await plan(ctx({ d: d(), chain: chain({ ...theirs, simulateCalls: refuses }), indexer: indexer() }), now());
    expect(approving.view).toMatchObject({ loanId: "5" });
    expect(batches).toEqual([["approve", "exitNow:7"]]);
    // Where the RPC cannot simulate a batch, the call alone, when nothing comes before it.
    const alone = await prepareNext(ctx({ d: d(), chain: approved({ ...theirs, simulateCalls: () => Promise.resolve(null),
      simulate: (x: { to: Address; data: `0x${string}` }) => (same(x.to, DESK) && desk(x.data).args?.[2] === 7n ? Promise.reject(new ApiError("SIMULATION_FAILED", "reverts")) : Promise.resolve(100_000n)) }), indexer: indexer() }), now());
    expect(desk(alone.next!.transaction.data).args?.[2]).toBe(5n);
    // An open exit's next listing too: still 750 short, its last listing of 9 ended unsold.
    batches.length = 0;
    const listed = await prepareNext(ctx({ d: d(), chain: chain({ ...theirs, exitOf: exit({ shares: HELD, id: 9n, nonce: 2n, committedAt: NOW - 1_000 }),
      exitShortfall: (_d: unknown, _v: unknown, o: Address) => Promise.resolve(o === OTHER ? usd(100) : usd(750)), simulateCalls: refuses }), indexer: indexer() }),
    { action: "earn_exit_list", wallet: WALLET, vault: VAULT });
    expect(desk(listed.next!.transaction.data)).toMatchObject({ functionName: "list", args: [getAddress(VAULT), getAddress(WALLET), 5n] });
    expect(batches).toEqual([["list:7"]]);
  });

  it("commits again over an exit whose request lapsed, as the app's Exit now on a lapsed exit does", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: approved({ exitOf: exit({ shares: 1_000n * E18, id: 7n, nonce: 3n, committedAt: NOW - 86_400 }) }), indexer: indexer() }), now());
    expect(desk(p.next!.transaction.data).args).toEqual([getAddress(VAULT), HELD, 7n]);
    expect(p.view).toMatchObject({ lapsed: true });
  });

  it("settles the vault first while a loan of it is past its end and not booked", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: chain({ earliestMaturity: () => Promise.resolve(NOW - 1), vaultMaxWithdraw: () => Promise.resolve(0n) }), indexer: indexer({}, ["3"]) }), now());
    expect(p.next).toMatchObject({ label: "Settle the vault's loans", final: false });
    expect(p.again).toBe(true);
    expect(p.view).toMatchObject({ action: "earn_exit_now", loanId: null, need: null });
  });

  it("settles first, 32 a transaction, the records the desk waits on before it lists (r13d), then prepares the exit again", async () => {
    const c = ctx({ d: d(), chain: approved({ pendingSettlements: waiting }), indexer: indexer() });
    const p = await prepareNext(c, now());
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "Settle the vault's loans", final: false });
    expect(getAddress(p.next!.transaction.to)).toBe(getAddress(VAULT));
    expect(p.then).toEqual(["Settle the vault's loans"]);
    expect(p.again).toBe(true);
    expect(p.view).toMatchObject({ action: "earn_exit_now", payableNow: "2250000000", loanId: null, need: null });
    expect(p.summary.rows).toEqual([{ label: "First", value: "Settle 40 loans of RWA · NVDAx: the exit desk lists none of its loans while one's outcome waits to be booked" }]);
    expect(await settled(await plan(c, now()))).toEqual([WAITING.slice(0, 32), WAITING.slice(32)]);
    // Once none waits, the exit itself.
    expect(desk((await prepareNext(ctx({ d: d(), chain: approved(), indexer: indexer() }), now())).next!.transaction.data).functionName).toBe("exitNow");
  });

  it("refuses what the vault can pay now before settling anything for the desk", async () => {
    const c = chain({ pendingSettlements: waiting, vaultMaxWithdraw: () => Promise.resolve(usd(1_000)), exitVaultBook: book(usd(3_000)) });
    expect(await refusal(prepareNext(ctx({ d: d(), chain: c, indexer: indexer() }), now()))).toEqual({ code: "NO_SHORTFALL", retryable: true });
  });
});

/** SEC-01 (root D391): what the wallet carried of each holding's window, of a supply of 100, by id; the reads seen. */
const carried = (by: Record<string, bigint>, seen: unknown[][] = []) => (factory: unknown, vault: unknown, ids: readonly bigint[], who: unknown) => {
  seen.push([factory, vault, [...ids], who]);
  return Promise.resolve(ids.map((id) => ({ exposure: by[id.toString()] ?? 0n, supply: 100n })));
};

describe("the leaver pays its own discount (SEC-01, root D391)", () => {
  it("tries holdings by where the desk would stop each for the exit, not by the stake floor alone (SEC-01 review)", () => {
    // A need of 100. A: a stake floor of 4950 and a book of 1,000, so the desk stops it at the need's 8910. B: a stake
    // floor of 5050 and a book of exactly 100, so the desk stops it at 5050, where a buyer is likelier to meet it.
    const E = 10n ** 18n, need = 100n, stakes = new Map<bigint, number>([[1n, 4_950], [2n, 5_050]]);
    const A = { id: 1n, remaining: 50n * E, book: 1_000n * E, maturity: 10 }, B = { id: 2n, remaining: 5n * E, book: 100n * E, maturity: 10 };
    const order = [A, B].sort(exitFit(need, stakes));
    expect(order.map((h) => h.id)).toEqual([2n, 1n]);
    expect(order.map((h) => exitFloor(h, need, stakes.get(h.id)!))).toEqual([5_050, 8_910]);
    // No stake floor known (share views without exitShare): the size order, the smallest that covers the need first.
    expect([A, B].sort(exitFit(need, null)).map((h) => h.id)).toEqual([2n, 1n]);
    expect([B, A].sort(exitFit(1_000n, null)).map((h) => h.id)).toEqual([1n, 2n]);
  });

  it("says a listing whose floor is where it starts (9900) does not fall and is unlikely to sell (SEC-01 review)", () => {
    const cash = { token: USDG, symbol: "USDG", decimals: 6, stable: true };
    expect(soldFor(7n, "RWA · NVDAx", 1n, 10n ** 30n, cash, 9_900)).toBe("Loan #7 of RWA · NVDAx: its price stays at book value plus 99% of what it has still to earn and does not fall. A vault is unlikely to buy it");
    expect(soldFor(7n, "RWA · NVDAx", 1n, 10n ** 30n, cash, 9_899)).toMatch(/falls from book value plus 99% of what it has still to earn to book value plus 98\.99% of it\. /);
  });

  it("lists the holding the wallet carried more of, says where its price stops and that it may not sell, and that the wallet pays the buyer's discount", async () => {
    const seen: unknown[][] = [];
    // 30% of loans 5's and 9's windows, but 5% of 7's (a loan made before most of its shares came in).
    const p = await prepareNext(ctx({ d: d(), chain: approved({ exitShares: carried({ "5": 30n, "7": 5n, "9": 30n }, seen) }), indexer: indexer() }), now());
    expect(desk(p.next!.transaction.data).args).toEqual([getAddress(VAULT), HELD, 5n]);
    // Every share committed of every share held: the stake floors are 6930 for 5 and 9, and 9405 for 7, whose 69% group
    // goes first; 5 covers the 750 USDG need, 9 does not. Its floor is its stake's, above the need's.
    expect(p.view).toMatchObject({ action: "earn_exit_now", loanId: "5", need: "750000000", floorBps: 6_930 });
    expect(seen).toEqual([[manifest().intentV1.factory, VAULT, [7n, 5n, 9n], WALLET]]);
    expect(p.summary.rows[2]!.value).toBe("Loan #5 of RWA · NVDAx: over ten minutes its price falls from book value plus 99% of what it has still to earn to book value plus 69.30% of it. A vault buys only if the price falls far enough for it, so it may not sell");
    expect(p.summary.rows[3]!.value).toBe("About 7.45 USDG: your share of what the vault's loans have still to earn, if they are repaid. You pay the buyer's discount on loan #5 yourself, out of your share of what that loan has still to earn");
    // A wallet that carried the whole of every window keeps nothing back: the desk stops each at the need's floor, and 9,
    // which the need covers whole, at book value, below 7's, so 9 goes first (SEC-01 review: the desk's floor, not the
    // stake floor alone, orders them).
    const all = await prepareNext(ctx({ d: d(), chain: approved({ exitShares: carried({ "5": 100n, "7": 100n, "9": 100n }) }), indexer: indexer() }), now());
    expect(all.view).toMatchObject({ loanId: "9", floorBps: 0 });
    expect(all.summary.rows[2]!.value).toBe("Loan #9 of RWA · NVDAx: over ten minutes its price falls from book value plus 99% of what it has still to earn to book value. A vault buys only if the price falls far enough for it, so it may not sell");
  });

  it("keeps the earlier words and no floor where the share views answer no exitShare (an earlier generation's)", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: approved(), indexer: indexer() }), now());
    expect(p.view).toMatchObject({ loanId: "7", floorBps: null });
    expect(p.summary.rows[2]!.value).toBe("Loan #7 of RWA · NVDAx: over ten minutes 750.00 USDG of it falls to book value, the rest keeps 99% of what it has still to earn");
    expect(p.summary.rows[3]!.value).toBe("About 7.45 USDG: your share of what the vault's loans have still to earn, if they are repaid");
  });

  it("counts an open exit's committed shares as the desk does: no more than the wallet's balance and its approval of the desk", async () => {
    const listing = (allowance: bigint) => chain({
      exitOf: exit({ shares: HELD, id: 7n, nonce: 3n, committedAt: NOW - 1_000 }), exitAsk: () => Promise.resolve({ listedAt: NOW - 1_000, deadline: NOW - 340, nonce: 3n, exit: true }),
      exitShortfall: () => Promise.resolve(usd(150)), allowance: () => Promise.resolve(allowance), exitShares: carried({ "5": 60n, "7": 60n, "9": 60n }),
    });
    const input = { action: "earn_exit_list", wallet: WALLET, vault: VAULT } as const;
    // Approved for half its shares: it carried 60 × ½ = 30 of each window, 6930; for all of them, 60, 3960.
    expect((await prepareNext(ctx({ d: d(), chain: listing(HELD / 2n), indexer: indexer() }), input)).view).toMatchObject({ action: "earn_exit_list", loanId: "9", floorBps: 6_930 });
    expect((await prepareNext(ctx({ d: d(), chain: listing(HELD), indexer: indexer() }), input)).view).toMatchObject({ action: "earn_exit_list", loanId: "9", floorBps: 3_960 });
  });
});

/** An open exit of all the wallet's shares, committed `ago` seconds back, its last listing of 7 ended unsold. */
const open = (ago = 1_000) => exit({ shares: HELD, id: 7n, nonce: 3n, committedAt: NOW - ago });
const ended: ExitAsk = { listedAt: NOW - 1_000, deadline: NOW - 340, nonce: 3n, exit: true };
const live: ExitAsk = { listedAt: NOW - 100, deadline: NOW + 560, nonce: 3n, exit: true };
const short = (need: bigint) => () => Promise.resolve(need);

describe("an open exit's next listing", () => {
  const listing = (over: Record<string, unknown> = {}) => chain({ exitOf: open(), exitAsk: () => Promise.resolve(ended), exitShortfall: short(usd(150)), ...over });
  const input = { action: "earn_exit_list", wallet: WALLET, vault: VAULT } as const;

  it("lists the next holding once the last listing ended unsold, sized to what the vault still cannot pay (the desk's shortfall)", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: listing({ exitListing: theirsAt(7n, 3n, WALLET) }), indexer: indexer() }), input);
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "List the next loan", final: true });
    expect(getAddress(p.next!.transaction.to)).toBe(getAddress(DESK));
    const call = desk(p.next!.transaction.data);
    expect(call.functionName).toBe("list");
    expect(call.args).toEqual([getAddress(VAULT), getAddress(WALLET), 9n]);
    expect(p.view).toMatchObject({ action: "earn_exit_list", vault: VAULT, shares: String(HELD), loanId: "9", need: "150000000", lapsesAt: NOW - 1_000 + 86_400 });
  });

  it("settles first what the desk waits on before it lists the next holding (r13d)", async () => {
    const c = ctx({ d: d(), chain: listing({ pendingSettlements: () => Promise.resolve([3n]) }), indexer: indexer() });
    const p = await prepareNext(c, input);
    expect(p.next).toMatchObject({ label: "Settle the vault's loans", final: false });
    expect(p.again).toBe(true);
    expect(p.view).toMatchObject({ action: "earn_exit_list", shares: String(HELD), loanId: null, need: null, lapsesAt: NOW - 1_000 + 86_400 });
    expect(p.summary.title).toBe(`List the next loan for your exit from RWA · NVDAx (${VAULT.slice(0, 6)}…${VAULT.slice(-4)})`);
    expect(await settled(await plan(c, input))).toEqual([[3n]]);
    // Nothing is settled for an exit the vault can pay the rest of.
    expect(await refusal(prepareNext(ctx({ d: d(), chain: listing({ pendingSettlements: () => Promise.resolve([3n]), exitShortfall: short(0n) }), indexer: indexer() }), input)))
      .toEqual({ code: "NO_SHORTFALL", retryable: true });
  });

  it("refuses what it cannot do, in fixed words", async () => {
    const go = (c: ReturnType<typeof chain>) => refusal(prepareNext(ctx({ d: d(), chain: c, indexer: indexer() }), input));
    expect(await go(listing({ exitOf: exit() }))).toEqual({ code: "NO_EXIT", retryable: false });
    expect(await go(listing({ exitAsk: () => Promise.resolve(live) }))).toEqual({ code: "LISTING_LIVE", retryable: true });
    expect(await go(listing({ exitOf: open(86_400) }))).toEqual({ code: "EXIT_LAPSED", retryable: false });
    expect(await go(listing({ exitShortfall: short(0n) }))).toEqual({ code: "NO_SHORTFALL", retryable: true });
    expect(await go(listing({ withinAverage: () => Promise.resolve(false) }))).toEqual({ code: "NO_LOAN_TO_LIST", retryable: true });
    expect(await go(listing({ exitDeskOf: () => Promise.resolve(null) }))).toEqual({ code: "EXITS_CLOSED", retryable: false });
  });
});

describe("an exit's cancel", () => {
  const input = { action: "earn_exit_cancel", wallet: WALLET, vault: VAULT } as const;

  it("withdraws the exit on the desk the factory bound, while exits are closed too", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: chain({ exitDeskOf: () => Promise.resolve(null), exitOf: open(), exitAsk: () => Promise.resolve(ended) }), indexer: indexer() }), input);
    expect(p.next).toMatchObject({ label: "Cancel the exit", final: true });
    expect(getAddress(p.next!.transaction.to)).toBe(getAddress(DESK));
    expect(desk(p.next!.transaction.data)).toMatchObject({ functionName: "cancel", args: [getAddress(VAULT)] });
    expect(p.view).toMatchObject({ action: "earn_exit_cancel", vault: VAULT, shares: String(HELD), listed: null, lapsed: false });
    // A listing still live stays in the market until it ends, no longer for this exit: another exit may take it over (ED2).
    const listed = await prepareNext(ctx({ d: d(), chain: chain({ exitOf: open(), exitAsk: () => Promise.resolve(live) }), indexer: indexer() }), input);
    expect(listed.view).toMatchObject({ listed: "7" });
  });

  it("refuses where there is no exit to cancel", async () => {
    const go = (c: ReturnType<typeof chain>) => refusal(prepareNext(ctx({ d: d(), chain: c, indexer: indexer() }), input));
    expect(await go(chain())).toEqual({ code: "NO_EXIT", retryable: false });
    expect(await go(chain({ boundExitDeskOf: () => Promise.resolve(null), exitOf: open() }))).toEqual({ code: "NO_EXIT", retryable: false });
  });
});

describe("collecting what an exit's sales paid", () => {
  const owed = (amounts: Record<string, bigint>) => (_desk: Address, asset: Address) => Promise.resolve(amounts[asset.toLowerCase()] ?? 0n);
  const input = { action: "earn_exit_collect", wallet: WALLET } as const;

  it("withdraws what the desk owes the wallet, one transaction an asset", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: chain({ exitOwed: owed({ [USDG]: usd(2_400) }) }), indexer: indexer() }), input);
    expect(p.next).toMatchObject({ label: "Receive 2,400.00 USDG" });
    expect(getAddress(p.next!.transaction.to)).toBe(getAddress(DESK));
    expect(desk(p.next!.transaction.data)).toMatchObject({ functionName: "withdraw", args: [getAddress(USDG)] });
    expect(p.view).toEqual({ action: "earn_exit_collect", owed: [{ desk: DESK, token: USDG, symbol: "USDG", decimals: 6, amount: "2400000000" }] });
    // GLDx's generation binds the same desk: what it owes in GLDx is its own withdrawal.
    const m = assetManifest();
    const both = parseDeployment({ ...m, intentV1: { ...m.intentV1, exitDesk: DESK }, intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, exitDesk: DESK } } });
    const two = await prepareNext(ctx({ d: both, chain: chain({ exitOwed: owed({ [USDG]: usd(5), [GLDX]: E18 / 2n }) }), indexer: indexer() }), input);
    expect([two.next?.label, ...two.then]).toEqual(["Receive 5.00 USDG", "Receive 0.5 GLDx"]);
    const gold = await prepareNext(ctx({ d: both, chain: chain({ exitOwed: owed({ [USDG]: usd(5), [GLDX]: E18 / 2n }) }), indexer: indexer() }), { ...input, asset: GLDX });
    expect([gold.next?.label, ...gold.then]).toEqual(["Receive 0.5 GLDx"]);
  });

  it("refuses an asset it owes none of, and says when nothing is owed", async () => {
    const go = (asset: Address) => refusal(prepareNext(ctx({ d: d(), chain: chain(), indexer: indexer() }), { ...input, asset }));
    expect(await go(USDG)).toEqual({ code: "NOTHING_TO_WITHDRAW", retryable: false });
    expect(await go(NVDA)).toEqual({ code: "UNKNOWN_LEND_ASSET", retryable: false });
    const p = await prepareNext(ctx({ d: d(), chain: chain(), indexer: indexer() }), input);
    expect(p.status).toBe("done");
    expect(p.summary.title).toBe("Nothing to collect");
  });
});

describe("open exits and what the desk owes, where the wallet reads its portfolio and collects", () => {
  const read = (c: ReturnType<typeof chain>, deployment = d()) => portfolio(ctx({ d: deployment, chain: c, indexer: indexer() }), WALLET);

  it("say each holding's open exit and its stage, as the app's Portfolio line does", async () => {
    const stage = async (over: Record<string, unknown>) => (await read(chain({ exitOf: open(), exitAsk: () => Promise.resolve(ended), exitShortfall: short(usd(150)), ...over }))).earn[0]!.exit;
    expect(await stage({ exitAsk: () => Promise.resolve(live) })).toEqual({
      shares: String(HELD), committed: "3000000000", stage: "listed", loanId: "7", listingEndsAt: NOW + 560, lapsesAt: NOW - 1_000 + 86_400,
    });
    expect(await stage({})).toMatchObject({ stage: "next", loanId: null, listingEndsAt: null });
    // While exits are closed nothing is listed for it until they reopen.
    expect(await stage({ exitDeskOf: () => Promise.resolve(null) })).toMatchObject({ stage: "closed" });
    expect(await stage({ exitShortfall: short(0n) })).toMatchObject({ stage: "payable" });
    expect(await stage({ exitOf: open(86_400) })).toMatchObject({ stage: "lapsed" });
    expect((await read(chain())).earn[0]).toMatchObject({ vault: VAULT, exit: null });
  });

  it("say what the desk owes the wallet, by asset, and collect it with the rest", async () => {
    const owing = chain({ exitOwed: (_desk: Address, asset: Address) => Promise.resolve(asset.toLowerCase() === USDG.toLowerCase() ? usd(2_400) : 0n) });
    expect((await read(owing)).exitOwed).toEqual([{ desk: DESK, token: USDG, symbol: "USDG", decimals: 6, amount: "2400000000" }]);
    const p = await prepareNext(ctx({ d: d(), chain: owing, indexer: indexer() }), { action: "collect", wallet: WALLET });
    expect(p.next?.label).toBe("Receive 2,400.00 USDG from your exit now");
    expect(desk(p.next!.transaction.data)).toMatchObject({ functionName: "withdraw", args: [getAddress(USDG)] });
    expect(p.summary.rows).toContainEqual({ label: "From your exit now", value: "2,400.00 USDG" });
    expect(p.view).toMatchObject({ action: "collect", exits: [{ token: USDG, symbol: "USDG", decimals: 6, amount: "2400000000" }] });
  });

  it("read nothing of a desk where the release names none, so a portfolio and a collect read as before", async () => {
    const p = await read(chain(), parseDeployment(manifest()));
    expect(p).not.toHaveProperty("exitOwed");
    expect(p.earn[0]).not.toHaveProperty("exit");
    const c = await prepareNext(ctx({ chain: chain({ exitOwed: () => Promise.resolve(usd(5)) }), indexer: indexer() }), { action: "collect", wallet: WALLET });
    expect(c.view).not.toHaveProperty("exits");
  });
});

describe("where a partner vault's exit now is served", () => {
  it("only where a current generation names its exit desk", () => {
    for (const action of EXITS) {
      expect(actionsOn(parseDeployment(manifest()))).not.toContain(action);
      expect(actionsOn(d())).toContain(action);
    }
    const m = assetManifest();
    const gold = parseDeployment({ ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, exitDesk: DESK } } });
    for (const action of EXITS) expect(actionsOn(gold)).toContain(action);
  });

  it("on a bundled network once its release names a desk: the testnet's from r13, not yet mainnet's", () => {
    for (const m of [MAINNET_MANIFEST, TESTNET_MANIFEST]) {
      const d = parseDeployment(m), desk = d.generations.some((g) => g.exitDesk !== null);
      for (const action of EXITS) expect(actionsOn(d).includes(action), `${action} on ${d.chainId}`).toBe(desk);
    }
  });
});

/** The index's routes without an accounting that says what the loans have still to earn (an older index). */
function indexerRoutes() {
  return { "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [row], nextCursor: null } };
}
function accountingWithout() {
  return (path: string) => ({
    status: 200,
    body: path.endsWith("/accounting")
      ? { pricing: { totalAssets: "10000000000", totalSupply: String(10_000n * E18), assetsPerShare: "1" }, liquidity: { free: "2250000000" }, settlement: { due: false, settleable: [] } }
      : { shares: String(HELD), value: "3000000000", withdrawableNow: "2250000000", rewards: "0", pockets: [] },
  });
}

describe("an exit with gage's index silent", () => {
  const silent = () => fakeUpstream({ "/intent/partners/vaults": () => ({ status: 503, body: {} }) });
  const manager = (paused = false) => () => Promise.resolve({ name: "Acme", categoryMask: 1, mandateVersion: 13, bufferBps: 500, paused });

  it("plans it from the chain, the vault naming itself, and what it gives up left unknown, never a guess", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: approved({ vaultManager: manager() }), indexer: silent() }), now());
    expect(p.status).toBe("ready");
    expect(desk(p.next!.transaction.data).args).toEqual([getAddress(VAULT), HELD, 7n]);
    expect(p.view).toMatchObject({ action: "earn_exit_now", name: "Acme", loanId: "7" });
    expect(p.preview?.giveUp).toBeNull();
    // Its next listing and its cancel read nothing else.
    const open = { exitOf: exit({ shares: HELD, id: 5n, nonce: 1n, committedAt: NOW - 3600 }), exitShortfall: () => Promise.resolve(usd(750)), vaultManager: manager() };
    expect((await prepareNext(ctx({ d: d(), chain: approved(open), indexer: silent() }), { action: "earn_exit_cancel", wallet: WALLET, vault: VAULT })).next).toMatchObject({ label: "Cancel the exit" });
  });

  it("refuses while the vault itself says it is paused", async () => {
    expect(await refusal(prepareNext(ctx({ d: d(), chain: approved({ vaultManager: manager(true) }), indexer: silent() }), now()))).toEqual({ code: "PAUSED", retryable: false });
  });

  it("settles first what its desk names while a loan is past its end and not booked", async () => {
    const c = ctx({ d: d(), chain: approved({ vaultManager: manager(), earliestMaturity: () => Promise.resolve(NOW - 1), pendingSettlements: () => Promise.resolve([3n]) }), indexer: silent() });
    expect(await settled(await plan(c, now()))).toEqual([[3n]]);
  });
});
