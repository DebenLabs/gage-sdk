import { parseAbi } from "viem";

// Only what the service reads and the user-owned calls it prepares. Signatures from contracts/src (v2, intent, loop).
export const engineAbi = parseAbi([
  "struct Collateral { uint8 kind; address token; uint256 amountOrTokenId; }",
  "struct V2Loan { address originator; address account; address token; address collateralBeneficiary; uint8 kind; uint8 state; uint8 filled; uint32 term; uint40 fundingDeadline; uint40 fundedAt; uint40 closedAt; uint128 principal; uint128 cap; uint128 originationFee; uint128 borrowerReward; uint128 lenderReward; uint256 collateral; bytes32 exposureKey; uint256 exposureAmount; }",
  "function getLoan(uint256 id) view returns (V2Loan)",
  // The last id listed: ids run from 1, so a loan past it is not listed yet at the block read.
  "function loanCount() view returns (uint256)",
  "function USDG() view returns (address)",
  "function ownerOf(uint256 id) view returns (address)",
  "function cashCredit(address) view returns (uint256)",
  "function list(Collateral c, uint128 principal, uint128 cap, uint32 term, uint40 fundingDeadline, bool withRewards) returns (uint256 id)",
  "function cancelFunding(uint256 id)",
  "function reclaim(uint256 id, address recipient)",
  "function withdrawCollateral(uint256 id, address recipient)",
  "function withdrawUSDG(address recipient)",
  // The reclaim right is an ERC-721: a roll moves it through the rollover router (D285), approved for one loan or all.
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  // How many rights a wallet holds: one per loan waiting for funding or running, minted at its listing, burnt at its close.
  "function balanceOf(address owner) view returns (uint256)",
  // A listing's id, from its receipt, and the moment the vaults fund it.
  "event Listed(uint256 indexed id, address indexed borrower, address account, Collateral collateral, uint128 principal, uint128 cap, uint32 term, uint40 fundingDeadline)",
  "event Activated(uint256 indexed id, uint40 fundedAt, uint128 fee, uint128 borrowerReward, uint128 lenderReward)",
]);
export const registryAbi = parseAbi([
  "struct ERC20Config { bool allowed; uint8 lane; uint256 minAmount; uint256 maxDealRaw; uint256 maxOpenRaw; }",
  "function getERC20Config(address token) view returns (ERC20Config)",
  "function allowedTerms() view returns (uint32[])",
  "function feeBps() view returns (uint16)",
  "function newDealsPaused() view returns (bool)",
  // An unbridged core's listing rewards for a six-decimal fee (R2 option C: a stablecoin market posts its terms scaled).
  "function quoteRewards(uint32 term, uint128 fee) view returns (uint128 borrower, uint128 lender)",
]);
export const rewardsAbi = parseAbi([
  "function claimable(uint256 id, address account) view returns (uint256)",
  "function claim(uint256 id, address recipient)",
  // What a separately funded ledger may still allocate: an activation above it reverts InsufficientBudget (R2 option C).
  "function freeBudget() view returns (uint256)",
]);
export const accountAbi = parseAbi(["function released() view returns (bool)"]);
/**
 * A private-lane router (contracts/src/private/PrivateBorrowRouter.sol, D201): the one core it lists on, and what it
 * opened as each of that core's loan ids, written in the loan's own listing transaction and never cleared (a zero token
 * for a loan it did not open). The audit of 18 October 2026 (M7): how gage-sdk tells a private loan from the chain.
 */
export const privateRouterAbi = parseAbi([
  "function CORE() view returns (address)",
  "function opened(uint256 id) view returns (address token, uint128 principal, bool open)",
]);
/**
 * A partner vault factory (contracts/src/intent/IntentFactory.sol): whether it made a vault, and what pool vault creation
 * (D333) checks and calls: its core and version, who may create (an admitted creator, or anyone while `openCreation`,
 * Intent D43), how it classifies a token, and `create` itself.
 */
