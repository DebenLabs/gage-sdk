import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { engineAbi, loopRouterAbi, partnerVaultAbi } from "../src/abi.js";
import type { Call } from "../src/chain.js";
import { gageFrom } from "../src/client.js";
import { ApiError } from "../src/errors.js";
import type { View } from "../src/plans.js";
import { run } from "../src/run.js";
import { A, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, NOW, NVDA, OTHER, preview, ROUTER, signedLoop, USDG, VAULT, WALLET } from "../src/testing.js";

const borrow = { action: "borrow" as const, wallet: WALLET, token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 604_800 };
const fast = () => Promise.resolve();
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

describe("run with the agent's own signer", () => {
  it("sends the exact approval, then the listing once, each simulated first and on the testnet", async () => {
    const chain = fakeChain();
    const signer = fakeSigner();
    const steps: string[] = [];
    const r = await run(ctx({ chain }), borrow, signer, { sleep: fast, onStep: (s) => steps.push(`${s.label}:${s.outcome}`) });
    expect(r.status).toBe("done");
    expect(r.error).toBeNull();
    expect(r.unsent).toEqual([]);
    expect(steps).toEqual(["Approve NVDAx:succeeded", "Borrow:succeeded"]);
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([NVDA, CORE]);
    expect(decodeFunctionData({ abi: erc20Abi, data: signer.sent[0]!.data }).args).toEqual([CORE, 5n * 10n ** 18n]);
    expect(decodeFunctionData({ abi: engineAbi, data: signer.sent[1]!.data }).functionName).toBe("list");
    // The estimate plus a fifth, on the deployment's chain; every step simulated before it is sent.
    expect(signer.sent.every((t) => t.gas === 120_000n && t.chainId === 46630 && t.value === 0n)).toBe(true);
    expect(chain.simulated).toHaveLength(2);
  });

  it("stops at a reverted step and names the steps that never went out", async () => {
    const r = await run(ctx({ chain: fakeChain({ wait: () => Promise.resolve(false) }) }), borrow, fakeSigner(), { sleep: fast });
    expect(r.status).toBe("stopped");
    expect(r.error).toMatchObject({ code: "TX_FAILED" });
    expect(r.sent.map((s) => s.outcome)).toEqual(["reverted"]);
    expect(r.unsent).toEqual(["Borrow"]);
  });

  it("never sends past a transaction that is not mined in time", async () => {
    const signer = fakeSigner();
    const r = await run(ctx({ chain: fakeChain({ wait: () => Promise.resolve(null) }) }), borrow, signer, { sleep: fast });
    expect(r).toMatchObject({ status: "stopped", error: { code: "TX_PENDING" }, unsent: ["Borrow"] });
    expect(signer.sent).toHaveLength(1);
  });

  it("keeps the signer's own words out of the answer (D221)", async () => {
    const r = await run(ctx(), borrow, fakeSigner(WALLET, true), { sleep: fast });
    expect(r).toMatchObject({ status: "stopped", sent: [], unsent: ["Approve NVDAx", "Borrow"], error: { code: "SEND_FAILED", retryable: true } });
    expect(JSON.stringify(r)).not.toContain("rpc.example");
  });

  it("simulates a step again when the node trails the block just mined, then stops if it still reverts", async () => {
    let calls = 0;
    const flaky = fakeChain({ simulate: () => { calls += 1; return calls === 2 ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n); } });
    const sleep = vi.fn(fast);
    expect((await run(ctx({ chain: flaky }), borrow, fakeSigner(), { sleep })).status).toBe("done");
    expect(sleep).toHaveBeenCalledTimes(1);
    let first = true;
    const broken = fakeChain({ simulate: () => { if (first) { first = false; return Promise.resolve(100_000n); } return Promise.reject(new ApiError("SIMULATION_FAILED", "x")); } });
    const r = await run(ctx({ chain: broken }), borrow, fakeSigner(), { sleep: fast });
    expect(r).toMatchObject({ status: "stopped", error: { code: "SIMULATION_FAILED" }, unsent: ["Borrow"] });
  });

  it("builds a loop again when the node trails the approvals just mined: its sources are simulated as it is built", async () => {
    const instant = { schema: "gage-intent-instant-v1", status: "ok", refusal: null, expiresAt: NOW + 30,
      answer: { collateral: "2000000000000000000", valueUSDG: "400000000", principal: "300000000", cap: "303000000", costBps: 100, ltvBps: 7500, binds: "wallet", room: "0", vaults: 1 } };
    const rates = fakeUpstream({ "/intent/instant/": instant, "/intent/preview/": preview(), "/intent/loop/quotes/": signedLoop });
    let loops = 0;
    const chain = fakeChain({ simulate: (call: Call) => (call.to === ROUTER && loops++ === 0 ? Promise.reject(new ApiError("SIMULATION_FAILED", "x")) : Promise.resolve(100_000n)) });
    const sleep = vi.fn(fast);
    const signer = fakeSigner();
    const leverage = { action: "leverage" as const, wallet: WALLET, token: NVDA, own: "2000000000000000000", multiple: 2, term: 604_800, maxCostBps: 150 };
    const r = await run(ctx({ chain, rates }), leverage, signer, { sleep });
    expect(r.status).toBe("done");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(signer.sent.map((t) => t.to)).toEqual([NVDA, USDG, ROUTER]);
    expect(decodeFunctionData({ abi: loopRouterAbi, data: signer.sent[2]!.data }).functionName).toBe("loop");
  });

  it("throws a refusal found before any step, and sends nothing", async () => {
    const signer = fakeSigner();
    expect(await code(run(ctx(), { ...borrow, term: 86_400 }, signer))).toBe("TERM_NOT_ALLOWED");
    expect(signer.sent).toHaveLength(0);
  });

  it("acts only for the signer's own wallet", async () => {
    const gage = gageFrom(ctx());
    expect(await code(run(ctx(), borrow, fakeSigner(OTHER)))).toBe("WALLET_MISMATCH");
    expect(await code(gage.run({ ...borrow, wallet: OTHER } as never, fakeSigner()))).toBe("WALLET_MISMATCH");
    const { wallet: _, ...request } = borrow;
    const signer = fakeSigner();
    expect((await gage.run(request, signer, { sleep: fast })).wallet).toBe(WALLET);
  });

  it("says there was nothing to do when the plan has no step", async () => {
    const indexer = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } });
    const signer = fakeSigner();
    const r = await run(ctx({ indexer }), { action: "collect", wallet: WALLET }, signer);
    expect(r).toMatchObject({ status: "nothing_to_do", sent: [], error: null });
    expect(signer.sent).toHaveLength(0);
  });

  it("deposits into Earn: the exact USDG approval, then the deposit with the preview's shares less the slippage", async () => {
    const vault = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1814400, assets: [NVDA], fundingEnabled: true };
    const indexer = fakeUpstream({
      "/intent/partners/vaults?": { items: [vault], nextCursor: null },
      "/intent/partners/vaults/": { kind: "DEPOSIT", assets: "100000000", shares: "100000000000000000000", refusal: null, availableNow: null },
    });
    const signer = fakeSigner();
    const r = await gageFrom(ctx({ indexer })).run({ action: "earn_deposit", vault: VAULT, amount: "100000000" }, signer, { sleep: fast });
    expect(r.status).toBe("done");
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([USDG, VAULT]);
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: signer.sent[1]!.data }).args).toEqual([100_000_000n, 995n * 10n ** 17n]);
  });
});

