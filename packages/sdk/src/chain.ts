import { createPublicClient, erc20Abi, http, type Address, type ContractFunctionParameters, type Hex, type Log } from "viem";
import {
  accountAbi, agentIdentityAbi, cashoutRouterAbi, engineAbi, factoryAbi, loopRouterAbi, partnerVaultAbi, privateRouterAbi, registryAbi, reputationAbi, rewardsAbi,
  rolloverRouterAbi, stateViewAbi, v3PoolAbi,
} from "./abi.js";
import { MULTICALL3 } from "./chains.js";
import { ApiError, requireThat } from "./errors.js";

export interface Call { from: Address; to: Address; data: Hex; value: bigint }
export interface Loan {
  originator: Address; account: Address; token: Address; collateralBeneficiary: Address; state: number; filled: number; term: number;
  fundingDeadline: number; fundedAt: number; closedAt: number; principal: bigint; cap: bigint; originationFee: bigint; collateral: bigint;
}
export interface TokenConfig { allowed: boolean; lane: number; minAmount: bigint; maxDealRaw: bigint; maxOpenRaw: bigint }
/** A mined transaction: who sent it where with what, whether it succeeded, its logs and its block's time (unix seconds). */
export interface Sent { from: Address; to: Address | null; input: Hex; success: boolean; logs: Log[]; at?: number }
/** A v4 pool as its StateView reports it now: slot0's price, tick and fees, and the active liquidity. */
export interface PoolState { sqrtPriceX96: bigint; tick: number; liquidity: bigint; lpFee: number; protocolFee: number }
/** A Uniswap V3 pool as it reports itself now: slot0's price and tick, the active liquidity, its fee tier in pips and its tick spacing. */
export interface V3PoolState { sqrtPriceX96: bigint; tick: number; liquidity: bigint; fee: number; tickSpacing: number }
/** Where a pool's initialized ticks are read: a Uniswap V3 pool itself, or a v4 pool through the StateView. */
export type TickSource = { kind: "v3"; pool: Address } | { kind: "v4"; stateView: Address; poolId: Hex };
/**
 * A partner vault's book at one block: what a redemption is priced on (`totalAssets`, `totalSupply`), what it is paid
 * from (`freeLiquidity`) and the principal lent out (`performingPrincipal`), which keeps the vault's last share in.
 */
export interface VaultBook { totalAssets: bigint; totalSupply: bigint; free: bigint; performing: bigint }
/** A standing roll instruction as the rollover router keeps it (`autoRolls`, D285), raw amounts in the loan's asset. */
export interface AutoRollState {
  borrower: Address; executor: Address; term: number; window: number; rollsLeft: number; withRewards: boolean; until: number; maxCost: bigint; maxTopUp: bigint;
}
/** One swap of a cash-out through gage's own routes (`GageV2CashoutRouter.Route`): kind 0 a v4 pool by its key, 1 a V3 pool by its fee tier. */
export interface CashoutRoute {
  kind: number; tokenIn: Address; tokenOut: Address; v3Fee: number;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }; minOut: bigint;
}
/** `GageV2CashoutRouter.Exit`: a cash-out through gage's own routes (`cashOutDetailed`); the two underlying minimums are ignored. */
export interface CashoutExit {
  loanId: bigint; recipient: Address; minimumNet: bigint; maxFinanceFee: bigint; minUnderlying0: bigint; minUnderlying1: bigint; deadline: bigint; routes: CashoutRoute[];
}