export const factoryAbi = parseAbi([
  "function isVault(address) view returns (bool)",
  "function CORE() view returns (address)",
  "function MANDATE_VERSION() view returns (uint256)",
  "function isCreator(address) view returns (bool)",
  "function openCreation() view returns (bool)",
  "function categoryOf(address) view returns (bool classified, uint8 category)",
  "function create((address curator,uint16[4] categoryWeights,address[] assets,uint32 maxLoanTerm,uint16 feeBps,uint8 minGrade,uint8 minRateGrade,uint128 maxLoanPrincipal,uint16 maxAssetBps,uint16 bufferBps,uint16 executionCapBps) mandate,bool secondaryEnabled,uint16 secondaryExtraBps,string name) returns (address vault)",
  // Mandate 13 (Intent D56): `secondaryOnly`, a vault that buys running loans and funds no new one.
  "function create((address curator,uint16[4] categoryWeights,address[] assets,uint32 maxLoanTerm,uint16 feeBps,uint8 minGrade,uint8 minRateGrade,uint128 maxLoanPrincipal,uint16 maxAssetBps,uint16 bufferBps,uint16 executionCapBps) mandate,bool secondaryEnabled,uint16 secondaryExtraBps,bool secondaryOnly,string name) returns (address vault)",
  "event VaultCreated(address indexed vault,address indexed curator,address creator,uint256 index)",
]);
/**
 * A rehypo source (contracts/src/rehypo/GageRehypoSource.sol, D345): what a pool LP's exit now (root D357) reads of it,
 * `exitNow` itself, and the errors it can revert with.
 */
export const rehypoSourceAbi = parseAbi([
  "function vault() view returns (address)",
  "function depositor() view returns (address)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function float() view returns (uint256)",
  "function EXIT_HOLD() view returns (uint32)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function exitNow(uint256 id)",
  "error NoExitDesk()", "error NothingToExit()", "error VaultSettling()", "error InsideUnlock()", "error NoVault()",
]);
/**
 * The chain's exit desk (contracts/src/intent/IntentExitDesk.sol, Intent D57): a holder's exit and when it was committed
 * (it lapses `EXIT_LIFE` later), what the vault cannot pay of it now (`shortfall`), what its sales left the holder to
 * collect, a holding's exit listing, the average-yield rule; a holder's own calls (commit and list, list the next
 * holding, cancel, collect) and the errors they can revert with.
 */
export const exitDeskAbi = parseAbi([
  "function exits(address vault, address owner) view returns (uint256 shares, uint256 id, uint64 nonce)",
  "function committedAt(address vault, address owner) view returns (uint256)",
  "function EXIT_LIFE() view returns (uint256)",
  "function shortfall(address vault, address owner) view returns (uint256)",
  "function owed(address asset, address owner) view returns (uint256)",
  "function listings(address vault, uint256 id) view returns (address owner, uint64 nonce)",
  "function withinAverage(address vault, uint256 id) view returns (bool)",
  // r13d: the records of the vault only its `settle` books; while any waits, the desk lists nothing (`SettlementPending`).
  "function pendingSettlements(address vault) view returns (uint256[] ids)",
  // SEC-01 (root D391): what an exit sale of a holding charged its leaver, the buyer's discount below the listing's start.
  "function exitDebit(address vault, uint256 id) view returns (address owner, uint256 debit)",
  // SEC-01 (root D391): where the desk would stop holding `id`'s listing for `owner`'s exit; a live exit listing passes to
  // an exit whose floor there is strictly lower than the floor of the exit it serves.
  "function floorOf(address vault, uint256 id, address owner) view returns (uint256)",
  "event ExitDebited(address indexed vault, address indexed owner, uint256 indexed id, uint256 pocketId, uint256 debit)",
  "function exitNow(address vault, uint256 shares, uint256 id)",
  "function list(address vault, address owner, uint256 id)",
  "function cancel(address vault)",
  "function withdraw(address asset) returns (uint256 amount)",
  "error NotDeskVault()", "error NotOwner()", "error InvalidAmount()", "error NoExit()", "error ListingLive()", "error NoShortfall()", "error AboveAverageYield()",
  "error SettlementPending()", "error NothingToPay()",
]);
/**
 * What choosing the holding an exit lists reads around the desk (Intent D57): the factory's desk now (zero while exits
 * are closed), the one it bound for good, which keeps every commitment and what sales owe while they are, and its share
 * views.
 */
export const exitFactoryAbi = parseAbi([
  "function exitDesk() view returns (address)",
  "function boundExitDesk() view returns (address)",
  "function SHARE_VIEWS() view returns (address)",
]);
/**
 * A release's GenerationDeployer (r13, D347) as gage-sdk proves a lend generation its indexer found (src/discovery.ts):
 * its own record of each generation it built (`GenerationDeployed`), of each factory (`isFactory`) and of its listing.
 */
