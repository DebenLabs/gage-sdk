/**
 * What another team's site needs of gage's answers (D447): the routers it would otherwise hard-code, the terms the partner
 * vaults lend for now, each token's pause, and plans a paused Stock Token cannot block. A paused token cannot move (D213),
 * so a repayment or a cancellation sent with the pickup in one all-or-nothing batch would fail whole, and with no grace a
 * loan that could not be repaid is lost: the plan never carries the pickup while the token is paused.
 */
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { prepareNext } from "../src/prepare.js";
import { assets, capabilities, loan as readLoan, portfolio } from "../src/reads.js";
import {
  A, assetManifest, CASHOUT, CORE, ctx, FACTORY, fakeChain, fakeUpstream, GLD_CORE, loan, mainnetManifest, NOW, NVDA, position, ROLL_ROUTER, ROUTER, rollQuote, USDG, VAULT, WALLET,
} from "../src/testing.js";

const SEVEN = { seconds: 604_800, days: 7 }, TWENTY_ONE = { seconds: 1_814_400, days: 21 };
const vault = (over: Record<string, unknown> = {}) => ({ address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true, ...over });
const vaults = (...items: unknown[]) => fakeUpstream({ "/intent/partners/vaults?": { items, nextCursor: null } });
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof ApiError ? { code: e.code, status: e.status, retryable: e.retryable, message: e.message } : String(e); } };
const paused = (...over: Parameters<typeof fakeChain>) => fakeChain({ tokensPaused: (tokens: readonly string[]) => Promise.resolve(tokens.map(() => true)), ...over[0] });
const running = fakeUpstream({ "/v2/positions/": position("4") });
const labels = (p: { next: { label: string } | null; then: string[] }) => [...(p.next ? [p.next.label] : []), ...p.then];

describe("what a site reads rather than hard-codes", () => {
  it("capabilities names the rollover and cash-out routers beside the core", async () => {
    expect((await capabilities(ctx())).contracts).toEqual({ usdg: USDG, core: CORE, factory: FACTORY, loopRouter: ROUTER, rolloverRouter: getAddress(ROLL_ROUTER), cashoutRouter: CASHOUT });
  });
  it("names each lend asset's routers where its generation has them", async () => {
    const m = assetManifest();
    const named = { ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, rolloverRouter: A(0xb7) } } };
    const caps = await capabilities(ctx({ d: parseDeployment(named) }));
    expect(caps.lendAssets?.[0]).toMatchObject({ core: GLD_CORE, rolloverRouter: A(0xb7), cashoutRouter: getAddress(A(0xf5)) });
    expect((await capabilities(ctx({ d: parseDeployment(m) }))).lendAssets?.[0]).not.toHaveProperty("rolloverRouter");
  });

  describe("each token's terms", () => {
    const row = async (indexer = vaults(vault())) => (await assets(ctx({ indexer }))).assets.find((a) => a.token === NVDA)!;
    it("are those the registry offers and a vault lending against it takes: 21 days is not one where every vault stops at 7", async () => {
      expect((await row()).terms).toEqual([SEVEN, TWENTY_ONE]);
      expect((await row(vaults(vault({ maxLoanTerm: 604_800 })))).terms).toEqual([SEVEN]);
    });
    it("count any vault that lends against it, and no vault that has stopped or names another token", async () => {
      expect((await row(vaults(vault({ maxLoanTerm: 604_800 }), vault({ address: A(0x72), maxLoanTerm: 1_814_400 })))).terms).toEqual([SEVEN, TWENTY_ONE]);
      expect((await row(vaults(vault({ fundingEnabled: false })))).terms).toEqual([]);
      expect((await row(vaults(vault({ assets: [A(0x99)] })))).terms).toEqual([]);
    });
    it("are unread, never none, where the vaults could not be read", async () => {
      const down = fakeUpstream({ "/intent/partners/vaults?": () => ({ status: 503, body: {} }) });
      expect(await row(down)).toMatchObject({ vaults: null, terms: null });
    });
  });

  describe("each token's pause", () => {
    it("is read from the token, a Stock Token's alone", async () => {
      const asked: string[][] = [];
      const chain = fakeChain({ tokensPaused: (tokens: string[]) => { asked.push(tokens); return Promise.resolve(tokens.map(() => true)); } });
      const rows = (await assets(ctx({ chain, indexer: vaults() }))).assets;
      expect(rows.find((a) => a.token === NVDA)).toMatchObject({ paused: true });
      expect(asked).toEqual([[NVDA]]);
    });
    it("is false for a token not paused", async () => {
      expect((await assets(ctx({ indexer: vaults() }))).assets.find((a) => a.token === NVDA)).toMatchObject({ paused: false });
    });
  });

  it("a wallet's loans name their token and term, so a site reads the rest from the chain", async () => {
    const indexer = fakeUpstream({
      "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: [position("9")], nextCursor: null },
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [], nextCursor: null },
    });
    const { loans } = await portfolio(ctx({ indexer }), WALLET);
    expect(loans[0]).toMatchObject({ loanId: "9", token: NVDA, term: 604_800 });
  });
});

