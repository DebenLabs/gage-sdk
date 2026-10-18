/**
 * Short links (D290), ported from gage.cash's own rule (shared/link-name.mjs, web/src/borrow/tokenLinks.ts): a partner
 * vault's `<app>/v/<link>` and a token's `<app>/borrow/<link>`. A name becomes a link by keeping its letters and digits,
 * lower-case, with one dash between words. Claims are taken in order (a vault's creation, a token's place in the
 * release): the first to claim a link keeps it for good, and a later claim of the same link takes the first characters
 * of its own address after a dash, as few as leave it free. Vault links come from gage's indexer (`GET
 * /intent/partners/links`), which sees every creation; token links are computed here from the release, as the app does.
 */

/** The most characters a name gives a link, before any address suffix. */
export const LINK_MAX = 40;

/** Links no vault may take: the site's own words, and words that would pass for gage's own vault. */
export const VAULT_RESERVED: readonly string[] = Object.freeze([
  "admin", "borrow", "create", "earn", "gage", "help", "lend", "manage", "new", "official", "partner", "partners",
  "portfolio", "protocol", "support", "team", "vault", "vaults",
]);

/** Links no token may take: Borrow's own pages under `/borrow/`. */
export const TOKEN_RESERVED: readonly string[] = Object.freeze(["private", "zap"]);

/** A link that reads as an address or the start of one stays an address. */
const ADDRESS_LIKE = /^0x[0-9a-f]*$/;

/** A name as a link: accents dropped, letters and digits kept lower-case, one dash between runs; null when none is left. */
export function linkName(name: string | null | undefined): string | null {
  const plain = (name ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = plain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cut = words.slice(0, LINK_MAX).replace(/-+$/, "");
  return cut === "" ? null : cut;
}

/**
 * Each claim's link, keyed by its address in lower case. Claims come in the order they were made (`{ address, name }`);
 * an address keeps its first link, a name that gives no link gives none, and `reserved` links are never handed out.
 */
export function assignLinks(claims: readonly { address: string; name: string | null | undefined }[], reserved: readonly string[] = []): Map<string, string> {
  const taken = new Set(reserved.map((word) => word.toLowerCase()));
  const links = new Map<string, string>();
  for (const { address, name } of claims) {
    const key = address.toLowerCase();
    if (links.has(key)) continue;
    const base = linkName(name);
    if (base === null) continue;
    const hex = key.replace(/^0x/, "");
    let link = ADDRESS_LIKE.test(base) || taken.has(base) ? null : base;
    for (let n = 4; link === null && n <= hex.length; n += 2) {
      const candidate = `${base}-${hex.slice(0, n)}`;
      if (!taken.has(candidate)) link = candidate;
    }
    if (link === null) continue;
    taken.add(link);
    links.set(key, link);
  }
  return links;
}

/**
 * Each admitted token's Borrow link, by its address in lower case. `listed` is the release's tokens in its order (the
 * USDG engine's, then each public lend asset's own), `allowed` false for one the release lists as no longer admitted:
 * each token claims its ticker once, where it first appears, admitted or not, and only an admitted one is served, so a
 * token no screening admitted never gets a link, whatever its ticker.
 */
export function tokenLinks(listed: readonly { token: string; symbol: string; allowed: boolean }[]): Map<string, string> {
  const tokens: { token: string; symbol: string; allowed: boolean }[] = [];
  const seen = new Set<string>();
  for (const t of listed) {
    const key = t.token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ ...t, token: key });
  }
  const links = assignLinks(tokens.map((t) => ({ address: t.token, name: t.symbol })), TOKEN_RESERVED);
  return new Map(tokens.flatMap((t) => {
    const link = links.get(t.token);
    return t.allowed && link !== undefined ? [[t.token, link] as const] : [];
  }));
}