/** The chain reads, the simulation and the receipt wait the SDK needs, behind one seam so tests replace the RPC. */
export interface Chain {
  head(): Promise<{ number: bigint; timestamp: number }>;
  loan(engine: Address, id: bigint): Promise<Loan>;
  /** The reclaim right's holder; null once the right is burned (cancelled or closed). */
  ownerOf(engine: Address, id: bigint): Promise<Address | null>;
  /**
   * Whether one of `routers`, the private lane's on `core`, opened each of `ids` (`opened`, D201; the audit of 18 October
   * 2026, M7): true where one did; false where every one answered it did not, for a loan the core had listed by the block
   * read; null where the chain cannot say (`privateLoansFrom`). Read with the core's count and each router's core in one
   * call at one block, a slice of loans at a time.
   */
  privateLoans(core: Address, routers: readonly Address[], ids: readonly bigint[]): Promise<(boolean | null)[]>;
  released(account: Address): Promise<boolean>;
  cashCredit(engine: Address, wallet: Address): Promise<bigint>;
  tokenConfig(registry: Address, token: Address): Promise<TokenConfig>;
  terms(registry: Address): Promise<number[]>;
  feeBps(registry: Address): Promise<number>;
  paused(registry: Address): Promise<boolean>;
  balance(token: Address, wallet: Address): Promise<bigint>;
  /** The wallet's ETH, which pays its gas. */
  nativeBalance(wallet: Address): Promise<bigint>;
  allowance(token: Address, wallet: Address, spender: Address): Promise<bigint>;
  /** The pool `poolId` as `stateView` reports it: where leverage prices its purchase. */
  poolState(stateView: Address, poolId: Hex): Promise<PoolState>;
  /** The Uniswap V3 pool `pool` as it reports itself: where leverage prices a purchase through it (D242). */
  v3PoolState(pool: Address): Promise<V3PoolState>;
  /** The pool's tick bitmap word `word` (compressed tick >> 8): where a purchase larger than the active range is priced. */
  tickBitmap(source: TickSource, word: number): Promise<bigint>;
  /** The liquidity the pool gains (loses, negative) when its price crosses `tick` upward. */
  tickLiquidityNet(source: TickSource, tick: number): Promise<bigint>;
  /** The loop router's V3 factory; null for a router that buys through v4 pools only (a build from before D242). */
  loopV3Factory(router: Address): Promise<Address | null>;
  /** Whether the loop router may call `executor` for `loopVia` (D243); false for a router without executors. */
  loopExecutorAllowed(router: Address, executor: Address): Promise<boolean>;
  loanRewards(rewards: Address, id: bigint, wallet: Address): Promise<bigint>;
  /** Who may move one reclaim right (`getApproved`); the zero address when nobody is. */
  approvedFor(engine: Address, id: bigint): Promise<Address>;
  /** Whether `operator` may move every reclaim right `owner` holds on `engine` (`isApprovedForAll`). */
  approvedForAll(engine: Address, owner: Address, operator: Address): Promise<boolean>;
  /** The standing roll instruction on a loan; null when there is none. */
  autoRoll(router: Address, id: bigint): Promise<AutoRollState | null>;
  /** Whether the rollover router is paused: it then rolls nothing. */
  rolloverPaused(router: Address): Promise<boolean>;
  /** Whether a cash-out router admits `executor` for `cashOutVia`; null for a router built before D245, which has no such sale. */
  cashoutExecutorAllowed(router: Address, executor: Address): Promise<boolean | null>;
  /**
   * What `cashOutDetailed` would pay `from` through gage's own routes now, its `eth_call` read (the app's weighing of an
   * aggregator's sale, web/src/v2/CashoutFlow.tsx); null when it would revert: a route the router does not admit, a
   * right not yet approved to it, a pool that cannot carry the sale.
   */
  cashoutRouteNet(router: Address, exit: CashoutExit, from: Address): Promise<bigint | null>;
  isVault(factory: Address, vault: Address): Promise<boolean>;
  vaultCore(vault: Address): Promise<Address>;
  vaultShares(vault: Address, wallet: Address): Promise<bigint>;
  /** The vault's book, its four figures read in one call, so at one block. */
  vaultBook(vault: Address): Promise<VaultBook>;
  pocketClaimable(vault: Address, pocket: bigint, wallet: Address): Promise<bigint>;
  vaultRewards(vault: Address, wallet: Address): Promise<bigint>;
  /** What a core pays and is repaid in (`USDG()`): USDG, or its generation's lend asset (D251, Intent D55). */
  coreAsset(core: Address): Promise<Address>;
  /** What a partner vault takes and pays out (`USDG()`): its generation's lend asset. */
  vaultAsset(vault: Address): Promise<Address>;
  /** A token's symbol and decimals, for collateral a lend-asset generation names outside the release's asset list. */
  tokenInfo(token: Address): Promise<{ symbol: string; decimals: number }>;
  /** Whether `wallet` owns or operates ERC-8004 agent `agentId` (`isAuthorizedOrOwner`), whose own ratings the registry refuses. */
  agentAuthorized(identityRegistry: Address, wallet: Address, agentId: bigint): Promise<boolean>;
  /** How many ratings `wallet` has given ERC-8004 agent `agentId` (`getLastIndex`), revoked ones included. */
  feedbackCount(reputationRegistry: Address, agentId: bigint, wallet: Address): Promise<bigint>;
  /** How many transactions the wallet has sent, those still pending included: what moves once the network takes one. */
  nonce(wallet: Address): Promise<number>;
  /** Simulates and estimates gas at the head; any revert is one fixed refusal. */
  simulate(call: Call): Promise<bigint>;
  sent(hash: Hex): Promise<Sent | null>;
  /** Waits for a sent transaction: true once it succeeded, false if it reverted or another took its nonce, null if it is not mined in time. */
  wait(hash: Hex): Promise<boolean | null>;
}

