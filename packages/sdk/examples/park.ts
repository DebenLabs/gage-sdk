/**
 * Park and unpark, from the LP's own wallet: an out-of-range position holds one token and earns no fees, so `park` pulls
 * it out on its own DEX and deposits that token into a partner vault, and `unpark` withdraws and opens a new position in
 * a range you pick. Each is one batch of calls (EIP-5792 `wallet_sendCalls`), simulated whole first; any wallet that sends
 * batches sends it (viem's `walletClient.sendCalls`, say). A DEX adds its own pools with `createGage({ parkPools })`.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/park.ts <wallet>   (lists, signing nothing)
 */
import { pathToFileURL } from "node:url";
import { createGage, type Gage, type ParkBatch } from "gage-sdk";

/**
 * Sends a batch for the wallet and resolves once it is mined: with viem,
 * `async (b) => { const { id } = await wallet.sendCalls(b); await wallet.waitForCallsStatus({ id }); }`.
 */
export type SendCalls = (batch: { calls: { to: `0x${string}`; data: `0x${string}`; value: bigint }[] }) => Promise<unknown>;

/** The wallet's out-of-range positions in the pools served, each with the one token it holds and the vaults that take it. */
export async function parkable(gage: Gage, wallet: string, also: { manager: string; id: string }[] = []) {
  const { positions } = await gage.parkPositions(wallet, also);
  return positions.map((p) => ({ manager: p.manager, id: p.id, pool: p.poolName, holds: p.holds, vaults: p.vaults, refusal: p.refusal }));
}

/**
 * Sends a park's or an unpark's batch. A vault with a loan past its end is settled first (`again`): that batch is the
 * settle, and the batch is asked for again once it is mined. A wallet that cannot send batches sends `calls` in order.
 */
async function sendBatch(ask: () => Promise<ParkBatch>, sendCalls: SendCalls) {
  for (let round = 0; round < 2; round += 1) {
    const batch = await ask();
    await sendCalls({ calls: batch.calls.map(({ to, data, value }) => ({ to, data, value })) });
    if (!batch.again) return { summary: batch.summary, calls: batch.calls.length };
  }
  throw new Error("The vault still has loans to settle: ask again shortly");
}

/** Parks the wallet's first parkable position into the first vault that takes what it holds (or `vault`), as one batch. */
export async function park(gage: Gage, wallet: string, sendCalls: SendCalls, vault?: string) {
  const position = (await parkable(gage, wallet)).find((p) => p.refusal === null && p.vaults.length > 0);
  if (!position) throw new Error("No out-of-range position of this wallet parks now");
  const into = vault ?? position.vaults[0]!.vault;
  return sendBatch(() => gage.parkCalls({ wallet, manager: position.manager, id: position.id, vault: into }), sendCalls);
}

/** Unparks `amount` (raw, or all the vault can pay now) from `vault` into [tickLower, tickUpper] of a pool served, as one batch. */
export function unpark(gage: Gage, wallet: string, sendCalls: SendCalls, at: { vault: string; manager: string; pool: string; tickLower: number; tickUpper: number; amount?: string }) {
  return sendBatch(() => gage.unparkCalls({ wallet, ...at }), sendCalls);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [wallet] = process.argv.slice(2);
  if (!wallet) {
    console.error("Usage: npx tsx examples/park.ts <wallet>");
    process.exit(1);
  }
  console.dir(await parkable(createGage(), wallet), { depth: 4 });
}
