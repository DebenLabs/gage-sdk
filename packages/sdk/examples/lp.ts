/**
 * The LP lane, carried out with your own key: a fixed-cost USDG loan against a liquidity position (Uniswap v3 or v4,
 * SushiSwap v3, Ramses or Fables), with no liquidation: the loan is never closed early because a price moves, and a loan
 * not repaid by its end is settled by unwinding the position for its lenders, nothing else taken. Lending to it is a
 * deposit into an LP vault. Served where the release makes the lane public. Mainnet by default, so this moves real money.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`:
 *   npx tsx examples/lp.ts <wallet>                    the wallet's positions and the LP vaults, signing nothing
 *   WALLET_KEY=0x… npx tsx examples/lp.ts <wallet> borrow
 */
import { pathToFileURL } from "node:url";
import { createGage, privateKeySigner, type Gage, type Signer } from "gage-sdk";

/**
 * The wallet's positions the lane takes now (and Fables receipts not wrapped yet), with the LP vaults and the lane's
 * terms. Where the lane is not public, the lane's reads refuse (`LP_CLOSED`).
 */
export async function lpOverview(gage: Gage, wallet: string) {
  const [{ lpLane }, positions, { vaults }] = await Promise.all([gage.capabilities(), gage.lpPositions(wallet), gage.lpVaults()]);
  return {
    terms: (lpLane?.terms ?? []).map((t) => t.seconds),
    borrowable: positions.positions.filter((p) => p.borrowable).map((p) => ({ adapter: p.adapter, tokenId: p.tokenId, pool: p.poolName })),
    refused: positions.positions.filter((p) => !p.borrowable).map((p) => ({ tokenId: p.tokenId, refusal: p.refusal })),
    fablesReceipts: positions.fablesReceipts ?? [],
    vaults: vaults.map((v) => ({ vault: v.vault, name: v.name, takesDeposits: v.takesDeposits })),
  };
}

/** Borrows against the wallet's first position the lane takes, over the lane's shortest term, at its quoted cost. */
export async function borrowAgainstPosition(gage: Gage, signer: Signer) {
  const overview = await lpOverview(gage, signer.address);
  const position = overview.borrowable[0], term = overview.terms[0];
  if (!position || term === undefined) throw new Error("No position this wallet holds is one the LP lane takes now");
  // Signed for this wallet for five minutes at most: borrow soon after quoting.
  const quote = await gage.lpQuote({ adapter: position.adapter, tokenId: position.tokenId, wallet: signer.address, term });
  const { action: _, ...loan } = quote.prepare;
  const borrowed = await gage.run({ action: "lp_borrow", ...loan }, signer);
  return { quote: quote.summary, status: borrowed.status, loan: borrowed.loan, error: borrowed.error };
}

/** Repays an LP loan in full before its end and takes the position back. */
export const repayLpLoan = (gage: Gage, signer: Signer, loanId: string) => gage.run({ action: "lp_repay", loanId }, signer);

/** Lends to the lane: a USDG deposit (raw, 6 decimals) into the first LP vault that takes deposits now. */
export async function lendToLpVault(gage: Gage, signer: Signer, amount: string) {
  const { vaults } = await gage.lpVaults();
  const vault = vaults.find((v) => v.takesDeposits);
  if (!vault) throw new Error("No LP vault takes deposits now");
  return gage.run({ action: "lp_deposit", vault: vault.vault, amount }, signer);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [wallet, go] = process.argv.slice(2), key = process.env.WALLET_KEY;
  if (!wallet) {
    console.error("Usage: npx tsx examples/lp.ts <wallet> [borrow]");
    process.exit(1);
  }
  const gage = createGage();
  console.dir(await lpOverview(gage, wallet), { depth: 4 });
  if (go === "borrow") {
    if (!key) throw new Error("WALLET_KEY is needed to borrow");
    console.dir(await borrowAgainstPosition(gage, privateKeySigner(key)), { depth: 4 });
  }
}
