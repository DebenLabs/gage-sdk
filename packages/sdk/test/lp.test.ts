/**
 * The LP lane (docs/api.md "LP lane", D314, D315): fixed-cost USDG loans against Uniswap v3, SushiSwap v3 and Ramses V3
 * WETH/USDG positions and Uniswap v4 ETH/USDG ones, through the lane's own core, registry and vaults. The fixture
 * (`lpManifest`) publishes the lane with one vault, a Uniswap v3 and a Ramses adapter and a WETH/USDG pool under each
 * (`lpFormatsManifest` adds a SushiSwap v3 and a Uniswap v4 adapter, each with its pool); the fake chain holds WETH at
 * 2,500 USDG, the wallet's position #1469882 around that price, no loan yet, and the rates service's quote
 * (`lpQuoteRoute`) lends 1,000 USDG repaying 1,006 against 2,000 USDG of value, at the registry's 0.35% fee.
 */
import { existsSync } from "node:fs";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Address, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { fablesHookAbi, fablesWrapperAbi, lpCoreAbi, lpVaultAbi, lpCompanionAbi, lpVaultFactoryAbi, positionManagerAbi } from "../src/abi.js";
import type { Call, Chain, FablesReceipts, LpLoan } from "../src/chain.js";
import { gageFrom } from "../src/client.js";
import { parseDeployment, parseLpLane } from "../src/deployment.js";
import { MAINNET_MANIFEST } from "../src/deployments/mainnet.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { ApiError, refusalOf } from "../src/errors.js";
import { costCeiling, costWithin, LP_RULE, lpLoans, lpPositions, lpQuote, lpVaults, MAX_LP_LOANS, positionAmounts, valueInUsdg } from "../src/lp.js";
import { PARK_RULE } from "../src/park.js";
import { actionsOn } from "../src/networks.js";
import { plan } from "../src/plans.js";
import { prepareNext } from "../src/prepare.js";
import { capabilities, portfolio, RULES } from "../src/reads.js";
import { run } from "../src/run.js";
import type { View } from "../src/plans.js";
import { gageTools } from "../src/tools.js";
import {
  A, ctx, FACTORY_VAULT, LP_CURATOR, POOL, LP_FACTORY, lpStockManifest, NVDA, NVDA_POOL, SPY, SPY_POOL, FABLES_ADAPTER, FABLES_HOOK, FABLES_KEY, FABLES_POOL, FABLES_RANGE, FABLES_WRAPPER, fakeChain, fakeSigner, fakeUpstream, LP_CORE, LP_ESCROW, LP_FACTS, LP_PRICE, LP_REG,
  LP_BRIDGE, LP_COMPANION, LP_RESERVE_STATE, LP_RESERVE_TOKEN, LP_RESERVE_VAULT_STATE, LP_VAULT, LP_VAULT_STATE, lpFablesManifest, lpFormatsManifest, lpLoan, lpManifest, lpQuoteRoute, lpRewardsManifest, manifest,
  NOW, OTHER, RAM, RAMSES_ADAPTER, RAMSES_FACTORY, RAMSES_NFPM, RAMSES_POOL, STATE_VIEW, SUSHI_ADAPTER, SUSHI_FACTORY, SUSHI_NFPM, SUSHI_POOL, UNI_ADAPTER, UNI_FACTORY, UNI_NFPM,
  UNI_POOL, USDG, V4_ADAPTER, V4_POOL, V4_POOL_ID, V4_POOL_MANAGER, V4_POSM, WALLET, WETH,
} from "../src/testing.js";
import type { Upstream } from "../src/upstream.js";
/** The testnet's LP lane, once public: the bundled release drops a hidden one (sync-deployment). */
const TESTNET_LP = Boolean((TESTNET_MANIFEST as unknown as { lpLane?: { public?: boolean } }).lpLane?.public);

const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return refusalOf(e); } };
const d = () => parseDeployment(lpManifest());
const rates = (over: Parameters<typeof lpQuoteRoute>[0] = {}) => fakeUpstream({ "/lp/quote/": lpQuoteRoute(over) });
/** A rates route whose quote body a test edits before it is answered. */
const edited = (edit: (body: { quote: Record<string, unknown>; terms: Record<string, unknown>; valuation: Record<string, unknown>; expiresAt: number }) => void) =>
  fakeUpstream({ "/lp/quote/": (path: string) => { const r = lpQuoteRoute()(path) as { status: number; body: Parameters<typeof edit>[0] }; edit(r.body); return r; } });
const lc = (over: { chain?: Chain; rates?: Upstream; indexer?: Upstream } = {}) => ctx({ d: d(), ...over });
const ID = "1469882";
const usdgRef = { token: USDG, symbol: "USDG", decimals: 6 };
const wethRef = { token: WETH, symbol: "TOKEN", decimals: 18 };
/** The fixture position's figures at 2,500 USDG a WETH: 7.0047 WETH and 31,621.64 USDG, worth 49,133.49 USDG. */
const AMOUNT0 = 7_004_737_249_814_534_707n, AMOUNT1 = 31_621_644_497n, VALUE = 49_133_487_621n;

describe("the LP lane in a deployment", () => {
  it("is read from the release's lpLane block, its addresses checksummed, while its switch is on", () => {
    const lane = d().lpLane!;
    expect(lane).toMatchObject({ startBlock: 1, core: getAddress(LP_CORE), registry: getAddress(LP_REG), vaults: [{ address: getAddress(LP_VAULT), name: "WETH/USDG LP lane" }] });
    expect(lane.adapters.map((a) => [a.kind, a.address, a.positionManager])).toEqual([["uniswap-v3", getAddress(UNI_ADAPTER), getAddress(UNI_NFPM)], ["ramses-v3", getAddress(RAMSES_ADAPTER), getAddress(RAMSES_NFPM)]]);
    expect(lane.pools.map((p) => [p.name, p.pool, p.fee, p.tickSpacing])).toEqual([["Uniswap v3 WETH/USDG 0.05%", getAddress(UNI_POOL), 500, 10], ["Ramses WETH/USDG", getAddress(RAMSES_POOL), 125, 1]]);
    expect(lane.executors.map((e) => [e.kind, e.token, e.pools.length])).toEqual([["one-pool", getAddress(WETH), 1], ["two-hop", getAddress(RAM), 2]]);
  });

  it("is none where the release names no lane or keeps it hidden; each bundled release serves its lane once public, mainnet's since 5 November 2026", () => {
    expect(parseDeployment(manifest()).lpLane).toBeNull();
    expect(parseDeployment(lpManifest({ public: false })).lpLane).toBeNull();
    // The testnet's lane while public (its first from 22 October 2026, D331's replacement from 24 October 2026, the one
    // serving Fables from 29 October 2026): a v3 pool, and native v4 and Fables pools whose ETH is booked as a WETH that
    // sorts above USDG (the order the readers take since #762). Hidden, the bundled release names none.
    const testnetLane = parseDeployment(TESTNET_MANIFEST).lpLane;
    if (TESTNET_LP) expect(testnetLane!.pools.map((p) => [p.native, BigInt(p.token0) > BigInt(p.token1)])).toEqual([[false, false], [true, true], [true, true]]);
    else expect(testnetLane).toBeNull();
    // Mainnet's lane (r13, deployed 4 November 2026), public since the founders' go-live (5 November 2026): its twelve pools,
    // the six WETH/USDG v3-style ones (Ouro v3's two since 6 November 2026, D450, at the list's end), the native v4 and Fables ETH/USDG pools, and the four stock pools; no vault of its
    // own, every vault a curator's through its factory (D319).
    const mainnetLane = (MAINNET_MANIFEST as unknown as { lpLane?: { public?: boolean } }).lpLane;
    expect(mainnetLane?.public).toBe(true);
    const lane = parseDeployment(MAINNET_MANIFEST).lpLane!;
    expect(lane.adapters.map((a) => a.kind)).toEqual(["uniswap-v3", "ramses-v3", "uniswap-v3", "uniswap-v4", "fables", "uniswap-v3"]);
    expect(lane.pools.map((p) => [p.name, p.native])).toEqual([
      ["Ramses WETH/USDG", false], ["Uniswap v3 WETH/USDG 0.05%", false], ["Uniswap v3 WETH/USDG 0.01%", false], ["SushiSwap v3 WETH/USDG 0.05%", false],
      ["Uniswap v4 ETH/USDG 0.05%", true], ["Fables ETH/USDG", true],
      ["Uniswap v3 NVDA/USDG 0.05%", false], ["Uniswap v4 SPY/USDG 0.3%", false], ["Uniswap v3 GLD/USDG 0.3%", false], ["Uniswap v3 GLD/USDG 0.05%", false],
      ["Ouro v3 WETH/USDG 0.3%", false], ["Ouro v3 WETH/USDG 1%", false],
    ]);
    // Moved to reserve vaults on 7 November 2026 (D454): the new factory and the bridge, the first factory retired and its one
    // vault, RWA LP, named.
    expect([lane.vaults, lane.vaultFactory, lane.retiredVaultFactories, lane.rewardsBridge]).toEqual([
      [{ address: getAddress("0x591c09B854cd50c660c399A37d4E524f4dCc6F34"), name: "RWA LP" }], getAddress("0xe40737DdbeaeaA7d8d7cF5Af2BB62e8dB5aa40Ab"),
      [getAddress("0xDDd6afeA325F20Bba4Df0A5a7DB307524bbcbF77")], getAddress("0xF25BFD4DA8451B1220AF7A49aaB24E1Cf72593B7"),
    ]);
  });

  it("is refused when it cannot be read, hidden or not", () => {
    const lane = lpManifest().lpLane;
    const bad = (over: Record<string, unknown>) => () => parseDeployment({ ...manifest(), lpLane: { ...lane, ...over } });
    expect(bad({ extra: 1 })).toThrow(/unknown key "extra"/);
    // A lane funds loans through vaults: its own, or (none since D319) those its factory opens.
    expect(bad({ public: false, vaults: [] })).toThrow(/lpLane names no vault and no vault factory/);
    expect(bad({ pools: [{ ...lane.pools[0]!, token0: USDG, token1: WETH }] })).toThrow(/out of order/);
    expect(bad({ executors: [lane.executors[0]!, { ...lane.executors[1]!, token: WETH }] })).toThrow(/names a token twice/);
    expect(bad({ vaults: [{ address: LP_CORE, name: "x" }] })).toThrow(/vaults\[0\] is also its core/);
    expect(bad({ pools: [lane.pools[0]!, lane.pools[0]!] })).toThrow(/names a pool twice/);
    expect(bad({ adapters: [{ ...lane.adapters[0]!, kind: "uniswap-v5" }] })).toThrow(/kind is not one of uniswap-v3, ramses-v3, uniswap-v4, fables/);
    // A Uniswap v4 adapter names its PoolManager, never a factory, and a v3-style one never a PoolManager.
    expect(bad({ adapters: [{ ...lane.adapters[0]!, kind: "uniswap-v4" }] })).toThrow(/adapters\[0\] is a uniswap-v4 adapter naming a factory/);
    expect(bad({ adapters: [{ ...lane.adapters[0]!, poolManager: V4_POOL_MANAGER }] })).toThrow(/adapters\[0\] is a uniswap-v3 adapter naming a PoolManager/);
    expect(bad({ pools: [{ ...lane.pools[0]!, poolId: V4_POOL_ID }] })).toThrow(/pools\[0\] is a v3 pool naming a v4 key/);
  });

  it("reads a Uniswap v4 adapter by its PoolManager and its pools by their id, and SushiSwap v3 as a second Uniswap v3 adapter", () => {
    const lane = parseDeployment(lpFormatsManifest()).lpLane!;
    expect(lane.adapters.map((a) => [a.kind, a.address, a.positionManager, a.factory, a.poolManager])).toEqual([
      ["uniswap-v3", getAddress(UNI_ADAPTER), getAddress(UNI_NFPM), getAddress(UNI_FACTORY), null],
      ["ramses-v3", getAddress(RAMSES_ADAPTER), getAddress(RAMSES_NFPM), getAddress(RAMSES_FACTORY), null],
      ["uniswap-v3", getAddress(SUSHI_ADAPTER), getAddress(SUSHI_NFPM), getAddress(SUSHI_FACTORY), null],
      ["uniswap-v4", getAddress(V4_ADAPTER), getAddress(V4_POSM), null, getAddress(V4_POOL_MANAGER)],
    ]);
    expect(lane.pools.map((p) => [p.name, p.pool, p.poolId, p.native, p.hooks])).toEqual([
      ["Uniswap v3 WETH/USDG 0.05%", getAddress(UNI_POOL), null, false, null], ["Ramses WETH/USDG", getAddress(RAMSES_POOL), null, false, null],
      ["SushiSwap WETH/USDG 0.05%", getAddress(SUSHI_POOL), null, false, null], ["ETH / USDG v4 0.05%", getAddress(V4_POOL), V4_POOL_ID, true, getAddress(A(0))],
    ]);
    // The pool's address is its id's low 160 bits: the key the core and the registry use.
    expect(V4_POOL.toLowerCase()).toBe(`0x${V4_POOL_ID.slice(-40)}`);
    const all = lpFormatsManifest().lpLane;
    const bad = (pool: Record<string, unknown>) => () => parseDeployment({ ...manifest(), lpLane: { ...all, pools: [...all.pools.slice(0, 3), { ...all.pools[3]!, ...pool }] } });
    expect(bad({ pool: A(0x999) })).toThrow(/pools\[3\].pool is not its id's low 160 bits/);
    expect(bad({ poolId: "0x12" })).toThrow(/pools\[3\].poolId is not a pool id/);
    expect(bad({ native: "yes" })).toThrow(/pools\[3\].native is not a boolean/);
    expect(bad({ hooks: undefined })).toThrow(/pools\[3\].hooks is not an address/);
  });

  it("reads a native v4 pool in its own currency order, ETH first and booked as WETH, however WETH's address sorts", () => {
    // The testnet's WETH sorts above its USDG (launch/live/46630.json), and native ETH (zero) below both: the release books
    // its ETH/USDG pools' ETH as WETH in token0, above token1 (22 October 2026).
    const T_WETH = "0x7943e237c7F95DA44E0301572D358911207852Fa";
    const all = lpFormatsManifest().lpLane;
    const lane = (pool: Record<string, unknown>) => parseDeployment({ ...manifest(), lpLane: { ...all, pools: [...all.pools.slice(0, 3), { ...all.pools[3]!, token0: T_WETH, ...pool }] } }).lpLane!;
    expect(lane({}).pools[3]).toMatchObject({ token0: getAddress(T_WETH), token1: getAddress(USDG), native: true });
    // Not native, the same tokens are out of order; and a native pool books two different tokens.
    expect(() => lane({ native: false })).toThrow(/pools\[3\] names its tokens out of order/);
    expect(() => lane({ token1: T_WETH })).toThrow(/pools\[3\] names its tokens out of order/);
  });

  // The SDK reads the block by the rules every service shares (shared/lp-lane.mjs), in gage's main repository.
  const SHARED = new URL("../../../shared/lp-lane.mjs", import.meta.url);
  it.skipIf(!existsSync(SHARED))("refuses exactly what shared/lp-lane.mjs refuses, in its words, and reads what it reads", async () => {
    const shared = await import(SHARED.href) as { lpLane: (m: unknown, o?: { includeHidden?: boolean }) => { core: string; pools: { pool: string }[] } | null };
    const lane = lpManifest().lpLane;
    // Every format, and each way a Uniswap v4 adapter or pool is named wrong.
    const all = lpFormatsManifest().lpLane, v4Pool = (over: Record<string, unknown>) => ({ ...all, pools: [...all.pools.slice(0, 3), { ...all.pools[3]!, ...over }] });
    const v4Adapter = (over: Record<string, unknown>) => ({ ...all, adapters: [...all.adapters.slice(0, 3), { ...all.adapters[3]!, ...over }] });
    // A Fables adapter names its hook, and its pools are v4 pools of that hook (the reader every service shares serves it).
    const HOOK = A(0x7);
    const fables = (adapter: Record<string, unknown> = {}, pool: Record<string, unknown> = {}) => ({
      ...all, adapters: [...all.adapters.slice(0, 3), { ...all.adapters[3]!, kind: "fables", hook: HOOK, ...adapter }], pools: [...all.pools.slice(0, 3), { ...all.pools[3]!, hooks: HOOK, ...pool }],
    });
    const variants: unknown[] = [
      all, { ...all, public: false }, v4Adapter({ factory: A(0x5) }), v4Adapter({ poolManager: undefined }), v4Adapter({ poolManager: A(0) }), v4Adapter({ kind: "uniswap-v5" }),
      { ...lane, adapters: [{ ...lane.adapters[0]!, poolManager: V4_POOL_MANAGER }] }, { ...lane, pools: [{ ...lane.pools[0]!, native: false }] },
      v4Pool({ poolId: undefined }), v4Pool({ poolId: V4_POOL_ID.toUpperCase().replace("0X", "0x") }), v4Pool({ poolId: `${V4_POOL_ID}00` }), v4Pool({ pool: A(0x999) }),
      v4Pool({ native: undefined }), v4Pool({ native: 1 }), v4Pool({ hooks: A(0x6) }), v4Pool({ hooks: "0x0" }), v4Pool({ hooks: undefined }), v4Pool({ extra: true }),
      // A native pool's ETH booked as a WETH whose address sorts above USDG (the testnet's), not native, or on both sides.
      v4Pool({ token0: A(0x7943) }), v4Pool({ token0: A(0x7943), native: false }), v4Pool({ token1: all.pools[3]!.token0 }),
      fables(), fables({ hook: undefined }), fables({ factory: A(0x5) }), fables({}, { hooks: A(0) }), v4Adapter({ hook: HOOK }), { ...lane, adapters: [{ ...lane.adapters[0]!, hook: HOOK }] },
      lane, { ...lane, public: false }, { ...lane, public: "yes" }, { ...lane, startBlock: 0 }, { ...lane, startBlock: 1.5 }, { ...lane, core: A(0) }, { ...lane, registry: "0x12" },
      { ...lane, vaults: [] }, { ...lane, vaults: [{ address: LP_VAULT, name: " " }] }, { ...lane, vaults: [{ address: LP_VAULT, name: "x".repeat(65) }] },
      { ...lane, vaults: [{ address: LP_VAULT, name: "v", extra: true }] }, { ...lane, adapters: [] }, { ...lane, adapters: [{ ...lane.adapters[0]!, factory: A(0) }] },
      { ...lane, executors: [{ ...lane.executors[0]!, pools: [UNI_POOL, RAMSES_POOL] }] }, { ...lane, executors: [{ ...lane.executors[1]!, kind: "three-hop" }] },
      { ...lane, executors: [lane.executors[0]!, { ...lane.executors[0]!, address: A(0x777) }] },
      { ...lane, pools: [{ ...lane.pools[0]!, adapter: A(0x778) }] }, { ...lane, pools: [{ ...lane.pools[0]!, fee: 0x1000000 }] }, { ...lane, pools: [{ ...lane.pools[0]!, tickSpacing: 0 }] },
      { ...lane, pools: [{ ...lane.pools[0]!, name: "" }] }, { ...lane, pools: [lane.pools[0]!, lane.pools[0]!] }, { ...lane, adapters: [lane.adapters[0]!, { ...lane.adapters[1]!, address: UNI_ADAPTER }] },
      { ...lane, registry: LP_VAULT }, { ...lane, pools: "none" }, "lane",
      // D318: the vault factory, and a sale executor through one hookless v4 pool named by its id.
      { ...lane, vaultFactory: A(0x131) }, { ...lane, vaultFactory: A(0) }, { ...lane, vaultFactory: LP_CORE },
      { ...lane, executors: [lane.executors[0]!, { address: A(0x132), token: A(0x133), kind: "v4-one-pool", pools: [V4_POOL], poolId: V4_POOL_ID }] },
      { ...lane, executors: [lane.executors[0]!, { address: A(0x132), token: A(0x133), kind: "v4-one-pool", pools: [A(0x999)], poolId: V4_POOL_ID }] },
      { ...lane, executors: [lane.executors[0]!, { address: A(0x132), token: A(0x133), kind: "v4-one-pool", pools: [V4_POOL] }] },
      { ...lane, executors: [{ ...lane.executors[0]!, poolId: V4_POOL_ID }] },
      // D454: the rewards bridge, and older factories kept named.
      { ...lane, rewardsBridge: LP_BRIDGE }, { ...lane, rewardsBridge: A(0) }, { ...lane, rewardsBridge: "0x12" }, { ...lane, rewardsBridge: LP_CORE },
      { ...lane, retiredVaultFactories: [A(0x153)] }, { ...lane, retiredVaultFactories: [] }, { ...lane, retiredVaultFactories: "none" }, { ...lane, retiredVaultFactories: [A(0)] },
      { ...lane, retiredVaultFactories: [LP_VAULT] }, { ...lane, retiredVaultFactories: [A(0x153), A(0x153)] }, { ...lane, vaultFactory: A(0x153), retiredVaultFactories: [A(0x153)] },
      { ...lane, rewardsBridge: A(0x153), retiredVaultFactories: [A(0x153)] },
    ];
    for (const [n, v] of variants.entries()) {
      const m = { ...manifest(), lpLane: v };
      let theirs: string | null = null, ours: string | null = null;
      let read: ReturnType<typeof shared.lpLane> = null;
      try { read = shared.lpLane(m); } catch (e) { theirs = (e as Error).message; }
      try { parseLpLane(m); } catch (e) { ours = (e as Error).message; }
      expect(ours, `variant ${n}`).toBe(theirs);
      if (theirs === null) {
        const mine = parseLpLane(m);
        expect(mine === null, `variant ${n}`).toBe(read === null);
        if (mine && read) expect([mine.core.toLowerCase(), ...mine.pools.map((p) => p.pool.toLowerCase())]).toEqual([read.core, ...read.pools.map((p) => p.pool)]);
      }
    }
  });

  it("serves the lane's actions only where it is public, and wrapping Fables receipts only where it names a Fables adapter", () => {
    const LP = ["lp_borrow", "lp_repay", "lp_return_position", "lp_collect", "lp_withdraw", "lp_deposit", "lp_redeem", "lp_claim_bonus", "lp_roll"];
    const CURATE = ["lp_vault_add_pool", "lp_vault_remove_pool"];
    expect(actionsOn(d()).filter((a) => a.startsWith("lp_"))).toEqual([...LP, ...CURATE]);
    expect(actionsOn(parseDeployment(lpFablesManifest())).filter((a) => a.startsWith("lp_"))).toEqual([...LP, "lp_wrap", "lp_unwrap", ...CURATE]);
    // Opening a vault, only where the lane names its factory (D318).
    expect(actionsOn(parseDeployment(lpStockManifest())).filter((a) => a.startsWith("lp_"))).toEqual([...LP, "lp_create_vault", ...CURATE]);
    expect(actionsOn(parseDeployment(lpManifest({ public: false }))).filter((a) => a.startsWith("lp_"))).toEqual([]);
    // Mainnet's public lane names a Fables adapter, its vault factory and, since its switch (D454), its rewards bridge: every LP
    // action, the sGAGE claim included.
    expect(actionsOn(parseDeployment(MAINNET_MANIFEST)).filter((a) => a.startsWith("lp_"))).toEqual([...LP.slice(0, 8), "lp_claim_rewards", ...LP.slice(8),
      "lp_wrap", "lp_unwrap", "lp_create_vault", ...CURATE]);
  });
});

describe("a position's figures", () => {
  it("are its liquidity's amounts at the pool's price, as LiquidityAmounts rounds them, and their worth in USDG", () => {
    expect(positionAmounts(LP_PRICE.sqrtPriceX96, LP_FACTS.tickLower, LP_FACTS.tickUpper, LP_FACTS.liquidity)).toEqual({ amount0: AMOUNT0, amount1: AMOUNT1 });
    expect(valueInUsdg(USDG, WETH, USDG, AMOUNT0, AMOUNT1, LP_PRICE.sqrtPriceX96)).toBe(VALUE);
    // Above its range all WETH, below it all USDG.
    expect(positionAmounts(LP_PRICE.sqrtPriceX96, -190_000, -180_000, LP_FACTS.liquidity)).toEqual({ amount0: 52_787_847_314_360_016_916n, amount1: 0n });
    expect(positionAmounts(LP_PRICE.sqrtPriceX96, -210_000, -200_000, LP_FACTS.liquidity)).toEqual({ amount0: 0n, amount1: 179_562_218_972n });
    expect(positionAmounts(LP_PRICE.sqrtPriceX96, -199_380, -197_370, 0n)).toEqual({ amount0: 0n, amount1: 0n });
    // USDG first in a pool: the other token priced by the inverse; a pool without USDG has no worth here.
    expect(valueInUsdg(USDG, USDG, WETH, 5n, 10n ** 18n, 2n ** 96n * 31_622n)).toBe(1_000_049_123n);
    expect(valueInUsdg(USDG, WETH, RAM, 1n, 1n, LP_PRICE.sqrtPriceX96)).toBeNull();
  });

  it("hold a quote to a cost limit exactly, and name the whole basis points that take it", () => {
    expect(costWithin({ principal: 1_000_000_000n, repayment: 1_006_000_000n }, 60)).toBe(true);
    expect(costWithin({ principal: 1_000_000_000n, repayment: 1_006_000_001n }, 60)).toBe(false);
    expect(costCeiling({ principal: 1_000_000_000n, repayment: 1_006_000_001n })).toBe(61);
    expect(costCeiling({ principal: 1_000_000_000n, repayment: 1_000_000_000n })).toBe(1);
  });
});

describe("a wallet's LP positions", () => {
  /** Three Uniswap positions (one in a pool the lane does not list, one empty) and a Ramses one. */
  const holding = (over: Record<string, unknown> = {}) => fakeChain({
    ownedPositions: (manager: Address) => Promise.resolve(manager.toLowerCase() === UNI_NFPM ? { total: 3n, ids: [3n, 2n, 1n], enumerable: true } : { total: 1n, ids: [7n], enumerable: true }),
    lpFacts: (adapter: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => (id === 2n ? { ...LP_FACTS, pool: A(0x999) }
      : id === 1n ? { ...LP_FACTS, liquidity: 0n } : adapter.toLowerCase() === RAMSES_ADAPTER ? { ...LP_FACTS, pool: RAMSES_POOL } : LP_FACTS))),
    ...over,
  });

  it("are each adapter's positions in a pool the lane lists, newest first, valued at the pool's price, with whether the lane takes each now", async () => {
    const r = await lpPositions(lc({ chain: holding() }), WALLET);
    expect(r.positions.map((p) => [p.kind, p.tokenId, p.poolName, p.borrowable, p.refusal])).toEqual([
      ["uniswap-v3", "3", "Uniswap v3 WETH/USDG 0.05%", true, null], ["uniswap-v3", "1", "Uniswap v3 WETH/USDG 0.05%", false, "EMPTY_POSITION"], ["ramses-v3", "7", "Ramses WETH/USDG", true, null],
    ]);
    expect(r.positions[0]).toEqual({
      adapter: getAddress(UNI_ADAPTER), kind: "uniswap-v3", positionManager: getAddress(UNI_NFPM), tokenId: "3", pool: getAddress(UNI_POOL), poolName: "Uniswap v3 WETH/USDG 0.05%",
      token0: wethRef, token1: usdgRef, tickLower: -199_380, tickUpper: -197_370, liquidity: String(LP_FACTS.liquidity), inRange: true,
      amount0: String(AMOUNT0), amount1: String(AMOUNT1), valueUSDG: String(VALUE), borrowable: true, refusal: null,
    });
    expect(r.note).not.toMatch(/Only the newest|could not list/);
  });

  it("say when the registry would refuse one: its pool not admitted, or its range narrower than the pool's least", async () => {
    const closed = await lpPositions(lc({ chain: holding({ lpPoolConfig: () => Promise.resolve({ allowed: false, minHalfWidthTicks: 0, minLoanPrincipal: 0n, maxLoanPrincipal: 1n, maxOutstanding: 1n }) }) }), WALLET);
    expect(closed.positions.map((p) => p.refusal)).toEqual(["POOL_NOT_ALLOWED", "EMPTY_POSITION", "POOL_NOT_ALLOWED"]);
    const narrow = await lpPositions(lc({ chain: holding({ lpPoolConfig: () => Promise.resolve({ allowed: true, minHalfWidthTicks: 1_006, minLoanPrincipal: 0n, maxLoanPrincipal: 1n, maxOutstanding: 1n }) }) }), WALLET);
    expect(narrow.positions[0]).toMatchObject({ borrowable: false, refusal: "RANGE_TOO_NARROW" });
  });

  it("read at most a hundred of each position manager, and say when one cannot list them", async () => {
    const many = fakeChain({ ownedPositions: (manager: Address) => Promise.resolve(manager.toLowerCase() === UNI_NFPM ? { total: 150n, ids: [9n], enumerable: true } : { total: 2n, ids: [], enumerable: false }) });
    const r = await lpPositions(lc({ chain: many }), WALLET);
    expect(r.positions.map((p) => p.tokenId)).toEqual(["9"]);
    expect(r.note).toContain("Only the newest 100 positions of each position manager were read (uniswap-v3).");
    expect(r.note).toContain("A position manager could not list this wallet's positions (ramses-v3): quote one by its id.");
  });

  it("are refused where the release makes no LP lane public", async () => {
    expect(await code(lpPositions(ctx(), WALLET))).toBe("LP_CLOSED");
    expect(await code(lpPositions(ctx({ d: parseDeployment(lpManifest({ public: false })) }), WALLET))).toBe("LP_CLOSED");
  });
});

