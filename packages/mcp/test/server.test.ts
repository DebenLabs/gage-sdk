import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gageFrom, parseDeployment, TESTNET_MANIFEST } from "gage-sdk";
import {
  A, assetManifest, CORE, ctx, fakeChain, fakeSigner, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_VAULT, GLDX, LP_CORE, lpFablesManifest, lpFormatsManifest, lpLoan, lpManifest, lpQuoteRoute, lpStockManifest,
  mainnetManifest, NVDA,
  SCHIFFY, UNI_ADAPTER, UNI_NFPM, USDG, V4_ADAPTER, V4_POOL, VAULT, WALLET, WETH,
} from "gage-sdk/testing";
import { decodeFunctionData, parseAbi } from "viem";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, MAINNET_LIMITS } from "../src/limits.js";
import { createLocalMcp } from "../src/server.js";
import { EXITS, PUTS, ROLLS, TESTNET_FABLES, TESTNET_LP, TESTNET_PARK, TESTNET_ROLLS, TESTNET_TOOLS } from "./testnet.js";

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
    // Eight reads, the two pool vault tools (D333) and a prepare per action: on mainnet, rating gage too (D302).
    expect((await client.listTools()).tools).toHaveLength(22);
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
    expect(names).toHaveLength(36);
    expect(names).toContain("gage_limits");
    expect(names).toContain("gage_feedback");
    expect(client.getInstructions()).toContain("Spend limits its owner set: it borrows at most 100 USDG a loan or loop and 250 USDG in any 24 hours");
    expect(client.getInstructions()).toContain("leaving a loan to roll by itself or ending that, withdrawing, unparking, exiting a partner vault or a rehypo pool now and listing an exit's next loan, cancelling, collecting, claiming an LP vault's bonus, wrapping or unwrapping Fables receipts, a curator's opening an LP vault or changing its pools and rating gage are not limited");
    expect(client.getInstructions()).toContain("gage_roll, gage_auto_roll, gage_cancel_auto_roll");
    expect(client.getInstructions()).not.toContain("LP loans:");
    const limitsTool = (await client.listTools()).tools.find((t) => t.name === "gage_limits")!;
    expect(limitsTool.description).toContain("leaving a loan to roll by itself or ending that, withdrawing, unparking, exiting a partner vault or a rehypo pool now and listing an exit's next loan, cancelling, collecting, claiming an LP vault's bonus, wrapping or unwrapping Fables receipts, a curator's opening an LP vault or changing its pools and rating gage are not limited");
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
  // Current routers enable new rolls and puts. Retained routers only close positions and end earlier instructions.
  it("serves and names only the actions its network has", async () => {
    const signer = fakeSigner();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(gageFrom(ctx({ d: parseDeployment(TESTNET_MANIFEST), indexer: indexer() })), signer);
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const names = (await client.listTools()).tools.map((t) => t.name);
    // Its LP lane, while public: the lane's 28 tools (four reads, and a prepare and an action for each of its twelve
    // actions, its own loan roll among them) beside the others.
    expect(names).toHaveLength(TESTNET_TOOLS);
    expect(names.filter((n) => n.includes("roll") && !n.includes("put") && !n.includes("_lp_"))).toEqual([...ROLLS.map((a) => `gage_prepare_${a}`), ...ROLLS.map((a) => `gage_${a}`)]);
    expect(names.filter((n) => n.includes("put_"))).toEqual([...(PUTS.includes("put_open") ? ["gage_put_quote"] : []), ...PUTS.map((a) => `gage_prepare_${a}`), ...PUTS.map((a) => `gage_${a}`)]);
    expect(client.getInstructions()).toContain("The action tools (gage_borrow, gage_leverage, gage_cancel, gage_reclaim, gage_cash_out, "
      + ROLLS.map((a) => `gage_${a}, `).join("") + "gage_earn_deposit, gage_earn_redeem, gage_collect" + PUTS.map((a) => `, gage_${a}`).join("")
      + (TESTNET_LP ? ", gage_lp_borrow, gage_lp_repay, gage_lp_return_position, gage_lp_collect, gage_lp_withdraw, gage_lp_deposit, gage_lp_redeem, "
        + "gage_lp_claim_bonus, gage_lp_roll" + (TESTNET_FABLES ? ", gage_lp_wrap, gage_lp_unwrap" : "") + ", gage_lp_create_vault, gage_lp_vault_add_pool, gage_lp_vault_remove_pool" : "")
      + (TESTNET_PARK ? ", gage_park, gage_unpark" : "") + EXITS.map((a) => `, gage_${a}`).join("") + ")");
    if (!TESTNET_ROLLS) expect(client.getInstructions()).not.toContain("gage_roll");
    // Exit now, once a current generation names the chain's exit desk: a prepare and an action for each exit action.
    expect(names.filter((n) => n.includes("exit"))).toEqual([...EXITS.map((a) => `gage_prepare_${a}`), ...EXITS.map((a) => `gage_${a}`)]);
    // Park and unpark (D334) wherever the release names an LP lane: the read, the two actions, and one line saying what they are for.
    expect(names.filter((n) => n.includes("park"))).toEqual(TESTNET_PARK ? ["gage_park_positions", "gage_prepare_park", "gage_prepare_unpark", "gage_park", "gage_unpark"] : []);
    if (TESTNET_PARK) expect(client.getInstructions()).toMatch(/Park: gage_park_positions lists a wallet's out-of-range liquidity positions/);
  });

  // D333: a DEX partner's pool vaults, one per pool token gage lends; the calls are its curator's to send, never this server's.
  it("answers the calls that create a pool's vaults, and signs none of them, even with a key", async () => {
    const signer = fakeSigner();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(gageFrom(ctx({ d: parseDeployment(assetManifest()), indexer: indexer() })), signer);
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const tools = (await client.listTools()).tools.filter((t) => t.name.includes("pool_vaults"));
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint, t.annotations?.destructiveHint])).toEqual([["gage_pool_vaults", true, false], ["gage_create_pool_vaults", true, false]]);
    expect(client.getInstructions()).toContain("gage_create_pool_vaults answers the calls that create them");
    const made = await client.callTool({ name: "gage_create_pool_vaults", arguments: {
      curator: A(0xfab1e), name: "Fables", pool: ["GLDx", "USDG"], term: 604_800, feeBps: 1_000,
      sides: [{ token: "GLDx", maxLoan: "5000000000000000000" }, { token: "USDG", maxLoan: "1500000000" }],
    } });
    const answer = made.structuredContent as { name: string; calls: { to: string }[]; safeBatch: { transactions: unknown[] } };
    expect(answer.name).toBe("Fables GLDx/USDG");
    expect(answer.calls.map((c) => c.to)).toEqual([GLD_FACTORY, "0x0000000000000000000000000000000000000050"]);
    expect(answer.safeBatch.transactions).toHaveLength(2);
    expect(signer.sent).toHaveLength(0);
  });

  it("without a key, reads and prepares unsigned transactions only", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(21);
    expect(tools.some((t) => t.annotations?.destructiveHint)).toBe(false);
    expect(client.getInstructions()).toMatch(/holds no key/);
  });

  it("with a key, adds its wallet and the actions, which sign and send gage's own plan", async () => {
    const signer = fakeSigner();
    const client = await connect(signer);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(33);
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

// The LP lane (docs/api.md "LP lane"), where a release makes it public: its reads and actions, and the spend limits
// counting an LP loan by its principal.
describe("the local MCP where the LP lane is public", () => {
  const lpMainnet = (principal: bigint) => gageFrom(ctx({
    d: parseDeployment({ ...mainnetManifest(), lpLane: lpManifest().lpLane }), indexer: indexer(),
    rates: fakeUpstream({ "/lp/quote/": lpQuoteRoute({ principal, repayment: (principal * 1006n) / 1000n }) }),
  }));
  const connectTo = async (gage: ReturnType<typeof gageFrom>, signer?: ReturnType<typeof fakeSigner>, limited?: Parameters<typeof createLocalMcp>[2]) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcp(gage, signer, limited);
    await server.connect(serverSide);
    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(async () => { await client.close(); await server.close(); });
    return client;
  };

  it("reads the lane and prepares its actions without a key, and says what its tools are for", async () => {
    const client = await connectTo(gageFrom(ctx({ d: parseDeployment(lpManifest()), indexer: indexer() })));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.includes("_lp_"))).toEqual([
      "gage_lp_positions", "gage_lp_quote", "gage_lp_loans", "gage_lp_vaults", "gage_prepare_lp_borrow", "gage_prepare_lp_repay", "gage_prepare_lp_return_position",
      "gage_prepare_lp_collect", "gage_prepare_lp_withdraw", "gage_prepare_lp_deposit", "gage_prepare_lp_redeem", "gage_prepare_lp_claim_bonus", "gage_prepare_lp_roll",
      "gage_prepare_lp_vault_add_pool", "gage_prepare_lp_vault_remove_pool",
    ]);
    // A vault funds only the pools of its mandate; without a factory in the release, no word of opening one.
    expect(client.getInstructions()).toContain("it funds loans only in the pools of its mandate (gage_lp_vaults funds). Its curator changes them with the lp_vault_add_pool and lp_vault_remove_pool tools.");
    expect(client.getInstructions()).toContain("LP loans: gage_lp_positions lists a wallet's ETH/USDG or stock/USDG liquidity positions on Uniswap v3 or v4, SushiSwap v3 or Ramses that gage lends USDG against at a fixed cost");
    expect(client.getInstructions()).toContain("before its end it may be rolled into a new loan on the same position (the lp_roll tools)");
    expect(client.getInstructions()).toContain("A Uniswap v4 position leaves any subscription it has when it is pledged, and a native ETH pool's fees come as WETH.");
    // Without a Fables adapter in the release, no word of Fables and no wrap tools.
    expect(client.getInstructions()).not.toContain("Fables");
    const vaults = await client.callTool({ name: "gage_lp_vaults", arguments: {} });
    expect(vaults.structuredContent).toMatchObject({ vaults: [{ name: "WETH/USDG LP lane", takesDeposits: true }] });
  });

  it("lists a wallet's Uniswap v4 positions gage's index names, each checked on chain, and says when some may be missing", async () => {
    const v4Facts = { pool: V4_POOL, token0: WETH, token1: USDG, tickLower: -199_380, tickUpper: -197_370, liquidity: 10n ** 16n };
    const chain = fakeChain({ lpFacts: (adapter: string, ids: readonly bigint[]) => Promise.resolve(ids.map(() => (adapter.toLowerCase() === V4_ADAPTER ? v4Facts : null))) });
    const index = (incomplete: boolean) => fakeUpstream({ "/lp/positions?": { owner: WALLET.toLowerCase(), block: "1", incomplete, positions: [{ adapter: V4_ADAPTER, kind: "uniswap-v4", tokenId: "12" }] } });
    const read = async (incomplete: boolean) => (await (await connectTo(gageFrom(ctx({ d: parseDeployment(lpFormatsManifest()), chain, indexer: index(incomplete) }))))
      .callTool({ name: "gage_lp_positions", arguments: { wallet: WALLET } })).structuredContent as { positions: { kind: string; tokenId: string; poolName: string }[]; note: string };
    const complete = await read(false);
    expect(complete.positions).toMatchObject([{ kind: "uniswap-v4", tokenId: "12", poolName: "ETH / USDG v4 0.05%" }]);
    expect(complete.note).not.toContain("may be missing");
    expect((await read(true)).note).toContain("Some of this wallet's Uniswap v4 positions may be missing");
  });

  it("serves Fables' wrap tools where the release lends against Fables positions, and says how receipts are borrowed against", async () => {
    const client = await connectTo(gageFrom(ctx({ d: parseDeployment(lpFablesManifest()), indexer: indexer() })));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.includes("_lp_")).slice(-5)).toEqual(["gage_prepare_lp_roll", "gage_prepare_lp_wrap", "gage_prepare_lp_unwrap", "gage_prepare_lp_vault_add_pool", "gage_prepare_lp_vault_remove_pool"]);
    expect(client.getInstructions()).toContain("SushiSwap v3, Ramses or Fables that gage lends USDG against");
    expect(client.getInstructions()).toContain("Fables receipts not wrapped yet are listed apart (fablesReceipts): the lp_borrow tools take their adapter and rangeId and wrap them into a position first");
  });

  it("serves a curator's tool to open an LP vault where the release names the lane's vault factory, and says the vault's shares are a token", async () => {
    const client = await connectTo(gageFrom(ctx({ d: parseDeployment({ ...mainnetManifest(), lpLane: lpStockManifest().lpLane }), indexer: indexer() })));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("gage_prepare_lp_create_vault");
    // D319: the registry's mayOpenVault, a curator it allows or anyone once it opens creation; ERC-4626 shares that move.
    expect(client.getInstructions()).toContain("and a wallet the registry lets open one (a curator it allows, or anyone once it opens vault creation) opens one with the lp_create_vault tools.");
    expect(client.getInstructions()).toContain("an LP vault is an ERC-4626 whose shares (gLP, raw in the vault's own shareDecimals) move between wallets");
  });

  it("rolls an LP loan under spend limits by what its new loan borrows beyond the old one: a roll of the same size counts nothing", async () => {
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), "gage-limits-")), "wallet"));
    const chain = fakeChain({ lpLoans: (_c: string, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id }))) });
    const rolled = (principal: bigint) => gageFrom(ctx({
      d: parseDeployment({ ...mainnetManifest(), lpLane: lpManifest().lpLane }), chain, indexer: indexer(),
      rates: fakeUpstream({ "/lp/quote/": lpQuoteRoute({ principal, repayment: (principal * 1006n) / 1000n }) }),
    }));
    const rolling = { loanId: "1", term: 604_800, maxCostBps: 60 };
    const signer = fakeSigner();
    // The 1,000 USDG loan rolled into 1,150: 150 USDG further, past the 100 an action.
    const over = await (await connectTo(rolled(1_150_000_000n), signer, { limits: MAINNET_LIMITS, ledger })).callTool({ name: "gage_lp_roll", arguments: rolling });
    expect(over.isError).toBe(true);
    expect(JSON.stringify(over.content)).toContain("This LP roll borrows a further 150 USDG: this wallet may borrow at most 100 USDG a loan or loop");
    expect(signer.sent).toHaveLength(0);
    const client = await connectTo(rolled(1_000_000_000n), signer, { limits: MAINNET_LIMITS, ledger });
    const done = await client.callTool({ name: "gage_lp_roll", arguments: rolling });
    // The new loan less its fee falls 9.50 USDG short of the old repayment: the wallet pays it, approved exactly.
    expect(done.structuredContent).toMatchObject({ status: "done", sent: [{ label: "Approve USDG" }, { label: "Roll over" }] });
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([USDG, LP_CORE]);
    expect((await client.callTool({ name: "gage_limits", arguments: {} })).structuredContent).toMatchObject({ borrow: { used: "0", left: "250000000" } });
  });

  it("borrows against a position under spend limits by its principal: past one nothing is sent, within one the loan's USDG comes to the wallet", async () => {
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), "gage-limits-")), "wallet"));
    const borrow = { adapter: UNI_ADAPTER, tokenId: "1469882", term: 604_800, maxCostBps: 60 };
    const signer = fakeSigner();
    const over = await (await connectTo(lpMainnet(150_000_000n), signer, { limits: MAINNET_LIMITS, ledger })).callTool({ name: "gage_lp_borrow", arguments: borrow });
    expect(over.isError).toBe(true);
    expect(JSON.stringify(over.content)).toContain("This LP loan borrows 150 USDG: this wallet may borrow at most 100 USDG a loan or loop");
    expect(signer.sent).toHaveLength(0);
    const client = await connectTo(lpMainnet(100_000_000n), signer, { limits: MAINNET_LIMITS, ledger });
    const done = await client.callTool({ name: "gage_lp_borrow", arguments: borrow });
    expect(done.structuredContent).toMatchObject({ status: "done", sent: [{ label: "Approve position #1469882" }, { label: "Borrow" }, { label: "Receive 99.65 USDG" }] });
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([UNI_NFPM, LP_CORE, LP_CORE]);
    expect((await client.callTool({ name: "gage_limits", arguments: {} })).structuredContent).toMatchObject({ borrow: { used: "100000000", left: "150000000" } });
    // Withdrawing what the lane credits the wallet holds nothing against the limits.
    expect((await client.callTool({ name: "gage_lp_withdraw", arguments: {} })).structuredContent).toMatchObject({ status: "nothing_to_do" });
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
    // The release's current actions, its retained-position upkeep, and the LP lane's 28 tools while public.
    expect(tools).toHaveLength(TESTNET_TOOLS);
    if (TESTNET_ROLLS) expect(tools.map((t) => t.name)).toContain("gage_roll");
    else expect(tools.map((t) => t.name)).not.toContain("gage_roll");
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
