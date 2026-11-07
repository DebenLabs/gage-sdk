/**
 * With gage's index silent (D439, amending D222): a wallet's own repayment and withdrawal are decided from the chain. A
 * loan stays refused wherever the chain cannot prove it public: a private-lane router opened it, the chain cannot say, or
 * the core's registry admitted a router this release does not name, which could be a lane it does not know.
 */
import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { partnerVaultAbi } from "../src/abi.js";
import type { Chain, VaultManagerState } from "../src/chain.js";
import { gageFrom } from "../src/client.js";
import { parseDeployment, publicRoutersOf } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import type { Upstream } from "../src/upstream.js";
import { prepareNext } from "../src/prepare.js";
import { run } from "../src/run.js";
import { A, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, loan as chainLoan, mainnetManifest, manifest, NOW, NVDA, OLD, position, PRIVATE_ROUTER, REG, VAULT, WALLET } from "../src/testing.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const lane = () => parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, privateRouter: PRIVATE_ROUTER } });
/** gage's index, answering nothing, as the real upstream refuses when it gets no answer. */
const silent = (): Upstream => {
  const refuse = () => Promise.reject(new ApiError("UPSTREAM_UNAVAILABLE", "A gage data service did not answer", 503, true));
  return { raw: refuse, get: refuse };
};
const repay = { action: "reclaim" as const, wallet: WALLET, loanId: "7" };
const STRANGER = A(0x5a5a), DESK = A(0x162);

/** A running loan of the wallet's, on a core with the private lane; `opened` is what its router says of the loan. */
const running = (opened: (boolean | null)[] = [false], over: Partial<Record<keyof Chain, unknown>> = {}) => fakeChain({
  loan: () => Promise.resolve(chainLoan({ state: 2, originator: WALLET })),
  ownerOf: () => Promise.resolve(WALLET),
  privateLoans: () => Promise.resolve(opened),
  routerAdmissions: () => Promise.resolve([PRIVATE_ROUTER]),
  ...over,
});
const context = (chain: Chain, indexer = silent()) => ctx({ d: lane(), chain, indexer });

