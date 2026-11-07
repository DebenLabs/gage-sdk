import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, decodeFunctionData, encodeEventTopics, encodeFunctionResult, getAddress, multicall3Abi, pad, toHex, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A } from "../src/testing.js";
import { createChain } from "../src/chain.js";
import { MULTICALL3 } from "../src/chains.js";
import { exitDebitFrom, exitFloorFrom, exitSharesFrom, logSpans, lpCompanionFrom, lpReserveFrom, privateLoansFrom, succeeded } from "../src/chain.js";
import { lpReserveVaultAbi, lpVaultAbi, lpCompanionAbi, registryAbi } from "../src/abi.js";
import { CORE, NVDA, OTHER, USDG } from "../src/testing.js";

const SENT = `0x${"a".repeat(64)}` as const, OTHER_TX = `0x${"b".repeat(64)}` as const;

// The audit of 18 October 2026 (M1): waiting for a transaction resolves with the receipt of whatever took its nonce, and
// only its status was read, so a listing the wallet cancelled was recorded as sent and its run as done.
describe("a sent transaction's receipt", () => {
  it("is its success only when it is its own, or a copy with the same calldata that only paid more for gas", () => {
    expect(succeeded(SENT, { transactionHash: SENT, status: "success" }, null)).toBe(true);
    expect(succeeded(SENT, { transactionHash: SENT, status: "reverted" }, null)).toBe(false);
    expect(succeeded(SENT, { transactionHash: OTHER_TX, status: "success" }, "repriced")).toBe(true);
    expect(succeeded(SENT, { transactionHash: OTHER_TX, status: "success" }, "cancelled")).toBe(false);
    expect(succeeded(SENT, { transactionHash: OTHER_TX, status: "success" }, "replaced")).toBe(false);
  });
});

// The audit of 18 October 2026 (M7): a loan is public only where the chain bears it out, every router of its core
// answering at a block that had listed it. A node behind the index answers the zero token for a loan it has not seen.
describe("what one block's reads say of a loan's private lane", () => {
  const ok = (result: unknown) => ({ status: "success", result }), failed = { status: "failure" };
  const none = ok([zeroAddress, 0n, false]), opened = ok([NVDA, 1_000_000_000n, true]);

  it("is private where a router opened it, public where every router of the core opened none of a listed loan, else unknown", () => {
    // Nine loans listed, two routers of the core: loan 7 opened by the second, 8 by neither, 10 not listed yet.
    expect(privateLoansFrom(CORE, 2, [7n, 8n, 10n], [ok(9n), ok(CORE), ok(CORE), none, none, none, opened, none, none])).toEqual([true, false, null]);
  });

  it("is unknown wherever a read failed, a router lists on another core, or the id is no loan's", () => {
    expect(privateLoansFrom(CORE, 1, [8n], [failed, ok(CORE), none])).toEqual([null]);
    expect(privateLoansFrom(CORE, 1, [8n], [ok(9n), failed, none])).toEqual([null]);
    expect(privateLoansFrom(CORE, 1, [8n], [ok(9n), ok(OTHER), none])).toEqual([null]);
    expect(privateLoansFrom(CORE, 1, [8n], [ok(9n), ok(CORE), failed])).toEqual([null]);
    expect(privateLoansFrom(CORE, 1, [0n], [ok(9n), ok(CORE), none])).toEqual([null]);
    expect(privateLoansFrom(CORE, 1, [8n], [ok(9n), ok(CORE)])).toEqual([null]);
  });
});