export const generationDeployerAbi = parseAbi([
  "event GenerationDeployed(bytes32 indexed id, address indexed asset, address factory, address core, address registry, address rewards, address reserve, address feeProcessor, address quoteVerifier, address fillRouter, address gradeRegistry, address cashoutRouter, address rolloverRouter, string name)",
  "function isFactory(address factory) view returns (bool)",
  "function listed(bytes32 id) view returns (bool)",
]);
/** A cash-out router's flash source: a V3 router's `FLASH_POOL()`, a v4 router's (D348) `POOL_MANAGER()`. */
export const flashSourceAbi = parseAbi(["function FLASH_POOL() view returns (address)", "function POOL_MANAGER() view returns (address)"]);
/** The factory's share views (`IntentVaultViews`): a vault's open records, the set the desk weighs a holding against. */
export const shareViewsAbi = parseAbi([
  "function rewardRecords(address vault) view returns (uint256[])",
  // SEC-01 (root D391): what a holder carried of a holding's exposure window and the window's supply, as a sale would close it now.
  "function exitShare(address vault, uint256 id, address who) view returns (uint256 exposure, uint256 supply)",
]);
/**
 * A partner vault's records, sale slots and market, as the desk reads a holding, when its next settlement falls due, and
 * what the desk's `shortfall` reads of it: a commitment's claim, what the vault holds outside its loans and the loans.
 */
export const exitVaultAbi = parseAbi([
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function freeLiquidity() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function performingPrincipal() view returns (uint256)",
  "function accruedInterest() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function LENDER_MARKET() view returns (address)",
  "function earliestMaturity() view returns (uint40)",
  "function lenderSaleSlots(uint256 id) view returns (uint8)",
  "function loans(uint256 id) view returns (uint8 slots, uint8 lane, uint16 feeBps, uint40 maturity, bool withdrawn, bool settled, bool recovered, bool repaid, uint64 snapshotId, uint128 principal, uint256 snapshotSupply, uint128 interest, uint128 rate, uint64 clockStart, uint128 executionFee, bool executionEarned)",
]);
/** A vault's market (mandate 13, Intent D56): a holding's listing. */
export const lenderMarketAbi = parseAbi([
  "function asks(uint256 id) view returns (uint40 listedAt, uint40 deadline, uint16 maxFeeBps, uint8 slots, uint64 nonce, bool exit)",
]);
/** The Intent core: where a loan's interest clock stops (`accrualEnd`). */
export const accrualAbi = parseAbi(["function accrualEnd(uint256 id) view returns (uint256)"]);
/** The PoolManager's StateView: the pool leverage buys through, its price, liquidity and initialized ticks (v4-periphery StateView). */
export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getTickBitmap(bytes32 poolId, int16 tick) view returns (uint256 tickBitmap)",
  "function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);
export const partnerVaultAbi = parseAbi([
  "function VAULT() view returns (address)",
  "function USDG() view returns (address)",
  "function deposit(uint256 assets, uint256 minShares) returns (uint256 shares)",
  "function redeem(uint256 shares, uint256 minAssets) returns (uint256 assets)",
  "function pocketClaimable(uint256 pocketId, address who) view returns (uint256)",
  "function claimPocket(uint256 pocketId) returns (uint256 amount)",
  "function claimPockets(uint256[] pocketIds)",
  "function rewardClaimable(address who) view returns (uint256)",
  "function claimRewards() returns (uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function freeLiquidity() view returns (uint256)",
  "function performingPrincipal() view returns (uint256)",
  // Booking its loans' outcomes, anyone's call: while one is past its end unbooked, deposits and redemptions wait.
  "function settle(uint256[] ids)",
]);
/**
 * The loop router (contracts/src/loop/LoopRouter.sol): its three ways to buy the purchase, a hookless v4 pool (`loop`), a
 * V3 pool (`loopV3`, D242) or an admitted aggregator with flash-borrowed USDG (`loopVia`, D243), what the SDK reads of it,
 * its events and every error it can revert with (test/abi.test.ts holds this to the compiled router).
 */
