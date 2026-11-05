/**
 * LP vault shares (`gLP`) count the vault's own decimals: USDG's six plus its virtual-share offset, so one whole share,
 * 10^decimals of them raw, was worth one USDG when the vault opened. A vault opened since D331 has 18; one opened before
 * it (the testnet's first LP lane) keeps 12. They are read from the vault (`decimals()`), never assumed.
 */
import type { Address } from "viem";
import type { Chain } from "./chain.js";
import * as f from "./format.js";

/** A vault's share decimals and one whole share, raw. */
export async function lpShareUnit(chain: Pick<Chain, "lpShareDecimals">, vault: Address): Promise<{ decimals: number; one: bigint }> {
  const decimals = await chain.lpShareDecimals(vault);
  return { decimals, one: 10n ** BigInt(decimals) };
}

/** Shares as a summary writes them, in their vault's decimals, to four places. */
export const lpSharesText = (raw: bigint, decimals: number) => `${f.units(raw, decimals, 4)} share${raw === 10n ** BigInt(decimals) ? "" : "s"}`;