// SEC-01 (root D391): the share views' `exitShare` and the desk's `exitDebit`, as one block's multicall answers them.
describe("what the share views and the exit desk answer of an exit sale's discount", () => {
  const ok = (result: unknown) => ({ status: "success", result });
  /** A read the contract refused with no data, as viem's multicall gives it: what views or a desk before D391 answer. */
  const empty = (functionName: string) => ({ status: "failure", error: new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], data: "0x", functionName }), { abi: [], functionName }) });
  /** A node's refusal of the whole multicall (rate limit, internal error, a header it lacks): viem gives every read it. */
  const node = { status: "failure", error: new ContractFunctionExecutionError(new BaseError("limit exceeded"), { abi: [], functionName: "aggregate3" }) };
  /** A -32603 with no data, which viem files as a revert, though nothing reverted. */
  const internal = (functionName: string) => ({ status: "failure", error: new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], functionName, message: "internal error" }), { abi: [], functionName }) });

  it("reads each holding's exposure and supply in order, and none at all where a read reverted with no data (share views before D391)", () => {
    expect(exitSharesFrom([ok([3n, 10n]), ok([0n, 0n])])).toEqual([{ exposure: 3n, supply: 10n }, { exposure: 0n, supply: 0n }]);
    expect(exitSharesFrom([])).toEqual([]);
    expect(exitSharesFrom([ok([3n, 10n]), empty("exitShare")])).toBeNull();
  });

  it("fails the read on a node's refusal, a revert that is not empty, or an answer that is no pair of amounts (SEC-01 review)", () => {
    expect(() => exitSharesFrom([node, node])).toThrow("limit exceeded");
    expect(() => exitSharesFrom([ok([3n, 10n]), internal("exitShare")])).toThrow();
    expect(() => exitSharesFrom([{ status: "failure" }])).toThrow();
    expect(() => exitSharesFrom([ok([3n])])).toThrow();
    expect(() => exitSharesFrom([ok(["3", 10n])])).toThrow();
  });

  it("reads what a sale charged its leaver, zero for none, and nothing from a desk before D391; any other failure fails", () => {
    expect(exitDebitFrom(ok([OTHER, 5n]))).toEqual({ owner: OTHER, debit: 5n });
    expect(exitDebitFrom(ok([zeroAddress, 0n]))).toEqual({ owner: zeroAddress, debit: 0n });
    expect(exitDebitFrom(empty("exitDebit"))).toBeNull();
    expect(() => exitDebitFrom(node)).toThrow("limit exceeded");
    expect(() => exitDebitFrom(internal("exitDebit"))).toThrow();
    expect(() => exitDebitFrom(undefined)).toThrow();
    expect(() => exitDebitFrom(ok([OTHER]))).toThrow();
  });

  it("reads where the desk stops a listing for an owner, nothing from a desk before D391, and fails on anything else (SEC-01 review)", () => {
    expect(exitFloorFrom(ok(4_950n))).toBe(4_950);
    expect(exitFloorFrom(empty("floorOf"))).toBeNull();
    expect(() => exitFloorFrom(node)).toThrow("limit exceeded");
    expect(() => exitFloorFrom(internal("floorOf"))).toThrow();
    expect(() => exitFloorFrom(ok(9_901n))).toThrow();
  });
});

// Reads asked together travel as one call: a public node that challenges bursts sees one request, not one per token.
// D454: a reserve vault's `COMPANION()`, and its companion's fields, read apart from the vault's other reads.
describe("what a vault and its companion answer of its reserve", () => {
  const ok = (result: unknown) => ({ status: "success", result });
  const empty = (functionName: string) => ({ status: "failure", error: new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], data: "0x", functionName }), { abi: [], functionName }) });
  const node = { status: "failure", error: new ContractFunctionExecutionError(new BaseError("limit exceeded"), { abi: [], functionName: "aggregate3" }) };
  const COMPANION = getAddress(A(0x150)), TOKEN = getAddress(A(0x151));

  it("is a reserve vault's only where COMPANION() answers a nonzero address; an LPVault lacks the name, and answers no address", () => {
    expect(lpCompanionFrom(ok(COMPANION))).toBe(COMPANION);
    expect(lpCompanionFrom(ok(zeroAddress))).toBeNull();
    expect(lpCompanionFrom(empty("COMPANION"))).toBeNull();
  });

  it("never takes a node's refusal, or an answer that is no address, for an LPVault", () => {
    expect(() => lpCompanionFrom(node)).toThrow("limit exceeded");
    expect(() => lpCompanionFrom(ok(1n))).toThrow();
    expect(() => lpCompanionFrom(undefined)).toThrow();
  });

  it("reads each of the companion's fields, a failed read leaving its own field null, and the holding unknown only where the reserve's reads failed", () => {
    expect(lpReserveFrom(COMPANION, [ok(TOKEN), ok(3n), ok(5n), ok([true, 4n]), ok(9n), ok(500), ok(400), ok(false), ok(7n)])).toEqual({
      companion: COMPANION, token: TOKEN, shares: 3n, value: 5n, payable: 4n, freeLiquidity: 9n, bufferBps: 500, minCostBpsPerYear: 400, closed: false, rewardsAccounted: 7n,
    });
    expect(lpReserveFrom(COMPANION, [ok(TOKEN), ok(3n), empty("reserveValue"), ok([false, 0n]), ok(9n), ok(500), ok(400), ok(true), ok(7n)]))
      .toMatchObject({ shares: 3n, value: null, payable: null, freeLiquidity: 9n, closed: true });
    expect(lpReserveFrom(COMPANION, [node, node, node, node, node, node, node, node, node])).toEqual({
      companion: COMPANION, token: null, shares: null, value: null, payable: null, freeLiquidity: null, bufferBps: null, minCostBpsPerYear: null, closed: null, rewardsAccounted: null,
    });
  });
});

