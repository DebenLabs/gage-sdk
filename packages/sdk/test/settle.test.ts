/**
 * A vault due a settlement: a loan past its end that nobody booked yet keeps it from taking deposits or paying out
 * (`IntentVault.SettlementDue`). The plan settles first, then deposits or redeems as planned again from the chain.
 */
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { partnerVaultAbi } from "../src/abi.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { prepareNext } from "../src/prepare.js";
import { portfolio } from "../src/reads.js";
import { run } from "../src/run.js";
import { A, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, mainnetManifest, NVDA, VAULT, WALLET } from "../src/testing.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const row = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true };

/** The index of one vault due a settlement of `settleable` until `settled()` says it was booked. */
function index(settleable: string[], settled: () => boolean) {
  return fakeUpstream({
    "/intent/partners/vaults?": { items: [row], nextCursor: null },
    "/intent/partners/vaults/": (path: string) => {
      if (path.includes("/accounting")) return { status: 200, body: { pricing: { totalAssets: "1", totalSupply: "1", assetsPerShare: "1" }, liquidity: { free: "1" }, settlement: { due: !settled(), settleable } } };
      if (path.includes("/position/")) return { status: 200, body: { shares: "1000000000000000000", value: "1000000", withdrawableNow: "1000000", rewards: "0", pockets: [] } };
      const refusal = settled() ? null : "SETTLEMENT_DUE";
      return { status: 200, body: { kind: path.includes("deposit=") ? "DEPOSIT" : "REDEEM", assets: "1000000", shares: "1000000000000000000", refusal, availableNow: null } };
    },
  });
}

describe("a deposit into a vault due a settlement", () => {
  it("settles the loans the index names first, with the gas booking them takes", async () => {
    const p = await prepareNext(ctx({ indexer: index(["3", "4"], () => false), chain: fakeChain({ simulate: () => Promise.resolve(200_000n) }) }), { action: "earn_deposit", wallet: WALLET, vault: VAULT, amount: "1000000" });
    expect(p.status).toBe("ready");
    expect(p.next).toMatchObject({ label: "Settle the vault's loans", final: false });
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: p.next!.transaction.data })).toMatchObject({ functionName: "settle", args: [[3n, 4n]] });
    // The estimate and 250,000 a loan and two more (shared/tx-gas.mjs).
    expect(p.next!.transaction.gas).toBe(String(200_000 + 250_000 * 4));
    expect(p.then).toEqual([]);
    expect(p.notes[0]).toMatch(/written off, which lowers the share price/);
  });

  it("is carried out whole by run(): the settle, then the deposit planned again once it is mined", async () => {
    let booked = false;
    const signer = fakeSigner();
    const chain = fakeChain({ wait: () => { booked = true; return Promise.resolve(true); } });
    const r = await run(ctx({ indexer: index(["3"], () => booked), chain }), { action: "earn_deposit", wallet: WALLET, vault: VAULT, amount: "1000000" }, signer);
    expect(r.status).toBe("done");
    expect(r.sent.map((s) => s.label)).toEqual(["Settle the vault's loans", "Approve USDG", "Deposit"]);
    expect(r.unsent).toEqual([]);
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: signer.sent[2]!.data })).toMatchObject({ functionName: "deposit" });
  });

  it("asks the limit once, with the deposit's amount, before the settle is sent", async () => {
    let booked = false;
    const views: unknown[] = [];
    const limit = (view: unknown) => { views.push(view); return { release: () => undefined }; };
    await run(ctx({ indexer: index(["3"], () => booked), chain: fakeChain({ wait: () => { booked = true; return Promise.resolve(true); } }) }),
      { action: "earn_deposit", wallet: WALLET, vault: VAULT, amount: "1000000" }, fakeSigner(), { limit });
    expect(views).toEqual([expect.objectContaining({ action: "earn_deposit", amount: "1000000" })]);
  });

  it("is refused while the index names no loan to settle yet", async () => {
    expect(await code(prepareNext(ctx({ indexer: index([], () => false) }), { action: "earn_deposit", wallet: WALLET, vault: VAULT, amount: "1000000" }))).toBe("SETTLEMENT_DUE");
  });
});

describe("a withdrawal from a vault due a settlement", () => {
  it("settles first, then redeems as planned again", async () => {
    let booked = false;
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: index(["9"], () => booked), chain: fakeChain({ wait: () => { booked = true; return Promise.resolve(true); } }) }),
      { action: "earn_redeem", wallet: WALLET, vault: VAULT }, signer);
    expect(r.status).toBe("done");
    expect(r.sent.map((s) => s.label)).toEqual(["Settle the vault's loans", "Withdraw"]);
  });
});

describe("a withdrawal's view while its vault is due a settlement", () => {
  it("names what the shares are worth before the settlement books its loans, never 0", async () => {
    const p = await prepareNext(ctx({ indexer: index(["9"], () => false) }), { action: "earn_redeem", wallet: WALLET, vault: VAULT });
    expect(p.next?.label).toBe("Settle the vault's loans");
    expect(p.view).toMatchObject({ action: "earn_redeem", assets: "1000000" });
  });
});

