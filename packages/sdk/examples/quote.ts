/**
 * What gage lends against now, and the largest loan the partner vaults fund for one token. Reads only: no key, and
 * nothing is signed.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/quote.ts [symbol]
 */
import { pathToFileURL } from "node:url";
import { createGage, type Gage } from "gage-sdk";

/** The terms gage offers, its rules, and a quote for one whole token (or its minimum, when larger) over the shortest term. */
export async function quote(gage: Gage, symbol?: string) {
  const { terms, rules } = await gage.capabilities();
  const { assets } = await gage.assets();
  // Collateral lent in USDG: a row naming another lend asset is borrowed in that asset instead.
  const lentInUsdg = assets.filter((a) => !("asset" in a) || a.asset.symbol === "USDG");
  const asset = lentInUsdg.find((a) => symbol === undefined || a.symbol.toLowerCase() === symbol.toLowerCase());
  if (!asset) throw new Error(`gage takes no ${symbol ?? "token"} as collateral now`);
  const term = terms[0];
  if (!term) throw new Error("gage offers no loan term now");
  const whole = 10n ** BigInt(asset.decimals), least = BigInt(asset.minAmount);
  const pledge = least > whole ? least : whole;
  const q = await gage.borrowQuote({ token: asset.token, maxCollateral: pledge.toString(), term: term.seconds });
  return { terms: terms.map((t) => `${t.days} days`), rules, asset: asset.symbol, summary: q.summary, prepare: q.prepare };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await quote(createGage(), process.argv[2]));
}
