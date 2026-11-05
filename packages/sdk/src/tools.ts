/**
 * Every gage tool in one catalogue (D222, D224). The hosted MCP, the local MCP that signs with an agent's own key, and
 * any agent framework use the same names, inputs and words. Each tool is a name, a title, a description, a zod input,
 * hints, and a function that answers in plain JSON.
 */
import type { z } from "zod";
import type { Gage } from "./client.js";
import { short } from "./format.js";
import { LP_FORMATS } from "./lp.js";
import { createPoolVaultsInput, poolVaultsInput } from "./pools.js";
import { MAINNET_DEFAULTS } from "./networks.js";
import {
  actionShapes, borrowQuoteInput, emptyInput, leverageQuoteInput, loanInput, lpQuoteInput, parkPositionsInput, parseInput, putQuoteInput, signedShapes, vaultInput, walletInput, type ActionInput,
  type ActionName,
} from "./schemas.js";
import type { SpendLimit } from "./run.js";
import type { Signer } from "./signer.js";

export interface GageTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  /** MCP's tool hints: reads change nothing; the signer's tools move the wallet's funds. */
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** Checks the input against `inputSchema`, then answers; amounts are decimal strings, never bigints. */
  execute(input: unknown): Promise<Record<string, unknown>>;
}

export interface ToolOptions {
  /**
   * Adds the signer's tools: `gage_wallet` and one per action (`gage_borrow`, …), each acting for the signer's wallet only,
   * on every network. Whether they act under spend limits is the wallet owner's choice (`limit`, D297, D311).
   */
  signer?: Signer;
  /** The spend limit every action of the signer's is carried out under (D297): asked with its plan, before anything is sent. */
  limit?: SpendLimit;
  /** Answers the prepare tools instead of `gage.prepare` (the hosted service adds its review link). */
  prepare?: (input: ActionInput) => Promise<unknown>;
  /** The sentence that ends each prepare tool's description. */
  prepareNote?: string;
}

/** JSON without bigints: every raw amount as its decimal string. */
export const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v)) as Record<string, unknown>;

