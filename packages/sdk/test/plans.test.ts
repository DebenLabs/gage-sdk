import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { engineAbi, loopRouterAbi, rewardsAbi } from "../src/abi.js";
import type { Call, TickSource } from "../src/chain.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { owed, shares, usdg } from "../src/format.js";
import { prepareNext, type Prepared } from "../src/prepare.js";
import { allocate, preview as readPreview } from "../src/intent.js";
import { assets, earnVaults, leverageQuote } from "../src/reads.js";
import { vaultName } from "../src/data.js";
import { run } from "../src/run.js";
import { A, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, loan, mainnetManifest, manifest, NOW, NVDA, OTHER, POOL, position, preview, REWARDS, ROUTER, signedLoop, STATE_VIEW, swapCall, USDG, V3_POOL, VAULT, WALLET } from "../src/testing.js";
import { poolId, sqrtPriceAtTick } from "../src/v4math.js";

const borrowInput = { action: "borrow" as const, wallet: WALLET, token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 604_800 };
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

describe("deployment", () => {
  it("serves Robinhood Chain and its testnet, and lists on the newest engine, the Intent core", () => {
    expect(() => parseDeployment({ ...manifest(), chainId: 1 })).toThrow(/4663/);
    expect(() => parseDeployment({ ...manifest(), chainId: 4663 })).toThrow(/not public/);
    expect(parseDeployment(mainnetManifest()).chainId).toBe(4663);
    expect(() => parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, core: A(0x21) } })).toThrow(/core/);
    const d = parseDeployment(manifest());
    expect(d.core.engine.toLowerCase()).toBe(CORE);
    // The ETH pool (zero currency) is never a leverage pool.
    expect([...d.pools.keys()]).toEqual([NVDA]);
  });
});

describe("borrow", () => {
  it("asks for the exact collateral approval first, then lists on the core once", async () => {
    const p = await prepareNext(ctx(), borrowInput);
    expect(p.status).toBe("approval_required");
    expect(p.next?.transaction.to.toLowerCase()).toBe(NVDA);
    const approve = decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data });
    expect(approve.args).toEqual([expect.stringMatching(/^0x0+20$/i), 5n * 10n ** 18n]);
    expect(p.then).toEqual(["Borrow"]);
    const ready = await prepareNext(ctx({ chain: fakeChain({ allowance: () => Promise.resolve(10n ** 30n) }) }), borrowInput);
    expect(ready.status).toBe("ready");
    expect(ready.next?.final).toBe(true);
    const list = decodeFunctionData({ abi: engineAbi, data: ready.next!.transaction.data });
    expect(list.functionName).toBe("list");
    expect(list.args.slice(1, 4)).toEqual([1_000_000_000n, 1_010_000_000n, 604_800]);
    expect(list.args[4]).toBe(NOW + 86_400);
  });
  it("says what happens without repayment, in the words of no liquidation", async () => {
    const p = await prepareNext(ctx(), borrowInput);
    expect(p.summary.title).toBe("Borrow 1,000.00 USDG against 5 NVDAx");
    expect(p.summary.rows).toContainEqual({ label: "If you don't repay", value: "The lenders keep the 5 NVDAx. Nothing else is taken, and the loan is never closed early." });
    expect(p.summary.rows).toContainEqual({ label: "You receive", value: "990.00 USDG after the 1% fee" });
  });
  it("refuses what the core would refuse", async () => {
    expect(await code(prepareNext(ctx({ chain: fakeChain({ paused: () => Promise.resolve(true) }) }), borrowInput))).toBe("LISTINGS_PAUSED");
    expect(await code(prepareNext(ctx(), { ...borrowInput, term: 86_400 }))).toBe("TERM_NOT_ALLOWED");
    expect(await code(prepareNext(ctx(), { ...borrowInput, collateral: "1" }))).toBe("COLLATERAL_BELOW_MINIMUM");
    expect(await code(prepareNext(ctx(), { ...borrowInput, cap: "1000000000" }))).toBe("INVALID_TERMS");
    expect(await code(prepareNext(ctx(), { ...borrowInput, token: OTHER }))).toBe("UNSUPPORTED_COLLATERAL");
    expect(await code(prepareNext(ctx({ chain: fakeChain({ balance: () => Promise.resolve(0n) }) }), borrowInput))).toBe("INSUFFICIENT_BALANCE");
  });
  it("gives the review page the figures it draws: the pledge's value from the instant answer, scaled, and whether vaults fund it now", async () => {
    const instant = { schema: "gage-intent-instant-v1", status: "ok", refusal: null, expiresAt: NOW + 30,
      answer: { collateral: "2500000000000000000", valueUSDG: "500000000", principal: "300000000", cap: "303000000", costBps: 100, ltvBps: 6000, binds: "room", room: "0", vaults: 1 } };
    const p = await prepareNext(ctx({ rates: fakeUpstream({ "/intent/preview/": preview(), "/intent/instant/": instant }) }), borrowInput);
    expect(p.view).toMatchObject({ action: "borrow", symbol: "NVDAx", collateral: "5000000000000000000", fee: "10000000", valueUSDG: "1000000000", fundsNow: true });
    const blind = await prepareNext(ctx({ rates: fakeUpstream({ "/intent/preview/": preview(false) }) }), borrowInput);
    expect(blind.view).toMatchObject({ valueUSDG: null, fundsNow: false });
  });
  it("warns when the vaults would not fund it whole", async () => {
    const p = await prepareNext(ctx({ rates: fakeUpstream({ "/intent/preview/": preview(false) }) }), borrowInput);
    expect(p.notes.join(" ")).toMatch(/may stay unfunded/);
  });
});

