/**
 * Waiting for a listing to be funded. A borrow lists the loan; gage's keeper funds it from the partner vaults on its next
 * pass, in seconds when a vault has the room, later when one must free some (the listing stays open until its funding
 * deadline). Once funded, the loan's payout is the wallet's credit on the core, which `collect` sends to the wallet.
 */
import type { Address } from "viem";
import { loanRecord, stateName } from "./data.js";
import { engineOf } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import type { Ctx } from "./plans.js";

export type FillOutcome =
  /** Funded: the term runs from `fundedAt` to `endsAt`, and `receive` (the principal less the fee) is the wallet's credit. */
  | { status: "funded"; engine: Address; loanId: string; fundedAt: number; endsAt: number; receive: string }
  /** Still waiting for funding when the wait ended; it stays open to the vaults until `fundingDeadline`. */
  | { status: "waiting"; engine: Address; loanId: string; fundingDeadline: number | null }
  /** Its funding window passed unfunded, or it was cancelled: `collect` takes the collateral back. */
  | { status: "expired" | "cancelled"; engine: Address; loanId: string }
  /** Funded and closed already: repaid, or kept by its lenders. */
  | { status: "closed"; engine: Address; loanId: string; state: string };

export interface WaitOptions {
  /** How long to wait, in seconds: five minutes when omitted. */
  timeoutSeconds?: number;
  /** How often to look, in seconds: every ten when omitted, as the app does. */
  pollSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForFill(c: Ctx, i: { loanId: string; engine?: string | undefined }, o: WaitOptions = {}): Promise<FillOutcome> {
  const engine = i.engine ? engineOf(c.d, i.engine) : c.d.core;
  requireThat(engine, "UNKNOWN_ENGINE", "This engine is not gage's", 404);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const poll = Math.max(1, o.pollSeconds ?? 10), tries = Math.max(1, Math.ceil((o.timeoutSeconds ?? 300) / poll));
  const id = BigInt(i.loanId), at = { engine: engine.engine, loanId: i.loanId };
  // A loan the private lane may have opened is never served (D209): the index must show it public first, which a
  // listing a few seconds old it may not yet, and the chain bear it out (M7).
  let indexed = false;
  for (let n = 1; ; n += 1) {
    if (!indexed) {
      try { await loanRecord(c, engine.engine, i.loanId); indexed = true; } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") throw error;
      }
    }
    if (indexed) {
      const l = await c.chain.loan(engine.engine, id);
      if (l.state === 2) return { status: "funded", ...at, fundedAt: l.fundedAt, endsAt: l.fundedAt + l.term, receive: (l.principal - l.originationFee).toString() };
      if (l.state === 5) return { status: "cancelled", ...at };
      if (l.state !== 1) return { status: "closed", ...at, state: stateName(l.state) };
      if (c.now() >= l.fundingDeadline) return { status: "expired", ...at };
      if (n >= tries) return { status: "waiting", ...at, fundingDeadline: l.fundingDeadline };
    } else if (n >= tries) return { status: "waiting", ...at, fundingDeadline: null };
    await sleep(poll * 1000);
  }
}
