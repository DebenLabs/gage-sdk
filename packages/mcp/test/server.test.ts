import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gageFrom, parseDeployment, TESTNET_MANIFEST } from "gage-sdk";
import { A, assetManifest, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_VAULT, GLDX, mainnetManifest, NVDA, SCHIFFY, USDG, VAULT, WALLET } from "gage-sdk/testing";
import { decodeFunctionData, parseAbi } from "viem";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, MAINNET_LIMITS } from "../src/limits.js";
import { createLocalMcp } from "../src/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const vault = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1814400, assets: [NVDA], fundingEnabled: true };
const indexer = () => fakeUpstream({
  "/intent/partners/vaults?": { items: [vault], nextCursor: null },
  "/intent/partners/vaults/": { kind: "DEPOSIT", assets: "100000000", shares: "100000000000000000000", refusal: null, availableNow: null },
});

async function connect(signer?: ReturnType<typeof fakeSigner>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createLocalMcp(gageFrom(ctx({ indexer: indexer() })), signer);
  await server.connect(serverSide);
  const client = new Client({ name: "gage-test", version: "1.0.0" });
  await client.connect(clientSide);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("the local MCP on mainnet (D260)", () => {
  const mainnet = () => gageFrom(ctx({ d: parseDeployment(mainnetManifest()), indexer: indexer() }));

  it("serves without a key: it reads and prepares, says it is mainnet, and never signs", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(mainnet());
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    // Seven reads and a prepare per action: on mainnet, rating gage too (D302).
    expect((await client.listTools()).tools).toHaveLength(19);
    expect(client.getInstructions()).toContain("on Robinhood Chain (4663), with real assets.");
    expect(client.getInstructions()).toContain("To let this server sign under spend limits");
    expect(client.getInstructions()).toContain("you may rate gage, agent #8845 in ERC-8004, with gage_prepare_feedback: your own score from 0 to 100, once a wallet. It is optional, and gage offers nothing for it.");
    expect(client.getInstructions()).not.toContain("testnet");
  });

  it("signs with a key its owner gives no spend limits too: the owner's choice (D311)", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(mainnet(), fakeSigner());
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("gage_borrow");
    expect(names).not.toContain("gage_limits");
    expect(client.getInstructions()).not.toContain("Spend limits");
  });

  it("signs under spend limits with a key (D297): a loan past one sends nothing, and gage_limits says what is left", async () => {
    const signer = fakeSigner();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), "gage-limits-")), "wallet"));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(mainnet(), signer, { limits: MAINNET_LIMITS, ledger });
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(33);
    expect(names).toContain("gage_limits");
    expect(names).toContain("gage_feedback");
    expect(client.getInstructions()).toContain("Spend limits its owner set: it borrows at most 100 USDG a loan or loop and 250 USDG in any 24 hours");
    expect(client.getInstructions()).toContain("leaving a loan to roll by itself or ending that, withdrawing, cancelling, collecting and rating gage are not limited");
    expect(client.getInstructions()).toContain("gage_roll, gage_auto_roll, gage_cancel_auto_roll");
    const limitsTool = (await client.listTools()).tools.find((t) => t.name === "gage_limits")!;
    expect(limitsTool.description).toContain("leaving a loan to roll by itself or ending that, withdrawing, cancelling, collecting and rating gage are not limited");
    expect(client.getInstructions()).toContain("you may rate gage, agent #8845 in ERC-8004, with gage_feedback");
    const loan = (principal: bigint) => ({ token: NVDA, collateral: "5000000000000000000", principal: String(principal), cap: String((principal * 101n) / 100n), term: 604_800 });
    const over = await client.callTool({ name: "gage_borrow", arguments: loan(150_000_000n) });
    expect(over.isError).toBe(true);
    expect(JSON.stringify(over.content)).toContain("SPEND_LIMIT");
    expect(signer.sent).toHaveLength(0);
    const done = await client.callTool({ name: "gage_borrow", arguments: loan(100_000_000n) });
    expect(done.structuredContent).toMatchObject({ status: "done" });
    expect((await client.callTool({ name: "gage_limits", arguments: {} })).structuredContent).toMatchObject({ borrow: { used: "100000000", left: "150000000" } });
  });

  // D302: the wallet rates gage itself, one transaction to ERC-8004's Reputation Registry; a rating moves no money, so no limit holds it.
  it("rates gage with its own wallet under spend limits, holding nothing against them", async () => {
    const signer = fakeSigner();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), "gage-limits-")), "wallet"));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(mainnet(), signer, { limits: MAINNET_LIMITS, ledger });
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const rated = await client.callTool({ name: "gage_feedback", arguments: { score: 85 } });
    expect(rated.structuredContent).toMatchObject({ action: "feedback", status: "done", sent: [{ label: "Rate gage", outcome: "succeeded" }], notes: [] });
    expect(signer.sent).toHaveLength(1);
    expect(signer.sent[0]).toMatchObject({ to: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", chainId: 4663 });
    expect((await client.callTool({ name: "gage_limits", arguments: {} })).structuredContent).toMatchObject({ borrow: { used: "0" }, deposit: { used: "0" } });
  });
});

