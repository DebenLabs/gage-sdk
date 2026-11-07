/**
 * Park and unpark (D334): an out-of-range position pulled out on its own DEX into a partner vault, and a new one minted
 * from a vault's withdrawal, from the wallet itself. Each DEX's calls are held to the encoding the LP lane's adapters
 * send (contracts/src/lp/adapters) and to the selectors read from the contracts deployed on Robinhood Chain.
 */
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, maxUint128, parseAbi, toFunctionSelector, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { fablesLiquidityAbi, partnerVault4626Abi, partnerVaultAbi, permit2Abi, ramsesManagerAbi, v3ManagerAbi, v4ManagerAbi } from "../src/abi.js";
import type { DexPosition, FablesReceipts, V4Position } from "../src/chain.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { gageFrom } from "../src/client.js";
import { positionAmounts } from "../src/lp.js";
import { actionsOn } from "../src/networks.js";
import { holdingOf, mintFigures, PARK_DEADLINE, parkBatch, parkPoolFrom, parkPositions, V4_ACTION } from "../src/park.js";
import { prepareNext } from "../src/prepare.js";
import { run } from "../src/run.js";
import { gageTools } from "../src/tools.js";
import {
  A, assetManifest, CORE, ctx, FABLES_HOOK, FABLES_KEY, fakeChain, fakeSigner, fakeUpstream, GLD_CORE, GLD_VAULT, LP_PRICE, lpFablesManifest, lpFormatsManifest, manifest, NOW,
  NVDA, PERMIT2, RAMSES_NFPM, SUSHI_NFPM, UNI_NFPM, UNI_POOL, USDG, V4_ADAPTER, V4_KEY, V4_POOL_ID, V4_POSM, VAULT, WALLET, WETH,
} from "../src/testing.js";
import { poolId, sqrtPriceAtTick } from "../src/v4math.js";

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

/** The lane's pools with its switch off (D334 parks from them all the same), the release's WETH named. */
const hidden = () => ({ ...lpFormatsManifest({ public: false }), WETH });
const d = () => parseDeployment(hidden());

/** Positions around the fake pools' price (WETH at 2,500 USDG, tick −198,080; WETH is token0, USDG token1). */
const L = 10n ** 16n;
const BELOW_PRICE = { tickLower: -200_000, tickUpper: -199_000 }; // the price is above it: all USDG
const ABOVE_PRICE = { tickLower: -197_000, tickUpper: -196_000 }; // the price is under it: all WETH
const AROUND = { tickLower: -199_380, tickUpper: -197_370 };
const USDG_HELD = positionAmounts(LP_PRICE.sqrtPriceX96, BELOW_PRICE.tickLower, BELOW_PRICE.tickUpper, L).amount1;
const dex = (range: { tickLower: number; tickUpper: number }, over: Partial<DexPosition> = {}): DexPosition => ({ token0: WETH, token1: USDG, fee: 500, tickSpacing: null, ...range, liquidity: L, ...over });

/** A fake chain where the wallet holds `rows` at the managers named, `${manager}:${id}` (lower case). */
function chainWith(rows: Record<string, DexPosition>, v4: Record<string, V4Position> = {}, over: Parameters<typeof fakeChain>[0] = {}) {
  const ids = (m: Address) => Object.keys(rows).filter((k) => k.startsWith(m.toLowerCase())).map((k) => BigInt(k.split(":")[1]!));
  return fakeChain({
    ownedPositions: (m: Address) => Promise.resolve({ total: BigInt(ids(m).length), ids: ids(m), enumerable: true }),
    dexPositions: (m: Address, _r: boolean, list: readonly bigint[]) => Promise.resolve(list.map((id) => rows[`${m.toLowerCase()}:${id}`] ?? null)),
    v4Positions: (m: Address, list: readonly bigint[]) => Promise.resolve(list.map((id) => v4[`${m.toLowerCase()}:${id}`] ?? null)),
    ...over,
  });
}

