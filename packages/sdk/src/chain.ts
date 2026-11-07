import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, createPublicClient, erc20Abi, getAbiItem, http, toHex, type Address, type ContractFunctionParameters, type Hex, type Log } from "viem";
import { simulateCalls } from "viem/actions";
import {
  accountAbi, accrualAbi, agentIdentityAbi, assetPolicyAbi, cashoutRouterAbi, clPoolAbi, engineAbi, exitDeskAbi, exitFactoryAbi, exitVaultAbi, fablesHookAbi, fablesWrapperAbi, factoryAbi,
  flashSourceAbi, generationDeployerAbi, lenderMarketAbi, loopRouterAbi, lpAdapterAbi, lpCoreAbi, lpRegistryAbi, lpReserveVaultAbi, rehypoSourceAbi, shareViewsAbi, lpVaultAbi, lpCompanionAbi, lpVaultFactoryAbi, partnerVault4626Abi, partnerVaultAbi, permit2Abi, positionManagerAbi, privateRouterAbi, ramsesManagerAbi, registryAbi, reputationAbi, rewardsAbi,
  rolloverRouterAbi, stateViewAbi, stockTokenAbi, v3ManagerAbi, v3PoolAbi, v4ManagerAbi, vaultManagerAbi,
} from "./abi.js";
import { MULTICALL3, robinhoodMainnet, robinhoodTestnet } from "./chains.js";
import { MAINNET, TESTNET } from "./deployment.js";
import type { ExitAsk, ExitRecord, ExitShare } from "./exitChoice.js";
import { ApiError, requireThat } from "./errors.js";

export interface Call { from: Address; to: Address; data: Hex; value: bigint }
export interface Loan {
  originator: Address; account: Address; token: Address; collateralBeneficiary: Address; state: number; filled: number; term: number;
  fundingDeadline: number; fundedAt: number; closedAt: number; principal: bigint; cap: bigint; originationFee: bigint; collateral: bigint;
}
export interface TokenConfig { allowed: boolean; lane: number; minAmount: bigint; maxDealRaw: bigint; maxOpenRaw: bigint }
/** A partner vault factory as pool vault creation checks it (D333): its core, its version, the caller's admission, whether
 * creation is open to anyone (Intent D43; on mainnet since 5 November 2026, root D424) and each token's category. */
export interface IntentFactoryState { core: Address; mandateVersion: number; isCreator: boolean; openCreation: boolean; categories: (number | null)[] }
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

/**
 * One loan of the LP lane's core as it stores it (`LPCore.loan`, docs/api.md "LP lane"): its state 0 NONE (no such
 * loan), 1 ACTIVE, 2 REPAID, 3 DEFAULTED, 4 ABANDONED, 5 ROLLED; `end` and `start` in Unix seconds.
 */
export interface LpLoan {
  id: bigint; borrower: Address; vault: Address; adapter: Address; escrow: Address; pool: Address; tokenId: bigint;
  principal: bigint; repayment: bigint; start: number; end: number; state: number; positionReturned: boolean;
}
/** What an LP position adapter reads of one position (`facts`): its pool, tokens, range and liquidity. */
export interface LpFacts { pool: Address; token0: Address; token1: Address; tickLower: number; tickUpper: number; liquidity: bigint }
/** The LP registry's settings a new loan meets, read at one block. */
export interface LpRegistryState { terms: number[]; feeBps: number; ltvCapBps: number; newLoansPaused: boolean }
/** A pool's admission and caps under one adapter (`LPRegistry.poolConfig`). */
export interface LpPoolConfig { allowed: boolean; minHalfWidthTicks: number; minLoanPrincipal: bigint; maxLoanPrincipal: bigint; maxOutstanding: bigint }
/** One pool of an LP vault's mandate (D318): under which adapter, and from when it funds new loans (Unix seconds). */
export interface LpMandatePool { adapter: Address; pool: Address; activeAt: number }
/**
 * A reserve vault's companion (D454), read apart from the vault: its reserve's token, the reserve shares it holds, what they
 * are worth and what the reserve can pay of them, what the vault can pay out now (`freeLiquidity`: cash and reserve, past
 * credits and bonuses), what its curator set, and the sGAGE indexed and not yet claimed. Each null where its read failed.
 */
export interface LpReserveState {
  companion: Address; token: Address | null; shares: bigint | null; value: bigint | null; payable: bigint | null; freeLiquidity: bigint | null;
  bufferBps: number | null; minCostBpsPerYear: number | null; closed: boolean | null; rewardsAccounted: bigint | null;
}
/**
 * An LP vault's book and switches, read in one call, so at one block; its curator, its mandate (D318: the pools it
 * funds, null for a vault that names none) and its reserve (D454: null for an LPVault).
 */
export interface LpVaultState {
  /**
   * `totalShares` is the share token's `totalSupply()` (D319). `totalAssets` is null only on a reserve vault, whose
   * `totalAssets` reverts while reserve shares are held and the reserve's conversion fails; an LPVault's never does.
   */
  asset: Address; core: Address; totalAssets: bigint | null; freeCash: bigint; totalShares: bigint; outstandingPrincipal: bigint; bonusHeld: bigint;
  impaired: boolean; depositsClosed: boolean; fundingPaused: boolean; maxLoanPrincipal: bigint; performanceFeeBps: number; openLoans: number;
  curator: Address; mandate: LpMandatePool[] | null; reserve: LpReserveState | null;
}
/** The positions an ERC-721 position manager says `owner` holds: their count and the ids read, newest first; `enumerable` false where it cannot list them. */
export interface OwnedPositions { total: bigint; ids: bigint[]; enumerable: boolean }
/**
 * One holder's Fables receipts of one range, read in one call at one block: its receipts (`shares`, ERC-6909), how many
 * are staked for Fables' emissions, what `spender` (the wrapper) may move of them (`allowance`, or every one as an
 * `operator`), whether the hook's pause stops transfers, and the range's pool key and ticks (`set` false for a range
 * never deposited into).
 */
export interface FablesReceipts {
  shares: bigint; staked: bigint; allowance: bigint; operator: boolean; paused: boolean;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }; tickLower: number; tickUpper: number; set: boolean;
}
/** A wrapped Fables position: who holds its NFT and the range its receipts are of. */
export interface FablesWrapped { owner: Address; rangeId: bigint }
/**
 * A position at a v3-style position manager as it stores it (D334): its pool's tokens and fee tier (Uniswap v3's and its
 * forks') or tick spacing (Ramses V3's; the other null), its range and its liquidity.
 */
export interface DexPosition { token0: Address; token1: Address; fee: number | null; tickSpacing: number | null; tickLower: number; tickUpper: number; liquidity: bigint }
/** A position at a Uniswap v4 PositionManager (D334): its pool's key, hooks included, its range and its liquidity. */
export interface V4Position {
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }; tickLower: number; tickUpper: number; liquidity: bigint;
}
/** One call of a batch, as `simulateCalls` takes it. */
export interface BatchCall { to: Address; data: Hex; value: bigint }
/**
 * A rehypo source as a pool LP's exit now reads it (root D357), at one block: the vault it lends through and when that
 * vault's next settlement falls due (`earliestMaturity`), its asset, its one depositor (the pool's hook), the hook's LP
 * token supply and the wallet's part of it, everything the source holds (`totalAssets`), the asset it holds itself
 * (`float`), what it can pay the hook now (`maxWithdraw`), and how long it holds what an exit's sales pay for its LPs
 * after an ask (`EXIT_HOLD`, in seconds).
 */
export interface RehypoSourceRead {
  vault: Address; earliestMaturity: number; asset: Address; depositor: Address; totalAssets: bigint; float: bigint; payableNow: bigint; lpBalance: bigint;
  lpSupply: bigint; hold: number;
}
/** `owner`'s exit from a vault at the exit desk (Intent D57): the shares it may still redeem, its last listing's holding
 * and nonce, when it was committed, and how long a commitment lasts (`EXIT_LIFE`), both in seconds. */
export interface ExitRead { shares: bigint; id: bigint; nonce: bigint; committedAt: number; life: number }
/** What the desk's `shortfall` reads of a vault for a commitment of some shares, at one block: what they claim
 * (`previewRedeem`), what it holds outside its loans (`held`: its cash and its reserve at value, `totalAssets` less the
 * loans, root D394), its loans (`performingPrincipal` plus `accruedInterest`) and its share supply; and its free cash
 * (`freeLiquidity`, what it can pay out now), which the shortfall no longer reads. */
export interface ExitVaultBook { claim: bigint; free: bigint; held: bigint; loans: bigint; supply: bigint }

