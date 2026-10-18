/**
 * gage-sdk (D224, D301): gage's engine for builders and agents. It reads gage, prepares unsigned transactions and, given
 * the caller's own signer, carries actions out: borrow, leverage, cancel, repay, cash out (D245), roll over by hand or by
 * itself (D285), Earn deposits and withdrawals, collect, and on mainnet a rating of gage (D302). On Robinhood Chain (4663,
 * `network: "mainnet"`, D260) and its testnet (46630, the default, D222), each serving the actions its deployment can
 * carry out (`actionsOn`: the testnet has no rollover router); on mainnet the tools that sign with an agent's own key
 * come only under spend limits (D225, D297). gage never holds a key, and private loans are never served (D209). A
 * release's public lend assets besides USDG (D251) are served too, every amount named in its own asset.
 */
export { createGage, gageFrom, type Gage, type GageOptions, type GageScope } from "./client.js";
export { chainFor, MULTICALL3, robinhoodMainnet, robinhoodTestnet } from "./chains.js";
export { createChain, type Call, type Chain, type Loan, type Sent, type TokenConfig, type VaultBook } from "./chain.js";
export {
  assetOf, engineOf, generationOfCore, lendAssetOf, lendsMore, MAINNET, parseDeployment, TESTNET,
  type Asset, type ChainId, type Deployment, type Engine, type Generation, type LendAsset, type LoopPool, type PoolKey,
} from "./deployment.js";
export { MAINNET_MANIFEST } from "./deployments/mainnet.js";
export { TESTNET_MANIFEST } from "./deployments/testnet.js";
export {
  actionsOn, defaultsFor, MAINNET_DEFAULTS, networkNamed, signingToolsOpen, TESTNET_DEFAULTS, type Beacon, type Network, type NetworkDefaults,
} from "./networks.js";
export { ApiError, refusalOf, requireThat } from "./errors.js";
export {
  boundUnder, chooseSource, firstRunnable, fitsCap, keepsHeadroom, LOOP_HEADROOM_BPS, loopCall, loopCap, loopPayout, loopSpendable, parseLoopBuy, rankLoopQuotes,
  type LoopBase, type LoopBuyWant, type LoopCall, type LoopChoice, type LoopQuote, type ViaRoute,
} from "./loopSources.js";
export { waitForFill, type FillOutcome, type WaitOptions } from "./fill.js";
export { generationFor, redeemableShares, type Ctx, type InAsset, type Made, type Plan, type Row, type Step, type Summary, type TokenRef, type Tx, type View } from "./plans.js";
export { prepareNext, type NextTx, type Prepared } from "./prepare.js";
export { LEND_ASSET_RULE, RULES } from "./reads.js";
export { run, type Hold, type RunOptions, type RunResult, type SentStep, type SpendLimit } from "./run.js";
export {
  ACTIONS, actionInput, actionShapes, borrowQuoteInput, emptyInput, leverageQuoteInput, loanInput, parseInput, reviewAdvance, reviewToken, signedShapes, walletInput,
  type ActionInput, type ActionName, type ActionRequest,
} from "./schemas.js";
export { privateKeySigner, viemSigner, type Signer, type SignerTransaction } from "./signer.js";
export { gageTools, plain, type GageTool, type ToolOptions } from "./tools.js";
export { createUpstream, type Upstream } from "./upstream.js";
export { aggregatorCallOk, KYBER_EXECUTOR, type SwapWant } from "./aggregatorCall.js";
export * as abi from "./abi.js";
