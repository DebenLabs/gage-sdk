/**
 * A deposit into a partner vault, or a withdrawal from one, claims sGAGE for each of the vault's open reward records
 * (chaos finding 1, 26 September 2026). Estimated in a second in which no record has anything to claim (another
 * checkpoint's second, or the second the records opened), the call prices only the cheap path; mined a second later it
 * takes the claim path. The estimate and a fifth that gage-sdk sent ran out of gas or reverted `RewardsPending` on all 28
 * such calls of a mainnet fork's gas-scaling run, and on a live r9 vault's own records (21 October 2026). Each step now
 * carries the floor of the rule every gage client sends with (shared/tx-gas.mjs): 250,000 for each open record and two
 * more, the count read from the vault's storage for its mandate version, a full book of 64 when it cannot be read.
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { partnerVaultAbi } from "../src/abi.js";
import { createChain } from "../src/chain.js";
import { parseDeployment } from "../src/deployment.js";
import { INTENT_OPEN_RECORDS_SLOT, openRecords, TX_GAS } from "../src/gas.js";
import { prepareNext } from "../src/prepare.js";
import { run } from "../src/run.js";
import { A, assetManifest, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_VAULT, NVDA, SCHIFFY, VAULT, WALLET } from "../src/testing.js";

const SLOT = 29n;
const ESTIMATE = 400_000n;
const floor = (records: bigint) => 250_000n * (records + 2n);
const FULL_BOOK = floor(64n);
const fast = () => Promise.resolve();

const row = (over: Record<string, unknown> = {}) => ({
  address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true,
  mandateVersion: 12, ...over,
});
/** The index of one vault (or GLDx's, by its factory), every preview answered as a deposit or a redemption it takes. */
function index(vault: Record<string, unknown> = row(), gld: Record<string, unknown> = row({ address: GLD_VAULT, core: GLD_CORE, assets: [SCHIFFY] })) {
  return fakeUpstream({
    "/intent/partners/vaults?": (path: string) => ({ status: 200, body: { items: [path.includes(`factory=${GLD_FACTORY}`) ? gld : vault], nextCursor: null } }),
    "/intent/partners/vaults/": (path: string) => ({
      status: 200, body: { kind: path.includes("deposit=") ? "DEPOSIT" : "REDEEM", assets: "1000000", shares: "1000000000000000000", refusal: null, availableNow: null },
    }),
  });
}
/** A chain whose vaults hold `records` open records at the count's slot (an Error: the read fails); any other slot read fails. */
function chain(records: Record<string, bigint | Error>, over: Record<string, unknown> = {}) {
  const reads: [Address, bigint][] = [];
  const c = fakeChain({
    simulate: () => Promise.resolve(ESTIMATE),
    storageAt: (address: Address, slot: bigint) => {
      reads.push([address, slot]);
      const value = records[address.toLowerCase()];
      if (value instanceof Error) return Promise.reject(value);
      if (slot !== SLOT) return Promise.reject(new Error(`unexpected slot ${slot}`));
      return Promise.resolve(value ?? 0n);
    },
    ...over,
  });
  return Object.assign(c, { reads });
}
const deposit = { action: "earn_deposit" as const, wallet: WALLET, vault: VAULT, amount: "1000000" };
const redeem = { action: "earn_redeem" as const, wallet: WALLET, vault: VAULT };
const approved = { allowance: () => Promise.resolve(10n ** 30n) };