describe("the local MCP", () => {
  // The testnet's release names no rollover router: its tools and its instructions leave rolling over out.
  it("serves and names only the actions its network has", async () => {
    const signer = fakeSigner();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(gageFrom(ctx({ d: parseDeployment(TESTNET_MANIFEST), indexer: indexer() })), signer);
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(24);
    expect(names.filter((n) => n.includes("roll"))).toEqual([]);
    expect(client.getInstructions()).toContain("The action tools (gage_borrow, gage_leverage, gage_cancel, gage_reclaim, gage_cash_out, gage_earn_deposit, gage_earn_redeem, gage_collect)");
    expect(client.getInstructions()).not.toContain("gage_roll");
  });

  it("without a key, reads and prepares unsigned transactions only", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(18);
    expect(tools.some((t) => t.annotations?.destructiveHint)).toBe(false);
    expect(client.getInstructions()).toMatch(/holds no key/);
  });

  it("with a key, adds its wallet and the actions, which sign and send gage's own plan", async () => {
    const signer = fakeSigner();
    const client = await connect(signer);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(30);
    expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)).toEqual([
      "gage_borrow", "gage_leverage", "gage_cancel", "gage_reclaim", "gage_cash_out", "gage_roll", "gage_auto_roll", "gage_cancel_auto_roll", "gage_earn_deposit", "gage_earn_redeem", "gage_collect",
    ]);
    expect(client.getInstructions()).toContain(WALLET);
    const wallet = await client.callTool({ name: "gage_wallet", arguments: {} });
    expect(wallet.structuredContent).toMatchObject({ wallet: WALLET, usdg: "1000000000000000000000000000000" });
    const deposit = await client.callTool({ name: "gage_earn_deposit", arguments: { vault: VAULT, amount: "100000000" } });
    expect(deposit.structuredContent).toMatchObject({ status: "done", sent: [{ label: "Approve USDG", outcome: "succeeded" }, { label: "Deposit", outcome: "succeeded" }] });
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([USDG, VAULT]);
  });

  it("answers a refusal with its code, and takes no wallet from the input", async () => {
    const signer = fakeSigner();
    const client = await connect(signer);
    const refused = await client.callTool({ name: "gage_earn_deposit", arguments: { vault: A(0x99), amount: "100000000" } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("UNKNOWN_VAULT");
    // An input naming a wallet fails the schema, as a tool error or a protocol error depending on the SDK's version.
    const named = await client.callTool({ name: "gage_earn_deposit", arguments: { wallet: WALLET, vault: VAULT, amount: "100000000" } }).then((r) => r.isError === true, () => true);
    expect(named).toBe(true);
    expect(signer.sent).toHaveLength(0);
  });
});

/**
 * A release that lends GLDx beside USDG (D251): the signer's GLDx vault withdrawal never sends a full balance an
 * 18-decimal vault cannot pay after a loss, nor leaves shares with nothing behind them, and a loop in GLDx is refused
 * in fixed words.
 */
