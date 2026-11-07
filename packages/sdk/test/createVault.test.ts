/**
 * One partner vault, as gage.cash's Create makes it (web/src/intent/partners/PartnerCreate.tsx): a free name, one lend
 * asset, a mandate in one universe. `createVault` answers the call and a Safe's Transaction Builder file; the action
 * `create_vault` is the same vault for `prepare` and `run`, which reads the new vault's address from its receipt.
 */
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { factoryAbi } from "../src/abi.js";
import { gageFrom, type Gage } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { batchChecksum } from "../src/safe.js";
import { gageTools, poolVaultTools } from "../src/tools.js";
import { A, assetManifest, CORE, ctx, FACTORY, fakeChain, fakeSigner, GLD_CORE, GLD_FACTORY, GLDX, manifest, NVDA, SCHIFFY, USDG, WALLET } from "../src/testing.js";

const MEME = A(0x16), CURATOR = WALLET;
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const input = (over: Record<string, unknown> = {}) => ({ curator: CURATOR, name: "Acme Stocks", term: 604_800, feeBps: 1_000, maxLoan: "1500000000", ...over }) as Parameters<Gage["createVault"]>[0];
const withMemes = () => ({ ...assetManifest(), nativeV2: { ...manifest().nativeV2, assets: [...manifest().nativeV2.assets, { token: MEME, symbol: "MEMEx", name: "A meme", decimals: 18, lane: "MEME" }] } });
/** The fake's factories at a version, each token in its category: NVDAx a stock, MEMEx and SCHIFFYx memes. */
const factories = (over: { mandateVersion?: number; isCreator?: boolean; openCreation?: boolean } = {}) => ({
  intentFactory: (factory: Address, _a: Address, tokens: readonly Address[]) => Promise.resolve({
    core: factory === GLD_FACTORY ? GLD_CORE : CORE, mandateVersion: over.mandateVersion ?? 13, isCreator: over.isCreator ?? false, openCreation: over.openCreation ?? true,
    categories: tokens.map((t) => (t === NVDA ? 0 : t === MEME || t === SCHIFFY ? 1 : null)),
  }),
});
const gage = (over: Parameters<typeof fakeChain>[0] = {}, m: unknown = withMemes()) => {
  const chain = fakeChain({ ...factories(), ...over });
  return { chain, gage: gageFrom(ctx({ d: parseDeployment(m), chain })) };
};
type Args = [Record<string, unknown>, boolean, number, boolean, string];
const decoded = (data: Hex) => decodeFunctionData({ abi: factoryAbi, data }).args as unknown as Args;

