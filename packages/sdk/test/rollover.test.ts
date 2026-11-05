import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Address, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { engineAbi, rolloverRouterAbi } from "../src/abi.js";
import type { Chain, Loan } from "../src/chain.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError, refusalOf } from "../src/errors.js";
import { prepareNext } from "../src/prepare.js";
import { run } from "../src/run.js";
import { A, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, KEEPER, loan, manifest, NOW, OTHER, position, ROLL_ROUTER, rollQuote, USDG, WALLET } from "../src/testing.js";
import type { Upstream } from "../src/upstream.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
// The loan, and the wallet's loans on its core (`/v2/positions?account=`): this one alone.
const indexer = () => fakeUpstream({ "/v2/positions/": position("7"), "/v2/positions?": { items: [position("7")], nextCursor: null } });
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
    // r12 review C8: a ceiling below the 10 USDG fee every roll pays could never run.
    expect(await code(prepareNext(ctx({ indexer: indexer() }), { ...input, maxCost: "9999999" }))).toBe("MAX_COST_TOO_LOW");
    expect((await prepareNext(ctx({ indexer: indexer() }), { ...input, maxCost: "10000000" })).view).toMatchObject({ maxCost: "10000000" });
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

/**
 * The wallet's loans on the core as the index lists them (review R4/F20): this loan (#7, its own instruction four rolls),
 * another rolling by itself with two rolls left (#8), a listing rolling by itself with four (#13), and loans whose
 * instructions need nothing more: one repaid (#9), one whose instruction another wallet left (#10), one whose rolls are
 * spent (#11), one past its date (#12) and one whose right the wallet sold (#14).
 */
const walletList = () => ({
  items: [position("7"), position("8"), position("9", {}, { state: 3 }), position("10"), position("11"), position("12"),
    position("13", {}, { state: 1, fundedAt: 0, principal: "500000000", cap: "505000000" }), position("14", { owner: OTHER })],
  nextCursor: null,
});
/**
 * The core as it holds the wallet's loans, whose word counts (the class of F18): each right's holder by id, none once
 * burnt at a loan's close, every loan running at the fixture's figures unless `figures` says otherwise, and how many
 * rights the wallet holds there.
 */
const holding = (owners: Record<string, Address | null>, figures: Record<string, Partial<Loan>> = {}) => ({
  ownerOf: (_engine: Address, id: bigint) => Promise.resolve(owners[String(id)] ?? null),
  loan: (_engine: Address, id: bigint) => Promise.resolve(loan(figures[String(id)])),
  rights: () => Promise.resolve(BigInt(Object.values(owners).filter((o) => o === WALLET).length)),
});
/** `walletList`'s loans as the core holds them: #9's right burnt at its repayment, #13 a listing of 500 USDG, #14's right another wallet's. */
const LISTED = holding({ 7: WALLET, 8: WALLET, 9: null, 10: WALLET, 11: WALLET, 12: WALLET, 13: WALLET, 14: OTHER }, { 13: { state: 1, fundedAt: 0, principal: 500_000_000n, cap: 505_000_000n } });
const instruction = (over: Record<string, unknown> = {}) =>
  ({ borrower: WALLET, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 2, withRewards: false, until: NOW + 10 ** 7, maxCost: 40_000_000n, maxTopUp: 40_000_000n, ...over });
const standingOn = (by: Record<string, ReturnType<typeof instruction> | null>) => (router: string, id: bigint) =>
  Promise.resolve(router.toLowerCase() === ROLL_ROUTER ? by[String(id)] ?? null : null);
const STANDING = {
  "7": instruction({ rollsLeft: 4 }), "8": instruction(), "9": instruction(), "10": instruction({ borrower: OTHER }), "11": instruction({ rollsLeft: 0 }),
  "12": instruction({ until: NOW - 1 }), "13": instruction({ rollsLeft: 4, maxCost: 30_000_000n }), "14": instruction(),
};
const sharing = () => fakeUpstream({ "/v2/positions/": position("7"), "/v2/positions?": walletList() });
/** What #8 and #13 still need: each one's repayment, then its principal and ceiling for each further roll. */
const OTHERS = (1_010_000_000n + 1n * (1_000_000_000n + 40_000_000n)) + (505_000_000n + 3n * (500_000_000n + 30_000_000n));
/** #7's own four rolls at a ceiling of 25 USDG. */
const OWN_FOUR = 1_010_000_000n + 3n * (1_000_000_000n + 25_000_000n);
const autoInput = { action: "auto_roll" as const, wallet: WALLET, loanId: "7", maxCost: "25000000" };

