/**
 * A loan the private lane opened stays private whatever gage's index says (the audit of 18 October 2026, M7): gage-sdk
 * knew a private loan only by the index's `private` marker, so a wrong or hostile index marking one `private: false` had
 * it shown and planned on. The chain must bear the index out: no private-lane router of the loan's core opened it
 * (`opened`). A chain that cannot say keeps the loan unknown, as an index without the marker does.
 */
import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import { gageFrom } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError, refusalOf } from "../src/errors.js";
import { waitForFill } from "../src/fill.js";
import { prepareNext } from "../src/prepare.js";
import { loan, portfolio } from "../src/reads.js";
import { A, CORE, ctx, fakeChain, fakeUpstream, loan as chainLoan, mainnetManifest, manifest, NOW, NVDA, OLD, position, PRIVATE_ROUTER, USDG, VAULT, WALLET } from "../src/testing.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
/** The fixture release with the private lane on its core, or as `intent` names it. */
const lane = (intent: Record<string, unknown> = { privateRouter: PRIVATE_ROUTER }) => parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, ...intent } });
/** A chain where the lane's router opened `ids` and no other loan; each read of the lane is kept in `asked`. */
const opening = (ids: bigint[], asked: unknown[] = [], over: Partial<Record<keyof Chain, unknown>> = {}) => fakeChain({
  privateLoans: (core: Address, routers: readonly Address[], loans: readonly bigint[]) => {
    asked.push([core, [...routers], [...loans]]);
    return Promise.resolve(loans.map((id) => ids.includes(id)));
  },
  ...over,
});
const LOAN_ACTIONS = ["cancel", "reclaim", "cash_out", "roll", "auto_roll", "cancel_auto_roll"] as const;
const vault = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true };
/** Loans 7 and 8 on the core, both repaid with their collateral still to take back, and a vault pocket from each. */
const book = (pockets: unknown[] = [
  { id: 1, kind: "RECOVERY", loanId: "7", token: USDG, claimable: "5000000", private: false },
  { id: 2, kind: "RECOVERY", loanId: "8", token: USDG, claimable: "7000000", private: false },
]) => fakeUpstream({
  "/v2/positions?": (path: string) => ({ status: 200, body: {
    items: path.includes(`engine=${CORE}`) ? ["7", "8"].map((id) => position(id, {}, { state: 3, collateralBeneficiary: WALLET })) : [], nextCursor: null,
  } }),
  "/intent/partners/vaults?": { items: [vault], nextCursor: null },
  "/intent/partners/vaults/": { shares: "1", value: "1", withdrawableNow: "1", rewards: "0", pockets },
});
const repaid = { loan: () => Promise.resolve(chainLoan({ state: 3, collateralBeneficiary: WALLET })) };

describe("a loan the private lane opened, which the index marks public", () => {
  const c = () => ctx({ d: lane(), indexer: fakeUpstream({ "/v2/positions/": position("7") }), chain: opening([7n]) });

  it("reads as unknown", async () => {
    expect(await code(loan(c(), { loanId: "7" }))).toBe("NOT_FOUND");
  });

  it("is refused as unknown by every action on a loan, as a loan the index marks private is", async () => {
    for (const action of LOAN_ACTIONS) expect(await code(gageFrom(c()).prepare({ action, wallet: WALLET, loanId: "7" })), action).toBe("NOT_FOUND");
  });

  it("is never waited for", async () => {
    const funded = opening([43n], [], { loan: () => Promise.resolve(chainLoan({ fundedAt: NOW })) });
    const fast = { sleep: () => Promise.resolve(), pollSeconds: 10, timeoutSeconds: 30 };
    expect(await waitForFill(ctx({ d: lane(), indexer: fakeUpstream({ "/v2/positions/": position("43") }), chain: funded }), { loanId: "43" }, fast))
      .toMatchObject({ status: "waiting", fundingDeadline: null });
  });

  it("leaves the portfolio, its loans and its pockets each read from the chain in one call", async () => {
    const asked: unknown[] = [];
    const p = await portfolio(ctx({ d: lane(), indexer: book(), chain: opening([7n], asked) }), WALLET);
    expect(p.loans.map((l) => l.loanId)).toEqual(["8"]);
    expect(p.earn.map((e) => e.claimsReady)).toEqual([1]);
    expect(asked).toEqual([[getAddress(CORE), [getAddress(PRIVATE_ROUTER)], [7n, 8n]], [getAddress(CORE), [getAddress(PRIVATE_ROUTER)], [7n, 8n]]]);
  });

  it("leaves Collect all: neither its collateral nor its vault pocket", async () => {
    const p = await prepareNext(ctx({ d: lane(), indexer: book(), chain: opening([7n], [], repaid) }), { action: "collect", wallet: WALLET });
    expect(p.summary.rows).toEqual([{ label: "Collateral back", value: "5 NVDAx" }, { label: "Vault earnings", value: "7.00 USDG" }]);
  });
});

