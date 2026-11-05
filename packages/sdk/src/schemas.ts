import { z } from "zod";
import { ApiError } from "./errors.js";

/** Inputs of every route and tool, one definition for the SDK, HTTP, MCP and the review store. Raw amounts are decimal strings. */
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an 0x address");
export const raw = z.string().regex(/^[1-9]\d{0,77}$/, "a positive raw integer as a decimal string");
export const loanId = z.string().regex(/^\d{1,78}$/, "a loan id as a decimal string");
export const term = z.number().int().positive().describe("Loan term in seconds, one of the terms gage_capabilities lists");
export const multiple = z.number().min(1.1).max(3).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, "at most two decimals")
  .describe("Leverage, 1.1 to 3 with at most two decimals (2 = twice the pledge held for the loan)");
const slippage = z.number().int().min(0).max(500).optional().describe("Most the conversion may move against you, in bps; 50 when omitted");
/** The asset a loan is paid out and repaid in (D251): USDG when omitted, else a lend asset gage_capabilities lists. */
const lendAsset = address.optional().describe("The asset the loan is paid in and repaid in: USDG when omitted, or a lend asset gage_capabilities lists (its token address)");
/** Leverage lends USDG only (D251; a lend asset's loop router opens puts alone, D313): any other asset is refused by the planner, in fixed words. */
const leverageAsset = address.optional().describe("USDG only: leverage lends USDG (a loop in a lend asset is refused; a lend asset's puts open with put_open)");
/** A put's size: its pledge over its margin, as a loop's multiple is its holding over its pledge. */
const size = z.number().min(1.1).max(10).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, "at most two decimals")
  .describe("The put's size, 1.1 to 10 with at most two decimals: its whole USDG pledge over the margin you put in (4 = the margin and three times it bought with the loan)");

export const emptyInput = z.object({}).strict();
export const walletInput = z.object({ wallet: address.describe("The wallet that will sign") }).strict();
export const loanInput = z.object({ loanId, engine: address.optional().describe("The engine; the current core when omitted") }).strict();
export const vaultInput = z.object({ vault: address.describe("A partner vault, as gage_earn_vaults lists it") }).strict();
export const borrowQuoteInput = z.object({
  token: address, term, wallet: address.optional(), lendAsset,
  maxCollateral: raw.optional().describe("Most of the token to pledge, raw units: quotes the largest loan the vaults fund for it, at the lowest fixed cost they accept"),
  collateral: raw.optional().describe("With principal: the exact pledge of one chosen loan, raw units"),
  principal: raw.optional().describe("With collateral: the exact amount to borrow, raw units of the loan's asset; priced at the lowest fixed cost the vaults funding it accept, or at costBps"),
  costBps: z.number().min(0.1).max(5_000).optional()
    .describe("With collateral and principal: your own fixed cost for the loan instead, bps of the amount borrowed, to a tenth (more digits are rounded); the quote's grades say what each Loan grade costs"),
}).strict();
export const leverageQuoteInput = z.object({ token: address, own: raw.describe("The tokens you put in, raw units"), multiple, term, wallet: address.optional(), lendAsset: leverageAsset }).strict();
/** The asset a put borrows against USDG (docs/api.md "Puts on lend-asset generations"). */
const putAsset = address.describe("The asset the put borrows against USDG: a lend asset gage_capabilities lists with a putRouter (its token address)");
const margin = raw.describe("The USDG you put in, raw units (6 decimals): the most the put can lose");
export const putQuoteInput = z.object({ lendAsset: putAsset, margin, size, term, wallet: address.optional() }).strict();

