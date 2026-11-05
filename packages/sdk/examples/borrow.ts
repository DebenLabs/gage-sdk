/**
 * Borrowing, carried out with your own key: the largest loan the partner vaults fund now for a pledge, at the lowest fixed
 * cost they accept (one click), listed, funded by the vaults on gage's next pass, then collected. `exactQuote` is the
 * advanced form, where the borrower names the loan and, if they like, its cost. Mainnet by default, so this moves real
 * money; `createGage({ network: "testnet" })` and `privateKeySigner(key, { network: "testnet" })` use the testnet.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: WALLET_KEY=0x… npx tsx examples/borrow.ts <symbol> <amount> [days]
 */
import { pathToFileURL } from "node:url";
import { parseUnits } from "viem";
import { ApiError, createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

/** A term gage offers now, in seconds: `days` (7 when omitted), refused when no core here offers it. */
export async function termOf(gage: Gage, days = 7) {
  const { terms } = await gage.capabilities();
  const term = terms.find((t) => t.days === days);
  if (!term) throw new Error(`gage offers no ${days}-day loan now; it offers ${terms.map((t) => `${t.days} days`).join(", ")}`);
  return term.seconds;
}

/** The collateral row for a symbol, lent in USDG unless `lendAsset` names another asset gage lends. */
export async function collateralOf(gage: Gage, symbol: string, lendAsset?: string) {
  const { assets } = await gage.assets();
  // A row names the asset it is borrowed in once gage lends more than USDG.
  const lentIn = (a: (typeof assets)[number]) => ("asset" in a ? a.asset.token : gage.deployment.usdg).toLowerCase();
  const want = (lendAsset ?? gage.deployment.usdg).toLowerCase();
  const asset = assets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase() && lentIn(a) === want);
  if (!asset) throw new Error(`gage takes no ${symbol} as collateral now`);
  return asset;
}

/**
 * One click: pledge at most `amount` of the token (a decimal amount, such as "1.5") and borrow the largest loan the vaults
 * fund whole now, at the lowest fixed cost they accept. Waits for the vaults to fund it, then collects the payout.
 */
export async function borrow(gage: Gage, signer: Signer, symbol: string, amount: string, days = 7) {
  const [asset, term] = await Promise.all([collateralOf(gage, symbol), termOf(gage, days)]);
  const quote = await gage.borrowQuote({ token: asset.token, maxCollateral: parseUnits(amount, asset.decimals).toString(), term, wallet: signer.address });
  const { action: _, ...terms } = quote.prepare;
  // Lists the loan: an exact approval of the pledge first, each step simulated before it is sent.
  const listed = await gage.run({ action: "borrow", ...terms }, signer);
  if (listed.status !== "done" || !listed.loan) return { quote: quote.summary, listed, funded: null, collected: null };
  // gage's keeper funds a listing from the partner vaults on its next pass; the payout waits on the core until collected.
  const funded = await gage.waitForFill({ loanId: listed.loan.loanId, engine: listed.loan.engine });
  const collected = funded.status === "funded" ? await gage.run({ action: "collect" }, signer) : null;
  return { quote: quote.summary, listed, funded, collected };
}

/**
 * Advanced: one exact loan, `collateral` and `principal` raw, at the lowest cost the vaults funding it accept, or at the
 * borrower's own `costBps`. Whether the vaults fund it now, what each Loan grade costs, and the least they take.
 */
export async function exactQuote(gage: Gage, input: { token: string; collateral: string; principal: string; term: number; costBps?: number }) {
  const quote = await gage.borrowQuote(input);
  if (!("fundsNow" in quote)) throw new Error("An exact quote names collateral and principal");
  return {
    summary: quote.summary, costBps: quote.costBps, modelCostBps: quote.modelCostBps, grade: quote.grade, grades: quote.grades,
    fundsNow: quote.fundsNow, waitsFor: quote.waitsFor, lowestAcceptedCostBps: quote.lowestAcceptedCostBps, largestAccepted: quote.largestAccepted,
    prepare: quote.prepare,
  };
}

/**
 * A loop (leverage, USDG only): `own` of the token (raw) is pledged with what the loan buys of it in the same transaction,
 * `multiple` times `own` held in all, refused above the quote's cost when it is sent.
 */
export async function loop(gage: Gage, signer: Signer, token: string, own: string, multiple: number, term: number) {
  const quote = await gage.leverageQuote({ token, own, multiple, term, wallet: signer.address });
  const { action: _, ...terms } = quote.prepare;
  const looped = await gage.run({ action: "leverage", ...terms }, signer);
  // The most the purchase may cost, which the wallet approves first, in USDG.
  const most = "maxPurchaseCostUSDG" in quote ? quote.maxPurchaseCostUSDG : quote.maxPurchaseCost;
  return { quote: quote.summary, most, status: looped.status, loan: looped.loan };
}

/**
 * A refusal has a fixed code, fixed words, `retryable` and, for some, figures to act on in `details`: a pledge under the
 * token's minimum names the minimum, so the quote is asked again for it.
 */
export async function quoteAtLeastMinimum(gage: Gage, input: { token: string; maxCollateral: string; term: number }) {
  try {
    return await gage.borrowQuote(input);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "COLLATERAL_BELOW_MINIMUM") throw error;
    // `details.minimum`: the token, its symbol and decimals, and the least pledge, raw.
    const minimum = (error.details?.minimum as { raw?: string } | undefined)?.raw;
    if (minimum === undefined) throw error;
    return gage.borrowQuote({ ...input, maxCollateral: minimum });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.WALLET_KEY, [symbol, amount, days] = process.argv.slice(2);
  if (!key || !symbol || !amount) {
    console.error("Usage: WALLET_KEY=0x… npx tsx examples/borrow.ts <symbol> <amount> [days]");
    process.exit(1);
  }
  console.dir(await borrow(createGage(), privateKeySigner(key), symbol, amount, days ? Number(days) : 7), { depth: 4 });
}