describe("private loans", () => {
  const cancel = { action: "cancel" as const, wallet: WALLET, loanId: "7" };
  it("are unknown to every loan action, and so is a loan the index cannot tell about", async () => {
    for (const flag of [{ private: true }, { private: undefined }]) {
      const indexer = fakeUpstream({ "/v2/positions/": position("7", flag) });
      expect(await code(prepareNext(ctx({ indexer }), cancel))).toBe("NOT_FOUND");
      expect(await code(prepareNext(ctx({ indexer }), { ...cancel, action: "reclaim" }))).toBe("NOT_FOUND");
    }
  });
  it("leave Collect all, pockets included", async () => {
    const indexer = fakeUpstream({
      "/v2/positions?": { items: [position("1", { private: true }, { state: 3, collateralBeneficiary: WALLET })], nextCursor: null },
      "/intent/partners/vaults?": { items: [{ address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1814400, assets: [NVDA], fundingEnabled: true }], nextCursor: null },
      "/intent/partners/vaults/": { shares: "0", value: "0", withdrawableNow: "0", rewards: "0", pockets: [
        { id: 1, token: USDG, claimable: "5000000", private: true }, { id: 2, token: USDG, claimable: "7000000" }, { id: 3, token: USDG, claimable: "2000000", private: false },
      ] },
    });
    const p = await prepareNext(ctx({ indexer }), { action: "collect", wallet: WALLET });
    expect(p.summary.rows).toEqual([{ label: "Vault earnings", value: "2.00 USDG" }]);
    expect(p.next?.label).toMatch(/^Collect from RWA · NVDAx/);
  });
});

// Intent D54: from mandate version 12 every vault carries the name its manager gave it; earlier vaults are named after
// their family and token, as the Earn page names them.
describe("vault names", () => {
  const vault = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1814400, assets: [NVDA], fundingEnabled: true };
  const d = ctx().d;
  it("are the manager's own from version 12, one plain line, else the family and token", () => {
    expect(vaultName({ ...vault, name: "Tech stocks" }, d)).toBe("Tech stocks");
    expect(vaultName(vault, d)).toBe("RWA · NVDAx");
    expect(vaultName({ ...vault, assets: [NVDA, USDG], categoryMask: 2 }, d)).toBe("RH ECO vault");
    // Display text only: no line break, control or invisible character survives, and an empty name is no name.
    expect(vaultName({ ...vault, name: "  Gold\n\tvault\u200b " }, d)).toBe("Gold vault");
    expect(vaultName({ ...vault, name: "\u200b \n" }, d)).toBe("RWA · NVDAx");
    expect(vaultName({ ...vault, name: "é".repeat(60) }, d)).toBe("é".repeat(48));
  });
  it("name the vaults Earn lists and the steps that act on them, and a malformed one never hides a vault", async () => {
    const indexer = (name: unknown) => fakeUpstream({
      "/intent/partners/vaults?": { items: [{ ...vault, name }], nextCursor: null },
      "/intent/partners/vaults/": { pricing: { totalAssets: "1", totalSupply: "1", assetsPerShare: "1" }, liquidity: { free: "1" } },
    });
    expect((await earnVaults(ctx({ indexer: indexer("Tech stocks") }))).vaults.map((v) => v.name)).toEqual(["Tech stocks"]);
    expect((await earnVaults(ctx({ indexer: indexer(42) }))).vaults.map((v) => v.name)).toEqual(["RWA · NVDAx"]);
    const collect = fakeUpstream({
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [{ ...vault, name: "Tech stocks" }], nextCursor: null },
      "/intent/partners/vaults/": { shares: "0", value: "0", withdrawableNow: "0", rewards: "0", pockets: [{ id: 2, token: USDG, claimable: "7000000", private: false }] },
    });
    expect((await prepareNext(ctx({ indexer: collect }), { action: "collect", wallet: WALLET })).next?.label).toMatch(/^Collect from Tech stocks \(/);
  });
});

describe("loan actions", () => {
  const indexer = fakeUpstream({ "/v2/positions/": position("4") });
  it("repay is refused once the term has ended, and to anyone but the reclaim right's holder", async () => {
    const ended = fakeChain({ loan: () => Promise.resolve(loan({ fundedAt: NOW - 604_800 })), allowance: () => Promise.resolve(10n ** 30n) });
    expect(await code(prepareNext(ctx({ indexer, chain: ended }), { action: "reclaim", wallet: WALLET, loanId: "4" }))).toBe("TERM_ENDED");
    const notMine = fakeChain({ loan: () => Promise.resolve(loan({ originator: OTHER })), ownerOf: () => Promise.resolve(OTHER) });
    expect(await code(prepareNext(ctx({ indexer, chain: notMine }), { action: "reclaim", wallet: WALLET, loanId: "4" }))).toBe("NOT_YOUR_LOAN");
  });
  it("repay approves the cap, repays, then takes the collateral back", async () => {
    const p = await prepareNext(ctx({ indexer }), { action: "reclaim", wallet: WALLET, loanId: "4" });
    expect(p.next?.transaction.to.toLowerCase()).toBe(USDG);
    expect(p.then).toEqual(["Repay", "Receive collateral"]);
    expect(p.summary.rows[0]).toEqual({ label: "You pay", value: "1,010.00 USDG" });
  });
  it("collect takes back an unfunded listing past its deadline and claims loan rewards", async () => {
    const idx = fakeUpstream({
      "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: [position("9", {}, { state: 1, fundingDeadline: NOW - 1, borrowerReward: "1" })], nextCursor: null },
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [], nextCursor: null },
    });
    // The chain's listing, past its deadline as the index says.
    const chain = fakeChain({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0, fundingDeadline: NOW - 1 })), loanRewards: () => Promise.resolve(5n * 10n ** 18n),
      cashCredit: (engine: string) => Promise.resolve(engine.toLowerCase() === CORE ? 3_000_000n : 0n) });
    const p = await prepareNext(ctx({ indexer: idx, chain }), { action: "collect", wallet: WALLET });
    expect([p.next?.label, ...p.then]).toEqual(["Receive 3.00 USDG", "Cancel unfunded loan #9", "Receive collateral", "Claim sGAGE of loan #9"]);
    expect(p.summary.rows.map((r) => r.label)).toEqual(["USDG from loans", "Collateral back", "sGAGE rewards"]);
    expect(REWARDS).toBeDefined();
  });
});