// Valet's spend limits (D297): the run asks its limit with the plan, before anything is sent, and tells it whether the
// action itself went out.
describe("a run under a spend limit", () => {
  const held = () => {
    const views: View[] = [], released: boolean[] = [];
    return { views, released, limit: (view: View) => { views.push(view); return { release: (sent: boolean) => { released.push(sent); } }; } };
  };
  // The approval (the first hash) succeeds; the action itself ends as `then`.
  const action = (then: boolean | null) => fakeChain({ wait: (hash: Hex) => Promise.resolve(BigInt(hash) === 1n ? true : then) });

  it("is asked with the plan before any step is sent, and its refusal sends nothing", async () => {
    const signer = fakeSigner(), views: View[] = [];
    const refuse = (view: View) => { views.push(view); throw new ApiError("SPEND_LIMIT", "Past the limit", 403); };
    expect(await code(run(ctx(), borrow, signer, { sleep: fast, limit: refuse }))).toBe("SPEND_LIMIT");
    expect(signer.sent).toHaveLength(0);
    expect(views).toMatchObject([{ action: "borrow", principal: "1000000000" }]);
  });

  it("keeps the amount once the action itself is sent, mined or not, and gives it back when it never went out or reverted", async () => {
    const h = held();
    await run(ctx(), borrow, fakeSigner(), { sleep: fast, limit: h.limit });
    await run(ctx({ chain: action(null) }), borrow, fakeSigner(), { sleep: fast, limit: h.limit });
    await run(ctx({ chain: action(false) }), borrow, fakeSigner(), { sleep: fast, limit: h.limit });
    await run(ctx({ chain: fakeChain({ wait: () => Promise.resolve(false) }) }), borrow, fakeSigner(), { sleep: fast, limit: h.limit });
    await run(ctx(), borrow, fakeSigner(WALLET, true), { sleep: fast, limit: h.limit });
    expect(h.released).toEqual([true, true, false, false, false]);
  });

  it("keeps it when the signer failed on the action itself: it may have gone out", async () => {
    let n = 0;
    const flaky = { address: WALLET, sendTransaction: () => (n++ === 0 ? Promise.resolve(`0x${"0".repeat(63)}1` as Hex) : Promise.reject(new Error("timeout"))) };
    const h = held();
    const r = await run(ctx(), borrow, flaky, { sleep: fast, limit: h.limit });
    expect(r).toMatchObject({ status: "stopped", error: { code: "SEND_FAILED" } });
    expect(h.released).toEqual([true]);
  });

  it("is not asked when there is nothing to do", async () => {
    const indexer = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } });
    const h = held();
    expect((await run(ctx({ indexer }), { action: "collect", wallet: WALLET }, fakeSigner(), { limit: h.limit })).status).toBe("nothing_to_do");
    expect(h.views).toEqual([]);
  });
});

