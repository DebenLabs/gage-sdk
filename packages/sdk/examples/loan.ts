/**
 * A running loan, carried out with your own key: repay it (reclaim), roll it into a new loan of the same size, leave it
 * to roll by itself near its end, stop that, or cash it out. Each is offered only where the loan's core has it and while
 * the loan's state allows it, which `loan().actions` says first. Mainnet by default, so this moves real money.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`:
 *   WALLET_KEY=0x… npx tsx examples/loan.ts <loanId> <reclaim|roll|auto_roll|cancel_auto_roll|cash_out> [engine]
 */
import { pathToFileURL } from "node:url";
import { createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

export type LoanStep =
  | { action: "reclaim" | "cancel_auto_roll" }
  | { action: "roll"; term?: number }
  | { action: "auto_roll"; maxCost?: string }
  | { action: "cash_out"; minNet?: string; maxSlippageBps?: number };

/** Whether `loan().actions` offers `action` here now (an action done on gage.cash instead reads "… on gage.cash (…)"). */
export const offers = (actions: readonly string[], action: string) => actions.some((a) => a === action || a.startsWith(`${action} (`));

/** Carries `step` out on the signer's loan `loanId`, once the loan says it can be done here now. */
export async function manageLoan(gage: Gage, signer: Signer, loanId: string, step: LoanStep, engine?: string) {
  const at = engine === undefined ? { loanId } : { loanId, engine };
  const loan = await gage.loan(at);
  if (!offers(loan.actions, step.action)) throw new Error(`Loan ${loanId} offers no ${step.action} here now: ${loan.actions.join("; ") || "nothing"}`);
  // The loan's own core, so a loan in a lend asset is acted on where it lives.
  const result = await gage.run({ ...step, loanId, engine: loan.engine }, signer);
  // A roll opens a new loan, read from its receipt; an instruction to roll by itself is read back from the router.
  const after = step.action === "roll" && result.loan ? await gage.loan({ loanId: result.loan.loanId, engine: result.loan.engine }) : await gage.loan({ loanId, engine: loan.engine });
  return { status: result.status, sent: result.sent, error: result.error, newLoan: step.action === "roll" ? result.loan : null, autoRoll: after.autoRoll };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.WALLET_KEY, [loanId, action, engine] = process.argv.slice(2);
  const steps = ["reclaim", "roll", "auto_roll", "cancel_auto_roll", "cash_out"];
  if (!key || !loanId || !action || !steps.includes(action)) {
    console.error(`Usage: WALLET_KEY=0x… npx tsx examples/loan.ts <loanId> <${steps.join("|")}> [engine]`);
    process.exit(1);
  }
  console.dir(await manageLoan(createGage(), privateKeySigner(key), loanId, { action } as LoanStep, engine), { depth: 4 });
}
