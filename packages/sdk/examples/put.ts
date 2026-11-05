/**
 * A put on a lend asset, carried out with your own key: a loan of the asset (NVDA, say) against USDG, whose payout buys
 * more USDG and pledges it with your margin, so it gains as the asset falls and its loss stops at the margin. Served
 * where a lend asset's generation names a put router (`capabilities().lendAssets[].putRouter`). Mainnet by default, so
 * this moves real money.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: WALLET_KEY=0x… npx tsx examples/put.ts <symbol> <margin USDG> [size]
 */
import { pathToFileURL } from "node:url";
import { parseUnits } from "viem";
import { createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

/** The lend asset that offers puts, by symbol. */
export async function putAsset(gage: Gage, symbol: string) {
  const { lendAssets = [] } = await gage.capabilities();
  const asset = lendAssets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
  if (!asset || !("putRouter" in asset)) throw new Error(`gage offers no put on ${symbol} now`);
  return asset;
}

/** Opens a put of `size` times `marginUsdg` (a decimal amount) over the asset's shortest term, at its quoted cost. */
export async function openPut(gage: Gage, signer: Signer, symbol: string, marginUsdg: string, size = 3) {
  const asset = await putAsset(gage, symbol);
  const term = asset.terms[0];
  if (!term) throw new Error(`${asset.symbol} offers no term now`);
  const quote = await gage.putQuote({ lendAsset: asset.token, margin: parseUnits(marginUsdg, 6).toString(), size, term: term.seconds, wallet: signer.address });
  const { action: _, ...put } = quote.prepare;
  const opened = await gage.run({ action: "put_open", ...put }, signer);
  return { quote: quote.summary, status: opened.status, loan: opened.loan, error: opened.error };
}

/** Closes a running put out of its own pledge: the pledge buys the repayment back, the rest comes back in USDG. */
export async function closePut(gage: Gage, signer: Signer, loanId: string, engine: string, minBack?: string) {
  const closed = await gage.run({ action: "put_close", loanId, engine, ...(minBack ? { minBack } : {}) }, signer);
  return { status: closed.status, sent: closed.sent, error: closed.error };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.WALLET_KEY, [symbol, margin, size] = process.argv.slice(2);
  if (!key || !symbol || !margin) {
    console.error("Usage: WALLET_KEY=0x… npx tsx examples/put.ts <symbol> <margin USDG> [size]");
    process.exit(1);
  }
  console.dir(await openPut(createGage(), privateKeySigner(key), symbol, margin, size ? Number(size) : 3), { depth: 4 });
}