// D302: the line that a rating is open comes with an action's last transaction, never with a step that comes first.
describe("the steps that come first", () => {
  const RATE = /you may rate gage/;
  const deposit = { action: "earn_deposit" as const, wallet: WALLET, vault: VAULT, amount: "1000000" };
  const mainnet = () => parseDeployment(mainnetManifest());

  it("say the action is prepared again once they are mined, and carry no rating line", async () => {
    const first = await prepareNext(ctx({ d: mainnet(), indexer: index(["3"], () => false) }), deposit);
    expect(first).toMatchObject({ status: "ready", again: true, then: [], next: { label: "Settle the vault's loans", kind: "action", final: false } });
    expect(first.notes.some((n) => RATE.test(n))).toBe(false);
    const last = await prepareNext(ctx({ d: mainnet(), indexer: index(["3"], () => true), chain: fakeChain({ allowance: () => Promise.resolve(10n ** 30n) }) }), deposit);
    expect(last).not.toHaveProperty("again");
    expect(last.next).toMatchObject({ label: "Deposit", final: true });
    expect(last.notes.at(-1)).toMatch(RATE);
  });

  it("end a signer's run with the line once, after the action itself", async () => {
    let booked = false;
    const r = await run(ctx({ d: mainnet(), indexer: index(["3"], () => booked), chain: fakeChain({ wait: () => { booked = true; return Promise.resolve(true); } }) }), deposit, fakeSigner());
    expect(r.status).toBe("done");
    expect(r.notes.filter((n) => RATE.test(n))).toHaveLength(1);
    expect(r.notes.at(-1)).toMatch(RATE);
  });
});

// With gage's index off, the chain still knows what a core credits the wallet: a read that fails says nothing of what
// stayed unread, so nothing reads as empty.
describe("collect, where part of it could not be read", () => {
  const down = () => fakeUpstream({ "/v2/positions?": () => ({ status: 503, body: {} }), "/intent/partners/vaults?": () => ({ status: 503, body: {} }) });

  it("answers partial with a title that says so, never done", async () => {
    const p = await prepareNext(ctx({ indexer: down() }), { action: "collect", wallet: WALLET });
    expect(p).toMatchObject({ status: "partial", next: null });
    expect(p.summary.title).toBe("Some of this wallet's loans and vaults could not be read now: collect again shortly");
    expect(p.notes.join(" ")).toMatch(/Not read just now/);
    const r = await run(ctx({ indexer: down() }), { action: "collect", wallet: WALLET }, fakeSigner());
    expect(r.status).toBe("partial");
  });

  it("keeps a credit the chain knows in the plan, read on its own", async () => {
    const chain = fakeChain({ cashCredit: (core: string) => Promise.resolve(core === CORE ? 7_000_000n : 0n) });
    const p = await prepareNext(ctx({ indexer: down(), chain }), { action: "collect", wallet: WALLET });
    expect(p).toMatchObject({ status: "ready", next: { label: "Receive 7.00 USDG" } });
    expect(p.view).toMatchObject({ action: "collect", usdg: "7000000" });
    expect(p.notes.join(" ")).toMatch(/Not read just now/);
    const signer = fakeSigner();
    const r = await run(ctx({ indexer: down(), chain: fakeChain({ cashCredit: () => Promise.resolve(0n), ...{} }) }), { action: "collect", wallet: WALLET }, signer);
    expect(r.status).toBe("partial");
    const sent = await run(ctx({ indexer: down(), chain }), { action: "collect", wallet: WALLET }, fakeSigner());
    expect(sent).toMatchObject({ status: "partial", sent: [{ label: "Receive 7.00 USDG", outcome: "succeeded" }] });
  });

  it("says done only with everything read", async () => {
    const all = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } });
    const p = await prepareNext(ctx({ indexer: all }), { action: "collect", wallet: WALLET });
    expect(p).toMatchObject({ status: "done", summary: { title: "Nothing is ready to collect" } });
  });
});

describe("a portfolio where part of it could not be read", () => {
  it("says it is partial, and still shows each core's credit the chain knows", async () => {
    const down = fakeUpstream({ "/v2/positions?": () => ({ status: 503, body: {} }), "/intent/partners/vaults?": () => ({ status: 503, body: {} }), "/intent/partners/links": { links: [] } });
    const chain = fakeChain({ cashCredit: (core: string) => Promise.resolve(core === CORE ? 7_000_000n : 0n) });
    const answer = await portfolio(ctx({ indexer: down, chain }), WALLET);
    expect(answer).toMatchObject({ status: "partial", usdgCredit: "7000000", loans: [] });
    expect(answer.unread?.length).toBeGreaterThan(0);
    const up = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null }, "/intent/partners/links": { links: [] } });
    expect(await portfolio(ctx({ indexer: up }), WALLET)).not.toHaveProperty("status");
  });
});