export const loopRouterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Loop { PoolKey key; uint256 own; uint256 buy; uint256 maxCost; uint40 fundingDeadline; bool withRewards; bytes32 pricing; }",
  "struct LoopV3 { uint24 fee; uint256 own; uint256 buy; uint256 maxCost; uint40 fundingDeadline; bool withRewards; bytes32 pricing; }",
  "struct LoopVia { address executor; bytes data; address flashToken; uint24 flashFee; uint256 spend; uint256 own; uint256 buy; uint256 maxCost; uint40 fundingDeadline; bool withRewards; bytes32 pricing; }",
  "struct Allocation { address vault; uint8 units; uint128 principal; uint128 interest; uint128 minimum; uint128 executionFee; uint128 maxReserveShares; uint8 minRateGrade; uint16 capBps; uint16 managerBps; }",
  "struct Plan { address engine; uint256 listingId; address filler; address token; uint8 kind; uint256 collateral; uint128 principal; uint128 cap; uint32 term; uint32 costBps; uint32 feePolicy; uint64 epoch; uint40 issuedAt; uint40 expiry; bytes32 evidence; Allocation[] allocations; }",
  "function loop(Loop l, Plan plan, bytes signature, uint256[] maxReserveShares) returns (uint256 id, uint256 cost)",
  "function loopV3(LoopV3 l, Plan plan, bytes signature, uint256[] maxReserveShares) returns (uint256 id, uint256 cost)",
  "function loopVia(LoopVia l, Plan plan, bytes signature, uint256[] maxReserveShares) returns (uint256 id, uint256 cost)",
  "function V3_FACTORY() view returns (address)",
  "function executorAllowed(address executor) view returns (bool allowed)",
  "event Looped(uint256 indexed id, address indexed borrower, address indexed token, uint256 own, uint256 bought, uint256 cost, uint128 principal, uint128 cap, uint32 term)",
  "event BoughtVia(uint256 indexed id, address indexed executor, address flashPool, uint256 spent, uint256 flashFee, uint256 surplus)",
  "error CollateralMismatch(uint256 planned, uint256 looped)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error InexactTransfer(uint256 expected, uint256 received)",
  "error InvalidConfiguration()",
  "error InvalidExecutor()",
  "error InvalidPool()",
  "error ListingMismatch(uint256 listed, uint256 planned)",
  "error NotBorrowersPlan()",
  "error NotPool()",
  "error NotPoolManager()",
  "error NothingToBuy()",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error PartialPurchase(uint256 bought, uint256 wanted)",
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address token)",
  "error StrayBalance()",
  "error TooExpensive(uint256 cost, uint256 maxCost)",
]);
/** A Uniswap V3 pool (v3-core's UniswapV3Pool): where leverage prices a purchase through it (D242), its initialized ticks included. */
export const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);
/**
 * The rollover router (contracts/src/rollover/RolloverRouter.sol, D285): the roll a borrower sends, the standing
 * instruction left for gage's keeper, what the SDK reads of it, its events and every error it can revert with
 * (scripts/drift/abi-drift.mjs holds this to the compiled router).
 */
export const rolloverRouterAbi = parseAbi([
  "struct Roll { uint256 loanId; uint256 maxTopUp; bool withRewards; bytes32 pricing; }",
  "struct Allocation { address vault; uint8 units; uint128 principal; uint128 interest; uint128 minimum; uint128 executionFee; uint128 maxReserveShares; uint8 minRateGrade; uint16 capBps; uint16 managerBps; }",
  "struct Plan { address engine; uint256 listingId; address filler; address token; uint8 kind; uint256 collateral; uint128 principal; uint128 cap; uint32 term; uint32 costBps; uint32 feePolicy; uint64 epoch; uint40 issuedAt; uint40 expiry; bytes32 evidence; Allocation[] allocations; }",
  "struct AutoRoll { address borrower; uint32 term; uint32 window; uint8 rollsLeft; bool withRewards; address executor; uint40 until; uint128 maxCost; uint128 maxTopUp; }",
  "function roll(Roll r, Plan[] plans, bytes[] signatures, uint256[] maxReserveShares) returns (uint256 id)",
  "function setAutoRoll(uint256 loanId, address executor, uint32 term, uint32 window, uint128 maxCost, uint128 maxTopUp, uint8 rollsLeft, bool withRewards, uint40 until)",
  "function cancelAutoRoll(uint256 loanId)",
  "function autoRolls(uint256 loanId) view returns (address borrower, uint32 term, uint32 window, uint8 rollsLeft, bool withRewards, address executor, uint40 until, uint128 maxCost, uint128 maxTopUp)",
  "function rollableAt(uint256 loanId) view returns (uint256)",
  "function CORE() view returns (address)",
  "function paused() view returns (bool)",
  "event Rolled(uint256 indexed oldId, uint256 indexed newId, address indexed borrower, address caller, uint128 repaid, uint128 principal, uint128 cap, uint32 term, uint256 topUp)",
  "event AutoRollSet(uint256 indexed loanId, address indexed borrower, AutoRoll autoRoll)",
  "event AutoRollCancelled(uint256 indexed loanId, address indexed borrower)",
  "event AutoRollCarried(uint256 indexed fromId, uint256 indexed toId, uint8 rollsLeft)",
  "error AutoRollEnded()",
  "error CollateralMismatch()",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error InexactTransfer(uint256 expected, uint256 received)",
  "error InvalidAutoRoll()",
  "error InvalidConfiguration()",
  "error ListingMismatch(uint256 listed, uint256 planned)",
  "error NoAutoRoll()",
  "error NotActive()",
  "error NotBorrower()",
  "error NotBorrowersPlan()",
  "error NotExecutor()",
  "error NotPoolManager()",
  "error NothingToRescue()",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error PlanMismatch()",
  "error PrincipalMismatch(uint128 planned, uint128 old)",
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address token)",
  "error StrayBalance()",
  "error TermMismatch(uint32 planned, uint32 wanted)",
  "error TooEarly(uint256 opensAt)",
  "error TooExpensive(uint256 cost, uint256 maxCost)",
  "error TopUpTooHigh(uint256 topUp, uint256 maxTopUp)",
]);
/**
 * The put router (contracts/src/put/PutRouter.sol; docs/api.md "Puts on lend-asset generations"): a loan closed out of
 * its own collateral (`close`), rolled with the collateral token buying what the new payout leaves short (`roll`), the
 * standing instruction left for gage's keeper, what the SDK reads of it, its events and every error it can revert with
 * (test/abi.test.ts holds this to the compiled router). A swap's `venue` is 0 for a hookless v4 pool by its key, 1 for
 * the V3 factory's pool at `v3Fee`.
 */