describe("a wallet's SushiSwap v3 and Uniswap v4 positions", () => {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const fd = () => parseDeployment(lpFormatsManifest());
  const indexed = (id: string, adapter: Address = V4_ADAPTER) => ({
    adapter: adapter.toLowerCase(), kind: same(adapter, V4_ADAPTER) ? "uniswap-v4" : "uniswap-v3", positionManager: (same(adapter, V4_ADAPTER) ? V4_POSM : UNI_NFPM).toLowerCase(),
    tokenId: id, pool: (same(adapter, V4_ADAPTER) ? V4_POOL : UNI_POOL).toLowerCase(), poolName: "ETH / USDG v4 0.05%", token0: WETH, token1: USDG, tickLower: -199_380, tickUpper: -197_370,
    liquidity: String(LP_FACTS.liquidity),
  });
  /**
   * gage's index (`GET /lp/positions?owner=`, mocked): the wallet's Uniswap v4 positions #7, #30 and #12 and a Uniswap v3
   * one, as the indexer builder's route answers them, unless a test changes it.
   */
  const index = (over: { incomplete?: boolean; status?: number; owner?: Address; positions?: unknown[] } = {}) => fakeUpstream({
    "/lp/positions?": () => (over.status ? { status: over.status, body: { error: { code: "LP_UNAVAILABLE" } } } : { status: 200, body: {
      owner: (over.owner ?? WALLET).toLowerCase(), block: "92663733", incomplete: over.incomplete ?? false,
      positions: over.positions ?? [indexed("7"), indexed("30"), indexed("12"), indexed("3", UNI_ADAPTER)],
    } }),
  });
  /**
   * The chain: Sushi's position manager lists the wallet's #5 and Uniswap's and Ramses' none; v4's #30 belongs to another
   * wallet now; each position LP_FACTS in its adapter's pool. What the reads asked is kept.
   */
  const chain = (over: Record<string, unknown> = {}) => {
    const asked = { listed: [] as Address[], owners: [] as [Address, bigint[]][], v3Prices: [] as Address[], v4Prices: [] as [Address, Hex][] };
    const c = fakeChain({
      ownedPositions: (manager: Address) => { asked.listed.push(manager); return Promise.resolve(same(manager, SUSHI_NFPM) ? { total: 1n, ids: [5n], enumerable: true } : { total: 0n, ids: [], enumerable: true }); },
      positionOwners: (manager: Address, ids: readonly bigint[]) => { asked.owners.push([manager, [...ids]]); return Promise.resolve(ids.map((id) => (id === 30n ? OTHER : WALLET))); },
      lpFacts: (adapter: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => ({ ...LP_FACTS, pool: same(adapter, V4_ADAPTER) ? V4_POOL : same(adapter, SUSHI_ADAPTER) ? SUSHI_POOL : UNI_POOL }))),
      clPoolPrice: (pool: Address) => { asked.v3Prices.push(pool); return Promise.resolve(LP_PRICE); },
      poolState: (stateView: Address, id: Hex) => { asked.v4Prices.push([stateView, id]); return Promise.resolve({ ...LP_PRICE, liquidity: 1n, lpFee: 500, protocolFee: 0 }); },
      ...over,
    });
    return Object.assign(c, { asked });
  };

  it("finds Uniswap v4 positions through gage's index, checks each is the wallet's on chain, and values them at the pool's price read by its id", async () => {
    const c = chain(), indexer = index();
    const r = await lpPositions(ctx({ d: fd(), chain: c, indexer }), WALLET);
    expect(indexer.asked).toEqual([`/lp/positions?owner=${WALLET.toLowerCase()}`]);
    // Sushi's from its own position manager; v4's from the index, newest first, #30 left out as another wallet's now.
    // The index's Uniswap v3 position is not taken from it: that manager is asked on chain, and lists none.
    expect(r.positions.map((p) => [p.kind, p.positionManager, p.tokenId, p.poolName])).toEqual([
      ["uniswap-v3", getAddress(SUSHI_NFPM), "5", "SushiSwap WETH/USDG 0.05%"],
      ["uniswap-v4", getAddress(V4_POSM), "12", "ETH / USDG v4 0.05%"],
      ["uniswap-v4", getAddress(V4_POSM), "7", "ETH / USDG v4 0.05%"],
    ]);
    expect(c.asked.listed.map((m) => m.toLowerCase())).not.toContain(V4_POSM);
    expect(c.asked.owners).toEqual([[getAddress(V4_POSM), [30n, 12n, 7n]]]);
    expect(r.positions[1]).toEqual({
      adapter: getAddress(V4_ADAPTER), kind: "uniswap-v4", positionManager: getAddress(V4_POSM), tokenId: "12", pool: getAddress(V4_POOL), poolName: "ETH / USDG v4 0.05%",
      token0: wethRef, token1: usdgRef, tickLower: -199_380, tickUpper: -197_370, liquidity: String(LP_FACTS.liquidity), inRange: true,
      amount0: String(AMOUNT0), amount1: String(AMOUNT1), valueUSDG: String(VALUE), borrowable: true, refusal: null,
    });
    // The v4 pool's price is its StateView's by its id, never a read at the address the lane names it by; Sushi's is its slot0.
    expect(c.asked.v4Prices).toEqual([[getAddress(STATE_VIEW), V4_POOL_ID]]);
    expect(c.asked.v3Prices.map((p) => p.toLowerCase())).toEqual([SUSHI_POOL]);
    expect(r.positions[0]).toMatchObject({ adapter: getAddress(SUSHI_ADAPTER), pool: getAddress(SUSHI_POOL), valueUSDG: String(VALUE), borrowable: true });
    expect(r.note).not.toMatch(/may be missing|could not list|Only the newest/);
  });

  it("lists what it found and says some v4 positions may be missing when the index missed some or cannot answer", async () => {
    const missing = "Some of this wallet's Uniswap v4 positions may be missing: gage's index could not list them all now. Quote one by its id, or ask again shortly.";
    const partial = await lpPositions(ctx({ d: fd(), chain: chain(), indexer: index({ incomplete: true }) }), WALLET);
    expect(partial.positions.map((p) => p.tokenId)).toEqual(["5", "12", "7"]);
    expect(partial.note).toContain(missing);
    for (const indexer of [index({ status: 503 }), index({ owner: OTHER }), fakeUpstream({ "/lp/positions?": { positions: "none" } }), fakeUpstream({})]) {
      const r = await lpPositions(ctx({ d: fd(), chain: chain(), indexer }), WALLET);
      expect(r.positions.map((p) => p.tokenId)).toEqual(["5"]);
      expect(r.note).toContain(missing);
    }
    // A lane without a v4 adapter asks gage's index nothing.
    const none = index();
    expect((await lpPositions(lc({ chain: chain(), indexer: none }), WALLET)).note).not.toContain("may be missing");
    expect(none.asked).toEqual([]);
  });

  it("reads at most a hundred v4 positions, newest first, and none in a pool the lane does not list", async () => {
    const many = index({ positions: Array.from({ length: 105 }, (_, n) => indexed(String(n + 1))) });
    const c = chain({ lpFacts: (adapter: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => ({ ...LP_FACTS, pool: id === 105n ? A(0x999) : same(adapter, V4_ADAPTER) ? V4_POOL : SUSHI_POOL }))) });
    const r = await lpPositions(ctx({ d: fd(), chain: c, indexer: many }), WALLET);
    expect(c.asked.owners[0]![1]).toHaveLength(100);
    expect(c.asked.owners[0]![1][0]).toBe(105n);
    expect(r.positions.filter((p) => p.kind === "uniswap-v4").map((p) => p.tokenId).slice(0, 2)).toEqual(["104", "103"]);
    expect(r.note).toContain("Only the newest 100 positions of each position manager were read (uniswap-v4).");
  });

  it("judges a running loan's end by the chain's clock, not the machine's", async () => {
    const c = chain({
      head: () => Promise.resolve({ number: 1n, timestamp: NOW - 100 }),
      lpNextLoanId: () => Promise.resolve(2n),
      lpLoans: (_core: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, state: 1, end: NOW - 50 }))),
    });
    const r = await lpLoans(ctx({ d: fd(), chain: c }), WALLET, actionsOn(fd()));
    expect(r.loans[0]!.actions.join(" ")).toMatch(/lp_repay/);
  });

  it("values a running v4 loan's position at its pool's price by its id, and leaves an unlisted v4 pool's unread", async () => {
    const c = chain({
      lpNextLoanId: () => Promise.resolve(3n),
      lpLoans: (_core: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, adapter: V4_ADAPTER, tokenId: 12n, pool: id === 2n ? V4_POOL : A(0x998) }))),
    });
    const r = await lpLoans(ctx({ d: fd(), chain: c }), WALLET, actionsOn(fd()));
    expect(r.loans.map((l) => [l.loanId, l.kind, l.poolName, l.position?.valueUSDG ?? null])).toEqual([["2", "uniswap-v4", "ETH / USDG v4 0.05%", String(VALUE)], ["1", "uniswap-v4", "an LP pool", null]]);
    expect(c.asked.v4Prices).toEqual([[getAddress(STATE_VIEW), V4_POOL_ID]]);
    expect(c.asked.v3Prices).toEqual([]);
  });
});