// Review R4/F20: an approval sets the allowance whole, and every loan of a wallet on a core rolls through the same
// router, so an approval sized for one loan took the budgets of the wallet's other instructions there: their later rolls
// missed with `allowance_short`, and with no grace period the loans defaulted at their ends.
describe("a roll's approval beside the wallet's other loans rolling over by themselves", () => {
  it("approves this loan's four rolls on top of what the wallet's other instructions on the router still need", async () => {
    const p = await prepareNext(ctx({ indexer: sharing(), chain: fakeChain({ ...LISTED, autoRoll: standingOn(STANDING), approvedForAll: () => Promise.resolve(true) }) }), autoInput);
    expect(p.view).toMatchObject({ action: "auto_roll", allowance: String(OWN_FOUR + OTHERS), otherAutoRolls: 2 });
    expect(decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args).toEqual([getAddress(ROLL_ROUTER), OWN_FOUR + OTHERS]);
    expect(p.summary.rows).toContainEqual({ label: "Approvals that stay", value: "gage's rollover router may move your loans on this core and spend up to 8,230.00 USDG for their repayments, until you withdraw them in your wallet" });
    expect(p.notes).toContain("The approval also covers the rolls your 2 other loans rolling over by themselves still need: an approval replaces the one before it.");
  });

  it("approves a roll by hand on top of the other instructions, this loan's own ending with the roll", async () => {
    const p = await prepareNext(ctx({ indexer: sharing(), rates: rates(), chain: fakeChain({ ...LISTED, autoRoll: standingOn(STANDING), approvedFor: () => Promise.resolve(ROLL_ROUTER) }) }), rollInput);
    expect(p.next!.transaction.to.toLowerCase()).toBe(USDG);
    expect(decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args).toEqual([getAddress(ROLL_ROUTER), 1_010_000_000n + OTHERS]);
    expect(p.notes).toContain("The approval also covers the rolls your 2 other loans rolling over by themselves still need: an approval replaces the one before it.");
    const covered = await prepareNext(ctx({ indexer: sharing(), rates: rates(), chain: fakeChain({ ...LISTED, autoRoll: standingOn(STANDING), approvedFor: () => Promise.resolve(ROLL_ROUTER), allowance: () => Promise.resolve(1_010_000_000n + OTHERS) }) }), rollInput);
    expect(covered.status).toBe("ready");
  });

  it("counts a cancelled instruction no more, and asks for a lower approval once the others have ended", async () => {
    // #8's instruction cancelled: #13's alone stays beside this loan's.
    const cancelled = await prepareNext(ctx({ indexer: sharing(), chain: fakeChain({ ...LISTED, autoRoll: standingOn({ ...STANDING, "8": null }), approvedForAll: () => Promise.resolve(true) }) }), autoInput);
    expect(cancelled.view).toMatchObject({ allowance: String(OWN_FOUR + 505_000_000n + 3n * 530_000_000n), otherAutoRolls: 1 });
    // #8's rolls spent and #13 past its date: this loan's own four rolls are all it needs, already approved.
    const ended = await prepareNext(ctx({ indexer: sharing(), chain: fakeChain({ ...LISTED,
      autoRoll: standingOn({ ...STANDING, "8": instruction({ rollsLeft: 0 }), "13": instruction({ until: NOW - 1 }) }), approvedForAll: () => Promise.resolve(true), allowance: () => Promise.resolve(OWN_FOUR),
    }) }), autoInput);
    expect(ended.view).toMatchObject({ allowance: String(OWN_FOUR), otherAutoRolls: 0 });
    expect(ended.notes.some((n) => n.includes("other loans"))).toBe(false);
    expect(decodeFunctionData({ abi: rolloverRouterAbi, data: ended.next!.transaction.data }).functionName).toBe("setAutoRoll");
  });

  it("prepares nothing while the wallet's loans cannot be read: an approval sized without them would take their budgets", async () => {
    const down = fakeUpstream({ "/v2/positions/": position("7"), "/v2/positions?": () => ({ status: 503, body: { error: { code: "INDEXER_BUSY" } } }) });
    expect(await code(prepareNext(ctx({ indexer: down, chain: fakeChain({ autoRoll: standingOn(STANDING) }) }), autoInput))).toBe("UPSTREAM_UNAVAILABLE");
    expect(await code(prepareNext(ctx({ indexer: down, rates: rates(), chain: fakeChain({ autoRoll: standingOn(STANDING) }) }), rollInput))).toBe("UPSTREAM_UNAVAILABLE");
  });
});

/**
 * The class of F18 (the audit of 1 November 2026): the index only names the wallet's loans. Each is read from the core,
 * its figures and its right's holder the chain's, each once, and the list is held to the core's own count of the
 * wallet's rights: a wrong or compromised index could otherwise inflate a cap, add a loan that is not the wallet's,
 * repeat one, or leave one out, and the approval would follow it. One left out would leave the router short, and that
 * loan's roll would miss at the keeper, with no grace (D106).
 */
