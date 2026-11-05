/**
 * gage-sdk (D224, D301): gage's engine for builders and agents. It reads gage, prepares unsigned transactions and, given
 * the caller's own signer, carries actions out: borrow, leverage, cancel, repay, cash out (D245), roll over by hand or by
 * itself (D285), puts where a lend asset offers them (open, close, roll), Earn deposits and withdrawals, collect, and on
 * mainnet a rating of gage (D302), and the LP lane where a release makes it public (D314, D315: loans against Uniswap v3
 * and v4, SushiSwap v3 and Ramses positions, and its vaults). On Robinhood Chain (4663,
 * `network: "mainnet"`, D260) and its testnet (46630, the default, D222), each serving the actions its deployment can
 * carry out (`actionsOn`: the testnet has no rollover router); on mainnet the tools that sign with an agent's own key
 * come only under spend limits (D225, D297). gage never holds a key, and private loans are never served (D209). A
 * release's public lend assets besides USDG (D251) are served too, every amount named in its own asset. Park and unpark
 * (D334): an out-of-range LP position pulled out on its own DEX into a partner vault, and back into a new range, as one
 * batch of calls from the LP's own wallet, for gage's app and DEXes' own frontends alike. Exit now (Intent D57): a
 * partner-vault holder's, and a rehypo pool LP's (root D357), through the chain's exit desk where a release names one.
 */
export { createGage, gageFrom, type Gage, type GageOptions, type GageScope } from "./client.js";
export { foundGenerationsRefresher, mergeFoundGenerations, proveFoundGenerations } from "./discovery.js";
export { chainFor, MULTICALL3, robinhoodMainnet, robinhoodTestnet } from "./chains.js";
export {
  createChain, type BatchCall, type Call, type Chain, type DeployedGenerationRead, type DexPosition, type FoundGenerationRead, type IntentFactoryState, type Loan, type LpFacts,
  type LpLoan, type LpPoolConfig, type LpRegistryState, type LpVaultState, type OwnedPositions, type RehypoSourceRead, type Sent, type TokenConfig, type V4Position, type VaultBook,
} from "./chain.js";
export {
  chooseExitHolding, chooseExitLoan, EXIT_CONFIRM_SECONDS, EXIT_FALL_SECONDS, EXIT_GRACE_SECONDS, EXIT_KEEP_BPS, EXIT_LISTING_SECONDS, exitBook, exitCommitted, exitEligible, exitFit,
  exitFloor, exitNeed, exitNeedFloor, exitPosition, exitRank, exitShares, exitStage, exitMayTakeOver, exitStakeFloor, exitStakes, liveExit,
  type ExitAsk, type ExitChoice, type ExitCoreLoan, type ExitHolding, type ExitReads, type ExitRecord, type ExitShare, type ExitStage, type ExitStake, type ExitState,
} from "./exitChoice.js";
export type { ExitLine } from "./earnExit.js";
export {
  assetOf, engineOf, generationOfCore, lendAssetOf, lendsMore, lpAdapterOf, lpPoolOf, lpVaultOf, MAINNET, parkPoolsOf, parseDeployment, parseLpLane, putGenerations, TESTNET,
  type Asset, type ChainId, type Deployment, type Engine, type Generation, type LendAsset, type LoopPool, type LpAdapter, type LpAdapterKind, type LpExecutor,
  type LpLane, type LpPool, type LpVault, type ParkKind, type ParkPool, type PoolKey,
} from "./deployment.js";
export { MAINNET_MANIFEST } from "./deployments/mainnet.js";
export { TESTNET_MANIFEST } from "./deployments/testnet.js";
export {
  actionsOn, defaultsFor, MAINNET_DEFAULTS, networkNamed, TESTNET_DEFAULTS, type Beacon, type Network, type NetworkDefaults,
} from "./networks.js";
export { ApiError, refusalOf, requireThat } from "./errors.js";
export {
  boundUnder, chooseSource, firstRunnable, fitsCap, keepsHeadroom, LOOP_HEADROOM_BPS, loopCall, loopCap, loopPayout, loopSpendable, parseLoopBuy, rankLoopQuotes,
  type LoopBase, type LoopBuyWant, type LoopCall, type LoopChoice, type LoopQuote, type ViaRoute,
} from "./loopSources.js";
export { principalFor, putBuy, rankSwaps, spendBound, swapOf, type PutSwap, type SwapQuote } from "./puts.js";
export { waitForFill, type FillOutcome, type WaitOptions } from "./fill.js";
export { generationFor, redeemableShares, type Ctx, type InAsset, type Made, type Plan, type Row, type Step, type Summary, type TokenRef, type Tx, type View } from "./plans.js";
export { prepareNext, type BatchTx, type NextTx, type Prepared } from "./prepare.js";
// The card itself is gage-sdk/visual's `renderPreview`, apart, so an integration that draws its own never bundles it.
export type { ExitPreview, Preview, PreviewStep } from "./preview.js";
export {
  holdingOf, mintCall, mintFigures, PARK_DEADLINE, PARK_RULE, parkBatch, parkPoolFrom, parkPoolInput, parkPoolsIn, pullCalls, RAMSES_CLAIM_DELAY, rangeText, unlockData, V4_ACTION,
  type Held, type ParkBatch, type ParkCall, type ParkPoolInput,
} from "./park.js";
export { LEND_ASSET_RULE, PRIVATE_RULE, PUT_RULE, RULES } from "./reads.js";
export {
  costCeiling, LP_FORMATS, LP_RULE, LP_STATE, lpCostBps, MAX_LP_LOANS, MAX_LP_POSITIONS, positionAmounts, valueInUsdg,
  type LoanQuote, type LpPositionRef, type SignedLpQuote,
} from "./lp.js";
export type { LpAmount, LpView } from "./lpPlans.js";
export { lpSharesText, lpShareUnit } from "./lpShares.js";
export { run, type Hold, type RunOptions, type RunResult, type SentStep, type SpendLimit } from "./run.js";
export {
  ACTIONS, actionInput, actionShapes, borrowQuoteInput, emptyInput, leverageQuoteInput, loanInput, lpQuoteInput, parseInput, putQuoteInput, reviewAdvance, reviewToken, signedShapes,
  vaultInput, walletInput,
  type ActionInput, type ActionName, type ActionRequest,
} from "./schemas.js";
export { privateKeySigner, viemSigner, type Signer, type SignerTransaction } from "./signer.js";
export { gageTools, plain, poolVaultTools, type GageTool, type ToolOptions } from "./tools.js";
export {
  createPoolVaultsInput, NAME_MAX_BYTES, parsePoolName, poolsOf, poolTag, poolVaultName, poolVaultsInput,
  type PoolOf, type PoolSidePlan, type PoolSideVault, type PoolVaultsCreation,
} from "./pools.js";
export { batchChecksum, safeBatch, TX_BUILDER_VERSION, type SafeBatch } from "./safe.js";
export { createUpstream, type Upstream } from "./upstream.js";
export { aggregatorCallOk, KYBER_EXECUTOR, type SwapWant } from "./aggregatorCall.js";
export * as abi from "./abi.js";