export const putRouterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Swap { uint8 venue; PoolKey key; uint24 v3Fee; }",
  "struct Close { uint256 loanId; Swap swap; uint256 maxSpend; uint256 minBack; address recipient; }",
  "struct Roll { uint256 loanId; Swap swap; uint256 maxSpend; bool withRewards; bytes32 pricing; }",
  "struct Allocation { address vault; uint8 units; uint128 principal; uint128 interest; uint128 minimum; uint128 executionFee; uint128 maxReserveShares; uint8 minRateGrade; uint16 capBps; uint16 managerBps; }",
  "struct Plan { address engine; uint256 listingId; address filler; address token; uint8 kind; uint256 collateral; uint128 principal; uint128 cap; uint32 term; uint32 costBps; uint32 feePolicy; uint64 epoch; uint40 issuedAt; uint40 expiry; bytes32 evidence; Allocation[] allocations; }",
  "struct AutoRoll { address borrower; uint32 term; uint32 window; uint8 rollsLeft; bool withRewards; address executor; uint40 until; uint128 maxCost; uint128 maxSpend; }",
  "function close(Close c) returns (uint256 spent, uint256 returned)",
  "function roll(Roll r, Plan[] plans, bytes[] signatures, uint256[] maxReserveShares) returns (uint256 id)",
  "function setAutoRoll(uint256 loanId, address executor, uint32 term, uint32 window, uint128 maxCost, uint128 maxSpend, uint8 rollsLeft, bool withRewards, uint40 until)",
  "function cancelAutoRoll(uint256 loanId)",
  "function autoRolls(uint256 loanId) view returns (address borrower, uint32 term, uint32 window, uint8 rollsLeft, bool withRewards, address executor, uint40 until, uint128 maxCost, uint128 maxSpend)",
  "function rollableAt(uint256 loanId) view returns (uint256)",
  "function evidenceFor(address borrower, bytes32 pricing) pure returns (bytes32)",
  "function CORE() view returns (address)",
  "function USDG() view returns (address)",
  "function V3_FACTORY() view returns (address)",
  "function paused() view returns (bool)",
  "event Closed(uint256 indexed loanId, address indexed borrower, address recipient, uint128 repaid, uint256 spent, uint256 returned)",
  "event Rolled(uint256 indexed oldId, uint256 indexed newId, address indexed borrower, address caller, uint128 repaid, uint128 principal, uint128 cap, uint32 term, uint256 topUp, uint256 spent)",
  "event AutoRollSet(uint256 indexed loanId, address indexed borrower, AutoRoll autoRoll)",
  "event AutoRollCancelled(uint256 indexed loanId, address indexed borrower)",
  "event AutoRollCarried(uint256 indexed fromId, uint256 indexed toId, uint8 rollsLeft)",
  "error AutoRollEnded()",
  "error CollateralMismatch()",
  "error CostTooHigh(uint256 cost, uint256 maxCost)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error InexactTransfer(uint256 expected, uint256 received)",
  "error InvalidAutoRoll()",
  "error InvalidConfiguration()",
  "error InvalidRecipient()",
  "error InvalidSwap()",
  "error ListingMismatch(uint256 listed, uint256 planned)",
  "error NoAutoRoll()",
  "error NotActive()",
  "error NotBorrower()",
  "error NotBorrowersPlan()",
  "error NotExecutor()",
  "error NotPool()",
  "error NotPoolManager()",
  "error NothingToRescue()",
  "error OwnableInvalidOwner(address owner)",
  "error OwnableUnauthorizedAccount(address account)",
  "error PartialPurchase(uint256 bought, uint256 wanted)",
  "error PlanMismatch()",
  "error PrincipalMismatch(uint128 planned, uint128 old)",
  "error ReentrancyGuardReentrantCall()",
  "error ReturnTooLow(uint256 returned, uint256 minBack)",
  "error SafeERC20FailedOperation(address token)",
  "error SpendTooHigh(uint256 spent, uint256 maxSpend)",
  "error StrayBalance()",
  "error TermMismatch(uint32 planned, uint32 wanted)",
  "error TooEarly(uint256 opensAt)",
]);
/**
 * The cash-out router (contracts/src/v2/GageV2CashoutRouter.sol, D245): the sale `cashOutVia` makes through an executor
 * its owner admits, which repays the loan from a flash loan of its cap and pays the holder what the sale leaves.
 */
