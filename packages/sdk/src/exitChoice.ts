/**
 * Which of a partner vault's loans the chain's exit desk lists for a holder leaving it (Intent D57): the app's choice
 * (web/src/intent/partners/exitChoice.ts) and the keeper's (services/keeper/src/jobs/intent-exits.ts, `exitPick`), as
 * the desk weighs a holding (`IntentExitDesk._position`): among those the desk would list now, the smallest whose book
 * value covers what the exit needs, else the largest; a tie in book value goes to the least interest still to come per
 * unit of book value, then the earliest maturity, then the lowest id. Only the part the exit needs falls to book
 * (`floorBps`), so a holding far larger than it barely falls. A holding under another exit's live listing is listed for
 * this exit only by taking that listing over as it stands, which the desk does for a strictly larger need, or once that
 * exit cancelled (ED2, root D390); from root D391 only for an exit whose floor there is strictly lower than the floor of
 * the exit it serves, or once that exit needs nothing (`exitMayTakeOver`). From root D391 (the internal audit's SEC-01)
 * the leaver pays a sale's discount below the start out of its own loan-days part of that loan, so the desk's floor is
 * never below the share of what the loan has still to earn that the leaver's committed shares did not carry
 * (`exitStakeFloor`, from the share views' `exitShare`): holdings are tried first by where the desk would stop each for
 * this exit, the larger of that floor and the need's (`exitFloor`), in whole percent, the lowest first, then by size as
 * above. And, as the app counts them, the shares an amount commits and where an open exit
 * stands. Pure: every chain read is injected.
 */

/** IntentVault's interest clock precision (`RATE_PRECISION`). */
export const RATE_PRECISION = 10n ** 18n;
/** How long an exit listing's price falls (`IntentLenderMarket.AUCTION_SPAN`), and how long it stands after (`EXIT_GRACE`). */
export const EXIT_FALL_SECONDS = 600;
export const EXIT_GRACE_SECONDS = 60;
/** What the rest of an exit's holding keeps of what it has still to earn (`IntentExitDesk.START_KEEP_BPS`). */
export const EXIT_KEEP_BPS = 9900;
/** How long an exit listing stands: the market refuses one that would outlive its loan. */
export const EXIT_LISTING_SECONDS = EXIT_FALL_SECONDS + EXIT_GRACE_SECONDS;
/** What a prepared listing adds for the wallet's own confirmation, as the app does: the loan must outlive it by then. */
export const EXIT_CONFIRM_SECONDS = 300;
/** The core's ACTIVE state (`V2State`). */
const ACTIVE = 2;
const ZERO = "0x0000000000000000000000000000000000000000";
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** A running holding as the desk weighs it: interest still to earn and book value, both scaled by 1e18, and its end. */
export interface ExitHolding { id: bigint; remaining: bigint; book: bigint; maturity: number }
/** The fields of a vault's record of a holding (`IntentVault.loans(id)`) the desk reads. */
export interface ExitRecord { maturity: number; withdrawn: boolean; settled: boolean; principal: bigint; interest: bigint; rate: bigint; clockStart: number }
/** The core's loan as the eligibility check reads it. */
export interface ExitCoreLoan { state: number; term: number; fundedAt: number }
/** A market's listing of a holding (mandate 13's `asks(id)`). */
export interface ExitAsk { listedAt: number; deadline: number; nonce: bigint; exit: boolean }
/** SEC-01 (root D391): what a holder carried of a holding's exposure window and the window's whole supply (`exitShare`). */
export interface ExitShare { exposure: bigint; supply: bigint }
/**
 * SEC-01 (root D391): the leaver's side of the desk's stake floor: the shares the desk may redeem at the sale
 * (`committed`, the least of the exit's shares, the leaver's balance and its approval of the desk) and its balance.
 */
export interface ExitStake { committed: bigint; held: bigint }
/** The holding an exit lists, and where the desk would stop its price for that exit now (`floorBps`; null where the share
 * views answer no `exitShare`, or no stake was given). */
export interface ExitChoice extends ExitHolding { floorBps: number | null }

/**
 * The desk's stake floor (`IntentExitDesk.floorBps`, SEC-01): `ceil(9900 × (S − carried) / S)` in basis points of what the
 * holding has still to earn kept above book, `carried = exposure × committed / held` rounded down; 9900 in the purchase's
 * second (S zero) or for a leaver holding nothing, zero once it carried the whole window.
 */
export function exitStakeFloor(share: ExitShare, committed: bigint, held: bigint): number {
  if (share.supply === 0n) return EXIT_KEEP_BPS;
  const carried = held === 0n ? 0n : (share.exposure * committed) / held;
  return carried >= share.supply ? 0 : Number(ceilDiv(BigInt(EXIT_KEEP_BPS) * (share.supply - carried), share.supply));
}

