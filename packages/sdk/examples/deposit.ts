/**
 * A USDG deposit into the partner vault you chose, carried out with your own key: the approval for the exact amount
 * first, every step simulated before it is sent. Mainnet by default, so this moves real money; `createGage({ network:
 * "testnet" })` and `privateKeySigner(key, { network: "testnet" })` use the testnet. Anyone can create a vault, so nothing
 * here picks one for you: a vault's place in the list and its name say nothing of who runs it.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: WALLET_KEY=0x… npx tsx examples/deposit.ts <vault> 10
 */
import { pathToFileURL } from "node:url";
import { parseUnits } from "viem";
import { createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

/** Deposits `usdg` (a decimal amount, such as "10.5") into `chosen`, the address of the partner vault you chose. */
export async function deposit(gage: Gage, signer: Signer, chosen: string, usdg: string) {
  const { vaults } = await gage.earnVaults();
  const vault = vaults.find((v) => v.vault.toLowerCase() === chosen.toLowerCase());
  // A vault that lends USDG names its figures in USDG; one that lends another asset names them in that asset.
  if (!vault?.lends || !("totalAssetsUSDG" in vault)) throw new Error("That vault takes no USDG deposits now");
  return gage.run({ action: "earn_deposit", vault: vault.vault, amount: parseUnits(usdg, 6).toString() }, signer);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.WALLET_KEY, [chosen, amount] = process.argv.slice(2);
  if (!key || !chosen || !amount) {
    console.error("Usage: WALLET_KEY=0x… npx tsx examples/deposit.ts <vault> <USDG amount>");
    process.exit(1);
  }
  console.log(await deposit(createGage(), privateKeySigner(key), chosen, amount));
}