// A bridged sGAGE claim pays nothing while its source awaits an unlock, so `GageV2Rewards.claim` reverts NothingToClaim
// though `claimable` reads more. Collect all leaves out a claim that would revert, as gage.cash's does
// (web/src/lib/walletBatch.ts), so the steps after it still go out.
describe("collect, when a claim would revert", () => {
  const vault = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1814400, assets: [NVDA], fundingEnabled: true };
  const idx = () => fakeUpstream({
    "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: [position("7", {}, { borrowerReward: "1" }), position("8", {}, { borrowerReward: "1" })], nextCursor: null },
    "/v2/positions?": { items: [], nextCursor: null },
    "/intent/partners/vaults?": { items: [vault], nextCursor: null },
    "/intent/partners/vaults/": { shares: "0", value: "0", withdrawableNow: "0", rewards: "0", pockets: [{ id: 2, token: USDG, claimable: "7000000", private: false }] },
  });
  const chain = () => fakeChain({
    loanRewards: () => Promise.resolve(2n * 10n ** 18n),
    simulate: (call: Call) => (call.to.toLowerCase() === REWARDS && decodeFunctionData({ abi: rewardsAbi, data: call.data }).args[0] === 7n
      ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n)),
  });

  it("leaves that claim out, says so, and counts only what the rest collects", async () => {
    const p = await prepareNext(ctx({ indexer: idx(), chain: chain() }), { action: "collect", wallet: WALLET });
    expect([p.next?.label, ...p.then]).toEqual(["Claim sGAGE of loan #8", expect.stringMatching(/^Collect from RWA · NVDAx/)]);
    expect(p.summary.rows).toEqual([{ label: "Vault earnings", value: "7.00 USDG" }, { label: "sGAGE rewards", value: "2 sGAGE" }]);
    expect(p.view).toMatchObject({ action: "collect", sgage: "2000000000000000000", earnings: "7000000" });
    expect(p.notes).toContain("Left out, as it would revert now: Claim sGAGE of loan #7. Collect again later.");
  });

  it("is carried out whole by run(): every step but that claim goes out", async () => {
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: idx(), chain: chain() }), { action: "collect", wallet: WALLET }, signer);
    expect(r).toMatchObject({ status: "done", unsent: [] });
    expect(r.sent.map((s) => s.label)).toEqual(["Claim sGAGE of loan #8", expect.stringMatching(/^Collect from RWA · NVDAx/)]);
  });
});

// The index says where to look; the chain says what is there. Collect builds no call to a contract the index names
// unless the chain bears it out as a partner vault of one of gage's cores, cancels a listing only as the chain has it,
// reads no more rows than it asked for, and plans a bounded number of claims.
describe("collect, from an index it does not take on trust", () => {
  const vault = (address: string) => ({ address, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1814400, assets: [NVDA], fundingEnabled: true });
  const holding = { shares: "0", value: "0", withdrawableNow: "0", rewards: "3000000000000000000", pockets: [{ id: 2, token: USDG, claimable: "7000000", private: false }] };
  const FAKE = A(0x99), ELSEWHERE = A(0x98);

  it("claims only from vaults the chain bears out as partner vaults of gage's cores", async () => {
    const idx = fakeUpstream({
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [vault(VAULT), vault(FAKE), vault(ELSEWHERE)], nextCursor: null },
      "/intent/partners/vaults/": holding,
    });
    // FAKE was made by no factory of gage's; ELSEWHERE was, but lends on another core.
    const chain = fakeChain({
      isVault: (_f: string, v: string) => Promise.resolve(v.toLowerCase() !== FAKE.toLowerCase()),
      vaultCore: (v: string) => Promise.resolve(v.toLowerCase() === ELSEWHERE.toLowerCase() ? A(0x77) : CORE),
    });
    const p = await prepareNext(ctx({ indexer: idx, chain }), { action: "collect", wallet: WALLET });
    // VAULT's earnings and sGAGE alone: two calls, both to it.
    expect([p.next?.label, ...p.then]).toEqual([expect.stringMatching(/^Collect from /), expect.stringMatching(/^Claim sGAGE of /)]);
    expect(p.next!.transaction.to.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(p.view).toMatchObject({ earnings: "7000000", sgage: "3000000000000000000" });
  });

  it("cancels a listing past its deadline only as the chain has it, whatever the index says", async () => {
    const idx = fakeUpstream({
      "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: [position("9", {}, { state: 1, fundingDeadline: NOW - 1 })], nextCursor: null },
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [], nextCursor: null },
    });
    const listing = (fundingDeadline: number) => fakeChain({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0, fundingDeadline })) });
    // The chain's listing still has an hour to be funded: nothing to cancel, nothing to take back.
    expect((await prepareNext(ctx({ indexer: idx, chain: listing(NOW + 3_600) }), { action: "collect", wallet: WALLET })).status).toBe("done");
    const due = await prepareNext(ctx({ indexer: idx, chain: listing(NOW - 1) }), { action: "collect", wallet: WALLET });
    expect([due.next?.label, ...due.then]).toEqual(["Cancel unfunded loan #9", "Receive collateral"]);
  });

  it("reads no more loans than a page it asked for, plans at most twenty claims, and says when more are ready", async () => {
    const many = Array.from({ length: 150 }, (_, n) => position(String(n + 1), {}, { borrowerReward: "1" }));
    const idx = fakeUpstream({
      "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: many, nextCursor: null },
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [], nextCursor: null },
    });
    const simulated: string[] = [];
    let read = 0;
    const chain = fakeChain({ loanRewards: () => { read += 1; return Promise.resolve(10n ** 18n); }, simulate: (call: Call) => { simulated.push(call.to); return Promise.resolve(100_000n); } });
    const p = await prepareNext(ctx({ indexer: idx, chain }), { action: "collect", wallet: WALLET });
    // A page asks for 100 loans: the 50 past them are not read.
    expect(read).toBe(100);
    expect([p.next!, ...p.then]).toHaveLength(20);
    expect(simulated.length).toBeLessThanOrEqual(21);
    expect(p.notes).toContain("More claims are ready: collect again once these have gone through.");
    expect(p.view).toMatchObject({ sgage: String(20n * 10n ** 18n) });
  });

  // A bridged loan's last few raw units of sGAGE can wait on rounding for good: under a millionth of an sGAGE, nothing is
  // planned for them, and nothing tells the wallet to come back for them.
  it("plans no claim for a loan's dust of sGAGE", async () => {
    const idx = fakeUpstream({
      "/v2/positions?engine=0x0000000000000000000000000000000000000020": { items: [position("7", {}, { borrowerReward: "1" })], nextCursor: null },
      "/v2/positions?": { items: [], nextCursor: null },
      "/intent/partners/vaults?": { items: [], nextCursor: null },
    });
    const p = await prepareNext(ctx({ indexer: idx, chain: fakeChain({ loanRewards: () => Promise.resolve(999_999_999_999n) }) }), { action: "collect", wallet: WALLET });
    expect(p.status).toBe("done");
    expect(p.notes.join(" ")).not.toContain("Collect again later");
  });
});

