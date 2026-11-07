/**
 * What a team building on gage-sdk meets first: a quote before any wallet is connected, a list of what can be borrowed
 * now, a failure in the SDK's own words, and a refusal that says what it means and whether trying again can help.
 */
import { inspect } from "node:util";
import { ContractFunctionExecutionError, createWalletClient, custom, decodeFunctionData, getAddress, HttpRequestError, RpcRequestError, type Address, type BaseError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { cashoutRouterAbi } from "../src/abi.js";
import { createGage, gageFrom } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError, refusalOf, withoutUrls } from "../src/errors.js";
import { waitForFill } from "../src/fill.js";
import { prepareNext } from "../src/prepare.js";
import { assets, borrowQuote, leverageQuote, loan as readLoan, putQuote } from "../src/reads.js";
import { run } from "../src/run.js";
import { address, parseInput } from "../src/schemas.js";
import { viemSigner } from "../src/signer.js";
import {
  A, assetManifest, CASHOUT, cashoutSale, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, GLD_CORE, GLDX, loan, lpManifest, mainnetManifest, manifest, NOW, NVDA, position, preview, PUT_POOL, putManifest, REG, rollQuote, ROUTER, SCHIFFY, signedLoop, USDG, VAULT, WALLET,
} from "../src/testing.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return refusalOf(e); } };
const INSTANT = { schema: "gage-intent-instant-v1", status: "ok", refusal: null, expiresAt: NOW + 30, answer: { collateral: "2000000000000000000", valueUSDG: "400000000", principal: "300000000", cap: "303000000", costBps: 100, ltvBps: 7500, binds: "wallet", room: "0", vaults: 1 } };
const noInstant = (reason: string) => fakeUpstream({ "/intent/instant/": { schema: "gage-intent-instant-v1", status: "unavailable", refusal: null, expiresAt: NOW, answer: null, reason } });

describe("a quote with no wallet yet", () => {
  /** The rates service, which refuses a preview for gage's own routers as borrower, as it does a filler's own listing. */
  const routerRefused = (route: unknown) => fakeUpstream({
    "/intent/instant/": INSTANT, "/rates/suggest": route,
    "/intent/preview/": (path: string) => (new URL(path, "http://x.test").searchParams.get("borrower") === ROUTER.toLowerCase() || new URL(path, "http://x.test").searchParams.get("borrower") === A(0xb3).toLowerCase()
      ? { status: 200, body: { schema: "gage-intent-preview-v1", status: "refused", refusal: { code: "SELF_DEALING" }, vaults: [], summary: null } }
      : { status: 200, body: preview() }),
  });

  it("prices a loop as the core's own preview does, never as gage's router", async () => {
    const answer = await leverageQuote(ctx({ rates: routerRefused({}) }), { token: NVDA, own: "2000000000000000000", multiple: 2, term: 604_800 });
    expect(answer).toMatchObject({ own: "2000000000000000000", prepare: { action: "leverage" } });
  });

  it("prices a put the same way", async () => {
    const curve = { status: "preview", costBps: 100, collateralValueRaw: String(10n ** 21n), sizing: { curve: [{ principalRaw: String(10n ** 30n), repaymentRaw: String(10n ** 30n), costBps: 100 }] } };
    const c = ctx({ d: parseDeployment(putManifest()), rates: routerRefused(curve), chain: fakeChain({ poolState: () => Promise.resolve(PUT_POOL) }) });
    expect(await putQuote(c, { lendAsset: GLDX, margin: "100000000", size: 2, term: 604_800 })).toMatchObject({ margin: "100000000", prepare: { action: "put_open" } });
  });
});