/** The desk's floor for a need of `need` (raw) at a holding of book value `book` (scaled by 1e18): none when the need
 * covers it whole, else 9900 of the part beyond the need, rounded up. */
export function exitNeedFloor(need: bigint, book: bigint): number {
  const want = need * RATE_PRECISION;
  return want >= book ? 0 : Number(ceilDiv(BigInt(EXIT_KEEP_BPS) * (book - want), book));
}

/** Where the desk would stop `holding`'s price for an exit that needs `need`: the larger of the need's floor and the
 * leaver's stake floor (`stake`; null for a desk with none). */
export function exitFloor(holding: ExitHolding, need: bigint, stake: number | null): number {
  const floor = exitNeedFloor(need, holding.book);
  return stake !== null && stake > floor ? stake : floor;
}

/** The desk's `_position` of record `r`; null for a record the desk counts as nothing. */
export function exitPosition(id: bigint, r: ExitRecord, accrualEnd: bigint): ExitHolding | null {
  if (r.settled || r.withdrawn || r.rate === 0n) return null;
  const maturity = BigInt(r.maturity), start = BigInt(r.clockStart);
  const end = accrualEnd < maturity ? accrualEnd : maturity;
  const earned = r.rate * (end > start ? end - start : 0n), owed = r.interest * RATE_PRECISION;
  const book = r.principal * RATE_PRECISION + earned;
  return book === 0n ? null : { id, remaining: owed > earned ? owed - earned : 0n, book, maturity: r.maturity };
}