describe("an LP quote", () => {
  const ask = { adapter: UNI_ADAPTER, tokenId: ID, wallet: WALLET, term: 604_800 };

  it("asks the rates service for the position, borrower and term, and answers it as a borrow quote with a prepare object", async () => {
    const r = rates();
    const { note, ...q } = await lpQuote(lc({ rates: r }), ask);
    expect(r.asked).toEqual([`/lp/quote/${LP_CORE}?adapter=${UNI_ADAPTER}&tokenId=${ID}&borrower=${WALLET.toLowerCase()}&term=604800`]);
    expect(note).toContain("There is no liquidation: the loan is never closed early because a price moves; if it is not repaid by its end, the position goes to the lenders and nothing else is taken.");
    expect(q).toEqual({
      summary: "Pledge position #1469882 (Uniswap v3 WETH/USDG 0.05%), receive 996.50 USDG, repay 1,006.00 USDG within 7 days",
      position: { adapter: getAddress(UNI_ADAPTER), kind: "uniswap-v3", tokenId: ID, pool: getAddress(UNI_POOL), poolName: "Uniswap v3 WETH/USDG 0.05%", tickLower: -199_380, tickUpper: -197_370, liquidity: String(LP_FACTS.liquidity) },
      collateralValueUSDG: "2000000000", principal: "1000000000", receive: "996500000", originationFee: "3500000", feeBps: 35, repay: "1006000000", costBps: 60, ltvBps: 5000,
      term: 604_800, vault: getAddress(LP_VAULT), vaultName: "WETH/USDG LP lane", expiresAt: NOW + 300,
      prepare: { action: "lp_borrow", adapter: getAddress(UNI_ADAPTER), tokenId: ID, term: 604_800, maxCostBps: 60 },
    });
    const named = rates();
    expect((await lpQuote(lc({ rates: named }), { ...ask, vault: LP_VAULT })).prepare).toMatchObject({ vault: getAddress(LP_VAULT) });
    expect(named.asked[0]).toMatch(new RegExp(`&vault=${LP_VAULT}$`));
  });

  it("passes on the rates service's refusals only by the codes gage-sdk knows, in its own words", async () => {
    const known = await refusal(lpQuote(lc({ rates: rates({ refusal: "RANGE_TOO_NARROW" }) }), ask));
    expect(known).toEqual({ code: "RANGE_TOO_NARROW", message: "The position's range is narrower than its pool's least", retryable: false });
    expect(await refusal(lpQuote(lc({ rates: rates({ refusal: "CALL_GAGE_LP_BORROW_NOW" }) }), ask))).toEqual({ code: "RATES_REFUSED", message: "The rates service quoted no LP loan for this position", retryable: false });
    expect(await refusal(lpQuote(lc({ rates: rates({ refusal: "NOT_REGISTRY_SIGNER", status: 503 }) }), ask))).toMatchObject({ code: "NOT_REGISTRY_SIGNER", retryable: true });
    expect(await refusal(lpQuote(lc({ rates: rates({ refusal: "INTERNAL", status: 500 }) }), ask))).toMatchObject({ code: "RATES_UNAVAILABLE", retryable: true });
    expect(await code(lpQuote(lc({ rates: fakeUpstream({}) }), ask))).toBe("RATES_UNAVAILABLE");
    expect(await code(lpQuote(lc({ rates: fakeUpstream({ "/lp/quote/": { schema: "gage-lp-quote-v2" } }) }), ask))).toBe("UPSTREAM_INVALID");
    for (const c of ["ABOVE_POOL_CAP", "VAULT_CANNOT_FUND", "BELOW_MINIMUM_LOAN", "NOT_OWNER", "EMPTY_POSITION"]) expect(await code(lpQuote(lc({ rates: rates({ refusal: c }) }), ask))).toBe(c);
  });

  it("refuses a quote that is not for exactly this loan, nothing built on it", async () => {
    const mismatches: ((b: Parameters<Parameters<typeof edited>[0]>[0]) => void)[] = [
      (b) => { b.quote.borrower = OTHER; }, (b) => { b.quote.tokenId = "1"; }, (b) => { b.quote.term = "1814400"; }, (b) => { b.quote.adapter = RAMSES_ADAPTER; },
      (b) => { b.quote.vault = A(0x555); }, (b) => { b.quote.tickLower = "-199381"; }, (b) => { b.quote.liquidity = String(LP_FACTS.liquidity + 1n); },
      (b) => { b.quote.feeBps = "30"; b.terms.feeBps = 30; }, (b) => { b.quote.repayment = "999999999"; b.terms.repayment = "999999999"; },
      (b) => { b.quote.collateralValue = "1000000000"; b.valuation.collateralValue = "1000000000"; }, (b) => { b.terms.principal = "1"; }, (b) => { b.expiresAt += 1; },
    ];
    for (const [n, m] of mismatches.entries()) expect(await code(lpQuote(lc({ rates: edited(m) }), ask)), `mismatch ${n}`).toBe("PLAN_MISMATCH");
    expect(await code(lpQuote(lc({ rates: rates({ vault: A(0x555) }) }), { ...ask, vault: LP_VAULT }))).toBe("PLAN_MISMATCH");
    expect(await code(lpQuote(lc({ rates: rates({ deadline: NOW }) }), ask))).toBe("PRICING_EXPIRED");
  });

  it("is refused before the rates service is asked for a paused lane, a term the registry does not offer, or an adapter or vault the lane does not name", async () => {
    const r = rates();
    expect(await code(lpQuote(lc({ rates: r, chain: fakeChain({ lpRegistry: () => Promise.resolve({ terms: [604_800], feeBps: 35, ltvCapBps: 7_500, newLoansPaused: true }) }) }), ask))).toBe("LOANS_PAUSED");
    expect((await refusal(lpQuote(lc({ rates: r }), { ...ask, term: 86_400 })))).toMatchObject({ code: "TERM_NOT_ALLOWED", message: "Allowed terms: 7 days, 21 days" });
    expect(await code(lpQuote(lc({ rates: r }), { ...ask, adapter: A(0x777) }))).toBe("UNKNOWN_ADAPTER");
    expect(await code(lpQuote(lc({ rates: r }), { ...ask, vault: A(0x777) }))).toBe("UNKNOWN_VAULT");
    expect(r.asked).toEqual([]);
    expect(await code(lpQuote(ctx({ rates: r }), ask))).toBe("LP_CLOSED");
  });

  it("is refused for a position the lane's pools do not hold, or one that does not exist", async () => {
    expect(await code(lpQuote(lc({ rates: rates(), chain: fakeChain({ lpFacts: () => Promise.resolve([{ ...LP_FACTS, pool: A(0x999) }]) }) }), ask))).toBe("POOL_NOT_ALLOWED");
    expect(await code(lpQuote(lc({ rates: rates(), chain: fakeChain({ lpFacts: () => Promise.resolve([null]) }) }), ask))).toBe("POSITION_NOT_FOUND");
  });
});

describe("a wallet's LP loans and holdings", () => {
  /** Three loans: the wallet's running one (3), another wallet's (2), the wallet's repaid one not yet taken back (1). */
  const loans = (over: Record<string, unknown> = {}) => fakeChain({
    lpNextLoanId: () => Promise.resolve(4n),
    lpLoans: (_core: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => (id === 3n ? lpLoan({ id })
      : id === 2n ? lpLoan({ id, borrower: OTHER }) : lpLoan({ id, state: 2, tokenId: 5n })))),
    lpCredits: (_core: Address, _account: Address, tokens: readonly Address[]) => Promise.resolve(tokens.map((t) => (t.toLowerCase() === USDG ? 996_500_000n : 0n))),
    ...over,
  });

  it("lists the wallet's own loans newest first with what can be done now, each position valued now, and its credits", async () => {
    const r = await lpLoans(lc({ chain: loans() }), WALLET, actionsOn(d()));
    expect(r.loans.map((l) => [l.loanId, l.state, l.actions])).toEqual([
      ["3", "ACTIVE", ["lp_repay (borrower, before endsAt)", "lp_roll (borrower, before endsAt)", "lp_collect (borrower, before endsAt)"]],
      ["1", "REPAID", ["lp_return_position (borrower)"]],
    ]);
    expect(r.loans[0]).toMatchObject({
      borrower: WALLET, vault: LP_VAULT, vaultName: "WETH/USDG LP lane", adapter: UNI_ADAPTER, kind: "uniswap-v3", tokenId: ID, pool: UNI_POOL, poolName: "Uniswap v3 WETH/USDG 0.05%",
      principal: "1000000000", repay: "1006000000", costBps: 60, endsAt: NOW - 3600 + 604_800, term: 604_800, positionReturned: false,
      position: { inRange: true, amount0: String(AMOUNT0), amount1: String(AMOUNT1), valueUSDG: String(VALUE) },
    });
    expect(r.credits).toEqual([{ ...usdgRef, amount: "996500000" }]);
    // A service that does not prepare them says they are done on the app.
    const hosted = await lpLoans(lc({ chain: loans() }), WALLET, ["borrow"]);
    expect(hosted.loans[0]!.actions).toEqual([
      "lp_repay on testnet.gage.cash (borrower, before endsAt)", "lp_roll on testnet.gage.cash (borrower, before endsAt)", "lp_collect on testnet.gage.cash (borrower, before endsAt)",
    ]);
  });

  it("offers nothing on a loan past its end or defaulted, and says when only the newest loans were read", async () => {
    const ended = await lpLoans(lc({ chain: loans({ lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, end: NOW, state: id === 1n ? 3 : 1 }))) }) }), WALLET, actionsOn(d()));
    expect(ended.loans.map((l) => [l.state, l.actions, l.position === null])).toEqual([["ACTIVE", [], false], ["ACTIVE", [], false], ["DEFAULTED", [], true]]);
    const asked: number[] = [];
    const many = fakeChain({ lpNextLoanId: () => Promise.resolve(BigInt(MAX_LP_LOANS) + 6n), lpLoans: (_c: Address, ids: readonly bigint[]) => { asked.push(ids.length); return Promise.resolve(ids.map((id) => lpLoan({ id, state: 0 }))); } });
    const r = await lpLoans(lc({ chain: many }), WALLET, actionsOn(d()));
    expect(asked).toEqual([MAX_LP_LOANS]);
    expect(r.note).toContain(`Only the newest ${MAX_LP_LOANS} loans of the lane were read.`);
  });

  it("adds the lane to the wallet's portfolio: loans, credits, each vault's shares and worth, and its bonuses", async () => {
    const indexer = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } });
    const chain = loans({
      lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, state: id === 2n ? 3 : 2, positionReturned: true }))),
      lpShares: () => Promise.resolve(5n * 10n ** 18n), lpBonuses: (_v: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => (id === 2n ? 4_200_000n : 0n))),
    });
    const p = await portfolio(lc({ chain, indexer }), WALLET);
    expect(p.lp).toMatchObject({
      loans: [{ loanId: "3", state: "REPAID", actions: [] }, { loanId: "2", state: "DEFAULTED" }, { loanId: "1", state: "REPAID" }],
      credits: [{ ...usdgRef, amount: "996500000" }],
      vaults: [{ vault: getAddress(LP_VAULT), name: "WETH/USDG LP lane", shares: "5000000000000000000", shareDecimals: 12, valueUSDG: "5000000000000", bonuses: [{ loanId: "2", claimable: "4200000" }] }],
    });
    expect(p.note).toContain("lp is the LP lane");
    const without = await portfolio(ctx({ indexer }), WALLET);
    expect(without).not.toHaveProperty("lp");
  });

  it("reads each vault's share decimals from the vault: 12 for one opened before D331, 18 for one after", async () => {
    const indexer = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } });
    for (const decimals of [12, 18]) {
      // The same 200,000 USDG at par, a whole share 10^decimals raw.
      const scale = 10n ** BigInt(decimals - 6);
      const chain = loans({
        lpShareDecimals: () => Promise.resolve(decimals), lpVault: () => Promise.resolve({ ...LP_VAULT_STATE, totalShares: 200_000n * 10n ** BigInt(decimals) }),
        lpPreviewRedeem: (_v: Address, shares: bigint) => Promise.resolve(shares / scale), lpShares: () => Promise.resolve(5_000n * 10n ** BigInt(decimals)),
      });
      expect((await lpVaults(lc({ chain }))).vaults[0]).toMatchObject({ totalShares: String(200_000n * 10n ** BigInt(decimals)), shareDecimals: decimals, usdgPerShare: "1000000" });
      expect((await portfolio(lc({ chain, indexer }), WALLET)).lp?.vaults).toMatchObject([{ shares: String(5_000n * 10n ** BigInt(decimals)), shareDecimals: decimals, valueUSDG: "5000000000" }]);
    }
  });

  it("lists the LP vaults with their book and switches", async () => {
    const r = await lpVaults(lc({ chain: fakeChain({ lpVault: () => Promise.resolve({ ...LP_VAULT_STATE, depositsClosed: true, openLoans: 2, outstandingPrincipal: 5_000_000_000n }) }) }));
    expect(r.vaults).toEqual([{
      vault: getAddress(LP_VAULT), name: "WETH/USDG LP lane", factory: false, curator: LP_CURATOR, allowed: true, takesDeposits: false, paysOut: true, lends: true,
      mandate: [
        { adapter: UNI_ADAPTER, pool: UNI_POOL, poolName: "Uniswap v3 WETH/USDG 0.05%", activeAt: 1, funding: true },
        { adapter: RAMSES_ADAPTER, pool: RAMSES_POOL, poolName: "Ramses WETH/USDG", activeAt: 1, funding: true },
      ],
      funds: "It funds new loans against positions in Uniswap v3 WETH/USDG 0.05% and Ramses WETH/USDG.",
      totalAssetsUSDG: "200000000000", freeCashUSDG: "200000000000",
      outstandingPrincipalUSDG: "5000000000", totalShares: "200000000000000000", shareDecimals: 12, usdgPerShare: "1000000", performanceFeeBps: 1000, maxLoanPrincipalUSDG: "1000000000000", openLoans: 2, bonusHeldUSDG: "0",
      impaired: false, depositsClosed: true, fundingPaused: false,
    }]);
  });

  it("names the lane among the capabilities, with one rule saying what it is; none where it is not public", async () => {
    const caps = await capabilities(lc());
    expect(caps.lpLane).toMatchObject({
      core: getAddress(LP_CORE), registry: getAddress(LP_REG), vaults: [{ address: getAddress(LP_VAULT), name: "WETH/USDG LP lane" }],
      terms: [{ seconds: 604_800, days: 7 }, { seconds: 1_814_400, days: 21 }], originationFeeBps: 35, ltvCapBps: 7_500, newLoansPaused: false,
    });
    // The lane's pools are parked from too (D334), so park's rule follows the lane's.
    expect(caps.rules).toEqual([...RULES, LP_RULE, PARK_RULE]);
    // A Gage serving fewer actions says only the rules of those: the lane's contracts stay, for the reads it still answers.
    const fewer = await capabilities(lc(), ["borrow", "collect"]);
    expect(fewer.rules).toEqual(RULES);
    expect(fewer.lpLane).toBeDefined();
    expect(LP_RULE).toMatch(/There is no liquidation: the loan is never closed early because a price moves/);
    expect(caps.actions).toContain("lp_borrow");
    const plainCaps = await capabilities(ctx());
    expect(plainCaps).not.toHaveProperty("lpLane");
    expect(plainCaps.rules).toBe(RULES);
  });
});

/** A LoanOpened log of the core for `id` and the wallet. */
const opened = (id: bigint, borrower: Address = WALLET): Log => ({
  address: LP_CORE, removed: false, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null,
  data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }, { type: "uint40" }, { type: "address" }],
    [UNI_ADAPTER, UNI_POOL, 1_469_882n, 1_000_000_000n, 1_006_000_000n, 3_500_000n, NOW + 604_800, LP_ESCROW]),
  topics: encodeEventTopics({ abi: lpCoreAbi, eventName: "LoanOpened", args: { loanId: id, borrower, vault: LP_VAULT } }) as [Hex, ...Hex[]],
});
const borrowing = { action: "lp_borrow" as const, wallet: WALLET, adapter: UNI_ADAPTER, tokenId: ID, term: 604_800, maxCostBps: 60 };

