/**
 * Every gage tool in one catalogue (D222, D224). The hosted MCP, the local MCP that signs with an agent's own key, and
 * any agent framework use the same names, inputs and words. Each tool is a name, a title, a description, a zod input,
 * hints, and a function that answers in plain JSON.
 */
import type { z } from "zod";
import type { Gage } from "./client.js";
import { short } from "./format.js";
import { MAINNET_DEFAULTS } from "./networks.js";
import { actionShapes, borrowQuoteInput, emptyInput, leverageQuoteInput, loanInput, parseInput, signedShapes, walletInput, type ActionInput, type ActionName } from "./schemas.js";
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
  feedback: "Rate gage",
};
/** What a rating is (D302), in each of its tools' words: gage's entry exists on mainnet only, where the tools are served. */
const RATING = `gage (agent #${MAINNET_DEFAULTS.beacon.agentId} in ERC-8004) in its Reputation Registry: your own score from 0 to 100, once a wallet, public on chain. Optional: gage offers nothing for a rating.`;
/** What `collect` gathers, and what stays gage.cash's: the earlier surfaces this SDK does not collect from. */
const COLLECTS = "what is ready here: USDG and lend assets from loans, collateral back, vault earnings and the sGAGE of loans and partner vaults; a claim that would revert now is left out, and said. The first vault's credits and claims, earlier engines' lender recoveries, retired Earn strategies and the GAGE/sGAGE pool's rewards and Drip are collected on gage.cash.";
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
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PREPARE_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const SIGN = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function tool<I extends z.ZodObject>(name: string, title: string, description: string, input: I, annotations: GageTool["annotations"], run: (input: z.output<I>) => Promise<unknown>): GageTool {
  const inputSchema: z.ZodObject = input;
  return { name, title, description, inputSchema, annotations, execute: async (args) => plain(await run(parseInput(input, args ?? {}))) };
}

/** The catalogue for one Gage: seven reads and a prepare per action it serves; with a signer, also `gage_wallet` and those actions. */
export function gageTools(gage: Gage, options: ToolOptions = {}): GageTool[] {
  const prepare = options.prepare ?? ((input: ActionInput) => gage.prepare(input));
  const note = options.prepareNote ?? "Returns the next unsigned transaction; never signs.";
  const tools: GageTool[] = [
    tool("gage_capabilities", "gage capabilities", "Chain, contracts, allowed loan terms, fees, the rules and any lend assets besides USDG. Start here.", emptyInput, READ, () => gage.capabilities()),
    tool("gage_assets", "Collateral gage takes", "Tokens gage takes as collateral now: each one's minimum pledge, its most per loan where one is set (maxPerLoan, null where there is none), whether leverage buys it and its Borrow link on gage.cash; a row names the lend asset it is borrowed in, once there is more than USDG.", emptyInput, READ, () => gage.assets()),
    tool("gage_borrow_quote", "Borrow quote", "The largest loan the partner vaults fund now for at most maxCollateral of a token, or one exact loan (collateral and principal) priced as gage.cash prices it, in USDG or the lend asset named, with a prepare object for gage_prepare_borrow.", borrowQuoteInput, READ, (i) => gage.borrowQuote(i)),
    tool("gage_leverage_quote", "Leverage quote", "Preview a leveraged loop for a pledge and a multiple: amounts, cost and the most the purchase costs. Signs nothing.", leverageQuoteInput, READ, (i) => gage.leverageQuote(i)),
    tool("gage_loan", "Loan", "One loan: state, amounts, deadlines, what can be done with it now (here, or on gage.cash for an action this server does not serve), its standing instruction to roll by itself, and what closed it (a roll or a cash-out).", loanInput, READ, (i) => gage.loan(i)),
    tool("gage_portfolio", "Portfolio", "A wallet's loans (each one's sGAGE to claim, raw, and whether it rolls by itself), Earn holdings and credits (USDG, and each lend asset's apart).", walletInput, READ, (i) => gage.portfolio(i.wallet)),
    tool("gage_earn_vaults", "Earn vaults", "The partner vaults that lend: tokens, fees, size, free cash, share value and each one's link on gage.cash.", emptyInput, READ, () => gage.earnVaults()),
  ];
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
