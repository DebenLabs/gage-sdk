/**
 * The indexer's answers the service reads (docs/api.md, Indexer and Intent partner strategies), private loans dropped:
 * the index must mark a loan public, and the chain bear it out (the audit of 18 October 2026, M7).
 */
import { z } from "zod";
import type { Address } from "viem";
import type { Loan } from "./chain.js";
import { generationOfCore, privateRoutersOf, type Deployment, type Generation } from "./deployment.js";
import { ApiError } from "./errors.js";
import type { Ctx } from "./plans.js";
import { createUpstream, type Upstream } from "./upstream.js";

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
 * would read as none, and an agent could miss one it must repay before its term ends. Each loan is asked once, however
 * many entries name it: a written-off loan can carry any number of backing pockets (D404).
 */
export async function publicOnChain(c: Pick<Ctx, "d" | "chain">, loans: readonly { engine: Address; id: bigint | null }[]): Promise<boolean[]> {
  const shown = loans.map((l) => privateRoutersOf(c.d, l.engine).length === 0);
  const cores = new Map<string, { engine: Address; at: Map<bigint, number[]> }>();
  loans.forEach((l, i) => {
    if (shown[i] || l.id === null) return;
    const key = l.engine.toLowerCase();
    const core = cores.get(key) ?? { engine: l.engine, at: new Map<bigint, number[]>() };
    const entries = core.at.get(l.id);
    if (entries) entries.push(i);
    else core.at.set(l.id, [i]);
    cores.set(key, core);
  });
  await Promise.all([...cores.values()].map(async ({ engine, at }) => {
    const ids = [...at.keys()];
    const opened = await c.chain.privateLoans(engine, privateRoutersOf(c.d, engine), ids);
    ids.forEach((id, n) => { for (const i of at.get(id)!) shown[i] = opened[n] === false; });
  }));
  return shown;
}

export const STATE = ["NONE", "FUNDING", "ACTIVE", "REPAID", "DEFAULTED", "CANCELLED"] as const;
export const stateName = (s: number) => STATE[s] ?? "UNKNOWN";

/** One loan from the index; a private one reads as unknown, and so does one the chain does not bear out as public (M7). */
export async function loanRecord(c: Pick<Ctx, "d" | "chain" | "indexer" | "indexerAt">, engine: Address, id: string): Promise<Position> {
  const p = await loanIndexer(c, engine).get(`/v2/positions/${engine.toLowerCase()}/${id}`, position);
  if (!isPublic(p) || !(await publicOnChain(c, [{ engine, id: BigInt(id) }]))[0]) throw new ApiError("NOT_FOUND", "gage has no record of that", 404);
  return p;
}

/** Rows a page of loans asks for, and the most one is read for. */
const PAGE = 100;

/**
 * Every loan the wallet takes part in on one engine (borrower, lender or holder of the reclaim right), newest first: each
 * one the index marks public and the chain bears out (M7).
 */
