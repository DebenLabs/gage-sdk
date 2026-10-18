/**
 * An action carried out by the agent's own signer (D224). It is planned once, from the chain and gage's own services, as a
 * prepare is. Then each step is built, simulated at the head and sent in order, and each one is mined before the next.
 * Every approval is for the exact amount, and the one-time action (a listing, a loop, a deposit, a redemption) is sent
 * once. A refusal before any step is planned throws. Once a plan exists, the answer says what was sent and, if the run
 * stopped early, why, in fixed words (D221). Under a spend limit (D297), the plan is shown to the limit before anything is
 * sent, and the limit is told at the end whether the action itself went out.
 */
import type { Address, Hex } from "viem";
import { ApiError, refusalOf, requireThat } from "./errors.js";
import { plan, rateNote, type Ctx, type Made, type Step, type Summary, type Tx, type View } from "./plans.js";
import type { ActionInput } from "./schemas.js";
import type { Signer } from "./signer.js";

export interface SentStep {
  label: string;
  kind: "approve" | "action";
  hash: Hex;
  /** pending: sent, but not mined within two minutes; look it up by hash before acting again. */
  outcome: "succeeded" | "reverted" | "pending";
}
export interface RunResult {
  action: ActionInput["action"];
  wallet: Address;
  /** done: every step succeeded. nothing_to_do: the plan had no step. stopped: see `error`; the steps in `sent` stand. */
  status: "done" | "nothing_to_do" | "stopped";
  summary: Summary;
  notes: string[];
  sent: SentStep[];
  /** The steps never sent, by label; a step whose send may have gone out (`SEND_UNKNOWN`) is in neither list. */
  unsent: string[];
  error: { code: string; message: string; retryable: boolean } | null;
  /**
   * The loan the action opened, read from its own receipt: a borrow's listing (funded later by the partner vaults:
   * `waitForFill`), a loop's loan, a roll's new loan. Null for any other action, or when the receipt cannot be read.
   */
  loan: Made | null;
}
/** What a spend limit holds for one run (D297), until the run ends. */
export interface Hold {
  /**
   * `sent`: the action itself (the step sent once: a listing, a loop, a deposit) was handed to the signer and did not
   * revert, so its amount stays counted; also when its outcome is unknown. Otherwise it may be given back.
   */
  release(sent: boolean): void | Promise<void>;
}
/** A spend limit (D297): asked with an action's plan before any step is sent; it throws to refuse, or holds the amount. */
export type SpendLimit = (view: View) => Hold | Promise<Hold>;

export interface RunOptions {
  /** Called as each sent step settles, for progress. */
  onStep?: (step: SentStep) => void;
  /** How the run waits before simulating a step again (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  /** The spend limit this run is carried out under (D297): a refusal is thrown, and nothing is sent. */
  limit?: SpendLimit;
}

/** Gas above the estimate, as wallets add it, and what a step adds for a call whose estimate runs short. */
const headroom = (gas: bigint, step?: Step) => (gas * 12n) / 10n + (step?.extraGas ?? 0n);
/** How many times a plan whose steps come first is planned again (a vault's settle, then the deposit). */
const REPLANS = 2;
/**
 * A step right after a mined one is built and simulated up to three times, two seconds apart: an RPC node can trail by
 * a block, and building a loop simulates its purchase's sources too.
 */
const ATTEMPTS = 3;
const RETRY_MS = 2_000;

/**
 * Whether the wallet's nonce moved past `before`, read up to ATTEMPTS times, RETRY_MS apart, as a node can trail the
 * network that took a transaction. A nonce that cannot be read counts as moved: nothing then says nothing went out.
 */
async function moved(c: Ctx, wallet: Address, before: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try { if (await c.chain.nonce(wallet) > before) return true; } catch { return true; }
    if (attempt >= ATTEMPTS) return false;
    await sleep(RETRY_MS);
  }
}

async function ready(c: Ctx, step: Step, from: Address, afterSend: boolean, sleep: (ms: number) => Promise<void>): Promise<{ tx: Tx; gas: bigint }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const tx = await step.build();
      return { tx, gas: await c.chain.simulate({ from, ...tx }) };
    } catch (error) {
      const lagging = afterSend && error instanceof ApiError && error.code === "SIMULATION_FAILED";
      if (!lagging || attempt >= ATTEMPTS) throw error;
      await sleep(RETRY_MS);
    }
  }
}

