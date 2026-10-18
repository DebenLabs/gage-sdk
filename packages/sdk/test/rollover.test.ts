import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { engineAbi, rolloverRouterAbi } from "../src/abi.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { prepareNext } from "../src/prepare.js";
import { run } from "../src/run.js";
import { A, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, KEEPER, loan, manifest, NOW, OTHER, position, ROLL_ROUTER, rollQuote, USDG, WALLET } from "../src/testing.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const indexer = () => fakeUpstream({ "/v2/positions/": position("7") });
type Route = (path: string) => { status: number; body: unknown };
const rates = (route: Route = rollQuote()) => fakeUpstream({ "/intent/roll/quotes/": route });
const rollInput = { action: "roll" as const, wallet: WALLET, loanId: "7" };
const ready = { approvedFor: () => Promise.resolve(ROLL_ROUTER), allowance: () => Promise.resolve(10n ** 30n) };

describe("roll", () => {
  it("approves the right and the old repayment exactly, then rolls into a loan of the same size", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), rates: rates() }), rollInput);
    expect(p.status).toBe("approval_required");
    expect(decodeFunctionData({ abi: engineAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "approve", args: [getAddress(ROLL_ROUTER), 7n] });
    expect(p.next!.transaction.to.toLowerCase()).toBe(CORE);
    expect(p.then).toEqual(["Approve USDG", "Roll over"]);
    expect(p.view).toMatchObject({
      action: "roll", loanId: "7", oldPrincipal: "1000000000", oldCap: "1010000000", principal: "1000000000", cap: "1008000000", term: 604_800,
      fee: "10000000", payout: "990000000", topUp: "20000000", surplus: "0",
    });
    expect(p.summary.title).toBe("Roll loan #7 over into a new 7 days loan");
    expect(p.summary.rows).toContainEqual({ label: "From your wallet", value: "20.00 USDG" });
    expect(p.summary.rows).toContainEqual({ label: "You repay within 7 days", value: "1,008.00 USDG" });
    expect(p.summary.rows).toContainEqual({ label: "If you don't repay", value: "The lenders keep the 5 NVDAx. Nothing else is taken, and the loan is never closed early." });
  });

  it("asks for the USDG at the old repayment, to the unit, once the right is approved", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), rates: rates(), chain: fakeChain({ approvedFor: () => Promise.resolve(ROLL_ROUTER) }) }), rollInput);
    expect(p.next!.transaction.to.toLowerCase()).toBe(USDG);
    expect(decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args).toEqual([getAddress(ROLL_ROUTER), 1_010_000_000n]);
  });

  it("signs nothing itself: the roll carries the service's plans and holds the router to the top-up planned", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), rates: rates(), chain: fakeChain(ready) }), rollInput);
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "Roll over", final: true });
    expect(p.next!.transaction.to.toLowerCase()).toBe(ROLL_ROUTER);
    const roll = decodeFunctionData({ abi: rolloverRouterAbi, data: p.next!.transaction.data });
    expect(roll.functionName).toBe("roll");
    const [r, plans, signatures, shares] = roll.args as unknown as [{ loanId: bigint; maxTopUp: bigint; withRewards: boolean }, { listingId: bigint }[], string[], bigint[]];
    expect(r).toMatchObject({ loanId: 7n, maxTopUp: 20_000_000n, withRewards: false });
    expect(plans.map((x) => x.listingId)).toEqual([9n, 10n, 11n]);
    expect(signatures).toHaveLength(3);
    expect(shares).toEqual([7n]);
  });

  it("is refused before anything is planned where it cannot run", async () => {
    const c = (over: Parameters<typeof fakeChain>[0] = {}, route: Route = rollQuote()) => ctx({ indexer: indexer(), rates: rates(route), chain: fakeChain(over) });
    expect(await code(prepareNext(c({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0 })) }), rollInput))).toBe("NOT_ROLLABLE");
    expect(await code(prepareNext(c({ ownerOf: () => Promise.resolve(OTHER), loan: () => Promise.resolve(loan({ originator: OTHER })) }), rollInput))).toBe("NOT_YOUR_LOAN");
    expect(await code(prepareNext(c({ loan: () => Promise.resolve(loan({ fundedAt: NOW - 604_800 })) }), rollInput))).toBe("TERM_ENDED");
    expect(await code(prepareNext(c({ rolloverPaused: () => Promise.resolve(true) }), rollInput))).toBe("ROLLOVER_PAUSED");
    expect(await code(prepareNext(c(), { ...rollInput, term: 86_400 }))).toBe("TERM_NOT_ALLOWED");
    expect(await code(prepareNext(c({ balance: () => Promise.resolve(0n) }), rollInput))).toBe("INSUFFICIENT_BALANCE");
    // A quote for another size is not this roll: a roll keeps the loan's principal, as a roll by itself must.
    expect(await code(prepareNext(c({}, rollQuote({ principal: 1_200_000_000n, cap: 1_210_000_000n })), rollInput))).toBe("PLAN_MISMATCH");
    const refused = () => ({ status: 409, body: { schema: "gage-intent-roll-quote-v1", status: "refused", refusal: { code: "LOAN_NOT_ACTIVE", reason: "The loan is not running" }, unsigned: null, router: ROLL_ROUTER, terms: null, wallet: null, authorization: null } });
    expect(await code(prepareNext(c({}, refused), rollInput))).toBe("LOAN_NOT_ACTIVE");
    const closed = parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, rolloverRouter: A(0) } });
    expect(await code(prepareNext(ctx({ d: closed, indexer: indexer(), rates: rates() }), rollInput))).toBe("ROLLOVER_CLOSED");
  });

  it("stops before sending a roll that costs more than was planned", async () => {
    let asked = 0;
    const dearer = (path: string) => rollQuote({ cap: (asked += 1) > 1 ? 1_009_000_000n : 1_008_000_000n })(path);
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: indexer(), rates: rates(dearer), chain: fakeChain(ready) }), rollInput, signer);
    expect(r.status).toBe("stopped");
    expect(r.error?.code).toBe("PRICE_MOVED");
    expect(signer.sent).toHaveLength(0);
  });

  it("names the new loan from the roll's own receipt", async () => {
    const rolled: Log = {
      address: ROLL_ROUTER, removed: false, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null,
      data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint32" }, { type: "uint256" }],
        [WALLET, 1_010_000_000n, 1_000_000_000n, 1_008_000_000n, 604_800, 20_000_000n]),
      topics: encodeEventTopics({ abi: rolloverRouterAbi, eventName: "Rolled", args: { oldId: 7n, newId: 12n, borrower: WALLET } }) as [Hex, ...Hex[]],
    };
    const chain = fakeChain({ ...ready, sent: () => Promise.resolve({ from: WALLET, to: ROLL_ROUTER, input: "0x", success: true, logs: [rolled] }) });
    const r = await run(ctx({ indexer: indexer(), rates: rates(), chain }), rollInput, fakeSigner());
    expect(r).toMatchObject({ status: "done", loan: { engine: getAddress(CORE), loanId: "12" } });
  });

  it("says a roll by hand ends the loan's instruction to roll by itself", async () => {
    const standing = { borrower: WALLET, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 3, withRewards: false, until: NOW + 10 ** 7, maxCost: 40_000_000n, maxTopUp: 40_000_000n };
    const p = await prepareNext(ctx({ indexer: indexer(), rates: rates(), chain: fakeChain({ ...ready, autoRoll: () => Promise.resolve(standing) }) }), rollInput);
    expect(p.notes).toContain("Rolling by hand ends this loan's instruction to roll by itself.");
  });
});