describe("createVault", () => {
  it("answers one call from the curator: a free name, every stock its generation admits, the app's settings where none is named", async () => {
    const { chain, gage: g } = gage();
    const made = await g.createVault(input());
    expect(made).toMatchObject({ name: "Acme Stocks", curator: CURATOR, chainId: 46630, asset: { symbol: "USDG" }, factory: FACTORY, collateral: [{ symbol: "NVDAx" }], buysLoans: false, buysOnly: false });
    expect(made.calls).toHaveLength(1);
    expect(made.calls[0]).toMatchObject({ to: FACTORY, value: "0" });
    const [mandate, buys, extra, only, name] = decoded(made.calls[0]!.data);
    expect(mandate).toMatchObject({
      curator: getAddress(CURATOR), categoryWeights: [10_000, 0, 0, 10_000], assets: [getAddress(NVDA)], maxLoanTerm: 604_800, feeBps: 1_000, minGrade: 0, minRateGrade: 3,
      maxLoanPrincipal: 1_500_000_000n, maxAssetBps: 10_000, bufferBps: 0, executionCapBps: 2_000,
    });
    expect([buys, extra, only, name]).toEqual([false, 0, false, "Acme Stocks"]);
    // Simulated from the curator before anything is handed over.
    expect(chain.simulated).toEqual([{ from: CURATOR, to: FACTORY, data: made.calls[0]!.data, value: 0n }]);
  });

  it("answers the same call as a Safe's Transaction Builder file", async () => {
    const made = await gage().gage.createVault(input());
    expect(made.safeBatch.transactions.map((t) => [t.to, t.data, t.value])).toEqual([[getAddress(FACTORY), made.calls[0]!.data.toLowerCase(), "0"]]);
    expect(made.safeBatch.meta.checksum).toBe(batchChecksum(made.safeBatch));
    expect(made.safeBatch.meta.createdFromSafeAddress).toBe(getAddress(CURATOR));
  });

  it("takes the universe, the tokens and every setting a caller names", async () => {
    const memes = decoded((await gage().gage.createVault(input({ universe: "ecosystem", cashKeptFreeBps: 500, priorityFeeBps: 0, minRateGrade: 0, term: 1_814_400, feeBps: 500 }))).calls[0]!.data);
    expect(memes[0]).toMatchObject({ categoryWeights: [0, 10_000, 10_000, 0], assets: [getAddress(MEME)], bufferBps: 500, executionCapBps: 0, minRateGrade: 0, maxLoanTerm: 1_814_400, feeBps: 500 });
    // A universe is fixed for good: tokens of another one are refused, never taken over the universe named.
    expect(await code(gage().gage.createVault(input({ universe: "rwa", collateral: [MEME] })))).toBe("UNIVERSE_MISMATCH");
    expect(await code(gage().gage.createVault(input({ universe: "ecosystem", collateral: [NVDA] })))).toBe("UNIVERSE_MISMATCH");
    expect((await gage().gage.createVault(input({ universe: "ecosystem", collateral: [MEME] }))).collateral.map((t) => t.symbol)).toEqual(["MEMEx"]);
    const named = await gage().gage.createVault(input({ collateral: [MEME] }));
    expect(named.collateral.map((t) => t.symbol)).toEqual(["MEMEx"]);
    expect(decoded(named.calls[0]!.data)[0]).toMatchObject({ categoryWeights: [0, 10_000, 10_000, 0], assets: [getAddress(MEME)] });
  });

  it("makes a vault that buys running loans, or buys them only (mandate 13)", async () => {
    const both = decoded((await gage().gage.createVault(input({ buyLoans: { extraBps: 300 } }))).calls[0]!.data);
    expect([both[1], both[2], both[3]]).toEqual([true, 300, false]);
    const only = await gage().gage.createVault(input({ buyLoans: { extraBps: 300 }, buysOnly: true }));
    expect(only).toMatchObject({ buysLoans: true, buysOnly: true });
    expect(decoded(only.calls[0]!.data)[3]).toBe(true);
    expect(await code(gage().gage.createVault(input({ buysOnly: true })))).toBe("BUY_LOANS_NEEDED");
    // Before mandate 13 a factory has no such vault, and only USDG's vaults buy.
    const twelve = gage(factories({ mandateVersion: 12 })).gage;
    expect(await code(twelve.createVault(input({ buyLoans: { extraBps: 1 }, buysOnly: true })))).toBe("BUY_LOANS_CLOSED");
    expect(decodeFunctionData({ abi: factoryAbi, data: (await twelve.createVault(input())).calls[0]!.data }).args).toHaveLength(4);
    expect(await code(twelve.createVault(input({ asset: GLDX, buyLoans: { extraBps: 1 }, maxLoan: "1000000000000000000" })))).toBe("BUY_LOANS_CLOSED");
  });

  it("lends another asset on that asset's own factory, against what its generation admits", async () => {
    const made = await gage().gage.createVault(input({ asset: GLDX, maxLoan: "5000000000000000000" }));
    expect(made).toMatchObject({ factory: GLD_FACTORY, asset: { token: GLDX, symbol: "GLDx", decimals: 18 }, collateral: [{ symbol: "SCHIFFYx" }] });
    expect(decoded(made.calls[0]!.data)[0]).toMatchObject({ categoryWeights: [0, 10_000, 10_000, 0], assets: [getAddress(SCHIFFY)], maxLoanPrincipal: 5n * 10n ** 18n });
    // A stock's vault lends against memes alone, whatever is asked.
    expect(await code(gage().gage.createVault(input({ asset: GLDX, universe: "rwa", maxLoan: "1" })))).toBe("UNSUPPORTED_COLLATERAL");
    expect(await code(gage().gage.createVault(input({ asset: USDG }))).then(() => "ok")).toBe("ok");
    expect(await code(gage().gage.createVault(input({ asset: A(0xe1) })))).toBe("UNKNOWN_LEND_ASSET");
  });

  it("refuses what the factory would refuse, in fixed words", async () => {
    const g = gage().gage;
    expect(await code(g.createVault(input({ name: "" })))).toBe("INVALID_INPUT");
    expect(await code(g.createVault(input({ name: "bad\u0000name" })))).toBe("INVALID_INPUT");
    expect(await code(g.createVault(input({ name: "bad‮name" })))).toBe("INVALID_INPUT");
    expect(await code(g.createVault(input({ name: "   " })))).toBe("INVALID_INPUT");
    expect(await code(g.createVault(input({ name: "é".repeat(25) })))).toBe("NAME_TOO_LONG");
    expect(await code(g.createVault(input({ maxLoan: "1000000000000001" })))).toBe("MAX_LOAN_TOO_HIGH");
    expect(await code(g.createVault(input({ collateral: [SCHIFFY] })))).toBe("UNSUPPORTED_COLLATERAL");
    expect(await code(g.createVault(input({ collateral: [NVDA, MEME] })))).toBe("MIXED_COLLATERAL");
    expect(await code(g.createVault(input({ term: 86_400 })))).toBe("INVALID_INPUT");
    expect(await code(g.createVault(input({ feeBps: 400 })))).toBe("INVALID_INPUT");
    expect(await code(g.createVault(input({ priorityFeeBps: 5_001 })))).toBe("INVALID_INPUT");
    expect(await code(gage(factories({ openCreation: false })).gage.createVault(input()))).toBe("NOT_A_PARTNER");
    expect(await code(gage(factories({ openCreation: false, isCreator: true })).gage.createVault(input())).then(() => "ok")).toBe("ok");
    expect(await code(gage({ intentFactory: () => Promise.resolve({ core: A(0xbad), mandateVersion: 13, isCreator: true, openCreation: true, categories: [0] }) }).gage.createVault(input()))).toBe("FACTORY_CHANGED");
    expect(await code(gage({ simulate: () => Promise.reject(new ApiError("SIMULATION_FAILED", "x")) }).gage.createVault(input()))).toBe("SIMULATION_FAILED");
    // No token in its universe at all: the caller must name one.
    expect(await code(gage({ intentFactory: (_f: Address, _a: Address, tokens: readonly Address[]) => Promise.resolve({ core: CORE, mandateVersion: 13, isCreator: true, openCreation: true, categories: tokens.map(() => null) }) }).gage.createVault(input()))).toBe("UNSUPPORTED_COLLATERAL");
  });

  it("says when its name reads as one side of a pool", async () => {
    expect((await gage().gage.createVault(input())).notes.join(" ")).not.toMatch(/reads as one side of a pool/);
    expect((await gage().gage.createVault(input({ name: "Acme NVDA/USDG" }))).notes.join(" ")).toMatch(/reads as one side of a pool/);
  });
});

