/**
 * The examples (packages/sdk/examples) run as written against gage's own fakes, so they keep up with the API: the reads
 * the fakes answer are read for real, and every action, quote or batch an example asks for is checked against the very
 * schema `prepare` and `run` take, so an example that names a field the SDK no longer takes fails here.
 */
import { parseUnits } from "viem";
import { describe, expect, it, vi } from "vitest";
import { agentTools } from "../examples/agent-tools.js";
import { borrow, collateralOf, exactQuote, loop, quoteAtLeastMinimum, termOf } from "../examples/borrow.js";
import { createVault, tighten, vaultForSafe, withdrawCall } from "../examples/create-vault.js";
import { deposit } from "../examples/deposit.js";
import { collectExits, exitPreview, leave } from "../examples/exit-now.js";
import { lendMarkets, quoteIn } from "../examples/generations.js";
import { HOSTED, hostedAssets, prepareForReview } from "../examples/hosted-review.js";
import { manageLoan, offers } from "../examples/loan.js";
import { borrowAgainstPosition, lendToLpVault, lpOverview, repayLpLoan } from "../examples/lp.js";
import { park, parkable, unpark } from "../examples/park.js";
import { closePut, openPut, putAsset } from "../examples/put.js";
import { quote } from "../examples/quote.js";
import { loanState, markets, wallet } from "../examples/reads.js";
import { signYourself, type Wallet } from "../examples/sign-yourself.js";
import { counted, limitedTools, usdgLimit } from "../examples/spend-limit.js";
import { gageFrom, type Gage } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import type { View } from "../src/plans.js";
import { actionInput, borrowQuoteInput, leverageQuoteInput, lpQuoteInput, parseInput, putQuoteInput, vaultInput } from "../src/schemas.js";
import { A, CORE, ctx, fakeSigner, GLD_CORE, GLDX, lpFablesManifest, mainnetManifest, NVDA, putManifest, UNI_ADAPTER, USDG, VAULT, WALLET } from "../src/testing.js";

const mainnet = () => gageFrom(ctx({ d: parseDeployment(mainnetManifest()) }));
/** A run that checks its input against the schema `run` takes, with the signer's wallet, and answers `answer`. */
const checkedRun = (...answers: Record<string, unknown>[]) => {
  let n = 0;
  return vi.fn((input: object, signer: { address: string }) => {
    parseInput(actionInput, { ...input, wallet: signer.address });
    return Promise.resolve({ status: "done", sent: [], error: null, loan: null, ...answers[Math.min(n++, answers.length - 1)] });
  });
};

