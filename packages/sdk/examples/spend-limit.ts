/**
 * A spend limit of your own, for an agent that signs with its own key: asked with each action's plan before anything is
 * sent, it refuses by throwing, or holds the amount until the run ends. This one counts USDG borrowed and deposited
 * against one ceiling an action and one for any 24 hours, kept in memory (gage-mcp keeps its holds as files, so restarts
 * and parallel servers share one count). Hand it to `run` or to `gageTools`.
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/spend-limit.ts   (prints the tools it guards)
 */
import { pathToFileURL } from "node:url";
import { ApiError, createGage, gageTools, type Gage, type Signer, type SpendLimit, type View } from "gage-sdk";

/**
 * The USDG an action's plan puts into a loan or a vault, raw (6 decimals), as gage-mcp counts it: a loan, a loop or an LP
 * loan its principal, a roll only what it borrows beyond the loan it repays, a deposit or a park its amount. Anything that
 * brings money back, and anything in another asset than USDG, counts 0.
 */
export function counted(view: View, usdg: string): bigint {
  const isUsdg = (asset?: { token: string }) => asset === undefined || asset.token.toLowerCase() === usdg.toLowerCase();
  switch (view.action) {
    case "borrow": case "leverage": return isUsdg(view.asset) ? BigInt(view.principal) : 0n;
    case "lp_borrow": return BigInt(view.principal);
    case "roll": { const more = BigInt(view.principal) - BigInt(view.oldPrincipal); return more > 0n && isUsdg(view.asset) ? more : 0n; }
    case "lp_roll": { const more = BigInt(view.principal) - BigInt(view.oldPrincipal); return more > 0n ? more : 0n; }
    case "earn_deposit": return isUsdg(view.asset) ? BigInt(view.amount) : 0n;
    case "lp_deposit": return BigInt(view.amount);
    case "park": return isUsdg({ token: view.token }) ? BigInt(view.amount) : 0n;
    default: return 0n;
  }
}

/** At most `each` raw USDG an action and `day` in any 24 hours; a hold is given back when the action never went out. */
export function usdgLimit(usdg: string, each: bigint, day: bigint, now = () => Date.now()): SpendLimit {
  const held: { at: number; amount: bigint }[] = [];
  return (view) => {
    const amount = counted(view, usdg);
    if (amount === 0n) return { release: () => undefined };
    if (amount > each) throw new ApiError("SPEND_LIMIT", "Over this agent's limit for one action", 403);
    const since = now() - 86_400_000, used = held.filter((h) => h.at > since).reduce((sum, h) => sum + h.amount, 0n);
    if (used + amount > day) throw new ApiError("SPEND_LIMIT_DAY", "Over this agent's limit for 24 hours", 403);
    const hold = { at: now(), amount };
    held.push(hold);
    return { release: (sent) => { if (!sent) held.splice(held.indexOf(hold), 1); } };
  };
}

/** The tools an agent framework gets for a signer under that limit: 100 USDG an action, 250 in any 24 hours. */
export function limitedTools(gage: Gage, signer: Signer) {
  const limit = usdgLimit(gage.deployment.usdg, 100_000_000n, 250_000_000n);
  return gageTools(gage, { signer, limit });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A watch-only signer: it shows which tools would sign, and refuses to send anything.
  const signer: Signer = { address: "0x0000000000000000000000000000000000000001", sendTransaction: () => Promise.reject(new Error("watch-only")) };
  console.log(limitedTools(createGage(), signer).filter((t) => t.annotations.destructiveHint).map((t) => t.name));
}