const borrow = z.object({
  wallet: address, token: address, collateral: raw.describe("Tokens to pledge, raw units"),
  principal: raw.describe("To borrow, raw units of the loan's asset (USDG: 6 decimals)"), cap: raw.describe("To repay, raw units of the loan's asset, above principal"), term, lendAsset,
}).strict();
const leverage = z.object({
  wallet: address, token: address, own: raw.describe("The tokens you put in, raw units"), multiple, term,
  maxCostBps: z.number().int().min(1).max(5_000).describe("Highest loan cost you accept, bps of the amount borrowed; the loop is refused above it"),
  lendAsset: leverageAsset,
}).strict();
const loanAction = z.object({ wallet: address, loanId, engine: address.optional().describe("The engine; the current core when omitted, the loan's own core for a loan in a lend asset") }).strict();
/** A roll keeps the loan's size and pledge (D285): only its new term may be named, the loan's own when omitted. */
const roll = loanAction.extend({ term: term.optional().describe("The new loan's term in seconds, one gage_capabilities lists; the loan's own term when omitted") }).strict();
/** A cash-out sells the whole pledge (D245): only how far the net may fall below the quote, and the least it may be, may be named. */
const cashOut = loanAction.extend({
  maxSlippageBps: z.number().int().min(1).max(100).optional().describe("Most the net you receive may fall below the quote, in bps of it; 50 when omitted"),
  minNet: raw.optional().describe("The least you accept to receive, raw units of the loan's asset (USDG: 6 decimals): the cash-out is refused under it, and its transaction reverts under it"),
}).strict();
const autoRoll = loanAction.extend({
  maxCost: raw.optional().describe("The most each new loan may cost, its fixed cost and origination fee together, raw units of the loan's asset, at most the loan's principal; when omitted, twice what a roll of the loan costs now, held to four times the loan's own cost and fee (a listing not funded yet: twice its own cost and fee)"),
}).strict();
const deposit = z.object({ wallet: address, vault: address, amount: raw.describe("To deposit, raw units of the vault's asset (USDG: 6 decimals)"), maxSlippageBps: slippage }).strict();
const redeem = z.object({
  wallet: address, vault: address,
  shares: raw.optional().describe("Shares to redeem, raw (18 decimals); all when omitted, less what a vault of an asset with more than 6 decimals cannot pay after a loss (a millionth of the asset at most)"),
  maxSlippageBps: slippage,
}).strict();
/** A put opened through its generation's loop router: its asset, margin, size and term, and the loan cost accepted. */
const putOpen = z.object({
  wallet: address, lendAsset: putAsset, margin, size, term,
  maxCostBps: z.number().int().min(1).max(5_000).describe("Highest loan cost you accept, bps of the amount borrowed; the put is refused above it"),
}).strict();
/** A put's loan, always on its lend asset's own core. */
const putLoan = z.object({ wallet: address, loanId, engine: address.describe("The loan's core: its lend asset's (gage_capabilities lendAssets)") }).strict();
const putSlippage = z.number().int().min(1).max(500).optional().describe("Most the purchase may cost over its quote when it is sent, in bps; 50 when omitted");
/** A close buys the repayment back with the pledge: only how far its cost may move, and the least to come back, may be named. */
const putClose = putLoan.extend({
  maxSlippageBps: putSlippage,
  minBack: raw.optional().describe("The least of the pledge you accept back, raw units (USDG: 6 decimals): the close is refused under it, and its transaction reverts under it"),
}).strict();
/** A roll keeps the loan's size and pledge (D285): only its new term, and how far the top-up's cost may move, may be named. */
const putRoll = putLoan.extend({
  term: term.optional().describe("The new loan's term in seconds, one gage_capabilities lists; the loan's own term when omitted"),
  maxSlippageBps: putSlippage,
}).strict();
const putAutoRoll = putLoan.extend({
  maxCost: raw.optional().describe("The most each new loan may cost, its fixed cost and origination fee together, raw units of the loan's asset, at most the loan's principal; when omitted, as auto_roll starts it"),
  maxSpend: raw.optional().describe("The most of the pledge's token (USDG: 6 decimals) each roll may spend buying what the new loan leaves short, at most the loan's pledge; when omitted, twice what buying the largest top-up costs now"),
}).strict();
/** A rating of gage (D302): a score and nothing else, so no word of the agent's goes on chain or on the review page (D222). */
const feedback = z.object({
  wallet: address, score: z.number().int().min(0).max(100).describe("Your own rating of gage, a whole number from 0 (worst) to 100 (best)"),
}).strict();

