/**
 * A USDG deposit into a partner vault, carried out with your own key: the approval for the exact amount first, every
 * step simulated before it is sent. Mainnet by default, so this moves real money; `createGage({ network: "testnet" })`
 * and `privateKeySigner(key, { network: "testnet" })` use the testnet.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: WALLET_KEY=0x… npx tsx examples/deposit.ts 10
 */
import { pathToFileURL } from "node:url";
import { parseUnits } from "viem";
import { createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

/** Deposits `usdg` (a decimal amount, such as "10.5") into the first partner vault that takes USDG deposits now. */
export async function deposit(gage: Gage, signer: Signer, usdg: string) {
  const { vaults } = await gage.earnVaults();
  // A vault that lends USDG names its figures in USDG; one that lends another asset names them in that asset.
  const vault = vaults.find((v) => v.lends && "totalAssetsUSDG" in v);
  if (!vault) throw new Error("No partner vault takes USDG deposits now");
  return gage.run({ action: "earn_deposit", vault: vault.vault, amount: parseUnits(usdg, 6).toString() }, signer);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.WALLET_KEY, amount = process.argv[2];
  if (!key || !amount) {
    console.error("Usage: WALLET_KEY=0x… npx tsx examples/deposit.ts <USDG amount>");
    process.exit(1);
  }
  console.log(await deposit(createGage(), privateKeySigner(key), amount));
}
