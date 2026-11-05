import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { exitDebitFrom, exitFloorFrom, exitSharesFrom, privateLoansFrom, succeeded } from "../src/chain.js";
import { CORE, NVDA, OTHER } from "../src/testing.js";

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