const row = (address: Address, core: Address) => ({ address, creator: A(1), curator: A(1), core, categoryMask: 1, feeBps: 1000, maxLoanTerm: 1_814_400, assets: [NVDA], fundingEnabled: true });
/** gage's index: the USDG vault and GLDx's, a deposit's preview (or its refusal), an accounting, and the wallet's v4 position 77. */
function index(over: { refusal?: string | null; due?: boolean; mandateVersion?: number } = {}) {
  const version = over.mandateVersion === undefined ? {} : { mandateVersion: over.mandateVersion };
  return fakeUpstream({
    "/intent/partners/vaults?": { items: [{ ...row(VAULT, CORE), ...version }, { ...row(GLD_VAULT, GLD_CORE), ...version }], nextCursor: null },
    "/intent/partners/vaults/": (path: string) => {
      if (path.includes("/accounting")) return { status: 200, body: { pricing: { totalAssets: "1", totalSupply: "1", assetsPerShare: "1" }, liquidity: { free: "1" }, settlement: { due: over.due ?? false, settleable: ["3"] } } };
      if (path.includes("/position/")) return { status: 200, body: { shares: "1000000000000000000", value: "1000000", withdrawableNow: "1000000", rewards: "0", pockets: [] } };
      const kind = path.includes("deposit=") ? "DEPOSIT" : "REDEEM";
      return { status: 200, body: { kind, assets: "50000000", shares: "50000000000000000000", refusal: over.refusal ?? null, availableNow: null } };
    },
    "/lp/positions": { owner: WALLET, chainId: 46630, positions: [{ adapter: V4_ADAPTER, tokenId: "77" }], incomplete: false },
  });
}

const parking = (over: Record<string, unknown> = {}) => ({ action: "park" as const, wallet: WALLET, manager: UNI_NFPM, id: "5", vault: VAULT, ...over });
const decode = (data: Hex) => decodeFunctionData({ abi: v3ManagerAbi, data });

describe("park pools", () => {
  it("are the LP lane's whatever its switch, read straight from each DEX: a native v4 pool's ETH is its key's zero address", () => {
    const deployment = d();
    expect(deployment.lpLane).toBeNull();
    expect(deployment.parkPools.map((p) => [p.kind, p.manager])).toEqual([
      ["uniswap-v3", getAddress(UNI_NFPM)], ["ramses-v3", getAddress(RAMSES_NFPM)], ["uniswap-v3", getAddress(SUSHI_NFPM)], ["uniswap-v4", getAddress(V4_POSM)],
    ]);
    const v4 = deployment.parkPools[3]!;
    expect(v4).toMatchObject({ id: V4_POOL_ID, token0: zeroAddress, key: { ...V4_KEY, currency1: getAddress(USDG) }, indexedBy: getAddress(V4_ADAPTER) });
    expect(deployment.weth).toBe(getAddress(WETH));
  });

  it("are served, park and unpark with them, only where there is one", () => {
    expect(actionsOn(parseDeployment(manifest()))).not.toContain("park");
    expect(actionsOn(d())).toEqual(expect.arrayContaining(["park", "unpark"]));
    expect(gageFrom(ctx()).actions).not.toContain("park");
  });

  it("take a DEX's own, a hooked v4 pool by its key, checked", () => {
    const key = { currency0: A(0), currency1: USDG, fee: 0x800000, tickSpacing: 10, hooks: A(0x777) };
    const pool = parkPoolFrom({ kind: "uniswap-v4", name: "Zia ETH/USDG", manager: V4_POSM, key, stateView: A(0x90) });
    expect(pool).toMatchObject({ kind: "uniswap-v4", id: poolId(key), token0: zeroAddress, stateView: getAddress(A(0x90)), indexedBy: null });
    expect(() => parkPoolFrom({ kind: "uniswap-v4", name: "x", manager: V4_POSM, key: { ...key, currency0: USDG, currency1: A(0) }, stateView: A(0x90) })).toThrow(/currency0 sorts before/);
    expect(() => parkPoolFrom({ kind: "fables", name: "x", manager: V4_POSM, key, stateView: A(0x90) })).toThrow(/manager is its hook/);
    expect(() => parkPoolFrom({ kind: "uniswap-v3", name: "x", manager: UNI_NFPM, pool: UNI_POOL, token0: USDG, token1: WETH, fee: 500, tickSpacing: 10 })).toThrow(/token0 sorts before/);
  });
});