describe("borrowing against a position", () => {
  it("approves the position to the core, borrows on the quote, then receives the USDG it credits", async () => {
    const p = await plan(lc({ rates: rates() }), borrowing);
    expect(p.steps.map((s) => [s.label, s.kind, s.final])).toEqual([["Approve position #1469882", "approve", false], ["Borrow", "action", true], ["Receive 996.50 USDG", "action", false]]);
    const [approve, borrow, receive] = await Promise.all(p.steps.map((s) => s.build()));
    expect(approve!.to.toLowerCase()).toBe(UNI_NFPM);
    expect(decodeFunctionData({ abi: positionManagerAbi, data: approve!.data }).args).toEqual([getAddress(LP_CORE), 1_469_882n]);
    expect(borrow!.to.toLowerCase()).toBe(LP_CORE);
    const call = decodeFunctionData({ abi: lpCoreAbi, data: borrow!.data });
    expect(call.functionName).toBe("borrow");
    expect(call.args).toEqual([{
      borrower: getAddress(WALLET), vault: getAddress(LP_VAULT), adapter: getAddress(UNI_ADAPTER), tokenId: 1_469_882n, liquidity: LP_FACTS.liquidity, tickLower: -199_380, tickUpper: -197_370,
      collateralValue: 2_000_000_000n, principal: 1_000_000_000n, repayment: 1_006_000_000n, term: 604_800, feeBps: 35, deadline: BigInt(NOW + 300),
    }, `0x${"ab".repeat(65)}`]);
    expect(decodeFunctionData({ abi: lpCoreAbi, data: receive!.data })).toMatchObject({ functionName: "withdraw", args: [getAddress(USDG)] });
    expect(p.view).toEqual({
      action: "lp_borrow", adapter: getAddress(UNI_ADAPTER), kind: "uniswap-v3", tokenId: ID, pool: getAddress(UNI_POOL), poolName: "Uniswap v3 WETH/USDG 0.05%", vault: getAddress(LP_VAULT),
      vaultName: "WETH/USDG LP lane", collateralValue: "2000000000", principal: "1000000000", fee: "3500000", feeBps: 35, payout: "996500000", repayment: "1006000000", term: 604_800,
      costBps: 60, maxCostBps: 60, ltvBps: 5000, receive: "996500000", expiresAt: NOW + 300,
    });
    expect(p.summary).toEqual({ title: "Borrow 1,000.00 USDG against position #1469882 (Uniswap v3 WETH/USDG 0.05%)", rows: [
      { label: "You pledge", value: "Position #1469882, Uniswap v3 WETH/USDG 0.05%, worth about 2,000.00 USDG" },
      { label: "You receive", value: "996.50 USDG after the 0.35% fee" },
      { label: "You repay within 7 days", value: "1,006.00 USDG" },
      { label: "Loan cost", value: "0.60%, under the 0.60% limit set" },
      { label: "Lent by", value: "WETH/USDG LP lane" },
      { label: "While it runs", value: "You collect the position's fees with lp_collect; its liquidity stays in place" },
      { label: "If you don't repay", value: "The position is unwound for the lenders. Nothing else is taken, and the loan is never closed early because a price moves." },
    ] });
    expect(p.made!([opened(4n, OTHER), opened(5n)])).toEqual({ engine: getAddress(LP_CORE), loanId: "5" });
    expect(p.made!([])).toBeNull();
  });

  it("skips an approval in place, and receives what the core credited the wallet before with the new loan's USDG", async () => {
    const chain = fakeChain({ positionApproved: () => Promise.resolve(true), lpCredits: () => Promise.resolve([1_000_000n]) });
    const p = await prepareNext(lc({ rates: rates(), chain }), borrowing);
    expect(p).toMatchObject({ status: "ready", next: { label: "Borrow", final: true }, then: ["Receive 997.50 USDG"] });
    expect(p.view).toMatchObject({ receive: "997500000" });
  });

  it("is refused above the cost limit, for a position another wallet holds or that does not exist, and where the lane is not public", async () => {
    expect(await code(plan(lc({ rates: rates() }), { ...borrowing, maxCostBps: 59 }))).toBe("PRICE_ABOVE_LIMIT");
    expect(await code(plan(lc({ rates: rates(), chain: fakeChain({ positionOwner: () => Promise.resolve(OTHER) }) }), borrowing))).toBe("NOT_OWNER");
    expect(await code(plan(lc({ rates: rates(), chain: fakeChain({ positionOwner: () => Promise.resolve(null) }) }), borrowing))).toBe("POSITION_NOT_FOUND");
    expect(await code(plan(lc({ rates: rates() }), { ...borrowing, adapter: A(0x777) }))).toBe("UNKNOWN_ADAPTER");
    expect(await code(gageFrom(ctx({ rates: rates() })).prepare(borrowing))).toBe("ACTION_NOT_SERVED");
  });

  it("sends the quote planned while it has a minute left; past that asks again, held to the cost limit and to the loan planned", async () => {
    const late = (over: Parameters<typeof lpQuoteRoute>[0]) => {
      let n = 0;
      return fakeUpstream({ "/lp/quote/": (path: string) => lpQuoteRoute(n++ === 0 ? { deadline: NOW + 50 } : over)(path) });
    };
    const fresh = late({ deadline: NOW + 299 });
    const p = await plan(lc({ rates: fresh }), borrowing);
    const call = decodeFunctionData({ abi: lpCoreAbi, data: (await p.steps[1]!.build()).data });
    expect(call.args?.[0]).toMatchObject({ deadline: BigInt(NOW + 299) });
    expect(fresh.asked).toHaveLength(2);
    // The quote planned with time left is sent as it was, without asking again.
    const kept = rates();
    await (await plan(lc({ rates: kept }), borrowing)).steps[1]!.build();
    expect(kept.asked).toHaveLength(1);
    for (const [over, refused] of [[{ principal: 1_000_000_001n, repayment: 1_006_000_001n }, "PRICE_MOVED"], [{ principal: 989_000_000n, repayment: 994_934_000n }, "PRICE_MOVED"],
      [{ repayment: 1_007_000_000n }, "PRICE_ABOVE_LIMIT"]] as const) {
      expect(await code((await plan(lc({ rates: late(over) }), borrowing)).steps[1]!.build()), refused).toBe(refused);
    }
  });

  it("planned again once the loan is open, leaves only its USDG to receive, and borrows nothing new", async () => {
    const open = (credit: bigint) => fakeChain({
      positionOwner: () => Promise.resolve(LP_ESCROW), lpNextLoanId: () => Promise.resolve(2n), lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id }))),
      lpCredits: () => Promise.resolve([credit]),
    });
    const r = rates();
    const p = await plan(lc({ rates: r, chain: open(996_500_000n) }), borrowing);
    expect(p.view).toEqual({ action: "lp_withdraw", credits: [{ ...usdgRef, amount: "996500000" }] });
    expect(p.summary.title).toBe("LP loan #1 is open against position #1469882 (Uniswap v3 WETH/USDG 0.05%): receive its USDG");
    expect(p.steps.map((s) => s.label)).toEqual(["Receive 996.50 USDG"]);
    expect(r.asked).toEqual([]);
    expect((await prepareNext(lc({ rates: r, chain: open(0n) }), borrowing)).status).toBe("done");
  });

  it("is carried out by run(): the approval, the borrow and the USDG received, the loan named from the borrow's own receipt", async () => {
    const signer = fakeSigner();
    const chain = fakeChain({ sent: () => Promise.resolve({ from: WALLET, to: LP_CORE, input: "0x", success: true, logs: [opened(1n)] }) });
    const r = await run(lc({ rates: rates(), chain }), borrowing, signer, { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "done", loan: { engine: getAddress(LP_CORE), loanId: "1" } });
    expect(r.sent.map((s) => s.label)).toEqual(["Approve position #1469882", "Borrow", "Receive 996.50 USDG"]);
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([UNI_NFPM, LP_CORE, LP_CORE]);
  });
});

describe("repaying an LP loan and taking the position back", () => {
  const one = (over: Partial<LpLoan> = {}, chain: Record<string, unknown> = {}) => fakeChain({ lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, ...over }))), ...chain });
  const repaying = { action: "lp_repay" as const, wallet: WALLET, loanId: "1" };

  it("approves exactly the repayment, repays, then takes the position back", async () => {
    const p = await plan(lc({ chain: one() }), repaying);
    expect(p.steps.map((s) => s.label)).toEqual(["Approve USDG", "Repay", "Take back position #1469882"]);
    const [approve, repay, back] = await Promise.all(p.steps.map((s) => s.build()));
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([getAddress(LP_CORE), 1_006_000_000n]);
    expect(decodeFunctionData({ abi: lpCoreAbi, data: repay!.data })).toMatchObject({ functionName: "repay", args: [1n] });
    expect(decodeFunctionData({ abi: lpCoreAbi, data: back!.data })).toMatchObject({ functionName: "returnPosition", args: [1n] });
    expect(p.summary).toEqual({ title: "Repay LP loan #1 and take back position #1469882 (Uniswap v3 WETH/USDG 0.05%)", rows: [
      { label: "You pay", value: "1,006.00 USDG" }, { label: "Repay before", value: `${new Date((NOW - 3600 + 604_800) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} (the loan's last day)` },
      { label: "Back to your wallet", value: "Position #1469882, Uniswap v3 WETH/USDG 0.05%" },
    ] });
    expect(p.view).toMatchObject({ action: "lp_repay", loanId: "1", repayment: "1006000000", repaid: false, returned: false });
    // A Ramses position may bring rewards back with it.
    expect((await plan(lc({ chain: one({ adapter: RAMSES_ADAPTER, pool: RAMSES_POOL }) }), repaying)).notes).toEqual(["Rewards that reached the position's escrow are credited to the wallet when it comes back: lp_withdraw takes them."]);
  });

  it("leaves only the return once repaid, nothing once the position is back, and is refused past the end, defaulted, unfunded or for another's loan", async () => {
    expect((await plan(lc({ chain: one({ state: 2 }) }), repaying)).steps.map((s) => s.label)).toEqual(["Take back position #1469882"]);
    const back = await prepareNext(lc({ chain: one({ state: 2, positionReturned: true }) }), repaying);
    expect(back).toMatchObject({ status: "done", summary: { title: "LP loan #1 is repaid and position #1469882 (Uniswap v3 WETH/USDG 0.05%) is back" } });
    expect(await code(plan(lc({ chain: one({ end: NOW }) }), repaying))).toBe("TERM_ENDED");
    expect(await code(plan(lc({ chain: one({ state: 3 }) }), repaying))).toBe("NOT_REPAYABLE");
    expect(await code(plan(lc({ chain: one({ borrower: OTHER }) }), repaying))).toBe("NOT_YOUR_LOAN");
    expect(await code(plan(lc({ chain: one({ state: 0 }) }), repaying))).toBe("LOAN_NOT_FOUND");
    expect(await code(plan(lc({ chain: one({}, { balance: () => Promise.resolve(1n) }) }), repaying))).toBe("INSUFFICIENT_BALANCE");
    expect((await plan(lc({ chain: one({}, { allowance: () => Promise.resolve(10n ** 30n) }) }), repaying)).steps.map((s) => s.label)).toEqual(["Repay", "Take back position #1469882"]);
  });

  it("takes the position back with lp_return_position once repaid, refused before", async () => {
    const back = { action: "lp_return_position" as const, wallet: WALLET, loanId: "1" };
    const p = await plan(lc({ chain: one({ state: 2 }) }), back);
    expect(p.steps.map((s) => s.label)).toEqual(["Take back position #1469882"]);
    expect(p.view).toMatchObject({ action: "lp_return_position", loanId: "1", returned: false });
    expect((await prepareNext(lc({ chain: one({ state: 2, positionReturned: true }) }), back)).status).toBe("done");
    expect(await code(plan(lc({ chain: one() }), back))).toBe("NOT_REPAID");
    expect(await code(plan(lc({ chain: one({ state: 4 }) }), back))).toBe("NOT_REPAYABLE");
  });
});

describe("collecting an LP loan's fees", () => {
  const collecting = { action: "lp_collect" as const, wallet: WALLET, loanId: "1" };
  const fees = { amount0: 2_000_000_000_000_000n, amount1: 5_000_000n };
  const collect = (over: Partial<LpLoan> = {}, chain: Record<string, unknown> = {}) => fakeChain({
    lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, ...over }))), lpFeesOwed: () => Promise.resolve(fees), ...chain,
  });
  const ramses = { adapter: RAMSES_ADAPTER, pool: RAMSES_POOL };

  it("collects the fees, then is planned again to receive them; a Ramses position's rewards are claimed with them", async () => {
    const p = await plan(lc({ chain: collect() }), collecting);
    expect(p.steps.map((s) => s.label)).toEqual(["Collect the position's fees"]);
    expect(p.again).toBe(true);
    expect(decodeFunctionData({ abi: lpCoreAbi, data: (await p.steps[0]!.build()).data })).toMatchObject({ functionName: "collectFees", args: [1n] });
    expect(p.view).toMatchObject({ action: "lp_collect", loanId: "1", fees: [{ ...wethRef, amount: "2000000000000000" }, { ...usdgRef, amount: "5000000" }], rewards: false, receive: [] });
    expect(p.summary.rows).toEqual([{ label: "Fees ready", value: "0.002 TOKEN, 5.00 USDG" }, { label: "The position", value: "Its liquidity stays in place, pledged to the loan" }]);
    const r = await plan(lc({ chain: collect(ramses, { lpFacts: () => Promise.resolve([{ ...LP_FACTS, pool: RAMSES_POOL }]) }) }), collecting);
    expect(r.steps.map((s) => s.label)).toEqual(["Collect the position's fees", "Claim the position's rewards"]);
    expect(decodeFunctionData({ abi: lpCoreAbi, data: (await r.steps[1]!.build()).data })).toMatchObject({ functionName: "claimRewards", args: [1n] });
    expect(r.view).toMatchObject({ rewards: true });
  });

  it("receives first what the core credits the wallet in the loan's tokens, each token a step", async () => {
    const credited = (tokens: readonly Address[]) => Promise.resolve(tokens.map((t) => (t.toLowerCase() === WETH ? 2n * 10n ** 15n : t.toLowerCase() === RAM ? 7n * 10n ** 18n : 0n)));
    const p = await plan(lc({ chain: collect(ramses, { lpCredits: (_c: Address, _a: Address, t: readonly Address[]) => credited(t) }) }), collecting);
    expect(p.steps.map((s) => s.label)).toEqual(["Receive 0.002 TOKEN", "Receive 7 TOKEN"]);
    expect((await Promise.all(p.steps.map((s) => s.build()))).map((t) => decodeFunctionData({ abi: lpCoreAbi, data: t.data }).args)).toEqual([[getAddress(WETH)], [getAddress(RAM)]]);
    expect(p.again).toBeUndefined();
    expect(p.view).toMatchObject({ fees: [], receive: [{ token: getAddress(WETH), amount: "2000000000000000" }, { token: getAddress(RAM), amount: "7000000000000000000" }] });
  });

  it("claims a Ramses position's rewards alone when no fee is owed, and has nothing to do for a Uniswap one", async () => {
    const none = { lpFeesOwed: () => Promise.resolve({ amount0: 0n, amount1: 0n }) };
    const r = await plan(lc({ chain: collect(ramses, none) }), collecting);
    expect(r.steps.map((s) => s.label)).toEqual(["Claim the position's rewards"]);
    expect(r.again).toBeUndefined();
    expect(r.notes).toEqual(["The rewards claimed are credited on the LP lane's core: lp_withdraw receives them."]);
    const u = await prepareNext(lc({ chain: collect({}, none) }), collecting);
    expect(u).toMatchObject({ status: "done", summary: { title: "Nothing is ready to collect" } });
  });

  it("is refused past the end, for a loan not running, or another's", async () => {
    expect(await code(plan(lc({ chain: collect({ end: NOW }) }), collecting))).toBe("TERM_ENDED");
    expect(await code(plan(lc({ chain: collect({ state: 2 }) }), collecting))).toBe("NOT_RUNNING");
    expect(await code(plan(lc({ chain: collect({ borrower: OTHER }) }), collecting))).toBe("NOT_YOUR_LOAN");
  });

  it("is carried out by run(): collected, planned again, then received", async () => {
    const signer = fakeSigner();
    let credited = 0n;
    const chain = collect({}, {
      lpCredits: (_c: Address, _a: Address, t: readonly Address[]) => Promise.resolve(t.map((x) => (x.toLowerCase() === USDG ? credited : 0n))),
      wait: () => { credited = 5_000_000n; return Promise.resolve(true); },
    });
    const r = await run(lc({ chain }), collecting, signer, { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "done" });
    expect(r.sent.map((s) => s.label)).toEqual(["Collect the position's fees", "Receive 5.00 USDG"]);
  });
});