describe("leverage", () => {
  const instant = { schema: "gage-intent-instant-v1", status: "ok", refusal: null, expiresAt: NOW + 30,
    answer: { collateral: "2000000000000000000", valueUSDG: "400000000", principal: "300000000", cap: "303000000", costBps: 100, ltvBps: 7500, binds: "wallet", room: "0", vaults: 1 } };
  const rates = () => fakeUpstream({ "/intent/instant/": instant, "/intent/preview/": preview() });
  const input = { action: "leverage" as const, wallet: WALLET, token: NVDA, own: "2000000000000000000", multiple: 2, term: 604_800, maxCostBps: 150 };
  it("doubles the instant loan, buys the second share and caps the purchase at the pool's quote plus 0.5%", async () => {
    const p = await prepareNext(ctx({ rates: rates() }), input);
    expect(p.summary.title).toBe("Open a 2× loop on NVDAx");
    expect(p.summary.rows).toContainEqual({ label: "Held for the loan", value: "4 NVDAx" });
    // 2 NVDAx at 200 USDG through a 0.3% pool: 401.203612 USDG quoted, 0.5% over it rounded up to the cent.
    expect(p.summary.rows).toContainEqual({ label: "The purchase costs at most", value: "403.21 USDG" });
    expect(p.then).toEqual(["Approve USDG", "Open loop"]);
  });
  it("says what lands besides the tokens, at the least: the loan less its fee and the most the purchase may cost", async () => {
    const p = await prepareNext(ctx({ rates: rates() }), input);
    // 600 USDG borrowed, 6 of fee, the purchase at the most the router may take for it (403.21): what the wallet is
    // debited never exceeds the plan's figure, and what lands is never less than it says.
    expect(p.view).toMatchObject({ action: "leverage", own: "2000000000000000000", buy: "2000000000000000000", principal: "600000000", fee: "6000000", cashUSDG: "190790000", maxCost: "403210000" });
  });
  it("prices the purchase in the pool the plan buys through, its price and its ticks read from the release's StateView", async () => {
    const asked: unknown[][] = [], words: unknown[][] = [];
    const chain = fakeChain({
      poolState: (...args: unknown[]) => { asked.push(args); return Promise.resolve(POOL); },
      tickBitmap: (...args: unknown[]) => { words.push(args); return Promise.resolve(0n); },
    });
    await prepareNext(ctx({ rates: rates(), chain }), input);
    const id = poolId(ctx().d.pools.get(NVDA.toLowerCase())!);
    expect(asked).toEqual([[STATE_VIEW, id]]);
    // The price rises (USDG is currency1): the ticks above -223339, in its bitmap word (-223339 / 60 rounded down, >> 8).
    expect(words).toEqual([[{ kind: "v4", stateView: STATE_VIEW, poolId: id }, -15]]);
  });
  it("refuses a loop the pool's active liquidity cannot sell", async () => {
    const chain = fakeChain({ poolState: () => Promise.resolve({ ...POOL, liquidity: 10n ** 9n }) });
    expect(await code(prepareNext(ctx({ rates: rates(), chain }), input))).toBe("POOL_TOO_THIN");
  });
  it("refuses a price above the limit the agent set", async () => {
    expect(await code(prepareNext(ctx({ rates: rates() }), { ...input, maxCostBps: 50 }))).toBe("PRICE_ABOVE_LIMIT");
  });

  // Where the loop buys (D242, D243): the cheapest of the token's pools and KyberSwap's route, one approval for the best,
  // and when the loop is sent the first source, in rank order, that fits under it and simulates.
  const looping = () => fakeUpstream({ "/intent/instant/": instant, "/intent/preview/": preview(), "/intent/loop/quotes/": signedLoop });
  /** Approvals in place, so the next step is the loop itself; each loop simulated is recorded by the function it calls. */
  const approved = (over: Record<string, unknown> = {}, refuse: string[] = []) => {
    const tried: string[] = [];
    const chain = fakeChain({
      allowance: () => Promise.resolve(10n ** 30n),
      simulate: (call: Call) => {
        const fn = decodeFunctionData({ abi: loopRouterAbi, data: call.data }).functionName;
        tried.push(fn);
        return refuse.includes(fn) ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n);
      },
      ...over,
    });
    return Object.assign(chain, { tried });
  };
  /**
   * A wallet whose allowances the test sets as it approves, by token; its loops through the router are recorded by the
   * function they call, those in `refuse` reverting, and anything else simulates.
   */
  const walletChain = (allowed: Record<string, bigint>, refuse: string[] = [], over: Record<string, unknown> = {}) => {
    const tried: string[] = [];
    const chain = fakeChain({
      allowance: (token: string) => Promise.resolve(allowed[token.toLowerCase()] ?? 0n),
      simulate: (call: Call) => {
        if (call.to !== ROUTER) return Promise.resolve(100_000n);
        const fn = decodeFunctionData({ abi: loopRouterAbi, data: call.data }).functionName;
        tried.push(fn);
        return refuse.includes(fn) ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n);
      },
      ...over,
    });
    return Object.assign(chain, { tried });
  };
  const sent = (p: Prepared) => decodeFunctionData({ abi: loopRouterAbi, data: p.next!.transaction.data });
  const own = 2n * 10n ** 18n, pricing = `0x${"ef".repeat(32)}`, deadline = NOW + 86_400;
  // The fixture's USDG/NVDAx V3 pool (testing V3_POOL): a 0.05% tier, 400.211421 USDG for the purchase, 402.22 approved.
  const POOL_V3 = A(0xb0);
  const v3Row = { protocol: "v3", poolAddress: POOL_V3, currency0: USDG, currency1: NVDA, fee: 500, tickSpacing: 10, hooks: A(0), poolId: `0x${POOL_V3.slice(2).padStart(64, "0")}` };
  const withV3 = (v4 = true) => parseDeployment({ ...manifest(), ...(v4 ? {} : { pools: {} }), nativeV2: { ...manifest().nativeV2, cashoutPools: [v3Row] } });
  // The route's call makes exactly its purchase for the loop router (`aggregatorCallOk`): its spend of USDG for the NVDAx.
  // Its flash fee and most follow its spend, as the valuation service's do: ⌈spend × 100 / 1,000,000⌉ at a 0.01% lender.
  const kyber = (over: Record<string, unknown> = {}) => {
    const spend = BigInt((over.spend as string | undefined) ?? "400000000"), fee = (spend * 100n + 999_999n) / 1_000_000n;
    const b = {
      schema: "gage-loop-buy-v1", chainId: 46630, source: "kyberswap", token: NVDA.toLowerCase(), buy: "2000000000000000000", spend: String(spend),
      amountOut: "2001000000000000000", minOut: "2000000000000000000", executor: A(0xc0), lender: { pool: A(0xe0), flashToken: A(0xd0), flashFee: 100 },
      flashFee: String(fee), maxCost: String(spend + fee), effectiveCost: "399840080", deadline: NOW + 600, quotedAt: NOW, ...over,
    };
    return { data: swapCall({ tokenIn: USDG, amountIn: BigInt(b.spend), tokenOut: NVDA, recipient: ROUTER, minOut: BigInt(b.minOut) }), ...b };
  };

  it("with only v4 pools, as on the testnet, buys through the pool with `loop`, held to its quote plus 0.5%", async () => {
    const chain = approved();
    const p = await prepareNext(ctx({ rates: looping(), chain }), input);
    expect(p.status).toBe("ready");
    const call = sent(p);
    expect(call.functionName).toBe("loop");
    expect(call.args[0]).toEqual({ key: ctx().d.pools.get(NVDA.toLowerCase()), own, buy: own, maxCost: 403_210_000n, fundingDeadline: deadline, withRewards: false, pricing });
    expect(call.args[3]).toEqual([7n]);
    // Simulated when chosen, then for its gas.
    expect(chain.tried).toEqual(["loop", "loop"]);
  });

  it("buys through a cheaper V3 pool with `loopV3`, approving that pool's quote plus 0.5%; a V3-only token is one leverage buys", async () => {
    const p = await prepareNext(ctx({ d: withV3(), rates: looping(), chain: approved() }), input);
    expect(sent(p).functionName).toBe("loopV3");
    expect(sent(p).args[0]).toEqual({ fee: 500, own, buy: own, maxCost: 402_220_000n, fundingDeadline: deadline, withRewards: false, pricing });
    expect(p.summary.rows).toContainEqual({ label: "The purchase costs at most", value: "402.22 USDG" });
    const only = ctx({ d: withV3(false), rates: looping(), chain: approved() });
    expect((await assets(only)).assets[0]).toMatchObject({ leverage: true });
    expect(sent(await prepareNext(only, input)).functionName).toBe("loopV3");
  });

  it("prices a V3 pool past its active range: a narrow position at the price does not make it the cheapest source", async () => {
    // NVDAx at the lower edge of a narrow position: liquidity() reports the fixture's deep 1e18, but buying lowers the
    // price through tick 223330 at once, past which 1e16 is left. Bought there it costs more than through the v4 pool.
    const edge = 223_330;
    const chain = approved({
      v3PoolState: () => Promise.resolve({ ...V3_POOL, sqrtPriceX96: sqrtPriceAtTick(edge), tick: edge }),
      tickBitmap: (s: TickSource, word: number) => Promise.resolve(s.kind === "v3" && word === 87 ? 1n << 61n : 0n),
      tickLiquidityNet: (s: TickSource, tick: number) => Promise.resolve(s.kind === "v3" && tick === edge ? 99n * 10n ** 16n : 0n),
    });
    const p = await prepareNext(ctx({ d: withV3(), rates: looping(), chain }), input);
    expect(sent(p).functionName).toBe("loop");
    expect(p.view).toMatchObject({ maxCost: "403210000" });
  });

  it("leaves out a V3 pool whose live fee is not the manifest's: the router's getPool(token, USDG, fee) finds another", async () => {
    // A 0.01% pool would sell cheaper than either: it is still not the one the router would buy from.
    const chain = approved({ v3PoolState: () => Promise.resolve({ ...V3_POOL, fee: 100 }) });
    const p = await prepareNext(ctx({ d: withV3(), rates: looping(), chain }), input);
    expect(sent(p).functionName).toBe("loop");
    expect(p.view).toMatchObject({ maxCost: "403210000" });
  });

  it("answers a failed pool read when no source quotes, rather than calling the pool too thin, and leaves out only the pool that failed", async () => {
    const down = () => Promise.reject(new ApiError("RPC_DOWN", "x"));
    expect(await code(prepareNext(ctx({ rates: looping(), chain: approved({ poolState: down }) }), input))).toBe("RPC_DOWN");
    expect(await code(prepareNext(ctx({ d: withV3(), rates: looping(), chain: approved({ poolState: down, v3PoolState: down }) }), input))).toBe("RPC_DOWN");
    const p = await prepareNext(ctx({ d: withV3(), rates: looping(), chain: approved({ poolState: down }) }), input);
    expect(sent(p).functionName).toBe("loopV3");
  });

  it("leaves V3 pools out for a router built before D242, which has no V3 factory", async () => {
    const chain = approved({ loopV3Factory: () => Promise.resolve(null) });
    const p = await prepareNext(ctx({ d: withV3(), rates: looping(), chain }), input);
    expect(sent(p).functionName).toBe("loop");
    expect(p.view).toMatchObject({ maxCost: "403210000" });
  });

  it("buys through KyberSwap with `loopVia` when the valuation service's route is cheapest, pledging the plan's purchase", async () => {
    const valuation = fakeUpstream({ "/quote/loop-buy": kyber() });
    const p = await prepareNext(ctx({ rates: looping(), chain: approved(), valuation }), input);
    expect(valuation.asked[0]).toBe(`/quote/loop-buy?token=${NVDA.toLowerCase()}&buy=2000000000000000000&slippageBps=50`);
    expect(sent(p).functionName).toBe("loopVia");
    expect(sent(p).args[0]).toEqual({
      executor: getAddress(A(0xc0)), data: kyber().data, flashToken: getAddress(A(0xd0)), flashFee: 100, spend: 400_000_000n,
      own, buy: own, maxCost: 400_040_000n, fundingDeadline: deadline, withRewards: false, pricing,
    });
    expect(p.view).toMatchObject({ maxCost: "400040000" });
  });

  it("leaves KyberSwap out when the valuation service has no route, or the router does not admit its executor", async () => {
    for (const [valuation, chain] of [
      [fakeUpstream({ "/quote/loop-buy": () => ({ status: 503, body: { error: { code: "AGGREGATOR_UNAVAILABLE" } } }) }), approved()],
      [fakeUpstream({ "/quote/loop-buy": kyber() }), approved({ loopExecutorAllowed: () => Promise.resolve(false) })],
    ] as const) {
      const p = await prepareNext(ctx({ rates: looping(), chain, valuation }), input);
      expect(sent(p).functionName).toBe("loop");
      expect(p.view).toMatchObject({ maxCost: "403210000" });
    }
  });

  // D245: from r7 the testnet's valuation service answers through gage's stand-in for KyberSwap's router. The SDK pins no
  // aggregator: it asks the loop router whether it admits the route's own executor, and buys through any it admits.
  it("buys through the testnet's stand-in for KyberSwap's router with `loopVia` once the router admits it, and only then", async () => {
    const standin = A(0xf0), kyberRouter = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
    const routes = () => fakeUpstream({ "/quote/loop-buy": kyber({ source: "testnet-aggregator", executor: standin }) });
    const admitting = (admitted: string) => {
      const asked: string[][] = [];
      const chain = approved({ loopExecutorAllowed: (router: string, executor: string) => {
        asked.push([router, executor]);
        return Promise.resolve(executor.toLowerCase() === admitted);
      } });
      return Object.assign(chain, { asked });
    };
    const chain = admitting(standin);
    const p = await prepareNext(ctx({ rates: looping(), chain, valuation: routes() }), input);
    expect(chain.asked).toEqual([[ROUTER, getAddress(standin)]]);
    expect(sent(p).functionName).toBe("loopVia");
    expect(sent(p).args[0]).toMatchObject({ executor: getAddress(standin), spend: 400_000_000n, maxCost: 400_040_000n });
    // A router that admits KyberSwap's router alone leaves the stand-in's route out: the pool buys.
    const other = await prepareNext(ctx({ rates: looping(), chain: admitting(kyberRouter), valuation: routes() }), input);
    expect(sent(other).functionName).toBe("loop");
    expect(other.view).toMatchObject({ maxCost: "403210000" });
  });

  it("falls back to the next source when the best one would revert, held to that source's own bound", async () => {
    const valuation = fakeUpstream({ "/quote/loop-buy": kyber({ spend: "404960000", amountOut: "2020000000000000000" }) });
    const chain = approved({}, ["loopVia"]);
    const p = await prepareNext(ctx({ rates: looping(), chain, valuation }), input);
    expect(chain.tried).toEqual(["loopVia", "loop", "loop"]);
    expect(sent(p).args[0]).toMatchObject({ key: ctx().d.pools.get(NVDA.toLowerCase()), maxCost: 403_210_000n });
    expect(p.view).toMatchObject({ maxCost: "403210000" });
  });

  // When the loop is sent after its approvals (run: planned once, the approvals mined, then the loop built).
  /** Runs the leverage input from a wallet with no approvals yet; returns the run and the loop the signer sent, if any. */
  const runLoop = async (over: Record<string, unknown> = {}, valuation?: ReturnType<typeof fakeUpstream>) => {
    const chain = walletChain({}, [], over);
    const signer = fakeSigner();
    const r = await run(ctx({ rates: looping(), chain, ...(valuation ? { valuation } : {}) }), input, signer, { sleep: () => Promise.resolve() });
    const loop = signer.sent.find((t) => t.to === ROUTER);
    return { r, chain, signer, loop: loop ? decodeFunctionData({ abi: loopRouterAbi, data: loop.data }) : null };
  };

  it("skips a KyberSwap route above the approved bound when the loop is sent, without simulating it", async () => {
    let asked = 0;
    const valuation = fakeUpstream({ "/quote/loop-buy": () => (asked++ === 0
      ? { status: 503, body: { error: { code: "AGGREGATOR_UNAVAILABLE" } } }
      : { status: 200, body: kyber({ spend: "409960000", amountOut: "2034000000000000000", minOut: "2013700000000000000" }) }) });
    const { r, chain, loop } = await runLoop({}, valuation);
    expect(r.status).toBe("done");
    // Its 403.15 for exactly the purchase fits the 403.21 approved: asked again at the spend that pays for
    // (403.169683 with the 0.01% flash fee), it still costs 410.00, and is left out.
    expect(asked).toBe(3);
    expect(valuation.asked[2]).toMatch(/&hint=403169683$/);
    expect(chain.tried).toEqual(["loop", "loop"]);
    expect(loop?.args[0]).toMatchObject({ maxCost: 403_210_000n });
  });

  // KyberSwap's route sized again from a fresh price probe: a rise of even a wei sizes it up, past the bound approved for
  // the route quoted first, although the spend approved would still buy the whole purchase. The valuation service keeps a
  // `hint` spend while it still does (docs/api.md).
  const resized = (first: Record<string, unknown>, hinted: Record<string, string>) => {
    const asked: string[] = [];
    const valuation = fakeUpstream({ "/quote/loop-buy": (path: string) => {
      asked.push(path);
      const hint = new URL(path, "http://valuation.test").searchParams.get("hint");
      const answer = hint === null ? first : hinted[hint] ? { ...first, ...JSON.parse(hinted[hint]) as object } : null;
      return answer ? { status: 200, body: kyber(answer) } : { status: 404, body: { error: { code: "NO_ROUTE" } } };
    } });
    return { valuation, asked };
  };

  it("asks for KyberSwap's route again at the spend approved when the loop is sent, so a route that still buys the purchase fits", async () => {
    // At the plan: 404.96 USDG spent, 405.000496 at most, the cheapest at 400.99 for exactly the purchase. When the loop
    // is sent the price is up 0.05%: without the hint the route is sized to 405.20, above the 405.000496 approved.
    let plan = true;
    const asked: string[] = [];
    const valuation = fakeUpstream({ "/quote/loop-buy": (path: string) => {
      asked.push(path);
      const answer = plan || path.includes("&hint=404960000")
        ? kyber({ spend: "404960000", amountOut: "2020000000000000000" })
        : kyber({ spend: "405160000", amountOut: "2020000000000000000" });
      plan = false;
      return { status: 200, body: answer };
    } });
    const { r, loop } = await runLoop({}, valuation);
    expect(r.status).toBe("done");
    expect(loop?.functionName).toBe("loopVia");
    expect(loop?.args[0]).toMatchObject({ spend: 404_960_000n, maxCost: 405_000_496n });
    expect(asked[1]).toBe(`/quote/loop-buy?token=${NVDA.toLowerCase()}&buy=2000000000000000000&slippageBps=50&hint=404960000`);
  });

  it("asks once more at the spend an earlier approval pays for, with the route's lender fee, before asking for a larger approval", async () => {
    // 405.00 USDG approved; KyberSwap's fresh route needs 405.20. At a 0.01% flash fee 405.00 pays for a spend of
    // 404.959504 (404.959504 + 0.040496), which still buys the purchase.
    const { valuation, asked } = resized(
      { spend: "405160000", amountOut: "2020100000000000000" },
      { 404959504: JSON.stringify({ spend: "404959504", maxCost: "405000000" }) },
    );
    const chain = walletChain({ [NVDA]: own, [USDG]: 405_000_000n });
    const p = await prepareNext(ctx({ rates: looping(), chain, valuation }), input);
    expect(asked.map((a) => new URL(a, "http://valuation.test").searchParams.get("hint"))).toEqual([null, "404959504"]);
    expect(p.status).toBe("ready");
    expect(sent(p).functionName).toBe("loopVia");
    expect(sent(p).args[0]).toMatchObject({ spend: 404_959_504n, maxCost: 405_000_000n });
    // Nothing approved yet: nothing to fit, and the fresh route is the one asked for.
    const fresh = resized({ spend: "405160000", amountOut: "2020100000000000000" }, {});
    const first = await prepareNext(ctx({ rates: looping(), chain: walletChain({}), valuation: fresh.valuation }), input);
    expect(fresh.asked).toHaveLength(1);
    expect(first.view).toMatchObject({ maxCost: "405200516" });
  });

  it("refuses to send when every source costs more now than the approved most, and when none would run", async () => {
    let reads = 0;
    // The price up 2% between the plan and the loop: 409.27 USDG for the purchase, above the 403.21 approved.
    const { r, chain } = await runLoop({ poolState: () => Promise.resolve(reads++ === 0 ? POOL : { ...POOL, sqrtPriceX96: (POOL.sqrtPriceX96 * 101n) / 100n }) });
    expect(r).toMatchObject({ status: "stopped", unsent: ["Open loop"], error: { code: "PRICE_MOVED" } });
    expect(chain.tried).toEqual([]);
    const reverting = approved({}, ["loop", "loopV3", "loopVia"]);
    expect(await code(prepareNext(ctx({ rates: looping(), chain: reverting }), input))).toBe("SIMULATION_FAILED");
  });

  // D243's fallback when the cheapest source keeps reverting (a quote its swap cannot meet, a route the router refuses):
  // the next source's own bound is approved, and the loop buys through it.
  // The V3 pool quotes 400.211421 USDG (402.22 approved) but its loop reverts; the v4 pool, at a 1% fee, quotes about
  // 404.05 (406.07 approved).
  const v4AtOnePercent = { poolState: () => Promise.resolve({ ...POOL, lpFee: 10_000 }) };
  const approvedUSDG = (p: Prepared) => decodeFunctionData({ abi: erc20Abi, data: p.next!.transaction.data }).args[1];

  it("passes over the cheapest source when its loop reverts: the next source's own bound is approved, then the loop buys through it", async () => {
    const allowed: Record<string, bigint> = {};
    const chain = walletChain(allowed, ["loopV3"], v4AtOnePercent);
    const c = ctx({ d: withV3(), rates: looping(), chain });
    const first = await prepareNext(c, input);
    expect([first.next?.label, ...first.then]).toEqual(["Approve NVDAx", "Approve USDG", "Open loop"]);
    expect(first.view).toMatchObject({ maxCost: "402220000" });
    allowed[NVDA] = own;
    allowed[USDG] = 402_220_000n;
    // Approved for the V3 pool, whose loop reverts: the v4 pool's bound is above that approval, so it is asked for.
    const second = await prepareNext(c, input);
    expect(chain.tried).toEqual(["loopV3"]);
    expect([second.status, second.next?.label, ...second.then]).toEqual(["approval_required", "Approve USDG", "Open loop"]);
    expect(approvedUSDG(second)).toBe(406_070_000n);
    expect(second.summary.rows).toContainEqual({ label: "The purchase costs at most", value: "406.07 USDG" });
    allowed[USDG] = 406_070_000n;
    const third = await prepareNext(c, input);
    expect(third.status).toBe("ready");
    expect(sent(third).functionName).toBe("loop");
    expect(sent(third).args[0]).toMatchObject({ maxCost: 406_070_000n });
    expect(chain.tried).toEqual(["loopV3", "loopV3", "loop", "loop"]);
  });

  it("never passes over a source because the rates service did not sign the loop's plan: that is the refusal", async () => {
    const chain = walletChain({ [NVDA]: own, [USDG]: 402_220_000n }, ["loopV3"], v4AtOnePercent);
    expect(await code(prepareNext(ctx({ d: withV3(), rates: rates(), chain }), input))).toBe("RATES_UNAVAILABLE");
    expect(chain.tried).toEqual([]);
  });

  it("stops a run whose loop reverts through every source under its approval, saying to run it again; run again, it buys through the next source", async () => {
    const allowed: Record<string, bigint> = {};
    const chain = walletChain(allowed, ["loopV3"], v4AtOnePercent);
    const c = ctx({ d: withV3(), rates: looping(), chain });
    const r = await run(c, input, fakeSigner(), { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "stopped", unsent: ["Open loop"], error: { code: "SIMULATION_FAILED" } });
    expect(r.error?.message).not.toMatch(/balance|allowance/);
    expect(r.error?.message).toMatch(/again/);
    allowed[NVDA] = own;
    allowed[USDG] = 402_220_000n;
    const signer = fakeSigner();
    const again = await run(c, input, signer, { sleep: () => Promise.resolve() });
    expect(again.status).toBe("done");
    expect(signer.sent.map((t) => t.to)).toEqual([USDG, ROUTER]);
    expect(decodeFunctionData({ abi: erc20Abi, data: signer.sent[0]!.data }).args[1]).toBe(406_070_000n);
    expect(decodeFunctionData({ abi: loopRouterAbi, data: signer.sent[1]!.data }).functionName).toBe("loop");
  });

  // 17 October 2026 (mainnet loan 12, D271): KyberSwap spent its whole bound, past what the loan paid out, and the router
  // took the rest from a wallet holding no USDG. A loop's purchase is held to what its loan pays out, as the app holds it,
  // and a multiple is prepared only while the purchase's bound keeps 25 bp of the loan spare under that.
  const lending = (principal: string, cap: string) =>
    fakeUpstream({ "/intent/instant/": { ...instant, answer: { ...instant.answer, principal, cap } }, "/intent/preview/": preview(), "/intent/loop/quotes/": signedLoop });
  /** A wallet holding `usdgHeld` USDG, its pledge approved to the router, its USDG not. */
  const holding = (usdgHeld: bigint) => walletChain({ [NVDA]: own }, [], { balance: (token: string) => Promise.resolve(token.toLowerCase() === USDG ? usdgHeld : 10n ** 30n) });

  it("refuses a loop whose loan does not pay for its purchase, whatever USDG the wallet holds", async () => {
    // 37.5% of the pledge's value lent: 2× borrows 300 USDG and pays out 297 after the fee, for a purchase of up to 403.21.
    for (const usdgHeld of [0n, 110_000_000n, 10n ** 12n]) {
      expect(await code(prepareNext(ctx({ rates: lending("150000000", "151500000"), chain: holding(usdgHeld) }), input))).toBe("MULTIPLE_TOO_HIGH");
    }
    expect(await code(leverageQuote(ctx({ rates: lending("150000000", "151500000") }), { token: NVDA, own: input.own, multiple: 2, term: 604_800 }))).toBe("MULTIPLE_TOO_HIGH");
  });

  it("prepares a multiple whose purchase keeps 25 bp of the loan spare under what it pays out, and refuses one that keeps less", async () => {
    // 2× of 204.16 lends 408.32 and pays out 404.2368: a bound of 403.21 leaves 1.0268, over the 1.0208 kept spare.
    const p = await prepareNext(ctx({ rates: lending("204160000", "206201600"), chain: holding(0n) }), input);
    expect(p.view).toMatchObject({ principal: "408320000", fee: "4083200", maxCost: "403210000" });
    expect(approvedUSDG(p)).toBe(403_210_000n);
    // 2× of 204.15 pays out 404.217: 1.007 left, short of the 1.02075 kept spare, though the loan would still pay for it.
    expect(await code(prepareNext(ctx({ rates: lending("204150000", "206191500"), chain: holding(10n ** 12n) }), input))).toBe("MULTIPLE_TOO_HIGH");
  });

  // The audit of 18 October 2026 (L5): the spare was asked of the cheapest source alone, so a cheaper route whose own bound
  // broke it refused a loop a pool could buy, and a source tried after one that reverted was held to the whole payout.
  it("keeps the spare on every source it buys through, whichever is cheapest or tried first", async () => {
    // 2× of 204.5 pays out 404.91 and keeps 1.0225 spare: 403.8875 may be spent. KyberSwap's route costs 400.04 for the
    // purchase but up to 404.0404; the pool, 401.20 and up to 403.21.
    const kyberRoute = fakeUpstream({ "/quote/loop-buy": kyber({ spend: "404000000", amountOut: "2020000000000000000" }) });
    const pooled = await prepareNext(ctx({ rates: lending("204500000", "206545000"), chain: holding(0n), valuation: kyberRoute }), input);
    expect(pooled.view).toMatchObject({ maxCost: "403210000" });
    expect(approvedUSDG(pooled)).toBe(403_210_000n);
    // 2× of 203 pays out 401.94 and keeps 1.015 spare: 400.925 may be spent, which KyberSwap's 400.04 fits and the pool's
    // 403.21 does not. When the route would revert, the pool is not tried up to the whole payout.
    const chain = approved({}, ["loopVia"]);
    expect(await code(prepareNext(ctx({ rates: lending("203000000", "205030000"), chain, valuation: fakeUpstream({ "/quote/loop-buy": kyber() }) }), input))).toBe("SIMULATION_FAILED");
    expect(chain.tried).toEqual(["loopVia"]);
  });
});