// The LP lane (docs/api.md "LP lane", D314, D315, D316, D317): USDG loans against Uniswap v3 and v4, SushiSwap v3, Ramses
// V3 and Fables positions, their rolls, Fables receipts wrapped into positions, and its vaults.
const lpAdapter = address.describe("The position's adapter: one gage_capabilities lists under lpLane.adapters (Uniswap v3, SushiSwap v3, Ramses V3, Uniswap v4 or Fables; gage_lp_positions names each position's)");
const tokenId = z.string().regex(/^\d{1,78}$/, "a position id as a decimal string").describe("The position's id: its NFT's token id at the adapter's position manager (gage_lp_positions)");
const rangeId = z.string().regex(/^\d{1,78}$/, "a range id as a decimal string").describe("A Fables range's id: the receipts gage_lp_positions lists under fablesReceipts");
const lpTerm = z.number().int().positive().describe("Loan term in seconds, one of gage_capabilities lpLane.terms");
const lpVault = address.describe("An LP vault: one gage_lp_vaults lists (the manifest's, or one a curator opened through the lane's factory)");
const lpLoanId = loanId.describe("The LP loan's id on the lane's core (gage_lp_loans)");
const maxCostBps = z.number().int().min(1).max(5_000).describe("Highest loan cost you accept, bps of the amount borrowed; refused above it");
export const lpQuoteInput = z.object({
  adapter: lpAdapter, tokenId, wallet: address.describe("The wallet that holds the position and will borrow: the quote is signed for it"), term: lpTerm,
  vault: lpVault.optional().describe("The LP vault to borrow from; the lane's first one that can fund the loan whole when omitted"),
}).strict();
const lpBorrow = z.object({
  wallet: address, adapter: lpAdapter,
  tokenId: tokenId.optional().describe("The position's id (gage_lp_positions); or rangeId for Fables receipts not wrapped yet"),
  rangeId: rangeId.optional().describe("Fables receipts not wrapped yet (gage_lp_positions fablesReceipts), with the Fables adapter: they are wrapped into a position first, unstaking any staked, then borrowed against; name tokenId or rangeId, not both"),
  term: lpTerm, maxCostBps,
  vault: lpVault.optional().describe("The LP vault to borrow from; the lane's first one that can fund the loan whole when omitted"),
}).strict();
const lpLoan = z.object({ wallet: address, loanId: lpLoanId }).strict();
const lpRoll = z.object({
  wallet: address, loanId: lpLoanId, term: lpTerm, maxCostBps,
  vault: lpVault.optional().describe("The LP vault the new loan comes from; the loan's own vault first when omitted"),
}).strict();
const lpWrap = z.object({ wallet: address, adapter: lpAdapter.describe("The lane's Fables adapter (gage_capabilities lpLane.adapters, kind fables)"), rangeId }).strict();
const lpUnwrap = z.object({ wallet: address, adapter: lpAdapter.describe("The lane's Fables adapter (gage_capabilities lpLane.adapters, kind fables)"), tokenId }).strict();
const lpWithdraw = z.object({ wallet: address, token: address.optional().describe("The token to withdraw; every token the LP lane credits the wallet when omitted") }).strict();
const lpDeposit = z.object({ wallet: address, vault: lpVault, amount: raw.describe("USDG to deposit, raw units (6 decimals)"), maxSlippageBps: slippage }).strict();
const lpRedeem = z.object({
  wallet: address, vault: lpVault,
  shares: raw.optional().describe("Shares to redeem, raw, in the vault's own decimals (its shareDecimals in gage_lp_vaults and the portfolio, 18 or 12: 10^shareDecimals shares were worth 1 USDG when the vault opened); every share the vault's free cash pays when omitted"),
  maxSlippageBps: slippage,
}).strict();
const lpClaimBonus = z.object({
  wallet: address, vault: lpVault,
  loanId: lpLoanId.optional().describe("The defaulted LP loan whose bonus to claim; every loan of the vault with a bonus for this wallet when omitted"),
}).strict();
// A curator's LP vault (D318): opened through the lane's factory, funding only the pools of its mandate.
const lpPoolRef = z.object({
  adapter: address.describe("The pool's adapter (gage_capabilities lpLane.pools)"), pool: address.describe("The pool, as gage_capabilities lpLane.pools names it under that adapter"),
}).strict();
const lpCreateVault = z.object({
  wallet: address,
  name: z.string().min(1).max(64).describe("The vault's name, as depositors see it (at most 64 bytes)"),
  performanceFeeBps: z.number().int().min(500).max(1_500).describe("Your share of each loan's fixed cost, in bps: 500 to 1,500 (5% to 15%); fixed for good"),
  maxLoanPrincipal: raw.describe("The largest loan the vault funds, raw USDG (6 decimals), at most 10,000,000 USDG; you may change it later"),
  pools: z.array(lpPoolRef).min(1).max(32).describe("The pools the vault funds loans in (its mandate), each once: from gage_capabilities lpLane.pools"),
}).strict();
const lpVaultPool = z.object({ wallet: address, vault: lpVault.describe("An LP vault this wallet curates (gage_lp_vaults curator)"), adapter: lpPoolRef.shape.adapter, pool: lpPoolRef.shape.pool }).strict();

