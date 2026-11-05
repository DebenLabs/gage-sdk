/**
 * The in-chat card (MCP Apps): a host that draws apps shows a plan's preview as gage's card beside the words, and the
 * others keep the text. The card is drawn here from the plan and travels in the result's `_meta`.
 */
import { gageFrom, parseDeployment } from "gage-sdk";
import { A, CORE, ctx, fakeChain, fakeUpstream, manifest, NOW, NVDA, USDG, VAULT, WALLET } from "gage-sdk/testing";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_META, CARD_MIME, CARD_URI } from "../src/card.js";
import { createLocalMcp } from "../src/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const SOURCE = A(0x160), HOOK = A(0x161), DESK = A(0x162), MARKET = A(0x163);
const row = { address: VAULT, creator: A(1), curator: A(1), core: CORE, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true };
const LOAN = (id: string, interest: string) => ({ id, state: "PERFORMING", principal: "1000000000", interest, maturity: NOW - 3600 + 604_800, start: NOW - 3600 });
const indexer = () => fakeUpstream({
  "/intent/partners/vaults?": { items: [row], nextCursor: null },
  "/intent/partners/vaults/": {
    pricing: { totalAssets: "10000000000", totalSupply: "10000000000", assetsPerShare: "1" }, liquidity: { free: "1" }, settlement: { due: false, settleable: [] },
    asOf: NOW, loans: [LOAN("5", "20000000"), LOAN("7", "5000000")],
  },
});
const record = (interest: bigint) => ({
  maturity: NOW - 3600 + 604_800, withdrawn: false, settled: false, principal: 1_000_000_000n, interest, rate: (interest * 10n ** 18n) / 604_800n, clockStart: NOW - 3600,
});
/** The SDK's rehypo fixture: an LP's 3,000 USDG share of a source that can pay 1,000 now. */
const chain = () => fakeChain({
  rehypoSource: () => Promise.resolve({
    vault: VAULT, earliestMaturity: NOW + 86_400, asset: USDG, depositor: HOOK, totalAssets: 10_000_000_000n, float: 600_000_000n, payableNow: 1_000_000_000n,
    lpBalance: 30n, lpSupply: 100n, hold: 3600,
  }),
  exitDeskOf: () => Promise.resolve(DESK),
  lenderMarket: () => Promise.resolve(MARKET),
  exitOf: () => Promise.resolve({ shares: 0n, id: 0n, nonce: 0n, committedAt: 0, life: 86_400 }),
  exitOwed: () => Promise.resolve(0n),
  vaultPreviewWithdraw: (_vault: unknown, assets: bigint) => Promise.resolve(assets),
  vaultShares: () => Promise.resolve(9_400_000_000n),
  exitVaultBook: (_vault: unknown, shares: bigint) => Promise.resolve({ claim: shares, free: 1_900_000_000n, held: 1_900_000_000n, loans: 5_000_000_000n, supply: 10_000_000_000n }),
  exitRecords: () => Promise.resolve([5n, 7n]),
  exitRecord: (_vault: unknown, id: bigint) => Promise.resolve(record(id === 5n ? 20_000_000n : 5_000_000n)),
  accrualEnd: () => Promise.resolve(BigInt(NOW)),
  saleSlots: () => Promise.resolve(4),
  withinAverage: () => Promise.resolve(true),
});

async function connect() {
  const d = parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, exitDesk: DESK } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createLocalMcp(gageFrom(ctx({ d, chain: chain(), indexer: indexer() })));
  await server.connect(serverSide);
  const client = new Client({ name: "gage-test", version: "1.0.0" });
  await client.connect(clientSide);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("gage's card in the chat", () => {
  it("names its card on the tools whose answers carry a preview, and only on them", async () => {
    const tools = (await (await connect()).listTools()).tools;
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta("gage_prepare_rehypo_exit_now")?.ui?.resourceUri).toBe(CARD_URI);
    expect(meta("gage_prepare_earn_exit_now")?.ui?.resourceUri).toBe(CARD_URI);
    // An exit's next listing, cancel and collect carry no preview.
    for (const name of ["gage_prepare_earn_exit_list", "gage_prepare_earn_exit_cancel", "gage_prepare_earn_exit_collect"]) {
      expect(tools.some((t) => t.name === name), name).toBe(true);
      expect(meta(name)?.ui, name).toBeUndefined();
    }
    expect(meta("gage_prepare_borrow")?.ui).toBeUndefined();
  });

  it("serves the card's view as an app page that fetches and loads nothing", async () => {
    const read = await (await connect()).readResource({ uri: CARD_URI });
    const page = read.contents[0] as { mimeType?: string; text?: string };
    expect(page.mimeType).toBe(CARD_MIME);
    expect(page.text).toContain("ui/initialize");
    expect(page.text).toContain("ui/notifications/tool-result");
    expect(page.text).toContain(CARD_META);
    expect(page.text).not.toMatch(/src=|href=|@import|https?:\/\//);
  });

  it("draws the plan's preview as gage's card, light and dark, beside the plan the model reads as before", async () => {
    const result = await (await connect()).callTool({ name: "gage_prepare_rehypo_exit_now", arguments: { wallet: WALLET, source: SOURCE } });
    expect(result.isError).toBeFalsy();
    const card = (result._meta as Record<string, { light: string; dark: string }> | undefined)?.[CARD_META];
    expect(card?.light).toMatch(/^<svg /);
    expect(card?.light).toContain(">3,000.00 USDG<");
    expect(card?.light).toContain("about 7.00 USDG");
    expect(card?.dark).toContain('fill="#1d1a15"');
    const plan = JSON.parse((result.content as { text: string }[])[0]!.text) as { preview?: { giveUp: string } };
    expect(plan.preview?.giveUp).toBe("7008035");
    expect(JSON.stringify(result.content)).not.toContain("<svg");
  });
});