describe("a chain that cannot say whether the lane opened a loan", () => {
  const chains = () => [
    fakeChain({ privateLoans: (_core: Address, _routers: readonly Address[], ids: readonly bigint[]) => Promise.resolve(ids.map(() => null)) }),
    fakeChain({ privateLoans: () => Promise.resolve([]) }),
  ];

  it("keeps the loan unknown: a read that cannot tell, an answer short of the loans asked", async () => {
    for (const chain of chains()) {
      const c = ctx({ d: lane(), indexer: fakeUpstream({ "/v2/positions/": position("7") }), chain });
      expect(await code(loan(c, { loanId: "7" }))).toBe("NOT_FOUND");
      expect(await code(prepareNext(c, { action: "reclaim", wallet: WALLET, loanId: "7" }))).toBe("NOT_FOUND");
    }
  });

  it("leaves the loans and their pockets out of the portfolio and of Collect all", async () => {
    for (const chain of chains()) {
      const p = await portfolio(ctx({ d: lane(), indexer: book(), chain }), WALLET);
      expect(p.loans).toEqual([]);
      expect(p.earn.map((e) => e.claimsReady)).toEqual([0]);
      const collect = await prepareNext(ctx({ d: lane(), indexer: book(), chain: Object.assign(chain, repaid) }), { action: "collect", wallet: WALLET });
      expect(collect.next).toBeNull();
    }
  });

  // A read that fails says nothing of any loan: answered as the read failing, retryable, never as loans that are not
  // there. An empty portfolio could have an agent miss a loan it must repay before its term ends.
  it("fails the call, retryable, when the read itself fails: no loan left out, none shown", async () => {
    const down = () => fakeChain({ privateLoans: () => Promise.reject(new Error("socket hang up")) });
    const failure = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return refusalOf(e); } };
    const c = () => ctx({ d: lane(), indexer: fakeUpstream({ "/v2/positions/": position("7") }), chain: down() });
    expect(await failure(loan(c(), { loanId: "7" }))).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(await failure(prepareNext(c(), { action: "reclaim", wallet: WALLET, loanId: "7" }))).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(await failure(portfolio(ctx({ d: lane(), indexer: book(), chain: down() }), WALLET))).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(await failure(prepareNext(ctx({ d: lane(), indexer: book(), chain: Object.assign(down(), repaid) }), { action: "collect", wallet: WALLET })))
      .toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});

describe("a loan the chain bears out as public", () => {
  it("is shown as before", async () => {
    const asked: unknown[] = [];
    const l = await loan(ctx({ d: lane(), indexer: fakeUpstream({ "/v2/positions/": position("7") }), chain: opening([], asked) }), { loanId: "7" });
    expect(l).toMatchObject({ loanId: "7", state: "ACTIVE" });
    expect(asked).toEqual([[getAddress(CORE), [getAddress(PRIVATE_ROUTER)], [7n]]]);
  });

  it("is never asked about where no router lists: an earlier core without a lane, or a release without one", async () => {
    const asked: unknown[] = [];
    const indexer = fakeUpstream({ "/v2/positions/": position("7") });
    expect(await loan(ctx({ d: lane(), indexer, chain: opening([7n], asked) }), { loanId: "7", engine: OLD })).toMatchObject({ loanId: "7" });
    expect(await loan(ctx({ indexer, chain: opening([7n], asked) }), { loanId: "7" })).toMatchObject({ loanId: "7" });
    expect(asked).toEqual([]);
  });

  it("still needs the index's own marker: both must say public", async () => {
    for (const flag of [{ private: true }, { private: undefined }]) {
      expect(await code(loan(ctx({ d: lane(), indexer: fakeUpstream({ "/v2/positions/": position("7", flag) }), chain: opening([]) }), { loanId: "7" }))).toBe("NOT_FOUND");
    }
  });

  it("keeps a pocket the index names no loan for only where no router lists", async () => {
    const unnamed = () => book([{ id: 3, kind: "RECOVERY", token: USDG, claimable: "2000000", private: false }]);
    expect((await portfolio(ctx({ d: lane(), indexer: unnamed(), chain: opening([]) }), WALLET)).earn.map((e) => e.claimsReady)).toEqual([0]);
    expect((await portfolio(ctx({ indexer: unnamed(), chain: opening([]) }), WALLET)).earn.map((e) => e.claimsReady)).toEqual([1]);
  });
});

describe("the release's private lane", () => {
  const routers = (d: ReturnType<typeof parseDeployment>) => Object.fromEntries([...d.privateRouters].map(([core, list]) => [core, [...list]]));

  it("is each core's routers: the current one, those it retired, and each earlier core's", () => {
    const d = lane({ privateRouter: PRIVATE_ROUTER, retiredPrivateRouters: [A(0x62)], previousPrivateLanes: [{ generation: "r1", core: OLD, routers: [A(0x63), A(0x64)], startBlock: 1 }] });
    expect(routers(d)).toEqual({ [CORE]: [getAddress(PRIVATE_ROUTER), getAddress(A(0x62))], [OLD]: [getAddress(A(0x63)), getAddress(A(0x64))] });
  });

  it("stays on its core once retired, and is none where the release names none", () => {
    expect(routers(lane({ retiredPrivateRouters: [PRIVATE_ROUTER] }))).toEqual({ [CORE]: [getAddress(PRIVATE_ROUTER)] });
    expect(routers(lane({ previousPrivateLanes: [] }))).toEqual({});
    expect(parseDeployment(manifest()).privateRouters.size).toBe(0);
    expect(parseDeployment(mainnetManifest()).privateRouters.size).toBe(0);
  });

  it("refuses a router or a lane it cannot read, rather than guess", () => {
    expect(() => lane({ privateRouter: A(0) })).toThrow(/privateRouter/);
    expect(() => lane({ retiredPrivateRouters: ["0x12"] })).toThrow(/retiredPrivateRouters/);
    expect(() => lane({ retiredPrivateRouters: PRIVATE_ROUTER })).toThrow(/retiredPrivateRouters/);
    expect(() => lane({ previousPrivateLanes: [{ core: OLD, routers: [] }] })).toThrow(/previousPrivateLanes/);
    expect(() => lane({ previousPrivateLanes: [{ routers: [A(0x63)] }] })).toThrow(/previousPrivateLanes/);
  });
});
