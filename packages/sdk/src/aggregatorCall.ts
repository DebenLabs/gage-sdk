/**
 * The aggregator's call, read before the SDK simulates or sends it (D245, D246), as the app reads it
 * (web/src/chain/aggregatorCall.ts; security review of 13 October 2026). The cash-out's sale
 * (`GageV2CashoutRouter.cashOutVia`) and leverage's purchase (`LoopRouter.loopVia`) each make one call, built by gage's
 * valuation service, to an executor their router admits, and the router judges it only by its own balances. The SDK
 * decodes the call first and takes it only when it does what the answer says, on the valuation service's own rule:
 * - it sells exactly the input expected: the collateral and `loan.collateral` for a sale, USDG and `spend` for a purchase;
 * - the input goes only to KyberSwap's executor (`KYBER_EXECUTOR`);
 * - it pays no fee receiver and no partner fee;
 * - it buys the output expected, for our router: the cash-out router, or the loop router;
 * - its least output is at least the answer's `minOut`.
 * Three calls are read, by their selector: KyberSwap's Router V3 `swap(SwapParams)` (0x330c333e,
 * KyberNetwork/ks-aggregation-router), its MetaAggregationRouterV2 `swap(SwapExecutionParams)` (0xe21fd0e9), and the
 * testnet's stand-in for them, `TestnetAggregator.swap(Swap)` (D245), which pulls its input itself and pays no one
 * else (it cannot be deployed on mainnet, and mainnet's routers admit only KyberSwap's). Any other call is refused, as
 * is one that does not decode.
 */
import { decodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";

/** KyberSwap's executor: where both of its routers send a sale's input, and the contract they call with the route. */
export const KYBER_EXECUTOR = "0x8F10B468b06c6FD214B65F87778827F7D113f996" as Address;

/**
 * KyberSwap's Router V3 swap, the call its API builds with `useRouterV3=true` (D246): KSAggregationRouterV3's
 * SwapParams (KyberNetwork/ks-aggregation-router, src/interfaces/IKSAggregationRouterV3.sol).
 */
export const kyberRouterV3Abi = parseAbi([
  "struct InputTokenData { bytes permitData; address[] feeRecipients; uint256[] fees; address[] targets; uint256[] amounts; }",
  "struct OutputTokenData { uint256 minAmount; address[] feeRecipients; uint256[] fees; }",
  "struct SwapParams { address[] inputTokens; uint256[] inputAmounts; InputTokenData[] inputData; address[] outputTokens; OutputTokenData[] outputData; bytes permit2Data; address executor; bytes executorData; address recipient; uint256 deadline; bytes clientData; }",
  "function swap(SwapParams params) payable returns (uint256[] outputAmounts, uint256 gasUsed)",
]);
/** KyberSwap's MetaAggregationRouterV2 swap, the call its API builds otherwise: SwapExecutionParams, SwapDescriptionV2 inside. */
export const kyberRouterV2Abi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
]);
/** The testnet stand-in's swap (D245): TestnetAggregator.Swap, its paths and their hops (contracts/src/testnet/TestnetAggregator.sol). */
export const testnetAggregatorAbi = parseAbi([
  "struct Hop { uint8 venue; address tokenOut; uint24 fee; int24 tickSpacing; }",
  "struct Path { uint256 amountIn; Hop[] hops; }",
  "struct Swap { address tokenIn; address tokenOut; uint256 amountIn; uint256 minReturn; address recipient; uint256 deadline; Path[] paths; }",
  "function swap(Swap s) returns (uint256 amountOut)",
]);

const V3_SWAP = toFunctionSelector(kyberRouterV3Abi[0]);
const V2_SWAP = toFunctionSelector(kyberRouterV2Abi[0]);
const STAND_IN = toFunctionSelector(testnetAggregatorAbi[0]);

/** What the call must do: sell exactly `amountIn` of `tokenIn` for `tokenOut`, paid to `recipient`, never under `minOut`. */
export type SwapWant = { tokenIn: Address; amountIn: bigint; tokenOut: Address; recipient: Address; minOut: bigint };

const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
const none = (...lists: readonly (readonly unknown[])[]) => lists.every((list) => list.length === 0);
/** The input's transfers: at least one, each to KyberSwap's executor, adding up to exactly the input. */
const toExecutor = (to: readonly Address[], amounts: readonly bigint[], amountIn: bigint) =>
  to.length > 0 && to.length === amounts.length && to.every((target) => same(target, KYBER_EXECUTOR)) && amounts.reduce((sum, x) => sum + x, 0n) === amountIn;

/** Whether `data` is a call that makes exactly the sale `want` describes, on the rule above. */
export function aggregatorCallOk(data: Hex, want: SwapWant): boolean {
  const selector = data.slice(0, 10).toLowerCase();
  try {
    if (selector === V3_SWAP) {
      const [p] = decodeFunctionData({ abi: kyberRouterV3Abi, data }).args;
      const input = p.inputData[0], output = p.outputData[0];
      return p.inputTokens.length === 1 && same(p.inputTokens[0]!, want.tokenIn) && p.inputAmounts.length === 1 && p.inputAmounts[0] === want.amountIn
        && p.inputData.length === 1 && input !== undefined && none(input.feeRecipients, input.fees) && toExecutor(input.targets, input.amounts, want.amountIn)
        && same(p.executor, KYBER_EXECUTOR)
        && p.outputTokens.length === 1 && same(p.outputTokens[0]!, want.tokenOut) && p.outputData.length === 1 && output !== undefined
        && none(output.feeRecipients, output.fees) && output.minAmount >= want.minOut
        && same(p.recipient, want.recipient);
    }
    if (selector === V2_SWAP) {
      const [{ callTarget, approveTarget, desc: d }] = decodeFunctionData({ abi: kyberRouterV2Abi, data }).args;
      return same(callTarget, KYBER_EXECUTOR) && (BigInt(approveTarget) === 0n || same(approveTarget, KYBER_EXECUTOR))
        && same(d.srcToken, want.tokenIn) && d.amount === want.amountIn && toExecutor(d.srcReceivers, d.srcAmounts, want.amountIn)
        && none(d.feeReceivers, d.feeAmounts)
        && same(d.dstToken, want.tokenOut) && same(d.dstReceiver, want.recipient) && d.minReturnAmount >= want.minOut;
    }
    if (selector === STAND_IN) {
      const [s] = decodeFunctionData({ abi: testnetAggregatorAbi, data }).args;
      return same(s.tokenIn, want.tokenIn) && s.amountIn === want.amountIn && same(s.tokenOut, want.tokenOut) && same(s.recipient, want.recipient)
        && s.minReturn >= want.minOut;
    }
  } catch {
    // A call cut short, or one that does not decode as its selector says.
  }
  return false;
}