// Park and unpark (D334): an out-of-range LP position pulled out on its own DEX into a partner vault, and a new one minted
// from a vault's withdrawal, both from the wallet with no gage contract between.
const parkManager = address.describe("Where the position is held: its position manager (a Uniswap v3, SushiSwap v3 or Ramses V3 NonfungiblePositionManager, or a Uniswap v4 PositionManager), or a Fables hook for its receipts (gage_park_positions manager)");
export const parkId = z.string().regex(/^\d{1,78}$/, "a position id as a decimal string").describe("The position's id at its manager (gage_park_positions id): its NFT's token id, or a Fables range's id");
const parkShape = z.object({
  wallet: address, manager: parkManager, id: parkId,
  vault: address.describe("The partner vault to park in: one that takes the token the position holds now (gage_park_positions vaults; a DEX names its own)"),
  maxSlippageBps: slippage,
}).strict();
const tick = z.number().int().min(-887_272).max(887_272);
const unparkShape = z.object({
  wallet: address,
  vault: address.describe("The partner vault to withdraw from: one whose asset the pool pairs"),
  manager: address.describe("Where the new position is minted: the pool's manager (gage_capabilities parkPools manager)"),
  pool: z.string().regex(/^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, "a pool's address or a v4 pool's id").describe("The pool: a v3-style pool's address, or a v4 pool's id (gage_capabilities parkPools pool)"),
  tickLower: tick.describe("The new range's lower tick, a multiple of the pool's tick spacing"),
  tickUpper: tick.describe("The new range's upper tick, a multiple of the pool's tick spacing, above tickLower"),
  amount: raw.optional().describe("How much to withdraw, raw units of the vault's asset; everything the vault can pay the wallet now when omitted"),
  maxSlippageBps: slippage,
}).strict();

// Exit now from a rehypo pool (root D357): a pool LP asks the source of the side it cannot take to commit its vault
// shares at the chain's exit desk (Intent D57).
const rehypoExit = z.object({
  wallet: address.describe("The wallet that holds the pool's LP shares"),
  source: address.describe("The rehypo source of the pool's token your share is short of: the hook's source for that token, which lends it through a partner vault"),
}).strict();