export const cashoutRouterAbi = parseAbi([
  "struct ExitVia { uint256 loanId; address recipient; uint256 minimumNet; uint256 maxFinanceFee; uint256 deadline; address executor; bytes data; address flashToken; uint24 flashFee; uint256 minUsdgOut; }",
  "function cashOutVia(ExitVia exit) returns (uint256 gross, uint256 financeFee, uint256 platformFee, uint256 net)",
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Route { uint8 kind; address tokenIn; address tokenOut; uint24 v3Fee; PoolKey key; uint256 minOut; }",
  "struct Exit { uint256 loanId; address recipient; uint256 minimumNet; uint256 maxFinanceFee; uint256 minUnderlying0; uint256 minUnderlying1; uint256 deadline; Route[] routes; }",
  "function cashOutDetailed(Exit exit) returns (uint256 gross, uint256 financeFee, uint256 platformFee, uint256 net)",
  "function executorAllowed(address executor) view returns (bool)",
  "event CashedOut(uint256 indexed loanId, address indexed owner, address indexed recipient, uint256 gross, uint256 cap, uint256 financeFee, uint256 platformFee, uint256 net)",
  "error InvalidExit()",
  "error InsufficientOutput()",
  "error InvalidExecutor()",
  "error BadCallback()",
]);
/**
 * ERC-8004's registries (erc-8004-contracts 2.0.0, the canonical 0x8004 deployment on Robinhood Chain), not gage's own:
 * who owns or operates gage's entry (D291), and a rating of it (D302).
 */
export const agentIdentityAbi = parseAbi([
  "function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)",
]);
export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
]);
/**
 * The LP lane (contracts/src/lp, docs/api.md "LP lane", D314, D315, D317): its core's loans and credits and the calls a
 * borrower sends (borrow on a signed quote, roll a running loan into a new one on the same position, repay, take the
 * position back, collect fees and rewards, withdraw a credit).
 */
export const lpCoreAbi = parseAbi([
  "struct LPLoan { address borrower; address vault; address adapter; address escrow; address pool; uint256 tokenId; uint128 principal; uint128 repayment; uint40 start; uint40 end; uint8 state; bool positionReturned; }",
  "struct LoanQuote { address borrower; address vault; address adapter; uint256 tokenId; uint128 liquidity; int24 tickLower; int24 tickUpper; uint128 collateralValue; uint128 principal; uint128 repayment; uint32 term; uint16 feeBps; uint64 deadline; }",
  "function loan(uint256 loanId) view returns (LPLoan)",
  "function nextLoanId() view returns (uint256)",
  "function credit(address account, address token) view returns (uint256)",
  "function borrow(LoanQuote quote, bytes signature) returns (uint256 loanId)",
  "function roll(uint256 loanId, LoanQuote quote, bytes signature) returns (uint256 newLoanId)",
  "function repay(uint256 loanId)",
  "function returnPosition(uint256 loanId)",
  "function collectFees(uint256 loanId) returns (uint256 amount0, uint256 amount1)",
  "function claimRewards(uint256 loanId)",
  "function withdraw(address token) returns (uint256 amount)",
  "event LoanOpened(uint256 indexed loanId, address indexed borrower, address indexed vault, address adapter, address pool, uint256 tokenId, uint128 principal, uint128 repayment, uint256 fee, uint40 end, address escrow)",
  "event Rolled(uint256 indexed loanId, uint256 indexed newLoanId, address indexed borrower, uint256 repaid, int256 net)",
]);
/**
 * Fables positions as the lane takes them (contracts/src/lp/fables, D316): `FablesPositionWrapper` turns one range's
 * Fables receipts into a position NFT (not enumerable) and gives them back with their fees (`unwrap`).
 */