describe("a loan while its token is paused", () => {
  const read = (chain: ReturnType<typeof fakeChain>, l = position("7")) => readLoan(ctx({ chain, indexer: fakeUpstream({ "/v2/positions/": l }), valuation: fakeUpstream({}) }), { loanId: "7" });

  it("says so, and offers only what still works: repaying, never a sale or a roll that would move it", async () => {
    const l = await read(paused());
    expect(l.collateralPaused).toBe(true);
    expect(l.actions).toContain("reclaim (holder of the reclaim right, before endsAt)");
    expect(l.actions.filter((a) => a.startsWith("cash_out") || a.startsWith("roll"))).toEqual([]);
    expect((await read(fakeChain())).collateralPaused).toBe(false);
  });
  it("says nothing of a pickup until it can move", async () => {
    const closed = (chain: Record<string, unknown>) => fakeChain({ loan: () => Promise.resolve(loan({ state: 3, collateralBeneficiary: WALLET })), ...chain });
    expect((await read(closed({ tokensPaused: () => Promise.resolve([true]) }))).actions).toEqual([]);
    expect((await read(closed({}))).actions).toEqual(["collect (collateral back to the borrower)"]);
  });
  it("a read that fails is no pause: the actions are said as ever", async () => {
    const l = await read(fakeChain({ tokensPaused: () => Promise.reject(new Error("the node is down")) }));
    expect(l.collateralPaused).toBe(false);
    expect(l.actions).toContain("reclaim (holder of the reclaim right, before endsAt)");
  });

  describe("reclaim", () => {
    const input = { action: "reclaim" as const, wallet: WALLET, loanId: "4" };
    it("repays alone: the repayment is the plan's last step, and says where the collateral stays", async () => {
      const p = await prepareNext(ctx({ indexer: running, chain: paused() }), input);
      expect(labels(p)).toEqual(["Approve USDG", "Repay"]);
      const approved = await prepareNext(ctx({ indexer: running, chain: paused({ allowance: () => Promise.resolve(10n ** 30n) }) }), input);
      expect(approved.next).toMatchObject({ label: "Repay", final: true });
      expect(approved.then).toEqual([]);
      expect(approved.view).toMatchObject({ action: "reclaim", collateralPaused: true });
      expect(approved.notes.join(" ")).toMatch(/paused/);
    });
    it("takes the collateral back as ever when the token is not paused", async () => {
      const p = await prepareNext(ctx({ indexer: running, chain: fakeChain({ allowance: () => Promise.resolve(10n ** 30n) }) }), input);
      expect(p.next).toMatchObject({ label: "Repay", final: false });
      expect(p.then).toEqual(["Receive collateral"]);
      expect(p.view).not.toHaveProperty("collateralPaused");
    });
    it("a read that fails holds up no repayment", async () => {
      const chain = fakeChain({ allowance: () => Promise.resolve(10n ** 30n), tokensPaused: () => Promise.reject(new Error("the node is down")) });
      expect(labels(await prepareNext(ctx({ indexer: running, chain }), input))).toEqual(["Repay", "Receive collateral"]);
    });
    it("once repaid, the pickup is refused until the token resumes, and may be asked again", async () => {
      const repaid = { loan: () => Promise.resolve(loan({ state: 3, collateralBeneficiary: WALLET })) };
      expect(await refusal(prepareNext(ctx({ indexer: running, chain: paused(repaid) }), input))).toMatchObject({ code: "TOKEN_PAUSED", status: 409, retryable: true });
      expect(labels(await prepareNext(ctx({ indexer: running, chain: fakeChain(repaid) }), input))).toEqual(["Receive collateral"]);
    });
  });

  describe("cancel", () => {
    const listing = fakeUpstream({ "/v2/positions/": position("4", {}, { state: 1, fundedAt: 0 }) });
    const waiting = { loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0 })) };
    const input = { action: "cancel" as const, wallet: WALLET, loanId: "4" };
    it("cancels alone: the cancellation is the plan's last step", async () => {
      const p = await prepareNext(ctx({ indexer: listing, chain: paused(waiting) }), input);
      expect(p.next).toMatchObject({ label: "Cancel listing", final: true });
      expect(p.then).toEqual([]);
      expect(p.view).toMatchObject({ action: "cancel", collateralPaused: true });
    });
    it("takes the collateral back as ever when the token is not paused", async () => {
      expect(labels(await prepareNext(ctx({ indexer: listing, chain: fakeChain(waiting) }), input))).toEqual(["Cancel listing", "Receive collateral"]);
    });
    it("once cancelled, the pickup is refused until the token resumes", async () => {
      const cancelled = { loan: () => Promise.resolve(loan({ state: 5, fundedAt: 0, collateralBeneficiary: WALLET })) };
      expect(await refusal(prepareNext(ctx({ indexer: listing, chain: paused(cancelled) }), input))).toMatchObject({ code: "TOKEN_PAUSED", retryable: true });
    });
  });

  describe("roll and cash_out", () => {
    it("are refused by name: each would move the token", async () => {
      const rates = fakeUpstream({ "/intent/roll/quotes/": rollQuote() });
      expect(await refusal(prepareNext(ctx({ indexer: running, chain: paused(), rates }), { action: "roll", wallet: WALLET, loanId: "4" }))).toMatchObject({ code: "TOKEN_PAUSED" });
      expect(await refusal(prepareNext(ctx({ indexer: running, chain: paused(), valuation: fakeUpstream({}) }), { action: "cash_out", wallet: WALLET, loanId: "4" }))).toMatchObject({ code: "TOKEN_PAUSED" });
    });
  });

  describe("collect", () => {
    const idx = (l: Record<string, unknown>) => fakeUpstream({
      "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: [position("9", {}, l)], nextCursor: null },
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [], nextCursor: null },
    });
    const input = { action: "collect" as const, wallet: WALLET };
    it("leaves a paused token's pickup out, says so, and still gathers the rest", async () => {
      const chain = paused({ loan: () => Promise.resolve(loan({ state: 3, collateralBeneficiary: WALLET })), cashCredit: () => Promise.resolve(3_000_000n) });
      const p = await prepareNext(ctx({ indexer: idx({ state: 3, collateralBeneficiary: WALLET }), chain }), input);
      expect(labels(p).filter((l) => l === "Receive collateral")).toEqual([]);
      expect(labels(p).filter((l) => l.startsWith("Receive 3.00 USDG"))).not.toEqual([]);
      expect(p.view).toMatchObject({ action: "collect", collateral: [] });
      expect(p.notes.join(" ")).toMatch(/paused: NVDAx/);
    });
    it("does not cancel an expired listing whose token cannot come back yet", async () => {
      const chain = paused({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0, fundingDeadline: NOW - 1 })) });
      const p = await prepareNext(ctx({ indexer: idx({ state: 1, fundingDeadline: NOW - 1 }), chain }), input);
      expect(labels(p)).toEqual([]);
      expect(p.status).toBe("done");
      expect(p.notes.join(" ")).toMatch(/paused/);
    });
    it("takes it back as ever when the token is not paused", async () => {
      const chain = fakeChain({ loan: () => Promise.resolve(loan({ state: 3, collateralBeneficiary: WALLET })), cashCredit: () => Promise.resolve(0n) });
      expect(labels(await prepareNext(ctx({ indexer: idx({ state: 3, collateralBeneficiary: WALLET }), chain }), input))).toContain("Receive collateral");
    });
  });
});

