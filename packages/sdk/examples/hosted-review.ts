/**
 * gage's hosted agent service (Steward): no key anywhere. Your agent asks it to prepare an action over HTTP (or the same
 * tools over MCP at https://mcp.gage.cash/mcp), and hands the wallet's owner the review link it answers with; the owner
 * checks each step on gage.cash and signs it in their own wallet. It prepares borrow, leverage, cancel, reclaim,
 * earn_deposit, earn_redeem, collect and feedback; gage-sdk and gage-mcp carry out the rest. No SDK is needed: any HTTP
 * client will do.
 *
 * Run from packages/sdk: npx tsx examples/hosted-review.ts <wallet>   (prepares a collect and prints its review link)
 */
import { pathToFileURL } from "node:url";

export const HOSTED = "https://mcp.gage.cash";

/** Prepares `input` (`{ action, wallet, … }`, the shape `gage.prepare` takes) and returns its summary and review link. */
export async function prepareForReview(input: { action: string; wallet: string } & Record<string, unknown>, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${HOSTED}/v1/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = (await response.json()) as { error?: { code: string; message: string; retryable: boolean }; status?: string; summary?: { title: string }; review?: { url: string; expiresAt: number } | null };
  // Refusals come with a fixed code and fixed words, as the SDK's ApiError does.
  if (!response.ok || body.error) throw new Error(`${body.error?.code ?? response.status}: ${body.error?.message ?? "refused"}`);
  // A review link opens gage.cash/review for 30 minutes, planned again from the chain each time it is opened.
  return { status: body.status, title: body.summary?.title, review: body.review?.url ?? null, expiresAt: body.review?.expiresAt ?? null };
}

/** The same reads the SDK makes, over HTTP: what gage takes as collateral now. */
export async function hostedAssets(fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${HOSTED}/v1/assets`);
  if (!response.ok) throw new Error(`The hosted service answered ${response.status}`);
  return (await response.json()) as { assets: { symbol: string; token: string; minAmount: string }[] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [wallet] = process.argv.slice(2);
  if (!wallet) {
    console.error("Usage: npx tsx examples/hosted-review.ts <wallet>");
    process.exit(1);
  }
  console.log(await prepareForReview({ action: "collect", wallet }));
}