const TITLES: Record<ActionName, string> = {
  borrow: "Borrow", leverage: "Open a loop", cancel: "Cancel a listing", reclaim: "Repay a loan", cash_out: "Cash a loan out", roll: "Roll a loan over", auto_roll: "Roll a loan over by itself",
  cancel_auto_roll: "Stop rolling a loan over", earn_deposit: "Deposit into Earn", earn_redeem: "Withdraw from Earn", collect: "Collect what is ready",
  feedback: "Rate gage", put_open: "Open a put", put_close: "Close a put", put_roll: "Roll a put over", put_auto_roll: "Roll a put over by itself",
  put_cancel_auto_roll: "Stop rolling a put over",
  lp_borrow: "Borrow against an LP position", lp_repay: "Repay an LP loan", lp_return_position: "Take an LP position back", lp_collect: "Collect an LP position's fees",
  lp_withdraw: "Withdraw LP credits", lp_deposit: "Deposit into an LP vault", lp_redeem: "Withdraw from an LP vault", lp_claim_bonus: "Claim an LP vault's bonus",
  lp_roll: "Roll an LP loan over", lp_wrap: "Wrap Fables receipts into a position", lp_unwrap: "Unwrap a Fables position",
  lp_create_vault: "Open an LP vault", lp_vault_add_pool: "Add a pool to an LP vault", lp_vault_remove_pool: "Drop a pool from an LP vault",
  park: "Park an out-of-range position", unpark: "Unpark into a new position", rehypo_exit_now: "Exit a rehypo pool now",
  earn_exit_now: "Exit a partner vault now", earn_exit_list: "List an exit's next loan", earn_exit_cancel: "Cancel an exit", earn_exit_collect: "Collect what an exit paid",
};
/** What a partner vault's exit now is (Intent D57), in each of its tools' words. */
const EARN_EXIT = "for a holder whose balance is more than the vault can pay now: the wallet's vault shares (amount, raw in the vault's asset at today's share value; the whole balance when omitted) are committed at the chain's exit desk, approved to it for exactly those shares, and the desk lists one of the vault's loans: first the one whose price can fall furthest for this exit, then the smallest that covers what the vault cannot pay of them. Over ten minutes its price falls from book value plus 99% of what the loan has still to earn: only the part the vault cannot pay can reach book value, and the price falls no further than the wallet's own share of that loan can pay, since the wallet pays the buyer's discount, so the listing may not sell. The sale pays the wallet at today's share value in its own transaction, to collect with earn_exit_collect; the request lasts 24 hours. Refused while the vault can pay the amount now (withdraw it with earn_redeem), beside an exit already open, or while exits are closed. Like a withdrawal, it avoids losses on loans that default after the wallet leaves; the holders who stay bear them";
/** What an exit's next listing, its cancel and its collect are (Intent D57), in each of their tools' words. */
const EXIT_LIST = "the wallet's open exit from a partner vault, once its last listing ended unsold and the vault still cannot pay the rest: the next of the vault's loans, chosen as earn_exit_now chooses it; gage's keeper may also list it";
const EXIT_CANCEL = "the wallet's exit from a partner vault, before a sale: its shares stay the wallet's, and nothing more is listed or sold for it; it goes to the desk the vault's factory bound, so it works while exits are closed";
const EXIT_COLLECT = "what exit now sales paid the wallet, from the exit desk: asset (USDG or a lend asset), or every asset it owes when omitted";
/** What a rehypo pool's exit now is (root D357), in each of its tools' words. */
const REHYPO_EXIT = "for a pool LP whose share of one of the pool's tokens is more than that token's rehypo source can pay now (source: the hook's source for that token, which lends it through a partner vault). The source commits the vault shares its cash leaves short of the wallet's share at the chain's exit desk, which lists one of the vault's loans, first the one whose price can fall furthest for this exit. Over ten minutes its price falls from book value plus 99% of what the loan has still to earn, no further than the source's share of that loan can pay: the buyer's discount comes out of the source's share, so the pool's LPs who stay pay it, not the wallet, and the listing may not sell. Once a buyer takes it, remove the liquidity on the pool's hook as usual: the source pays from what the sale paid, held for its LPs for an hour. Refused while the source can pay the share now, or while exits are closed. Like a withdrawal, it avoids losses on loans that default after the wallet leaves; the LPs and holders who stay bear them"
/** What park is (D334), in each of its tools' words. */
const PARK = "an out-of-range liquidity position's whole liquidity is pulled out on its own DEX (manager and id from gage_park_positions), and the one token it holds is deposited into the partner vault named, which must take it (USDG, or a lend asset; ETH is not parked yet); its fees come to the wallet. Refused while the position is in range";
/** What unpark is (D334), in each of its tools' words. */
const UNPARK = "the partner vault named pays the wallet (amount, or all it can pay now: its free cash), and a new position is opened in [tickLower, tickUpper] of a pool gage_capabilities parkPools lists that pairs the vault's asset; a range around the price takes the pool's other token too, from the wallet";
/** How a park's or an unpark's transactions go: together. */
const TOGETHER = "Its transactions are built from one reading of the chain: send them in order (calls) or as one batch, without preparing again between them.";
/** What an LP loan is (docs/api.md "LP lane"), in each of its tools' words, with no liquidation's definition. */
const LP = `a fixed-cost USDG loan against an ETH/USDG or stock/USDG liquidity position on ${LP_FORMATS}, with no liquidation: it is never closed early because a price moves, and if it is not repaid by its end the position is unwound for its lenders and nothing else is taken`;
/** What moving a Uniswap v4 position into a loan's escrow does besides, said where a borrow is prepared or sent. */
const V4_MOVE = "A Uniswap v4 position leaves any subscription it has (a rewards program that tracks it) as it moves.";
/** Fables receipts not wrapped yet, borrowed against through lp_borrow's rangeId (D316). */
const FABLES_BORROW = "Fables receipts not wrapped yet (rangeId, gage_lp_positions fablesReceipts) are wrapped into a position first, any staked ones unstaked, and the borrow follows once the wrap is mined.";
/** What an LP roll is (D317), in each of its tools' words. */
const LP_ROLL = "a new loan on the same position repays the running LP loan in full before its end: the position stays in its escrow, and only the difference moves, the new loan's USDG less its fee over the old repayment credited to the wallet, or what it lacks paid by the wallet. Refused above maxCostBps";
/** What wrapping Fables receipts is (D316). */
const LP_WRAP = "every Fables receipt the wallet holds of one range (rangeId, gage_lp_positions fablesReceipts) becomes one position NFT the LP lane lends against: staked receipts are unstaked first (they stop earning Fables' emissions), and the wrapped ones earn the pool's swap fees";
/** What a curator's LP vault is (D318), in each of its tools' words. */
const CURATED = "A wallet the LP registry lets open one (a curator it allows, or anyone once it opens vault creation) opens a vault through the lane's factory and curates it: it funds loans only in the pools of its mandate, a pool added funding three hours later and one dropped stopping at once (open loans run on); the curator never touches its lenders' money";
/** What an LP vault's bonus is. */
const BONUS = "what a defaulted LP loan's sale brought above its book value, shared by the lenders by their share of the vault and the time they held it while the loan ran";
/** What a put is, in each of its tools' words (docs/api.md "Puts on lend-asset generations"). */
const PUT = "a loan of a lend asset against USDG, opened with put_open: it gains as the asset falls, and its loss stops at the USDG put in";
/** What a rating is (D302), in each of its tools' words: gage's entry exists on mainnet only, where the tools are served. */
const RATING = `gage (agent #${MAINNET_DEFAULTS.beacon.agentId} in ERC-8004) in its Reputation Registry: your own score from 0 to 100, once a wallet, public on chain. Optional: gage offers nothing for a rating.`;
/** What `collect` gathers, and what stays gage.cash's: the earlier surfaces this SDK does not collect from. */
const COLLECTS = "what is ready here: USDG and lend assets from loans, collateral back, vault earnings, the collateral and backing of loans the vaults wrote off (never counted as earnings), the sGAGE of loans and partner vaults, and what exit now sales paid; a claim that would revert now is left out, and said. The first vault's credits and claims, earlier engines' lender recoveries, retired Earn strategies and the GAGE/sGAGE pool's rewards and Drip are collected on gage.cash.";
const PREPARE: Record<ActionName, string> = {
  borrow: "Prepare a loan: pledge a token, receive USDG (or the lend asset named by lendAsset), repay a fixed amount of it within the term. Use the prepare object of gage_borrow_quote, without its action.",
  leverage: "Prepare a leveraged loop: the loan buys more of the pledged token in one transaction. USDG only. Refused above maxCostBps.",
  cancel: "Prepare cancelling a loan still waiting for funding and taking its collateral back.",
  reclaim: "Prepare repaying a running loan in full, in the asset it is paid in, and taking the collateral back, before its term ends.",
  cash_out: "Prepare cashing a running loan out: its whole collateral is sold through an aggregator, the loan repaid from the sale, and the rest less gage's 0.5% fee paid to the wallet, in one transaction.",
  roll: "Prepare rolling a running loan over: a new loan of the same size on the same pledge repays it in full, and the wallet adds the difference (the old loan's cost and the new fee) or keeps what is over.",
  auto_roll: "Prepare leaving a loan to roll over by itself: gage's keeper rolls it in its last hours into a loan of the same size and term, at most maxCost each, up to four times. Leaves standing approvals to gage's rollover router.",
  cancel_auto_roll: "Prepare ending a loan's instruction to roll over by itself.",
  earn_deposit: "Prepare a deposit into a partner vault (lending), in the asset the vault takes: USDG, or its lend asset.",
  earn_redeem: "Prepare withdrawing from a partner vault, everything it can pay when shares is omitted.",
  collect: `Prepare collecting ${COLLECTS}`,
  feedback: `Prepare rating ${RATING}`,
  put_open: "Prepare a put: borrow a lend asset (lendAsset) against USDG, whose loan buys more USDG and pledges it with your margin, size times the margin in all, in one transaction. It gains as the asset falls, and its loss stops at the margin. Refused above maxCostBps. Use the prepare object of gage_put_quote, without its action.",
  put_close: `Prepare closing a put, or any loan on a core with a put router, out of its own pledge: the pledge buys the repayment back and the rest comes back to the wallet, in one transaction (${PUT}).`,
  put_roll: "Prepare rolling a put over through its put router: a new loan of the same size on the same pledge repays it in full, and the wallet's USDG buys what the new payout leaves short.",
  put_auto_roll: "Prepare leaving a put to roll over by itself: gage's keeper rolls it in its last hours through its put router, at most maxCost each, buying each top-up with at most maxSpend of the wallet's USDG, up to four times. Leaves standing approvals to the put router.",
  put_cancel_auto_roll: "Prepare ending a put's instruction to roll over by itself through its put router.",
  lp_borrow: `Prepare an LP loan (${LP}): the position is approved to the lane's core and moves into its own escrow, and the loan's USDG less the fee comes to the wallet. ${V4_MOVE} ${FABLES_BORROW} Refused above maxCostBps. Use the prepare object of gage_lp_quote, without its action.`,
  lp_repay: "Prepare repaying an LP loan in full in USDG before its end, and taking its position back.",
  lp_return_position: "Prepare taking back the position of an LP loan repaid before its end.",
  lp_collect: "Prepare collecting a running LP loan's trading fees (a native ETH pool's as WETH), and a Ramses position's rewards, to the wallet; the liquidity stays in place.",
  lp_withdraw: "Prepare withdrawing what the LP lane's core credits the wallet (a loan's USDG, fees, rewards), every token when token is omitted.",
  lp_deposit: "Prepare a deposit of USDG into an LP vault, which lends against LP positions in the pools of its mandate. Refused while the vault is impaired, its deposits are closed or the registry no longer lets it lend.",
  lp_redeem: "Prepare withdrawing from an LP vault the wallet's own shares (those it received by transfer too), every share its free cash pays when shares is omitted.",
  lp_claim_bonus: `Prepare claiming an LP vault's bonus (${BONUS}), every loan with one when loanId is omitted.`,
  lp_roll: `Prepare rolling an LP loan over: ${LP_ROLL}.`,
  lp_wrap: `Prepare wrapping Fables receipts into a position: ${LP_WRAP}.`,
  lp_unwrap: "Prepare unwrapping a Fables position the wallet holds back into its receipts, with their fees less the claim fee Fables keeps.",
  lp_create_vault: `Prepare opening an LP vault, for a wallet the LP registry lets open one (a curator it allows, or anyone once it opens vault creation): its name, performance fee (500 to 1,500 bps of each loan's fixed cost, fixed for good), largest loan and the pools it funds (gage_capabilities lpLane.pools). ${CURATED}.`,
  lp_vault_add_pool: `Prepare adding a pool to the mandate of an LP vault this wallet curates: it funds new loans there three hours later. ${CURATED}.`,
  lp_vault_remove_pool: `Prepare dropping a pool from the mandate of an LP vault this wallet curates: it funds no new loan there from then on; loans already open run to their ends. ${CURATED}.`,
  park: `Prepare parking: ${PARK}. ${TOGETHER}`,
  unpark: `Prepare unparking: ${UNPARK}. ${TOGETHER}`,
  rehypo_exit_now: `Prepare an exit now from a rehypo pool, ${REHYPO_EXIT}.`,
  earn_exit_now: `Prepare an exit now from a partner vault, ${EARN_EXIT}.`,
  earn_exit_list: `Prepare listing the next loan for ${EXIT_LIST}.`,
  earn_exit_cancel: `Prepare cancelling ${EXIT_CANCEL}.`,
  earn_exit_collect: `Prepare collecting ${EXIT_COLLECT}.`,
};
const DO: Record<ActionName, string> = {
  borrow: "Borrow: pledge a token, receive USDG (or the lend asset named by lendAsset), repay a fixed amount of it within the term. Use the prepare object of gage_borrow_quote, without its action.",
  leverage: "Open a leveraged loop: the loan buys more of the pledged token in one transaction. USDG only. Refused above maxCostBps.",
  cancel: "Cancel a loan still waiting for funding and take its collateral back.",
  reclaim: "Repay a running loan in full, in the asset it is paid in, and take the collateral back, before its term ends.",
  cash_out: "Cash a running loan out: its whole collateral is sold through an aggregator, the loan repaid from the sale, and the rest less gage's 0.5% fee paid to the wallet, in one transaction.",
  roll: "Roll a running loan over: a new loan of the same size on the same pledge repays it in full, and the wallet adds the difference (the old loan's cost and the new fee) or keeps what is over.",
  auto_roll: "Leave a loan to roll over by itself: gage's keeper rolls it in its last hours into a loan of the same size and term, at most maxCost each, up to four times. Leaves standing approvals to gage's rollover router.",
  cancel_auto_roll: "End a loan's instruction to roll over by itself.",
  earn_deposit: "Deposit into a partner vault (lending), in the asset the vault takes: USDG, or its lend asset.",
  earn_redeem: "Withdraw from a partner vault, everything it can pay when shares is omitted.",
  collect: `Collect ${COLLECTS}`,
  feedback: `Rate ${RATING}`,
  put_open: "Open a put: borrow a lend asset (lendAsset) against USDG, whose loan buys more USDG and pledges it with your margin, size times the margin in all, in one transaction. It gains as the asset falls, and its loss stops at the margin. Refused above maxCostBps. Use the prepare object of gage_put_quote, without its action.",
  put_close: `Close a put, or any loan on a core with a put router, out of its own pledge: the pledge buys the repayment back and the rest comes back to the wallet, in one transaction (${PUT}).`,
  put_roll: "Roll a put over through its put router: a new loan of the same size on the same pledge repays it in full, and the wallet's USDG buys what the new payout leaves short.",
  put_auto_roll: "Leave a put to roll over by itself: gage's keeper rolls it in its last hours through its put router, at most maxCost each, buying each top-up with at most maxSpend of the wallet's USDG, up to four times. Leaves standing approvals to the put router.",
  put_cancel_auto_roll: "End a put's instruction to roll over by itself through its put router.",
  lp_borrow: `Borrow against an LP position (${LP}): the position is approved to the lane's core and moves into its own escrow, and the loan's USDG less the fee comes to the wallet. ${V4_MOVE} ${FABLES_BORROW} Refused above maxCostBps. Use the prepare object of gage_lp_quote, without its action.`,
  lp_repay: "Repay an LP loan in full in USDG before its end, and take its position back.",
  lp_return_position: "Take back the position of an LP loan repaid before its end.",
  lp_collect: "Collect a running LP loan's trading fees (a native ETH pool's as WETH), and a Ramses position's rewards, to the wallet; the liquidity stays in place.",
  lp_withdraw: "Withdraw what the LP lane's core credits the wallet (a loan's USDG, fees, rewards), every token when token is omitted.",
  lp_deposit: "Deposit USDG into an LP vault, which lends against LP positions in the pools of its mandate. Refused while the vault is impaired, its deposits are closed or the registry no longer lets it lend.",
  lp_redeem: "Withdraw from an LP vault the wallet's own shares (those it received by transfer too), every share its free cash pays when shares is omitted.",
  lp_claim_bonus: `Claim an LP vault's bonus (${BONUS}), every loan with one when loanId is omitted.`,
  lp_roll: `Roll an LP loan over: ${LP_ROLL}.`,
  lp_wrap: `Wrap Fables receipts into a position: ${LP_WRAP}.`,
  lp_unwrap: "Unwrap a Fables position the wallet holds back into its receipts, with their fees less the claim fee Fables keeps.",
  lp_create_vault: `Open an LP vault, for a wallet the LP registry lets open one (a curator it allows, or anyone once it opens vault creation): its name, performance fee (500 to 1,500 bps of each loan's fixed cost, fixed for good), largest loan and the pools it funds (gage_capabilities lpLane.pools). ${CURATED}.`,
  lp_vault_add_pool: `Add a pool to the mandate of an LP vault this wallet curates: it funds new loans there three hours later. ${CURATED}.`,
  lp_vault_remove_pool: `Drop a pool from the mandate of an LP vault this wallet curates: it funds no new loan there from then on; loans already open run to their ends. ${CURATED}.`,
  park: `Park an out-of-range position: ${PARK}.`,
  unpark: `Unpark: ${UNPARK}.`,
  rehypo_exit_now: `Exit a rehypo pool now, ${REHYPO_EXIT}.`,
  earn_exit_now: `Exit a partner vault now, ${EARN_EXIT}.`,
  earn_exit_list: `List the next loan for ${EXIT_LIST}.`,
  earn_exit_cancel: `Cancel ${EXIT_CANCEL}.`,
  earn_exit_collect: `Collect ${EXIT_COLLECT}.`,
};