// The whole read over a node's answers: every name an LPVault lacks reverts with no data, as a contract without it does.
describe("an LP vault's read, over a node's answers", () => {
  const VAULT_AT = getAddress(A(0x102)), COMPANION = getAddress(A(0x150)), TOKEN = getAddress(A(0x151)), ADAPTER = getAddress(A(0x103)), POOL_AT = getAddress(A(0x104));
  const abi = [...lpVaultAbi, ...lpReserveVaultAbi, ...lpCompanionAbi] as Abi;
  const BOOK: Record<string, unknown> = {
    USDG: USDG, CORE: getAddress(A(0x105)), totalAssets: 100n, freeCash: 40n, totalSupply: 90n, outstandingPrincipal: 60n, totalBonusHeld: 0n, impaired: false, depositsClosed: false, fundingPaused: false,
    maxLoanPrincipal: 1_000n, PERFORMANCE_FEE_BPS: 1000, openLoans: [1n, 2n], CURATOR: getAddress(A(0x106)), mandate: [[{ adapter: ADAPTER, pool: POOL_AT }], [7]],
  };
  const COMPANION_READS: Record<string, unknown> = {
    RESERVE: TOKEN, reserveShares: 3n, reserveValue: 50n, reservePayable: [true, 50n], freeLiquidity: 90n, bufferBps: 500, minCostBpsPerYear: 400, reserveClosed: false, accountedRewards: 7n,
  };
  /** A node answering Multicall3 from `answers`, by the called contract and function; anything else reverts with no data. */
  const node = (answers: Record<Address, Record<string, unknown>>) => (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string; params: { data?: Hex }[] } | { id: number; method: string; params: { data?: Hex }[] }[];
    const answer = (r: { id: number; method: string; params: { data?: Hex }[] }) => {
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1237" };
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: r.params[0]!.data! });
      const calls = (args as unknown as [readonly { target: Address; callData: Hex }[]])[0];
      const result = calls.map(({ target, callData }): { success: boolean; returnData: Hex } => {
        const { functionName } = decodeFunctionData({ abi, data: callData });
        const value = answers[getAddress(target)]?.[functionName];
        return value === undefined ? { success: false, returnData: "0x" }
          : { success: true, returnData: encodeFunctionResult({ abi, functionName, result: value }) };
      });
      return { jsonrpc: "2.0", id: r.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result }) };
    };
    return Promise.resolve(new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const reading = async <T>(answers: Parameters<typeof node>[0], read: (chain: ReturnType<typeof createChain>) => Promise<T>) => {
    vi.stubGlobal("fetch", vi.fn(node(answers)));
    try { return await read(createChain("https://rpc.example", 4663)); } finally { vi.unstubAllGlobals(); }
  };

  it("never fails an LPVault for the name it lacks: its book and mandate read as before, with no reserve", async () => {
    expect(await reading({ [VAULT_AT]: BOOK }, (chain) => chain.lpVault(VAULT_AT))).toMatchObject({
      totalAssets: 100n, freeCash: 40n, totalShares: 90n, openLoans: 2, performanceFeeBps: 1000, mandate: [{ adapter: ADAPTER, pool: POOL_AT, activeAt: 7 }], reserve: null,
    });
    expect(await reading({ [VAULT_AT]: BOOK }, (chain) => chain.lpCompanion(VAULT_AT))).toBeNull();
  });

  it("reads a reserve vault's companion apart", async () => {
    const answers = { [VAULT_AT]: { ...BOOK, COMPANION }, [COMPANION]: COMPANION_READS };
    expect(await reading(answers, (chain) => chain.lpVault(VAULT_AT))).toMatchObject({
      freeCash: 40n, reserve: { companion: COMPANION, token: TOKEN, shares: 3n, value: 50n, payable: 50n, freeLiquidity: 90n, bufferBps: 500, minCostBpsPerYear: 400, closed: false, rewardsAccounted: 7n },
    });
    expect(await reading(answers, (chain) => chain.lpCompanion(VAULT_AT))).toBe(COMPANION);
    expect(await reading({ [COMPANION]: { rewardClaimable: 11n } }, (chain) => chain.lpRewardClaimable(COMPANION, VAULT_AT))).toBe(11n);
  });

  it("keeps the vault's read when its companion answers nothing, or its totalAssets reverts as a reserve vault's may", async () => {
    expect(await reading({ [VAULT_AT]: { ...BOOK, COMPANION } }, (chain) => chain.lpVault(VAULT_AT))).toMatchObject({
      totalAssets: 100n, reserve: { companion: COMPANION, token: null, value: null, payable: null, freeLiquidity: null },
    });
    const { totalAssets: _, ...noAssets } = BOOK;
    expect(await reading({ [VAULT_AT]: { ...noAssets, COMPANION }, [COMPANION]: { ...COMPANION_READS, reserveValue: undefined, reservePayable: [false, 0n] } }, (chain) => chain.lpVault(VAULT_AT))).toMatchObject({
      totalAssets: null, freeCash: 40n, reserve: { companion: COMPANION, value: null, payable: null, freeLiquidity: 90n },
    });
  });

  it("still fails where an LPVault's book does not answer: only a reserve vault's totalAssets may revert", async () => {
    const { totalAssets: _, ...noAssets } = BOOK;
    await expect(reading({ [VAULT_AT]: noAssets }, (chain) => chain.lpVault(VAULT_AT))).rejects.toThrow();
    const { freeCash: __, ...noCash } = BOOK;
    await expect(reading({ [VAULT_AT]: { ...noCash, COMPANION }, [COMPANION]: COMPANION_READS }, (chain) => chain.lpVault(VAULT_AT))).rejects.toThrow();
  });
});

