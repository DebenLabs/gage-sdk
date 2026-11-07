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
/** A cost in tenths of a basis point, to its last tenth: `bps` where it is whole basis points. */
export const bpsTenths = (tenths: number) => (tenths % 10 === 0 ? bps(tenths / 10) : `${(tenths / 1000).toFixed(3)}%`);
export const days = (seconds: number) => {
  const d = seconds / 86_400;
  if (Number.isInteger(d)) return `${d} day${d === 1 ? "" : "s"}`;
  const h = Math.round(seconds / 3600);
  return `${h} hour${h === 1 ? "" : "s"}`;
};
export const date = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A token's own symbol is data, never words: kept short and plain, else "" and the caller names it otherwise. */
export const plainSymbol = (symbol: string) => (/^[A-Za-z0-9.$_-]{1,16}$/.test(symbol) ? symbol : "");

/** What shows other than it reads, as the app's own rule has it (`nameHidesText`, shared/link-name.mjs). */
const HIDES_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * A name someone else wrote, as one line of plain text of at most `most` characters; "" where it hides text, which is no
 * name at all: a name is never cleaned into another's.
 */
export const plainName = (text: string, most: number) =>
  HIDES_TEXT.test(text.replace(/\uFE0F/gu, "")) ? "" : Array.from(text.replace(/\s+/gu, " ").trim()).slice(0, most).join("").trim();

/** Letters that read as the Latin ones the words below are spelled with, once NFKD has folded the rest. */
const LOOKALIKE: ReadonlyMap<string, string> = new Map(Object.entries({
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0441": "c", "\u0456": "i", "\u0442": "t", "\u043c": "m", "\u0501": "d", "\u050d": "g",
  "\u0261": "g", "\u0251": "a", "\u03b1": "a", "\u03b5": "e", "\u03bf": "o", "\u03b9": "i", "\u03c4": "t", "\u03bc": "m", "\u03bd": "v", "\u03c5": "u",
}));
const CLAIM_WORDS: ReadonlySet<string> = new Set(["official", "officially", "verified", "audited"]);
const BADGE_WORDS: ReadonlySet<string> = new Set(["team", "og"]);

/**
 * Whether a vault's name claims what only gage or a badge could say, as the app's own rule has it (`nameClaims`,
 * shared/link-name.mjs): a word that starts with gage's name, official, verified or audited, or a first word that reads as
 * a badge. Anyone can name a vault anything, so such a name is not repeated: this package holds no badges, and a vault's
 * manager is in each answer.
 */
export const nameClaims = (name: string): boolean => {
  const words = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/./gu, (letter) => LOOKALIKE.get(letter) ?? letter).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return BADGE_WORDS.has(words[0] ?? "") || words.some((word) => word.startsWith("gage") || CLAIM_WORDS.has(word));
};