const READ ={ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PREPARE_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const SIGN = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function tool<I extends z.ZodObject>(name: string, title: string, description: string, input: I, annotations: GageTool["annotations"], run: (input: z.output<I>) => Promise<unknown>): GageTool {
  const inputSchema: z.ZodObject = input;
  return { name, title, description, inputSchema, annotations, execute: async (args) => plain(await run(parseInput(input, args ?? {}))) };
}

/**
 * Pool vaults (D333), for a DEX that lends its pool's tokens through gage, from any curator while creation is open: the pools
 * among the partner vaults, and the calls that create a pool's vaults, one per pool token gage lends, for one wallet
 * batch or a Safe's Transaction Builder file. Neither signs. Apart from `gageTools`, so a catalogue that does not offer
 * them stays as it is: gage-mcp adds them.
 */
export function poolVaultTools(gage: Gage): GageTool[] {
  return [
    tool("gage_pool_vaults", "Pool vaults", "The pools among the partner vaults (a curator's alone where one is named): one curator's vaults whose names end in the pool's tag (Fables NVDA/USDG), one for each pool token gage lends, each side its vault and gage.cash page, or none.",
      poolVaultsInput, READ, (i) => gage.poolVaults(i)),
    tool("gage_create_pool_vaults", "Create pool vaults", "The calls that create a DEX pool's vaults on gage, one for each pool token gage lends, each on its own factory, from any curator while its creation is open (mainnet's since 5 November 2026), otherwise one gage admitted as a partner: what both share named once (fee, longest loan, Loan grade floor, priority fee), and for each token its largest loan and the cash it keeps free. Neither vault lends against the pool's own two tokens unless a side names one and allowPoolTokens is true. Answers the calls for one wallet batch (EIP-5792, atomic) and the same as a Safe{Wallet} Transaction Builder file (safeBatch), each simulated from the curator now; a token gage does not lend gets no vault, and the answer says why. Never signs.",
      createPoolVaultsInput, READ, (i) => gage.createPoolVaults(i)),
  ];
}

/**
 * The catalogue for one Gage: eight reads (the put quote where puts open, and four LP reads where the LP lane is public)
 * and a prepare per action it serves; with a signer, also `gage_wallet` and those actions.
 * Where park is served, also its read, `gage_park_positions`.
 */
export function gageTools(gage: Gage, options: ToolOptions = {}): GageTool[] {
  const prepare = options.prepare ?? ((input: ActionInput) => gage.prepare(input));
  const note = options.prepareNote ?? "Returns the next unsigned transaction; never signs.";
  const tools: GageTool[] = [
    tool("gage_capabilities", "gage capabilities", "Chain, contracts, allowed loan terms, fees, the rules and any lend assets besides USDG. Start here.", emptyInput, READ, () => gage.capabilities()),
    tool("gage_assets", "Collateral gage takes", "Tokens gage takes as collateral now: each one's minimum pledge, its most per loan where one is set (maxPerLoan, null where there is none), whether leverage buys it and its Borrow link on gage.cash; a row names the lend asset it is borrowed in, once there is more than USDG.", emptyInput, READ, () => gage.assets()),
    tool("gage_borrow_quote", "Borrow quote", "The largest loan the partner vaults fund now for at most maxCollateral of a token, at the lowest fixed cost they accept; or one exact loan (collateral and principal) at the lowest cost that funds it now, or at your own costBps, with what each Loan grade costs; in USDG or the lend asset named, with a prepare object for gage_prepare_borrow.", borrowQuoteInput, READ, (i) => gage.borrowQuote(i)),
    tool("gage_leverage_quote", "Leverage quote", "Preview a leveraged loop for a pledge and a multiple: amounts, cost and the most the purchase costs. Signs nothing.", leverageQuoteInput, READ, (i) => gage.leverageQuote(i)),
    tool("gage_loan", "Loan", "One loan: state, amounts, deadlines, what can be done with it now (here, or on gage.cash for an action this server does not serve), its standing instruction to roll by itself, and what closed it (a roll or a cash-out).", loanInput, READ, (i) => gage.loan(i)),
    tool("gage_portfolio", "Portfolio", "A wallet's loans (each one's sGAGE to claim, raw, and whether it rolls by itself), Earn holdings and credits (USDG, and each lend asset's apart); where a release names the chain's exit desk, each holding's open exit now and where it stands, and what exit sales paid the wallet. A core or vault that could not be read just now is named in unread, never shown as empty.", walletInput, READ, (i) => gage.portfolio(i.wallet)),
    tool("gage_earn_vaults", "Earn vaults", "The partner vaults that lend: tokens, fees, size, free cash, share value and each one's link on gage.cash.", emptyInput, READ, () => gage.earnVaults()),
    tool("gage_vault_free_cash", "Vault free cash", "One partner vault's free cash: what withdrawals are paid from now, what comes back to it as its loans end, by day, and what loans past their end bring back once settled, only if their borrowers repay; and the share of the vault a new loan must leave free (bufferBps).", vaultInput, READ, (i) => gage.vaultFreeCash(i)),
  ];
  // Where puts open, their quote: a read beside the others, served with put_open alone, so a catalogue without puts is as before.
  if (gage.actions.includes("put_open")) {
    tools.push(tool("gage_put_quote", "Put quote", `Preview a put for a margin and a size: ${PUT}. Its pledge, purchase, loan, repayment, cost and the most the purchase costs, with a prepare object for gage_prepare_put_open. Signs nothing.`,
      putQuoteInput, READ, (i) => gage.putQuote(i)));
  }
  // Where the release makes the LP lane public, its reads, whatever actions this Gage serves: the hosted service serves
  // them beside its own actions, none of the lane's among them.
  if (gage.deployment.lpLane) {
    tools.push(
      tool("gage_lp_positions", "LP positions", `A wallet's liquidity positions on ${LP_FORMATS} in a pool gage's LP lane lends against: range, liquidity, amounts and worth in USDG at the pool's price now, and whether the lane takes it now. Uniswap v4 positions are found through gage's index and checked on chain; the note says when some may be missing. Start here to borrow against one.`,
        walletInput, READ, (i) => gage.lpPositions(i.wallet)),
      tool("gage_lp_quote", "LP loan quote", `A quote for ${LP}: what the wallet receives and repays, its cost and loan-to-value, signed for the wallet for five minutes at most, with a prepare object for gage_prepare_lp_borrow. Signs nothing.`,
        lpQuoteInput, READ, (i) => gage.lpQuote(i)),
      tool("gage_lp_loans", "LP loans", "A wallet's LP loans (state, amounts, end, its position now, what can be done with it now) and what the lane's core credits the wallet.",
        walletInput, READ, (i) => gage.lpLoans(i.wallet)),
      tool("gage_lp_vaults", "LP vaults", "The LP vaults that lend against LP positions, the release's and those curators opened: size, free cash, loans out, share value, fee, its curator, the pools it funds (its mandate, in plain words in funds), whether the registry still lets it lend, and whether each takes deposits and pays out now.",
        emptyInput, READ, () => gage.lpVaults()),
    );
  }
  // Where park is served (D334), its read: a wallet's out-of-range positions and the vaults that take what each holds.
  if (gage.actions.includes("park")) {
    tools.push(tool("gage_park_positions", "Out-of-range positions", "A wallet's out-of-range liquidity positions in the pools gage parks from (gage_capabilities parkPools): each one's pool, range, the one token it holds now and the partner vaults that take it, or why none can. Start here to park one.",
      parkPositionsInput, READ, (i) => gage.parkPositions(i.wallet, i.also ?? [])));
  }
  const served = (entries: [ActionName, z.ZodObject][]) => entries.filter(([action]) => gage.actions.includes(action));
  for (const [action, shape] of served(Object.entries(actionShapes) as [ActionName, z.ZodObject][])) {
    tools.push(tool(`gage_prepare_${action}`, `Prepare: ${TITLES[action]}`, `${PREPARE[action]} ${note}`, shape, PREPARE_HINTS,
      (i) => prepare({ ...(i as object), action } as ActionInput)));
  }
  const signer = options.signer;
  if (!signer) return tools;
  const limit = options.limit;
  const who = short(signer.address);
  tools.push(tool("gage_wallet", "This wallet", `The wallet this server signs with (${who}): its address, ETH for gas, USDG, lend assets and collateral tokens.`, emptyInput, READ, () => gage.balances(signer.address)));
  for (const [action, shape] of served(Object.entries(signedShapes) as [ActionName, z.ZodObject][])) {
    tools.push(tool(`gage_${action}`, TITLES[action], `${DO[action]} Signs and sends every step from ${who}: exact-amount approvals first, each step simulated before it is sent.`, shape, SIGN,
      (i) => gage.run({ ...(i as object), action } as Parameters<Gage["run"]>[0], signer, limit ? { limit } : {})));
  }
  return tools;
}