describe("a loan against a SushiSwap v3 or Uniswap v4 position", () => {
  const fd = () => parseDeployment(lpFormatsManifest());
  /** Every position of an adapter in that adapter's pool: the Uniswap v4 one in the native ETH/USDG pool, Sushi's in its own. */
  const formats = (over: Record<string, unknown> = {}) => fakeChain({
    lpFacts: (adapter: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => ({
      ...LP_FACTS, pool: adapter.toLowerCase() === V4_ADAPTER ? V4_POOL : adapter.toLowerCase() === SUSHI_ADAPTER ? SUSHI_POOL : UNI_POOL,
    }))),
    ...over,
  });
  const fc = (over: { chain?: Chain; rates?: Upstream } = {}) => ctx({ d: fd(), chain: formats(), ...over });
  const v4 = { action: "lp_borrow" as const, wallet: WALLET, adapter: V4_ADAPTER, tokenId: "12", term: 604_800, maxCostBps: 60 };

  it("approves a v4 position on Uniswap v4's PositionManager, and says it leaves its subscription and that its ETH fees come as WETH", async () => {
    const p = await plan(fc({ rates: rates() }), v4);
    expect(p.steps.map((s) => s.label)).toEqual(["Approve position #12", "Borrow", "Receive 996.50 USDG"]);
    const approve = await p.steps[0]!.build();
    expect(approve.to.toLowerCase()).toBe(V4_POSM);
    expect(decodeFunctionData({ abi: positionManagerAbi, data: approve.data }).args).toEqual([getAddress(LP_CORE), 12n]);
    expect(decodeFunctionData({ abi: lpCoreAbi, data: (await p.steps[1]!.build()).data }).args?.[0]).toMatchObject({ adapter: getAddress(V4_ADAPTER), tokenId: 12n });
    expect(p.view).toMatchObject({ action: "lp_borrow", kind: "uniswap-v4", pool: getAddress(V4_POOL), poolName: "ETH / USDG v4 0.05%" });
    expect(p.summary.title).toBe("Borrow 1,000.00 USDG against position #12 (ETH / USDG v4 0.05%)");
    expect(p.summary.rows).toContainEqual({ label: "While it runs", value: "You collect the position's fees with lp_collect, its ETH as WETH; its liquidity stays in place" });
    expect(p.summary.rows).toContainEqual({ label: "Its v4 subscription", value: "Moving the position into escrow ends any subscription it has: a rewards program that tracks it stops counting it" });
    expect(p.notes).toContain("Its fees are collected as WETH, not ETH.");
    expect(p.notes.join(" ")).toContain("Moving a Uniswap v4 position into its escrow ends any subscription it has");
    // Its quote says the same.
    const q = await lpQuote(fc({ rates: rates() }), { adapter: V4_ADAPTER, tokenId: "12", wallet: WALLET, term: 604_800 });
    expect(q).toMatchObject({ position: { kind: "uniswap-v4", pool: getAddress(V4_POOL), poolName: "ETH / USDG v4 0.05%" }, prepare: { adapter: getAddress(V4_ADAPTER), tokenId: "12" } });
    expect(q.note).toContain("ends any subscription it has");
  });

  it("approves a SushiSwap v3 position on Sushi's position manager, through the Uniswap v3 adapter, with nothing more to say", async () => {
    const p = await plan(fc({ rates: rates() }), { ...v4, adapter: SUSHI_ADAPTER, tokenId: "5" });
    expect((await p.steps[0]!.build()).to.toLowerCase()).toBe(SUSHI_NFPM);
    expect(p.view).toMatchObject({ kind: "uniswap-v3", pool: getAddress(SUSHI_POOL), poolName: "SushiSwap WETH/USDG 0.05%" });
    expect(p.summary.rows.map((r) => r.label)).not.toContain("Its v4 subscription");
    expect(p.notes.join(" ")).not.toMatch(/subscription|WETH, not ETH/);
  });

  it("collects a v4 loan's fees as WETH and USDG, with no reward to claim, and repays and takes it back like any other", async () => {
    const loan = (chain: Record<string, unknown> = {}) => formats({
      lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, adapter: V4_ADAPTER, pool: V4_POOL, tokenId: 12n }))),
      lpFeesOwed: () => Promise.resolve({ amount0: 2_000_000_000_000_000n, amount1: 5_000_000n }), ...chain,
    });
    const p = await plan(ctx({ d: fd(), chain: loan() }), { action: "lp_collect", wallet: WALLET, loanId: "1" });
    expect(p.steps.map((s) => s.label)).toEqual(["Collect the position's fees"]);
    expect(p.view).toMatchObject({ kind: "uniswap-v4", fees: [{ token: WETH, amount: "2000000000000000" }, { token: USDG, amount: "5000000" }], rewards: false });
    const repay = await plan(ctx({ d: fd(), chain: loan() }), { action: "lp_repay", wallet: WALLET, loanId: "1" });
    expect(repay.steps.map((s) => s.label)).toEqual(["Approve USDG", "Repay", "Take back position #12"]);
    expect(repay.summary.rows).toContainEqual({ label: "Back to your wallet", value: "Position #12, ETH / USDG v4 0.05%" });
  });

  it("names the lane's formats in the capabilities, and each v4 pool by its id", async () => {
    const caps = await capabilities(ctx({ d: fd(), chain: formats() }));
    expect(caps.lpLane!.pools.map((p) => ("poolId" in p ? [p.name, p.poolId, p.native] : [p.name]))).toEqual([
      ["Uniswap v3 WETH/USDG 0.05%"], ["Ramses WETH/USDG"], ["SushiSwap WETH/USDG 0.05%"], ["ETH / USDG v4 0.05%", V4_POOL_ID, true],
    ]);
    expect(caps.lpLane!.adapters.map((a) => a.kind)).toEqual(["uniswap-v3", "ramses-v3", "uniswap-v3", "uniswap-v4"]);
    expect(LP_RULE).toContain("an ETH/USDG or stock/USDG liquidity position on Uniswap v3 or v4, SushiSwap v3, Ouro v3, Ramses or Fables, in a pool the lane lists");
    expect(LP_RULE).toContain("rolled into a new loan on the same position (lp_roll)");
    const tools = gageTools(gageFrom(ctx({ d: fd() })));
    expect(tools.find((t) => t.name === "gage_lp_positions")!.description).toContain("on Uniswap v3 or v4, SushiSwap v3, Ouro v3, Ramses or Fables");
    expect(tools.find((t) => t.name === "gage_prepare_lp_borrow")!.description).toContain("A Uniswap v4 position leaves any subscription it has");
  });
});

/** A Rolled log of the core for the old loan `id`, rolled into `newId`. */
const rolledLog = (id: bigint, newId: bigint, net: bigint): Log => ({
  address: LP_CORE, removed: false, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null,
  data: encodeAbiParameters([{ type: "uint256" }, { type: "int256" }], [1_006_000_000n, net]),
  topics: encodeEventTopics({ abi: lpCoreAbi, eventName: "Rolled", args: { loanId: id, newLoanId: newId, borrower: WALLET } }) as [Hex, ...Hex[]],
});

describe("rolling an LP loan", () => {
  const running = (over: Partial<LpLoan> = {}, chain: Record<string, unknown> = {}) => fakeChain({
    lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, ...over }))), ...chain,
  });
  const rolling = { action: "lp_roll" as const, wallet: WALLET, loanId: "1", term: 604_800, maxCostBps: 60 };

  it("judges the loan's end by the chain's clock, not the machine's", async () => {
    const chain = running({ end: NOW - 50 }, { head: () => Promise.resolve({ number: 1n, timestamp: NOW - 100 }) });
    await expect(plan(lc({ chain, rates: rates() }), rolling)).resolves.toMatchObject({ view: { action: "lp_roll" } });
  });

  it("asks for the loan's roll, approves exactly what the wallet pays, and rolls on the same position", async () => {
    const r = rates();
    const p = await plan(lc({ chain: running(), rates: r }), rolling);
    expect(r.asked).toEqual([`/lp/quote/${LP_CORE}?adapter=${UNI_ADAPTER}&tokenId=${ID}&borrower=${WALLET.toLowerCase()}&term=604800&loan=1`]);
    // The new 1,000 USDG less its 3.50 fee falls 9.50 short of the old 1,006 repayment: the wallet pays it.
    expect(p.steps.map((s) => [s.label, s.kind, s.final])).toEqual([["Approve USDG", "approve", false], ["Roll over", "action", true]]);
    const [approve, roll] = await Promise.all(p.steps.map((s) => s.build()));
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([getAddress(LP_CORE), 9_500_000n]);
    const call = decodeFunctionData({ abi: lpCoreAbi, data: roll!.data });
    expect(call.functionName).toBe("roll");
    expect(call.args?.[0]).toBe(1n);
    expect(call.args?.[1]).toMatchObject({ adapter: getAddress(UNI_ADAPTER), tokenId: 1_469_882n, principal: 1_000_000_000n, repayment: 1_006_000_000n, term: 604_800 });
    expect(p.view).toMatchObject({
      action: "lp_roll", loanId: "1", kind: "uniswap-v3", oldPrincipal: "1000000000", owed: "1006000000", principal: "1000000000", fee: "3500000", repayment: "1006000000",
      net: "-9500000", pay: "9500000", receive: "0", term: 604_800, endsAt: NOW + 604_800, costBps: 60, maxCostBps: 60,
    });
    expect(p.summary.rows.slice(0, 2)).toEqual([{ label: "You pay now", value: "9.50 USDG" }, { label: "Then you repay within 7 days", value: "1,006.00 USDG" }]);
    expect(p.summary.rows).toContainEqual({ label: "The position", value: "It stays in its escrow: nothing is unwound, nothing moves" });
    expect(p.made!([rolledLog(1n, 2n, -9_500_000n)])).toEqual({ engine: getAddress(LP_CORE), loanId: "2" });
  });

  it("receives what a larger new loan nets over the old repayment, with nothing to approve", async () => {
    const p = await plan(lc({ chain: running(), rates: rates({ principal: 1_100_000_000n, repayment: 1_106_600_000n }) }), rolling);
    expect(p.steps.map((s) => s.label)).toEqual(["Roll over", "Receive 90.15 USDG"]);
    expect(p.view).toMatchObject({ net: "90150000", pay: "0", receive: "90150000" });
    expect(p.summary.rows[0]).toEqual({ label: "You receive now", value: "90.15 USDG" });
  });

  it("is refused for a loan not running, past its end or another's, above the cost limit, short of USDG, or when the quote settles otherwise", async () => {
    expect(await code(plan(lc({ chain: running({ state: 2 }), rates: rates() }), rolling))).toBe("NOT_RUNNING");
    expect(await code(plan(lc({ chain: running({ end: NOW }), rates: rates() }), rolling))).toBe("TERM_ENDED");
    expect(await code(plan(lc({ chain: running({ borrower: OTHER }), rates: rates() }), rolling))).toBe("NOT_YOUR_LOAN");
    expect(await code(plan(lc({ chain: running(), rates: rates() }), { ...rolling, maxCostBps: 59 }))).toBe("PRICE_ABOVE_LIMIT");
    expect(await code(plan(lc({ chain: running({}, { balance: () => Promise.resolve(1n) }), rates: rates() }), rolling))).toBe("INSUFFICIENT_BALANCE");
    // The quote's settlement must be this loan's: its repayment owed, and the net the core moves.
    expect(await code(plan(lc({ chain: running(), rates: rates({ owed: 1_005_000_000n }) }), rolling))).toBe("PLAN_MISMATCH");
    for (const refused of ["NOT_ACTIVE", "PAST_TERM", "NOT_BORROWER", "NOT_SAME_POSITION"]) {
      expect(await refusal(plan(lc({ chain: running(), rates: rates({ refusal: refused }) }), rolling))).toMatchObject({ code: refused, retryable: false });
    }
    // A borrow's quote carries no roll; a roll's quote must.
    expect(await code(plan(lc({ chain: running(), rates: edited((b) => { delete (b as { roll?: unknown }).roll; }) }), rolling))).toBe("PLAN_MISMATCH");
  });

  it("asks again past a minute before the quote runs out, held to the settlement planned", async () => {
    const late = (over: Parameters<typeof lpQuoteRoute>[0]) => {
      let n = 0;
      return fakeUpstream({ "/lp/quote/": (path: string) => lpQuoteRoute(n++ === 0 ? { deadline: NOW + 50 } : over)(path) });
    };
    const fine = await plan(lc({ chain: running(), rates: late({ deadline: NOW + 299 }) }), rolling);
    expect(decodeFunctionData({ abi: lpCoreAbi, data: (await fine.steps[1]!.build()).data }).args?.[1]).toMatchObject({ deadline: BigInt(NOW + 299) });
    // A fresh quote that would take more from the wallet than the approval planned is refused.
    const worse = await plan(lc({ chain: running(), rates: late({ principal: 999_000_000n, repayment: 1_004_994_000n }) }), rolling);
    expect(await code(worse.steps[1]!.build())).toBe("PRICE_MOVED");
  });

  it("is carried out by run(): the approval and the roll, the new loan named from its receipt", async () => {
    const signer = fakeSigner();
    const chain = running({}, { sent: () => Promise.resolve({ from: WALLET, to: LP_CORE, input: "0x", success: true, logs: [rolledLog(1n, 2n, -9_500_000n)] }) });
    const r = await run(lc({ rates: rates(), chain }), rolling, signer, { sleep: () => Promise.resolve() });
    expect(r).toMatchObject({ status: "done", loan: { engine: getAddress(LP_CORE), loanId: "2" } });
    expect(r.sent.map((s) => s.label)).toEqual(["Approve USDG", "Roll over"]);
  });
});

describe("Fables receipts and positions", () => {
  const fd = () => parseDeployment(lpFablesManifest());
  const receipts = (over: Partial<FablesReceipts> = {}): FablesReceipts => ({
    shares: 10n ** 16n, staked: 0n, allowance: 0n, operator: false, paused: false, key: FABLES_KEY, tickLower: LP_FACTS.tickLower, tickUpper: LP_FACTS.tickUpper, set: true, ...over,
  });
  /** The wallet's receipts of FABLES_RANGE, and the Fables pool's positions. */
  const fables = (over: Record<string, unknown> = {}) => fakeChain({
    fablesReceipts: () => Promise.resolve(receipts()),
    lpFacts: (adapter: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => ({ ...LP_FACTS, pool: adapter.toLowerCase() === FABLES_ADAPTER ? FABLES_POOL : UNI_POOL }))),
    ...over,
  });
  const fc = (chain: Chain, over: { rates?: Upstream; indexer?: Upstream } = {}) => ctx({ d: fd(), chain, ...over });
  const wrapping = { action: "lp_wrap" as const, wallet: WALLET, adapter: FABLES_ADAPTER, rangeId: String(FABLES_RANGE) };
  const hookCall = (data: Hex) => decodeFunctionData({ abi: fablesHookAbi, data });
  const wrapperCall = (data: Hex) => decodeFunctionData({ abi: fablesWrapperAbi, data });
  const key = { currency0: getAddress(A(0)), currency1: getAddress(USDG), fee: 0x800000, tickSpacing: 10, hooks: getAddress(FABLES_HOOK) };

  it("lists wrapped Fables positions the index names as positions, and receipts not wrapped yet apart, each read on chain", async () => {
    const indexer = fakeUpstream({ "/lp/positions?": {
      owner: WALLET.toLowerCase(), block: "1", incomplete: false, positions: [{ adapter: FABLES_ADAPTER, kind: "fables", tokenId: "12" }],
      fablesReceipts: [{ adapter: FABLES_ADAPTER, hook: FABLES_HOOK, rangeId: String(FABLES_RANGE), shares: "1", staked: "0" }, { adapter: FABLES_ADAPTER, rangeId: "778" }],
    } });
    const chain = fables({ fablesReceipts: (_h: Address, _o: Address, range: bigint) => Promise.resolve(range === FABLES_RANGE ? receipts({ staked: 4n * 10n ** 15n }) : receipts({ shares: 0n })) });
    const r = await lpPositions(fc(chain, { indexer }), WALLET);
    expect(r.positions.map((p) => [p.kind, p.tokenId, p.poolName, p.borrowable])).toEqual([["fables", "12", "Fables ETH/USDG", true]]);
    expect(r.fablesReceipts).toHaveLength(1);
    // The receipts are valued as the position they would make: their shares are its liquidity.
    const { amount0, amount1, valueUSDG, ...row } = r.fablesReceipts![0]!;
    expect(row).toEqual({
      adapter: getAddress(FABLES_ADAPTER), kind: "fables", hook: getAddress(FABLES_HOOK), rangeId: String(FABLES_RANGE), pool: getAddress(FABLES_POOL), poolName: "Fables ETH/USDG",
      shares: "10000000000000000", staked: "4000000000000000", token0: { ...wethRef, token: getAddress(WETH) }, token1: usdgRef, tickLower: LP_FACTS.tickLower, tickUpper: LP_FACTS.tickUpper,
      inRange: true, borrowable: true, refusal: null,
    });
    expect([amount0, amount1, valueUSDG].every((v) => v !== null && BigInt(v) > 0n)).toBe(true);
    expect(r.note).toContain("lp_borrow with { adapter, rangeId } wraps them into a position");
    // Without receipts, no such list.
    expect(await lpPositions(fc(fables({ fablesReceipts: () => Promise.resolve(receipts({ shares: 0n })) }), { indexer }), WALLET)).not.toHaveProperty("fablesReceipts");
  });

  it("wraps every receipt of a range: staked ones unstaked first, then approved to the wrapper, then wrapped to the wallet", async () => {
    const p = await plan(fc(fables({ fablesReceipts: () => Promise.resolve(receipts({ staked: 4n * 10n ** 15n })) })), wrapping);
    expect(p.steps.map((s) => [s.label, s.kind, s.final])).toEqual([
      ["Unstake the Fables receipts", "action", false], ["Approve the Fables receipts", "approve", false], ["Wrap the Fables receipts", "action", true],
    ]);
    const [unstake, approve, wrap] = await Promise.all(p.steps.map((s) => s.build()));
    expect(unstake!.to.toLowerCase()).toBe(FABLES_HOOK);
    expect(hookCall(unstake!.data)).toMatchObject({ functionName: "unstake", args: [key, LP_FACTS.tickLower, LP_FACTS.tickUpper, 4n * 10n ** 15n] });
    expect(hookCall(approve!.data)).toMatchObject({ functionName: "approve", args: [getAddress(FABLES_WRAPPER), FABLES_RANGE, 10n ** 16n] });
    expect(wrap!.to.toLowerCase()).toBe(FABLES_WRAPPER);
    expect(wrapperCall(wrap!.data)).toMatchObject({ functionName: "wrap", args: [key, LP_FACTS.tickLower, LP_FACTS.tickUpper, 10n ** 16n, getAddress(WALLET)] });
    expect(p.view).toEqual({ action: "lp_wrap", adapter: getAddress(FABLES_ADAPTER), rangeId: "777", pool: getAddress(FABLES_POOL), poolName: "Fables ETH/USDG", shares: "10000000000000000", staked: "4000000000000000" });
    expect(p.again).toBeUndefined();
    // Nothing to unstake or approve: only the wrap.
    const plain = await plan(fc(fables({ fablesReceipts: () => Promise.resolve(receipts({ operator: true })) })), wrapping);
    expect(plain.steps.map((s) => s.label)).toEqual(["Wrap the Fables receipts"]);
  });

  it("is refused while Fables pauses transfers, without receipts, or for another adapter", async () => {
    expect(await refusal(plan(fc(fables({ fablesReceipts: () => Promise.resolve(receipts({ paused: true })) })), wrapping))).toMatchObject({ code: "FABLES_PAUSED", retryable: true });
    expect(await code(plan(fc(fables({ fablesReceipts: () => Promise.resolve(receipts({ shares: 0n })) })), wrapping))).toBe("NOTHING_TO_WRAP");
    expect(await code(plan(fc(fables()), { ...wrapping, adapter: UNI_ADAPTER }))).toBe("NOT_FABLES");
    expect(await code(plan(fc(fables()), { action: "lp_borrow", wallet: WALLET, adapter: FABLES_ADAPTER, term: 604_800, maxCostBps: 60 }))).toBe("INVALID_INPUT");
  });

  it("borrows against receipts by wrapping them first, then, once that is mined, borrowing against the position they make, its loan limited then", async () => {
    const signer = fakeSigner();
    let wrapped = false;
    const chain = fables({
      fablesReceipts: () => Promise.resolve(receipts(wrapped ? { shares: 0n } : {})),
      fablesNextTokenId: () => Promise.resolve(wrapped ? 13n : 12n),
      fablesWrapped: (_w: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => (wrapped && id === 12n ? { owner: WALLET, rangeId: FABLES_RANGE } : null))),
      // The wrap mints position #12 to the wallet once it is mined.
      wait: () => { if (signer.sent.at(-1)?.to.toLowerCase() === FABLES_WRAPPER) wrapped = true; return Promise.resolve(true); },
    });
    const borrowing = { action: "lp_borrow" as const, wallet: WALLET, adapter: FABLES_ADAPTER, rangeId: String(FABLES_RANGE), term: 604_800, maxCostBps: 60 };
    const first = await plan(fc(chain, { rates: rates() }), borrowing);
    expect(first.view).toMatchObject({ action: "lp_wrap", rangeId: "777" });
    expect(first.again).toBe(true);
    expect(first.steps.map((s) => [s.label, s.final])).toEqual([["Approve the Fables receipts", false], ["Wrap the Fables receipts", false]]);
    const views: View[] = [];
    const r = await run(fc(chain, { rates: rates() }), borrowing, signer, { sleep: () => Promise.resolve(), limit: (view) => { views.push(view); return { release: () => undefined }; } });
    expect(r.status).toBe("done");
    expect(r.sent.map((s) => s.label)).toEqual(["Approve the Fables receipts", "Wrap the Fables receipts", "Approve position #12", "Borrow", "Receive 996.50 USDG"]);
    expect(signer.sent.map((t) => t.to.toLowerCase())).toEqual([FABLES_HOOK, FABLES_WRAPPER, FABLES_WRAPPER, LP_CORE, LP_CORE]);
    // The limit is asked with the wrap, and again with the loan, before it is borrowed.
    expect(views.map((v) => v.action)).toEqual(["lp_wrap", "lp_borrow"]);
    expect(views[1]).toMatchObject({ principal: "1000000000", tokenId: "12", kind: "fables" });
    // A loan's spend limit that refuses stops the run after the wrap, nothing borrowed.
    wrapped = false;
    const stopped = await run(fc(chain, { rates: rates() }), borrowing, signer, {
      sleep: () => Promise.resolve(), limit: (view) => { if (view.action === "lp_borrow") throw new ApiError("SPEND_LIMIT", "over", 403); return { release: () => undefined }; },
    });
    expect(stopped).toMatchObject({ status: "stopped", error: { code: "SPEND_LIMIT" } });
    expect(stopped.sent.map((x) => x.label)).toEqual(["Approve the Fables receipts", "Wrap the Fables receipts"]);
  });

  it("unwraps a position the wallet holds back into its receipts; refused for one it does not hold, or while Fables pauses transfers", async () => {
    const held = fables({ fablesWrapped: (_w: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => ({ owner: WALLET, rangeId: FABLES_RANGE }))) });
    const unwrapping = { action: "lp_unwrap" as const, wallet: WALLET, adapter: FABLES_ADAPTER, tokenId: "12" };
    const p = await plan(fc(held), unwrapping);
    expect(p.steps.map((s) => [s.label, s.final])).toEqual([["Unwrap position #12", true]]);
    const tx = await p.steps[0]!.build();
    expect(tx.to.toLowerCase()).toBe(FABLES_WRAPPER);
    expect(wrapperCall(tx.data)).toMatchObject({ functionName: "unwrap", args: [12n, getAddress(WALLET)] });
    expect(p.view).toMatchObject({ action: "lp_unwrap", kind: "fables", tokenId: "12", poolName: "Fables ETH/USDG" });
    expect(await code(plan(fc(fables({ fablesWrapped: (_w: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => ({ owner: LP_ESCROW, rangeId: FABLES_RANGE }))) })), unwrapping))).toBe("NOT_OWNER");
    expect(await code(plan(fc(fables()), unwrapping))).toBe("POSITION_NOT_FOUND");
    expect(await code(plan(fc(fables({
      fablesWrapped: (_w: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => ({ owner: WALLET, rangeId: FABLES_RANGE }))),
      fablesReceipts: () => Promise.resolve(receipts({ paused: true })),
    })), unwrapping))).toBe("FABLES_PAUSED");
  });
});