describe("a wallet's out-of-range positions", () => {
  it("lists each one with the token it holds and the vaults that take it, counts those in range, and says ETH does not park", async () => {
    const chain = chainWith(
      { [`${UNI_NFPM}:5`]: dex(BELOW_PRICE), [`${UNI_NFPM}:6`]: dex(AROUND), [`${SUSHI_NFPM}:9`]: dex(ABOVE_PRICE) },
      { [`${V4_POSM}:77`]: { key: V4_KEY, ...BELOW_PRICE, liquidity: L } },
    );
    const r = await parkPositions(ctx({ d: d(), chain, indexer: index() }), WALLET);
    expect(r.inRange).toBe(1);
    expect(r.positions.map((p) => [p.kind, p.id, p.holds.symbol, p.holds.amount, p.refusal])).toEqual([
      ["uniswap-v3", "5", "USDG", USDG_HELD.toString(), null],
      ["uniswap-v3", "9", "TOKEN", expect.any(String), "ETH_NOT_SUPPORTED"],
      ["uniswap-v4", "77", "USDG", USDG_HELD.toString(), null],
    ]);
    expect(r.positions[0]!.vaults.map((v) => v.vault)).toEqual([getAddress(VAULT)]);
    expect(r.positions[0]).toMatchObject({ parkable: true, tick: LP_PRICE.tick, ...BELOW_PRICE });
    expect(r.note).toMatch(/no gage vault takes ETH yet/);
  });

  it("reads a v4 position a DEX names that gage's index does not, and only the wallet's", async () => {
    const chain = chainWith({}, { [`${V4_POSM}:88`]: { key: V4_KEY, ...BELOW_PRICE, liquidity: L } }, {
      positionOwners: (_m: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => (id === 88n ? WALLET : A(0x999)))),
    });
    const r = await parkPositions(ctx({ d: d(), chain, indexer: index() }), WALLET, [{ manager: V4_POSM, id: "88" }]);
    expect(r.positions.map((p) => p.id)).toEqual(["88"]);
  });
});