describe("what can be borrowed", () => {
  const vaultRow = (assetsOf: string[], fundingEnabled = true) => ({ address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 604_800, assets: assetsOf, fundingEnabled });
  const twoAssets = () => ({ ...manifest(), nativeV2: { ...manifest().nativeV2, assets: [...manifest().nativeV2.assets, { token: A(0x1a), symbol: "WETH", name: "WETH", decimals: 18, lane: "ETH" }] } });

  it("says how many partner vaults lend against each token now, a vault that does not lend counting none", async () => {
    const indexer = fakeUpstream({ "/intent/partners/vaults?": { items: [vaultRow([NVDA]), vaultRow([NVDA], false)], nextCursor: null } });
    const rows = (await assets(ctx({ d: parseDeployment(twoAssets()), indexer }))).assets;
    expect(rows.map((r) => [r.symbol, r.vaults])).toEqual([["NVDAx", 1], ["WETH", 0]]);
  });

  it("counts by the generation a row is borrowed in, and says it does not know while gage's index does not answer", async () => {
    const indexer = fakeUpstream({ "/intent/partners/vaults?": (path: string) => ({ status: 200, body: { items: path.includes("factory=") ? [{ ...vaultRow([SCHIFFY]), core: GLD_CORE }] : [], nextCursor: null } }) });
    const rows = (await assets(ctx({ d: parseDeployment(assetManifest()), indexer }))).assets;
    expect(rows.map((r) => [r.symbol, r.vaults])).toEqual([["NVDAx", 0], ["SCHIFFYx", 1]]);
    const down = fakeUpstream({ "/intent/partners/vaults?": () => ({ status: 503, body: {} }) });
    expect((await assets(ctx({ indexer: down }))).assets.map((r) => r.vaults)).toEqual([null]);
  });

  it("gives a stock its display multiplier, and says none for a token without one", async () => {
    const rows = (await assets(ctx({ chain: fakeChain({ uiMultipliers: (tokens: readonly Address[]) => Promise.resolve(tokens.map(() => 1_000_775_000_000_000_000n)) }) }))).assets;
    expect(rows[0]).toMatchObject({ symbol: "NVDAx", lane: "STOCK", uiMultiplier: "1000775000000000000" });
    expect((await assets(ctx())).assets[0]!.uiMultiplier).toBeNull();
  });

  it("refuses a token no vault lends against in the app's words, never that gage does not take it", async () => {
    const answer = await refusal(borrowQuote(ctx({ rates: noInstant("NONE") }), { token: NVDA, maxCollateral: "1000000000000000000", term: 604_800 }));
    expect(answer).toMatchObject({ code: "NO_VAULT_LENDS", retryable: false });
    expect(answer!.message).toBe("No partner vault takes this token right now");
  });

  it("refuses a term gage does not offer as that, before anything is quoted", async () => {
    const rates = noInstant("NONE");
    for (const q of [{ maxCollateral: "1000000000000000000" }, { collateral: "1000000000000000000", principal: "1000000" }]) {
      expect(await refusal(borrowQuote(ctx({ d: parseDeployment(mainnetManifest()), rates }), { token: NVDA, term: 86_400, ...q }))).toMatchObject({ code: "TERM_NOT_ALLOWED" });
    }
    expect(rates.asked).toEqual([]);
    expect(await code(leverageQuote(ctx({ rates }), { token: NVDA, own: "1", multiple: 2, term: 1 }))).toBe("TERM_NOT_ALLOWED");
  });
});