describe("withdrawing LP credits", () => {
  const credits = (tokens: readonly Address[]) => Promise.resolve(tokens.map((t) => (t.toLowerCase() === USDG ? 3_000_000n : t.toLowerCase() === RAM ? 10n ** 18n : 0n)));
  const chain = () => fakeChain({ lpCredits: (_c: Address, _a: Address, t: readonly Address[]) => credits(t) });

  it("receives every token the core credits the wallet: USDG, its pools' tokens and the adapters' rewards", async () => {
    const asked: Address[][] = [];
    const p = await plan(lc({ chain: fakeChain({ lpCredits: (_c: Address, _a: Address, t: readonly Address[]) => { asked.push([...t]); return credits(t); } }) }), { action: "lp_withdraw", wallet: WALLET });
    expect(asked).toEqual([[getAddress(USDG), getAddress(WETH), getAddress(RAM)]]);
    expect(p.steps.map((s) => s.label)).toEqual(["Receive 3.00 USDG", "Receive 1 TOKEN"]);
    expect(p.view).toEqual({ action: "lp_withdraw", credits: [{ ...usdgRef, token: getAddress(USDG), amount: "3000000" }, { token: getAddress(RAM), symbol: "TOKEN", decimals: 18, amount: "1000000000000000000" }] });
  });

  it("receives one token when named, refused without a credit of it, and has nothing to do without any", async () => {
    expect((await plan(lc({ chain: chain() }), { action: "lp_withdraw", wallet: WALLET, token: RAM })).steps.map((s) => s.label)).toEqual(["Receive 1 TOKEN"]);
    expect(await code(plan(lc({ chain: chain() }), { action: "lp_withdraw", wallet: WALLET, token: WETH }))).toBe("NOTHING_TO_WITHDRAW");
    expect((await prepareNext(lc(), { action: "lp_withdraw", wallet: WALLET })).status).toBe("done");
  });
});

describe("an LP vault's deposits, withdrawals and bonuses", () => {
  const depositing = { action: "lp_deposit" as const, wallet: WALLET, vault: LP_VAULT, amount: "1000000000" };
  const vault = (over: Partial<typeof LP_VAULT_STATE> = {}, chain: Record<string, unknown> = {}) => fakeChain({ lpVault: () => Promise.resolve({ ...LP_VAULT_STATE, ...over }), ...chain });

  it("deposits USDG approved exactly, minting to the wallet (ERC-4626, D319) at least what it buys now less the slippage room", async () => {
    const p = await plan(lc({ chain: vault() }), depositing);
    expect(p.steps.map((s) => [s.label, s.final])).toEqual([["Approve USDG", false], ["Deposit", true]]);
    const [approve, deposit] = await Promise.all(p.steps.map((s) => s.build()));
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([getAddress(LP_VAULT), 1_000_000_000n]);
    expect(decodeFunctionData({ abi: lpVaultAbi, data: deposit!.data })).toMatchObject({ functionName: "deposit", args: [1_000_000_000n, getAddress(WALLET), 995_000_000_000_000n] });
    expect(p.view).toEqual({ action: "lp_deposit", vault: getAddress(LP_VAULT), name: "WETH/USDG LP lane", amount: "1000000000", minShares: "995000000000000", shareDecimals: 12, performanceFeeBps: 1000 });
    expect(p.summary.rows.slice(0, 2)).toEqual([{ label: "You deposit", value: "1,000.00 USDG" }, { label: "You receive at least", value: "995 shares" }]);
    expect((await plan(lc({ chain: vault() }), { ...depositing, maxSlippageBps: 0 })).view).toMatchObject({ minShares: "1000000000000000" });
  });

  it("is refused while the vault is impaired or its deposits closed, without the USDG, for nothing, or a vault the lane does not name", async () => {
    expect(await refusal(plan(lc({ chain: vault({ impaired: true }) }), depositing))).toMatchObject({ code: "VAULT_IMPAIRED" });
    expect(await code(plan(lc({ chain: vault({ depositsClosed: true }) }), depositing))).toBe("DEPOSITS_CLOSED");
    expect(await code(plan(lc({ chain: vault({}, { balance: () => Promise.resolve(1n) }) }), depositing))).toBe("INSUFFICIENT_BALANCE");
    expect(await code(plan(lc({ chain: vault({}, { lpPreviewDeposit: () => Promise.resolve(0n) }) }), depositing))).toBe("ZERO_SHARES");
    expect(await code(plan(lc({ chain: vault({ asset: WETH }) }), depositing))).toBe("ASSET_CHANGED");
    expect(await code(plan(lc({ chain: vault({ core: A(0x777) }) }), depositing))).toBe("UNKNOWN_VAULT");
    expect(await code(plan(lc(), { ...depositing, vault: A(0x777) }))).toBe("UNKNOWN_VAULT");
  });

  const redeeming = { action: "lp_redeem" as const, wallet: WALLET, vault: LP_VAULT };
  const held = (shares: bigint, over: Partial<typeof LP_VAULT_STATE> = {}) => vault(over, { lpShares: () => Promise.resolve(shares) });

  it("redeems every share the wallet holds, or the shares named, to the wallet, for at least what they redeem for now less the slippage room", async () => {
    // The holding is the share token's balanceOf (D319): shares the wallet received by transfer count as its own.
    const all = await plan(lc({ chain: held(5n * 10n ** 15n) }), redeeming);
    expect(decodeFunctionData({ abi: lpVaultAbi, data: (await all.steps[0]!.build()).data }))
      .toMatchObject({ functionName: "redeem", args: [5n * 10n ** 15n, getAddress(WALLET), getAddress(WALLET), 4_975_000_000n] });
    expect(all.view).toEqual({ action: "lp_redeem", vault: getAddress(LP_VAULT), name: "WETH/USDG LP lane", shares: "5000000000000000", shareDecimals: 12, assets: "5000000000", minAssets: "4975000000", all: true });
    expect(all.summary.rows[0]).toEqual({ label: "You redeem", value: "5,000 shares (all)" });
    const part = await plan(lc({ chain: held(5n * 10n ** 15n) }), { ...redeeming, shares: "1000000000000000" });
    expect(part.view).toMatchObject({ shares: "1000000000000000", assets: "1000000000", all: false });
  });

  it("counts shares in the vault's own decimals: 12 for a vault opened before D331, 18 for one after", async () => {
    for (const decimals of [12, 18]) {
      const scale = 10n ** BigInt(decimals - 6), shares = 5_000n * 10n ** BigInt(decimals);
      const chain = held(shares, { totalShares: 200_000n * 10n ** BigInt(decimals) });
      Object.assign(chain, {
        lpShareDecimals: () => Promise.resolve(decimals),
        lpPreviewDeposit: (_v: Address, assets: bigint) => Promise.resolve(assets * scale), lpPreviewRedeem: (_v: Address, s: bigint) => Promise.resolve(s / scale),
      });
      const deposit = await plan(lc({ chain }), depositing);
      expect(deposit.view).toMatchObject({ minShares: String(995n * 10n ** BigInt(decimals)), shareDecimals: decimals });
      expect(deposit.summary.rows[1]).toEqual({ label: "You receive at least", value: "995 shares" });
      const redeem = await plan(lc({ chain }), redeeming);
      expect(redeem.view).toMatchObject({ shares: String(shares), shareDecimals: decimals, assets: "5000000000", all: true });
      expect(redeem.summary.rows[0]).toEqual({ label: "You redeem", value: "5,000 shares (all)" });
    }
  });

  it("cuts everything to what the free cash pays, refuses shares named past it, and is refused while impaired or without shares", async () => {
    const short = held(5n * 10n ** 15n, { freeCash: 2_000_000_000n });
    const cut = await plan(lc({ chain: short }), redeeming);
    // 2,000 USDG of free cash at the vault's price, its virtual share and asset included: 2·10^15 shares exactly, the
    // vault's own maxRedeem, less a basis point of it while loans run (the free cash short of the vault's 200,000 USDG).
    expect(cut.view).toMatchObject({ shares: "1999800000000000", assets: "1999800000", all: false });
    const asked: [Address, Address][] = [];
    const told = held(5n * 10n ** 15n, { freeCash: 2_000_000_000n });
    told.lpMaxRedeem = (vault: Address, owner: Address) => { asked.push([vault, owner]); return Promise.resolve(1_500_000_000_000_000n); };
    expect((await plan(lc({ chain: told }), redeeming)).view).toMatchObject({ shares: "1499850000000000", assets: "1499850000", all: false });
    expect(asked.map(([v, o]) => [v.toLowerCase(), o.toLowerCase()])).toEqual([[LP_VAULT.toLowerCase(), WALLET.toLowerCase()]]);
    expect(cut.notes).toEqual(["The rest stays in the vault until it has the free cash to pay it."]);
    expect(await refusal(plan(lc({ chain: short }), { ...redeeming, shares: "3000000000000000" }))).toMatchObject({ code: "INSUFFICIENT_LIQUIDITY", details: { availableNow: "2000000000" } });
    expect(await code(plan(lc({ chain: held(5n * 10n ** 15n, { impaired: true }) }), redeeming))).toBe("VAULT_IMPAIRED");
    expect(await code(plan(lc({ chain: held(0n) }), redeeming))).toBe("EXCEEDS_BALANCE");
    expect(await code(plan(lc({ chain: held(5n) }), { ...redeeming, shares: "6" }))).toBe("EXCEEDS_BALANCE");
    expect(await code(plan(lc({ chain: held(5n) }), redeeming))).toBe("TOO_SMALL");
  });

  // LPVault accrues each running loan's return into its share price by the second, while its free cash stands still: a
  // redemption sized to the free cash's last unit (the vault's own maxRedeem) passes only in the second it was read.
  it("keeps a basis point of the free cash when it sizes everything while a loan runs, so the redemption still pays once sent", async () => {
    // 10,000 USDG free and a 90,000 USDG loan returning 900 over 7 days, an hour in; 12-decimal shares (10^6 virtual).
    const FREE = 10_000_000_000n, PRINCIPAL = 90_000_000_000n, NET = 900_000_000n, SPAN = 604_800n, SUPPLY = 100_000_000_000n * 10n ** 6n;
    const totalAssets = (seconds: bigint) => FREE + PRINCIPAL + (NET * (3_600n + seconds)) / SPAN;
    const worth = (shares: bigint, seconds = 0n) => (shares * (totalAssets(seconds) + 1n)) / (SUPPLY + 10n ** 6n);
    // What LPVault._payOut takes `seconds` after the plan read the vault: no more than its free cash (InsufficientLiquidity).
    const pays = (shares: bigint, seconds: bigint) => worth(shares, seconds) <= FREE;
    const running = (holding: bigint) => {
      const chain = held(holding, { freeCash: FREE, totalAssets: totalAssets(0n), totalShares: SUPPLY, outstandingPrincipal: PRINCIPAL, openLoans: 1 });
      chain.lpPreviewRedeem = (_v: Address, shares: bigint) => Promise.resolve(worth(shares));
      return chain;
    };
    // A holder of all but a USDG's worth of the shares: everything is cut to what the free cash pays.
    const big = running(SUPPLY - 10n ** 12n), exact = await big.lpMaxRedeem(LP_VAULT, WALLET);
    expect([pays(exact, 0n), pays(exact, 1n)]).toEqual([true, false]);
    const p = await plan(lc({ chain: big }), redeeming), shares = BigInt((p.view as { shares: string }).shares);
    expect(shares).toBe(exact - exact / 10_000n);
    for (const seconds of [0n, 1n, 60n, 3_600n]) expect(pays(shares, seconds), `${seconds} seconds later`).toBe(true);
    expect(p.view).toMatchObject({ all: false, assets: String(worth(shares)) });
    expect(p.notes).toEqual(["The rest stays in the vault until it has the free cash to pay it."]);
    // One whose holding the free cash pays now by less than that basis point is held to it too.
    const edge = SUPPLY * (FREE - 1_000n) / (totalAssets(0n) + 1n);
    expect([pays(edge, 0n), pays(edge, 60n)]).toEqual([true, false]);
    const q = await plan(lc({ chain: running(edge) }), redeeming), cut = BigInt((q.view as { shares: string }).shares);
    expect(cut).toBe(edge - edge / 10_000n);
    expect(pays(cut, 3_600n)).toBe(true);
  });

  const claiming = { action: "lp_claim_bonus" as const, wallet: WALLET, vault: LP_VAULT };
  /** Twenty-two defaulted loans of the vault, each with a bonus for the wallet but the first, and a running one. */
  const bonuses = () => fakeChain({
    lpNextLoanId: () => Promise.resolve(24n),
    lpLoans: (_c: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => lpLoan({ id, state: id === 23n ? 1 : 3 }))),
    lpBonuses: (_v: Address, ids: readonly bigint[]) => Promise.resolve(ids.map((id) => (id === 1n ? 0n : id * 1_000_000n))),
  });

  it("claims each defaulted loan's bonus for the wallet, twenty at a time, or one loan's when named", async () => {
    const p = await plan(lc({ chain: bonuses() }), claiming);
    expect(p.steps).toHaveLength(20);
    expect(p.steps[0]!.label).toBe("Claim the bonus of loan #22");
    expect(decodeFunctionData({ abi: lpVaultAbi, data: (await p.steps[0]!.build()).data })).toMatchObject({ functionName: "claimBonus", args: [22n] });
    expect(p.view).toMatchObject({ action: "lp_claim_bonus", total: String((22n + 3n) * 20n / 2n * 1_000_000n) });
    expect(p.notes).toContain("More bonuses are ready: claim again once these have gone through.");
    const one = await plan(lc({ chain: bonuses() }), { ...claiming, loanId: "5" });
    expect(one.steps.map((s) => s.label)).toEqual(["Claim the bonus of loan #5"]);
    expect(await code(plan(lc({ chain: bonuses() }), { ...claiming, loanId: "1" }))).toBe("NO_BONUS");
    expect((await prepareNext(lc(), claiming)).status).toBe("done");
  });
});