// Exit now from a partner vault (Intent D57): a holder whose balance is more than the vault can pay now commits its
// shares at the chain's exit desk, which lists one of the vault's loans for it; then the exit's next listing, its cancel,
// and what its sales paid, collected from the desk.
const earnExit = z.object({
  wallet: address.describe("The wallet that holds the vault's shares"),
  vault: address.describe("A partner vault, as gage_earn_vaults lists it"),
  amount: raw.optional().describe("What to exit, raw units of the vault's asset (USDG: 6 decimals) at today's share value; the whole balance when omitted"),
}).strict();
const earnExitOf = z.object({ wallet: address.describe("The wallet whose exit it is"), vault: address.describe("The partner vault its exit leaves") }).strict();
const earnExitCollect = z.object({
  wallet: address,
  asset: address.optional().describe("The asset to collect: USDG, or a lend asset gage_capabilities lists; every asset the exit desk owes the wallet when omitted"),
}).strict();

/** A wallet's out-of-range positions (D334), and positions to read beside those found: a v4 PositionManager and a Fables hook cannot list a holder's. */
export const parkPositionsInput = z.object({
  wallet: address.describe("The wallet that holds the positions"),
  also: z.array(z.object({ manager: address, id: parkId }).strict()).max(100).optional()
    .describe("Positions to read beside those found, by their manager and id: a Uniswap v4 PositionManager and a Fables hook cannot list a wallet's"),
}).strict();

export const actionShapes = {
  borrow, leverage, cancel: loanAction, reclaim: loanAction, cash_out: cashOut, roll, auto_roll: autoRoll, cancel_auto_roll: loanAction,
  earn_deposit: deposit, earn_redeem: redeem, collect: walletInput, feedback,
  put_open: putOpen, put_close: putClose, put_roll: putRoll, put_auto_roll: putAutoRoll, put_cancel_auto_roll: putLoan,
  lp_borrow: lpBorrow, lp_repay: lpLoan, lp_return_position: lpLoan, lp_collect: lpLoan, lp_withdraw: lpWithdraw, lp_deposit: lpDeposit, lp_redeem: lpRedeem,
  lp_claim_bonus: lpClaimBonus, lp_roll: lpRoll, lp_wrap: lpWrap, lp_unwrap: lpUnwrap,
  lp_create_vault: lpCreateVault, lp_vault_add_pool: lpVaultPool, lp_vault_remove_pool: lpVaultPool,
  park: parkShape, unpark: unparkShape, rehypo_exit_now: rehypoExit,
  earn_exit_now: earnExit, earn_exit_list: earnExitOf, earn_exit_cancel: earnExitOf, earn_exit_collect: earnExitCollect,
} as const;
/** The same actions for a signer (D224): the signer's own wallet acts, so no input names one. */
export const signedShapes = {
  borrow: borrow.omit({ wallet: true }), leverage: leverage.omit({ wallet: true }), cancel: loanAction.omit({ wallet: true }), reclaim: loanAction.omit({ wallet: true }),
  cash_out: cashOut.omit({ wallet: true }), roll: roll.omit({ wallet: true }), auto_roll: autoRoll.omit({ wallet: true }), cancel_auto_roll: loanAction.omit({ wallet: true }),
  earn_deposit: deposit.omit({ wallet: true }), earn_redeem: redeem.omit({ wallet: true }), collect: emptyInput, feedback: feedback.omit({ wallet: true }),
  put_open: putOpen.omit({ wallet: true }), put_close: putClose.omit({ wallet: true }), put_roll: putRoll.omit({ wallet: true }),
  put_auto_roll: putAutoRoll.omit({ wallet: true }), put_cancel_auto_roll: putLoan.omit({ wallet: true }),
  lp_borrow: lpBorrow.omit({ wallet: true }), lp_repay: lpLoan.omit({ wallet: true }), lp_return_position: lpLoan.omit({ wallet: true }),
  lp_collect: lpLoan.omit({ wallet: true }), lp_withdraw: lpWithdraw.omit({ wallet: true }), lp_deposit: lpDeposit.omit({ wallet: true }),
  lp_redeem: lpRedeem.omit({ wallet: true }), lp_claim_bonus: lpClaimBonus.omit({ wallet: true }), lp_roll: lpRoll.omit({ wallet: true }),
  lp_wrap: lpWrap.omit({ wallet: true }), lp_unwrap: lpUnwrap.omit({ wallet: true }),
  lp_create_vault: lpCreateVault.omit({ wallet: true }), lp_vault_add_pool: lpVaultPool.omit({ wallet: true }), lp_vault_remove_pool: lpVaultPool.omit({ wallet: true }),
  park: parkShape.omit({ wallet: true }), unpark: unparkShape.omit({ wallet: true }), rehypo_exit_now: rehypoExit.omit({ wallet: true }),
  earn_exit_now: earnExit.omit({ wallet: true }), earn_exit_list: earnExitOf.omit({ wallet: true }), earn_exit_cancel: earnExitOf.omit({ wallet: true }),
  earn_exit_collect: earnExitCollect.omit({ wallet: true }),
} as const;
export type ActionName = keyof typeof actionShapes;
export const ACTIONS = Object.keys(actionShapes) as ActionName[];