describe("the examples", () => {
  it("quote: reads the terms and the collateral, then asks for one whole token (or its minimum) over the shortest term", async () => {
    const gage = mainnet();
    const nvda = (await gage.assets()).assets.find((a) => a.token === NVDA)!;
    const borrowQuote = vi.fn(() => Promise.resolve({ summary: "Pledge 1 NVDA…", prepare: { action: "borrow" } }));
    const answer = await quote({ ...gage, borrowQuote } as unknown as Gage, nvda.symbol.toLowerCase());
    const whole = 10n ** BigInt(nvda.decimals), least = BigInt(nvda.minAmount);
    const { terms } = await gage.capabilities();
    expect(borrowQuote).toHaveBeenCalledWith({ token: NVDA, maxCollateral: (least > whole ? least : whole).toString(), term: terms[0]!.seconds });
    expect(answer).toMatchObject({ asset: nvda.symbol, summary: "Pledge 1 NVDA…", terms: terms.map((t) => `${t.days} days`) });
    await expect(quote({ ...gage, borrowQuote } as unknown as Gage, "nothing")).rejects.toThrow("gage takes no nothing as collateral now");
    // With no token named, the first a partner vault lends against: a token admitted and not yet lent against has no quote.
    const assets = () => Promise.resolve({ assets: [{ token: A(0x71), symbol: "WETH", decimals: 18, minAmount: "1", vaults: 0 }, { ...nvda, vaults: 1 }] });
    expect(await quote({ ...gage, assets, borrowQuote } as unknown as Gage)).toMatchObject({ asset: nvda.symbol });
  });

  it("deposit: the vault the caller named, whatever sorts first in the list, the amount in raw USDG, carried out by the signer", async () => {
    const run = vi.fn(() => Promise.resolve({ status: "done" }));
    const earnVaults = () => Promise.resolve({ vaults: [
      { vault: A(0x71), lends: false, totalAssetsUSDG: "1" },
      { vault: A(0x72), lends: true, totalAssets: "1", asset: { symbol: "GLDx" } },
      { vault: A(0x73), lends: true, totalAssetsUSDG: "5" },
      { vault: A(0x74), lends: true, totalAssetsUSDG: "9" },
    ] });
    const signer = fakeSigner();
    const g = { ...mainnet(), earnVaults, run } as unknown as Gage;
    await deposit(g, signer, A(0x74), "10.5");
    expect(run).toHaveBeenCalledWith({ action: "earn_deposit", vault: A(0x74), amount: "10500000" }, signer);
    // A name in any case is the same vault.
    await deposit(g, signer, A(0x74).toUpperCase().replace("0X", "0x"), "1");
    expect(run).toHaveBeenLastCalledWith({ action: "earn_deposit", vault: A(0x74), amount: "1000000" }, signer);
    run.mockClear();
    // Nothing else stands in for a vault that is not there, lends no more or takes another asset.
    await expect(deposit(g, signer, A(0x75), "1")).rejects.toThrow("That vault takes no USDG deposits now");
    await expect(deposit(g, signer, A(0x71), "1")).rejects.toThrow("That vault takes no USDG deposits now");
    await expect(deposit(g, signer, A(0x72), "1")).rejects.toThrow("That vault takes no USDG deposits now");
    expect(run).not.toHaveBeenCalled();
  });

  it("create-vault: a free name, for a signer or a Safe, then its manager's calls and a holder's way out, every input the schema's", async () => {
    const signer = fakeSigner();
    const run = checkedRun({ vault: A(0x71), sent: [{ hash: "0x1", label: "Create the vault" }] }, { sent: [{ hash: "0x2", label: "Set the largest loan" }] });
    const gage = { ...mainnet(), run } as unknown as Gage;
    expect(await createVault(gage, signer, "Acme Stocks", "1500")).toMatchObject({ status: "done", vault: A(0x71), sent: ["0x1"] });
    expect(run.mock.calls[0]![0]).toEqual({ action: "create_vault", name: "Acme Stocks", term: 604_800, feeBps: 1_000, maxLoan: "1500000000" });
    const made = await vaultForSafe(mainnet(), WALLET, "Acme Stocks").catch((e: unknown) => e);
    // The fixture's factory admits every account and classifies its one stock.
    expect(made).toMatchObject({ lendsAgainst: ["NVDAx"], calls: [{ value: "0" }] });
    expect(await tighten(gage, signer, VAULT)).toMatchObject({ status: "done", sent: ["Set the largest loan"], waiting: [] });
    expect(run.mock.calls[1]![0]).toEqual({ action: "vault_manage", vault: VAULT, maxLoan: "750000000", cashKeptFreeBps: 1_000, name: "Acme Stocks, careful" });
    const nothing = await withdrawCall(mainnet(), WALLET, VAULT);
    expect(nothing).toMatchObject({ settlementDue: false, payableNow: expect.any(String) as string });
    expect(nothing.call).toMatchObject({ to: VAULT, value: "0" });
  });

  it("agent-tools: the catalogue without a signer, then capabilities and collateral through execute", async () => {
    const answer = await agentTools(mainnet());
    expect(answer.tools).toHaveLength(22);
    expect(answer.tools[0]).toBe("gage_capabilities: gage capabilities");
    expect(answer.capabilities).toMatchObject({ network: "mainnet", chainId: 4663 });
    expect(answer.collateral).toHaveProperty("assets");
  });

  it("reads: the market, a wallet and a loan, each through its own read", async () => {
    const gage = mainnet();
    const earnVaults = () => Promise.resolve({ vaults: [{ vault: A(0x71), name: "Paused", lends: false }, { vault: VAULT, name: "Silicon", lends: true }] });
    const vaultFreeCash = vi.fn((i: unknown) => { parseInput(vaultInput, i); return Promise.resolve({ freeCashUSDG: "5" }); });
    const portfolio = vi.fn(() => Promise.resolve({
      loans: [{ loanId: "5", engine: CORE, state: "ACTIVE", repay: "1010000000", endsAt: 2, autoRoll: true }], earn: [{ vault: VAULT, name: "Silicon", shares: "7" }], usdgCredit: "0", unread: ["a vault"],
    }));
    const balances = () => Promise.resolve({ usdg: "1" });
    const loan = vi.fn(() => Promise.resolve({ state: "ACTIVE", actions: ["reclaim (borrower, before endsAt)"], autoRoll: null, closedBy: null }));
    const g = { ...gage, earnVaults, vaultFreeCash, portfolio, balances, loan } as unknown as Gage;
    const market = await markets(g);
    const { terms } = await gage.capabilities();
    expect(market).toMatchObject({ network: "mainnet", terms: terms.map((t) => `${t.days} days`), lends: ["USDG"], collateral: ["NVDAx"], vaults: ["Silicon"], freeCash: { freeCashUSDG: "5" } });
    expect(vaultFreeCash).toHaveBeenCalledWith({ vault: VAULT });
    expect(await wallet(g, WALLET)).toMatchObject({ loans: [{ loanId: "5", rollsByItself: true }], earn: [{ name: "Silicon" }], unread: ["a vault"], balances: { usdg: "1" } });
    expect(await loanState(g, "5")).toEqual({ state: "ACTIVE", actions: ["reclaim (borrower, before endsAt)"], autoRoll: null, closedBy: null });
    await loanState(g, "5", CORE);
    expect(loan.mock.calls).toEqual([[{ loanId: "5" }], [{ loanId: "5", engine: CORE }]]);
  });

  it("borrow: one click at the lowest cost the vaults accept, listed, funded, collected; the exact quote with a cost of one's own", async () => {
    const gage = mainnet(), signer = fakeSigner();
    expect(await termOf(gage)).toBe(604_800);
    await expect(termOf(gage, 1)).rejects.toThrow("gage offers no 1-day loan now; it offers 7 days, 21 days");
    expect((await collateralOf(gage, "nvdax")).token).toBe(NVDA);
    await expect(collateralOf(gage, "NVDAx", GLDX)).rejects.toThrow("gage takes no NVDAx as collateral now");
    const borrowQuote = vi.fn((i: unknown) => {
      const q = parseInput(borrowQuoteInput, i);
      return Promise.resolve({ summary: "Pledge 1.5 NVDAx…", prepare: { action: "borrow", token: q.token, collateral: q.maxCollateral, principal: "500000000", cap: "504000000", term: q.term } });
    });
    const run = checkedRun({ loan: { loanId: "9", engine: CORE } }, {});
    const waitForFill = vi.fn(() => Promise.resolve({ status: "funded" }));
    const answer = await borrow({ ...gage, borrowQuote, run, waitForFill } as unknown as Gage, signer, "NVDAx", "1.5");
    expect(borrowQuote).toHaveBeenCalledWith({ token: NVDA, maxCollateral: parseUnits("1.5", 18).toString(), term: 604_800, wallet: WALLET });
    expect(run.mock.calls.map(([input]) => input)).toEqual([
      { action: "borrow", token: NVDA, collateral: parseUnits("1.5", 18).toString(), principal: "500000000", cap: "504000000", term: 604_800 }, { action: "collect" },
    ]);
    expect(waitForFill).toHaveBeenCalledWith({ loanId: "9", engine: CORE });
    expect(answer.funded).toEqual({ status: "funded" });
    // A listing still waiting is not collected.
    const waiting = await borrow({ ...gage, borrowQuote, run: checkedRun({ loan: { loanId: "9", engine: CORE } }), waitForFill: () => Promise.resolve({ status: "waiting" }) } as unknown as Gage, signer, "NVDAx", "1");
    expect(waiting.collected).toBeNull();

    const exact = { summary: "Pledge 1 NVDAx…", costBps: 0.5, modelCostBps: 0.6, grade: "B", grades: [], fundsNow: true, waitsFor: null, lowestAcceptedCostBps: 0.3, largestAccepted: "9", prepare: { action: "borrow" } };
    const exactCalls = vi.fn((i: unknown) => { parseInput(borrowQuoteInput, i); return Promise.resolve(exact); });
    const input = { token: NVDA, collateral: "1000000000000000000", principal: "500000000", term: 604_800, costBps: 0.5 };
    expect(await exactQuote({ ...gage, borrowQuote: exactCalls } as unknown as Gage, input)).toMatchObject({ grade: "B", fundsNow: true, lowestAcceptedCostBps: 0.3 });
    expect(exactCalls).toHaveBeenCalledWith(input);
    await expect(exactQuote({ ...gage, borrowQuote: () => Promise.resolve({ summary: "", prepare: {} }) } as unknown as Gage, input)).rejects.toThrow("An exact quote names collateral and principal");
  });

  it("borrow: a pledge under the token's minimum is quoted again at the minimum its refusal names, by the SDK's own refusal", async () => {
    const gage = mainnet();
    const { assets } = await gage.assets();
    const nvda = assets.find((a) => a.token === NVDA)!;
    const term = await termOf(gage);
    const asked: unknown[] = [];
    // The SDK itself refuses the dust pledge, with the minimum in details; the second ask is stubbed.
    const borrowQuote = (i: { maxCollateral: string }) => { asked.push(i); return i.maxCollateral === "1" ? gage.borrowQuote({ token: NVDA, maxCollateral: "1", term }) : Promise.resolve({ summary: "at the minimum" }); };
    expect(await quoteAtLeastMinimum({ ...gage, borrowQuote } as unknown as Gage, { token: NVDA, maxCollateral: "1", term })).toEqual({ summary: "at the minimum" });
    expect(asked).toEqual([{ token: NVDA, maxCollateral: "1", term }, { token: NVDA, maxCollateral: nvda.minAmount, term }]);
    const other = () => Promise.reject(new Error("down"));
    await expect(quoteAtLeastMinimum({ ...gage, borrowQuote: other }, { token: NVDA, maxCollateral: "1", term })).rejects.toThrow("down");
  });

  it("borrow: a loop at its quoted cost, the quote's own terms passed on", async () => {
    const signer = fakeSigner();
    const leverageQuote = vi.fn((i: unknown) => {
      const q = parseInput(leverageQuoteInput, i);
      return Promise.resolve({ summary: "Put in 1 NVDAx, hold 2…", maxPurchaseCostUSDG: "180000000", prepare: { action: "leverage", token: q.token, own: q.own, multiple: q.multiple, term: q.term, maxCostBps: 60 } });
    });
    const run = checkedRun({ loan: { loanId: "12", engine: CORE } });
    const looped = await loop({ ...mainnet(), leverageQuote, run } as unknown as Gage, signer, NVDA, "1000000000000000000", 2, 604_800);
    expect(leverageQuote).toHaveBeenCalledWith({ token: NVDA, own: "1000000000000000000", multiple: 2, term: 604_800, wallet: WALLET });
    expect(run).toHaveBeenCalledWith({ action: "leverage", token: NVDA, own: "1000000000000000000", multiple: 2, term: 604_800, maxCostBps: 60 }, signer);
    expect(looped).toMatchObject({ most: "180000000", loan: { loanId: "12" } });
  });

  it("loan: acts only on what loan().actions offers here, on the loan's own core", async () => {
    expect(offers(["reclaim (borrower, before endsAt)", "cash_out on gage.cash (borrower, before endsAt)", "auto_roll"], "reclaim")).toBe(true);
    expect(offers(["cash_out on gage.cash (borrower, before endsAt)"], "cash_out")).toBe(false);
    expect(offers(["auto_roll"], "auto_roll")).toBe(true);
    const signer = fakeSigner();
    const loan = vi.fn((i: { loanId: string }) => Promise.resolve({ engine: GLD_CORE, actions: ["roll (borrower, before endsAt)", "auto_roll (borrower)"], autoRoll: i.loanId === "10" ? { rollsLeft: 4 } : null }));
    const run = checkedRun({ loan: { loanId: "10", engine: GLD_CORE } });
    const g = { ...mainnet(), loan, run } as unknown as Gage;
    expect(await manageLoan(g, signer, "5", { action: "roll", term: 1_814_400 })).toMatchObject({ status: "done", newLoan: { loanId: "10" }, autoRoll: { rollsLeft: 4 } });
    expect(run).toHaveBeenLastCalledWith({ action: "roll", term: 1_814_400, loanId: "5", engine: GLD_CORE }, signer);
    await manageLoan(g, signer, "5", { action: "auto_roll", maxCost: "8000000" }, GLD_CORE);
    expect(run).toHaveBeenLastCalledWith({ action: "auto_roll", maxCost: "8000000", loanId: "5", engine: GLD_CORE }, signer);
    expect(loan).toHaveBeenCalledWith({ loanId: "5", engine: GLD_CORE });
    await expect(manageLoan(g, signer, "5", { action: "cash_out", minNet: "1" })).rejects.toThrow("Loan 5 offers no cash_out here now: roll (borrower, before endsAt); auto_roll (borrower)");
  });

  it("exit-now: the preview first, then a withdrawal and the exit, and what the sales paid collected", async () => {
    const signer = fakeSigner(), exit = { shares: "7", committed: "5", stage: "listed", loanId: "3", listingEndsAt: 2, lapsesAt: 3 };
    const portfolio = vi.fn(() => Promise.resolve({ earn: [{ vault: VAULT, name: "Silicon", shares: "7", exit }], exitOwed: [{ desk: A(0xd1), token: USDG, amount: "5" }] }));
    const prepare = vi.fn((i: unknown) => { parseInput(actionInput, i); return Promise.resolve({ summary: { title: "Exit now" }, preview: { kind: "exit_now" }, next: { label: "Approve shares" }, notes: [] }); });
    const run = checkedRun({});
    const g = { ...mainnet(), portfolio, prepare, run } as unknown as Gage;
    expect(await exitPreview(g, WALLET, VAULT.toLowerCase())).toMatchObject({ exit, preview: { kind: "exit_now" }, next: "Approve shares" });
    expect(prepare).toHaveBeenCalledWith({ action: "earn_exit_now", wallet: WALLET, vault: VAULT.toLowerCase() });
    await expect(exitPreview(g, WALLET, A(0x99))).rejects.toThrow("This wallet holds no shares of that vault");
    expect(await leave(g, signer, VAULT)).toMatchObject({ withdrawn: "done", exited: "done", exit });
    expect(await collectExits(g, signer)).toMatchObject({ status: "done" });
    expect(run.mock.calls.map(([input]) => input)).toEqual([{ action: "earn_redeem", vault: VAULT }, { action: "earn_exit_now", vault: VAULT }, { action: "earn_exit_collect" }]);
    expect(await collectExits({ ...g, portfolio: () => Promise.resolve({ earn: [] }) } as unknown as Gage, signer)).toBeNull();
  });

  it("put: found among the lend assets with a put router, opened at its quote, closed out of its pledge", async () => {
    const gage = gageFrom(ctx({ d: parseDeployment(putManifest()) })), signer = fakeSigner();
    const asset = await putAsset(gage, "gldx");
    expect(asset).toMatchObject({ token: GLDX, core: GLD_CORE });
    await expect(putAsset(mainnet(), "GLDx")).rejects.toThrow("gage offers no put on GLDx now");
    const putQuote = vi.fn((i: unknown) => {
      const q = parseInput(putQuoteInput, i);
      return Promise.resolve({ summary: "Put in 100 USDG…", prepare: { action: "put_open", lendAsset: q.lendAsset, margin: q.margin, size: q.size, term: q.term, maxCostBps: 120 } });
    });
    const run = checkedRun({ loan: { loanId: "4", engine: GLD_CORE } });
    const opened = await openPut({ ...gage, putQuote, run } as unknown as Gage, signer, "GLDx", "100", 4);
    expect(putQuote).toHaveBeenCalledWith({ lendAsset: GLDX, margin: "100000000", size: 4, term: asset.terms[0]!.seconds, wallet: WALLET });
    expect(run).toHaveBeenCalledWith({ action: "put_open", lendAsset: GLDX, margin: "100000000", size: 4, term: asset.terms[0]!.seconds, maxCostBps: 120 }, signer);
    expect(opened.loan).toEqual({ loanId: "4", engine: GLD_CORE });
    await closePut({ ...gage, run } as unknown as Gage, signer, "4", GLD_CORE, "90000000");
    expect(run).toHaveBeenLastCalledWith({ action: "put_close", loanId: "4", engine: GLD_CORE, minBack: "90000000" }, signer);
  });

  it("lp: the wallet's positions the lane takes, a loan at its quote, a repayment and a deposit into an LP vault", async () => {
    const gage = gageFrom(ctx({ d: parseDeployment(lpFablesManifest({ public: true })) })), signer = fakeSigner();
    const lpPositions = () => Promise.resolve({ positions: [{ adapter: UNI_ADAPTER, tokenId: "8", poolName: "WETH/USDG", borrowable: false, refusal: "RANGE_TOO_NARROW" }, { adapter: UNI_ADAPTER, tokenId: "9", poolName: "WETH/USDG", borrowable: true, refusal: null }] });
    const lpVaults = () => Promise.resolve({ vaults: [{ vault: A(0x102), name: "Closed", takesDeposits: false }, { vault: A(0x141), name: "Open", takesDeposits: true }] });
    const lpQuote = vi.fn((i: unknown) => {
      const q = parseInput(lpQuoteInput, i);
      return Promise.resolve({ summary: "Borrow 900 USDG…", prepare: { action: "lp_borrow", adapter: q.adapter, tokenId: q.tokenId, term: q.term, maxCostBps: 90 } });
    });
    const run = checkedRun({ loan: { loanId: "1", engine: A(0x100) } });
    const g = { ...gage, lpPositions, lpVaults, lpQuote, run } as unknown as Gage;
    const overview = await lpOverview(g, WALLET);
    expect(overview).toMatchObject({ borrowable: [{ tokenId: "9" }], refused: [{ tokenId: "8", refusal: "RANGE_TOO_NARROW" }], fablesReceipts: [] });
    expect(overview.terms.length).toBeGreaterThan(0);
    await borrowAgainstPosition(g, signer);
    expect(lpQuote).toHaveBeenCalledWith({ adapter: UNI_ADAPTER, tokenId: "9", wallet: WALLET, term: overview.terms[0] });
    expect(run).toHaveBeenCalledWith({ action: "lp_borrow", adapter: UNI_ADAPTER, tokenId: "9", term: overview.terms[0], maxCostBps: 90 }, signer);
    await repayLpLoan(g, signer, "1");
    expect(run).toHaveBeenLastCalledWith({ action: "lp_repay", loanId: "1" }, signer);
    await lendToLpVault(g, signer, A(0x141), "50000000");
    expect(run).toHaveBeenLastCalledWith({ action: "lp_deposit", vault: A(0x141), amount: "50000000" }, signer);
    await expect(lendToLpVault(g, signer, A(0x142), "1")).rejects.toThrow("That LP vault takes no deposits now");
    await expect(lpOverview(mainnet(), WALLET)).rejects.toMatchObject({ code: "LP_CLOSED" });
  });

  it("generations: each lend asset with its terms, collateral and vaults; a quote paid out in one", async () => {
    const gage = gageFrom(ctx({ d: parseDeployment(putManifest()) }));
    const earnVaults = () => Promise.resolve({ vaults: [{ name: "Gold", asset: { token: GLDX } }, { name: "Silicon", asset: { token: USDG } }] });
    const borrowQuote = vi.fn((i: unknown) => { parseInput(borrowQuoteInput, i); return Promise.resolve({ summary: "Pledge…", prepare: { action: "borrow" } }); });
    const g = { ...gage, earnVaults, borrowQuote } as unknown as Gage;
    const [gold] = await lendMarkets(g);
    expect(gold).toMatchObject({ symbol: "GLDx", token: GLDX, puts: true, vaults: ["Gold"] });
    expect(gold!.collateral.length).toBeGreaterThan(0);
    const { assets } = await gage.assets();
    const row = assets.find((a) => "asset" in a && a.asset.token === GLDX)!;
    await quoteIn(g, "gldx", row.symbol, "2");
    expect(borrowQuote).toHaveBeenCalledWith({ token: row.token, maxCollateral: parseUnits("2", row.decimals).toString(), term: expect.any(Number) as number, lendAsset: GLDX });
    await expect(quoteIn(g, "frxUSD", row.symbol, "2")).rejects.toThrow("gage lends no frxUSD now");
  });

  it("park: the parkable positions, a park and an unpark each sent as one batch, the settle first where a vault needs one", async () => {
    const gage = mainnet();
    const parkPositions = vi.fn(() => Promise.resolve({ positions: [
      { manager: A(0x106), id: "1", poolName: "ETH/USDG", holds: { symbol: "WETH" }, vaults: [], refusal: "ETH_NOT_SUPPORTED" },
      { manager: A(0x106), id: "2", poolName: "ETH/USDG", holds: { symbol: "USDG" }, vaults: [{ vault: VAULT, name: "Silicon" }], refusal: null },
    ] }));
    const call = { label: "Pull", kind: "action", final: false, to: A(0x106), data: "0x01", value: 0n };
    const batches = [{ calls: [call], summary: { title: "Settle" }, again: true }, { calls: [call, call], summary: { title: "Park" } }];
    const parkCalls = vi.fn((i: object) => { parseInput(actionInput, { ...i, action: "park" }); return Promise.resolve(batches.shift()); });
    const unparkCalls = vi.fn((i: object) => { parseInput(actionInput, { ...i, action: "unpark" }); return Promise.resolve({ calls: [call], summary: { title: "Unpark" } }); });
    const sendCalls = vi.fn(() => Promise.resolve());
    const g = { ...gage, parkPositions, parkCalls, unparkCalls } as unknown as Gage;
    expect((await parkable(g, WALLET)).map((p) => p.refusal)).toEqual(["ETH_NOT_SUPPORTED", null]);
    await expect(park(g, WALLET, sendCalls, A(0x143))).rejects.toThrow("No out-of-range position of this wallet parks into that vault now");
    expect(parkCalls).not.toHaveBeenCalled();
    expect(await park(g, WALLET, sendCalls, VAULT)).toEqual({ summary: { title: "Park" }, calls: 2 });
    expect(parkCalls).toHaveBeenCalledTimes(2);
    expect(parkCalls).toHaveBeenCalledWith({ wallet: WALLET, manager: A(0x106), id: "2", vault: VAULT });
    expect(sendCalls).toHaveBeenNthCalledWith(1, { calls: [{ to: A(0x106), data: "0x01", value: 0n }] });
    const at = { vault: VAULT, manager: A(0x106), pool: A(0x10a), tickLower: -199_380, tickUpper: -197_370 };
    expect(await unpark(g, WALLET, sendCalls, at)).toEqual({ summary: { title: "Unpark" }, calls: 1 });
    expect(unparkCalls).toHaveBeenCalledWith({ wallet: WALLET, ...at });
  });

  it("sign-yourself: prepare, send, wait, prepare again, until the action itself is mined", async () => {
    const tx = { from: WALLET, to: USDG, data: "0x", value: "0", chainId: 4663, gas: "1" };
    const plans = [
      { status: "approval_required", next: { label: "Approve USDG", final: false, transaction: tx }, summary: { title: "Deposit" } },
      { status: "ready", next: { label: "Settle the vault's loans", final: true, transaction: tx }, again: true, summary: { title: "Deposit" } },
      { status: "ready", next: { label: "Deposit", final: true, transaction: tx }, summary: { title: "Deposit" } },
      { status: "done", next: null, summary: { title: "Deposit" } },
    ];
    const prepare = vi.fn((i: unknown) => { parseInput(actionInput, i); return Promise.resolve(plans.shift()); });
    const hashes: `0x${string}`[] = [];
    const wallet: Wallet = {
      sendTransaction: vi.fn(() => { const hash = `0x${String(hashes.length + 1).padStart(64, "0")}` as const; hashes.push(hash); return Promise.resolve(hash); }),
      waitForReceipt: vi.fn(() => Promise.resolve({ status: "success" as const })),
    };
    const input = { action: "earn_deposit", wallet: WALLET, vault: VAULT, amount: "10000000" };
    const done = await signYourself({ ...mainnet(), prepare } as unknown as Gage, wallet, input);
    expect(done.status).toBe("done");
    expect(done.sent.map((s) => s.label)).toEqual(["Approve USDG", "Settle the vault's loans", "Deposit"]);
    // The deposit was the action itself: nothing is prepared after it.
    expect(prepare).toHaveBeenCalledTimes(3);
    const reverting: Wallet = { ...wallet, waitForReceipt: () => Promise.resolve({ status: "reverted" as const }) };
    const once = vi.fn(() => Promise.resolve({ status: "ready", next: { label: "Deposit", final: true, transaction: tx }, summary: {} }));
    expect((await signYourself({ ...mainnet(), prepare: once } as unknown as Gage, reverting, input)).status).toBe("reverted");
    const batch = () => Promise.resolve({ status: "ready", next: { label: "Pull", final: false, transaction: tx }, calls: [], summary: {} });
    await expect(signYourself({ ...mainnet(), prepare: batch } as unknown as Gage, wallet, input)).rejects.toThrow("This action's calls go together");
  });

  it("spend-limit: counts USDG put into loans and vaults, refuses past either ceiling, and gives back what never went out", async () => {
    const view = (v: object) => v as View;
    expect(counted(view({ action: "borrow", principal: "5" }), USDG)).toBe(5n);
    expect(counted(view({ action: "borrow", principal: "5", asset: { token: GLDX } }), USDG)).toBe(0n);
    expect(counted(view({ action: "roll", principal: "7", oldPrincipal: "5" }), USDG)).toBe(2n);
    expect(counted(view({ action: "earn_deposit", amount: "3", asset: { token: USDG.toLowerCase() } }), USDG)).toBe(3n);
    expect(counted(view({ action: "park", amount: "4", token: USDG }), USDG)).toBe(4n);
    expect(counted(view({ action: "reclaim" }), USDG)).toBe(0n);
    let now = 0;
    const limit = usdgLimit(USDG, 100n, 150n, () => now);
    expect(() => limit(view({ action: "borrow", principal: "101" }))).toThrow("Over this agent's limit for one action");
    const first = await limit(view({ action: "borrow", principal: "100" }));
    expect(() => limit(view({ action: "lp_deposit", amount: "60" }))).toThrow("Over this agent's limit for 24 hours");
    await first.release(false);
    await (await limit(view({ action: "lp_deposit", amount: "60" }))).release(true);
    now = 86_400_001;
    await limit(view({ action: "borrow", principal: "100" }));
    const tools = limitedTools(mainnet(), fakeSigner());
    expect(tools.some((t) => t.name === "gage_borrow" && t.annotations.destructiveHint)).toBe(true);
  });

  it("hosted-review: a prepare over HTTP answered with its review link, and a read", async () => {
    const asked: { url: string; body?: unknown }[] = [];
    const fetcher = vi.fn((url: string, init?: { body?: string }) => {
      const body = init?.body === undefined ? undefined : JSON.parse(init.body) as unknown;
      asked.push({ url, body });
      // The hosted service checks the body against the same schema gage-sdk's prepare takes.
      if (body !== undefined) parseInput(actionInput, body);
      const answer = url.endsWith("/v1/assets") ? { assets: [{ symbol: "NVDA" }] } : { status: "ready", summary: { title: "Collect" }, review: { url: "https://gage.cash/review#abc", expiresAt: 9 } };
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    });
    expect(await prepareForReview({ action: "collect", wallet: WALLET }, fetcher as unknown as typeof fetch)).toEqual({ status: "ready", title: "Collect", review: "https://gage.cash/review#abc", expiresAt: 9 });
    expect(asked[0]).toEqual({ url: `${HOSTED}/v1/prepare`, body: { action: "collect", wallet: WALLET } });
    expect((await hostedAssets(fetcher as unknown as typeof fetch)).assets[0]!.symbol).toBe("NVDA");
    const refused = () => Promise.resolve(new Response(JSON.stringify({ error: { code: "ACTION_NOT_SERVED", message: "This service does not serve roll", retryable: false } }), { status: 400 }));
    await expect(prepareForReview({ action: "roll", wallet: WALLET, loanId: "1" }, refused as unknown as typeof fetch)).rejects.toThrow("ACTION_NOT_SERVED: This service does not serve roll");
  });
});