describe("the LP lane's tools", () => {
  const names = (tools: ReturnType<typeof gageTools>) => tools.map((t) => t.name);

  it("read the lane where it is public, beside a prepare and a signed tool per action; none of it elsewhere", () => {
    const tools = gageTools(gageFrom(lc()), { signer: fakeSigner() });
    expect(names(tools).filter((n) => n.startsWith("gage_lp_"))).toEqual([
      "gage_lp_positions", "gage_lp_quote", "gage_lp_loans", "gage_lp_vaults",
      "gage_lp_borrow", "gage_lp_repay", "gage_lp_return_position", "gage_lp_collect", "gage_lp_withdraw", "gage_lp_deposit", "gage_lp_redeem", "gage_lp_claim_bonus",
      "gage_lp_roll", "gage_lp_vault_add_pool", "gage_lp_vault_remove_pool",
    ]);
    expect(names(tools).filter((n) => n.startsWith("gage_prepare_lp_"))).toHaveLength(11);
    // Opening a vault, where the lane names its vault factory (D318).
    expect(names(gageTools(gageFrom(ctx({ d: parseDeployment(lpStockManifest()) })), { signer: fakeSigner() })).filter((n) => n.includes("lp_create_vault")))
      .toEqual(["gage_prepare_lp_create_vault", "gage_lp_create_vault"]);
    // Wrapping Fables receipts and unwrapping a position, where the lane names a Fables adapter.
    expect(names(gageTools(gageFrom(ctx({ d: parseDeployment(lpFablesManifest()) })), { signer: fakeSigner() })).filter((n) => /_lp_(un)?wrap$/.test(n)))
      .toEqual(["gage_prepare_lp_wrap", "gage_prepare_lp_unwrap", "gage_lp_wrap", "gage_lp_unwrap"]);
    expect(tools.filter((t) => t.name.startsWith("gage_lp_") && t.annotations.readOnlyHint)).toHaveLength(4);
    expect(names(gageTools(gageFrom(ctx()), { signer: fakeSigner() })).some((n) => n.includes("_lp_"))).toBe(false);
    expect(names(gageTools(gageFrom(ctx({ d: parseDeployment(lpManifest({ public: false })) })))).some((n) => n.includes("_lp_"))).toBe(false);
  });

  it("serve the reads alone to a Gage that serves no LP action, as the hosted service's does", async () => {
    const gage = gageFrom(lc({ chain: fakeChain() }), { actions: ["borrow", "collect"] });
    const tools = gageTools(gage);
    expect(names(tools).filter((n) => n.includes("_lp_"))).toEqual(["gage_lp_positions", "gage_lp_quote", "gage_lp_loans", "gage_lp_vaults"]);
    expect(await tools.find((t) => t.name === "gage_lp_vaults")!.execute({})).toMatchObject({ vaults: [{ name: "WETH/USDG LP lane", usdgPerShare: "1000000" }] });
    expect(await code(gage.prepare(borrowing))).toBe("ACTION_NOT_SERVED");
  });

  it("answer in plain JSON, and check their input", async () => {
    const tools = gageTools(gageFrom(lc({ rates: rates() })));
    const quote = tools.find((t) => t.name === "gage_lp_quote")!;
    expect(await quote.execute({ adapter: UNI_ADAPTER, tokenId: ID, wallet: WALLET, term: 604_800 })).toMatchObject({ principal: "1000000000", prepare: { action: "lp_borrow" } });
    expect(await code(quote.execute({ adapter: UNI_ADAPTER, tokenId: "-1", wallet: WALLET, term: 604_800 }))).toBe("INVALID_INPUT");
    const prepare = tools.find((t) => t.name === "gage_prepare_lp_borrow")!;
    expect(await prepare.execute({ wallet: WALLET, adapter: UNI_ADAPTER, tokenId: ID, term: 604_800, maxCostBps: 60 })).toMatchObject({ status: "approval_required", next: { label: "Approve position #1469882" } });
    // The simulation of the prepared step goes to the position manager.
    const chain = fakeChain();
    await prepareNext(lc({ rates: rates(), chain }), borrowing);
    expect((chain.simulated as Call[]).map((c) => c.to.toLowerCase())).toEqual([UNI_NFPM]);
  });
});

describe("curators' vaults, mandates and stock LPs (D318)", () => {
  const sd = () => parseDeployment(lpStockManifest());
  /** The lane's vault and one a curator opened through the factory: "Stock LP", funding the NVDA pool now and the SPY pool in an hour. */
  const STOCK_VAULT = { ...LP_VAULT_STATE, mandate: [{ adapter: UNI_ADAPTER, pool: NVDA_POOL, activeAt: NOW - 60 }, { adapter: V4_ADAPTER, pool: SPY_POOL, activeAt: NOW + 3_600 }] };
  const curated = (over: Record<string, unknown> = {}) => fakeChain({
    lpFactoryVaults: () => Promise.resolve([{ address: FACTORY_VAULT, name: "Stock LP" }]),
    lpFactoryVault: (_f: Address, v: Address) => Promise.resolve(v.toLowerCase() === FACTORY_VAULT ? "Stock LP" : null),
    lpVault: (v: Address) => Promise.resolve(v.toLowerCase() === FACTORY_VAULT ? STOCK_VAULT : LP_VAULT_STATE),
    ...over,
  });
  const sc = (over: { chain?: Chain; rates?: Upstream } = {}) => ctx({ d: sd(), chain: curated(), ...over });

  it("reads the lane's vault factory from the release, and lists its vaults beside the manifest's with their curator and mandate in plain words", async () => {
    expect(sd().lpLane!.vaultFactory).toBe(getAddress(LP_FACTORY));
    const r = await lpVaults(sc());
    expect(r.vaults.map((v) => [v.name, v.factory, v.allowed, v.lends])).toEqual([["WETH/USDG LP lane", false, true, true], ["Stock LP", true, true, true]]);
    const stock = r.vaults[1]!;
    expect(stock).toMatchObject({ vault: getAddress(FACTORY_VAULT), curator: LP_CURATOR, mandate: [
      { adapter: UNI_ADAPTER, pool: NVDA_POOL, poolName: "Uniswap v3 NVDA/USDG 0.05%", activeAt: NOW - 60, funding: true },
      { adapter: V4_ADAPTER, pool: SPY_POOL, poolName: "SPY / USDG v4 0.3%", activeAt: NOW + 3_600, funding: false },
    ] });
    expect(stock.funds).toBe(`It funds new loans against positions in Uniswap v3 NVDA/USDG 0.05%. It funds SPY / USDG v4 0.3% from ${new Date((NOW + 3_600) * 1000).toISOString()}.`);
    expect(r.note).toContain("a pool its curator adds funds three hours later");
    // A vault the registry no longer allows is not listed (D319): its depositors find it in their portfolio.
    const removed = await lpVaults(sc({ chain: curated({ lpVaultsAllowed: (_r: Address, vs: readonly Address[]) => Promise.resolve(vs.map((v) => v.toLowerCase() !== FACTORY_VAULT)) }) }));
    expect(removed.vaults.map((v) => v.name)).toEqual(["WETH/USDG LP lane"]);
  });

  it("lists every vault the registry allows however many the factory made, and finds a wallet's shares in any it made (D319)", async () => {
    // 70 factory vaults: the 69 oldest removed by the registry's owner (spam, say), the newest a curator's.
    const made = Array.from({ length: 70 }, (_, i) => ({ address: A(0x5000 + i), name: `Vault ${i}` })), newest = made[69]!.address;
    const listed = new Set([getAddress(LP_VAULT), newest]);
    const chain = curated({
      lpFactoryVaults: () => Promise.resolve(made),
      lpVaultsAllowed: (_r: Address, vs: readonly Address[]) => Promise.resolve(vs.map((v) => listed.has(getAddress(v)))),
      // The wallet holds shares in the newest and in one the registry removed, past the 64th.
      lpShares: (v: Address) => Promise.resolve(getAddress(v) === newest || getAddress(v) === made[66]!.address ? 2n * 10n ** 18n : 0n),
    });
    expect((await lpVaults(sc({ chain }))).vaults.map((v) => v.name)).toEqual(["WETH/USDG LP lane", "Vault 69"]);
    const indexer = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } });
    const p = await portfolio(ctx({ d: sd(), chain, indexer }), WALLET);
    expect(p.lp?.vaults.map((v) => v.name)).toEqual(["Vault 66", "Vault 69"]);
  });

  it("lists the factory's vaults alone for a lane with none of its own (D319)", async () => {
    const m = lpStockManifest();
    const own = parseDeployment({ ...m, lpLane: { ...m.lpLane, vaults: [] } });
    expect(own.lpLane!.vaults).toEqual([]);
    const r = await lpVaults(ctx({ d: own, chain: curated() }));
    expect(r.vaults.map((v) => [v.name, v.factory, getAddress(v.vault)])).toEqual([["Stock LP", true, getAddress(FACTORY_VAULT)]]);
  });

  it("borrows from a factory vault the quote names, by the name it was opened with, and never from a vault the lane does not have", async () => {
    const stock = { action: "lp_borrow" as const, wallet: WALLET, adapter: UNI_ADAPTER, tokenId: "5", term: 604_800, maxCostBps: 60 };
    const chain = curated({ lpFacts: (_a: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => ({ ...LP_FACTS, pool: NVDA_POOL, token0: USDG, token1: NVDA }))) });
    const p = await plan(sc({ chain, rates: rates({ vault: FACTORY_VAULT }) }), stock);
    expect(p.view).toMatchObject({ vault: getAddress(FACTORY_VAULT), vaultName: "Stock LP", poolName: "Uniswap v3 NVDA/USDG 0.05%" });
    expect(p.summary.rows).toContainEqual({ label: "Lent by", value: "Stock LP" });
    expect((await lpQuote(sc({ chain, rates: rates({ vault: FACTORY_VAULT }) }), { adapter: UNI_ADAPTER, tokenId: "5", wallet: WALLET, term: 604_800, vault: FACTORY_VAULT })).vaultName).toBe("Stock LP");
    expect(await code(plan(sc({ chain, rates: rates({ vault: A(0x999) }) }), stock))).toBe("PLAN_MISMATCH");
    expect(await code(lpQuote(sc({ chain }), { adapter: UNI_ADAPTER, tokenId: "5", wallet: WALLET, term: 604_800, vault: A(0x999) }))).toBe("UNKNOWN_VAULT");
    // The mandate and closed-market refusals, in fixed words.
    expect(await refusal(plan(sc({ chain, rates: rates({ refusal: "VAULT_CANNOT_FUND" }) }), stock))).toMatchObject({ code: "VAULT_CANNOT_FUND", message: expect.stringContaining("mandate") as string });
    expect(await refusal(plan(sc({ chain, rates: rates({ refusal: "PRICING_UNAVAILABLE", status: 503 }) }), stock))).toMatchObject({ code: "PRICING_UNAVAILABLE", message: expect.stringContaining("market is open") as string });
  });

  it("deposits into a factory vault, and refuses one the registry no longer lets lend", async () => {
    const depositing = { action: "lp_deposit" as const, wallet: WALLET, vault: FACTORY_VAULT, amount: "1000000000" };
    const p = await plan(sc(), depositing);
    expect(p.view).toMatchObject({ vault: getAddress(FACTORY_VAULT), name: "Stock LP" });
    expect(p.summary.rows.find((r) => r.label === "What it lends against")!.value).toMatch(/^It funds new loans against positions in Uniswap v3 NVDA\/USDG 0\.05%\. It funds SPY/);
    expect(await code(plan(sc({ chain: curated({ lpVaultsAllowed: () => Promise.resolve([false]) }) }), depositing))).toBe("VAULT_NOT_LENDING");
    expect(await code(plan(sc(), { ...depositing, vault: A(0x999) }))).toBe("UNKNOWN_VAULT");
  });

  it("opens a vault for a wallet the registry lets open one (a curator, or anyone once creation is open), with its fee, largest loan and the pools it funds", async () => {
    const opening = {
      action: "lp_create_vault" as const, wallet: WALLET, name: "Stock LP", performanceFeeBps: 1_000, maxLoanPrincipal: "50000000000",
      pools: [{ adapter: UNI_ADAPTER, pool: NVDA_POOL }, { adapter: V4_ADAPTER, pool: SPY_POOL }],
    };
    // mayOpenVault (D319): an allowed curator, or anyone once the registry's owner opens creation.
    const allowed = curated({ lpMayOpenVault: (_r: Address, w: Address) => Promise.resolve(w.toLowerCase() === WALLET.toLowerCase()) });
    const p = await plan(sc({ chain: allowed }), opening);
    expect(p.steps.map((x) => [x.label, x.final])).toEqual([["Open the vault", true]]);
    const tx = await p.steps[0]!.build();
    expect(tx.to.toLowerCase()).toBe(LP_FACTORY);
    expect(decodeFunctionData({ abi: lpVaultFactoryAbi, data: tx.data }).args).toEqual(["Stock LP", 1_000, 50_000_000_000n, [
      { adapter: getAddress(UNI_ADAPTER), pool: getAddress(NVDA_POOL) }, { adapter: getAddress(V4_ADAPTER), pool: getAddress(SPY_POOL) },
    ]]);
    expect(p.view).toEqual({ action: "lp_create_vault", name: "Stock LP", performanceFeeBps: 1_000, maxLoanPrincipal: "50000000000", pools: [
      { adapter: getAddress(UNI_ADAPTER), pool: getAddress(NVDA_POOL), poolName: "Uniswap v3 NVDA/USDG 0.05%" },
      { adapter: getAddress(V4_ADAPTER), pool: getAddress(SPY_POOL), poolName: "SPY / USDG v4 0.3%" },
    ] });
    expect(p.summary.rows[0]).toEqual({ label: "It lends against", value: "Positions in Uniswap v3 NVDA/USDG 0.05%, SPY / USDG v4 0.3%, and nothing else: its mandate" });
    expect(await code(plan(sc(), opening))).toBe("NOT_CURATOR");
    expect(await code(plan(sc({ chain: allowed }), { ...opening, pools: [{ adapter: UNI_ADAPTER, pool: A(0x999) }] }))).toBe("POOL_NOT_ALLOWED");
    expect(await code(plan(sc({ chain: allowed }), { ...opening, pools: [opening.pools[0]!, opening.pools[0]!] }))).toBe("INVALID_INPUT");
    expect(await code(plan(sc({ chain: allowed }), { ...opening, name: "x".repeat(33).replace(/x/g, "é") }))).toBe("INVALID_INPUT");
    expect(await code(plan(sc({ chain: allowed }), { ...opening, maxLoanPrincipal: "10000000000001" }))).toBe("INVALID_INPUT");
    expect(await code(plan(lc({ chain: allowed }), opening))).toBe("NO_VAULT_FACTORY");
  });

  it("adds a pool to its curator's vault, funding three hours later, and drops one at once; refused for anyone else or a pool in it, or not", async () => {
    const mine = curated({ lpVault: () => Promise.resolve({ ...STOCK_VAULT, curator: WALLET }) });
    const adding = { action: "lp_vault_add_pool" as const, wallet: WALLET, vault: FACTORY_VAULT, adapter: V4_ADAPTER, pool: V4_POOL };
    const p = await plan(sc({ chain: mine }), adding);
    expect(p.steps.map((x) => x.label)).toEqual(["Add ETH / USDG v4 0.05%"]);
    expect(decodeFunctionData({ abi: lpVaultAbi, data: (await p.steps[0]!.build()).data })).toMatchObject({ functionName: "addPool", args: [getAddress(V4_ADAPTER), getAddress(V4_POOL)] });
    expect(p.view).toMatchObject({ action: "lp_vault_add_pool", name: "Stock LP", poolName: "ETH / USDG v4 0.05%", fundsFrom: NOW + 3 * 3_600 });
    expect(await code(plan(sc(), adding))).toBe("NOT_CURATOR");
    expect(await code(plan(sc({ chain: mine }), { ...adding, pool: SPY_POOL }))).toBe("POOL_IN_MANDATE");
    const full = curated({ lpVault: () => Promise.resolve({ ...STOCK_VAULT, curator: WALLET, mandate: Array.from({ length: 32 }, (_, n) => ({ adapter: UNI_ADAPTER, pool: A(0x500 + n), activeAt: 1 })) }) });
    expect(await code(plan(sc({ chain: full }), adding))).toBe("TOO_MANY_POOLS");
    const dropping = { action: "lp_vault_remove_pool" as const, wallet: WALLET, vault: FACTORY_VAULT, adapter: UNI_ADAPTER, pool: NVDA_POOL };
    const drop = await plan(sc({ chain: mine }), dropping);
    expect(decodeFunctionData({ abi: lpVaultAbi, data: (await drop.steps[0]!.build()).data })).toMatchObject({ functionName: "removePool", args: [getAddress(UNI_ADAPTER), getAddress(NVDA_POOL)] });
    expect(drop.summary.rows).toEqual([{ label: "New loans there", value: "None from now: it stops at once" }, { label: "Loans already open", value: "Run to their ends, as agreed" }]);
    expect(await code(plan(sc({ chain: mine }), { ...dropping, pool: UNI_POOL }))).toBe("POOL_NOT_IN_MANDATE");
  });

  it("lists stock LPs in either token order, valued at their pool's price: NVDA/USDG on Uniswap v3 (USDG token0) and SPY/USDG on Uniswap v4", async () => {
    const facts = { tickLower: -60_000, tickUpper: 60_000, liquidity: 10n ** 15n };
    const chain = curated({
      ownedPositions: (manager: Address) => Promise.resolve(manager.toLowerCase() === UNI_NFPM ? { total: 1n, ids: [5n], enumerable: true } : { total: 0n, ids: [], enumerable: true }),
      lpFacts: (adapter: Address, ids: readonly bigint[]) => Promise.resolve(ids.map(() => (adapter.toLowerCase() === V4_ADAPTER
        ? { pool: SPY_POOL, token0: SPY, token1: USDG, ...facts } : { pool: NVDA_POOL, token0: USDG, token1: NVDA, ...facts }))),
      tokenInfo: (t: Address) => Promise.resolve({ symbol: t.toLowerCase() === NVDA ? "NVDA" : "SPY", decimals: 18 }),
    });
    const indexer = fakeUpstream({ "/lp/positions?": { owner: WALLET.toLowerCase(), block: "1", incomplete: false, positions: [{ adapter: V4_ADAPTER, kind: "uniswap-v4", tokenId: "9" }] } });
    const r = await lpPositions(ctx({ d: sd(), chain, indexer }), WALLET);
    expect(r.positions.map((p) => [p.poolName, p.token0.symbol, p.token1.symbol, p.borrowable])).toEqual([
      ["Uniswap v3 NVDA/USDG 0.05%", "USDG", "NVDA", true], ["SPY / USDG v4 0.3%", "SPY", "USDG", true],
    ]);
    for (const p of r.positions) {
      const usdgFirst = p.token0.symbol === "USDG";
      expect(BigInt(p.valueUSDG!)).toBe(valueInUsdg(USDG, usdgFirst ? USDG : SPY, usdgFirst ? NVDA : USDG, BigInt(p.amount0 ?? "0"), BigInt(p.amount1 ?? "0"), usdgFirst ? LP_PRICE.sqrtPriceX96 : POOL.sqrtPriceX96));
      expect(BigInt(p.valueUSDG!) > 0n).toBe(true);
    }
  });
});

