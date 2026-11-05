/**
 * A plan's preview: what an action that pays out over time does for the wallet, as raw amounts and a few words, so a
 * partner draws it in its own design or shows gage's card for it (`renderPreview`, gage-sdk/visual). An exit now carries
 * one: a partner vault's (Intent D57) and a rehypo pool's (root D357).
 */
import type { Address } from "viem";

/** One moment of the action, in order: `at` seconds after the wallet sends it, and in a few words when and what. */
export interface PreviewStep { at: number; when: string; what: string }

/**
 * An exit now: what the wallet receives (raw, in `asset`), of it what can be paid now, about what it gives up (its share
 * of what the vault's loans have still to earn, if they are repaid; null while the index cannot say), and its steps.
 */
export interface ExitPreview {
  kind: "exit_now";
  asset: { token: Address; symbol: string; decimals: number; stable: boolean };
  receive: string;
  now: string;
  giveUp: string | null;
  steps: PreviewStep[];
}

export type Preview = ExitPreview;

/** A span in the few characters a step's `when` has: "10 min", "1 h", "24 h", "2 d"; a day in hours, as the app counts an exit's request. */
export function span(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds <= 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}