// The audit of 18 October 2026 (H4): a signer that fails after the network took the transaction (an RPC gateway's 502,
// a timeout) must not be told it may send again, or a second listing, loop or deposit goes out. The wallet's nonce says
// whether anything went out.
describe("a signer that fails", () => {
  const network = () => {
    let nonce = 0;
    return { nonce: () => Promise.resolve(nonce), took: () => { nonce += 1; } };
  };

  it("after the wallet's nonce moved: the outcome is unknown, the step is not offered again, its amount stays held", async () => {
    const n = network();
    let calls = 0;
    // The approval goes through; the listing reaches the network, then its answer is lost.
    const signer = { address: WALLET, sendTransaction: () => { calls += 1; n.took(); return calls === 1 ? Promise.resolve(`0x${"0".repeat(63)}1` as Hex) : Promise.reject(new Error("502 Bad Gateway")); } };
    const released: boolean[] = [];
    const r = await run(ctx({ chain: fakeChain({ nonce: n.nonce }) }), borrow, signer, { sleep: fast, limit: () => ({ release: (s: boolean) => { released.push(s); } }) });
    expect(r).toMatchObject({ status: "stopped", error: { code: "SEND_UNKNOWN", retryable: false }, unsent: [] });
    expect(r.sent.map((s) => s.label)).toEqual(["Approve NVDAx"]);
    expect(released).toEqual([true]);
  });

  it("with the nonce where it was, nothing went out: it may be sent again", async () => {
    const r = await run(ctx({ chain: fakeChain({ nonce: network().nonce }) }), borrow, fakeSigner(WALLET, true), { sleep: fast });
    expect(r).toMatchObject({ status: "stopped", error: { code: "SEND_FAILED", retryable: true }, unsent: ["Approve NVDAx", "Borrow"] });
  });

  it("waits for a trailing node before saying nothing went out, and calls the outcome unknown when the nonce cannot be read", async () => {
    let reads = 0;
    // The node shows the transaction on the third read after the failure.
    const trailing = fakeChain({ nonce: () => Promise.resolve((reads += 1) >= 4 ? 1 : 0) });
    expect((await run(ctx({ chain: trailing }), borrow, fakeSigner(WALLET, true), { sleep: fast })).error).toMatchObject({ code: "SEND_UNKNOWN", retryable: false });
    let first = true;
    const unreadable = fakeChain({ nonce: () => (first ? ((first = false), Promise.resolve(0)) : Promise.reject(new Error("down"))) });
    expect((await run(ctx({ chain: unreadable }), borrow, fakeSigner(WALLET, true), { sleep: fast })).error).toMatchObject({ code: "SEND_UNKNOWN", retryable: false });
  });
});

// privateKeySigner signs for its network's chain (D260): a mainnet signer refuses a testnet transaction before sending.
describe("a key's signer", () => {
  // A fresh key each run: a well-known one (0x11…11) is anyone's, and its address held testnet ETH (the audit of 18 October 2026).
  const KEY = generatePrivateKey();
  const tx = (chainId: number) => ({ to: USDG, data: "0x" as const, value: 0n, gas: 21_000n, chainId });

  it("is the testnet's unless mainnet is named, and refuses another chain's transaction", async () => {
    const { privateKeySigner } = await import("../src/signer.js");
    // The refusal comes before anything is signed or sent.
    const send = (s: ReturnType<typeof privateKeySigner>, chainId: number) => code((async () => s.sendTransaction(tx(chainId)))());
    expect(await send(privateKeySigner(KEY), 4663)).toBe("CHAIN_MISMATCH");
    expect(await send(privateKeySigner(KEY, { network: "mainnet" }), 46630)).toBe("CHAIN_MISMATCH");
    expect(() => privateKeySigner(KEY, { network: "base" as "mainnet" })).toThrow(/Unknown network/);
  });
});