describe("the create_vault action", () => {
  const action = { action: "create_vault" as const, name: "Acme Stocks", term: 604_800 as const, feeBps: 1_000, maxLoan: "1500000000" };
  /** The factory's log of a vault created by this wallet, as its receipt carries it. */
  const created = (vault: Address): Log => ({
    address: FACTORY, topics: encodeEventTopics({ abi: factoryAbi, eventName: "VaultCreated", args: { vault, curator: CURATOR } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [CURATOR, 7n]), blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  });

  it("prepares the vault's call for the wallet, with its figures to draw", async () => {
    const p = await gage().gage.prepare({ ...action, wallet: CURATOR });
    expect(p).toMatchObject({ status: "ready", next: { label: "Create the vault", final: true, transaction: { to: FACTORY, from: CURATOR } }, then: [] });
    expect(p.view).toMatchObject({ action: "create_vault", name: "Acme Stocks", factory: FACTORY, maxLoan: "1500000000", feeBps: 1_000, term: 604_800, cashKeptFreeBps: 0, priorityFeeBps: 2_000, minRateGrade: 3, buysLoans: false, buysOnly: false });
    expect(p.summary.title).toBe('Create the partner vault "Acme Stocks"');
  });

  it("is carried out by run(), which answers the new vault's address from its receipt", async () => {
    const vault = A(0x777);
    const signer = fakeSigner();
    const chain = { sent: () => Promise.resolve({ from: CURATOR, to: FACTORY, input: "0x", success: true, logs: [created(vault)] }) };
    const r = await gage(chain).gage.run(action, signer);
    expect(r).toMatchObject({ status: "done", vault: getAddress(vault), loan: null });
    expect(signer.sent.map((t) => t.to)).toEqual([FACTORY]);
    // A receipt that names no vault of this wallet's answers none.
    const none = await gage({ sent: () => Promise.resolve(null) }).gage.run(action, fakeSigner());
    expect(none).toMatchObject({ status: "done", vault: null });
  });

  it("is served wherever a Gage serves actions, with its prepare and signed tools and a read that signs nothing", () => {
    const g = gage().gage;
    expect(g.actions).toContain("create_vault");
    const names = gageTools(g, { signer: fakeSigner() }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["gage_prepare_create_vault", "gage_create_vault"]));
    const read = poolVaultTools(g).find((t) => t.name === "gage_create_partner_vault");
    expect(read?.annotations.readOnlyHint).toBe(true);
  });
});