// Reserve vaults (D454; docs/api.md "LP lane", Reserve vaults): built, not deployed. An LPVault reads and acts as before.
describe("reserve vaults (D454)", () => {
  const rc = (over: { chain?: Chain; indexer?: Upstream } = {}) => ctx({ d: parseDeployment(lpRewardsManifest()), ...over });
  /** The fixture's vault as a reserve vault: its companion answers, 10,000 USDG of its 200,000 is cash. */
  const reserve = (over: Partial<typeof LP_VAULT_STATE> = {}, chain: Record<string, unknown> = {}) => fakeChain({
    lpVault: () => Promise.resolve({ ...LP_RESERVE_VAULT_STATE, ...over }), lpCompanion: () => Promise.resolve(LP_COMPANION), ...chain,
  });
  const failing = () => Promise.reject(new Error("execution reverted"));

  describe("the lane's rewards bridge and older factories", () => {
    it("reads them from the release, none where it names none", () => {
      expect(parseDeployment(lpRewardsManifest()).lpLane).toMatchObject({ rewardsBridge: getAddress(LP_BRIDGE), retiredVaultFactories: [] });
      expect(d().lpLane).toMatchObject({ rewardsBridge: null, retiredVaultFactories: [] });
      const m = lpManifest();
      expect(parseDeployment({ ...m, lpLane: { ...m.lpLane, retiredVaultFactories: [A(0x153)] } }).lpLane!.retiredVaultFactories).toEqual([getAddress(A(0x153))]);
    });

    it("serves the sGAGE claim only where the release names the bridge, so no deployment's catalogue changes before then", () => {
      expect(actionsOn(parseDeployment(lpRewardsManifest()))).toContain("lp_claim_rewards");
      expect(actionsOn(d())).not.toContain("lp_claim_rewards");
      // Mainnet's release names its bridge since the switch of 7 November 2026 (D454).
      expect(actionsOn(parseDeployment(MAINNET_MANIFEST))).toContain("lp_claim_rewards");
      const names = (c: ReturnType<typeof ctx>) => gageTools(gageFrom(c), { signer: fakeSigner() }).map((t) => t.name).filter((n) => n.includes("claim_rewards"));
      expect(names(rc())).toEqual(["gage_prepare_lp_claim_rewards", "gage_lp_claim_rewards"]);
      expect(names(lc())).toEqual([]);
    });
  });

  describe("what lpVaults reports", () => {
    it("reads an LPVault as before: no reserve, its figures and its note unchanged", async () => {
      const r = await lpVaults(lc());
      expect(r.vaults[0]).toMatchObject({ totalAssetsUSDG: "200000000000", freeCashUSDG: "200000000000", usdgPerShare: "1000000", takesDeposits: true, paysOut: true });
      expect(r.vaults[0]).not.toHaveProperty("reserve");
      expect(r.note).not.toContain("reserve");
    });

    it("reports a reserve vault's liquidity, reserve and minimum cost, raw, beside its free cash", async () => {
      const r = await lpVaults(lc({ chain: reserve() }));
      expect(r.vaults[0]).toMatchObject({
        freeCashUSDG: "10000000000", totalAssetsUSDG: "200000000000", takesDeposits: true, paysOut: true,
        reserve: {
          companion: LP_COMPANION, token: LP_RESERVE_TOKEN, shares: "148000000000000000000000", value: "150000000000", payable: "150000000000", freeLiquidity: "160000000000",
          bufferBps: 500, minCostBpsPerYear: 400, closed: false, rewardsAccounted: "7000000000000000000",
        },
      });
      expect(r.note).toContain("reserve.freeLiquidity");
      expect(r.note).toContain("lp_claim_rewards");
      expect(r.note).not.toMatch(/\b(yield|interest|stake|staking|APY)\b/i);
    });

    it("keeps a reserve vault listed when its companion's reads fail, those figures null", async () => {
      const unread = { ...LP_RESERVE_STATE, token: null, shares: null, value: null, payable: null, freeLiquidity: null, bufferBps: null, minCostBpsPerYear: null, closed: null, rewardsAccounted: null };
      const r = await lpVaults(lc({ chain: reserve({ reserve: unread }) }));
      expect(r.vaults[0]).toMatchObject({
        vault: getAddress(LP_VAULT), freeCashUSDG: "10000000000",
        reserve: { companion: LP_COMPANION, token: null, shares: null, value: null, payable: null, freeLiquidity: null, bufferBps: null, minCostBpsPerYear: null, closed: null, rewardsAccounted: null },
      });
    });

    it("keeps every vault listed while a reserve's conversion fails, where a reserve vault's totalAssets and previews revert", async () => {
      const chain = fakeChain({
        lpFactoryVaults: () => Promise.resolve([{ address: FACTORY_VAULT, name: "Reserve LP" }]),
        lpVault: (v: Address) => Promise.resolve(v.toLowerCase() === FACTORY_VAULT ? { ...LP_RESERVE_VAULT_STATE, totalAssets: null, reserve: { ...LP_RESERVE_STATE, value: null, payable: null } } : LP_VAULT_STATE),
        lpPreviewRedeem: (v: Address, shares: bigint) => (v.toLowerCase() === FACTORY_VAULT ? failing() : Promise.resolve(shares / 10n ** 6n)),
      });
      const r = await lpVaults(ctx({ d: parseDeployment(lpStockManifest()), chain }));
      expect(r.vaults.map((v) => [v.name, v.totalAssetsUSDG, v.usdgPerShare, v.takesDeposits, v.paysOut])).toEqual([
        ["WETH/USDG LP lane", "200000000000", "1000000", true, true], ["Reserve LP", null, null, false, false],
      ]);
    });

    it("still fails where an LPVault's preview fails: it never reverts, so that is the chain's failure", async () => {
      await expect(lpVaults(lc({ chain: fakeChain({ lpPreviewRedeem: failing }) }))).rejects.toThrow("execution reverted");
    });
  });

  describe("a wallet's portfolio", () => {
    const indexer = fakeUpstream({ "/v2/positions?": { items: [], nextCursor: null }, "/intent/partners/vaults?": { items: [], nextCursor: null } });

    it("leaves an LPVault's holding as it reads, with no sGAGE and no word of it", async () => {
      const p = await portfolio(lc({ chain: fakeChain({ lpShares: () => Promise.resolve(5n * 10n ** 15n) }), indexer }), WALLET);
      expect(p.lp?.vaults).toEqual([{ vault: getAddress(LP_VAULT), name: "WETH/USDG LP lane", shares: "5000000000000000", shareDecimals: 12, valueUSDG: "5000000000", bonuses: [] }]);
      expect(p.note).not.toContain("lp_claim_rewards");
    });

    it("adds a reserve vault's sGAGE to claim, read from its companion for the wallet", async () => {
      const asked: [Address, Address][] = [];
      const chain = reserve({}, {
        lpShares: () => Promise.resolve(5n * 10n ** 15n), lpRewardClaimable: (companion: Address, wallet: Address) => { asked.push([companion, wallet]); return Promise.resolve(2n * 10n ** 18n); },
      });
      const p = await portfolio(lc({ chain, indexer }), WALLET);
      expect(asked).toEqual([[LP_COMPANION, WALLET]]);
      expect(p.lp?.vaults).toMatchObject([{ shares: "5000000000000000", valueUSDG: "5000000000", sgageClaimable: "2000000000000000000" }]);
      expect(p.note).toContain("lp_claim_rewards");
    });

    it("keeps a vault held while sGAGE waits for a wallet that no longer holds shares, and leaves out one with neither", async () => {
      const claim = (raw: bigint) => reserve({}, { lpRewardClaimable: () => Promise.resolve(raw) });
      expect((await portfolio(lc({ chain: claim(1n), indexer }), WALLET)).lp?.vaults).toMatchObject([{ shares: "0", valueUSDG: "0", sgageClaimable: "1" }]);
      expect((await portfolio(lc({ chain: claim(0n), indexer }), WALLET)).lp?.vaults).toEqual([]);
    });

    it("answers a holding's unread parts as null rather than failing the portfolio: a reserve vault's preview or its sGAGE", async () => {
      const chain = reserve({}, { lpShares: () => Promise.resolve(5n * 10n ** 15n), lpPreviewRedeem: failing, lpRewardClaimable: failing });
      expect((await portfolio(lc({ chain, indexer }), WALLET)).lp?.vaults).toMatchObject([{ shares: "5000000000000000", valueUSDG: null, sgageClaimable: null }]);
    });
  });

  describe("a redemption", () => {
    const redeeming = { action: "lp_redeem" as const, wallet: WALLET, vault: LP_VAULT };
    /** A wallet with 50,000 USDG of shares in a vault with 10,000 USDG of free cash, whose maxRedeem says 40,000 USDG's. */
    const HELD = 5n * 10n ** 16n, MOST = 4n * 10n ** 16n;
    const holding = (most: bigint = MOST, chain: Record<string, unknown> = {}) => reserve({}, { lpShares: () => Promise.resolve(HELD), lpMaxRedeem: () => Promise.resolve(most), ...chain });

    it("pays above the free cash, up to maxRedeem", async () => {
      const p = await plan(lc({ chain: holding() }), { ...redeeming, shares: String(3n * 10n ** 16n) });
      expect(p.view).toMatchObject({ shares: "30000000000000000", assets: "30000000000", minAssets: "29850000000", all: false });
      expect(decodeFunctionData({ abi: lpVaultAbi, data: (await p.steps[0]!.build()).data }))
        .toMatchObject({ functionName: "redeem", args: [3n * 10n ** 16n, getAddress(WALLET), getAddress(WALLET), 29_850_000_000n] });
      expect((await plan(lc({ chain: holding() }), { ...redeeming, shares: String(MOST) })).view).toMatchObject({ shares: String(MOST), assets: "40000000000" });
    });

    it("refuses shares named above maxRedeem, saying what the vault can pay", async () => {
      expect(await refusal(plan(lc({ chain: holding() }), { ...redeeming, shares: String(MOST + 1n) })))
        .toMatchObject({ code: "INSUFFICIENT_LIQUIDITY", message: "The vault can pay 40,000.00 USDG now; redeem fewer shares", details: { availableNow: "40000000000" } });
    });

    it("cuts everything to a basis point under maxRedeem where the vault's liquidity limits it, as a share's value grows while the transaction is on its way", async () => {
      const p = await plan(lc({ chain: holding() }), redeeming);
      expect(p.view).toMatchObject({ shares: "39996000000000000", assets: "39996000000", all: false });
      expect(p.summary.rows[0]).toEqual({ label: "You redeem", value: "39,996 shares (all the vault can pay now)" });
      expect(p.notes).toEqual(["The rest stays in the vault until its cash and reserve can pay it."]);
    });

    it("redeems every share, uncut, where maxRedeem covers the holding", async () => {
      const p = await plan(lc({ chain: holding(HELD) }), redeeming);
      expect(p.view).toMatchObject({ shares: String(HELD), assets: "50000000000", all: true });
      expect(p.notes).toEqual([]);
    });

    it("refuses when maxRedeem is 0, as it is while the reserve cannot be read, without asking a preview that would revert", async () => {
      const chain = holding(0n, { lpPreviewRedeem: failing });
      expect(await refusal(plan(lc({ chain }), redeeming))).toMatchObject({ code: "INSUFFICIENT_LIQUIDITY", details: { availableNow: "0" } });
      expect(await refusal(plan(lc({ chain }), { ...redeeming, shares: "1" }))).toMatchObject({ code: "INSUFFICIENT_LIQUIDITY", details: { availableNow: "0" } });
    });

    it("is refused while impaired or for more than the wallet holds", async () => {
      expect(await code(plan(lc({ chain: reserve({ impaired: true }, { lpShares: () => Promise.resolve(HELD) }) }), redeeming))).toBe("VAULT_IMPAIRED");
      expect(await code(plan(lc({ chain: holding() }), { ...redeeming, shares: String(HELD + 1n) }))).toBe("EXCEEDS_BALANCE");
    });

    it("leaves an LPVault on its free cash: refused above it, with no maxRedeem asked", async () => {
      const asked: Address[] = [];
      const chain = fakeChain({
        lpVault: () => Promise.resolve({ ...LP_VAULT_STATE, freeCash: 2_000_000_000n }), lpShares: () => Promise.resolve(5n * 10n ** 15n),
        lpMaxRedeem: (v: Address) => { asked.push(v); return Promise.resolve(5n * 10n ** 15n); },
      });
      expect(await refusal(plan(lc({ chain }), { ...redeeming, shares: "3000000000000000" }))).toMatchObject({ code: "INSUFFICIENT_LIQUIDITY", details: { availableNow: "2000000000" } });
      expect(asked).toEqual([]);
    });
  });

  describe("a deposit", () => {
    const depositing = { action: "lp_deposit" as const, wallet: WALLET, vault: LP_VAULT, amount: "1000000000" };
    const row = async (chain: Chain, label: string) => (await plan(lc({ chain }), depositing)).summary.rows.find((r) => r.label === label)?.value;
    const removed = { lpVaultsAllowed: () => Promise.resolve([false]) };

    it("says a reserve vault's cash and reserve pay it out, and an LPVault's free cash still", async () => {
      expect(await row(reserve(), "Taking it out")).toBe("Any time the vault is not impaired, up to what its cash and its reserve can pay");
      expect(await row(fakeChain(), "Taking it out")).toBe("Any time the vault is not impaired, up to its free cash");
      expect(await row(reserve(), "While it waits for a loan")).toContain("its reserve");
      expect(await row(fakeChain(), "While it waits for a loan")).toBeUndefined();
    });

    it("no longer says cash would sit idle on a reserve vault the registry removed, still refused; an LPVault's words stay", async () => {
      const held = await refusal(plan(lc({ chain: reserve({}, removed) }), depositing));
      expect(held).toMatchObject({ code: "VAULT_NOT_LENDING" });
      expect(held!.message).not.toContain("idle");
      const old = await refusal(plan(lc({ chain: fakeChain(removed) }), depositing));
      expect(old).toMatchObject({ code: "VAULT_NOT_LENDING", message: "gage's registry no longer lets this vault fund new loans: a deposit would sit idle. Its open loans run to their ends" });
    });
  });

  describe("claiming a holder's sGAGE", () => {
    const claiming = { action: "lp_claim_rewards" as const, wallet: WALLET, vault: LP_VAULT };
    const owed = (raw: bigint) => reserve({}, { lpRewardClaimable: (_c: Address, _w: Address) => Promise.resolve(raw) });

    it("calls the vault's companion for the wallet's own sGAGE, one step, moving no USDG", async () => {
      const p = await plan(rc({ chain: owed(12n * 10n ** 18n + 5n * 10n ** 17n) }), claiming);
      expect(p.view).toEqual({ action: "lp_claim_rewards", vault: getAddress(LP_VAULT), name: "WETH/USDG LP lane", companion: LP_COMPANION, amount: "12500000000000000000" });
      expect(p.summary.title).toBe("Claim 12.5 sGAGE from WETH/USDG LP lane (" + `${getAddress(LP_VAULT).slice(0, 6)}…${getAddress(LP_VAULT).slice(-4)})`);
      expect(p.summary.rows[0]).toEqual({ label: "You receive", value: "12.5 sGAGE" });
      expect(p.steps.map((s) => [s.label, s.kind, s.final])).toEqual([["Claim 12.5 sGAGE", "action", true]]);
      const tx = await p.steps[0]!.build();
      expect([tx.to, tx.value]).toEqual([LP_COMPANION, 0n]);
      expect(decodeFunctionData({ abi: lpCompanionAbi, data: tx.data })).toMatchObject({ functionName: "claimRewards" });
      expect((await prepareNext(rc({ chain: owed(1n) }), claiming)).status).toBe("ready");
      // A sliver under the last place shown reads in its own digits, never as none.
      expect((await plan(rc({ chain: owed(1n) }), claiming)).steps[0]!.label).toBe("Claim 0.000000000000000001 sGAGE");
    });

    it("refuses on an LPVault, which has no companion and pays no sGAGE", async () => {
      expect(await refusal(plan(rc(), claiming))).toMatchObject({ code: "NOT_RESERVE_VAULT", retryable: false });
      expect(await code(prepareNext(rc(), claiming))).toBe("NOT_RESERVE_VAULT");
    });

    it("refuses with nothing to claim, and for a vault the lane does not name", async () => {
      expect(await refusal(plan(rc({ chain: owed(0n) }), claiming))).toMatchObject({ code: "NOTHING_TO_CLAIM", retryable: false });
      expect(await code(plan(rc({ chain: owed(1n) }), { ...claiming, vault: A(0x777) }))).toBe("UNKNOWN_VAULT");
    });
  });
});