describe("a deposit into a partner vault", () => {
  it("is prepared with the estimate and 250,000 for each open record and two more, read from the vault's storage", async () => {
    const c = chain({ [VAULT]: 6n }, approved);
    const p = await prepareNext(ctx({ indexer: index(), chain: c }), deposit);
    expect(p.next).toMatchObject({ label: "Deposit", final: true });
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: p.next!.transaction.data }).functionName).toBe("deposit");
    expect(p.next!.transaction.gas).toBe(String(ESTIMATE + floor(6n)));
    expect(c.reads).toEqual([[VAULT, SLOT]]);
  });

  it("is sent by run() with the estimate and a fifth, and the floor; its approval with the estimate and a fifth alone", async () => {
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: index(), chain: chain({ [VAULT]: 6n }) }), deposit, signer, { sleep: fast });
    expect(r.status).toBe("done");
    expect(r.sent.map((s) => s.label)).toEqual(["Approve USDG", "Deposit"]);
    expect(signer.sent.map((t) => t.gas)).toEqual([480_000n, 480_000n + floor(6n)]);
  });

  it("is sized for an empty book's slack, and for its cap, as the count says", async () => {
    for (const records of [0n, 1n, 64n]) {
      const p = await prepareNext(ctx({ indexer: index(), chain: chain({ [VAULT]: records }, approved) }), deposit);
      expect(p.next!.transaction.gas).toBe(String(ESTIMATE + floor(records)));
    }
  });

  it("is sized for a full book when the count cannot be read: no mandate version, one with another layout, a failed read, a count past the cap", async () => {
    const cases = [
      { vault: row({ mandateVersion: undefined }), records: { [VAULT]: 6n } },
      { vault: row({ mandateVersion: "12" }), records: { [VAULT]: 6n } },
      { vault: row({ mandateVersion: 10 }), records: { [VAULT]: 6n } },
      { vault: row(), records: { [VAULT]: new Error("rpc down") } },
      { vault: row(), records: { [VAULT]: 65n } },
    ];
    for (const { vault, records } of cases) {
      const p = await prepareNext(ctx({ indexer: index(vault), chain: chain(records, approved) }), deposit);
      expect(p.next!.transaction.gas).toBe(String(ESTIMATE + FULL_BOOK));
    }
  });

  it("reads a lend-asset vault's own count (D251)", async () => {
    const c = chain({ [GLD_VAULT]: 3n, [VAULT]: 40n }, approved);
    const p = await prepareNext(ctx({ d: parseDeployment(assetManifest()), indexer: index(), chain: c }), { ...deposit, vault: GLD_VAULT, amount: String(5n * 10n ** 18n) });
    expect(p.next).toMatchObject({ label: "Deposit" });
    expect(p.next!.transaction.gas).toBe(String(ESTIMATE + floor(3n)));
    expect(c.reads).toEqual([[GLD_VAULT, SLOT]]);
  });

  it("never asks more than the chain takes in one transaction, nor less than the estimate", async () => {
    const at = (estimate: bigint) => chain({ [VAULT]: new Error("rpc down") }, { ...approved, simulate: () => Promise.resolve(estimate) });
    const cap = 32_000_000n + 1_000_000n;
    expect((await prepareNext(ctx({ indexer: index(), chain: at(20_000_000n) }), deposit)).next!.transaction.gas).toBe(String(cap));
    expect((await prepareNext(ctx({ indexer: index(), chain: at(34_000_000n) }), deposit)).next!.transaction.gas).toBe("34000000");
    const signer = fakeSigner();
    await run(ctx({ indexer: index(), chain: at(20_000_000n) }), deposit, signer, { sleep: fast });
    expect(signer.sent.map((t) => t.gas)).toEqual([cap]);
  });
});

describe("a withdrawal from a partner vault", () => {
  it("is prepared, and sent by run(), with the floor for the vault's open records", async () => {
    const p = await prepareNext(ctx({ indexer: index(), chain: chain({ [VAULT]: 8n }) }), redeem);
    expect(p.next).toMatchObject({ label: "Withdraw", final: true });
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: p.next!.transaction.data }).functionName).toBe("redeem");
    expect(p.next!.transaction.gas).toBe(String(ESTIMATE + floor(8n)));
    const signer = fakeSigner();
    expect((await run(ctx({ indexer: index(), chain: chain({ [VAULT]: 8n }) }), redeem, signer, { sleep: fast })).status).toBe("done");
    expect(signer.sent.map((t) => t.gas)).toEqual([480_000n + floor(8n)]);
  });

  it("is sized for a full book when the index names no mandate version", async () => {
    const p = await prepareNext(ctx({ indexer: index(row({ mandateVersion: undefined })), chain: chain({ [VAULT]: 8n }) }), redeem);
    expect(p.next!.transaction.gas).toBe(String(ESTIMATE + FULL_BOOK));
  });
});