describe("the loans a roll's approval counts", () => {
  /** What #8's instruction still needs at the core's figures: its repayment, then one new loan's at most. */
  const EIGHT = 1_010_000_000n + 1_000_000_000n + 40_000_000n;
  const listing = (...items: unknown[]) => fakeUpstream({ "/v2/positions/": position("7"), "/v2/positions?": { items, nextCursor: null } });
  /** The core holding the rights `owners` names, with an instruction of the wallet's standing on #8, #10 and #12; this loan's right approved. */
  const chain = (owners: Record<string, Address | null>) => fakeChain({
    ...holding(owners), autoRoll: standingOn({ "7": instruction({ rollsLeft: 4 }), "8": instruction(), "10": instruction(), "12": instruction() }),
    approvedFor: () => Promise.resolve(ROLL_ROUTER), approvedForAll: () => Promise.resolve(true),
  });
  /** What a roll by hand approves to the router, then what `auto_roll` does, besides this loan's own need. */
  const besides = async (indexer: Upstream, c: Chain) => {
    const roll = await prepareNext(ctx({ indexer, rates: rates(), chain: c }), rollInput);
    const auto = await prepareNext(ctx({ indexer, chain: c }), autoInput);
    return [(decodeFunctionData({ abi: erc20Abi, data: roll.next!.transaction.data }).args[1] as bigint) - 1_010_000_000n, BigInt((auto.view as { allowance: string }).allowance) - OWN_FOUR];
  };

  it("counts each loan at the cap and principal the core holds, never the index's", async () => {
    const index = listing(position("7"), position("8", {}, { principal: "10000000000", cap: "10100000000" }));
    expect(await besides(index, chain({ 7: WALLET, 8: WALLET }))).toEqual([EIGHT, EIGHT]);
    // The index is asked only which loans to read: the wallet's, waiting for funding or running.
    expect(index.asked).toContain(`/v2/positions?engine=${CORE}&account=${WALLET.toLowerCase()}&state=funding&limit=100`);
    expect(index.asked).toContain(`/v2/positions?engine=${CORE}&account=${WALLET.toLowerCase()}&state=active&limit=100`);
  });

  it("leaves out a loan whose right another wallet holds, or whose right is burnt, whatever the index says", async () => {
    const index = listing(position("7"), position("8"), position("10"), position("12"));
    expect(await besides(index, chain({ 7: WALLET, 8: WALLET, 10: OTHER, 12: null }))).toEqual([EIGHT, EIGHT]);
  });

  it("counts a loan the index repeats once", async () => {
    const p = await prepareNext(ctx({ indexer: listing(position("7"), position("8"), position("8")), chain: chain({ 7: WALLET, 8: WALLET }) }), autoInput);
    expect(p.view).toMatchObject({ allowance: String(OWN_FOUR + EIGHT), otherAutoRolls: 1 });
  });

  it("approves nothing when the index leaves out a loan whose right the core counts for the wallet", async () => {
    // The wallet holds three rights on the core, this loan's, #8's and #10's; the index names two.
    const index = listing(position("7"), position("8")), c = chain({ 7: WALLET, 8: WALLET, 10: WALLET });
    const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return refusalOf(e); } };
    for (const p of [prepareNext(ctx({ indexer: index, rates: rates(), chain: c }), rollInput), prepareNext(ctx({ indexer: index, chain: c }), autoInput)]) {
      expect(await refused(p)).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: "gage's index does not list every loan this wallet holds on the core now, so nothing is approved; try again shortly", retryable: true });
    }
  });

  it("counts the loan the plan is for though the index does not list it yet", async () => {
    // The wallet holds this loan's right and #8's; the index names #8 alone.
    expect(await besides(listing(position("8")), chain({ 7: WALLET, 8: WALLET }))).toEqual([EIGHT, EIGHT]);
  });
});

describe("cancel_auto_roll", () => {
  const input = { action: "cancel_auto_roll" as const, wallet: WALLET, loanId: "7" };
  const standing = (borrower = WALLET) => ({ borrower, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 2, withRewards: false, until: NOW + 10 ** 7, maxCost: 1n, maxTopUp: 1n });

  it("ends the instruction the wallet left, in one call that approves nothing", async () => {
    const p = await prepareNext(ctx({ indexer: indexer(), chain: fakeChain({ autoRoll: () => Promise.resolve(standing()) }) }), input);
    expect(p.status).toBe("ready");
    expect(decodeFunctionData({ abi: rolloverRouterAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "cancelAutoRoll", args: [7n] });
    // The router's approval stays as it is: the wallet's other instructions still need theirs.
    expect(p.then).toEqual([]);
    expect(p.view).toMatchObject({ action: "cancel_auto_roll", loanId: "7", rollsLeft: 2 });
  });

  it("is refused where the wallet left none", async () => {
    expect(await code(prepareNext(ctx({ indexer: indexer() }), input))).toBe("NO_AUTO_ROLL");
    expect(await code(prepareNext(ctx({ indexer: indexer(), chain: fakeChain({ autoRoll: () => Promise.resolve(standing(OTHER)) }) }), input))).toBe("NO_AUTO_ROLL");
  });
});
