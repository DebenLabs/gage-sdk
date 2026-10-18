import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { engineAbi } from "../src/abi.js";
import { parseDeployment } from "../src/deployment.js";
import { waitForFill } from "../src/fill.js";
import { run } from "../src/run.js";
import { ApiError, refusalOf } from "../src/errors.js";
import { prepareNext } from "../src/prepare.js";
import { borrowQuote, capabilities } from "../src/reads.js";
import { A, ACCOUNT, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, loan, mainnetManifest, NOW, NVDA, OTHER, position, WALLET } from "../src/testing.js";

const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return refusalOf(e); } };
const instant = (body: Record<string, unknown>) => fakeUpstream({ "/intent/instant/": { schema: "gage-intent-instant-v1", refusal: null, expiresAt: 1, answer: null, ...body } });
const quote = { token: NVDA, maxCollateral: "5000000000000000000", term: 604_800 };

describe("a pledge under the token's minimum", () => {
  // SPY's minimum on mainnet's core, 18 October 2026: 0.129484359193353593 SPY, about 99 USDG.
  const minimum = 129_484_359_193_353_593n;
  const chain = () => fakeChain({ tokenConfig: () => Promise.resolve({ allowed: true, lane: 0, minAmount: minimum, maxDealRaw: 0n, maxOpenRaw: 0n }) });

  it("is refused before any quote is asked, with the minimum rounded up and in raw units", async () => {
    const rates = fakeUpstream({});
    const r = await refusal(borrowQuote(ctx({ chain: chain(), rates }), { ...quote, maxCollateral: "9000000000000000" }));
    expect(r).toEqual({
      code: "COLLATERAL_BELOW_MINIMUM", message: "The least NVDAx one loan takes is 0.1295 NVDAx", retryable: false,
      details: { minimum: { token: NVDA, symbol: "NVDAx", decimals: 18, raw: "129484359193353593" } },
    });
    expect(rates.asked).toEqual([]);
  });

  it("says the same when a loan is prepared, never a minimum under the one needed", async () => {
    const r = await refusal(prepareNext(ctx({ chain: chain() }), { action: "borrow", wallet: WALLET, token: NVDA, collateral: "1000", principal: "1000000", cap: "1010000", term: 604_800 }));
    expect(r).toMatchObject({ code: "COLLATERAL_BELOW_MINIMUM", message: "The least NVDAx one loan takes is 0.1295 NVDAx" });
  });
});

describe("an instant answer with no loan", () => {
  it("names its reason as its own code, in fixed words", async () => {
    const asked = (reason: string) => refusal(borrowQuote(ctx({ rates: instant({ status: "unavailable", reason }) }), quote));
    expect(await asked("TOO_SMALL")).toMatchObject({ code: "LOAN_TOO_SMALL", message: "The partner vaults fund no loan this small; pledge more" });
    expect(await asked("DRY")).toMatchObject({ code: "INSUFFICIENT_CAPACITY" });
    expect(await asked("TERM")).toMatchObject({ code: "TERM_NOT_FUNDED" });
    expect(await asked("HOURS")).toMatchObject({ code: "ONE_DAY_CLOSED" });
    // A reason the SDK does not know is one fixed answer, never the service's text.
    expect(await asked("SOMETHING_NEW")).toEqual({ code: "RATES_REFUSED", message: "The partner vaults fund no loan for this pledge now", retryable: false });
  });

  it("keeps a refusal's own code, in gage-sdk's words", async () => {
    const r = await refusal(borrowQuote(ctx({ rates: instant({ status: "refused", refusal: { code: "ABOVE_MARKET_LIMIT", reason: "Above the market's limit" } }) }), quote));
    expect(r).toMatchObject({ code: "ABOVE_MARKET_LIMIT", message: "The loan repays more than this collateral's limit allows; borrow less" });
  });
});

// The audit of 18 October 2026 (H3): the instant answer sizes a loan for at most the tokens asked about. An answer that
// pledges more (or nothing) is not taken, or a quote's prepare object and a loop would pledge more than the wallet named.
describe("an instant answer outside the pledge asked about", () => {
  const pledging = (collateral: string) => instant({ status: "ok", expiresAt: NOW + 30, answer: {
    collateral, valueUSDG: "1000000000", principal: "600000000", cap: "606000000", costBps: 100, ltvBps: 6000, binds: "wallet", room: "0", vaults: 1,
  } });
  const loop = { action: "leverage" as const, wallet: WALLET, token: NVDA, own: "5000000000000000000", multiple: 2, term: 604_800, maxCostBps: 150 };

  it("is refused for a quote and for a loop, never taken as the wallet's pledge", async () => {
    expect(await refusal(borrowQuote(ctx({ rates: pledging("6000000000000000000") }), quote))).toMatchObject({ code: "RATES_UNAVAILABLE", retryable: false });
    expect(await refusal(borrowQuote(ctx({ rates: pledging("0") }), quote))).toMatchObject({ code: "RATES_UNAVAILABLE", retryable: false });
    expect(await refusal(prepareNext(ctx({ rates: pledging("6000000000000000000") }), loop))).toMatchObject({ code: "RATES_UNAVAILABLE", retryable: false });
  });

  it("is taken at or under it", async () => {
    expect((await borrowQuote(ctx({ rates: pledging("5000000000000000000") }), quote)).pledge).toBe("5000000000000000000");
    expect((await borrowQuote(ctx({ rates: pledging("4000000000000000000") }), quote)).prepare).toMatchObject({ collateral: "4000000000000000000" });
  });
});

