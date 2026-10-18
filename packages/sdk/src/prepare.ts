/** One prepare answer: the summary, the next unsigned transaction (simulated), what follows it, and a review link. */
import type { Address } from "viem";
import { plan, rateNote, type Ctx, type Summary, type View } from "./plans.js";
import type { ActionInput } from "./schemas.js";

export interface NextTx {
  label: string;
  kind: "approve" | "action";
  final: boolean;
  transaction: { from: Address; to: Address; data: `0x${string}`; value: string; chainId: number; gas: string };
}
export interface Prepared {
  action: ActionInput["action"];
  wallet: Address;
  status: "approval_required" | "ready" | "done";
  summary: Summary;
  /** The figures the review page draws; an agent reads `summary`. */
  view: View;
  next: NextTx | null;
  then: string[];
  notes: string[];
  /**
   * The steps come first and the action itself is prepared again once they are mined (a vault's settle before a deposit
   * or a withdrawal): `next` is then not the action's last transaction, though nothing follows it in `then`.
   */
  again?: true;
}

export async function prepareNext(c: Ctx, input: ActionInput): Promise<Prepared> {
  const wallet = input.wallet as Address;
  const p = await plan(c, input);
  const [first, ...rest] = p.steps;
  let next: NextTx | null = null;
  if (first) {
    const t = await first.build();
    const gas = (await c.chain.simulate({ from: wallet, ...t })) + (first.extraGas ?? 0n);
    next = { label: first.label, kind: first.kind, final: first.final, transaction: { from: wallet, to: t.to, data: t.data, value: t.value.toString(), chainId: c.d.chainId, gas: gas.toString() } };
  }
  // The action's last transaction may carry the line that a rating of gage is open (D302); steps that come first never do.
  const rate = next?.kind === "action" && !rest.length && !p.again ? rateNote(c, input.action) : null;
  return {
    action: input.action, wallet, status: !next ? "done" : next.kind === "approve" ? "approval_required" : "ready",
    summary: p.summary, view: p.view, next, then: rest.map((s) => s.label), notes: rate ? [...p.notes, rate] : p.notes,
    ...(p.again && next ? { again: true as const } : {}),
  };
}
