/**
 * The indexer's answers the service reads (docs/api.md, Indexer and Intent partner strategies), private loans dropped:
 * the index must mark a loan public, and the chain bear it out (the audit of 18 October 2026, M7).
 */
import { z } from "zod";
import type { Address } from "viem";
import { privateRoutersOf, type Deployment, type Generation } from "./deployment.js";
import { ApiError } from "./errors.js";
import type { Ctx } from "./plans.js";
import type { Upstream } from "./upstream.js";

const digits = z.string().regex(/^\d{1,78}$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const position = z.object({
  engine: addr, id: digits,
  loan: z.object({
    originator: addr, account: addr, token: addr, collateralBeneficiary: addr, state: z.coerce.number().int(), filled: z.coerce.number().int(),
    term: z.coerce.number().int(), fundingDeadline: z.coerce.number().int(), fundedAt: z.coerce.number().int(), closedAt: z.coerce.number().int(),
    principal: digits, cap: digits, originationFee: digits, borrowerReward: digits, lenderReward: digits, collateral: digits,
  }).loose(),
  slots: z.array(addr),
  owner: addr.nullable().optional(),
  private: z.boolean().optional(),
}).loose();
export type Position = z.output<typeof position>;
const positionPage = z.object({ items: z.array(position), nextCursor: z.string().nullable() }).loose();

/**
 * A loan the private lane may have opened is never served (D209, D222): only `private: false` passes. A missing flag
 * means the indexer cannot tell yet, which counts as private.
 */
export const isPublic = (p: { private?: boolean | undefined }) => p.private === false;

/**
 * Which of `loans` the chain bears out as public, in their order (the audit of 18 October 2026, M7): the index's marker
 * alone once told a private loan, so a wrong or hostile index could have one served. Every loan of a core no private-lane
 * router lists on; on one a router does, only a loan none of them opened, every loan of that core asked in one read. A
 * loan the chain cannot say of, and one the index named no id for, stay private, as a loan the index cannot tell about
 * does. A read that fails says nothing of any loan, so it fails the call, retryable: left out instead, a wallet's loans
 * would read as none, and an agent could miss one it must repay before its term ends.
 */
export async function publicOnChain(c: Pick<Ctx, "d" | "chain">, loans: readonly { engine: Address; id: bigint | null }[]): Promise<boolean[]> {
  const shown = loans.map((l) => privateRoutersOf(c.d, l.engine).length === 0);
  const cores = new Map<string, { engine: Address; at: number[] }>();
  loans.forEach((l, i) => {
    if (shown[i] || l.id === null) return;
    const key = l.engine.toLowerCase();
    cores.set(key, { engine: l.engine, at: [...(cores.get(key)?.at ?? []), i] });
  });
  await Promise.all([...cores.values()].map(async ({ engine, at }) => {
    const opened = await c.chain.privateLoans(engine, privateRoutersOf(c.d, engine), at.map((i) => loans[i]!.id!));
    at.forEach((i, n) => { shown[i] = opened[n] === false; });
  }));
  return shown;
}

export const STATE = ["NONE", "FUNDING", "ACTIVE", "REPAID", "DEFAULTED", "CANCELLED"] as const;
export const stateName = (s: number) => STATE[s] ?? "UNKNOWN";

/** One loan from the index; a private one reads as unknown, and so does one the chain does not bear out as public (M7). */
export async function loanRecord(c: Pick<Ctx, "d" | "chain" | "indexer">, engine: Address, id: string): Promise<Position> {
  const p = await c.indexer.get(`/v2/positions/${engine.toLowerCase()}/${id}`, position);
  if (!isPublic(p) || !(await publicOnChain(c, [{ engine, id: BigInt(id) }]))[0]) throw new ApiError("NOT_FOUND", "gage has no record of that", 404);
  return p;
}

/** Rows a page of loans asks for, and the most one is read for. */
const PAGE = 100;

/**
 * Every loan the wallet takes part in on one engine (borrower, lender or holder of the reclaim right), newest first: each
 * one the index marks public and the chain bears out (M7).
 */
export async function walletLoans(c: Pick<Ctx, "d" | "chain" | "indexer">, engine: Address, wallet: Address, pages = 5): Promise<Position[]> {
  const out: Position[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < pages; n += 1) {
    const page: z.output<typeof positionPage> = await c.indexer.get(`/v2/positions?engine=${engine.toLowerCase()}&account=${wallet.toLowerCase()}&limit=${PAGE}${cursor ? `&cursor=${cursor}` : ""}`, positionPage);
    // No more rows than were asked for: an answer longer than its page is cut to it.
    out.push(...page.items.slice(0, PAGE).filter(isPublic));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const shown = await publicOnChain(c, out.map((p) => ({ engine, id: BigInt(p.id) })));
  return out.filter((_, i) => shown[i]);
}

const vault = z.object({
  address: addr, creator: addr, curator: addr, core: addr, categoryMask: z.number().int(), feeBps: z.number().int(), maxLoanTerm: z.number().int(),
  assets: z.array(addr), fundingEnabled: z.boolean(),
  /** Mandate version 12 (Intent D54): the name its manager gave it, display text only. Earlier vaults have none; one the
   * index answers malformed is read as none, so it never hides the vault. */
  name: z.string().optional().catch(undefined),
}).loose();
export type PartnerVault = z.output<typeof vault>;
/** Rows a page of partner vaults asks for, and the most one is read for. */
const VAULT_PAGE = 50;
const vaultPage = z.object({ items: z.array(vault), nextCursor: z.string().nullable() }).loose();

/**
 * Every partner vault of a generation's factory, on its core only: the USDG generation's by default. A lend-asset
 * generation's are asked by its factory (`factory=`, docs/api.md "Lend-asset generations"); USDG's name none, as before.
 */
export async function partnerVaults(indexer: Upstream, d: Deployment, g: Generation = d.generations[0]!): Promise<PartnerVault[]> {
  const out: PartnerVault[] = [];
  const factory = g.primary ? "" : `&factory=${g.factory.toLowerCase()}`;
  let cursor: string | null = null;
  for (let n = 0; n < 20; n += 1) {
    const page: z.output<typeof vaultPage> = await indexer.get(`/intent/partners/vaults?limit=${VAULT_PAGE}${factory}${cursor ? `&cursor=${cursor}` : ""}`, vaultPage);
    out.push(...page.items.slice(0, VAULT_PAGE).filter((v) => v.core.toLowerCase() === g.core.engine.toLowerCase()));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/** Every vault of every public generation, each with its generation, USDG's first (D251). */
export async function allPartnerVaults(indexer: Upstream, d: Deployment): Promise<{ v: PartnerVault; g: Generation }[]> {
  const lists = await Promise.all(d.generations.map(async (g) => (await partnerVaults(indexer, d, g)).map((v) => ({ v, g }))));
  return lists.flat();
}

const linkTable = z.object({ links: z.array(z.object({ link: z.string(), vault: z.string() }).loose()) }).loose();
/** A link as the rule makes it (src/links.ts): lower-case letters, digits and dashes, a name's 40 and an address's 40. */
const LINK = /^[a-z0-9][a-z0-9-]{0,95}$/;

/**
 * Each partner vault's short link by its address in lower case (`GET /intent/partners/links`, D290): the index's table,
 * from the name each vault's creation gave it. Empty while the index cannot say (a table not built yet, an index without
 * the route): a link is display data, so its absence never stops a read.
 */
export async function vaultLinks(indexer: Upstream): Promise<Map<string, string>> {
  try {
    const r = await indexer.raw("/intent/partners/links");
    const parsed = r.status === 200 ? linkTable.safeParse(r.body) : null;
    const rows = parsed?.success ? parsed.data.links.filter((x) => LINK.test(x.link) && /^0x[0-9a-fA-F]{40}$/.test(x.vault)) : [];
    return new Map(rows.map((x) => [x.vault.toLowerCase(), x.link] as const));
  } catch { return new Map(); }
}

export const accounting = z.object({
  pricing: z.object({ totalAssets: digits, totalSupply: digits, assetsPerShare: digits }).loose(),
  liquidity: z.object({ free: digits }).loose(),
  /** The loans `settle` would book now (`due`: one is past its end, so deposits and redemptions wait for it). */
  settlement: z.object({ due: z.boolean(), settleable: z.array(digits) }).loose().optional(),
}).loose();

export const holding = z.object({
  shares: digits, value: digits, withdrawableNow: digits, rewards: digits,
  /** `loanId`: the loan a pocket came from, by which the chain is asked (M7); one the index answers malformed is none. */
  pockets: z.array(z.object({
    id: z.number().int(), kind: z.string().optional(), loanId: digits.optional().catch(undefined), token: addr, claimable: digits, private: z.boolean().optional(),
  }).loose()),
  earnings: digits.optional(),
}).loose();
type Pocket = z.output<typeof holding>["pockets"][number];

/**
 * What each holding can claim from its vault's pockets now, private ones left out (D222): the index must mark a pocket
 * public and, on a core a private-lane router lists on, the chain bear its loan out as public too (M7), every holding's
 * asked together. `engine` is the core the holding's vault lends on.
 */
export async function claimablePockets(c: Pick<Ctx, "d" | "chain">, held: readonly { engine: Address; pockets: readonly Pocket[] }[]): Promise<Pocket[][]> {
  const ready = held.map(({ engine, pockets }) => pockets.filter((p) => isPublic(p) && BigInt(p.claimable) > 0n).map((p) => ({ p, engine })));
  const all = ready.flat();
  const shown = await publicOnChain(c, all.map(({ p, engine }) => ({ engine, id: p.loanId === undefined ? null : BigInt(p.loanId) })));
  const kept = new Set(all.filter((_, i) => shown[i]).map(({ p }) => p));
  return ready.map((rows) => rows.flatMap(({ p }) => (kept.has(p) ? [p] : [])));
}

export const previewAnswer = z.object({
  kind: z.enum(["DEPOSIT", "REDEEM"]), assets: digits, shares: digits, refusal: z.string().nullable(), availableNow: digits.nullable(),
}).loose();

/** The longest vault name the factory takes (`IntentFactory.MAX_NAME_BYTES` counts bytes; this counts characters). */
const NAME_CHARS = 48;

/**
 * A vault's name. From mandate version 12 (Intent D54) the one its manager gave it, on chain, as plain text: one line,
 * without control or invisible format characters, at most 48 characters. A vault without one (earlier versions, or a
 * name that is empty once cleaned) is named as the Earn page names it (web/src/intent/partners/copy.ts): its family from
 * the categories it lends against (RWA: stocks and commodities, RH ECO: meme and utility coins), and its token when it
 * lends against one only.
 */
export function vaultName(v: Pick<PartnerVault, "categoryMask" | "assets" | "name">, d: Deployment): string {
  const own = Array.from((v.name ?? "").replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim()).slice(0, NAME_CHARS).join("").trim();
  if (own) return own;
  const family = v.categoryMask & (1 | 8) ? "RWA" : v.categoryMask & (2 | 4) ? "RH ECO" : "Partner";
  const named = (a: { token: string }) => a.token.toLowerCase() === v.assets[0]!.toLowerCase();
  // A lend-asset generation's collateral may be outside the release's asset list (D249): it names its own.
  const one = v.assets.length === 1 ? d.assets.find(named) ?? d.generations.flatMap((g) => g.collateral).find(named) : undefined;
  return one ? `${family} · ${one.symbol}` : `${family} vault`;
}