describe("a failure of the chain or a node", () => {
  const dead = (message: string) => () => Promise.reject(new Error(message));

  it("reaches a caller in the SDK's own words, retryable, with what failed as its cause", async () => {
    const gage = gageFrom(ctx({ chain: fakeChain({ tokenConfig: dead("HTTP request failed. URL: https://rpc.example/secretkey123") }) }));
    const error = await gage.assets().catch((e: unknown) => e) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(error.message).toBe("gage could not answer this now");
    expect((error.cause as Error).message).toContain("HTTP request failed");
  });

  it("never prints a node's URL or key, by any way a log writes an error", async () => {
    const failure = Object.assign(new Error("RPC Request failed.\n\nURL: https://rpc.example/v2/secretkey123\nRequest body: {}"), { name: "ContractFunctionExecutionError", shortMessage: "RPC Request failed.", details: "over the limit at wss://rpc.example/secretkey123" });
    const gage = gageFrom(ctx({ chain: fakeChain({ tokenConfig: () => Promise.reject(failure) }) }));
    const error = await gage.assets().catch((e: unknown) => e) as ApiError;
    for (const printed of [inspect(error, { depth: 8 }), JSON.stringify(error), String(error.stack), String((error.cause as Error).message), String((error.cause as Error).stack)]) expect(printed).not.toContain("secretkey123");
    expect(error.cause).toMatchObject({ name: "ContractFunctionExecutionError" });
    expect((error.cause as Error).message).toMatch(/RPC Request failed/);
  });

  it("names the read that failed and what the node answered, never where", async () => {
    const url = "https://rpc.example/v2/secretkey123";
    const read = (cause: BaseError) => new ContractFunctionExecutionError(cause, { abi: [], functionName: "getERC20Config", args: [NVDA], contractAddress: REG });
    const failures = [
      [read(new HttpRequestError({ url, status: 503, details: "Service Unavailable" })), { status: 503 }],
      [read(new RpcRequestError({ url, body: { method: "eth_call" }, error: { code: -32005, message: "over the limit" } })), { code: -32005 }],
    ] as const;
    for (const [failure, answered] of failures) {
      const error = await gageFrom(ctx({ chain: fakeChain({ tokenConfig: () => Promise.reject(failure) }) })).assets().catch((e: unknown) => e) as ApiError;
      const named = { name: "ContractFunctionExecutionError", contractAddress: REG, functionName: "getERC20Config", ...answered };
      expect(error.cause).toMatchObject(named);
      // Read again, it says the same: a log may pass any failure through it, the SDK's own causes among them.
      expect(withoutUrls(error.cause)).toMatchObject({ ...named, message: (error.cause as Error).message });
      for (const printed of [inspect(error, { depth: 8 }), JSON.stringify(error), String((error.cause as Error).message)]) expect(printed).not.toContain("secretkey123");
    }
  });

  it("is not a caller's own bug, which asking again cannot clear", async () => {
    const gage = gageFrom(ctx());
    const signer = fakeSigner();
    for (const call of [() => gage.run(null as never, signer), () => gage.run({ action: "collect" } as never, undefined as never)]) {
      await expect(call()).rejects.toMatchObject({ code: "INVALID_CALL", retryable: false });
    }
    // A Chain of its own, written for an earlier release, that lacks a method this one asks of it.
    const old = gageFrom(ctx({ chain: fakeChain({ uiMultipliers: undefined as never }) }));
    await expect(old.assets()).rejects.toMatchObject({ code: "INVALID_CALL", retryable: false });
  });

  it("does so for every method, a refusal of its own passing through unchanged", async () => {
    const chain = fakeChain({ loan: dead("boom"), nativeBalance: dead("boom"), terms: dead("boom"), simulate: dead("boom") });
    const gage = gageFrom(ctx({ chain, indexer: fakeUpstream({ "/v2/positions/": position("7") }) }));
    expect(await code(gage.balances(WALLET))).toBe("UNAVAILABLE");
    expect(await code(gage.capabilities())).toBe("UNAVAILABLE");
    expect(await code(gage.prepare({ action: "reclaim", wallet: WALLET, loanId: "7" }))).toBe("UNAVAILABLE");
    expect(await code(gage.balances("nope"))).toBe("INVALID_INPUT");
  });

  it("reads the same from createGage over a dead RPC", async () => {
    const gage = createGage({ rpcUrl: "http://127.0.0.1:9/secretkey123", fetch: () => Promise.reject(new Error("off")) });
    const error = await gage.capabilities().catch((e: unknown) => e) as ApiError;
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(error.message).not.toContain("secretkey123");
  }, 30_000);

  it("names a rate limit's wait where the service gives one", async () => {
    const limited = (async () => Promise.resolve(new Response("{}", { status: 429, headers: { "Retry-After": "12" } }))) as typeof fetch;
    const gage = createGage({ fetch: limited });
    await expect(gage.ctx.rates.raw("/x")).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, details: { retryAfterSeconds: 12 } });
    const none = (async () => Promise.resolve(new Response("{}", { status: 429 }))) as typeof fetch;
    await expect(createGage({ fetch: none }).ctx.rates.raw("/x")).rejects.toMatchObject({ code: "RATE_LIMITED", details: undefined });
  });
});