describe("the local MCP where a lend asset is public", () => {
  it("withdraws everything a GLDx vault can pay, never its full balance, and refuses a GLDx loop", async () => {
    const E18 = 10n ** 18n, supply = 5n * E18, total = 42n * E18 / 10n, VIRTUAL = 10n ** 12n, SCALE = 10n ** 12n;
    const toAssets = (n: bigint) => (n * (total + SCALE)) / (supply + VIRTUAL);
    const lent = fakeUpstream({
      "/intent/partners/vaults?": (path: string) => ({ status: 200, body: {
        items: path.includes(`factory=${GLD_FACTORY}`) ? [{ ...vault, address: GLD_VAULT, core: GLD_CORE, categoryMask: 6, assets: [SCHIFFY] }] : [vault], nextCursor: null,
      } }),
      "/intent/partners/vaults/": (path: string) => {
        const n = BigInt(new URL(path, "http://indexer.test").searchParams.get("redeem")!), assets = toAssets(n), refusal = assets > total ? "INSUFFICIENT_LIQUIDITY" : null;
        return { status: 200, body: { kind: "REDEEM", assets: String(assets), shares: String(n), refusal, availableNow: refusal ? String(total) : null } };
      },
    });
    const signer = fakeSigner();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    // The vault's book, read on chain: this wallet its only holder, all 4.2 GLDx free.
    const chain = fakeChain({ vaultShares: () => Promise.resolve(supply), vaultBook: () => Promise.resolve({ totalAssets: total, totalSupply: supply, free: total, performing: 0n }) });
    const server = createLocalMcp(gageFrom(ctx({ d: parseDeployment(assetManifest()), indexer: lent, chain })), signer);
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const loop = await client.callTool({ name: "gage_leverage", arguments: { token: NVDA, own: String(E18), multiple: 2, term: 604_800, maxCostBps: 500, lendAsset: GLDX } });
    expect(loop.isError).toBe(true);
    expect(JSON.stringify(loop.content)).toContain("LEVERAGE_CLOSED");
    const out = await client.callTool({ name: "gage_earn_redeem", arguments: { vault: GLD_VAULT } });
    expect(out.structuredContent).toMatchObject({ status: "done", sent: [{ label: "Withdraw", outcome: "succeeded" }] });
    const [shares] = decodeFunctionData({ abi: parseAbi(["function redeem(uint256 shares, uint256 minAssets)"]), data: signer.sent[0]!.data }).args;
    expect(shares).toBeLessThan(supply);
    expect(toAssets(shares)).toBeLessThanOrEqual(total);
    // Something stays behind the shares left: never shares out with nothing behind them (the r9 e2e, 15 October 2026).
    expect(total - toAssets(shares)).toBeGreaterThan(0n);
  });
});

describe("gage-mcp over stdio", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const spawnArgs = ["--import", "tsx", cli];

  it("serves the signer's tools when started with a key, and keeps stdout to MCP", async () => {
    const key = generatePrivateKey();
    const transport = new StdioClientTransport({ command: process.execPath, args: spawnArgs, cwd, env: { ...getDefaultEnvironment(), GAGE_NETWORK: "testnet", GAGE_PRIVATE_KEY: key }, stderr: "pipe" });
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const tools = (await client.listTools()).tools;
    // The testnet's own release: no rollover router, so no roll tools (seven reads, the wallet, eight prepares, eight actions).
    expect(tools).toHaveLength(24);
    expect(tools.map((t) => t.name)).not.toContain("gage_roll");
    expect(client.getInstructions()).toContain(privateKeyToAccount(key).address);
  }, 30_000);

  it("refuses a malformed key in fixed words, never echoing it", () => {
    const key = `0x${"z".repeat(64)}`;
    const r = spawnSync(process.execPath, spawnArgs, { cwd, env: { ...getDefaultEnvironment(), GAGE_PRIVATE_KEY: key }, input: "", encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("INVALID_KEY");
    expect(r.stderr).not.toContain("zzzz");
    expect(r.stdout).toBe("");
  }, 30_000);
});
