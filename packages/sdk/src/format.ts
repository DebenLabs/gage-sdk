/** Amounts and times in the words a review card shows; every figure is computed here, never taken from a caller. */

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A raw amount with `decimals`, cut (never rounded up) to `places`, trailing zeros kept to `keep`. */
export function units(raw: bigint, decimals: number, places: number, keep = 0): string {
  const negative = raw < 0n, v = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  let frac = (v % scale).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  if (frac.length < keep) frac = frac.padEnd(keep, "0");
  return `${negative ? "-" : ""}${group(whole.toString())}${frac ? `.${frac}` : ""}`;
}

/** USDG has six decimals; a sliver under a cent reads in its own first digits, never as 0.00. */
export const usdg = (raw: bigint) => `${raw > 0n && raw < 10_000n ? units(raw, 6, 6) : units(raw, 6, 2, 2)} USDG`;
/** What is owed, rounded up to the cent: a review never shows less than the wallet will pay. */
export const owed = (raw: bigint) => usdg(((raw + 9_999n) / 10_000n) * 10_000n);

/** A lend asset as amounts are written in it (D251): its symbol and decimals, and whether it reads as money. */
export interface Unit { symbol: string; decimals: number; stable: boolean }
/** The places an amount of `a` is written to: a stablecoin's cents, another asset's own places up to six. */
const placesOf = (a: Unit) => (a.stable ? 2 : Math.min(a.decimals, 6));
/**
 * An amount of a lend asset, cut (never rounded up): USDG exactly as `usdg`; a stablecoin in cents; another asset to
 * six places at most (`0.495 GLDx`). A sliver under its last place reads in its own digits, never as none.
 */
export function money(raw: bigint, a: Unit): string {
  if (a.symbol === "USDG" && a.decimals === 6) return usdg(raw);
  const places = placesOf(a);
  const sliver = raw > 0n && raw < 10n ** BigInt(a.decimals - places);
  return `${sliver ? units(raw, a.decimals, a.decimals) : units(raw, a.decimals, places, a.stable ? 2 : 0)} ${a.symbol}`;
}
/** What is owed in a lend asset, rounded up at its last place shown: never less than the wallet will pay. */
export function owedIn(raw: bigint, a: Unit): string {
  if (a.symbol === "USDG" && a.decimals === 6) return owed(raw);
  const step = 10n ** BigInt(a.decimals - placesOf(a));
  return money(((raw + step - 1n) / step) * step, a);
}
export const token = (raw: bigint, decimals: number, symbol: string) => `${units(raw, decimals, 4)} ${symbol}`;
/** A least amount of a token, rounded up at its last place shown: "at least" then never reads under what is needed. */
export const tokenUp = (raw: bigint, decimals: number, symbol: string) => {
  const step = 10n ** BigInt(Math.max(0, decimals - 4));
  return token(((raw + step - 1n) / step) * step, decimals, symbol);
};
export const shares = (raw: bigint) => `${units(raw, 18, 4)} share${raw === 10n ** 18n ? "" : "s"}`;
export const bps = (value: number) => `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
export const days = (seconds: number) => {
  const d = seconds / 86_400;
  return Number.isInteger(d) ? `${d} day${d === 1 ? "" : "s"}` : `${(seconds / 3600).toFixed(0)} hours`;
};
export const date = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