describe("a viem signer with no chain of its own", () => {
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const client = () => createWalletClient({ account: privateKeyToAccount(KEY), transport: custom({ request: () => Promise.reject(new Error("no node here")) }) });

  it("signs for mainnet, as everything else defaults to it, refusing another chain's transaction", async () => {
    const signer = viemSigner(client());
    const tx = { to: USDG, data: "0x" as const, value: 0n, gas: 21_000n };
    await expect((async () => signer.sendTransaction({ ...tx, chainId: 46630 }))()).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
    await expect((async () => signer.sendTransaction({ ...tx, chainId: 4663 }))()).rejects.not.toMatchObject({ code: "CHAIN_MISMATCH" });
  });

  it("reaches run() as itself, not as a send that failed, and leaves a limit's hold released", async () => {
    const borrow = { action: "borrow" as const, wallet: WALLET, token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 604_800 };
    const released: boolean[] = [];
    const signer = fakeSigner();
    signer.sendTransaction = (tx) => (tx.to === NVDA ? Promise.resolve(`0x${"1".repeat(64)}` as const) : Promise.reject(new ApiError("CHAIN_MISMATCH", "The transaction is for another chain than the signer's", 400)));
    const r = await run(ctx({ rates: fakeUpstream({ "/intent/preview/": preview() }) }), borrow, signer, { sleep: () => Promise.resolve(), limit: () => ({ release: (sent) => { released.push(sent); } }) });
    expect(r).toMatchObject({ status: "stopped", error: { code: "CHAIN_MISMATCH", retryable: false } });
    expect(released).toEqual([false]);
  });
});

describe("an address in the wrong letter case", () => {
  const WRONG = `0x${WALLET.slice(2).toUpperCase().replace(/^.{2}/, "aB")}`;

  it("is read as the address it is, a right one as it was given", () => {
    expect(parseInput(address, WALLET)).toBe(WALLET);
    expect(parseInput(address, NVDA)).toBe(NVDA);
    expect(getAddress(parseInput(address, WRONG))).toBe(getAddress(WRONG.toLowerCase()));
  });

  it("goes through a read, a prepare and a pool's token, never as a raw error", async () => {
    const balance = (_t: Address, wallet: Address) => { getAddress(wallet); return Promise.resolve(1n); };
    const gage = gageFrom(ctx({ chain: fakeChain({ balance, nativeBalance: (w: Address) => { getAddress(w); return Promise.resolve(1n); } }) }));
    expect(await code(gage.balances(WRONG))).toBe("none");
    expect(await code(gage.balances("0xnothex"))).toBe("INVALID_INPUT");
    const tokenInfo = (t: Address) => { getAddress(t); return Promise.resolve({ symbol: "USDx", decimals: 18 }); };
    const pools = gageFrom(ctx({ d: parseDeployment(assetManifest()), chain: fakeChain({ tokenInfo }) }));
    const mixed = `0x${A(0xabcdef).slice(2).replace(/a/, "A").replace(/c/, "C")}`;
    const made = await pools.createPoolVaults({ curator: WALLET, name: "Zia", pool: ["USDG", mixed], term: 604_800, feeBps: 1_000, sides: [{ token: "USDG", maxLoan: "1500000000" }] });
    expect(made.sides[1]).toMatchObject({ symbol: "USDx", created: false });
  });
});