/**
 * A partner vault as its curator manages it, read in one call at one block: who may, where its asset policy and market
 * are, what it is set to now, and what waits. `categoryWeights` and `pendingLimits` are in the policy's order (four
 * categories: STOCK, MEME, RH_ECOSYSTEM, COMMODITY; eight limits: `IntentLimit`), a limit with no change waiting at
 * `readyAt` zero, and `pendingBuyReadyAt` zero with no change to buying loans waiting.
 */
export interface VaultManagerState {
  curator: Address; policy: Address; market: Address; mandateVersion: number; name: string; categoryMask: number; paused: boolean; fillersOpen: boolean; feeRecipient: Address;
  executionCapBps: number; maxLoanPrincipal: bigint; maxAssetBps: number; bufferBps: number; minRateGrade: number; categoryWeights: number[];
  pendingLimits: { value: bigint; readyAt: number }[];
  buysLoans: boolean; buyExtraBps: number; buysOnly: boolean; pendingBuyExtraBps: number; pendingBuyReadyAt: number;
}

/** The contracts one `GenerationDeployed` names, lowercase, with its id, asset, name and block. */
export interface DeployedGenerationRead {
  id: Hex; asset: Address; name: string; blockNumber: number; factory: Address; core: Address; registry: Address; rewards: Address; reserve: Address;
  feeProcessor: Address; quoteVerifier: Address; fillRouter: Address; gradeRegistry: Address; cashoutRouter: Address; rolloverRouter: Address;
}
/** A lend generation as its deployer recorded it (`foundGeneration`): its deployment, then each answer at one block, lowercase. */
export interface FoundGenerationRead {
  deployed: DeployedGenerationRead;
  /** The deployer's `isFactory(factory)`. */
  recorded: boolean;
  /** The deployer's `listed(id)`: the entry's `public`. */
  listed: boolean;
  /** The factory's `boundExitDesk()`; null for none. */
  exitDesk: Address | null;
  mandateVersion: number;
  symbol: string;
  decimals: number;
  /** The cash-out router's `FLASH_POOL()`, or `POOL_MANAGER()` for a v4 router. */
  flashPool: Address;
}