/**
 * Whether a sent transaction did what it was sent to do, from the receipt its wait resolved with: that receipt is of
 * whatever took its nonce. A copy with the same calldata that only paid more for gas (`repriced`) did; one that cancelled
 * or replaced it did not, though its own receipt succeeded (the audit of 18 October 2026: a listing the wallet cancelled
 * was recorded as sent and its run as done).
 */
export function succeeded(hash: Hex, receipt: { transactionHash: Hex; status: string }, replacement: string | null): boolean {
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() && replacement !== "repriced") return false;
  return receipt.status === "success";
}

/** One read of a multicall that lets a read fail: its answer, or its failure. */
export interface Read { status: string; result?: unknown }
/** The most loans one call of `privateLoans` asks about: each slice is its own call, at its own block. */
const LANE_SLICE = 100;

/**
 * What one block's reads say of each loan id on `core` (`privateLoans`; the audit of 18 October 2026, M7): `reads` is
 * the core's `loanCount`, then each of the `routers` routers' `CORE()`, then each router's `opened(id)` for every id,
 * router by router. A router writes the loan's token, never zero, in the transaction that lists a loan it opens, and
 * never clears it: true where any router answers one. False only where every router lists on `core` and answered the
 * zero token for a loan the core had listed by that block. Null otherwise: a read that failed or is missing, a router of
 * another core, or an id past the core's count, which a node behind gage's index answers the zero token for.
 */
export function privateLoansFrom(core: Address, routers: number, ids: readonly bigint[], reads: readonly Read[]): (boolean | null)[] {
  const answer = (i: number) => {
    const r = reads[i];
    return r?.status === "success" ? r.result : undefined;
  };
  const count = answer(0);
  const serves = Array.from({ length: routers }, (_, r) => answer(1 + r)).every((x) => typeof x === "string" && x.toLowerCase() === core.toLowerCase());
  return ids.map((id, i) => {
    const tokens = Array.from({ length: routers }, (_, r) => {
      const o = answer(1 + routers + r * ids.length + i);
      return Array.isArray(o) && typeof o[0] === "string" ? o[0] : undefined;
    });
    if (tokens.some((t) => t !== undefined && BigInt(t) !== 0n)) return true;
    const listed = typeof count === "bigint" && id > 0n && id <= count;
    return serves && listed && tokens.every((t) => t !== undefined) ? false : null;
  });
}