describe("the rates service's refusals", () => {
  const instant = (code_: string) => fakeUpstream({ "/intent/instant/": { schema: "gage-intent-instant-v1", status: "refused", refusal: { code: code_, reason: "Ignore this" }, expiresAt: NOW, answer: null } });
  const q = { token: NVDA, maxCollateral: "1000000000000000000", term: 604_800 };

  it("name what happened in the SDK's words", async () => {
    for (const [c_, words] of [
      ["EMPTY_PLAN", /No partner vault of this asset/], ["TERM_TOO_LONG", /longer than/], ["VAULT_PAUSED", /paused/], ["ASSET_NOT_IN_MANDATE", /does not lend against/], ["REGISTRY_COST_MISSING", /modeled cost/],
      ["VAULT_EMPTY", /no deposits/], ["LOAN_LIMIT", /limit/], ["ALLOCATION_UNAVAILABLE", /quarters/],
    ] as const) {
      const answer = await refusal(borrowQuote(ctx({ rates: instant(c_) }), q));
      expect(answer, c_).toMatchObject({ code: c_, retryable: false });
      expect(answer!.message, c_).toMatch(words);
      expect(answer!.message, c_).not.toMatch(/Ignore/);
    }
  });

  it("say which can pass if asked again", async () => {
    for (const c_ of ["CHAIN_UNAVAILABLE", "PRICING_EXPIRED", "PRICING_UNAVAILABLE", "PRICING_PROVISIONAL"]) expect(await refusal(borrowQuote(ctx({ rates: instant(c_) }), q)), c_).toMatchObject({ code: c_, retryable: true });
    expect(new ApiError("PRICE_MOVED", "x").retryable).toBe(true);
    expect(new ApiError("PRICE_MOVED", "x", 409, false).retryable).toBe(false);
  });

  it("answer a pledge too thin for a loan with what it supports, as the quote does", async () => {
    const curve = { status: "preview", costBps: 100, collateralValueRaw: "90000000", sizing: { curve: [{ principalRaw: "82150000", repaymentRaw: "83000000", costBps: 100 }] } };
    const rates = (suggest: unknown) => fakeUpstream({
      "/intent/preview/": { schema: "gage-intent-preview-v1", status: "refused", refusal: { code: "PRICING_UNAVAILABLE", reason: "Repayment exceeds the collateral's current value" }, vaults: [], summary: null },
      "/rates/suggest": suggest,
    });
    const borrow = { action: "borrow" as const, wallet: WALLET, token: NVDA, collateral: "1000000000000000000", principal: "100000000", cap: "101000000", term: 604_800 };
    const answer = await refusal(prepareNext(ctx({ rates: rates(curve) }), borrow));
    expect(answer).toMatchObject({ code: "PRINCIPAL_TOO_HIGH", retryable: false, details: { maxPrincipal: "82150000" } });
    expect(answer!.message).toBe("This pledge supports a loan of at most 82.15 USDG now; borrow less or pledge more");
    // Within what it supports, or with no curve to say, the model's own refusal stands.
    expect(await refusal(prepareNext(ctx({ rates: rates(curve) }), { ...borrow, principal: "50000000", cap: "50500000" }))).toMatchObject({ code: "PRICING_UNAVAILABLE", retryable: true });
    expect(await refusal(prepareNext(ctx({ rates: fakeUpstream({ "/intent/preview/": { schema: "gage-intent-preview-v1", status: "refused", refusal: { code: "PRICING_UNAVAILABLE" }, vaults: [], summary: null } }) }), borrow))).toMatchObject({ code: "PRICING_UNAVAILABLE" });
  });
});

describe("a cash-out whose fresh quote moved a little", () => {
  const indexer = () => fakeUpstream({ "/v2/positions/": position("7") });
  const input = { action: "cash_out" as const, wallet: WALLET, loanId: "7" };
  const chain = () => fakeChain({ approvedFor: () => Promise.resolve(CASHOUT) });
  const quoted = (outs: (bigint | null)[]) => {
    let n = 0;
    return fakeUpstream({ "/quote/cashout-sale": (path: string) => { const out = outs[Math.min(n++, outs.length - 1)]!; return out === null ? { status: 503, body: {} } : cashoutSale({ amountOut: out })(path); } });
  };

  it("goes through while it stays above the plan's floor, holding the sale to that floor", async () => {
    // Planned at 1,100 USDG (net 89.44, at least 89.00); quoted again at 1,099.75 (net about 89.20).
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: indexer(), valuation: quoted([1_100_000_000n, 1_099_750_000n]), chain: chain() }), input, signer);
    expect(r).toMatchObject({ status: "done" });
    expect(decodeFunctionData({ abi: cashoutRouterAbi, data: signer.sent[0]!.data }).args[0]).toMatchObject({ minimumNet: 89_002_258n });
  });

  it("stops under the floor as a price that moved, which preparing again can clear", async () => {
    const r = await run(ctx({ indexer: indexer(), valuation: quoted([1_100_000_000n, 1_099_000_000n]), chain: chain() }), input, fakeSigner());
    expect(r).toMatchObject({ status: "stopped", error: { code: "PRICE_MOVED", retryable: true } });
  });

  it("says the aggregator did not answer rather than that the sale pays less", async () => {
    const r = await run(ctx({ indexer: indexer(), valuation: quoted([1_100_000_000n, null]), chain: chain() }), input, fakeSigner());
    expect(r).toMatchObject({ status: "stopped", error: { code: "SALE_UNAVAILABLE", retryable: true } });
    expect(await refusal(prepareNext(ctx({ indexer: indexer(), valuation: quoted([null]), chain: chain() }), input))).toMatchObject({ code: "NO_SALE", retryable: true });
  });
});