/** The chain reads, the simulation and the receipt wait the SDK needs, behind one seam so tests replace the RPC. */
export interface Chain {
  head(): Promise<{ number: bigint; timestamp: number }>;
  loan(engine: Address, id: bigint): Promise<Loan>;
  /** The reclaim right's holder; null once the right is burned (cancelled or closed). */
  ownerOf(engine: Address, id: bigint): Promise<Address | null>;
  /** How many reclaim rights `owner` holds on `engine` (`balanceOf`): one for each loan waiting for funding or running whose right it holds. */
  rights(engine: Address, owner: Address): Promise<bigint>;
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
  /** The sGAGE a listing with `fee` (raw, in the core's asset) for `term` asks of its core's ledger (`quoteRewards`). */
  rewardsQuote(registry: Address, term: number, fee: bigint): Promise<{ borrower: bigint; lender: bigint }>;
  /** What a separately funded rewards ledger may still allocate (`freeBudget`; zero on a bridged one). */
  rewardsBudget(rewards: Address): Promise<bigint>;
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
  /** The pool a cash-out router flash-borrows from (`FLASH_POOL()`), what its sales through an aggregator rest on; null for a router that has none, such as a v4 router. */
  cashoutFlashPool(router: Address): Promise<Address | null>;
  /**
   * What `cashOutDetailed` would pay `from` through gage's own routes now, its `eth_call` read (the app's weighing of an
   * aggregator's sale, web/src/v2/CashoutFlow.tsx); null when it would revert: a route the router does not admit, a
   * right not yet approved to it, a pool that cannot carry the sale.
   */
  cashoutRouteNet(router: Address, exit: CashoutExit, from: Address): Promise<bigint | null>;
  isVault(factory: Address, vault: Address): Promise<boolean>;
  /**
   * A partner vault factory's core and version, whether `account` may create there (`isCreator`), and each of `tokens`'
   * category (`categoryOf`: 0 STOCK, 1 MEME, 2 RH_ECOSYSTEM, 3 COMMODITY; null where it classified none), in one call at
   * one block: what pool vault creation checks (D333).
   */
  intentFactory(factory: Address, account: Address, tokens: readonly Address[]): Promise<IntentFactoryState>;
  vaultCore(vault: Address): Promise<Address>;
  /** A partner vault as its curator manages it, at one block; null for a vault too early to name its limits (before mandate 12). */
  vaultManager(vault: Address): Promise<VaultManagerState | null>;
  /** Whether a vault's asset policy lends against each of `tokens`, and when each waiting to be added may be (zero for none). */
  policyTokens(policy: Address, tokens: readonly Address[]): Promise<{ picked: boolean; readyAt: number }[]>;
  /** The most `owner` can redeem from a partner vault now (ERC-4626's `maxRedeem`: none at a settlement due); null for a vault before ERC-4626. */
  vaultMaxRedeem(vault: Address, owner: Address): Promise<bigint | null>;
  /** What a sale of a running loan is charged on a core (`tradeFeeBps`), from its registry. */
  tradeFeeBps(registry: Address): Promise<number>;
  vaultShares(vault: Address, wallet: Address): Promise<bigint>;
  /** The vault's book, its four figures read in one call, so at one block. */
  vaultBook(vault: Address): Promise<VaultBook>;
  pocketClaimable(vault: Address, pocket: bigint, wallet: Address): Promise<bigint>;
  vaultRewards(vault: Address, wallet: Address): Promise<bigint>;
  /** What a core pays and is repaid in (`USDG()`): USDG, or its generation's lend asset (D251, Intent D55). */
  coreAsset(core: Address): Promise<Address>;
  /** How long past a loan's term a core still takes its repayment (`GRACE()`), seconds: none on any core since V3, 48 hours on the two before. */
  coreGrace(core: Address): Promise<number>;
  /** What a partner vault takes and pays out (`USDG()`): its generation's lend asset. */
  vaultAsset(vault: Address): Promise<Address>;
  /** Each token's display multiplier (`uiMultiplier()`, 18 decimals), in their order, at one block; null for a token that has none. */
  uiMultipliers(tokens: readonly Address[]): Promise<(bigint | null)[]>;
  /**
   * Whether each token says it is paused (`paused()`, a Stock Token's own pause or its beacon's, D213), in their order, at
   * one block: such a token cannot move until it resumes. False for a token with no such entry.
   */
  tokensPaused(tokens: readonly Address[]): Promise<boolean[]>;
  /** One storage word of `address` at the head: where a partner vault's open reward-record count is read (src/gas.ts). */
  storageAt(address: Address, slot: bigint): Promise<bigint>;
  /** A token's symbol and decimals, and its name where it answers one: collateral the release's asset list does not name. */
  tokenInfo(token: Address): Promise<{ symbol: string; decimals: number; name?: string }>;
  /**
   * Every router `registry` admitted from block `from` to block `to` (`RouterSet` allowing it), each as often as it was, one
   * since removed among them: what it opened stays open. Read in spans of `LOG_SPAN`; a node that will not read that many
   * fails the read.
   */
  routerAdmissions(registry: Address, from: bigint, to: bigint): Promise<Address[]>;
  /** Whether `wallet` owns or operates ERC-8004 agent `agentId` (`isAuthorizedOrOwner`), whose own ratings the registry refuses. */
  agentAuthorized(identityRegistry: Address, wallet: Address, agentId: bigint): Promise<boolean>;
  /** How many ratings `wallet` has given ERC-8004 agent `agentId` (`getLastIndex`), revoked ones included. */
  feedbackCount(reputationRegistry: Address, agentId: bigint, wallet: Address): Promise<bigint>;
  /** The id the LP core's next loan takes (`nextLoanId`): its loans are 1 to this less one. */
  lpNextLoanId(core: Address): Promise<bigint>;
  /** LP loans by id, read a slice at a time, each slice at one block; a loan with state 0 is none. */
  lpLoans(core: Address, ids: readonly bigint[]): Promise<LpLoan[]>;
  /** What `account` may withdraw of each of `tokens` from the LP core (`credit`), in their order, at one block. */
  lpCredits(core: Address, account: Address, tokens: readonly Address[]): Promise<bigint[]>;
  /** The LP registry's terms, fee, loan cap and pause, at one block. */
  lpRegistry(registry: Address): Promise<LpRegistryState>;
  /** A pool's admission and caps under `adapter` on the LP registry. */
  lpPoolConfig(registry: Address, adapter: Address, pool: Address): Promise<LpPoolConfig>;
  /** An LP vault's book and switches, at one block, and a reserve vault's companion apart. */
  lpVault(vault: Address): Promise<LpVaultState>;
  /** A reserve vault's companion (`COMPANION()`, D454), null for an LPVault, which lacks the name. A node's refusal fails the read. */
  lpCompanion(vault: Address): Promise<Address | null>;
  /** The sGAGE `account` may claim from a reserve vault's companion now (`rewardClaimable`: as indexed so far). */
  lpRewardClaimable(companion: Address, account: Address): Promise<bigint>;
  /** Every vault an LP vault factory opened (`vaults`), oldest first, with the name each was opened with (`nameOf`). */
  lpFactoryVaults(factory: Address): Promise<{ address: Address; name: string }[]>;
  /** The name an LP vault factory opened `vault` with, or null where the factory did not open it (`isVault`). */
  lpFactoryVault(factory: Address, vault: Address): Promise<string | null>;
  /** Whether the LP registry lets each of `vaults` fund new loans (`vaultAllowed`), in their order. */
  lpVaultsAllowed(registry: Address, vaults: readonly Address[]): Promise<boolean[]>;
  /** Whether the LP registry lets `account` open a vault through the factory (`mayOpenVault`: an allowed curator, or anyone once creation is open, D319). */
  lpMayOpenVault(registry: Address, account: Address): Promise<boolean>;
  /** The shares `account` holds in an LP vault (`balanceOf`: an ERC-20 since D319, so shares it received by transfer count). */
  lpShares(vault: Address, account: Address): Promise<bigint>;
  /** An LP vault's share decimals (`decimals()`): 18 since D331, 12 for a vault opened before it (src/lpShares.ts). */
  lpShareDecimals(vault: Address): Promise<number>;
  /** The most of `account`'s shares an LP vault redeems now (ERC-4626's `maxRedeem`: its holding up to what the free cash pays, and a reserve vault's reserve, none while impaired or while that reserve cannot be read). */
  lpMaxRedeem(vault: Address, account: Address): Promise<bigint>;
  /** The shares `assets` USDG would buy in an LP vault now (`previewDeposit`). */
  lpPreviewDeposit(vault: Address, assets: bigint): Promise<bigint>;
  /** The USDG `shares` would redeem for in an LP vault now (`previewRedeem`). */
  lpPreviewRedeem(vault: Address, shares: bigint): Promise<bigint>;
  /** What `account` may claim of each loan's bonus in an LP vault (`bonusClaimable`), in their order, at one block. */
  lpBonuses(vault: Address, loanIds: readonly bigint[], account: Address): Promise<bigint[]>;
  /** Each position's facts through its adapter, in their order; null for one it cannot read (burned, or none). */
  lpFacts(adapter: Address, tokenIds: readonly bigint[]): Promise<(LpFacts | null)[]>;
  /** The tokens a position adapter's DEX pays as rewards (`rewardTokens`): none for Uniswap v3, Ramses' gauge tokens. */
  lpRewardTokens(adapter: Address): Promise<Address[]>;
  /**
   * The positions `owner` holds in an enumerable ERC-721 position manager (Uniswap v3's, SushiSwap v3's, Ramses V3's), at
   * most `max` of them read, newest first. Uniswap v4's cannot list them: `enumerable` false.
   */
  ownedPositions(manager: Address, owner: Address, max: number): Promise<OwnedPositions>;
  /** Who holds position `tokenId` (`ownerOf`); null for one that does not exist. */
  positionOwner(manager: Address, tokenId: bigint): Promise<Address | null>;
  /** Who holds each of `tokenIds` (`ownerOf`), in their order, read a slice at a time, each slice at one block; null for one that does not exist. */
  positionOwners(manager: Address, tokenIds: readonly bigint[]): Promise<(Address | null)[]>;
  /** Whether `operator` may move position `tokenId` of `owner`: approved for it (`getApproved`) or for all (`isApprovedForAll`). */
  positionApproved(manager: Address, tokenId: bigint, owner: Address, operator: Address): Promise<boolean>;
  /**
   * A v3-style pool's price now (Uniswap v3, SushiSwap v3, Ramses V3): `slot0`'s first two fields. A Uniswap v4 pool's is
   * its StateView's (`poolState`), by its id.
   */
  clPoolPrice(pool: Address): Promise<{ sqrtPriceX96: bigint; tick: number }>;
  /** What collecting an LP loan's fees would credit its borrower now (`collectFees`, its `eth_call`); null when it would revert. */
  lpFeesOwed(core: Address, loanId: bigint, borrower: Address): Promise<{ amount0: bigint; amount1: bigint } | null>;
  /** `owner`'s Fables receipts of range `rangeId` on `hook`, and what `spender` may move of them, at one block. */
  fablesReceipts(hook: Address, owner: Address, rangeId: bigint, spender: Address): Promise<FablesReceipts>;
  /** Each wrapped position's holder and range (`ownerOf`, `position`), in their order; null for one that does not exist. */
  fablesWrapped(wrapper: Address, tokenIds: readonly bigint[]): Promise<(FablesWrapped | null)[]>;
  /** The id the wrapper's next position takes (`nextTokenId`): its positions are 1 to this less one. */
  fablesNextTokenId(wrapper: Address): Promise<bigint>;
  /**
   * Each position at a v3-style position manager (`positions`: Uniswap v3's and its forks', or Ramses V3's 10 fields with
   * `ramses`), in their order, read a slice at a time; null for one it cannot read (burned, or none).
   */
  dexPositions(manager: Address, ramses: boolean, tokenIds: readonly bigint[]): Promise<(DexPosition | null)[]>;
  /** Each position at a Uniswap v4 PositionManager (`getPoolAndPositionInfo`, `getPositionLiquidity`), in their order; null for one that does not exist. */
  v4Positions(manager: Address, tokenIds: readonly bigint[]): Promise<(V4Position | null)[]>;
  /** When a Ramses V3 position's liquidity last changed (`positionLastModified`, Unix seconds). */
  ramsesLastModified(manager: Address, tokenId: bigint): Promise<number>;
  /** The Permit2 a Uniswap v4 PositionManager settles through (`permit2`). */
  permit2Of(manager: Address): Promise<Address>;
  /** What `spender` may pull of `token` from `owner` through Permit2, and until when (Unix seconds). */
  permit2Allowance(permit2: Address, owner: Address, token: Address, spender: Address): Promise<{ amount: bigint; expiration: number }>;
  /**
   * The most `owner` can withdraw from a partner vault now (ERC-4626's `maxWithdraw`: none at a settlement due); null for
   * a vault of a generation before ERC-4626, which answers no such read.
   */
  vaultMaxWithdraw(vault: Address, owner: Address): Promise<bigint | null>;
  /** A rehypo source and the wallet's LP share of it (root D357); null for an address that does not answer as one with a vault. */
  rehypoSource(source: Address, wallet: Address): Promise<RehypoSourceRead | null>;
  /** The exit desk a partner vault factory names now (Intent D57); null while exits are closed, or for a factory before mandate 13. */
  exitDeskOf(factory: Address): Promise<Address | null>;
  /** A partner vault's own market (`LENDER_MARKET`), where its holdings are listed. */
  lenderMarket(vault: Address): Promise<Address>;
  /** `owner`'s exit from `vault` at the desk, with when it was committed and the desk's `EXIT_LIFE`, at one block. */
  exitOf(desk: Address, vault: Address, owner: Address): Promise<ExitRead>;
  /** What the desk owes `owner` in `asset` from its exits' sales (`owed`). */
  exitOwed(desk: Address, asset: Address, owner: Address): Promise<bigint>;
  /** The partner-vault shares withdrawing `assets` would burn now (`previewWithdraw`). */
  vaultPreviewWithdraw(vault: Address, assets: bigint): Promise<bigint>;
  /** What the desk's `shortfall` would read of `vault` for a commitment of `shares`. */
  exitVaultBook(vault: Address, shares: bigint): Promise<ExitVaultBook>;
  /** A vault's open records, through its factory's share views (`SHARE_VIEWS().rewardRecords(vault)`). */
  exitRecords(factory: Address, vault: Address): Promise<bigint[]>;
  /**
   * SEC-01 (root D391): what `who` has carried of each holding's exposure window and the window's whole supply
   * (`SHARE_VIEWS().exitShare(vault, id, who)`), in `ids`' order, at one block; null where the share views answer none
   * (an empty revert: an earlier generation's, whose desk sets no stake floor). Any other failure throws.
   */
  exitShares(factory: Address, vault: Address, ids: readonly bigint[], who: Address): Promise<ExitShare[] | null>;
  /** SEC-01 (root D391): what the exit sale of holding `id` of `vault` charged its leaver (`exitDebit`); a zero owner
   * and debit for none, and null from a desk that answers none (an empty revert: before D391). Any other failure throws. */
  exitDebit(desk: Address, vault: Address, id: bigint): Promise<{ owner: Address; debit: bigint } | null>;
  /** SEC-01 (root D391): where the desk would stop holding `id`'s listing for `owner`'s exit (`floorOf`); null from a
   * desk that answers none (an empty revert: before D391), which takes no listing over. Any other failure throws. */
  exitFloorOf(desk: Address, vault: Address, id: bigint, owner: Address): Promise<number | null>;
  /** The vault's record of holding `id` (`loans(id)`): the fields the desk weighs. */
  exitRecord(vault: Address, id: bigint): Promise<ExitRecord>;
  /** Where loan `id`'s interest clock stops on its core (`accrualEnd`). */
  accrualEnd(core: Address, id: bigint): Promise<bigint>;
  /** The quarters of holding `id` the vault can sell (`lenderSaleSlots`). */
  saleSlots(vault: Address, id: bigint): Promise<number>;
  /**
   * The desk's record of its last exit listing of holding `id` (`listings`): the exit it serves and that listing's nonce,
   * zero for none, and none once that exit cancelled. ED2 (root D390): an exit whose floor there is strictly lower
   * (`exitFloorOf`, root D391) takes a live one over.
   */
  exitListing(desk: Address, vault: Address, id: bigint): Promise<{ owner: Address; nonce: bigint }>;
  /** A market's listing of holding `id` (mandate 13's `asks`). */
  exitAsk(market: Address, id: bigint): Promise<ExitAsk>;
  /** Whether the desk finds holding `id` within the vault's average interest still to come per unit of book value. */
  withinAverage(desk: Address, vault: Address, id: bigint): Promise<boolean>;
  /**
   * The records of `vault` the desk waits on (r13d, `pendingSettlements`): while any awaits its booking, the desk lists
   * nothing (`SettlementPending`). None from a desk before r13d, which answers no such read and lists while they wait.
   */
  pendingSettlements(desk: Address, vault: Address): Promise<bigint[]>;
  /**
   * The exit desk a partner vault factory bound for good (Intent D57, `boundExitDesk`): it keeps every commitment and what
   * sales owe while exits are closed, so cancelling and collecting go there; null before one was named, or for a factory
   * before mandate 13.
   */
  boundExitDeskOf(factory: Address): Promise<Address | null>;
  /**
   * What the chain records of a lend generation the indexer says the release's GenerationDeployer built (r13, D347;
   * src/discovery.ts): the deployer's `GenerationDeployed` naming `factory` in `block`, then, in one call at one block and
   * of the contracts it names, the deployer's record of the factory and listing switch, the exit desk the factory is
   * bound to, its mandate version, the asset's symbol and decimals and the cash-out router's flash source. Null when the
   * deployer logged no such deployment.
   */
  foundGeneration(deployer: Address, factory: Address, block: number): Promise<FoundGenerationRead | null>;
  /** What `vault` cannot pay now of `owner`'s commitment at the desk (`shortfall`): zero for none, for one that lapsed, or once the vault can pay the rest. */
  exitShortfall(desk: Address, vault: Address, owner: Address): Promise<bigint>;
  /** When a partner vault's next settlement falls due (`earliestMaturity`): from then until a settle books its loans, it pays nothing out and sells none of them. */
  earliestMaturity(vault: Address): Promise<number>;
  /**
   * Simulates `calls` in order from `from`, each seeing the ones before it (`eth_simulateV1`): whether each would succeed;
   * null where the RPC cannot simulate a batch.
   */
  simulateCalls(from: Address, calls: readonly BatchCall[]): Promise<boolean[] | null>;
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
/** The most LP loans, credits or bonuses one call reads: each slice is its own call, at its own block. */
const LP_SLICE = 100;
const slicesOf = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, n) => items.slice(n * size, (n + 1) * size));
/** The low 24 bits of `word` as a signed tick, as v4's PositionInfoLibrary reads a packed range (`signextend(2, …)`). */
export const int24 = (word: bigint): number => {
  const low = Number(word & 0xffffffn);
  return low >= 0x800000 ? low - 0x1000000 : low;
};