export const fablesWrapperAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function wrap(PoolKey key, int24 tickLower, int24 tickUpper, uint128 shares, address to) returns (uint256 tokenId)",
  "function unwrap(uint256 tokenId, address to)",
  "function position(uint256 tokenId) view returns (PoolKey key, int24 tickLower, int24 tickUpper, uint128 shares, address holder, uint256 rangeId)",
  "function nextTokenId() view returns (uint256)",
  "event Wrapped(uint256 indexed tokenId, address indexed to, uint256 indexed rangeId, uint128 shares, address holder)",
]);
/**
 * A Fables hook's LP ledger (FablesRampETH, not gage's own): a holder's ERC-6909 receipts of a range, how many of them
 * are staked for Fables' emissions (`userPosition`'s first field), the allowance the wrapper needs, the pause that stops
 * transfers, and a range's pool key. Staked receipts are unstaked before they are wrapped.
 */
export const fablesHookAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct UserPosition { uint128 staked; uint128 owed0; uint128 owed1; uint256 checkpoint0X128; uint256 checkpoint1X128; uint256 stakedCheckpoint0X128; uint256 stakedCheckpoint1X128; uint256 forgone0; uint256 forgone1; }",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function allowance(address owner, address spender, uint256 id) view returns (uint256)",
  "function isOperator(address owner, address spender) view returns (bool)",
  "function approve(address spender, uint256 id, uint256 amount) returns (bool)",
  "function userPosition(uint256 id, address owner) view returns (UserPosition)",
  "function unstake(PoolKey key, int24 tickLower, int24 tickUpper, uint128 shares)",
  "function paused() view returns (bool)",
  "function rangeKey(uint256 id) view returns (PoolKey key, int24 tickLower, int24 tickUpper, bool set)",
]);
/** The LP registry: the settings a new loan meets, and a pool's admission and caps under an adapter. */
export const lpRegistryAbi = parseAbi([
  "struct PoolConfig { bool allowed; uint24 minHalfWidthTicks; uint128 minLoanPrincipal; uint128 maxLoanPrincipal; uint128 maxOutstanding; }",
  "function terms() view returns (uint32[])",
  "function feeBps() view returns (uint16)",
  "function ltvCapBps() view returns (uint16)",
  "function newLoansPaused() view returns (bool)",
  "function poolConfig(address adapter, address pool) view returns (PoolConfig)",
  // D318: whether a vault may fund new loans (the owner's word, else whether the factory made it); D319: who may open one
  // (an allowed curator, or anyone once its owner opens creation).
  "function vaultAllowed(address vault) view returns (bool)",
  "function mayOpenVault(address account) view returns (bool)",
]);
/**
 * An LP vault: its book and switches, a holder's shares and bonuses, and a depositor's calls. An ERC-4626 over USDG
 * (D319): its shares are an ERC-20 (`gLP`, the vault's own `decimals()`, src/lpShares.ts) that transfers, a holder's read with `balanceOf`; deposits and
 * redemptions name the receiver (and the owner), with a least amount out. Its curator's mandate (D318): the pools it
 * funds, each from when, and the curator's calls that add or drop one.
 */
export const lpVaultAbi = parseAbi([
  "struct PoolRef { address adapter; address pool; }",
  "function USDG() view returns (address)",
  "function CORE() view returns (address)",
  "function PERFORMANCE_FEE_BPS() view returns (uint16)",
  "function totalAssets() view returns (uint256 assets)",
  "function freeCash() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function outstandingPrincipal() view returns (uint256)",
  "function totalBonusHeld() view returns (uint256)",
  "function impaired() view returns (bool)",
  "function depositsClosed() view returns (bool)",
  "function fundingPaused() view returns (bool)",
  "function maxLoanPrincipal() view returns (uint128)",
  "function openLoans() view returns (uint256[])",
  "function balanceOf(address account) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function bonusClaimable(uint256 loanId, address account) view returns (uint256)",
  "function deposit(uint256 assets, address receiver, uint256 minShares) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner, uint256 minAssets) returns (uint256 assets)",
  "function claimBonus(uint256 loanId) returns (uint256 amount)",
  "function CURATOR() view returns (address)",
  "function mandate() view returns (PoolRef[] pools, uint40[] activeAt)",
  "function addPool(address adapter, address pool)",
  "function removePool(address adapter, address pool)",
]);
/**
 * LPVaultFactory (D318): a wallet the registry lets open one (`mayOpenVault`: an allowed curator, or anyone once creation
 * is open, D319) opens an LP vault in one call, curated by it, funding only the pools it names; the factory lists its
 * vaults and the name each was opened with.
 */