describe("what is not a Stock Token", () => {
  it("is never read as paused: another token's paused() may mean anything, and would hide its pickup from every plan", async () => {
    const asked: unknown[] = [];
    const meme = A(0x99);
    const chain = fakeChain({ tokensPaused: (t: unknown[]) => { asked.push(t); return Promise.resolve([true]); }, allowance: () => Promise.resolve(10n ** 30n), loan: () => Promise.resolve(loan({ token: meme })) });
    const p = await prepareNext(ctx({ indexer: running, chain }), { action: "reclaim", wallet: WALLET, loanId: "4" });
    expect(labels(p)).toEqual(["Repay", "Receive collateral"]);
    expect(asked).toEqual([]);
  });
});

describe("a 1-day loan", () => {
  it("rolls on gage.cash, on mainnet: its one approval is its auto-settle, which a roll's would take the place of", async () => {
    const chain = fakeChain({ loan: () => Promise.resolve(loan({ term: 86_400 })) });
    const main = parseDeployment(mainnetManifest());
    const p = prepareNext(ctx({ d: main, indexer: running, chain, rates: fakeUpstream({ "/intent/roll/quotes/": rollQuote() }) }), { action: "roll", wallet: WALLET, loanId: "4", term: 604_800 });
    expect(await refusal(p)).toMatchObject({ code: "ROLLOVER_CLOSED" });
  });
});