describe("repaying with gage's index silent", () => {
  it("serves a wallet's own loan once the chain proves it public", async () => {
    const admissions = vi.fn(() => Promise.resolve([PRIVATE_ROUTER]));
    const p = await prepareNext(context(running([false], { routerAdmissions: admissions, head: () => Promise.resolve({ number: 500n, timestamp: NOW }) })), repay);
    // From the chain's first block: a release's start block can come after a registry's first logs.
    expect(admissions).toHaveBeenCalledWith(REG, 0n, 500n);
    expect(p.next).not.toBeNull();
    expect([p.next!.label, ...p.then].join(" ")).toContain("Repay");
    expect(p.view).toMatchObject({ action: "reclaim", loanId: "7" });
    // And carries it out, every step simulated and sent as any other.
    const signer = fakeSigner();
    expect(await run(context(running()), repay, signer)).toMatchObject({ status: "done", error: null });
    expect(signer.sent.length).toBeGreaterThan(0);
  });

  it("serves one on a core with no private lane where its registry admitted only what the release names", async () => {
    const chain = fakeChain({ loan: () => Promise.resolve(chainLoan({ state: 2, originator: WALLET })), ownerOf: () => Promise.resolve(WALLET) });
    expect((await prepareNext(ctx({ chain, indexer: silent() }), repay)).next).not.toBeNull();
  });

  it("refuses a private loan: a private-lane router opened it", async () => {
    expect(await code(prepareNext(context(running([true])), repay))).toBe("NOT_FOUND");
    expect(await code(run(context(running([true])), repay, fakeSigner()))).toBe("NOT_FOUND");
  });

  it("refuses a loan the chain cannot say of", async () => {
    expect(await code(prepareNext(context(running([null])), repay))).toBe("NOT_FOUND");
  });

  it("refuses, and sends nothing, where the core's registry admitted a router this release does not name: it could be a lane it does not know", async () => {
    const stale = running([false], { routerAdmissions: () => Promise.resolve([PRIVATE_ROUTER, STRANGER]) });
    const signer = fakeSigner();
    await expect(gageFrom(context(stale)).run({ action: "reclaim", loanId: "7" } as never, signer)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
    expect(signer.sent).toEqual([]);
    // A core with no private lane in this release is no exception: the stranger could be the first.
    const none = fakeChain({ loan: () => Promise.resolve(chainLoan({ state: 2, originator: WALLET })), ownerOf: () => Promise.resolve(WALLET), routerAdmissions: () => Promise.resolve([STRANGER]) });
    await expect(prepareNext(ctx({ chain: none, indexer: silent() }), repay)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
  });

  it("names no router of its own as a stranger: the release's loop and rollover routers, and the private one", async () => {
    const d = lane();
    const named = [...publicRoutersOf(d, CORE), PRIVATE_ROUTER];
    expect(named.length).toBeGreaterThan(1);
    const known = running([false], { routerAdmissions: () => Promise.resolve(named) });
    expect((await prepareNext(context(known), repay)).next).not.toBeNull();
  });

  it("refuses while the chain's reads fail: nothing is proved, and asking again can clear it", async () => {
    const lost = () => Promise.reject(new Error("no node"));
    for (const over of [{ routerAdmissions: lost }, { privateLoans: lost }]) {
      await expect(gageFrom(context(running([false], over))).prepare(repay)).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    }
  });

  it("refuses another wallet's loan as ever", async () => {
    const theirs = running([false], { loan: () => Promise.resolve(chainLoan({ state: 2, originator: OLD, collateralBeneficiary: OLD })), ownerOf: () => Promise.resolve(OLD) });
    expect(await code(prepareNext(context(theirs), repay))).toBe("NOT_YOUR_LOAN");
  });

  it("listens to an index that answers: gone, marked private or marked nothing stays refused whatever the chain says", async () => {
    const answers = [
      fakeUpstream({ "/v2/positions": () => ({ status: 404, body: {} }) }),
      fakeUpstream({ "/v2/positions/": position("7", { private: true }) }),
      fakeUpstream({ "/v2/positions/": (() => { const { private: _gone, ...row } = position("7"); return row; })() }),
    ];
    for (const indexer of answers) expect(await code(prepareNext(context(running(), indexer), repay))).toBe("NOT_FOUND");
  });

  it("is the repayment alone: anything else on a loan still needs the index", async () => {
    for (const input of [{ action: "cancel" as const, wallet: WALLET, loanId: "7" }, { action: "cash_out" as const, wallet: WALLET, loanId: "7", maxSlippageBps: 50 }]) {
      expect(await code(prepareNext(context(running()), input))).toBe("UPSTREAM_UNAVAILABLE");
    }
  });

  it("reads each router the release names for an earlier generation as named", () => {
    const m = mainnetManifest() as Record<string, unknown>;
    const core = parseDeployment(m).engines[0]!.engine, loopRouter = A(0x1a1a), rolloverRouter = A(0x1b1b);
    const d = parseDeployment({ ...m, intentV1Previous: [{ intentV1: { core, factory: A(0x1c1c), loopRouter, rolloverRouter }, intentV1IndexerUrl: "https://retained.example" }] });
    expect(publicRoutersOf(d, core)).toEqual(expect.arrayContaining([getAddress(loopRouter), getAddress(rolloverRouter)]));
  });
});

describe("withdrawing with gage's index silent", () => {
  const redeem = { action: "earn_redeem" as const, wallet: WALLET, vault: VAULT };
  const E18 = 10n ** 18n;
  /** A quarter of the vault's shares at its own conversion, rounded down: its virtual shares and assets count. */
  const WORTH = (E18 * 10_000_001n) / (4n * E18 + 10n ** 12n);
  const manager = { name: "Acme", categoryMask: 9, mandateVersion: 13, bufferBps: 0, paused: false } as VaultManagerState;
  const holder = (over: Partial<Record<keyof Chain, unknown>> = {}) => fakeChain({
    isVault: () => Promise.resolve(true),
    vaultCore: () => Promise.resolve(CORE),
    vaultShares: () => Promise.resolve(E18),
    vaultBook: () => Promise.resolve({ totalAssets: 10_000_000n, totalSupply: 4n * E18, free: 9_000_000n, performing: 1_000_000n }),
    vaultManager: () => Promise.resolve(manager),
    vaultMaxRedeem: () => Promise.resolve(E18),
    earliestMaturity: () => Promise.resolve(NOW + 3_600),
    ...over,
  });

  it("plans the withdrawal from the chain alone: the vault its factory made, named as it names itself, at its own book's worth", async () => {
    const indexer = silent();
    const p = await prepareNext(ctx({ chain: holder(), indexer }), redeem);
    expect(p).toMatchObject({ status: "ready", next: { label: "Withdraw", final: true }, view: { action: "earn_redeem", name: "Acme", assets: WORTH.toString() } });
    expect(p.next!.transaction.to.toLowerCase()).toBe(VAULT.toLowerCase());
    const call = decodeFunctionData({ abi: partnerVaultAbi, data: p.next!.transaction.data });
    expect(call.functionName).toBe("redeem");
    expect((call.args as readonly [bigint, bigint])[0]).toBe(E18);
    expect((call.args as readonly [bigint, bigint])[1]).toBeLessThan(WORTH);
    expect((call.args as readonly [bigint, bigint])[1]).toBeGreaterThan(0n);
    const signer = fakeSigner();
    expect(await run(ctx({ chain: holder(), indexer: silent() }), redeem, signer)).toMatchObject({ status: "done", error: null });
    expect(signer.sent).toHaveLength(1);
  });

  it("names a vault from before named limits by its family, and sizes its gas for a full book", async () => {
    const p = await prepareNext(ctx({ chain: holder({ vaultManager: () => Promise.resolve(null) }), indexer: silent() }), redeem);
    expect(p.view).toMatchObject({ name: "Partner vault" });
    expect(BigInt(p.next!.transaction.gas)).toBeGreaterThan(16_000_000n);
  });

  it("acts on no vault the chain does not bear out", async () => {
    expect(await code(prepareNext(ctx({ chain: holder({ isVault: () => Promise.resolve(false) }), indexer: silent() }), redeem))).toBe("UNKNOWN_VAULT");
    expect(await code(prepareNext(ctx({ chain: holder({ vaultCore: () => Promise.resolve(A(0xbad)) }), indexer: silent() }), redeem))).toBe("UNKNOWN_VAULT");
  });

  it("settles first what the factory's exit desk names when a settlement is due, the preview read from the same book", async () => {
    const pending = Array.from({ length: 40 }, (_, n) => BigInt(n + 1));
    let booked = false;
    const signer = fakeSigner();
    const due = holder({
      earliestMaturity: () => Promise.resolve(booked ? NOW + 3_600 : NOW - 1),
      exitDeskOf: () => Promise.resolve(DESK),
      pendingSettlements: () => Promise.resolve(booked ? [] : pending),
      wait: () => { booked = true; return Promise.resolve(true); },
    });
    const first = await prepareNext(ctx({ chain: due, indexer: silent() }), redeem);
    expect(first.view).toMatchObject({ action: "earn_redeem", name: "Acme", assets: WORTH.toString(), minAssets: "0" });
    expect(first.next).toMatchObject({ label: "Settle the vault's loans", final: false });
    const call = decodeFunctionData({ abi: partnerVaultAbi, data: first.next!.transaction.data });
    expect(call).toMatchObject({ functionName: "settle", args: [pending.slice(0, 32)] });
    // Run plans it again once the settle is mined, and withdraws.
    expect(await run(ctx({ chain: due, indexer: silent() }), redeem, signer)).toMatchObject({ status: "done", error: null });
    expect(signer.sent.map((t) => decodeFunctionData({ abi: partnerVaultAbi, data: t.data }).functionName)).toEqual(["settle", "redeem"]);
  });

  it("says a settlement is due and to ask again, where no desk names what to book", async () => {
    const due = (over: Partial<Record<keyof Chain, unknown>>) => holder({ earliestMaturity: () => Promise.resolve(NOW - 1), ...over });
    for (const chain of [due({}), due({ exitDeskOf: () => Promise.resolve(DESK) })]) {
      await expect(prepareNext(ctx({ chain, indexer: silent() }), redeem)).rejects.toMatchObject({ code: "SETTLEMENT_DUE", retryable: true });
    }
  });

  it("holds a withdrawal to what the vault can pay as the index would, and refuses a vault with nothing behind its shares", async () => {
    const book = (over: object) => () => Promise.resolve({ totalAssets: 10_000_000n, totalSupply: 4n * E18, free: 9_000_000n, performing: 1_000_000n, ...over });
    const shares = (p: Awaited<ReturnType<typeof prepareNext>>) => BigInt((p.view as { shares: string }).shares);
    const assets = (p: Awaited<ReturnType<typeof prepareNext>>) => BigInt((p.view as { assets: string }).assets);
    // A part asked for is held to what the vault says it can pay now.
    const part = { ...redeem, shares: (E18 / 2n).toString() };
    await expect(prepareNext(ctx({ chain: holder({ vaultMaxRedeem: () => Promise.resolve(E18 / 4n) }), indexer: silent() }), part)).rejects.toThrow("The vault can pay 0.62");
    // One from before ERC-4626 says nothing of that: its free cash sizes the withdrawal, as it does any vault's.
    const cut = await prepareNext(ctx({ chain: holder({ vaultMaxRedeem: () => Promise.resolve(null), vaultBook: book({ free: 1_000_000n }) }), indexer: silent() }), part);
    expect(assets(cut)).toBeLessThanOrEqual(1_000_000n);
    // Its last holder, with a loan out, leaves a share behind: the vault refuses the whole supply while a loan is out.
    const last = await prepareNext(ctx({ chain: holder({ vaultBook: book({ totalSupply: E18 }) }), indexer: silent() }), redeem);
    expect(shares(last)).toBeLessThan(E18);
    expect(await code(prepareNext(ctx({ chain: holder({ vaultBook: book({ totalAssets: 0n, free: 0n, performing: 0n }) }), indexer: silent() }), redeem))).toBe("IMPAIRED");
  });

  it("reads the index's own preview while it answers, the chain's rule never asked", async () => {
    const maturity = vi.fn(() => Promise.resolve(NOW - 1));
    const row = { address: VAULT, creator: WALLET, curator: WALLET, core: CORE, categoryMask: 9, feeBps: 1_000, maxLoanTerm: 604_800, assets: [NVDA], fundingEnabled: true, name: "Acme" };
    const indexer = fakeUpstream({
      "/intent/partners/vaults?": { items: [row], nextCursor: null },
      "/intent/partners/vaults/": { kind: "REDEEM", assets: "2400000", shares: "1000000000000000000", refusal: null, availableNow: null },
    });
    const p = await prepareNext(ctx({ chain: holder({ earliestMaturity: maturity }), indexer }), redeem);
    expect(p.view).toMatchObject({ assets: "2400000" });
    expect(maturity).not.toHaveBeenCalled();
  });

  it("is the withdrawal alone: a deposit still needs the index", async () => {
    const deposit = { action: "earn_deposit" as const, wallet: WALLET, vault: VAULT, amount: "1000000" };
    expect(await code(prepareNext(ctx({ chain: holder(), indexer: silent() }), deposit))).toBe("UPSTREAM_UNAVAILABLE");
  });
});