describe("reads asked together", () => {
  it("go as one call to Multicall3, each with its own answer", async () => {
    const calls: { method: string; to?: string }[] = [];
    const fetcher = vi.fn((_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number; method: string; params: { to?: string }[] } | { id: number; method: string; params: { to?: string }[] }[];
      const answer = (r: { id: number; method: string; params: { to?: string }[] }) => {
        calls.push({ method: r.method, ...(r.params?.[0]?.to ? { to: r.params[0].to } : {}) });
        return { jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? "0x1237" : "0x" };
      };
      return Promise.resolve(new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const chain = createChain("https://rpc.example", 4663);
      await Promise.allSettled([chain.balance(A(0x10), A(0x1)), chain.balance(A(0x11), A(0x1)), chain.balance(A(0x12), A(0x1)), chain.feeBps(A(0x30))]);
      const reads = calls.filter((c) => c.method === "eth_call");
      expect(reads).toHaveLength(1);
      expect(reads[0]!.to?.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// The chain's public node answers logs over ten million blocks at most, and a registry soon passes that from its start.
describe("logs over a wide range of blocks", () => {
  const rpc = () => {
    const asked: { from: bigint; to: bigint }[] = [];
    const logs: unknown[][] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { body: string }) => {
      const one = (m: { id: number; method: string; params: { fromBlock: string; toBlock: string; topics?: unknown }[] }) => {
        if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0xb626" };
        const { fromBlock, toBlock } = m.params[0]!;
        asked.push({ from: BigInt(fromBlock), to: BigInt(toBlock) });
        return { jsonrpc: "2.0", id: m.id, result: logs.shift() ?? [] };
      };
      const body = JSON.parse(init.body) as Parameters<typeof one>[0] | Parameters<typeof one>[0][];
      return Promise.resolve(new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    return { asked, logs, chain: createChain("https://rpc.test", 46630) };
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("cuts a range into spans the node takes, none wider, none missed", () => {
    expect(logSpans(5n, 5n)).toEqual([{ fromBlock: 5n, toBlock: 5n }]);
    expect(logSpans(1n, 10_000_000n)).toEqual([{ fromBlock: 1n, toBlock: 10_000_000n }]);
    expect(logSpans(1n, 10_000_001n)).toEqual([{ fromBlock: 1n, toBlock: 10_000_000n }, { fromBlock: 10_000_001n, toBlock: 10_000_001n }]);
    expect(logSpans(9n, 8n)).toEqual([]);
  });

  it("reads a registry's log across them, in order", async () => {
    const { asked, chain } = rpc();
    expect(await chain.routerAdmissions(USDG, 100n, 25_000_100n)).toEqual([]);
    expect(asked).toEqual([{ from: 100n, to: 10_000_099n }, { from: 10_000_100n, to: 20_000_099n }, { from: 20_000_100n, to: 25_000_100n }]);
  });

  it("reads every router a registry ever admitted, one since removed among them, and none it refused", async () => {
    const { asked, logs, chain } = rpc();
    const topic = encodeEventTopics({ abi: registryAbi, eventName: "RouterSet" })[0];
    const log = (router: string, allowed: boolean, block: number) => ({
      address: USDG, topics: [topic, pad(router as Hex)], data: pad(allowed ? "0x01" : "0x00"), blockNumber: toHex(block), transactionHash: pad("0x1"), transactionIndex: "0x0", blockHash: pad("0x2"), logIndex: "0x0", removed: false,
    });
    logs.push([log(A(0x71), true, 1), log(A(0x72), false, 2)], [log(A(0x71), false, 10_000_002)]);
    expect(await chain.routerAdmissions(USDG, 1n, 10_000_003n)).toEqual([getAddress(A(0x71))]);
    expect(asked).toHaveLength(2);
  });
});