describe("terms on mainnet", () => {
  const mainnet = (over = {}) => ctx({ d: parseDeployment(mainnetManifest()), chain: fakeChain({ terms: () => Promise.resolve([86_400, 604_800, 1_814_400]), ...over }) });

  it("are the product's 7 and 21 days, though the registry allows a 1-day term no vault there lends for", async () => {
    expect((await capabilities(mainnet())).terms).toEqual([{ seconds: 604_800, days: 7 }, { seconds: 1_814_400, days: 21 }]);
    const r = await refusal(prepareNext(mainnet(), { action: "borrow", wallet: WALLET, token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 86_400 }));
    expect(r).toMatchObject({ code: "TERM_NOT_ALLOWED", message: "Allowed terms: 7 days, 21 days" });
  });

  it("are every term the registry allows on the testnet", async () => {
    expect((await capabilities(ctx({ chain: fakeChain({ terms: () => Promise.resolve([86_400, 604_800]) }) }))).terms.map((t) => t.seconds)).toEqual([86_400, 604_800]);
  });
});

describe("refusals", () => {
  it("carry details only where the SDK computed them", () => {
    expect(refusalOf(new ApiError("X", "y"))).toEqual({ code: "X", message: "y", retryable: false });
    expect(refusalOf(new Error("rpc https://secret"))).toEqual({ code: "UNAVAILABLE", message: "gage could not answer this now", retryable: true });
  });
});

describe("a borrow's loan", () => {
  const borrowInput = { action: "borrow" as const, wallet: WALLET, token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 604_800 };
  /** The core's Listed log for `id`, as the receipt of a listing carries it. */
  const listed = (id: bigint, borrower: Address = WALLET, address: Address = CORE): Log => ({
    address, data: encodeAbiParameters(
      [{ type: "address" }, { type: "tuple", components: [{ type: "uint8" }, { type: "address" }, { type: "uint256" }] }, { type: "uint128" }, { type: "uint128" }, { type: "uint32" }, { type: "uint40" }],
      [ACCOUNT, [0, NVDA, 5n * 10n ** 18n], 1_000_000_000n, 1_010_000_000n, 604_800, NOW + 86_400]),
    topics: encodeEventTopics({ abi: engineAbi, eventName: "Listed", args: { id, borrower } }) as [Hex, ...Hex[]],
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  });
  const receipt = (logs: Log[]) => fakeChain({ allowance: () => Promise.resolve(10n ** 30n), sent: () => Promise.resolve({ from: WALLET, to: CORE, input: "0x", success: true, logs }) });

  it("is named by the listing's own receipt: the wallet's listing on the core, no other", async () => {
    const r = await run(ctx({ chain: receipt([listed(41n, OTHER), listed(42n, WALLET, A(0x99)), listed(43n)]) }), borrowInput, fakeSigner());
    expect(r).toMatchObject({ status: "done", loan: { engine: getAddress(CORE), loanId: "43" } });
    expect((await run(ctx({ chain: receipt([]) }), borrowInput, fakeSigner())).loan).toBeNull();
  });

  it("is none for an action that opens no loan", async () => {
    const r = await run(ctx({ indexer: fakeUpstream({ "/v2/positions/": position("7", {}, { state: 1 }) }), chain: fakeChain({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0 })) }) }), { action: "cancel", wallet: WALLET, loanId: "7" }, fakeSigner());
    expect(r.loan).toBeNull();
  });
});