describe("a roll's signed plan", () => {
  const index = fakeUpstream({ "/v2/positions/": position("4"), "/v2/positions?": { items: [position("4")], nextCursor: null } });
  const approved = { allowance: () => Promise.resolve(10n ** 30n), approvedForAll: () => Promise.resolve(true) };
  const roll = (chain: ReturnType<typeof fakeChain>) => prepareNext(ctx({ indexer: index, chain, rates: fakeUpstream({ "/intent/roll/quotes/": rollQuote() }) }), { action: "roll", wallet: WALLET, loanId: "4" });

  it("is simulated once this node's head reaches its date: a node a moment behind the rates service's would refuse a good plan", async () => {
    const heads: number[] = [];
    // The rates service dated the plan at NOW; this node is a block behind it, then catches up.
    const chain = fakeChain({ ...approved, head: () => { const timestamp = heads.length < 3 ? NOW - 1 : NOW; heads.push(timestamp); return Promise.resolve({ timestamp, number: 1n }); } });
    const p = await roll(chain);
    expect(p.next).toMatchObject({ label: "Roll over", final: true });
    expect(heads.filter((t) => t === NOW - 1).length).toBeGreaterThan(0);
    expect(heads.at(-1)).toBe(NOW);
  });
  it("is simulated at once where the head is there already", async () => {
    let asked = 0;
    const chain = fakeChain({ ...approved, head: () => { asked += 1; return Promise.resolve({ timestamp: NOW, number: 1n }); } });
    const started = Date.now();
    expect((await roll(chain)).next?.label).toBe("Roll over");
    expect(Date.now() - started).toBeLessThan(400);
    expect(asked).toBeGreaterThan(0);
  });
});

describe("a roll's view", () => {
  it("says what its approval comes to, and how many other loans it covers", async () => {
    const standing = { borrower: WALLET, executor: A(0xc0), term: 604_800, window: 21_600, rollsLeft: 1, withRewards: false, until: NOW + 10 ** 7, maxCost: 40_000_000n, maxTopUp: 45_000_000n };
    const indexer = fakeUpstream({
      "/v2/positions/": position("4"),
      "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: [position("4"), position("5", {}, { cap: "2000000000" })], nextCursor: null },
      "/v2/positions?": { items: [], nextCursor: null },
    });
    const chain = fakeChain({
      autoRoll: (_router: string, id: bigint) => Promise.resolve(id === 5n ? standing : null),
      loan: (_core: string, id: bigint) => Promise.resolve(loan(id === 5n ? { cap: 2_000_000_000n } : {})),
      rights: () => Promise.resolve(2n),
    });
    const p = await prepareNext(ctx({ indexer, chain, rates: fakeUpstream({ "/intent/roll/quotes/": rollQuote() }) }), { action: "roll", wallet: WALLET, loanId: "4" });
    expect(p.view).toMatchObject({ action: "roll", allowance: "3010000000", otherAutoRolls: 1 });
  });
  it("is the loan's own repayment where no other loan rolls by itself", async () => {
    const p = await prepareNext(ctx({ indexer: fakeUpstream({ "/v2/positions/": position("4"), "/v2/positions?": { items: [position("4")], nextCursor: null } }), rates: fakeUpstream({ "/intent/roll/quotes/": rollQuote() }) }), { action: "roll", wallet: WALLET, loanId: "4" });
    expect(p.view).toMatchObject({ action: "roll", allowance: "1010000000", otherAutoRolls: 0 });
  });
});
