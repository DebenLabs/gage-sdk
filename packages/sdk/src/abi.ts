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
]);
export const rewardsAbi = parseAbi([
  "function claimable(uint256 id, address account) view returns (uint256)",
  "function claim(uint256 id, address recipient)",
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
export const factoryAbi = parseAbi(["function isVault(address) view returns (bool)"]);
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