export const actionInput = z.discriminatedUnion("action", [
  borrow.extend({ action: z.literal("borrow") }),
  leverage.extend({ action: z.literal("leverage") }),
  loanAction.extend({ action: z.literal("cancel") }),
  loanAction.extend({ action: z.literal("reclaim") }),
  cashOut.extend({ action: z.literal("cash_out") }),
  roll.extend({ action: z.literal("roll") }),
  autoRoll.extend({ action: z.literal("auto_roll") }),
  loanAction.extend({ action: z.literal("cancel_auto_roll") }),
  deposit.extend({ action: z.literal("earn_deposit") }),
  redeem.extend({ action: z.literal("earn_redeem") }),
  walletInput.extend({ action: z.literal("collect") }),
  feedback.extend({ action: z.literal("feedback") }),
  putOpen.extend({ action: z.literal("put_open") }),
  putClose.extend({ action: z.literal("put_close") }),
  putRoll.extend({ action: z.literal("put_roll") }),
  putAutoRoll.extend({ action: z.literal("put_auto_roll") }),
  putLoan.extend({ action: z.literal("put_cancel_auto_roll") }),
  lpBorrow.extend({ action: z.literal("lp_borrow") }),
  lpLoan.extend({ action: z.literal("lp_repay") }),
  lpLoan.extend({ action: z.literal("lp_return_position") }),
  lpLoan.extend({ action: z.literal("lp_collect") }),
  lpWithdraw.extend({ action: z.literal("lp_withdraw") }),
  lpDeposit.extend({ action: z.literal("lp_deposit") }),
  lpRedeem.extend({ action: z.literal("lp_redeem") }),
  lpClaimBonus.extend({ action: z.literal("lp_claim_bonus") }),
  lpRoll.extend({ action: z.literal("lp_roll") }),
  lpWrap.extend({ action: z.literal("lp_wrap") }),
  lpUnwrap.extend({ action: z.literal("lp_unwrap") }),
  lpCreateVault.extend({ action: z.literal("lp_create_vault") }),
  lpVaultPool.extend({ action: z.literal("lp_vault_add_pool") }),
  lpVaultPool.extend({ action: z.literal("lp_vault_remove_pool") }),
  parkShape.extend({ action: z.literal("park") }),
  unparkShape.extend({ action: z.literal("unpark") }),
  rehypoExit.extend({ action: z.literal("rehypo_exit_now") }),
  earnExit.extend({ action: z.literal("earn_exit_now") }),
  earnExitOf.extend({ action: z.literal("earn_exit_list") }),
  earnExitOf.extend({ action: z.literal("earn_exit_cancel") }),
  earnExitCollect.extend({ action: z.literal("earn_exit_collect") }),
]);
export type ActionInput = z.output<typeof actionInput>;
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An action for a signer to carry out: the signer's wallet acts, so it names none. */
export type ActionRequest = Without<ActionInput, "wallet">;

/** Input checked against its schema; a mismatch is one refusal naming each field (INVALID_INPUT). */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("INVALID_INPUT", `Input does not match the schema: ${result.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}`, 400);
  return result.data;
}

export const reviewToken = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict();
export const reviewAdvance = reviewToken.extend({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();