describe("parking, per DEX, pulls a position out as the LP lane's adapters do", () => {
  it("Uniswap v3: decreaseLiquidity of all of it, its USDG the minimum, collect of everything owed, then the deposit", async () => {
    const chain = chainWith({ [`${UNI_NFPM}:5`]: dex(BELOW_PRICE) });
    const b = await parkBatch(ctx({ d: d(), chain, indexer: index() }), parking());
    expect(b.calls.map((x) => x.label)).toEqual(["Pull position #5 out", "Collect position #5", "Approve USDG", "Deposit"]);
    expect(b.calls.every((x) => x.value === 0n)).toBe(true);
    const deadline = BigInt(NOW + PARK_DEADLINE);
    // The adapter's own encoding (IPositionManagerParams), selector for selector.
    const adapter = parseAbi([
      "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params)",
      "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)",
    ]);
    expect(b.calls[0]).toMatchObject({ to: UNI_NFPM, data: encodeFunctionData({ abi: adapter, functionName: "decreaseLiquidity", args: [{ tokenId: 5n, liquidity: L, amount0Min: 0n, amount1Min: USDG_HELD, deadline }] }) });
    expect(b.calls[1]!.data).toBe(encodeFunctionData({ abi: adapter, functionName: "collect", args: [{ tokenId: 5n, recipient: WALLET, amount0Max: maxUint128, amount1Max: maxUint128 }] }));
    expect(b.calls[0]!.data.slice(0, 10)).toBe("0x0c49ccbe");
    expect(b.calls[1]!.data.slice(0, 10)).toBe("0xfc6f7865");
    expect(decodeFunctionData({ abi: erc20Abi, data: b.calls[2]!.data }).args).toEqual([VAULT, USDG_HELD]);
    // An earlier generation's vault: its slippage-held deposit, the preview's shares less 0.5%.
    expect(b.calls[3]!.data.slice(0, 10)).toBe(toFunctionSelector("deposit(uint256,uint256)"));
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: b.calls[3]!.data }).args).toEqual([USDG_HELD, 50n * 10n ** 18n - (50n * 10n ** 18n * 50n) / 10_000n]);
    expect(b.view).toMatchObject({ action: "park", amount: USDG_HELD.toString(), token: USDG, symbol: "USDG", vault: VAULT });
  });

  it("a native ERC-4626 vault takes deposit(assets, receiver)", async () => {
    const chain = chainWith({ [`${UNI_NFPM}:5`]: dex(BELOW_PRICE) }, {}, { vaultMaxWithdraw: () => Promise.resolve(0n) });
    const b = await parkBatch(ctx({ d: d(), chain, indexer: index() }), parking());
    expect(b.calls[3]!.data.slice(0, 10)).toBe("0x6e553f65");
    expect(decodeFunctionData({ abi: partnerVault4626Abi, data: b.calls[3]!.data }).args).toEqual([USDG_HELD, WALLET]);
  });

  it("Uniswap v4: one modifyLiquidities, DECREASE_LIQUIDITY then TAKE_PAIR to the wallet, a native pool's ETH as ETH", async () => {
    const chain = chainWith({}, { [`${V4_POSM}:77`]: { key: V4_KEY, ...BELOW_PRICE, liquidity: L } });
    const b = await parkBatch(ctx({ d: d(), chain, indexer: index() }), parking({ manager: V4_POSM, id: "77" }));
    expect(b.calls.map((x) => x.label)).toEqual(["Pull position #77 out", "Approve USDG", "Deposit"]);
    const { args } = decodeFunctionData({ abi: v4ManagerAbi, data: b.calls[0]!.data });
    expect(b.calls[0]!.data.slice(0, 10)).toBe("0xdd46508f");
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], args[0] as Hex);
    expect(actions).toBe("0x0111");
    // UniV4PositionAdapter: abi.encode(tokenId, liquidity, min0, min1, bytes("")) and abi.encode(currency0, currency1, recipient).
    expect(params[0]).toBe(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [77n, L, 0n, USDG_HELD, "0x"]));
    expect(params[1]).toBe(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [zeroAddress, getAddress(USDG), WALLET]));
    expect(args[1]).toBe(BigInt(NOW + PARK_DEADLINE));
  });

  it("Ramses: the same pull as Uniswap's, but only three minutes after the position's last liquidity change", async () => {
    const rows = { [`${RAMSES_NFPM}:3`]: dex(BELOW_PRICE, { fee: null, tickSpacing: 1 }) };
    const soon = chainWith(rows, {}, { ramsesLastModified: () => Promise.resolve(NOW - 100) });
    const wait = await parkBatch(ctx({ d: d(), chain: soon, indexer: index() }), parking({ manager: RAMSES_NFPM, id: "3" })).then(() => null, (e: unknown) => e as ApiError);
    expect(wait).toMatchObject({ code: "RAMSES_WAIT", retryable: true });
    expect(wait?.message).toMatch(new Date((NOW + 80) * 1000).toISOString());
    const b = await parkBatch(ctx({ d: d(), chain: chainWith(rows), indexer: index() }), parking({ manager: RAMSES_NFPM, id: "3" }));
    expect(decode(b.calls[0]!.data)).toMatchObject({ functionName: "decreaseLiquidity", args: [{ tokenId: 3n, liquidity: L, amount0Min: 0n, amount1Min: USDG_HELD }] });
    expect(decode(b.calls[1]!.data)).toMatchObject({ functionName: "collect" });
    expect(b.notes.join(" ")).toMatch(/pays its rewards to the wallet/);
  });

  it("Fables: the hook's withdraw of the wallet's receipts, their USDG the minimum", async () => {
    const receipts: FablesReceipts = { shares: L, staked: 0n, allowance: 0n, operator: false, paused: false, key: FABLES_KEY, ...BELOW_PRICE, set: true };
    const chain = fakeChain({ fablesReceipts: () => Promise.resolve(receipts) });
    const b = await parkBatch(ctx({ d: parseDeployment({ ...lpFablesManifest({ public: false }), WETH }), chain, indexer: index() }), parking({ manager: FABLES_HOOK, id: "777" }));
    expect(b.calls.map((x) => x.label)).toEqual(["Withdraw the Fables receipts", "Approve USDG", "Deposit"]);
    expect(b.calls[0]!.data.slice(0, 10)).toBe("0xa2ba1fc8");
    const { args } = decodeFunctionData({ abi: fablesLiquidityAbi, data: b.calls[0]!.data });
    expect(args).toEqual([{ ...FABLES_KEY, currency1: getAddress(USDG), hooks: getAddress(FABLES_HOOK) }, BELOW_PRICE.tickLower, BELOW_PRICE.tickUpper, L, WALLET, 0n, USDG_HELD, BigInt(NOW + PARK_DEADLINE)]);
    expect(b.summary.rows.find((r) => r.label === "Its fees")?.value).toBe("Stay claimable on Fables");
  });
});