export function createChain(rpcUrl: string, chainId: number): Chain {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }), cacheTime: 0 });
  let checked = false;
  const ready = async () => {
    if (checked) return;
    requireThat(await client.getChainId() === chainId, "CHAIN_MISMATCH", "The RPC serves another chain", 503);
    checked = true;
  };
  const read = async <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> => {
    await ready();
    // One untyped seam over viem's ABI generics; each caller names the type its ABI returns.
    return await client.readContract({ address, abi, functionName, args }) as T;
  };
  return {
    async head() {
      await ready();
      const b = await client.getBlock();
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async loan(engine, id) {
      const l = await read<Loan & { state: number }>(engine, engineAbi, "getLoan", [id]);
      requireThat(l.state !== 0, "LOAN_NOT_FOUND", "No loan has this id on this engine", 404);
      return { ...l, fundingDeadline: Number(l.fundingDeadline), fundedAt: Number(l.fundedAt), closedAt: Number(l.closedAt), term: Number(l.term) };
    },
    async ownerOf(engine, id) {
      try { return await read<Address>(engine, engineAbi, "ownerOf", [id]); } catch { return null; }
    },
    async privateLoans(core, routers, ids) {
      await ready();
      const slices = Array.from({ length: Math.ceil(ids.length / LANE_SLICE) }, (_, n) => ids.slice(n * LANE_SLICE, (n + 1) * LANE_SLICE));
      const answers = await Promise.all(slices.map(async (slice) => {
        const contracts: ContractFunctionParameters[] = [
          { address: core, abi: engineAbi, functionName: "loanCount" },
          ...routers.map((router) => ({ address: router, abi: privateRouterAbi, functionName: "CORE" })),
          ...routers.flatMap((router) => slice.map((id) => ({ address: router, abi: privateRouterAbi, functionName: "opened", args: [id] }))),
        ];
        // Never split (batchSize 0): the slice's count and routers' cores vouch for its answers only at the same block.
        const reads = await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0, contracts });
        return privateLoansFrom(core, routers.length, slice, reads);
      }));
      return answers.flat();
    },
    released: (account) => read<boolean>(account, accountAbi, "released"),
    cashCredit: (engine, wallet) => read<bigint>(engine, engineAbi, "cashCredit", [wallet]),
    tokenConfig: (registry, token) => read<TokenConfig>(registry, registryAbi, "getERC20Config", [token]),
    terms: async (registry) => (await read<readonly number[]>(registry, registryAbi, "allowedTerms")).map(Number),
    feeBps: async (registry) => Number(await read<number>(registry, registryAbi, "feeBps")),
    paused: (registry) => read<boolean>(registry, registryAbi, "newDealsPaused"),
    balance: (token, wallet) => read<bigint>(token, erc20Abi, "balanceOf", [wallet]),
    async nativeBalance(wallet) {
      await ready();
      return client.getBalance({ address: wallet });
    },
    allowance: (token, wallet, spender) => read<bigint>(token, erc20Abi, "allowance", [wallet, spender]),
    async poolState(stateView, poolId) {
      const [slot0, liquidity] = await Promise.all([
        read<readonly [bigint, number, number, number]>(stateView, stateViewAbi, "getSlot0", [poolId]),
        read<bigint>(stateView, stateViewAbi, "getLiquidity", [poolId]),
      ]);
      return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity, protocolFee: Number(slot0[2]), lpFee: Number(slot0[3]) };
    },
    async v3PoolState(pool) {
      const [slot0, liquidity, fee, tickSpacing] = await Promise.all([
        read<readonly [bigint, number, number, number, number, number, boolean]>(pool, v3PoolAbi, "slot0"),
        read<bigint>(pool, v3PoolAbi, "liquidity"),
        read<number>(pool, v3PoolAbi, "fee"),
        read<number>(pool, v3PoolAbi, "tickSpacing"),
      ]);
      return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity, fee: Number(fee), tickSpacing: Number(tickSpacing) };
    },
    tickBitmap: (source, word) => (source.kind === "v3"
      ? read<bigint>(source.pool, v3PoolAbi, "tickBitmap", [word])
      : read<bigint>(source.stateView, stateViewAbi, "getTickBitmap", [source.poolId, word])),
    async tickLiquidityNet(source, tick) {
      if (source.kind === "v3") return (await read<readonly [bigint, bigint, ...unknown[]]>(source.pool, v3PoolAbi, "ticks", [tick]))[1];
      return (await read<readonly [bigint, bigint]>(source.stateView, stateViewAbi, "getTickLiquidity", [source.poolId, tick]))[1];
    },
    async loopV3Factory(router) {
      try { return await read<Address>(router, loopRouterAbi, "V3_FACTORY"); } catch { return null; }
    },
    async loopExecutorAllowed(router, executor) {
      try { return await read<boolean>(router, loopRouterAbi, "executorAllowed", [executor]); } catch { return false; }
    },
    loanRewards: (rewards, id, wallet) => read<bigint>(rewards, rewardsAbi, "claimable", [id, wallet]),
    async approvedFor(engine, id) {
      try { return await read<Address>(engine, engineAbi, "getApproved", [id]); } catch { return "0x0000000000000000000000000000000000000000"; }
    },
    approvedForAll: (engine, owner, operator) => read<boolean>(engine, engineAbi, "isApprovedForAll", [owner, operator]),
    async autoRoll(router, id) {
      const [borrower, term, window, rollsLeft, withRewards, executor, until, maxCost, maxTopUp] =
        await read<readonly [Address, number, number, number, boolean, Address, number, bigint, bigint]>(router, rolloverRouterAbi, "autoRolls", [id]);
      if (BigInt(borrower) === 0n) return null;
      return { borrower, executor, term: Number(term), window: Number(window), rollsLeft: Number(rollsLeft), withRewards, until: Number(until), maxCost, maxTopUp };
    },
    rolloverPaused: (router) => read<boolean>(router, rolloverRouterAbi, "paused"),
    async cashoutExecutorAllowed(router, executor) {
      try { return await read<boolean>(router, cashoutRouterAbi, "executorAllowed", [executor]); } catch { return null; }
    },
    async cashoutRouteNet(router, exit, from) {
      await ready();
      try {
        const { result } = await client.simulateContract({ address: router, abi: cashoutRouterAbi, functionName: "cashOutDetailed", args: [exit], account: from });
        return result[3];
      } catch { return null; }
    },
    isVault: (factory, vault) => read<boolean>(factory, factoryAbi, "isVault", [vault]),
    vaultCore: (vault) => read<Address>(vault, partnerVaultAbi, "VAULT"),
    vaultShares: (vault, wallet) => read<bigint>(vault, partnerVaultAbi, "balanceOf", [wallet]),
    async vaultBook(vault) {
      await ready();
      const at = { address: vault, abi: partnerVaultAbi } as const;
      const [totalAssets, totalSupply, free, performing] = await client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: false,
        contracts: [
          { ...at, functionName: "totalAssets" }, { ...at, functionName: "totalSupply" },
          { ...at, functionName: "freeLiquidity" }, { ...at, functionName: "performingPrincipal" },
        ],
      });
      return { totalAssets, totalSupply, free, performing };
    },
    pocketClaimable: (vault, pocket, wallet) => read<bigint>(vault, partnerVaultAbi, "pocketClaimable", [pocket, wallet]),
    vaultRewards: (vault, wallet) => read<bigint>(vault, partnerVaultAbi, "rewardClaimable", [wallet]),
    coreAsset: (core) => read<Address>(core, engineAbi, "USDG"),
    vaultAsset: (vault) => read<Address>(vault, partnerVaultAbi, "USDG"),
    async tokenInfo(token) {
      const [symbol, decimals] = await Promise.all([read<string>(token, erc20Abi, "symbol"), read<number>(token, erc20Abi, "decimals")]);
      return { symbol, decimals: Number(decimals) };
    },
    agentAuthorized: (identityRegistry, wallet, agentId) => read<boolean>(identityRegistry, agentIdentityAbi, "isAuthorizedOrOwner", [wallet, agentId]),
    feedbackCount: (reputationRegistry, agentId, wallet) => read<bigint>(reputationRegistry, reputationAbi, "getLastIndex", [agentId, wallet]),
    async nonce(wallet) {
      await ready();
      return client.getTransactionCount({ address: wallet, blockTag: "pending" });
    },
    async simulate(call) {
      await ready();
      const request = { account: call.from, to: call.to, data: call.data, value: call.value };
      try {
        await client.call(request);
        return await client.estimateGas(request);
      } catch {
        // The RPC's own message can carry its URL; the agent gets fixed words (D221).
        throw new ApiError("SIMULATION_FAILED", "The transaction would revert now; check balances, allowances and the loan's state", 409);
      }
    },
    async sent(hash) {
      await ready();
      try {
        const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        return { from: tx.from, to: tx.to ?? null, input: tx.input, success: receipt.status === "success", logs: receipt.logs, at: Number(block.timestamp) };
      } catch { return null; }
    },
    async wait(hash) {
      await ready();
      try {
        let replacement: string | null = null;
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 1_000, onReplaced: (r) => { replacement = r.reason; } });
        return succeeded(hash, receipt, replacement);
      } catch { return null; }
    },
  };
}
