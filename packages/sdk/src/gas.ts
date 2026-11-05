/**
 * The gas a call that claims sGAGE for each of a partner vault's open reward records needs, ported from the rule every
 * gage client sends with (shared/tx-gas.mjs; test/earnGas.test.ts holds the two to each other in gage's main repository).
 * Every deposit and redemption checkpoints the vault's whole book, and a settle each loan it books. Estimated in a second
 * in which no record has anything to claim (another checkpoint's second, or the second the records opened), the call
 * prices only the cheap path; mined a second later it takes the claim path and runs out of gas, or reverts
 * `RewardsPending` when an inner claim is starved (chaos finding 1, 26 September 2026; the estimate and a fifth failed
 * all 28 such calls of a mainnet fork, 21 October 2026). Unused gas is refunded: a larger limit only raises the balance
 * a wallet checks before it sends.
 */
import type { Address } from "viem";
import type { Chain } from "./chain.js";

export const TX_GAS = Object.freeze({
  /** Gas limit per open record on the claim path: about 217k-236k measured on the bridged r2 core. */
  recordClaimGas: 250_000n,
  /** Records opened between the count read and the block the transaction lands in. */
  recordSlack: 2n,
  /** IntentVault `MAX_OPEN_LOANS`: a count above it is a layout mismatch, not a count. */
  maxOpenRecords: 64n,
  /** ArbGasInfo's max transaction gas on 4663 and 46630, 32,000,000. */
  txGasCap: 32_000_000n,
  /** Room above the cap for the L1 part an Arbitrum chain's `eth_estimateGas` includes. */
  l1Allowance: 1_000_000n,
});

/**
 * Storage slot of `_openLoans._inner._values.length` per IntentVault mandate version (`forge inspect IntentVault
 * storageLayout`). Only verified versions are listed; any other version has no count, and its call is sized for a full
 * book. Version 12 keeps version 11's layout.
 */
export const INTENT_OPEN_RECORDS_SLOT: Readonly<Record<number, bigint>> = Object.freeze({ 11: 29n, 12: 29n, 13: 29n });

/**
 * The vault's open reward-record count at the head, or undefined for an unknown mandate version, a failed read, or a
 * value above the open-record cap (the layout is not the one this module knows).
 */
export async function openRecords(chain: Pick<Chain, "storageAt">, vault: Address, mandateVersion: number | undefined): Promise<bigint | undefined> {
  const slot = mandateVersion === undefined ? undefined : INTENT_OPEN_RECORDS_SLOT[mandateVersion];
  if (slot === undefined) return undefined;
  try {
    const value = await chain.storageAt(vault, slot);
    return value > TX_GAS.maxOpenRecords ? undefined : value;
  } catch {
    return undefined;
  }
}

/** The gas a step adds to its estimate for `records` open records and the slack; a count not read is a full book. */
export const recordGas = (records: bigint | undefined) => TX_GAS.recordClaimGas * ((records ?? TX_GAS.maxOpenRecords) + TX_GAS.recordSlack);

/** What a vault's deposit or redemption adds to its estimate: the floor for each of its open records (`recordGas`). */
export async function bookGas(chain: Pick<Chain, "storageAt">, vault: Address, mandateVersion: number | undefined): Promise<bigint> {
  return recordGas(await openRecords(chain, vault, mandateVersion));
}

/** A limit held to what the chain takes in one transaction and its L1 part, never under the estimate itself. */
export function capped(limit: bigint, estimate: bigint): bigint {
  const most = TX_GAS.txGasCap + TX_GAS.l1Allowance;
  const cap = estimate > most ? estimate : most;
  return limit < cap ? limit : cap;
}
