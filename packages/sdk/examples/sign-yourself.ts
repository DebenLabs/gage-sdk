/**
 * Signing each step yourself, as a browser wallet or a custody API does: `prepare` returns the next unsigned transaction,
 * simulated now; the wallet signs and sends it; once it is mined, prepare again, until nothing is left. gage signs nothing
 * and never sees a key. Here the wallet is any `{ sendTransaction, waitForReceipt }` pair; with viem, a wallet client
 * on `robinhoodMainnet` and a public client on the same chain.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/sign-yourself.ts <wallet>   (prints the first step)
 */
import { pathToFileURL } from "node:url";
import { createGage, type Gage, type NextTx } from "gage-sdk";

/** Sends one unsigned transaction and waits for it: the parts of a wallet this loop needs. */
export interface Wallet {
  sendTransaction(tx: NextTx["transaction"]): Promise<`0x${string}`>;
  /** Resolves once the transaction is mined, with whether it succeeded. */
  waitForReceipt(hash: `0x${string}`): Promise<{ status: "success" | "reverted" }>;
}

/**
 * Carries an action out step by step: prepare, sign and send `next`, wait, prepare again. It stops once the action's own
 * transaction (`next.final`, with no `again`) is mined, when nothing is left, or at a revert. Never send an answer's
 * `next` twice: prepare again instead.
 */
export async function signYourself(gage: Gage, wallet: Wallet, input: { action: string; wallet: string } & Record<string, unknown>, most = 6) {
  const sent: { label: string; hash: string }[] = [];
  for (let step = 0; step < most; step += 1) {
    const plan = await gage.prepare(input);
    if (plan.status === "done" || !plan.next) return { status: "done" as const, sent, summary: plan.summary };
    // Park and unpark answer every call at once, from one reading of the chain: send those together (examples/park.ts).
    if (plan.calls) throw new Error("This action's calls go together: send plan.calls in order, without preparing again");
    const hash = await wallet.sendTransaction(plan.next.transaction);
    sent.push({ label: plan.next.label, hash });
    const receipt = await wallet.waitForReceipt(hash);
    if (receipt.status !== "success") return { status: "reverted" as const, sent, summary: plan.summary };
    // The action itself went out: preparing again would plan it a second time.
    if (plan.next.final && !plan.again) return { status: "done" as const, sent, summary: plan.summary };
  }
  return { status: "stopped" as const, sent, summary: null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [wallet] = process.argv.slice(2);
  if (!wallet) {
    console.error("Usage: npx tsx examples/sign-yourself.ts <wallet>");
    process.exit(1);
  }
  // What a wallet would be asked to sign first to collect what is ready for it.
  const plan = await createGage().prepare({ action: "collect", wallet });
  console.dir({ status: plan.status, summary: plan.summary, next: plan.next, then: plan.then }, { depth: 4 });
}
