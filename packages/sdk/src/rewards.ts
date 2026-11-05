/**
 * sGAGE on a stablecoin lend market (R2 option C, 27 October 2026): its core's own ledger pays a loan's rewards from a
 * treasury-funded budget and reverts the fill that activates the loan when that budget is short, so a listing asks for
 * them only while the budget covers the quote. The rule is gage.cash's own (shared/lend-rewards.mjs), ported here as the
 * SDK ships alone; test/rewards.test.ts holds the two to each other in gage's main repository.
 */
import type { Chain } from "./chain.js";
import type { Engine } from "./deployment.js";

/** Whether a ledger's free budget pays a quote: only a quote above zero, and only within the budget. */
export function rewardsCovered({ quote, freeBudget }: { quote: { borrower: bigint; lender: bigint }; freeBudget: bigint }): boolean {
  const total = quote.borrower + quote.lender;
  return total > 0n && total <= freeBudget;
}

/**
 * The `withRewards` a listing of `principal` for `term` on `engine` is sent with, a loop's, a roll's and a put's alike. On
 * a core whose own registry quotes its rewards (`registryRewards`), true while its ledger's free budget covers the quote
 * for the core's own fee (the principal times the registry's `feeBps`, rounded down, as `GageV2Vault._list` charges it).
 * False everywhere else, reading nothing: USDG's bridged core allocates through its bridge at activation, whatever the
 * listing asked.
 */
export async function listsWithRewards(chain: Chain, engine: Engine, term: number, principal: bigint): Promise<boolean> {
  if (!engine.registryRewards) return false;
  const fee = (principal * BigInt(await chain.feeBps(engine.registry))) / 10_000n;
  const [quote, freeBudget] = await Promise.all([chain.rewardsQuote(engine.registry, term, fee), chain.rewardsBudget(engine.rewards)]);
  return rewardsCovered({ quote, freeBudget });
}