describe("parking refuses", () => {
  const with5 = (range: { tickLower: number; tickUpper: number }) => chainWith({ [`${UNI_NFPM}:5`]: dex(range) });
  it("a position in range, which earns fees", async () => {
    expect(await code(parkBatch(ctx({ d: d(), chain: with5(AROUND), indexer: index() }), parking()))).toBe("IN_RANGE");
  });
  it("one that holds ETH, which no gage vault takes yet", async () => {
    expect(await code(parkBatch(ctx({ d: d(), chain: with5(ABOVE_PRICE), indexer: index() }), parking()))).toBe("ETH_NOT_SUPPORTED");
  });
  it("a vault that takes another token than the position holds", async () => {
    const both = parseDeployment({ ...assetManifest(), WETH, lpLane: lpFormatsManifest({ public: false }).lpLane });
    expect(await code(parkBatch(ctx({ d: both, chain: with5(BELOW_PRICE), indexer: index() }), parking({ vault: GLD_VAULT })))).toBe("VAULT_ASSET_MISMATCH");
  });
  it("another wallet's position, and a manager gage parks no pool at", async () => {
    expect(await code(parkBatch(ctx({ d: d(), chain: chainWith({ [`${UNI_NFPM}:5`]: dex(BELOW_PRICE) }, {}, { positionOwner: () => Promise.resolve(A(0x999)) }), indexer: index() }), parking()))).toBe("NOT_OWNER");
    expect(await code(parkBatch(ctx({ d: d(), chain: with5(BELOW_PRICE), indexer: index() }), parking({ manager: A(0x4444) })))).toBe("UNKNOWN_POOL");
  });
  it("and settles a vault due a settlement first, to be planned again", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: with5(BELOW_PRICE), indexer: index({ refusal: "SETTLEMENT_DUE" }) }), parking());
    expect(b.again).toBe(true);
    expect(b.calls.map((x) => x.label)).toEqual(["Settle the vault's loans"]);
  });
});