describe("waitForFill", () => {
  const indexed = () => fakeUpstream({ "/v2/positions/": position("43") });
  const at = (states: Partial<Parameters<typeof loan>[0]>[]) => {
    let n = 0;
    return fakeChain({ loan: () => Promise.resolve(loan(states[Math.min(n++, states.length - 1)])) });
  };
  const fast = { sleep: () => Promise.resolve(), pollSeconds: 10, timeoutSeconds: 60 };

  it("answers once the vaults fund it, with when it ends and what the wallet receives", async () => {
    const chain = at([{ state: 1, fundedAt: 0 }, { state: 1, fundedAt: 0 }, { state: 2, fundedAt: NOW, originationFee: 10_000_000n }]);
    expect(await waitForFill(ctx({ indexer: indexed(), chain }), { loanId: "43" }, fast))
      .toEqual({ status: "funded", engine: getAddress(CORE), loanId: "43", fundedAt: NOW, endsAt: NOW + 604_800, receive: "990000000" });
  });

  it("says it is still waiting when the wait ends, expired past its funding window, cancelled or closed", async () => {
    expect(await waitForFill(ctx({ indexer: indexed(), chain: at([{ state: 1, fundedAt: 0 }]) }), { loanId: "43" }, fast)).toMatchObject({ status: "waiting", fundingDeadline: NOW + 86_400 });
    expect(await waitForFill(ctx({ indexer: indexed(), chain: at([{ state: 1, fundedAt: 0, fundingDeadline: NOW }]) }), { loanId: "43" }, fast)).toMatchObject({ status: "expired" });
    expect(await waitForFill(ctx({ indexer: indexed(), chain: at([{ state: 5 }]) }), { loanId: "43" }, fast)).toMatchObject({ status: "cancelled" });
    expect(await waitForFill(ctx({ indexer: indexed(), chain: at([{ state: 3 }]) }), { loanId: "43" }, fast)).toMatchObject({ status: "closed", state: "REPAID" });
  });

  it("serves no loan the index does not show public, and waits for one it does not show yet", async () => {
    const hidden = fakeUpstream({ "/v2/positions/": position("43", { private: true }) });
    expect(await waitForFill(ctx({ indexer: hidden, chain: at([{ state: 2 }]) }), { loanId: "43" }, fast)).toMatchObject({ status: "waiting", fundingDeadline: null });
    let n = 0;
    const late = fakeUpstream({ "/v2/positions/": () => ((n += 1) > 2 ? { status: 200, body: position("43") } : { status: 404, body: {} }) });
    expect(await waitForFill(ctx({ indexer: late, chain: at([{ state: 2, fundedAt: NOW }]) }), { loanId: "43" }, fast)).toMatchObject({ status: "funded" });
  });
});

describe("an exact loan's quote", () => {
  // The model's curve for 5 NVDAx (1,000 USDG of value): 20 bps up to 400 USDG, 30 bps up to 900.
  const curve = { status: "preview", costBps: 30, collateralValueRaw: "1000000000", sizing: { curve: [
    { principalRaw: "399201596", repaymentRaw: "400000000", costBps: 20 }, { principalRaw: "897308075", repaymentRaw: "900000000", costBps: 30 },
  ] } };
  const previewAt = (over: { modelBps?: number; accepts?: boolean; floor?: number; fills?: boolean } = {}) => (path: string) => {
    const q = new URL(path, "http://rates.test").searchParams;
    return { status: 200, body: {
      schema: "gage-intent-preview-v1", status: "ok", refusal: null, vaults: [],
      listing: { cap: q.get("cap") }, pricing: { costBps: over.modelBps ?? 20 },
      summary: { units: over.fills === false ? 0 : 4, fills: over.fills ?? true, reason: over.fills === false ? "INSUFFICIENT_LIQUIDITY" : null,
        accepts: over.accepts ?? true, acceptFloorTenths: over.floor ?? 150, acceptMaxPrincipal: "5000000000" },
    } };
  };
  const rates = (pv = previewAt()) => fakeUpstream({ "/rates/suggest": curve, "/intent/preview/": pv });
  const exact = { token: NVDA, term: 604_800, collateral: "5000000000000000000", principal: "300000000" };

  it("prices the amount at the model's cost for it on this pledge, as the borrow card does", async () => {
    const r = rates();
    const q = await borrowQuote(ctx({ rates: r }), exact);
    expect(q).toMatchObject({
      mode: "exact", principal: "300000000", repay: "300600000", costBps: 20, receive: "297000000", ltvBps: 3000, fundsNow: true, accepted: true,
      prepare: { action: "borrow", token: NVDA, collateral: "5000000000000000000", principal: "300000000", cap: "300600000", term: 604_800 },
    });
    expect(r.asked[0]).toBe(`/rates/suggest?chainId=46630&term=604800&engine=${CORE}&token=${NVDA}&collateral=5000000000000000000&maxRepaymentBps=9000`);
  });

  it("raises the cost to the model's for these exact terms, then to the lowest the vaults' settings take it whole at", async () => {
    expect(await borrowQuote(ctx({ rates: rates(previewAt({ modelBps: 25 })) }), exact)).toMatchObject({ repay: "300750000", costBps: 25 });
    expect(await borrowQuote(ctx({ rates: rates(previewAt({ accepts: false, floor: 275 })) }), exact)).toMatchObject({ repay: "300825000", costBps: 27.5 });
  });

  it("says when the vaults would make it wait, and how much the pledge supports at most", async () => {
    expect(await borrowQuote(ctx({ rates: rates(previewAt({ fills: false })) }), exact)).toMatchObject({ fundsNow: false, waitsFor: "INSUFFICIENT_LIQUIDITY" });
    const r = await refusal(borrowQuote(ctx({ rates: rates() }), { ...exact, principal: "950000000" }));
    expect(r).toEqual({ code: "PRINCIPAL_TOO_HIGH", message: "This pledge supports a loan of at most 897.30 USDG now; borrow less or pledge more", retryable: false, details: { maxPrincipal: "897308075" } });
  });

  it("is asked one way or the other, never both", async () => {
    for (const bad of [{ token: NVDA, term: 604_800 }, { ...exact, maxCollateral: "1" }, { token: NVDA, term: 604_800, principal: "1" }]) {
      expect(await refusal(borrowQuote(ctx({ rates: rates() }), bad))).toMatchObject({ code: "INVALID_INPUT" });
    }
  });
});