describe("a loan's end, by the chain's clock", () => {
  const indexer = () => fakeUpstream({ "/v2/positions/": position("7") });
  const input = { action: "reclaim" as const, wallet: WALLET, loanId: "7" };
  const ends = NOW + 100;
  const running = () => Promise.resolve(loan({ fundedAt: ends - 604_800 }));

  it("lets a machine ahead of the chain repay what the chain still takes", async () => {
    const chain = fakeChain({ loan: running, head: () => Promise.resolve({ number: 1n, timestamp: ends - 1 }) });
    const c = { ...ctx({ indexer: indexer(), chain }), now: () => ends + 3_600 };
    expect((await prepareNext(c, input)).status).toBe("approval_required");
    expect((await readLoan(c, { loanId: "7" })).actions.join(" ")).toMatch(/reclaim/);
  });

  it("refuses at the chain's end though the machine's clock is behind", async () => {
    const chain = fakeChain({ loan: running, head: () => Promise.resolve({ number: 1n, timestamp: ends }) });
    const c = { ...ctx({ indexer: indexer(), chain }), now: () => ends - 3_600 };
    expect(await code(prepareNext(c, input))).toBe("TERM_ENDED");
    expect((await readLoan(c, { loanId: "7" })).actions.join(" ")).not.toMatch(/reclaim/);
  });

  describe("on a core that takes repayment past the term (`GRACE`)", () => {
    const GRACE = 172_800;
    const at = (timestamp: number, coreGrace: () => Promise<number> = () => Promise.resolve(GRACE)) =>
      ctx({ indexer: indexer(), chain: fakeChain({ loan: running, coreGrace, head: () => Promise.resolve({ number: 1n, timestamp }) }) });

    it("plans the repayment until the chain closes it, and draws that end", async () => {
      const p = await prepareNext(at(ends - 1), input);
      expect(p.status).toBe("approval_required");
      expect(p.view).toMatchObject({ action: "reclaim", endsAt: ends + GRACE });
      expect(p.notes.join(" ")).not.toMatch(/term has ended/);
    });
    it("in the window past the term, says the term has ended and when the repayment closes", async () => {
      const p = await prepareNext(at(ends), input);
      expect(p.status).toBe("approval_required");
      expect(p.view).toMatchObject({ action: "reclaim", endsAt: ends + GRACE });
      expect(p.notes.join(" ")).toMatch(/term has ended/);
      expect((await prepareNext(at(ends + GRACE - 1), input)).status).toBe("approval_required");
    });
    it("warns of the last minute by the end the chain keeps, not the term's", async () => {
      expect((await prepareNext(at(ends - 30), input)).notes.join(" ")).not.toMatch(/under a minute/);
      expect((await prepareNext(at(ends + GRACE - 30), input)).notes.join(" ")).toMatch(/under a minute/);
    });
    it("refuses from the second the chain does", async () => {
      expect(await code(prepareNext(at(ends + GRACE), input))).toBe("TERM_ENDED");
    });
    it("never says the lenders keep the collateral on a read that failed", async () => {
      const silent = () => Promise.reject(new Error("rpc down"));
      // Inside the term the term's own end still holds: nothing is refused, and no later end is promised.
      const p = await prepareNext(at(ends - 1, silent), input);
      expect(p.status).toBe("approval_required");
      expect(p.view).toMatchObject({ endsAt: ends });
      await expect(prepareNext(at(ends, silent), input)).rejects.toThrow(/rpc down/);
    });
  });

  it("says how little time is left when an approval must go first, and still offers it", async () => {
    const chain = fakeChain({ loan: running, head: () => Promise.resolve({ number: 1n, timestamp: ends - 30 }) });
    const p = await prepareNext(ctx({ indexer: indexer(), chain }), input);
    expect(p.status).toBe("approval_required");
    expect(p.notes.join(" ")).toMatch(/under a minute/);
    const approved = fakeChain({ loan: running, head: () => Promise.resolve({ number: 1n, timestamp: ends - 30 }), allowance: () => Promise.resolve(10n ** 30n) });
    expect((await prepareNext(ctx({ indexer: indexer(), chain: approved }), input)).notes.join(" ")).not.toMatch(/under a minute/);
  });
});