describe("format", () => {
  it("never shows less than is owed, and slivers in their own digits", () => {
    expect(owed(1_010_000_001n)).toBe("1,010.01 USDG");
    expect(usdg(1_010_009_999n)).toBe("1,010.00 USDG");
    expect(usdg(1234n)).toBe("0.001234 USDG");
    expect(shares(10n ** 18n)).toBe("1 share");
  });
});

// Pashov I-04: a vault opens no record under the smallest one. The rates service refuses those counts last
// (PURCHASE_TOO_SMALL); the filler, and this mirror of it, pass a vault through them but never leave it on one.
describe("the filler's allocation, mirrored", () => {
  const B = "0x00000000000000000000000000000000000000b2";
  const vault = (address: string, most: number, fee: number, small = 1) => ({ vault: address, loanPrincipal: "0", totalAssets: "10000000000",
    options: [1, 2, 3, 4].map((u) => ({ units: u, principal: String(u * 7_500_000), executionFee: String(u * fee),
      refusal: u <= small ? { code: "PURCHASE_TOO_SMALL", reason: "" } : u > most ? { code: "LOAN_LIMIT", reason: "" } : null })) });
  const read = (vaults: unknown[]) => readPreview(fakeUpstream({ "/intent/preview/": { schema: "gage-intent-preview-v1", status: "ok", refusal: null, vaults,
    summary: { units: 4, fills: true, reason: null } } }), CORE, { token: NVDA, collateral: 1n, principal: 30_000_000n, cap: 33_000_000n, term: 604_800 }, WALLET);

  it("keeps the counts refused only for their size as steps, and never ends a vault on one", async () => {
    const funded = await read([vault(VAULT, 3, 30), vault(B, 4, 20)]);
    expect(funded.vaults[0]!.options).toEqual([{ units: 1, principal: 7_500_000n, executionFee: 30n, step: true }, { units: 2, principal: 15_000_000n, executionFee: 60n },
      { units: 3, principal: 22_500_000n, executionFee: 90n }]);
    // The first vault pays more and takes three at most; three would leave the second one quarter alone.
    expect(allocate(funded.vaults)).toEqual([{ vault: VAULT, units: 2 }, { vault: B, units: 2 }].sort((x, y) => (BigInt(x.vault) < BigInt(y.vault) ? -1 : 1)));
    // Each taking three or none: never four.
    expect(allocate((await read([vault(VAULT, 3, 30, 2), vault(B, 3, 20, 2)])).vaults)).toBeNull();
    // Steps that lead nowhere are dropped.
    expect((await read([vault(VAULT, 1, 30)])).vaults[0]!.options).toEqual([]);
  });
});
