/**
 * A Safe{Wallet} Transaction Builder batch, ported from gage's own release tool (scripts/lib/release/safe-batch.mjs):
 * version "1.0", the chain id as a string, meta.createdFromSafeAddress, raw calldata with contractMethod null, and the
 * Transaction Builder's own checksum, which Safe{Wallet} verifies when the file is loaded. gage never proposes to a Safe:
 * a Safe's owners load the file, check each call and sign there.
 */
import { getAddress, isAddress, keccak256, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import { requireThat } from "./errors.js";

/** The Transaction Builder version gage's batches name. */
export const TX_BUILDER_VERSION = "1.17.0";

export interface SafeBatch {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: string;
    createdFromSafeAddress: Address;
    createdFromOwnerAddress: string;
    checksum?: Hex;
  };
  transactions: { to: Address; value: "0"; data: Hex; contractMethod: null; contractInputsValues: null }[];
}

/** The Transaction Builder's canonical serialisation (safe-react-apps tx-builder, lib/checksum.ts). */
function serialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${JSON.stringify(keys)}${keys.map((key) => `${serialize((value as Record<string, unknown>)[key])},`).join("")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The checksum Safe{Wallet} verifies: over the batch without its checksum, with the name blanked. */
export function batchChecksum(batch: SafeBatch): Hex {
  const meta: Partial<SafeBatch["meta"]> = { ...batch.meta };
  delete meta.checksum;
  return keccak256(stringToHex(serialize({ ...batch, meta: { ...meta, name: null } })));
}

/** A Transaction Builder batch of `calls` from `safe` on `chainId`; every call is non-payable. */
export function safeBatch(input: { chainId: number; safe: Address; name: string; description: string; calls: readonly { to: Address; data: Hex }[]; createdAt?: number }): SafeBatch {
  requireThat(isAddress(input.safe) && input.safe.toLowerCase() !== zeroAddress, "INVALID_INPUT", "A Safe batch needs the Safe's address", 400);
  requireThat(input.calls.length > 0, "INVALID_INPUT", "A Safe batch needs a call", 400);
  const batch: SafeBatch = {
    version: "1.0",
    chainId: String(input.chainId),
    createdAt: input.createdAt ?? Date.now(),
    meta: { name: input.name, description: input.description, txBuilderVersion: TX_BUILDER_VERSION, createdFromSafeAddress: getAddress(input.safe), createdFromOwnerAddress: "" },
    transactions: input.calls.map((call) => ({ to: getAddress(call.to), value: "0", data: call.data.toLowerCase() as Hex, contractMethod: null, contractInputsValues: null })),
  };
  batch.meta.checksum = batchChecksum(batch);
  return batch;
}