/** An LP loan as the core's `loan` answers it, with its id. */
function lpLoanOf(id: bigint, l: unknown): LpLoan {
  const x = l as { borrower: Address; vault: Address; adapter: Address; escrow: Address; pool: Address; tokenId: bigint; principal: bigint; repayment: bigint; start: number | bigint; end: number | bigint; state: number | bigint; positionReturned: boolean };
  return {
    id, borrower: x.borrower, vault: x.vault, adapter: x.adapter, escrow: x.escrow, pool: x.pool, tokenId: x.tokenId, principal: x.principal, repayment: x.repayment,
    start: Number(x.start), end: Number(x.end), state: Number(x.state), positionReturned: x.positionReturned,
  };
}

/** One read of a multicall, as viem answers it with `allowFailure`. */
type Tried = { status: string; result?: unknown; error?: unknown };

/**
 * Whether a multicall read of `functionName` failed as a contract without that entry (and without a fallback) answers
 * it: a revert with no data at all. That alone says "an earlier generation's, which answers none"; a failure of the RPC
 * (viem gives every read of the call the transport's error), a revert with data, or an answer that does not decode is
 * not that, and the read fails.
 */
export function emptyRevert(r: Tried | undefined, functionName: string): boolean {
  const e = r?.status === "failure" ? r.error : undefined;
  return e instanceof ContractFunctionExecutionError && e.functionName === functionName && e.cause instanceof ContractFunctionRevertedError && e.cause.raw === "0x";
}

/** A multicall read that failed otherwise than `emptyRevert` says, or answered what its ABI does not: the read fails. */
const unread = (r: Tried | undefined, functionName: string): Error =>
  r?.status === "failure" && r.error instanceof Error ? r.error : new Error(`${functionName}: the chain's answer could not be read`);

/**
 * D454: a vault's `COMPANION()` answer: a nonzero address is a reserve vault's companion; zero, or a revert with no data
 * (an LPVault lacks the name), is none. Any other failure throws: a node's refusal is never taken for an LPVault, whose
 * redemptions and words differ.
 */
export function lpCompanionFrom(r: Tried | undefined): Address | null {
  if (emptyRevert(r, "COMPANION")) return null;
  const x = r?.status === "success" ? r.result : undefined;
  if (typeof x !== "string") throw unread(r, "COMPANION");
  return BigInt(x) === 0n ? null : x as Address;
}

/** What `lpReserveFrom` reads of a companion, in order. */
const LP_RESERVE_READS = ["RESERVE", "reserveShares", "reserveValue", "reservePayable", "freeLiquidity", "bufferBps", "minCostBpsPerYear", "reserveClosed", "accountedRewards"] as const;

/**
 * D454: a companion's answers to `LP_RESERVE_READS`, each read's failure leaving its own field null and never failing the
 * vault's read; `payable` null too where `reservePayable` says the reserve's reads failed.
 */
export function lpReserveFrom(companion: Address, reads: readonly Tried[]): LpReserveState {
  const got = <T>(n: number) => (reads[n]?.status === "success" ? reads[n].result as T : null);
  const payable = got<readonly [boolean, bigint]>(3), bps = (n: number) => { const v = got<number>(n); return v === null ? null : Number(v); };
  return {
    companion, token: got<Address>(0), shares: got<bigint>(1), value: got<bigint>(2), payable: payable?.[0] ? payable[1] : null, freeLiquidity: got<bigint>(4),
    bufferBps: bps(5), minCostBpsPerYear: bps(6), closed: got<boolean>(7), rewardsAccounted: got<bigint>(8),
  };
}

/**
 * SEC-01 (root D391): one block's `exitShare` answers, in order, as `{ exposure, supply }`; null when a read reverted
 * with no data (share views before D391 answer none). Any other failure, or an answer that is not a pair of amounts,
 * throws: a node's refusal is never taken for an earlier generation.
 */
export function exitSharesFrom(reads: readonly Tried[]): ExitShare[] | null {
  const out: ExitShare[] = [];
  for (const r of reads) {
    if (emptyRevert(r, "exitShare")) return null;
    const x = r.status === "success" ? r.result : undefined;
    if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== "bigint" || typeof x[1] !== "bigint") throw unread(r, "exitShare");
    out.push({ exposure: x[0], supply: x[1] });
  }
  return out;
}

/** SEC-01 (root D391): a desk's `exitDebit` answer as `{ owner, debit }`; null when it reverted with no data (a desk
 * before D391); any other failure throws. */
export function exitDebitFrom(r: Tried | undefined): { owner: Address; debit: bigint } | null {
  if (emptyRevert(r, "exitDebit")) return null;
  const x = r?.status === "success" ? r.result : undefined;
  if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== "string" || typeof x[1] !== "bigint") throw unread(r, "exitDebit");
  return { owner: x[0] as Address, debit: x[1] };
}

/** SEC-01 (root D391): a desk's `floorOf` answer in basis points; null when it reverted with no data (a desk before
 * D391); any other failure, or a floor above where a listing starts, throws. */
