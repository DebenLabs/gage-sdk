/** One prepare answer: the summary, the next unsigned transaction (simulated), what follows it, and a review link. */
import type { Address } from "viem";
import { capped } from "./gas.js";
import { plan, rateNote, type Ctx, type Summary, type View } from "./plans.js";
import type { Preview } from "./preview.js";
import type { ActionInput } from "./schemas.js";

export interface NextTx {
  label: string;
  kind: "approve" | "action";
  final: boolean;
  /**
   * `gas` is the simulation's estimate, to which a wallet adds its own headroom. A partner vault's settle, deposit or
   * redemption also carries 250,000 for each loan it books or open reward record it claims for, and two more
   * (src/gas.ts): an estimate taken while the records have nothing to claim does not see what claiming costs. A client
   * that sizes such a call from an estimate of its own adds that floor to it, as gage.cash's review page does.
   */
  transaction: { from: Address; to: Address; data: `0x${string}`; value: string; chainId: number; gas: string };
}
/**
 * One transaction of an action whose transactions go together (park and unpark, D334): unsigned, its gas the wallet's to
 * price. `extraGas`: what a client sending it on its own adds to its estimate, "0" for most (see `NextTx`).
 */
export interface BatchTx { label: string; kind: "approve" | "action"; final: boolean; extraGas: string; transaction: { from: Address; to: Address; data: `0x${string}`; value: string; chainId: number } }
export interface Prepared {
  action: ActionInput["action"];
  wallet: Address;
  /** `partial`: nothing to send from what was read, but part of it did not answer, so `notes` name what to ask again. */
  status: "approval_required" | "ready" | "done" | "partial";
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
  /**
   * Every transaction of an action whose transactions go together (park and unpark, D334), `next` first, built from one
   * reading of the chain: send them in order, each once the one before is mined, or as one batch (EIP-5792), and do not
   * prepare again between them.
   */
  calls?: BatchTx[];
  /**
   * What the action does for the wallet over time, as raw amounts and a few words to draw in your own design, or as
   * gage's card (`renderPreview`, gage-sdk/visual): on the actions that pay out over time, a rehypo pool's exit now today.
   */
  preview?: Preview;
}

export async function prepareNext(c: Ctx, input: ActionInput): Promise<Prepared> {
  const wallet = input.wallet as Address;
  const p = await plan(c, input);
  const [first, ...rest] = p.steps;
  let next: NextTx | null = null;
  if (first) {
    const t = await first.build();
    const estimate = await c.chain.simulate({ from: wallet, ...t });
    const gas = capped(estimate + (first.extraGas ?? 0n), estimate);
    next = { label: first.label, kind: first.kind, final: first.final, transaction: { from: wallet, to: t.to, data: t.data, value: t.value.toString(), chainId: c.d.chainId, gas: gas.toString() } };
  }
  // The action's last transaction may carry the line that a rating of gage is open (D302); steps that come first never do.
  const rate = next?.kind === "action" && !rest.length && !p.again ? rateNote(c, input.action) : null;
  // A batch's every transaction, built now: planned again after its first, it would read a state half changed.
  const calls = p.batch && first ? await Promise.all(p.steps.map(async (s): Promise<BatchTx> => {
    const t = await s.build();
    return { label: s.label, kind: s.kind, final: s.final, extraGas: (s.extraGas ?? 0n).toString(), transaction: { from: wallet, to: t.to, data: t.data, value: t.value.toString(), chainId: c.d.chainId } };
  })) : null;
  return {
    action: input.action, wallet, status: !next ? (p.partial ? "partial" : "done") : next.kind === "approve" ? "approval_required" : "ready",
    summary: p.summary, view: p.view, next, then: rest.map((s) => s.label), notes: rate ? [...p.notes, rate] : p.notes,
    ...(p.again && next ? { again: true as const } : {}),
    ...(calls ? { calls } : {}),
    ...(p.preview ? { preview: p.preview } : {}),
  };
}
