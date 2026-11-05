/**
 * Reading gage: what it lends against and on which terms, the partner vaults and what each can pay now, a wallet's loans
 * and Earn holdings, and one loan. Reads only: no key, and nothing is signed.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/reads.ts [wallet] [loanId]
 */
import { pathToFileURL } from "node:url";
import { createGage, type Gage } from "gage-sdk";

/** The market as a front page draws it: the terms, the fee, the collateral, the assets gage lends and the vaults that lend them. */
export async function markets(gage: Gage) {
  const [caps, { assets }, { vaults }] = await Promise.all([gage.capabilities(), gage.assets(), gage.earnVaults()]);
  const lending = vaults.filter((v) => v.lends);
  return {
    network: caps.network,
    terms: caps.terms.map((t) => `${t.days} days`),
    originationFeeBps: caps.originationFeeBps,
    newLoansPaused: caps.newLoansPaused,
    // USDG first, then each lend asset a generation lends (a stock token or a stablecoin), each with its own terms.
    lends: ["USDG", ...(caps.lendAssets ?? []).map((a) => a.symbol)],
    collateral: assets.map((a) => a.symbol),
    vaults: lending.map((v) => v.name),
    // What one vault pays withdrawals from now, and what comes back to it as its loans end, if they are repaid.
    freeCash: lending[0] ? await gage.vaultFreeCash({ vault: lending[0].vault }) : null,
  };
}

/** A wallet: its loans, Earn holdings, credits and balances. `unread` names any part that could not be read just now. */
export async function wallet(gage: Gage, address: string) {
  const [portfolio, balances] = await Promise.all([gage.portfolio(address), gage.balances(address)]);
  return {
    loans: portfolio.loans.map((l) => ({ loanId: l.loanId, engine: l.engine, state: l.state, repay: l.repay, endsAt: l.endsAt, rollsByItself: l.autoRoll })),
    earn: portfolio.earn.map((h) => ({ vault: h.vault, name: h.name, shares: h.shares })),
    usdgCredit: portfolio.usdgCredit,
    unread: portfolio.unread ?? [],
    balances,
  };
}

/** One loan: its state, deadlines, what can be done with it now, and its standing instruction to roll, if any. */
export async function loanState(gage: Gage, loanId: string, engine?: string) {
  const loan = await gage.loan(engine === undefined ? { loanId } : { loanId, engine });
  return { state: loan.state, actions: loan.actions, autoRoll: loan.autoRoll, closedBy: loan.closedBy };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gage = createGage();
  const [address, loanId] = process.argv.slice(2);
  console.dir(await markets(gage), { depth: 3 });
  if (address) console.dir(await wallet(gage, address), { depth: 3 });
  if (loanId) console.dir(await loanState(gage, loanId), { depth: 3 });
}