/** The listing order: least interest still to come per unit of book value, then earliest maturity, then lowest id. */
export function exitRank(a: ExitHolding, b: ExitHolding): number {
  const x = a.remaining * b.book, y = b.remaining * a.book;
  if (x !== y) return x < y ? -1 : 1;
  if (a.maturity !== b.maturity) return a.maturity - b.maturity;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The desk's own `_live`: the market's listing of the holding is still exit listing `nonce`, and open. */
export const liveExit = (ask: ExitAsk, nonce: bigint, now: number): boolean =>
  nonce !== 0n && ask.listedAt !== 0 && ask.exit && ask.nonce === nonce && now < ask.deadline;

/** What the choice reads from the chain, each for one vault, its desk and its market. */
export interface ExitReads {
  records(): Promise<readonly bigint[]>;
  record(id: bigint): Promise<ExitRecord>;
  accrualEnd(id: bigint): Promise<bigint>;
  saleSlots(id: bigint): Promise<number>;
  coreLoan(id: bigint): Promise<ExitCoreLoan>;
  /** The desk's record of its last exit listing of holding `id` (`listings`): the exit it serves and that listing's
   * nonce, zero for none (and none once that exit cancelled). */
  listing(id: bigint): Promise<{ owner: string; nonce: bigint }>;
  ask(id: bigint): Promise<ExitAsk>;
  withinAverage(id: bigint): Promise<boolean>;
  /** What the vault cannot pay now of another holder's exit (`shortfall(vault, owner)`). */
  shortfall(owner: string): Promise<bigint>;
  /** SEC-01 (root D391): where the desk would stop holding `id`'s listing for `owner`'s exit (`floorOf(vault, id,
   * owner)`); null from a desk that answers none (an earlier generation's), which takes no listing over. */
  floorOf(id: bigint, owner: string): Promise<number | null>;
  /** SEC-01 (root D391): what the leaver carried of each holding's exposure window (`exitShare`), in `ids`' order; null
   * where the share views answer none. Absent: no stake floor is read. */
  exitShares?(ids: readonly bigint[]): Promise<readonly ExitShare[] | null>;
}

/** The vault's running holdings in the order the desk lists them (`exitRank`), each record read once. */
export async function exitBook(reads: ExitReads): Promise<ExitHolding[]> {
  const ids = [...new Set(await reads.records())];
  const held = await Promise.all(ids.map(async (id) => {
    const r = await reads.record(id);
    if (r.settled || r.withdrawn || r.rate === 0n) return null;
    return exitPosition(id, r, await reads.accrualEnd(id));
  }));
  return held.filter((h): h is ExitHolding => h !== null).sort(exitRank);
}

/**
 * Whether the desk would list holding `id` now for an exit whose floor there would be `mine` (`exitFloor`): a quarter of
 * it left to sell, its loan running past the listing (and past `slack` more, the wallet's own confirmation), no other
 * exit's live listing of it that this exit may not take over (`exitMayTakeOver`), and within the vault's average. Its
 * record must name that listing's nonce, and a cancelled exit's record is gone, so its listing still standing is any
 * exit's.
 */
export async function exitEligible(reads: ExitReads, id: bigint, now: number, mine: number, slack = 0): Promise<boolean> {
  if ((await reads.saleSlots(id)) <= 0) return false;
  const loan = await reads.coreLoan(id);
  if (loan.state !== ACTIVE || now + slack + EXIT_LISTING_SECONDS > loan.fundedAt + loan.term) return false;
  const { owner, nonce } = await reads.listing(id);
  if (nonce !== 0n && owner.toLowerCase() !== ZERO && liveExit(await reads.ask(id), nonce, now) && !(await exitMayTakeOver(reads, id, owner, mine))) return false;
  return reads.withinAverage(id);
}

/**
 * ED2 (root D390), the desk's takeover rule in one place, keyed by SEC-01's floors (root D391): whether an exit whose floor
 * at holding `id` would be `mine` (`exitFloor`) may take over the live exit listing of it that serves `holder`'s exit:
 * only through a desk that answers `floorOf`, and only where it stops that listing strictly higher for `holder`'s exit
 * (`floorOf(vault, id, holder)`), both floors as the takeover's own transaction finds the vault; or once `holder`'s exit
 * needs nothing (`shortfall` zero, read only where its floor is 9900, which it then is). A cancelled exit's listing names
 * no exit, and any exit may take it over. A takeover lowers where the listing stops as that transaction finds it, but not
 * for good: cash moved within it (root D395), or fewer shares the taker commits after it (root D408), can leave the listing
 * stopping higher than it did for the exit it displaced.
 */
export async function exitMayTakeOver(reads: ExitReads, id: bigint, holder: string, mine: number): Promise<boolean> {
  const theirs = await reads.floorOf(id, holder);
  if (theirs === null) return false;
  return mine < theirs || (theirs === EXIT_KEEP_BPS && (await reads.shortfall(holder)) === 0n);
}

/**
 * The order holdings are offered for an exit that needs `need` (raw, in the vault's asset): where the desk would stop
 * each for this exit (`exitFloor`, the larger of the need's floor and the leaver's stake floor, `stakes` by id) in whole
 * percent, the lowest first (SEC-01; a holding whose stake floor is not known compares equal); then those whose book
 * covers it, the smallest of them first, then the rest, the largest first; equal books in listing order (`exitRank`).
 */
export function exitFit(need: bigint, stakes?: ReadonlyMap<bigint, number> | null): (a: ExitHolding, b: ExitHolding) => number {
  const want = need * RATE_PRECISION;
  const percent = (h: ExitHolding) => {
    const stake = stakes?.get(h.id);
    return stake === undefined ? 0 : Math.floor(exitFloor(h, need, stake) / 100);
  };
  return (a, b) => {
    const kept = percent(a) - percent(b);
    if (kept !== 0) return kept;
    const covers = a.book >= want;
    if (covers !== b.book >= want) return covers ? -1 : 1;
    if (a.book !== b.book) return (a.book < b.book) === covers ? -1 : 1;
    return exitRank(a, b);
  };
}

/** An exit listing of the holding still open on the market, whichever exit it serves, or none once it cancelled: a listing
 * of it now takes that one over as it stands (ED2, root D390). */
export const standingExit = (ask: ExitAsk, now: number): boolean => ask.listedAt !== 0 && ask.exit && now < ask.deadline;

/**
 * The leaver's stake floor on each holding (SEC-01): `stake`'s committed shares and balance over what it carried of each
 * (`reads.exitShares`); null without a stake or that read, or where the share views answer none.
 */
export async function exitStakes(reads: ExitReads, holdings: readonly ExitHolding[], stake?: ExitStake): Promise<Map<bigint, number> | null> {
  if (!stake || !reads.exitShares) return null;
  const shares = await reads.exitShares(holdings.map((h) => h.id));
  if (!shares || shares.length !== holdings.length) return null;
  return new Map(holdings.map((h, i) => [h.id, exitStakeFloor(shares[i]!, stake.committed, stake.held)]));
}

/**
 * The holding an exit that needs `need` lists: the first in `exitFit` order the desk would list now (`slack` as
 * `exitEligible`'s), by where the desk would stop it for this exit (`exitFloor`, with the leaver's stake floor, `stake`,
 * SEC-01), then the smallest covering one, else the largest; with
 * where the desk would stop its price for this exit now. Null when there is none. With `takes`, a holding under a standing
 * exit listing is chosen only once `takes` says the desk takes that listing over for this exit; a takeover it refuses
 * (`ListingLive`: the testnet's r13d desk refuses them all, and a race lost to a lower floor can) is passed over for the
 * next holding, as the keeper passes it over.
 */
export async function chooseExitHolding(
  reads: ExitReads, need: bigint, now: number, slack = 0, takes?: (holding: ExitHolding) => Promise<boolean>, stake?: ExitStake,
): Promise<ExitChoice | null> {
  const book = await exitBook(reads), stakes = await exitStakes(reads, book, stake);
  for (const holding of book.sort(exitFit(need, stakes))) {
    const floor = exitFloor(holding, need, stakes?.get(holding.id) ?? null);
    if (!(await exitEligible(reads, holding.id, now, floor, slack))) continue;
    if (takes && standingExit(await reads.ask(holding.id), now) && !(await takes(holding))) continue;
    return { ...holding, floorBps: stakes ? floor : null };
  }
  return null;
}

/** `chooseExitHolding`'s id, as the app's and the keeper's choice answers it. */
export async function chooseExitLoan(
  reads: ExitReads, need: bigint, now: number, slack = 0, takes?: (holding: ExitHolding) => Promise<boolean>, stake?: ExitStake,
): Promise<bigint | null> {
  return (await chooseExitHolding(reads, need, now, slack, takes, stake))?.id ?? null;
}

/**
 * What a commitment of `shares` needs, as the desk's `shortfall` counts it: what they claim (`previewRedeem`) beyond
 * what the vault holds outside its loans (`held`: its cash and its reserve at value, `totalAssets` less the loans, root
 * D394; not what the reserve can pay out now), at most their part of its loans (`performingPrincipal` plus
 * `accruedInterest`). Zero when cash and the reserve cover them, and the desk then lists nothing (`NoShortfall`).
 */
export function exitNeed(v: { claim: bigint; held: bigint; loans: bigint; shares: bigint; supply: bigint }): bigint {
  if (v.claim <= v.held || v.supply === 0n) return 0n;
  const part = (v.shares * v.loans) / v.supply;
  return v.claim - v.held < part ? v.claim - v.held : part;
}

/**
 * The shares an exit of `wanted` (raw, in the vault's asset) commits out of a holding of `held` shares worth `value`,
 * and what they are worth at today's share value, as the app's sheet counts them: every share for the whole balance,
 * else the part worth `wanted`, rounded down.
 */
export function exitShares(held: bigint, value: bigint, wanted: bigint): { shares: bigint; worth: bigint } {
  if (held === 0n || value === 0n || wanted <= 0n) return { shares: 0n, worth: 0n };
  if (wanted >= value) return { shares: held, worth: value };
  const shares = (held * wanted) / value;
  return { shares, worth: (shares * value) / held };
}

/** What `committed` shares of an exit are worth out of a holding of `held` shares worth `value`: the desk redeems no
 * more than the holder still holds. */
export function exitCommitted(committed: bigint, held: bigint, value: bigint): bigint {
  return held === 0n ? 0n : ((committed < held ? committed : held) * value) / held;
}

/**
 * A holder's exit as the desk holds it (`exits(vault, owner)`), the market's listing of its last holding (null when none
 * was read), what the vault still cannot pay of it (`shortfall`), when the holder committed and how long a commitment
 * lasts (`committedAt`, the desk's `EXIT_LIFE`, in seconds).
 */
export interface ExitState { shares: bigint; loanId: bigint; nonce: bigint; ask: ExitAsk | null; shortfall: bigint; committedAt: number; life: number }

/**
 * Where an open exit stands, as the app's card says it: lapsed `EXIT_LIFE` after it was committed (nothing is listed or
 * paid for it again until the holder commits again); its holding listed until `ends`; the next one to list (the last
 * ended unsold, or a sale paid part of it, while the vault still cannot pay the rest); or nothing left that the vault
 * cannot pay now.
 */
export type ExitStage = { kind: "lapsed" } | { kind: "listed"; loanId: bigint; ends: number } | { kind: "next" } | { kind: "payable" };

/** `e`'s stage at `now`; null for no exit. */
export function exitStage(e: ExitState, now: number): ExitStage | null {
  if (e.shares === 0n) return null;
  // The desk's own `_lapsed`, first: a lapsed exit reads no shortfall, which is not the vault paying it.
  if (now >= e.committedAt + e.life) return { kind: "lapsed" };
  if (e.ask && liveExit(e.ask, e.nonce, now)) return { kind: "listed", loanId: e.loanId, ends: e.ask.deadline };
  return e.shortfall === 0n ? { kind: "payable" } : { kind: "next" };
}