export const lpVaultFactoryAbi = parseAbi([
  "struct PoolRef { address adapter; address pool; }",
  "function create(string name, uint16 performanceFeeBps, uint128 maxLoanPrincipal, PoolRef[] pools) returns (address vault)",
  "function vaults() view returns (address[])",
  "function vaultCount() view returns (uint256)",
  "function vaultsFrom(uint256 start, uint256 count) view returns (address[] page)",
  "function nameOf(address vault) view returns (string)",
  "function isVault(address vault) view returns (bool)",
  "event VaultCreated(address indexed vault, address indexed curator, string name, uint16 performanceFeeBps, uint128 maxLoanPrincipal, PoolRef[] pools)",
]);
/** An LP position adapter (`ILPAdapter`): a position's facts, its position manager and the tokens its DEX pays as rewards. */
export const lpAdapterAbi = parseAbi([
  "struct PositionFacts { address pool; address token0; address token1; int24 tickLower; int24 tickUpper; uint128 liquidity; }",
  "function facts(uint256 tokenId) view returns (PositionFacts)",
  "function positionManager() view returns (address)",
  "function rewardTokens() view returns (address[])",
]);
/**
 * An LP position's ERC-721 manager, not gage's own (Uniswap v3's NonfungiblePositionManager, SushiSwap v3's and Ramses
 * V3's, all enumerable, and Uniswap v4's PositionManager, which is not: it answers all but `tokenOfOwnerByIndex`): the
 * positions a wallet holds, who holds one, and the approval a borrow needs.
 */
export const positionManagerAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
]);
/**
 * A v3-style pool's price (Uniswap v3, SushiSwap v3, Ramses V3): the first two fields of `slot0`, which they share (their
 * later ones differ). A Uniswap v4 pool's is read from its StateView by its id (`stateViewAbi`).
 */
export const clPoolAbi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick)"]);

// Park and unpark (D334): an out-of-range position pulled out on its own DEX and its USDG side parked in a partner vault,
// then a new position minted from it. The DEXes' contracts are not gage's: their surfaces are those deployed on
// Robinhood Chain, each read from its bytecode's selectors (24 October 2026) and the LP lane's adapters, which send the
// same calls (contracts/src/lp/adapters).
/**
 * A Uniswap v3 NonfungiblePositionManager and the forks that keep it (SushiSwap v3's): a position's 12 fields, pools by
 * fee tier, and the calls that pull its liquidity out (`decreaseLiquidity`, then `collect`) and mint one.
 */
export const v3ManagerAbi = parseAbi([
  "struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);
/**
 * Ramses V3's position manager, where it differs: 10-field positions keyed by tick spacing, a mint by tick spacing, and
 * when a position's liquidity last changed (a reward claim within about 100 seconds of one forfeits it, D321). Its
 * `decreaseLiquidity` and `collect` are Uniswap's, and a liquidity change pays the position's rewards to its owner.
 */
export const ramsesManagerAbi = parseAbi([
  "struct MintParams { address token0; address token1; int24 tickSpacing; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "function positions(uint256 tokenId) view returns (address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function positionLastModified(uint256 tokenId) view returns (uint256)",
]);
/**
 * A Uniswap v4 PositionManager (v4-periphery), hooked pools too: a position's pool key and packed range, its liquidity,
 * the one entry every position action goes through (`modifyLiquidities`), and the Permit2 its settlements pull through.
 */
export const v4ManagerAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
  "function permit2() view returns (address)",
]);
/** Uniswap's Permit2 (AllowanceTransfer): what a v4 PositionManager may pull of a token, and until when. */
export const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
/** A Fables hook's LP entries: receipts burned for their principal (`withdraw`, IFablesLedger) and minted 1:1 with liquidity (`deposit`). */
export const fablesLiquidityAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function withdraw(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity, address to, uint128 amount0Min, uint128 amount1Min, uint256 deadline)",
  "function deposit(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity, uint128 amount0Max, uint128 amount1Max, uint256 deadline) payable",
]);
/**
 * A partner vault's ERC-4626 entries (Intent's native ERC-4626 generations): a deposit naming its receiver, a withdrawal
 * of exact assets, and the most an owner can withdraw now. A vault of an earlier generation has none of them, and answers
 * `deposit(assets, minShares)` and `redeem(shares, minAssets)` alone (`partnerVaultAbi`).
 */
export const partnerVault4626Abi = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)",
  "function maxWithdraw(address owner) view returns (uint256)",
]);
