import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { privateLoansFrom, succeeded } from "../src/chain.js";
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