describe("auto_roll", () => {
  const input = { action: "auto_roll" as const, wallet: WALLET, loanId: "7" };

  it("lets the router follow the wallet's loans, approves four rolls' repayments, then leaves the instruction for gage's keeper", async () => {
    const quotes = rates();
    const p = await prepareNext(ctx({ indexer: indexer(), rates: quotes }), input);
    expect(decodeFunctionData({ abi: engineAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "setApprovalForAll", args: [getAddress(ROLL_ROUTER), true] });
    expect(p.then).toEqual(["Approve USDG", "Turn on rolling by itself"]);
    // A roll of this loan costs 8 USDG of fixed cost and the new loan's 10 USDG fee now, quoted as a roll by hand is
    // (`/intent/roll/quotes`, the same term): the ceiling starts at twice that, as gage.cash's starts it.
    expect(quotes.asked).toEqual([`/intent/roll/quotes/${CORE}?loan=7&borrower=${WALLET.toLowerCase()}&term=604800&count=3`]);
    expect(p.view).toMatchObject({ action: "auto_roll", maxCost: "36000000", maxTopUp: "36000000", rolls: 4, window: 21_600, executor: getAddress(KEEPER), allowance: "4118000000" });
    expect(p.summary.rows).toContainEqual({ label: "Approvals that stay", value: "gage's rollover router may move your loans on this core and spend up to 4,118.00 USDG for their repayments, until you withdraw them in your wallet" });
    expect(p.notes).toContain("The ceiling is twice what a roll of this loan costs now: 18.00 USDG, its fixed cost and fee together.");
    const done = await prepareNext(ctx({ indexer: indexer(), chain: fakeChain({ approvedForAll: () => Promise.resolve(true), allowance: () => Promise.resolve(10n ** 30n) }) }), { ...input, maxCost: "25000000" });
    const set = decodeFunctionData({ abi: rolloverRouterAbi, data: done.next!.transaction.data });
    const end = NOW - 3600 + 604_800;
    expect(set).toMatchObject({ functionName: "setAutoRoll", args: [7n, getAddress(KEEPER), 604_800, 21_600, 25_000_000n, 25_000_000n, 4, false, end + 4 * 604_800 + 86_400] });
    expect(done.next!.final).toBe(true);
  });

  it("names the ceiling it is given without asking for a quote, and refuses to start one when no roll can be quoted now", async () => {
    const quotes = rates();
    const given = await prepareNext(ctx({ indexer: indexer(), rates: quotes }), { ...input, maxCost: "25000000" });
    expect(given.view).toMatchObject({ maxCost: "25000000" });
    expect(quotes.asked).toEqual([]);
    // No quote, no ceiling guessed from this loan's own cost: the roll's own refusal.
    const refused = () => ({ status: 409, body: { schema: "gage-intent-roll-quote-v1", status: "refused", refusal: { code: "TOO_LATE", reason: "Too close to the end of the term" }, unsigned: null, router: ROLL_ROUTER, terms: null, wallet: null, authorization: null } });
    expect(await code(prepareNext(ctx({ indexer: indexer(), rates: rates(refused) }), input))).toBe("TOO_LATE");
    expect(await code(prepareNext(ctx({ indexer: indexer() }), input))).toBe("RATES_UNAVAILABLE");
  });

  // The quote comes from the rates service: the default ceiling is held to four times this loan's own cost, read from the
  // chain, so an answer out of line widens neither the ceiling nor the approvals that stay. Above that the agent names
  // maxCost, and a ceiling it names is never more than the loan's principal.
  it("holds the default ceiling to four times the loan's own cost, and an agent's to the loan's principal", async () => {
    // Today 50 USDG (40 of fixed cost, the 10 USDG fee): twice is 100, held to 80, four times this loan's 20.
    const high = await prepareNext(ctx({ indexer: indexer(), rates: rates(rollQuote({ cap: 1_040_000_000n })) }), input);
    expect(high.view).toMatchObject({ maxCost: "80000000", allowance: String(1_010_000_000n + 3n * (1_000_000_000n + 80_000_000n)) });
    expect(await code(prepareNext(ctx({ indexer: indexer(), rates: rates(rollQuote({ cap: 1_500_000_000n })) }), input))).toBe("ROLL_COST_HIGH");
    expect(await code(prepareNext(ctx({ indexer: indexer() }), { ...input, maxCost: "1000000001" }))).toBe("MAX_COST_TOO_HIGH");
    expect((await prepareNext(ctx({ indexer: indexer() }), { ...input, maxCost: "1000000000" })).view).toMatchObject({ maxCost: "1000000000" });
  });

  it("can be left on a listing still waiting for funding, and is refused where no keeper runs it", async () => {
    // No roll of a listing can be quoted: the ceiling starts as gage.cash's Borrow ticket starts it, at twice this loan's
    // own fixed cost and fee.
    const quotes = rates();
    const funding = await prepareNext(ctx({ indexer: indexer(), rates: quotes, chain: fakeChain({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0 })) }) }), input);
    expect(funding.view).toMatchObject({ action: "auto_roll", maxCost: "40000000", until: NOW + 86_400 + 604_800 + 4 * 604_800 + 86_400 });
    expect(quotes.asked).toEqual([]);
    expect(funding.notes).toContain("The ceiling is twice what this loan costs: 20.00 USDG, its fixed cost and fee together. A listing's roll cannot be quoted until it is funded.");
    const keeperless = parseDeployment({ ...manifest(), rolloverExecutor: undefined });
    expect(await code(prepareNext(ctx({ d: keeperless, indexer: indexer() }), input))).toBe("AUTO_ROLL_CLOSED");
    expect(await code(prepareNext(ctx({ indexer: indexer(), chain: fakeChain({ loan: () => Promise.resolve(loan({ state: 3 })) }) }), input))).toBe("NOT_ROLLABLE");
  });
});

describe("cancel_auto_roll", () => {
  const input = { action: "cancel_auto_roll" as const, wallet: WALLET, loanId: "7" };
  const standing = (borrower = WALLET) => ({ borrower, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 2, withRewards: false, until: NOW + 10 ** 7, maxCost: 1n, maxTopUp: 1n });

  it("ends the instruction the wallet left, in one call", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), chain: fakeChain({ autoRoll: () => Promise.resolve(standing()) }) }), input);
    expect(p.status).toBe("ready");
    expect(decodeFunctionData({ abi: rolloverRouterAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "cancelAutoRoll", args: [7n] });
    expect(p.view).toMatchObject({ action: "cancel_auto_roll", loanId: "7", rollsLeft: 2 });
  });

  it("is refused where the wallet left none", async () => {
    expect(await code(prepareNext(ctx({ indexer: indexer() }), input))).toBe("NO_AUTO_ROLL");
    expect(await code(prepareNext(ctx({ indexer: indexer(), chain: fakeChain({ autoRoll: () => Promise.resolve(standing(OTHER)) }) }), input))).toBe("NO_AUTO_ROLL");
  });
});
