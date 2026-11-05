/**
 * The assets gage lends besides USDG: each lend generation (a stock token such as GLD, or a stablecoin market), its
 * terms, the collateral it takes and its partner vaults. A release lists its own generations, and a stablecoin market
 * deployed later through the release's GenerationDeployer is found on chain, checked against that deployer and served
 * with no new SDK release. Reads only: no key, and nothing is signed.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/generations.ts [lend asset] [collateral] [amount]
 */
import { pathToFileURL } from "node:url";
import { parseUnits } from "viem";
import { createGage, type Gage } from "gage-sdk";

/** Every asset gage lends now, with its terms, what it takes as collateral and the vaults that lend it. */
export async function lendMarkets(gage: Gage) {
  // Ask gage's indexer for generations found on chain now; every other read asks at most once a minute.
  await gage.refreshGenerations();
  const [{ lendAssets = [] }, { assets }, { vaults }] = await Promise.all([gage.capabilities(), gage.assets(), gage.earnVaults()]);
  const lentIn = (row: object) => ("asset" in row ? (row.asset as { token: string }).token.toLowerCase() : gage.deployment.usdg.toLowerCase());
  return lendAssets.map((a) => ({
    symbol: a.symbol, token: a.token, decimals: a.decimals, stablecoin: a.stable, core: a.core,
    terms: a.terms.map((t) => `${t.days} days`), puts: "putRouter" in a,
    collateral: assets.filter((row) => lentIn(row) === a.token.toLowerCase()).map((row) => row.symbol),
    vaults: vaults.filter((v) => lentIn(v) === a.token.toLowerCase()).map((v) => v.name),
  }));
}

/** The largest loan paid out in `lendAsset` (its symbol) that `amount` of `collateral` (a symbol) raises now, over its shortest term. */
export async function quoteIn(gage: Gage, lendAsset: string, collateral: string, amount: string) {
  const markets = await lendMarkets(gage);
  const market = markets.find((m) => m.symbol.toLowerCase() === lendAsset.toLowerCase());
  if (!market) throw new Error(`gage lends no ${lendAsset} now`);
  const { assets } = await gage.assets();
  const row = assets.find((a) => "asset" in a && a.asset.token.toLowerCase() === market.token.toLowerCase() && a.symbol.toLowerCase() === collateral.toLowerCase());
  if (!row) throw new Error(`gage's ${market.symbol} vaults take no ${collateral} now`);
  const { lendAssets = [] } = await gage.capabilities();
  const term = lendAssets.find((a) => a.token === market.token)?.terms[0];
  if (!term) throw new Error(`${market.symbol} offers no term now`);
  const quote = await gage.borrowQuote({ token: row.token, maxCollateral: parseUnits(amount, row.decimals).toString(), term: term.seconds, lendAsset: market.token });
  return { summary: quote.summary, prepare: quote.prepare };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gage = createGage();
  const [lendAsset, collateral, amount] = process.argv.slice(2);
  console.dir(await lendMarkets(gage), { depth: 3 });
  if (lendAsset && collateral && amount) console.dir(await quoteIn(gage, lendAsset, collateral, amount), { depth: 3 });
}