describe("unparking", () => {
  const unparking = (over: Record<string, unknown> = {}) => ({ action: "unpark" as const, wallet: WALLET, vault: VAULT, manager: UNI_NFPM, pool: UNI_POOL, ...BELOW_PRICE, ...over });
  const native = (most = 5_000_000_000n, over: Parameters<typeof fakeChain>[0] = {}) => fakeChain({ vaultMaxWithdraw: () => Promise.resolve(most), ...over });

  it("withdraws all the vault can pay, then mints a range below the price from USDG alone", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: native(), indexer: index() }), unparking());
    expect(b.calls.map((x) => x.label)).toEqual(["Withdraw 5,000.00 USDG", "Approve USDG", "Open the new Uniswap v3 WETH/USDG 0.05% position"]);
    expect(b.calls[0]!.data.slice(0, 10)).toBe("0xb460af94");
    expect(decodeFunctionData({ abi: partnerVault4626Abi, data: b.calls[0]!.data }).args).toEqual([5_000_000_000n, WALLET, WALLET]);
    expect(decodeFunctionData({ abi: erc20Abi, data: b.calls[1]!.data }).args).toEqual([UNI_NFPM, 5_000_000_000n]);
    expect(b.calls[2]!.data.slice(0, 10)).toBe("0x88316456");
    expect(decode(b.calls[2]!.data).args[0]).toEqual({
      token0: getAddress(WETH), token1: getAddress(USDG), fee: 500, ...BELOW_PRICE, amount0Desired: 0n, amount1Desired: 5_000_000_000n,
      amount0Min: 0n, amount1Min: 5_000_000_000n - 25_000_000n, recipient: WALLET, deadline: BigInt(NOW + PARK_DEADLINE),
    });
    expect(b.view).toMatchObject({ action: "unpark", amount: "5000000000", other: null, tickLower: BELOW_PRICE.tickLower });
    expect(b.notes.join(" ")).toMatch(/waits on the vault's free cash/);
  });

  it("around the price takes WETH too, from the wallet, approved exactly", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: native(), indexer: index() }), unparking({ ...AROUND, amount: "1000000000" }));
    const m = mintFigures(LP_PRICE.sqrtPriceX96, AROUND.tickLower, AROUND.tickUpper, false, 1_000_000_000n)!;
    expect(m.around).toBe(true);
    expect(b.calls.map((x) => x.label)).toEqual(["Withdraw 1,000.00 USDG", "Approve USDG", "Approve TOKEN", "Open the new Uniswap v3 WETH/USDG 0.05% position"]);
    expect(decodeFunctionData({ abi: erc20Abi, data: b.calls[2]!.data }).args).toEqual([UNI_NFPM, m.other]);
    expect(decode(b.calls[3]!.data).args[0]).toMatchObject({ amount0Desired: m.other, amount1Desired: 1_000_000_000n, amount0Min: m.other - (m.other * 50n) / 10_000n });
    expect(b.view).toMatchObject({ other: { token: getAddress(WETH), amount: m.other.toString() } });
  });

  it("into Uniswap v4: Permit2 approvals, MINT_POSITION, SETTLE_PAIR and SWEEP, the native ETH sent along", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: native(), indexer: index() }), unparking({ manager: V4_POSM, pool: V4_POOL_ID, ...AROUND, amount: "1000000000" }));
    expect(b.calls.map((x) => x.label)).toEqual(["Withdraw 1,000.00 USDG", "Approve USDG to Permit2", "Let the position manager take USDG", "Open the new ETH / USDG v4 0.05% position"]);
    expect(decodeFunctionData({ abi: erc20Abi, data: b.calls[1]!.data }).args).toEqual([PERMIT2, 1_000_000_000n]);
    expect(b.calls[2]!.data.slice(0, 10)).toBe("0x87517c45");
    expect(decodeFunctionData({ abi: permit2Abi, data: b.calls[2]!.data }).args).toEqual([getAddress(USDG), V4_POSM, 1_000_000_000n, NOW + PARK_DEADLINE]);
    const m = mintFigures(LP_PRICE.sqrtPriceX96, AROUND.tickLower, AROUND.tickUpper, false, 1_000_000_000n)!;
    const [unlock] = decodeFunctionData({ abi: v4ManagerAbi, data: b.calls[3]!.data }).args as [Hex, bigint];
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], unlock);
    expect(actions).toBe(`0x${[V4_ACTION.MINT_POSITION, V4_ACTION.SETTLE_PAIR, V4_ACTION.SWEEP].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
    const mint = decodeAbiParameters([
      { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] },
      { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" },
    ], params[0]!);
    // The liquidity cut by the slippage room, its ETH at most what the full liquidity takes now, sent as value.
    expect(mint.slice(1)).toEqual([AROUND.tickLower, AROUND.tickUpper, m.liquidity - (m.liquidity * 50n) / 10_000n, m.other, 1_000_000_000n, WALLET, "0x"]);
    expect(params[2]).toBe(encodeAbiParameters([{ type: "address" }, { type: "address" }], [zeroAddress, WALLET]));
    expect(b.calls[3]!.value).toBe(m.other);
  });

  it("into Ramses: its mint by tick spacing", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: native(), indexer: index() }), unparking({ manager: RAMSES_NFPM, pool: (d().parkPools[1]!.id) }));
    expect(b.calls[2]!.data.slice(0, 10)).toBe("0x6d70c415");
    expect(decodeFunctionData({ abi: ramsesManagerAbi, data: b.calls[2]!.data }).args[0]).toMatchObject({ tickSpacing: 1, amount1Desired: 5_000_000_000n });
  });

  it("from an earlier generation's vault: earn_redeem's redemption, then the mint with what it pays", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: fakeChain(), indexer: index() }), unparking());
    expect(b.calls[0]!.label).toBe("Withdraw");
    expect(decodeFunctionData({ abi: partnerVaultAbi, data: b.calls[0]!.data }).functionName).toBe("redeem");
    expect(decode(b.calls[2]!.data).args[0]).toMatchObject({ amount1Desired: 50_000_000n });
  });

  it("refuses a range that holds only WETH, ticks off the spacing, a vault the pool does not pair, and an empty or short vault", async () => {
    const c = (chain = native()) => ctx({ d: parseDeployment({ ...assetManifest(), WETH, lpLane: lpFormatsManifest({ public: false }).lpLane }), chain, indexer: index() });
    expect(await code(parkBatch(c(), unparking(ABOVE_PRICE)))).toBe("RANGE_WITHOUT_ASSET");
    expect(await code(parkBatch(c(), unparking({ tickLower: -200_005 })))).toBe("INVALID_RANGE");
    expect(await code(parkBatch(c(), unparking({ vault: GLD_VAULT })))).toBe("VAULT_ASSET_NOT_IN_POOL");
    expect(await code(parkBatch(c(native(0n)), unparking()))).toBe("NOTHING_TO_WITHDRAW");
    expect(await code(parkBatch(c(), unparking({ amount: "6000000000" })))).toBe("INSUFFICIENT_LIQUIDITY");
  });

  it("settles a vault due a settlement first", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: native(0n), indexer: index({ due: true }) }), unparking());
    expect(b).toMatchObject({ again: true, calls: [{ label: "Settle the vault's loans" }] });
  });
});

describe("the arithmetic", () => {
  it("out of range, a position holds one token, exactly what the pull returns; in range, both", () => {
    expect(holdingOf({ ...BELOW_PRICE, liquidity: L }, LP_PRICE.sqrtPriceX96)).toMatchObject({ inRange: false, side: 1, amount: USDG_HELD, amount0: 0n });
    expect(holdingOf({ ...ABOVE_PRICE, liquidity: L }, LP_PRICE.sqrtPriceX96)).toMatchObject({ inRange: false, side: 0, amount1: 0n });
    expect(holdingOf({ ...AROUND, liquidity: L }, LP_PRICE.sqrtPriceX96)).toMatchObject({ inRange: true, side: null });
  });

  it("a new position never takes more of the vault's asset than was withdrawn, and the other side what the price asks", () => {
    for (const range of [BELOW_PRICE, AROUND]) {
      const m = mintFigures(LP_PRICE.sqrtPriceX96, range.tickLower, range.tickUpper, false, 1_234_567_890n)!;
      const back = positionAmounts(LP_PRICE.sqrtPriceX96, range.tickLower, range.tickUpper, m.liquidity);
      expect(back.amount1).toBeLessThanOrEqual(1_234_567_890n);
      expect(back.amount1).toBeGreaterThan(1_234_567_890n - 1_000n);
      expect(back.amount0).toBeLessThanOrEqual(m.other);
    }
    expect(mintFigures(LP_PRICE.sqrtPriceX96, ABOVE_PRICE.tickLower, ABOVE_PRICE.tickUpper, false, 10n ** 9n)).toBeNull();
    expect(mintFigures(LP_PRICE.sqrtPriceX96, ABOVE_PRICE.tickLower, ABOVE_PRICE.tickUpper, true, 10n ** 18n)).toMatchObject({ around: false, other: 0n });
    expect(sqrtPriceAtTick(BELOW_PRICE.tickUpper)).toBeLessThan(LP_PRICE.sqrtPriceX96);
  });
});

describe("sending a park", () => {
  const c = () => ctx({ d: d(), chain: chainWith({ [`${UNI_NFPM}:5`]: dex(BELOW_PRICE) }), indexer: index() });

  it("refuses a batch the chain says would revert, naming the call", async () => {
    const chain = chainWith({ [`${UNI_NFPM}:5`]: dex(BELOW_PRICE) }, {}, { simulateCalls: (_f: Address, calls: readonly unknown[]) => Promise.resolve(calls.map((_, n) => n !== 3)) });
    const e = await parkBatch(ctx({ d: d(), chain, indexer: index() }), parking()).then(() => null, (x: unknown) => x as ApiError);
    expect(e).toMatchObject({ code: "SIMULATION_FAILED" });
    expect(e?.message).toMatch(/^Deposit would revert now/);
  });

  it("prepares every transaction at once, built from one reading", async () => {
    const p = await prepareNext(c(), parking());
    expect(p.next).toMatchObject({ label: "Pull position #5 out", final: false });
    expect(p.calls?.map((x) => x.label)).toEqual(["Pull position #5 out", "Collect position #5", "Approve USDG", "Deposit"]);
    expect(p.calls?.[3]).toMatchObject({ final: true, transaction: { from: WALLET, to: VAULT, value: "0", chainId: 46630 } });
  });

  it("is carried out by run(), each transaction in order", async () => {
    const signer = fakeSigner();
    const r = await run(c(), parking(), signer);
    expect(r.status).toBe("done");
    expect(r.sent.map((s) => s.label)).toEqual(["Pull position #5 out", "Collect position #5", "Approve USDG", "Deposit"]);
    expect(signer.sent.map((t) => t.to)).toEqual([UNI_NFPM, UNI_NFPM, USDG, VAULT]);
  });

  it("is served to agents: the read, and a prepare and a signed run for park and unpark", async () => {
    const gage = gageFrom(c());
    const names = gageTools(gage, { signer: fakeSigner() }).map((t) => t.name).filter((n) => /park/.test(n));
    expect(names).toEqual(["gage_park_positions", "gage_prepare_park", "gage_prepare_unpark", "gage_park", "gage_unpark"]);
    const caps = await gage.capabilities();
    expect(caps.parkPools).toHaveLength(4);
    expect(caps.actions).toContain("unpark");
  });
});

/**
 * A partner vault's deposit, withdrawal or settle claims for each open reward record or loan it books, which an estimate
 * taken in the second of another checkpoint misses (src/gas.ts). A caller sending a batch's calls one by one has no other
 * way to learn that floor. A mainnet fork, 6 November 2026: an unpark's withdrawal sent with its estimate alone, 686,426,
 * ran out of gas; the same withdrawal took 946,605.
 */
describe("a batch's calls say what each adds to its estimate", () => {
  const floor = (records: bigint) => 250_000n * (records + 2n);
  const FULL_BOOK = floor(64n);
  const six = { storageAt: () => Promise.resolve(6n) };
  const held = chainWith({ [`${UNI_NFPM}:5`]: dex(BELOW_PRICE) }, {}, six);
  const unparking = { action: "unpark" as const, wallet: WALLET, vault: VAULT, manager: UNI_NFPM, pool: UNI_POOL, ...BELOW_PRICE };
  const paying = { vaultMaxWithdraw: () => Promise.resolve(5_000_000_000n) };
  const counted = (over: Parameters<typeof index>[0] = {}) => index({ mandateVersion: 12, ...over });

  it("a park's deposit its vault's floor, the DEX's calls and the approval nothing", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: held, indexer: counted() }), parking());
    expect(b.calls.map((x) => [x.label, x.extraGas])).toEqual([["Pull position #5 out", 0n], ["Collect position #5", 0n], ["Approve USDG", 0n], ["Deposit", floor(6n)]]);
  });

  it("an unpark's withdrawal its vault's floor, the approval and the mint nothing", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: fakeChain({ ...paying, ...six }), indexer: counted() }), unparking);
    expect(b.calls.map((x) => x.extraGas)).toEqual([floor(6n), 0n, 0n]);
    expect(b.calls[0]!.data.slice(0, 10)).toBe("0xb460af94");
  });

  it("an earlier generation's redemption too", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: fakeChain(six), indexer: counted() }), unparking);
    expect(b.calls[0]!.label).toBe("Withdraw");
    expect(b.calls.map((x) => x.extraGas)).toEqual([floor(6n), 0n, 0n]);
  });

  it("a settlement that comes first, for each loan it books", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: held, indexer: counted({ refusal: "SETTLEMENT_DUE" }) }), parking());
    expect(b.again).toBe(true);
    expect(b.calls.map((x) => [x.label, x.extraGas])).toEqual([["Settle the vault's loans", floor(1n)]]);
  });

  it("a full book's when the count cannot be read", async () => {
    const b = await parkBatch(ctx({ d: d(), chain: held, indexer: index() }), parking());
    expect(b.calls[3]!.extraGas).toBe(FULL_BOOK);
  });

  it("prepare's calls the same, as strings, beside the transaction a wallet takes", async () => {
    const p = await prepareNext(ctx({ d: d(), chain: held, indexer: counted() }), parking());
    expect(p.calls?.map((x) => x.extraGas)).toEqual(["0", "0", "0", String(floor(6n))]);
    expect(Object.keys(p.calls![3]!.transaction).sort()).toEqual(["chainId", "data", "from", "to", "value"]);
  });
});