describe("the count's read", () => {
  it("asks the RPC for one storage word at the head, its slot as 32 bytes", async () => {
    const asked: { method: string; params: unknown[] }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        asked.push(call);
        const result = call.method === "eth_chainId" ? "0x1237" : `0x${"0".repeat(63)}6`;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await createChain(`http://127.0.0.1:${port}`, 4663).storageAt(VAULT, SLOT)).toBe(6n);
      expect(asked.find((a) => a.method === "eth_getStorageAt")?.params).toEqual([VAULT, `0x${"0".repeat(62)}1d`, "latest"]);
    } finally {
      server.close();
    }
  });
});

// gage-sdk is published apart from gage's main repository, so it carries its own copy of the rule (src/gas.ts). In the
// main repository, what prepare and run() send is held to shared/tx-gas.mjs itself.
const SHARED = new URL("../../../shared/tx-gas.mjs", import.meta.url);
type Rpc = (args: { method: string; params: unknown[] }) => Promise<unknown>;
type Rule = {
  TX_GAS: Record<string, unknown>;
  INTENT_OPEN_RECORDS_SLOT: Record<number, bigint>;
  planGasLimit: (input: { estimate: bigint; records?: bigint; headroom?: { num: bigint; den: bigint } }) => bigint;
  readOpenRecords: (rpc: Rpc, vault: string, mandateVersion: number | undefined) => Promise<bigint | undefined>;
  recordsFor: (rpc: Rpc, hint: { intentVaults: string[]; mandateVersion: number | undefined }) => Promise<bigint | undefined>;
};
describe.skipIf(!existsSync(SHARED))("the shared rule (shared/tx-gas.mjs)", () => {
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  /** The same storage as `chain`, as a JSON-RPC node answers it. */
  const rpc = (records: Record<string, bigint | Error>): Rpc => ({ method, params }) => {
    const [address, slot] = params as [string, string];
    const value = records[address.toLowerCase()];
    if (value instanceof Error) return Promise.reject(value);
    if (method !== "eth_getStorageAt" || BigInt(slot) !== SLOT) return Promise.reject(new Error(`unexpected ${method} ${slot}`));
    return Promise.resolve(word(value ?? 0n));
  };
  const books: Record<string, bigint | Error>[] = [{ [VAULT]: 0n }, { [VAULT]: 6n }, { [VAULT]: 64n }, { [VAULT]: 65n }, { [VAULT]: new Error("rpc down") }];
  const versions = [12, 11, 10, undefined];
  const estimates = [21_000n, ESTIMATE, 1_000_143n, 20_000_000n, 40_000_000n];

  it("has the same figures and slots, and reads the same count from the same storage", async () => {
    const shared = await import(SHARED.href) as Rule;
    const { lookaheadSeconds: _, ...figures } = shared.TX_GAS;
    expect(TX_GAS).toEqual(figures);
    expect(INTENT_OPEN_RECORDS_SLOT).toEqual(shared.INTENT_OPEN_RECORDS_SLOT);
    for (const records of books) for (const mandateVersion of [...versions, 5, 13]) {
      expect(await openRecords(chain(records), VAULT, mandateVersion)).toBe(await shared.readOpenRecords(rpc(records), VAULT, mandateVersion));
    }
  });

  it("is what prepare sends with no headroom, and what run() sends at least with its fifth, for every book, version and estimate", async () => {
    const shared = await import(SHARED.href) as Rule;
    for (const records of books) for (const mandateVersion of versions) for (const estimate of estimates) {
      const count = await shared.recordsFor(rpc(records), { intentVaults: [VAULT], mandateVersion });
      const c = chain(records, { ...approved, simulate: () => Promise.resolve(estimate) });
      const vaults = index(row({ mandateVersion }));
      const p = await prepareNext(ctx({ indexer: vaults, chain: c }), deposit);
      expect(p.next!.transaction.gas).toBe(String(shared.planGasLimit({ estimate, records: count!, headroom: { num: 1n, den: 1n } })));
      const signer = fakeSigner();
      await run(ctx({ indexer: vaults, chain: c }), deposit, signer, { sleep: fast });
      const sent = signer.sent[0]!.gas;
      expect(sent).toBeGreaterThanOrEqual(shared.planGasLimit({ estimate, records: count!, headroom: { num: 12n, den: 10n } }));
      expect(sent).toBeGreaterThanOrEqual(shared.planGasLimit({ estimate, records: count!, headroom: { num: 1n, den: 1n } }));
    }
  });
});