export function exitFloorFrom(r: Tried | undefined): number | null {
  if (emptyRevert(r, "floorOf")) return null;
  const x = r?.status === "success" ? r.result : undefined;
  if (typeof x !== "bigint" || x > 9_900n) throw unread(r, "floorOf");
  return Number(x);
}

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

/** The most blocks the chain's public node reads logs over in one query, for one address and one event. */
export const LOG_SPAN = 10_000_000n;
/** Blocks `from` to `to` in ranges of `LOG_SPAN` at most, none left out. */
export function logSpans(from: bigint, to: bigint): { fromBlock: bigint; toBlock: bigint }[] {
  const out: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let at = from; at <= to; at += LOG_SPAN) {
    const end = at + LOG_SPAN - 1n;
    out.push({ fromBlock: at, toBlock: end < to ? end : to });
  }
  return out;
}

export function createChain(rpcUrl: string, chainId: number): Chain {
  // Reads asked together go as one call to Multicall3, each with its own answer or revert: viem needs the chain to know where that is.
  const chain = chainId === MAINNET ? robinhoodMainnet : chainId === TESTNET ? robinhoodTestnet : undefined;
  const client = createPublicClient({ ...(chain ? { chain } : {}), batch: { multicall: true }, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }), cacheTime: 0 });
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
  // Reads in one call, never split (batchSize 0), so at one block: `all` fails with any read, `tried` keeps each read's
  // own failure (a revert), while a failure of the RPC itself fails either.
  const all = async (contracts: ContractFunctionParameters[]): Promise<unknown[]> => {
    await ready();
    return await client.multicall({ multicallAddress: MULTICALL3, allowFailure: false, batchSize: 0, contracts });
  };
  const tried = async (contracts: ContractFunctionParameters[]): Promise<Read[]> => {
    await ready();
    return await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0, contracts });
  };
  const companionOf = async (vault: Address) => lpCompanionFrom((await tried([{ address: vault, abi: lpReserveVaultAbi, functionName: "COMPANION" }]))[0]);
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
    rights: (engine, owner) => read<bigint>(engine, engineAbi, "balanceOf", [owner]),
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
    async rewardsQuote(registry, term, fee) {
      const [borrower, lender] = await read<readonly [bigint, bigint]>(registry, registryAbi, "quoteRewards", [term, fee]);
      return { borrower, lender };
    },
    rewardsBudget: (rewards) => read<bigint>(rewards, rewardsAbi, "freeBudget"),
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
    async cashoutFlashPool(router) {
      // A router without one has no such entry, and the call reverts; a failure of the RPC fails the read.
      const [r] = await tried([{ address: router, abi: flashSourceAbi, functionName: "FLASH_POOL" }]);
      return r?.status === "success" ? r.result as Address : null;
    },
    async cashoutRouteNet(router, exit, from) {
      await ready();
      try {
        const { result } = await client.simulateContract({ address: router, abi: cashoutRouterAbi, functionName: "cashOutDetailed", args: [exit], account: from });
        return result[3];
      } catch { return null; }
    },
    isVault: (factory, vault) => read<boolean>(factory, factoryAbi, "isVault", [vault]),
    async intentFactory(factory, account, tokens) {
      const [core, version, creator, open, ...classes] = await all([
        { address: factory, abi: factoryAbi, functionName: "CORE" },
        { address: factory, abi: factoryAbi, functionName: "MANDATE_VERSION" },
        { address: factory, abi: factoryAbi, functionName: "isCreator", args: [account] },
        { address: factory, abi: factoryAbi, functionName: "openCreation" },
        ...tokens.map((token) => ({ address: factory, abi: factoryAbi, functionName: "categoryOf", args: [token] })),
      ]);
      return {
        core: core as Address, mandateVersion: Number(version), isCreator: creator === true, openCreation: open === true,
        categories: (classes as (readonly [boolean, number])[]).map(([classified, category]) => (classified ? Number(category) : null)),
      };
    },
    vaultCore: (vault) => read<Address>(vault, partnerVaultAbi, "VAULT"),
    async vaultManager(vault) {
      const at = { address: vault, abi: vaultManagerAbi } as const;
      const names = ["CURATOR", "ASSET_POLICY", "LENDER_MARKET", "MANDATE_VERSION", "name", "CATEGORY_MASK", "paused", "fillersOpen", "feeRecipient", "executionCapBps", "maxLoanPrincipal", "maxAssetBps", "bufferBps", "minRateGrade"] as const;
      // A vault before mandate 12 has no asset policy limits or name, and those reads revert; a failure of the RPC fails the read.
      const reads = await tried([...names.map((functionName) => ({ ...at, functionName })), ...[0, 1, 2, 3].map((category) => ({ ...at, functionName: "categoryWeightBps", args: [category] }))]);
      if (reads.some((r) => r.status !== "success")) return null;
      const [curator, policy, market, version, name, mask, paused, fillersOpen, feeRecipient, cap, maxLoan, maxAsset, buffer, grade, ...weights] = reads.map((r) => r.result) as
        [Address, Address, Address, bigint, string, number, boolean, boolean, Address, number, bigint, number, number, number, ...number[]];
      const on = { address: policy, abi: assetPolicyAbi } as const;
      const [pending, rest] = await Promise.all([
        all([0, 1, 2, 3, 4, 5, 6, 7].map((limit) => ({ ...on, functionName: "pendingLimit", args: [limit] }))) as Promise<(readonly [bigint, bigint])[]>,
        all((["secondaryEnabled", "minExtraAnnualReturnBps", "pendingExtraBps", "pendingReadyAt"] as const).map((functionName) => ({ ...on, functionName }))) as Promise<[boolean, number, number, bigint]>,
      ]);
      // Only mandate 13's vaults can be created to buy alone.
      const [only] = await tried([{ ...on, functionName: "SECONDARY_ONLY" }]);
      return {
        curator, policy, market, mandateVersion: Number(version), name, categoryMask: Number(mask), paused, fillersOpen, feeRecipient, executionCapBps: Number(cap), maxLoanPrincipal: maxLoan,
        maxAssetBps: Number(maxAsset), bufferBps: Number(buffer), minRateGrade: Number(grade), categoryWeights: weights.map(Number),
        pendingLimits: pending.map(([value, readyAt]) => ({ value, readyAt: Number(readyAt) })),
        buysLoans: rest[0], buyExtraBps: Number(rest[1]), buysOnly: only?.status === "success" && only.result === true, pendingBuyExtraBps: Number(rest[2]), pendingBuyReadyAt: Number(rest[3]),
      };
    },
    async policyTokens(policy, tokens) {
      if (!tokens.length) return [];
      const reads = await all(tokens.flatMap((token) => [
        { address: policy, abi: assetPolicyAbi, functionName: "picked", args: [token] }, { address: policy, abi: assetPolicyAbi, functionName: "readyAt", args: [token] },
      ]));
      return tokens.map((_, n) => ({ picked: reads[2 * n] === true, readyAt: Number(reads[2 * n + 1]) }));
    },
    async vaultMaxRedeem(vault, owner) {
      // A vault before ERC-4626 has no such entry, and the call reverts; a failure of the RPC fails the read.
      const [r] = await tried([{ address: vault, abi: partnerVault4626Abi, functionName: "maxRedeem", args: [owner] }]);
      return r?.status === "success" ? r.result as bigint : null;
    },
    tradeFeeBps: async (registry) => Number(await read<number>(registry, registryAbi, "tradeFeeBps")),
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
    coreGrace: (core) => read<number>(core, engineAbi, "GRACE"),
    vaultAsset: (vault) => read<Address>(vault, partnerVaultAbi, "USDG"),
    async uiMultipliers(tokens) {
      if (!tokens.length) return [];
      // A token that is no Stock Token has no such entry, and the call reverts; a failure of the RPC fails the read.
      return (await tried(tokens.map((token) => ({ address: token, abi: stockTokenAbi, functionName: "uiMultiplier" })))).map((r) => (r.status === "success" ? r.result as bigint : null));
    },
    async tokensPaused(tokens) {
      if (!tokens.length) return [];
      // A token with no pause has no such entry, and the call reverts; a failure of the RPC fails the read.
      return (await tried(tokens.map((token) => ({ address: token, abi: stockTokenAbi, functionName: "paused" })))).map((r) => r.status === "success" && r.result === true);
    },
    async storageAt(address, slot) {
      await ready();
      const word = await client.getStorageAt({ address, slot: toHex(slot, { size: 32 }) });
      requireThat(word !== undefined, "UNAVAILABLE", "The RPC answered no storage word", 503);
      return BigInt(word);
    },
    async tokenInfo(token) {
      const [symbol, decimals, name] = await Promise.all([
        read<string>(token, erc20Abi, "symbol"), read<number>(token, erc20Abi, "decimals"),
        // A token without a name still has its symbol.
        read<string>(token, erc20Abi, "name").catch(() => undefined),
      ]);
      return { symbol, decimals: Number(decimals), ...(name === undefined ? {} : { name }) };
    },
    async routerAdmissions(registry, from, to) {
      await ready();
      // One registry and one event a call: the chain's public node refuses a list of addresses, and a range over `LOG_SPAN`.
      const routers: Address[] = [];
      for (const span of logSpans(from, to)) {
        const logs = await client.getLogs({ address: registry, event: getAbiItem({ abi: registryAbi, name: "RouterSet" }), ...span, strict: true });
        routers.push(...logs.filter((l) => l.args.allowed).map((l) => l.args.router));
      }
      return routers;
    },
    agentAuthorized: (identityRegistry, wallet, agentId) => read<boolean>(identityRegistry, agentIdentityAbi, "isAuthorizedOrOwner", [wallet, agentId]),
    feedbackCount: (reputationRegistry, agentId, wallet) => read<bigint>(reputationRegistry, reputationAbi, "getLastIndex", [agentId, wallet]),
    lpNextLoanId: (core) => read<bigint>(core, lpCoreAbi, "nextLoanId"),
    async lpLoans(core, ids) {
      const answers = await Promise.all(slicesOf(ids, LP_SLICE).map(async (slice) =>
        (await all(slice.map((id) => ({ address: core, abi: lpCoreAbi, functionName: "loan", args: [id] })))).map((l, n) => lpLoanOf(slice[n]!, l))));
      return answers.flat();
    },
    async lpCredits(core, account, tokens) {
      if (!tokens.length) return [];
      return (await all(tokens.map((token) => ({ address: core, abi: lpCoreAbi, functionName: "credit", args: [account, token] })))) as bigint[];
    },
    async lpRegistry(registry) {
      const at = { address: registry, abi: lpRegistryAbi } as const;
      const [terms, feeBps, ltvCapBps, newLoansPaused] = await all([
        { ...at, functionName: "terms" }, { ...at, functionName: "feeBps" }, { ...at, functionName: "ltvCapBps" }, { ...at, functionName: "newLoansPaused" },
      ]) as [readonly number[], number, number, boolean];
      return { terms: terms.map(Number), feeBps: Number(feeBps), ltvCapBps: Number(ltvCapBps), newLoansPaused };
    },
    async lpPoolConfig(registry, adapter, pool) {
      const c = await read<{ allowed: boolean; minHalfWidthTicks: number; minLoanPrincipal: bigint; maxLoanPrincipal: bigint; maxOutstanding: bigint }>(registry, lpRegistryAbi, "poolConfig", [adapter, pool]);
      return { allowed: c.allowed, minHalfWidthTicks: Number(c.minHalfWidthTicks), minLoanPrincipal: c.minLoanPrincipal, maxLoanPrincipal: c.maxLoanPrincipal, maxOutstanding: c.maxOutstanding };
    },
    async lpVault(vault) {
      const at = { address: vault, abi: lpVaultAbi } as const;
      const names = ["USDG", "CORE", "totalAssets", "freeCash", "totalSupply", "outstandingPrincipal", "totalBonusHeld", "impaired", "depositsClosed", "fundingPaused", "maxLoanPrincipal", "PERFORMANCE_FEE_BPS", "openLoans", "CURATOR"] as const;
      // The mandate and the reserve are read apart: a vault built before D318 names no mandate (null), and an LPVault no
      // companion (D454), so one new name never fails the book's read.
      const [book, [mandate], reserve] = await Promise.all([
        tried(names.map((functionName) => ({ ...at, functionName }))), tried([{ ...at, functionName: "mandate" }]),
        companionOf(vault).then(async (companion) => (companion ? lpReserveFrom(companion, await tried(LP_RESERVE_READS.map((functionName) => ({ address: companion, abi: lpCompanionAbi, functionName })))) : null)),
      ]);
      // Every read of the book must answer, at one block, but a reserve vault's totalAssets, which reverts while its reserve's conversion fails.
      const values = book.map((r, n) => {
        if (r.status === "success") return r.result;
        if (reserve && names[n] === "totalAssets") return null;
        throw unread(r, names[n]!);
      });
      const [asset, core, totalAssets, freeCash, totalShares, outstandingPrincipal, bonusHeld, impaired, depositsClosed, fundingPaused, maxLoanPrincipal, fee, open, curator] =
        values as [Address, Address, bigint | null, bigint, bigint, bigint, bigint, boolean, boolean, boolean, bigint, number, readonly bigint[], Address];
      const m = mandate?.status === "success" ? mandate.result as readonly [readonly { adapter: Address; pool: Address }[], readonly number[]] : null;
      return {
        asset, core, totalAssets, freeCash, totalShares, outstandingPrincipal, bonusHeld, impaired, depositsClosed, fundingPaused, maxLoanPrincipal,
        performanceFeeBps: Number(fee), openLoans: open.length, curator,
        mandate: m ? m[0].map((p, n) => ({ adapter: p.adapter, pool: p.pool, activeAt: Number(m[1][n] ?? 0) })) : null,
        reserve,
      };
    },
    lpCompanion: (vault) => companionOf(vault),
    lpRewardClaimable: (companion, account) => read<bigint>(companion, lpCompanionAbi, "rewardClaimable", [account]),
    async lpFactoryVaults(factory) {
      // Paged through vaultCount and vaultsFrom where the factory has them: one vaults() call outgrows a node's gas cap
      // once creation is open (r12 review C15). A factory built before them answers vaults() whole.
      const [count] = await tried([{ address: factory, abi: lpVaultFactoryAbi, functionName: "vaultCount" }]);
      let vaults: readonly Address[];
      if (count?.status === "success" && typeof count.result === "bigint") {
        const starts: bigint[] = [];
        for (let start = 0n; start < count.result; start += 500n) starts.push(start);
        const pages = starts.length ? await all(starts.map((start) => ({ address: factory, abi: lpVaultFactoryAbi, functionName: "vaultsFrom", args: [start, 500n] }))) as readonly (readonly Address[])[] : [];
        vaults = pages.flat();
      } else vaults = await read<readonly Address[]>(factory, lpVaultFactoryAbi, "vaults");
      const names = vaults.length ? await tried(vaults.map((v) => ({ address: factory, abi: lpVaultFactoryAbi, functionName: "nameOf", args: [v] }))) : [];
      return vaults.map((address, n) => ({ address, name: names[n]?.status === "success" && typeof names[n].result === "string" ? names[n].result : "" }));
    },
    async lpFactoryVault(factory, vault) {
      const [made, name] = await all([
        { address: factory, abi: lpVaultFactoryAbi, functionName: "isVault", args: [vault] }, { address: factory, abi: lpVaultFactoryAbi, functionName: "nameOf", args: [vault] },
      ]) as [boolean, string];
      return made ? name : null;
    },
    async lpVaultsAllowed(registry, vaults) {
      if (!vaults.length) return [];
      return (await all(vaults.map((v) => ({ address: registry, abi: lpRegistryAbi, functionName: "vaultAllowed", args: [v] })))).map(Boolean);
    },
    lpMayOpenVault: (registry, account) => read<boolean>(registry, lpRegistryAbi, "mayOpenVault", [account]),
    lpShares: (vault, account) => read<bigint>(vault, lpVaultAbi, "balanceOf", [account]),
    lpShareDecimals: async (vault) => Number(await read<number>(vault, lpVaultAbi, "decimals")),
    lpMaxRedeem: (vault, account) => read<bigint>(vault, lpVaultAbi, "maxRedeem", [account]),
    lpPreviewDeposit: (vault, assets) => read<bigint>(vault, lpVaultAbi, "previewDeposit", [assets]),
    lpPreviewRedeem: (vault, shares) => read<bigint>(vault, lpVaultAbi, "previewRedeem", [shares]),
    async lpBonuses(vault, loanIds, account) {
      const answers = await Promise.all(slicesOf(loanIds, LP_SLICE).map(async (slice) =>
        await all(slice.map((id) => ({ address: vault, abi: lpVaultAbi, functionName: "bonusClaimable", args: [id, account] }))) as bigint[]));
      return answers.flat();
    },
    async lpFacts(adapter, tokenIds) {
      const answers = await Promise.all(slicesOf(tokenIds, LP_SLICE).map(async (slice) =>
        (await tried(slice.map((id) => ({ address: adapter, abi: lpAdapterAbi, functionName: "facts", args: [id] })))).map((r): LpFacts | null => {
          if (r.status !== "success") return null;
          const f = r.result as { pool: Address; token0: Address; token1: Address; tickLower: number; tickUpper: number; liquidity: bigint };
          return { pool: f.pool, token0: f.token0, token1: f.token1, tickLower: Number(f.tickLower), tickUpper: Number(f.tickUpper), liquidity: f.liquidity };
        })));
      return answers.flat();
    },
    lpRewardTokens: async (adapter) => [...await read<readonly Address[]>(adapter, lpAdapterAbi, "rewardTokens")],
    async ownedPositions(manager, owner, max) {
      const total = await read<bigint>(manager, positionManagerAbi, "balanceOf", [owner]);
      const n = total < BigInt(max) ? Number(total) : max;
      if (n <= 0) return { total, ids: [], enumerable: true };
      // Newest first: an enumerable manager appends a position it mints or receives to its holder's list.
      const reads = await tried(Array.from({ length: n }, (_, k) => ({ address: manager, abi: positionManagerAbi, functionName: "tokenOfOwnerByIndex", args: [owner, total - 1n - BigInt(k)] })));
      if (reads.some((r) => r.status !== "success")) return { total, ids: [], enumerable: false };
      return { total, ids: reads.map((r) => r.result as bigint), enumerable: true };
    },
    async positionOwner(manager, tokenId) {
      // A position that does not exist reverts; a failure of the RPC fails the read.
      const [r] = await tried([{ address: manager, abi: positionManagerAbi, functionName: "ownerOf", args: [tokenId] }]);
      return r?.status === "success" ? r.result as Address : null;
    },
    async positionOwners(manager, tokenIds) {
      const answers = await Promise.all(slicesOf(tokenIds, LP_SLICE).map(async (slice) =>
        (await tried(slice.map((id) => ({ address: manager, abi: positionManagerAbi, functionName: "ownerOf", args: [id] })))).map((r) => (r.status === "success" ? r.result as Address : null))));
      return answers.flat();
    },
    async positionApproved(manager, tokenId, owner, operator) {
      const [one, every] = await all([
        { address: manager, abi: positionManagerAbi, functionName: "getApproved", args: [tokenId] },
        { address: manager, abi: positionManagerAbi, functionName: "isApprovedForAll", args: [owner, operator] },
      ]) as [Address, boolean];
      return one.toLowerCase() === operator.toLowerCase() || every;
    },
    async clPoolPrice(pool) {
      const [sqrtPriceX96, tick] = await read<readonly [bigint, number]>(pool, clPoolAbi, "slot0");
      return { sqrtPriceX96, tick: Number(tick) };
    },
    async fablesReceipts(hook, owner, rangeId, spender) {
      const at = { address: hook, abi: fablesHookAbi } as const;
      const [shares, position, allowance, operator, paused, range] = await all([
        { ...at, functionName: "balanceOf", args: [owner, rangeId] }, { ...at, functionName: "userPosition", args: [rangeId, owner] },
        { ...at, functionName: "allowance", args: [owner, spender, rangeId] }, { ...at, functionName: "isOperator", args: [owner, spender] },
        { ...at, functionName: "paused" }, { ...at, functionName: "rangeKey", args: [rangeId] },
      ]) as [bigint, { staked: bigint }, bigint, boolean, boolean, readonly [FablesReceipts["key"], number, number, boolean]];
      const [key, tickLower, tickUpper, set] = range;
      return {
        shares, staked: position.staked, allowance, operator, paused, set, tickLower: Number(tickLower), tickUpper: Number(tickUpper),
        key: { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks },
      };
    },
    async fablesWrapped(wrapper, tokenIds) {
      const answers = await Promise.all(slicesOf(tokenIds, LP_SLICE).map(async (slice) => {
        const reads = await tried(slice.flatMap((id) => [
          { address: wrapper, abi: positionManagerAbi, functionName: "ownerOf", args: [id] },
          { address: wrapper, abi: fablesWrapperAbi, functionName: "position", args: [id] },
        ]));
        return slice.map((_, n): FablesWrapped | null => {
          const owner = reads[2 * n], position = reads[2 * n + 1];
          if (owner?.status !== "success" || position?.status !== "success") return null;
          return { owner: owner.result as Address, rangeId: (position.result as readonly unknown[])[5] as bigint };
        });
      }));
      return answers.flat();
    },
    fablesNextTokenId: (wrapper) => read<bigint>(wrapper, fablesWrapperAbi, "nextTokenId"),
    async dexPositions(manager, ramses, tokenIds) {
      const answers = await Promise.all(slicesOf(tokenIds, LP_SLICE).map(async (slice) =>
        (await tried(slice.map((id) => ({ address: manager, abi: ramses ? ramsesManagerAbi : v3ManagerAbi, functionName: "positions", args: [id] })))).map((r): DexPosition | null => {
          if (r.status !== "success") return null;
          const p = r.result as readonly unknown[];
          // Uniswap's 12 fields lead with its nonce and operator, its fee tier at 4; Ramses' 10 with the tokens, its tick spacing at 2.
          const at = ramses ? 0 : 2;
          return {
            token0: p[at] as Address, token1: p[at + 1] as Address, fee: ramses ? null : Number(p[4]), tickSpacing: ramses ? Number(p[2]) : null,
            tickLower: Number(p[at + 3]), tickUpper: Number(p[at + 4]), liquidity: p[at + 5] as bigint,
          };
        })));
      return answers.flat();
    },
    async v4Positions(manager, tokenIds) {
      const answers = await Promise.all(slicesOf(tokenIds, LP_SLICE).map(async (slice) => {
        const reads = await tried(slice.flatMap((id) => [
          { address: manager, abi: v4ManagerAbi, functionName: "getPoolAndPositionInfo", args: [id] },
          { address: manager, abi: v4ManagerAbi, functionName: "getPositionLiquidity", args: [id] },
        ]));
        return slice.map((_, n): V4Position | null => {
          const info = reads[2 * n], liquidity = reads[2 * n + 1];
          if (info?.status !== "success" || liquidity?.status !== "success") return null;
          const [key, packed] = info.result as readonly [V4Position["key"], bigint];
          // A position that was never minted reads an empty key: no pool has a zero tick spacing.
          if (Number(key.tickSpacing) === 0) return null;
          return {
            key: { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks },
            tickLower: int24(packed >> 8n), tickUpper: int24(packed >> 32n), liquidity: liquidity.result as bigint,
          };
        });
      }));
      return answers.flat();
    },
    ramsesLastModified: async (manager, tokenId) => Number(await read<bigint>(manager, ramsesManagerAbi, "positionLastModified", [tokenId])),
    permit2Of: (manager) => read<Address>(manager, v4ManagerAbi, "permit2"),
    async permit2Allowance(permit2, owner, token, spender) {
      const [amount, expiration] = await read<readonly [bigint, number, number]>(permit2, permit2Abi, "allowance", [owner, token, spender]);
      return { amount, expiration: Number(expiration) };
    },
    async rehypoSource(source, wallet) {
      const at = { address: source, abi: rehypoSourceAbi } as const;
      // Anything else answers no such reads, and the calls revert; a failure of the RPC fails the read.
      const first = await tried([{ ...at, functionName: "vault" }, { ...at, functionName: "depositor" }, { ...at, functionName: "asset" }, { ...at, functionName: "totalAssets" }]);
      if (first.some((r) => r.status !== "success")) return null;
      const [vault, depositor, asset, totalAssets] = first.map((r) => r.result) as [Address, Address, Address, bigint];
      if (BigInt(vault) === 0n || BigInt(depositor) === 0n) return null;
      const [earliestMaturity, float, hold, payableNow, lpBalance, lpSupply] = await all([
        { address: vault, abi: exitVaultAbi, functionName: "earliestMaturity" },
        { ...at, functionName: "float" },
        { ...at, functionName: "EXIT_HOLD" },
        { ...at, functionName: "maxWithdraw", args: [depositor] },
        { address: depositor, abi: erc20Abi, functionName: "balanceOf", args: [wallet] },
        { address: depositor, abi: erc20Abi, functionName: "totalSupply" },
      ]) as [number, bigint, number, bigint, bigint, bigint];
      return { vault, earliestMaturity: Number(earliestMaturity), asset, depositor, totalAssets, float, payableNow, lpBalance, lpSupply, hold: Number(hold) };
    },
    async exitDeskOf(factory) {
      // A factory before mandate 13 has no such entry, and the call reverts; a failure of the RPC fails the read.
      const [r] = await tried([{ address: factory, abi: exitFactoryAbi, functionName: "exitDesk" }]);
      return r?.status === "success" && BigInt(r.result as Address) !== 0n ? r.result as Address : null;
    },
    lenderMarket: (vault) => read<Address>(vault, exitVaultAbi, "LENDER_MARKET"),
    async exitOf(desk, vault, owner) {
      const at = { address: desk, abi: exitDeskAbi } as const;
      const [[shares, id, nonce], committedAt, life] = await all([
        { ...at, functionName: "exits", args: [vault, owner] }, { ...at, functionName: "committedAt", args: [vault, owner] }, { ...at, functionName: "EXIT_LIFE" },
      ]) as [readonly [bigint, bigint, bigint], bigint, bigint];
      return { shares, id, nonce, committedAt: Number(committedAt), life: Number(life) };
    },
    exitOwed: (desk, asset, owner) => read<bigint>(desk, exitDeskAbi, "owed", [asset, owner]),
    vaultPreviewWithdraw: (vault, assets) => read<bigint>(vault, exitVaultAbi, "previewWithdraw", [assets]),
    async exitVaultBook(vault, shares) {
      const at = { address: vault, abi: exitVaultAbi } as const;
      const [claim, free, total, principal, earned, supply] = await all([
        { ...at, functionName: "previewRedeem", args: [shares] }, { ...at, functionName: "freeLiquidity" }, { ...at, functionName: "totalAssets" },
        { ...at, functionName: "performingPrincipal" }, { ...at, functionName: "accruedInterest" }, { ...at, functionName: "totalSupply" },
      ]) as [bigint, bigint, bigint, bigint, bigint, bigint];
      const loans = principal + earned;
      return { claim, free, held: total > loans ? total - loans : 0n, loans, supply };
    },
    async exitRecords(factory, vault) {
      const views = await read<Address>(factory, exitFactoryAbi, "SHARE_VIEWS");
      return [...await read<readonly bigint[]>(views, shareViewsAbi, "rewardRecords", [vault])];
    },
    async exitShares(factory, vault, ids, who) {
      if (!ids.length) return [];
      const views = await read<Address>(factory, exitFactoryAbi, "SHARE_VIEWS");
      // Share views before D391 have no such entry, and the call reverts with no data; any other failure fails the read.
      return exitSharesFrom(await tried(ids.map((id) => ({ address: views, abi: shareViewsAbi, functionName: "exitShare", args: [vault, id, who] }))));
    },
    async exitFloorOf(desk, vault, id, owner) {
      // A desk before D391 has no such entry, and the call reverts with no data; any other failure fails the read.
      const [r] = await tried([{ address: desk, abi: exitDeskAbi, functionName: "floorOf", args: [vault, id, owner] }]);
      return exitFloorFrom(r);
    },
    async exitDebit(desk, vault, id) {
      // A desk before D391 has no such entry, and the call reverts with no data; any other failure fails the read.
      const [r] = await tried([{ address: desk, abi: exitDeskAbi, functionName: "exitDebit", args: [vault, id] }]);
      return exitDebitFrom(r);
    },
    async exitRecord(vault, id) {
      const r = await read<readonly unknown[]>(vault, exitVaultAbi, "loans", [id]);
      return {
        maturity: Number(r[3]), withdrawn: r[4] as boolean, settled: r[5] as boolean, principal: r[9] as bigint, interest: r[11] as bigint, rate: r[12] as bigint,
        clockStart: Number(r[13]),
      };
    },
    accrualEnd: (core, id) => read<bigint>(core, accrualAbi, "accrualEnd", [id]),
    saleSlots: async (vault, id) => Number(await read<number>(vault, exitVaultAbi, "lenderSaleSlots", [id])),
    async exitListing(desk, vault, id) {
      const [owner, nonce] = await read<readonly [Address, bigint]>(desk, exitDeskAbi, "listings", [vault, id]);
      return { owner, nonce };
    },
    async exitAsk(market, id) {
      const [listedAt, deadline, , , nonce, exit] = await read<readonly [number, number, number, number, bigint, boolean]>(market, lenderMarketAbi, "asks", [id]);
      return { listedAt: Number(listedAt), deadline: Number(deadline), nonce, exit };
    },
    withinAverage: (desk, vault, id) => read<boolean>(desk, exitDeskAbi, "withinAverage", [vault, id]),
    async pendingSettlements(desk, vault) {
      // A desk before r13d has no such entry, and the call reverts; a failure of the RPC fails the read.
      const [r] = await tried([{ address: desk, abi: exitDeskAbi, functionName: "pendingSettlements", args: [vault] }]);
      return r?.status === "success" ? [...r.result as readonly bigint[]] : [];
    },
    async boundExitDeskOf(factory) {
      // A factory before mandate 13 has no such entry, and the call reverts; a failure of the RPC fails the read.
      const [r] = await tried([{ address: factory, abi: exitFactoryAbi, functionName: "boundExitDesk" }]);
      return r?.status === "success" && BigInt(r.result as Address) !== 0n ? r.result as Address : null;
    },
    async foundGeneration(deployer, factory, block) {
      await ready();
      const low = (x: string) => x.toLowerCase() as Address;
      const logs = await client.getLogs({ address: deployer, event: generationDeployerAbi[0], fromBlock: BigInt(block), toBlock: BigInt(block), strict: true });
      const log = logs.find((l) => low(l.address) === low(deployer) && low(l.args.factory) === low(factory));
      if (!log) return null;
      const a = log.args;
      const deployed: DeployedGenerationRead = { id: a.id.toLowerCase() as Hex, asset: low(a.asset), name: a.name, blockNumber: Number(log.blockNumber),
        factory: low(a.factory), core: low(a.core), registry: low(a.registry), rewards: low(a.rewards), reserve: low(a.reserve), feeProcessor: low(a.feeProcessor),
        quoteVerifier: low(a.quoteVerifier), fillRouter: low(a.fillRouter), gradeRegistry: low(a.gradeRegistry), cashoutRouter: low(a.cashoutRouter),
        rolloverRouter: low(a.rolloverRouter) };
      const r = await tried([
        { address: deployer, abi: generationDeployerAbi, functionName: "isFactory", args: [deployed.factory] },
        { address: deployer, abi: generationDeployerAbi, functionName: "listed", args: [deployed.id] },
        { address: deployed.factory, abi: exitFactoryAbi, functionName: "boundExitDesk" },
        { address: deployed.factory, abi: factoryAbi, functionName: "MANDATE_VERSION" },
        { address: deployed.asset, abi: erc20Abi, functionName: "symbol" },
        { address: deployed.asset, abi: erc20Abi, functionName: "decimals" },
        { address: deployed.cashoutRouter, abi: flashSourceAbi, functionName: "FLASH_POOL" },
        { address: deployed.cashoutRouter, abi: flashSourceAbi, functionName: "POOL_MANAGER" },
      ]);
      const value = (i: number): unknown => (r[i]?.status === "success" ? r[i].result : undefined);
      const required = (i: number, what: string): unknown => {
        const answer = value(i);
        requireThat(answer !== undefined, "UNAVAILABLE", `${what} did not answer`, 503);
        return answer;
      };
      // A V3 cash-out router borrows from its FLASH_POOL(); a v4 router (the deployer's) from its PoolManager.
      const flashPool = (value(6) ?? required(7, "The cash-out router's FLASH_POOL() or POOL_MANAGER()")) as Address;
      const desk = value(2) as Address | undefined;
      return {
        deployed,
        recorded: required(0, "The deployer's isFactory()") === true,
        listed: required(1, "The deployer's listed()") === true,
        exitDesk: desk !== undefined && BigInt(desk) !== 0n ? low(desk) : null,
        mandateVersion: Number(required(3, "The factory's MANDATE_VERSION()")),
        symbol: required(4, "The asset's symbol()") as string,
        decimals: Number(required(5, "The asset's decimals()")),
        flashPool: low(flashPool),
      };
    },
    exitShortfall: (desk, vault, owner) => read<bigint>(desk, exitDeskAbi, "shortfall", [vault, owner]),
    earliestMaturity: async (vault) => Number(await read<number>(vault, exitVaultAbi, "earliestMaturity")),
    async vaultMaxWithdraw(vault, owner) {
      // A vault before ERC-4626 has no such entry, and the call reverts; a failure of the RPC fails the read.
      const [r] = await tried([{ address: vault, abi: partnerVault4626Abi, functionName: "maxWithdraw", args: [owner] }]);
      return r?.status === "success" ? r.result as bigint : null;
    },
    async simulateCalls(from, calls) {
      await ready();
      try {
        const { results } = await simulateCalls(client, { account: from, calls: calls.map((x) => ({ to: x.to, data: x.data, value: x.value })) });
        return results.map((r) => r.status === "success");
      } catch {
        return null;
      }
    },
    async lpFeesOwed(core, loanId, borrower) {
      await ready();
      try {
        const { result } = await client.simulateContract({ address: core, abi: lpCoreAbi, functionName: "collectFees", args: [loanId], account: borrower });
        return { amount0: result[0], amount1: result[1] };
      } catch (error) {
        // A revert says nothing is collectable now; a failure of the RPC fails the read.
        if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError)) return null;
        throw error;
      }
    },
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