export async function walletLoans(c: Pick<Ctx, "d" | "chain" | "indexer" | "indexerAt">, engine: Address, wallet: Address, pages = 5): Promise<Position[]> {
  const out: Position[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < pages; n += 1) {
    const page: z.output<typeof positionPage> = await loanIndexer(c, engine).get(`/v2/positions?engine=${engine.toLowerCase()}&account=${wallet.toLowerCase()}&limit=${PAGE}${cursor ? `&cursor=${cursor}` : ""}`, positionPage);
    // No more rows than were asked for: an answer longer than its page is cut to it.
    out.push(...page.items.slice(0, PAGE).filter(isPublic));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const shown = await publicOnChain(c, out.map((p) => ({ engine, id: BigInt(p.id) })));
  return out.filter((_, i) => shown[i]);
}

/** A page of loans read for their ids alone: what each one is, the core says (`walletRights`). */
const idPage = z.object({ items: z.array(z.object({ id: digits }).loose()), nextCursor: z.string().nullable() }).loose();

/**
 * The loans whose reclaim right `wallet` holds on `engine`, as the core holds them (the class of F18, the audit of 1
 * November 2026: a signer never takes a gage service's word for an amount it approves). The index only names them, the
 * wallet's loans there waiting for funding or running, private ones too, whose rights the core counts as well: each is
 * read from the core (`ownerOf`, then `getLoan`) and kept, once, while the wallet holds its right. The core is an ERC-721
 * of rights, minted at a listing and burnt at its close, so its count of the wallet's (`rights`) is every such loan:
 * fewer read than that means the index left one out, and the list is refused rather than used in part, retryable as
 * when the index does not answer. `known`, the loan an action is for, counts though the index may not list it yet.
 */
export async function walletRights(c: Pick<Ctx, "d" | "chain" | "indexer" | "indexerAt">, engine: Address, wallet: Address, known: bigint, pages = 5): Promise<{ id: bigint; loan: Loan }[]> {
  const ids = new Set([known]);
  for (const state of ["funding", "active"]) {
    let cursor: string | null = null;
    for (let n = 0; n < pages; n += 1) {
      const page: z.output<typeof idPage> = await loanIndexer(c, engine).get(`/v2/positions?engine=${engine.toLowerCase()}&account=${wallet.toLowerCase()}&state=${state}&limit=${PAGE}${cursor ? `&cursor=${cursor}` : ""}`, idPage);
      page.items.slice(0, PAGE).forEach((p) => ids.add(BigInt(p.id)));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  }
  const mine = (holder: Address | null) => holder !== null && holder.toLowerCase() === wallet.toLowerCase();
  const [count, read] = await Promise.all([
    c.chain.rights(engine, wallet),
    // A closed loan's right is burnt and has no holder: not the wallet's, and its loan is not read.
    Promise.all([...ids].map(async (id) => (mine(await c.chain.ownerOf(engine, id)) ? { id, loan: await c.chain.loan(engine, id) } : null))),
  ]);
  const held = read.filter((r): r is { id: bigint; loan: Loan } => r !== null && (r.loan.state === 1 || r.loan.state === 2));
  if (BigInt(held.length) < count) throw new ApiError("UPSTREAM_UNAVAILABLE", "gage's index does not list every loan this wallet holds on the core now, so nothing is approved; try again shortly", 503, true);
  return held;
}

const vault = z.object({
  address: addr, creator: addr, curator: addr, core: addr, categoryMask: z.number().int(), feeBps: z.number().int(), maxLoanTerm: z.number().int(),
  assets: z.array(addr), fundingEnabled: z.boolean(),
  /** Mandate version 12 (Intent D54): the name its manager gave it, display text only. Earlier vaults have none; one the
   * index answers malformed is read as none, so it never hides the vault. */
  name: z.string().optional().catch(undefined),
  /** Its factory's mandate version, which the index checks against the vault's own `MANDATE_VERSION()`: where its open
   * reward-record count is kept (src/gas.ts). One the index omits or answers malformed is none, and the vault's
   * deposits and redemptions are sized for a full book. */
  mandateVersion: z.number().int().optional().catch(undefined),
  /** Its manager's current settings, of which `bufferBps` is read, the share of the vault a new loan or purchase must
   * leave free ("Cash kept free", D335), and `paused`, while none of its loans sells (Intent D57's exit now waits for
   * it). One the index omits or answers malformed is unknown. */
  settings: z.object({ bufferBps: z.number().int().min(0).max(10_000), paused: z.boolean().optional().catch(undefined) }).loose().optional().catch(undefined),
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

const generationIndexes = new Map<string, Upstream>();
/**
 * The index that serves `g`, one per generation (D403): a retained generation's own (docs/api.md "Historical service
 * retention"), a current one's the release names for it (`Generation.indexerUrl`), else the network's.
 */
export function indexerOf(c: Pick<Ctx, "indexer" | "indexerAt">, g: Generation): Upstream {
  const url = g.retired?.indexerUrl ?? g.indexerUrl;
  if (!url) return c.indexer;
  if (c.indexerAt) return c.indexerAt(url);
  let u = generationIndexes.get(url);
  if (!u) generationIndexes.set(url, (u = createUpstream(url)));
  return u;
}

/**
 * The index that serves loans on `engine`: its generation's (`indexerOf`), except a retained USDG generation's core,
 * which stays among the release's engines, and any other engine: the network's, which keeps every USDG engine.
 */
function loanIndexer(c: Pick<Ctx, "d" | "indexer" | "indexerAt">, engine: string): Upstream {
  const g = generationOfCore(c.d, engine);
  return g && !(g.retired && g.primary) ? indexerOf(c, g) : c.indexer;
}

/** Every vault of every public generation, each with its generation, USDG's first (D251); with `retired`, the kept ones' too. */
export async function allPartnerVaults(c: Pick<Ctx, "indexer" | "indexerAt" | "d">, retired = false): Promise<{ v: PartnerVault; g: Generation }[]> {
  const gens = retired ? [...c.d.generations, ...c.d.retired] : c.d.generations;
  const lists = await Promise.all(gens.map(async (g) => (await partnerVaults(indexerOf(c, g), c.d, g)).map((v) => ({ v, g }))));
  return lists.flat();
}

/**
 * Each of `items` read on its own (D412): the answers in order, and a line for each read that failed. A portfolio or a
 * Collect reads many cores and vaults, each at its generation's index; one that does not answer is named, never read as
 * empty, and never takes the others down with it.
 */
export async function eachRead<T, R>(items: readonly T[], read: (x: T) => Promise<R>, name: (x: T) => string): Promise<{ read: { x: T; r: R }[]; unread: string[] }> {
  const settled = await Promise.allSettled(items.map(read));
  const out: { x: T; r: R }[] = [], unread: string[] = [];
  settled.forEach((s, n) => {
    if (s.status === "fulfilled") out.push({ x: items[n]!, r: s.value });
    else unread.push(`${name(items[n]!)}: ${s.reason instanceof ApiError ? s.reason.message : "it did not answer"}`);
  });
  return { read: out, unread };
}

/** As `allPartnerVaults` with `retired`, each generation's list read on its own: one whose index does not answer is unread (D412). */
export async function everyPartnerVault(c: Pick<Ctx, "indexer" | "indexerAt" | "d">): Promise<{ vaults: { v: PartnerVault; g: Generation }[]; unread: string[] }> {
  const { read, unread } = await eachRead([...c.d.generations, ...c.d.retired], (g) => partnerVaults(indexerOf(c, g), c.d, g),
    (g) => `the ${g.id} vaults of factory ${g.factory}`);
  return { vaults: read.flatMap(({ x: g, r }) => r.map((v) => ({ v, g }))), unread };
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

/** One UTC day of what comes back to a vault's free cash as its loans end, if repaid (D335): `by` the day's last end. */
const freeCashDay = z.object({ by: z.number().int().nonnegative(), amount: digits }).loose();
export const accounting = z.object({
  pricing: z.object({ totalAssets: digits, totalSupply: digits, assetsPerShare: digits }).loose(),
  /** `schedule` and `settling` (D335): when more frees up; absent from an index before them, and one it answers
   * malformed is read as absent, so the figures beside them still serve. */
  liquidity: z.object({
    free: digits,
    schedule: z.array(freeCashDay).optional().catch(undefined),
    settling: digits.optional().catch(undefined),
  }).loose(),
  /** The loans `settle` would book now (`due`: one is past its end, so deposits and redemptions wait for it). */
  settlement: z.object({ due: z.boolean(), settleable: z.array(digits) }).loose().optional(),
  /** The index's time and the vault's loans, which `stillToEarn` reads: absent from an older index, and one it answers
   * malformed is read as absent, so the figures beside them still serve. */
  asOf: z.number().int().optional().catch(undefined),
  loans: z.array(z.object({
    state: z.string(), interest: digits, maturity: z.number().int(), start: z.number().int().nullable().optional(),
  }).loose()).optional().catch(undefined),
}).loose();

/**
 * What a vault's loans have still to earn if they are repaid, raw in its asset, as the app counts it
 * (web/src/intent/partners/earningNow.ts `stillToEarn`): each loan the vault earns on at the index's time (performing, or
 * repaid with its schedule running, and before its end), its interest still to accrue evenly to its end. Null while the
 * index cannot say: an older index, or a loan the vault earns on whose start it has not seen.
 */
export function stillToEarn(a: z.output<typeof accounting>): bigint | null {
  const asOf = a.asOf;
  if (asOf === undefined || !a.loans) return null;
  let left = 0n;
  for (const loan of a.loans) {
    if (!((loan.state === "PERFORMING" || loan.state === "REPAID_RUNNING") && loan.maturity > asOf)) continue;
    if (loan.start === undefined) return null;
    if (loan.start === null) left += BigInt(loan.interest);
    else if (loan.start < loan.maturity) left += (BigInt(loan.interest) * BigInt(loan.maturity - Math.max(asOf, loan.start))) / BigInt(loan.maturity - loan.start);
  }
  return left;
}

/** The most pockets one claim takes (`claimPockets`): a loan's backing names its oldest this many as its next claim. */
export const MAX_CLAIM_POCKETS = 64;

export const holding = z.object({
  shares: digits, value: digits, withdrawableNow: digits, rewards: digits,
  /**
   * `loanId`: the loan a pocket came from, by which the chain is asked (M7); one the index answers malformed is none.
   * `kind`: `RECOVERY` (a written-off loan's collateral), `RECAPITALIZATION` (backing added to one, which an index
   * before D414 listed here) or `EARNINGS`.
   */
  pockets: z.array(z.object({
    id: z.number().int(), kind: z.string().optional(), loanId: digits.optional().catch(undefined), token: addr, claimable: digits, private: z.boolean().optional(),
  }).loose()),
  /**
   * D414: each written-off loan's backing, summed by loan: how many of its pockets pay the wallet something and what they
   * pay, and the next claim, the oldest 64 of them and what it pays. An index before D414 sends none and lists backing
   * among `pockets`.
   */
  backing: z.array(z.object({
    loanId: digits.optional().catch(undefined), token: addr, pockets: z.number().int().nonnegative(), claimable: digits,
    next: z.object({ ids: z.array(z.number().int().positive()).min(1).max(MAX_CLAIM_POCKETS), claimable: digits }),
    private: z.boolean().optional(),
  }).loose()).optional(),
  earnings: digits.optional(),
}).loose();
type Pocket = z.output<typeof holding>["pockets"][number];
/** A written-off loan's backing on a holding (D414). */
export type Backing = NonNullable<z.output<typeof holding>["backing"]>[number];

/** A holding's backing by loan: the index's sums (D414), or, from an index before them, its backing pockets summed here. */
export function backingOf(h: { pockets: readonly Pocket[]; backing?: readonly Backing[] | undefined }): Backing[] {
  if (h.backing) return [...h.backing];
  const loans = new Map<string | undefined, Backing>();
  for (const p of [...h.pockets].filter((x) => x.kind === "RECAPITALIZATION").sort((x, y) => x.id - y.id)) {
    const b = loans.get(p.loanId) ?? { loanId: p.loanId, token: p.token, pockets: 0, claimable: "0", next: { ids: [], claimable: "0" }, private: p.private };
    loans.set(p.loanId, b);
    b.pockets += 1;
    b.claimable = String(BigInt(b.claimable) + BigInt(p.claimable));
    // A loan's backing is public only while every pocket of it is.
    if (!isPublic(p)) b.private = p.private;
    if (b.next.ids.length < MAX_CLAIM_POCKETS) b.next = { ids: [...b.next.ids, p.id], claimable: String(BigInt(b.next.claimable) + BigInt(p.claimable)) };
  }
  return [...loans.values()];
}

/**
 * What each holding can claim from its vault's pockets now, private ones left out (D222): the index must mark a pocket,
 * or a loan's backing, public and, on a core a private-lane router lists on, the chain bear its loan out as public too
 * (M7), every holding's asked together. `engine` is the core the holding's vault lends on. Backing comes by loan (D414):
 * from an index before that, the backing pockets it lists are summed here and left out of `pockets`.
 */
export async function claimablePockets(
  c: Pick<Ctx, "d" | "chain">,
  held: readonly { engine: Address; pockets: readonly Pocket[]; backing?: readonly Backing[] | undefined }[],
): Promise<{ pockets: Pocket[]; backing: Backing[] }[]> {
  const ready = held.map(({ engine, pockets, backing }) => ({
    pockets: pockets.filter((p) => p.kind !== "RECAPITALIZATION" && isPublic(p) && BigInt(p.claimable) > 0n).map((p) => ({ p, engine })),
    backing: backingOf({ pockets, backing }).filter((b) => isPublic(b) && BigInt(b.claimable) > 0n).map((b) => ({ b, engine })),
  }));
  const pockets = ready.flatMap((r) => r.pockets),
    backing = ready.flatMap((r) => r.backing);
  const shown = await publicOnChain(c, [...pockets.map(({ p, engine }) => ({ engine, id: p.loanId })), ...backing.map(({ b, engine }) => ({ engine, id: b.loanId }))]
    .map(({ engine, id }) => ({ engine, id: id === undefined ? null : BigInt(id) })));
  const kept = new Set<object>([...pockets.map(({ p }) => p), ...backing.map(({ b }) => b)].filter((_, i) => shown[i]));
  return ready.map((r) => ({
    pockets: r.pockets.flatMap(({ p }) => (kept.has(p) ? [p] : [])),
    backing: r.backing.flatMap(({ b }) => (kept.has(b) ? [b] : [])),
  }));
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
