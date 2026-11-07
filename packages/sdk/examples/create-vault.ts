/**
 * One partner vault of your own: created and managed with your own key, the manager's calls gage.cash's Manage sends, and
 * what a holder can take out read from the chain alone. Mainnet by default, so this spends real gas; `createGage({ network:
 * "testnet" })` and `privateKeySigner(key, { network: "testnet" })` use the testnet, where creation is for admitted partners.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/create-vault.ts "Acme Stocks" (a read, for a
 * Safe); WALLET_KEY=0x… npx tsx examples/create-vault.ts "Acme Stocks" create
 */
import { pathToFileURL } from "node:url";
import { parseUnits } from "viem";
import { createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

/** A vault lending USDG against stocks, at most `largestLoan` USDG a loan. Its name is free, and the signer manages it for good. */
export async function createVault(gage: Gage, signer: Signer, name: string, largestLoan: string) {
  const made = await gage.run({ action: "create_vault", name, term: 604_800, feeBps: 1_000, maxLoan: parseUnits(largestLoan, 6).toString() }, signer);
  return { status: made.status, vault: made.vault ?? null, sent: made.sent.map((s) => s.hash) };
}

/** The same vault for a Safe: the call and its Transaction Builder file, simulated from the curator now. Signs nothing. */
export async function vaultForSafe(gage: Gage, safe: string, name: string) {
  const { calls, safeBatch, collateral, notes } = await gage.createVault({ curator: safe, name, term: 604_800, feeBps: 1_000, maxLoan: "1500000000" });
  return { calls, safeBatch, lendsAgainst: collateral.map((t) => t.symbol), notes };
}

/** Its manager's calls: each field one transaction, what the vault has already left out. Lower caps apply at once, higher ones wait three hours. */
export async function tighten(gage: Gage, signer: Signer, vault: string) {
  const { settings, waiting } = await gage.vaultOnChain({ vault });
  if (!settings) throw new Error("This vault is from before named limits: manage it on gage.cash");
  const managed = await gage.run({ action: "vault_manage", vault, maxLoan: (BigInt(settings.maxLoan) / 2n).toString(), cashKeptFreeBps: 1_000, name: "Acme Stocks, careful" }, signer);
  return { status: managed.status, sent: managed.sent.map((s) => s.label), waiting };
}

/** What a holder can take out now, and the call for it, read from the chain alone: it answers while gage's index does not. */
export async function withdrawCall(gage: Gage, wallet: string, vault: string) {
  const { holder, settlementDue } = await gage.vaultOnChain({ vault, wallet });
  return { settlementDue, payableNow: holder?.payableNow ?? "0", call: holder?.withdraw ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2] ?? "Acme Stocks", key = process.env.WALLET_KEY;
  if (process.argv[3] === "create" && key) console.dir(await createVault(createGage(), privateKeySigner(key), name, "1500"), { depth: 4 });
  // A read from a wallet that holds nothing: no key, nothing signed.
  else console.dir(await vaultForSafe(createGage(), "0x000000000000000000000000000000000000dEaD", name), { depth: 2 });
}