export async function run(c: Ctx, input: ActionInput, signer: Signer, options: RunOptions = {}): Promise<RunResult> {
  const wallet = input.wallet as Address;
  requireThat(wallet.toLowerCase() === signer.address.toLowerCase(), "WALLET_MISMATCH", "The signer is not the wallet this action is for", 400);
  let p = await plan(c, input);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sent: SentStep[] = [];
  let loan: Made | null = null;
  // The steps of the plan being sent, from `from` in `sent` (a plan planned again starts its own count).
  let from = 0;
  // Once every step went through, the answer may carry the line that a rating of gage is open (D302).
  const rate = rateNote(c, input.action);
  // A step whose send failed after the wallet's nonce moved: it may have gone out, so it is not offered as unsent.
  let doubtful = false;
  const answer = (status: RunResult["status"], error: RunResult["error"] = null): RunResult => ({
    action: input.action, wallet, status, summary: p.summary, notes: status === "done" && rate ? [...p.notes, rate] : p.notes, sent,
    unsent: p.steps.slice(sent.length - from + (doubtful ? 1 : 0)).map((s) => s.label), error, loan,
  });
  if (!p.steps.length) return answer("nothing_to_do");
  const hold = options.limit ? await options.limit(p.view) : null;
  // Whether the action itself went out: from the moment it is handed to the signer, unless the chain says it reverted.
  let spent = false;
  // One step: built, simulated and sent, then waited for; a RunResult when the run stops there.
  const send = async (step: Step): Promise<RunResult | null> => {
    let hash: Hex;
    try {
      const { tx, gas } = await ready(c, step, wallet, sent.length > 0, sleep);
      const nonce = await c.chain.nonce(wallet);
      try {
        if (step.final) spent = true;
        hash = await signer.sendTransaction({ ...tx, gas: headroom(gas, step), chainId: c.d.chainId });
      } catch (error) {
        // The signer's own message can carry its RPC's URL; the agent gets fixed words, the caller the cause (D221).
        // Whether it went out is the wallet's nonce's to say: a signer can fail after the network took the transaction (a
        // gateway's 502, a timeout), and sending it again would open a second listing, loop or deposit (the audit of
        // 18 October 2026). An account contract's nonce does not move: such a wallet is answered as before.
        if (await moved(c, wallet, nonce, sleep)) {
          doubtful = true;
          throw new ApiError("SEND_UNKNOWN", "The signer failed after the wallet sent a transaction, which may be this one; look up the wallet's latest transaction before sending it again", 502, false, { cause: error });
        }
        throw new ApiError("SEND_FAILED", "The signer did not send the transaction; check its ETH for gas and its network", 502, true, { cause: error });
      }
    } catch (error) {
      return answer("stopped", refusalOf(error));
    }
    const mined = await c.chain.wait(hash);
    const done: SentStep = { label: step.label, kind: step.kind, hash, outcome: mined === null ? "pending" : mined ? "succeeded" : "reverted" };
    sent.push(done);
    options.onStep?.(done);
    if (mined === null) return answer("stopped", { code: "TX_PENDING", message: "A transaction was sent but is not mined yet; look it up by hash before acting again", retryable: false });
    if (!mined) {
      if (step.final) spent = false;
      return answer("stopped", { code: "TX_FAILED", message: "The transaction reverted on chain, or another of the wallet's took its place", retryable: false });
    }
    if (step.final && p.made) {
      const receipt = await c.chain.sent(hash);
      loan = receipt ? p.made(receipt.logs) : null;
    }
    return null;
  };
  try {
    for (let replans = 0; ; replans += 1) {
      for (const step of p.steps) {
        const stopped = await send(step);
        if (stopped) return stopped;
      }
      if (!p.again) return answer("done");
      // The steps that had to come first are mined: the action is planned again from the chain, and its own steps sent.
      if (replans >= REPLANS) return answer("stopped", { code: "SETTLEMENT_DUE", message: "The vault still has a loan to settle; try again shortly", retryable: true });
      try { p = await plan(c, input); } catch (error) { return answer("stopped", refusalOf(error)); }
      from = sent.length;
      if (!p.steps.length) return answer("done");
    }
  } finally {
    await hold?.release(spent);
  }
}
