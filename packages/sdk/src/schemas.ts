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
/** Leverage lends USDG only (D251): any other asset is refused by the planner, in fixed words. */
const leverageAsset = address.optional().describe("USDG only: leverage lends USDG (a loop in a lend asset is refused)");

export const emptyInput = z.object({}).strict();
export const walletInput = z.object({ wallet: address.describe("The wallet that will sign") }).strict();
export const loanInput = z.object({ loanId, engine: address.optional().describe("The engine; the current core when omitted") }).strict();
export const borrowQuoteInput = z.object({
  token: address, term, wallet: address.optional(), lendAsset,
  maxCollateral: raw.optional().describe("Most of the token to pledge, raw units: quotes the largest loan the vaults fund for it"),
  collateral: raw.optional().describe("With principal: the exact pledge of one chosen loan, raw units"),
  principal: raw.optional().describe("With collateral: the exact amount to borrow, raw units of the loan's asset; priced as the borrow card prices it"),
}).strict();
export const leverageQuoteInput = z.object({ token: address, own: raw.describe("The tokens you put in, raw units"), multiple, term, wallet: address.optional(), lendAsset: leverageAsset }).strict();

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
/** A rating of gage (D302): a score and nothing else, so no word of the agent's goes on chain or on the review page (D222). */
const feedback = z.object({
  wallet: address, score: z.number().int().min(0).max(100).describe("Your own rating of gage, a whole number from 0 (worst) to 100 (best)"),
}).strict();

export const actionShapes = {
  borrow, leverage, cancel: loanAction, reclaim: loanAction, cash_out: cashOut, roll, auto_roll: autoRoll, cancel_auto_roll: loanAction,
  earn_deposit: deposit, earn_redeem: redeem, collect: walletInput, feedback,
} as const;
/** The same actions for a signer (D224): the signer's own wallet acts, so no input names one. */
export const signedShapes = {
  borrow: borrow.omit({ wallet: true }), leverage: leverage.omit({ wallet: true }), cancel: loanAction.omit({ wallet: true }), reclaim: loanAction.omit({ wallet: true }),
  cash_out: cashOut.omit({ wallet: true }), roll: roll.omit({ wallet: true }), auto_roll: autoRoll.omit({ wallet: true }), cancel_auto_roll: loanAction.omit({ wallet: true }),
  earn_deposit: deposit.omit({ wallet: true }), earn_redeem: redeem.omit({ wallet: true }), collect: emptyInput, feedback: feedback.omit({ wallet: true }),
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
