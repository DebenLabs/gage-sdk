/**
 * Leaving a partner vault: a withdrawal of what its free cash pays now, and exit now for the rest, where a release names
 * the chain's exit desk. Exit now sells one of the vault's loans for your shares: preview it first (what you receive, what
 * you give up and when), then commit, follow it in the portfolio, and collect what the sale paid. Mainnet by default, so
 * this moves real money.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`:
 *   npx tsx examples/exit-now.ts <wallet> <vault>              the preview, signing nothing
 *   WALLET_KEY=0x… npx tsx examples/exit-now.ts <wallet> <vault> go
 */
import { pathToFileURL } from "node:url";
import { createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

/** What leaving `vault` looks like now: what the vault pays now, and the exit now plan for the rest, with its preview. */
export async function exitPreview(gage: Gage, wallet: string, vault: string) {
  const { earn } = await gage.portfolio(wallet);
  const holding = earn.find((h) => h.vault.toLowerCase() === vault.toLowerCase());
  if (!holding) throw new Error("This wallet holds no shares of that vault");
  const plan = await gage.prepare({ action: "earn_exit_now", wallet, vault });
  return { holding, exit: holding.exit ?? null, summary: plan.summary, preview: plan.preview ?? null, next: plan.next?.label ?? null, notes: plan.notes };
}

/**
 * Withdraws what the vault pays now, then exits the rest now. The sale pays at today's share value in its own
 * transaction, owed by the exit desk until collected (`collectExits`).
 */
export async function leave(gage: Gage, signer: Signer, vault: string) {
  const withdrawn = await gage.run({ action: "earn_redeem", vault }, signer);
  const exited = await gage.run({ action: "earn_exit_now", vault }, signer);
  const { earn } = await gage.portfolio(signer.address);
  return { withdrawn: withdrawn.status, exited: exited.status, error: exited.error, exit: earn.find((h) => h.vault.toLowerCase() === vault.toLowerCase())?.exit ?? null };
}

/** Collects what exit sales paid the wallet, in every asset the desk owes it. */
export async function collectExits(gage: Gage, signer: Signer) {
  const { exitOwed } = await gage.portfolio(signer.address);
  if (!exitOwed?.some((x) => BigInt(x.amount) > 0n)) return null;
  return gage.run({ action: "earn_exit_collect" }, signer);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [wallet, vault, go] = process.argv.slice(2), key = process.env.WALLET_KEY;
  if (!wallet || !vault) {
    console.error("Usage: npx tsx examples/exit-now.ts <wallet> <vault> [go]");
    process.exit(1);
  }
  const gage = createGage();
  console.dir(await exitPreview(gage, wallet, vault), { depth: 4 });
  if (go === "go") {
    if (!key) throw new Error("WALLET_KEY is needed to exit");
    console.dir(await leave(gage, privateKeySigner(key), vault), { depth: 4 });
  }
}