describe("a roll's first read", () => {
  it("asks again when the price expired, as the signed plans do", async () => {
    let asked = 0;
    const route = rollQuote();
    const rates = fakeUpstream({ "/intent/roll/quotes/": (path: string) => {
      asked += 1;
      return asked === 1 ? { status: 200, body: { schema: "gage-intent-roll-quote-v1", status: "refused", refusal: { code: "PRICING_EXPIRED" }, unsigned: null, router: null, terms: null, wallet: null, authorization: null } } : route(path);
    } });
    const { rollFigures } = await import("../src/intent.js");
    const figures = await rollFigures(rates, { engine: CORE, loanId: 7n, borrower: WALLET, term: 604_800, oldPrincipal: 1_000_000_000n, oldCap: 1_010_000_000n }, () => Promise.resolve());
    expect(figures.terms.principal).toBe(1_000_000_000n);
    expect(asked).toBe(2);
  });
});

describe("waitForFill on a listing gage's index has not shown", () => {
  it("is still waiting when the wait is over, with no deadline to give", async () => {
    const c = ctx({ indexer: fakeUpstream({}), chain: fakeChain({ loan: () => Promise.resolve(loan({ state: 1, fundedAt: 0 })) }) });
    expect(await waitForFill(c, { loanId: "9" }, { timeoutSeconds: 1, pollSeconds: 1, sleep: () => Promise.resolve() })).toEqual({ status: "waiting", engine: CORE, loanId: "9", fundingDeadline: null });
  });
});

describe("the fakes of gage-sdk/testing", () => {
  it("answer a quote out of the box, a worked sample rather than no such route", async () => {
    const gage = gageFrom(ctx());
    const q = await gage.borrowQuote({ token: NVDA, maxCollateral: "2000000000000000000", term: 604_800 });
    expect(q).toMatchObject({ pledge: "2000000000000000000", prepare: { action: "borrow", token: NVDA } });
    // A smaller pledge is answered as itself: the sample never pledges more than it was asked about.
    expect(await gage.borrowQuote({ token: NVDA, maxCollateral: "1000000000000000000", term: 604_800 })).toMatchObject({ pledge: "1000000000000000000" });
  });
});

describe("a rolled LP loan", () => {
  it("says it rolled, never that the position went to its lenders", async () => {
    const { lpLoan } = await import("../src/testing.js");
    const rolled = { ...ctx({ d: parseDeployment(lpManifest()), chain: fakeChain({ lpNextLoanId: () => Promise.resolve(2n), lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, state: 5 }))) }) }) };
    for (const action of ["lp_repay", "lp_return_position"] as const) {
      const answer = await refusal(prepareNext(rolled, { action, wallet: WALLET, loanId: "1" }));
      expect(answer!.message, action).toMatch(/rolled into a new one on the same position/);
      expect(answer!.message, action).not.toMatch(/went to the lenders/);
    }
  });
});

describe("a found generation's cash-out router", () => {
  it("is offered here only where it answers a flash pool: a v4 router's sales are gage.cash's", async () => {
    const indexer = fakeUpstream({ "/v2/positions/": position("7") });
    const valuation = fakeUpstream({ "/quote/cashout-sale": cashoutSale() });
    const actions = async (flash: Address | null) => (await readLoan(ctx({ indexer, valuation, chain: fakeChain({ cashoutFlashPool: () => Promise.resolve(flash) }) }), { loanId: "7" })).actions.join(" ");
    expect(await actions(A(0xe9))).toMatch(/cash_out \(/);
    expect(await actions(null)).toMatch(/cash_out on /);
    expect(await code(prepareNext(ctx({ indexer, valuation, chain: fakeChain({ cashoutFlashPool: () => Promise.resolve(null) }) }), { action: "cash_out", wallet: WALLET, loanId: "7" }))).toBe("CASHOUT_CLOSED");
  });
});

describe("the signed loop", () => {
  it("still opens for a wallet that names itself", async () => {
    const rates = fakeUpstream({ "/intent/instant/": INSTANT, "/intent/preview/": preview(), "/intent/loop/quotes/": signedLoop });
    const r = await run(ctx({ rates }), { action: "leverage", wallet: WALLET, token: NVDA, own: "2000000000000000000", multiple: 2, term: 604_800, maxCostBps: 150 }, fakeSigner(), { sleep: () => Promise.resolve() });
    expect(r.status).toBe("done");
  });
});
