/**
 * The rates service's Intent routes as the borrow card uses them (docs/api.md, "Intent funding preview", "Intent instant
 * borrow", "Intent private-lane quotes", "Intent roll quotes"): what the partner vaults fund, the instant loan,
 * leverage's signed plan and a roll's (D285). `allocate` and the plan checks are web/src/private/borrow.ts's and
 * web/src/rollover/quotes.ts's, so an agent's loop and roll are funded as the app's are.
 */
import { z } from "zod";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { ApiError } from "./errors.js";
import type { Upstream } from "./upstream.js";

const digits = z.string().regex(/^\d{1,78}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const refusal = z.object({ code: z.string(), reason: z.string().optional() }).loose();

export interface Terms { token: Address; collateral: bigint; principal: bigint; cap: bigint; term: number }
export type Allocation = { vault: Address; units: number };
/** `step`: refused only because the purchase would open the vault's record under the smallest one (Pashov I-04,
 * `PURCHASE_TOO_SMALL`, the rates service's last check): the vault passes through it to a larger count, never ends on it. */
interface VaultOption { units: number; principal: bigint; executionFee: bigint; step?: true }
interface VaultReading { vault: Address; options: VaultOption[]; loanPrincipal: bigint; totalAssets: bigint }

/**
 * The rates service's refusals gage-sdk passes on, in its own words (docs/api.md, the Intent routes). Neither another
 * code nor any text the service sends reaches an agent: a wrong or hostile answer could write instructions into them
 * (the audit of 18 October 2026).
 */
const REFUSALS: Record<string, string> = {
  ABOVE_MARKET_LIMIT: "The loan repays more than this collateral's limit allows; borrow less",
  ASSET_OPEN_CAP: "Loans against this token are at their limit now",
  COLLATERAL_ABOVE_MAXIMUM: "The pledge is over the token's maximum",
  COLLATERAL_BELOW_MINIMUM: "The pledge is under the token's minimum",
  COLLATERAL_NOT_ALLOWED: "gage does not take this token as collateral now",
  FILLER_NOT_ADMITTED: "gage's filler is not admitted for this loan now",
  FILLS_CLOSED: "The partner vaults are not filling loans now",
  INCOMPLETE_PLAN: "The partner vaults fund only part of this loan now",
  LEVERAGE_CLOSED: "Leverage is not offered here now",
  LISTINGS_PAUSED: "New loans are paused",
  LOAN_NOT_ACTIVE: "The loan is not running",
  NO_COST_OFFERED: "gage's rates model offers no cost for these terms now",
  NO_FILLER: "No filler is set to fund this loan now",
  NOT_RIGHT_HOLDER: "This wallet does not hold the loan's right",
  PRICING_EXPIRED: "The price expired before it was signed; prepare again",
  PRICING_UNAVAILABLE: "gage's rates model cannot price this now; try again shortly",
  PRINCIPAL_TOO_SMALL: "The loan is smaller than the partner vaults fund; borrow more",
  PURCHASE_TOO_SMALL: "A vault's part of this loan would be under its smallest",
  RETURN_ABOVE_PRINCIPAL: "The loan would cost more than it lends",
  ROLLOVER_CLOSED: "Rolling over is not offered for this loan's core",
  ROUTER_NOT_ADMITTED: "gage's router is not admitted to fill this loan now",
  SELF_DEALING: "This wallet is one of gage's own routers or fillers: no vault funds it",
  SIGNER_NOT_CONFIGURED: "gage's rates service cannot sign now; try again later",
  TERM_NOT_ALLOWED: "The partner vaults do not lend for this term",
  TOO_LATE: "The loan ends too soon to roll; repay it before it ends",
  UNSUPPORTED_COLLATERAL: "gage does not take this token as collateral now",
};

/** A refusal of the rates service: its code when gage-sdk knows it, in gage-sdk's words; else `own`, in `fallback`. */
const refused = (code: string | undefined, fallback: string, own = "RATES_REFUSED") =>
  code !== undefined && Object.hasOwn(REFUSALS, code) ? new ApiError(code, REFUSALS[code]!, 409) : new ApiError(own, fallback, 409);

function answer<S extends z.ZodType>(schema: S, got: { status: number; body: unknown }, what: string): z.output<S> {
  const parsed = schema.safeParse(got.body);
  if (parsed.success) return parsed.data;
  const said = (got.body && typeof got.body === "object" ? got.body : {}) as { refusal?: { code?: string; reason?: string } | null; error?: { code?: string; message?: string } };
  if (got.status === 404) throw new ApiError("RATES_UNAVAILABLE", `The rates service does not offer ${what}`, 503);
  if (got.status >= 500) throw new ApiError("RATES_UNAVAILABLE", "The rates service could not answer", 503, true);
  throw refused(said.refusal?.code ?? said.error?.code, "The rates service refused these terms");
}

const termsQuery = (t: Terms, borrower: Address) =>
  `token=${t.token.toLowerCase()}&collateral=${t.collateral}&principal=${t.principal}&cap=${t.cap}&term=${t.term}&borrower=${borrower.toLowerCase()}`;

const previewSchema = z.object({
  schema: z.literal("gage-intent-preview-v1"),
  status: z.enum(["ok", "refused"]),
  refusal: refusal.nullable(),
  vaults: z.array(z.object({
    vault: address, loanPrincipal: digits, totalAssets: digits,
    options: z.array(z.object({ units: z.number().int().min(1).max(4), principal: digits, executionFee: digits, refusal: refusal.nullable() }).loose()),
  }).loose()).optional(),
  summary: z.object({
    units: z.number().int(), fills: z.boolean(), reason: z.string().nullable(),
    // Whether the vaults' settings accept these terms whatever their cash now, the lowest cost (tenths of a basis point)
    // and the largest principal at which they take the loan whole (docs/api.md, "Intent funding preview").
    accepts: z.boolean().optional(), acceptFloorTenths: z.number().int().nullable().optional(), acceptMaxPrincipal: digits.nullable().optional(),
  }).loose().nullable(),
  /** The model's cost of these exact terms (`purpose=comparison`), which the vaults' floors read. */
  pricing: z.object({ costBps: z.number().int() }).loose().nullable().optional(),
}).loose();

/** What the vaults could take of these exact terms, at one block; `fills` when all four quarters are taken. */
export async function preview(rates: Upstream, engine: Address, t: Terms, borrower: Address) {
  const p = answer(previewSchema, await rates.raw(`/intent/preview/${engine.toLowerCase()}?${termsQuery(t, borrower)}`), "funding previews");
  if (p.status === "refused") throw refused(p.refusal?.code, "The rates service refused these terms");
  const vaults: VaultReading[] = (p.vaults ?? []).map((v) => {
    const options: VaultOption[] = [];
    // An option with a refusal ends that vault's options, as the filler reads them, except the first counts refused only for
    // their size: steps, dropped when no count the vault accepts follows them.
    let accepted = 0;
    for (const o of v.options) {
      if (o.refusal) {
        if (accepted === 0 && o.refusal.code === "PURCHASE_TOO_SMALL") { options.push({ units: o.units, principal: BigInt(o.principal), executionFee: BigInt(o.executionFee), step: true }); continue; }
        break;
      }
      options.push({ units: o.units, principal: BigInt(o.principal), executionFee: BigInt(o.executionFee) });
      accepted += 1;
    }
    if (accepted === 0) options.length = 0;
    return { vault: v.vault as Address, options, loanPrincipal: BigInt(v.loanPrincipal), totalAssets: BigInt(v.totalAssets) };
  });
  return {
    fills: Boolean(p.summary?.fills), units: p.summary?.units ?? 0, reason: p.summary?.reason ?? null, vaults,
    accepts: p.summary?.accepts ?? null, acceptFloorTenths: p.summary?.acceptFloorTenths ?? null,
    acceptMaxPrincipal: p.summary?.acceptMaxPrincipal ? BigInt(p.summary.acceptMaxPrincipal) : null, modelBps: p.pricing?.costBps ?? null,
  };
}

const point = z.object({ principalRaw: digits, repaymentRaw: digits, costBps: z.number().int().min(0).max(5_000) }).loose();
const suggestSchema = z.object({
  status: z.enum(["preview", "ready"]), costBps: z.number().int(), collateralValueRaw: digits,
  sizing: z.object({ curve: z.array(point).max(100) }).loose(),
}).loose();
/** Why the model offers no loan (`status: unavailable`, its reason a sentence): one fixed refusal of the SDK's. */
const NO_SUGGESTION = new ApiError("NO_SUGGESTION", "gage's rates model offers no loan against this pledge now", 409);

/**
 * The model's amount-to-cost curve for an exact pledge (`GET /rates/suggest`, the borrow card's sizing): the cost of
 * each amount up to the pledge's limit, `maxRepaymentBps` of its value (70% for memes, 90% for stocks and ETH).
 */
export async function suggestCurve(rates: Upstream, a: { chainId: number; engine: Address; token: Address; collateral: bigint; term: number; maxRepaymentBps: number; asset?: Address }) {
  const q = `chainId=${a.chainId}&term=${a.term}&engine=${a.engine.toLowerCase()}&token=${a.token.toLowerCase()}&collateral=${a.collateral}&maxRepaymentBps=${a.maxRepaymentBps}${a.asset ? `&asset=${a.asset.toLowerCase()}` : ""}`;
  const r = await rates.raw(`/rates/suggest?${q}`);
  if (r.status >= 500) throw new ApiError("RATES_UNAVAILABLE", "The rates service could not answer", 503, true);
  const parsed = suggestSchema.safeParse(r.body);
  if (!parsed.success) throw NO_SUGGESTION;
  return { value: BigInt(parsed.data.collateralValueRaw), curve: parsed.data.sizing.curve.map((p) => ({ principal: BigInt(p.principalRaw), repayment: BigInt(p.repaymentRaw), costBps: p.costBps })) };
}

/** The most of `limit` more units the vaults take, each ending on none or a count it accepts, from what `has` gives each. */
function reachable(vaults: readonly VaultReading[], has: (v: VaultReading) => number, limit: number): number {
  let sums = new Set([0]);
  for (const v of vaults) {
    const from = has(v), adds: number[] = [];
    for (let to = from; to <= v.options.length; to += 1) if (to === 0 || !v.options[to - 1]!.step) adds.push(to - from);
    const next = new Set<number>();
    for (const sum of sums) for (const add of adds) if (sum + add <= limit) next.add(sum + add);
    sums = next;
  }
  return Math.max(...sums);
}

/**
 * The four quarters handed out one at a time, as the filler does; null when the vaults cannot take them all. With steps
 * (Pashov I-04), a unit goes only to a vault whose taking it still lets every vault end on none or a count it accepts.
 */
export function allocate(vaults: readonly VaultReading[], units = 4): Allocation[] | null {
  const stepped = vaults.some((v) => v.options.some((o) => o.step));
  if ((stepped ? reachable(vaults, () => 0, units) : vaults.reduce((n, v) => n + v.options.length, 0)) < units) return null;
  const given = new Map<string, number>();
  const has = (v: VaultReading) => given.get(v.vault.toLowerCase()) ?? 0;
  for (let unit = 0; unit < units; unit += 1) {
    const after = (taker: VaultReading) => (v: VaultReading) => has(v) + (v === taker ? 1 : 0);
    const candidates = vaults.filter((v) => has(v) < v.options.length).filter((v) => !stepped || reachable(vaults, after(v), units - unit - 1) === units - unit - 1).map((v) => {
      const n = has(v), next = v.options[n]!, before = n === 0 ? { principal: 0n, executionFee: 0n } : v.options[n - 1]!;
      return { v, fee: next.executionFee - before.executionFee, loans: v.loanPrincipal + before.principal };
    });
    const best = candidates.reduce((a, b) => {
      if (a.fee !== b.fee) return a.fee > b.fee ? a : b;
      const aEmpty = a.v.totalAssets === 0n, bEmpty = b.v.totalAssets === 0n;
      if (aEmpty !== bEmpty) return aEmpty ? b : a;
      const left = a.loans * b.v.totalAssets, right = b.loans * a.v.totalAssets;
      if (left !== right) return left < right ? a : b;
      return BigInt(a.v.vault) < BigInt(b.v.vault) ? a : b;
    });
    given.set(best.v.vault.toLowerCase(), has(best.v) + 1);
  }
  return vaults.filter((v) => has(v) > 0).map((v) => ({ vault: v.vault, units: has(v) })).sort((a, b) => (BigInt(a.vault) < BigInt(b.vault) ? -1 : 1));
}

/**
 * Why the instant answer offers no loan (`InstantReason`, services/valuation/src/rates/intent/instant.ts), in the SDK's
 * own codes and words: the service names a reason, never a sentence.
 */
const INSTANT_REASONS: Record<string, [code: string, words: string]> = {
  TOO_SMALL: ["LOAN_TOO_SMALL", "The partner vaults fund no loan this small; pledge more"],
  DRY: ["INSUFFICIENT_CAPACITY", "No partner vault has the free cash or room for a loan against this pledge now"],
  EMPTY: ["INSUFFICIENT_CAPACITY", "No partner vault that lends against this token holds deposits now"],
  TERM: ["TERM_NOT_FUNDED", "No partner vault lends against this token for this term now; try another term"],
  NONE: ["UNSUPPORTED_COLLATERAL", "gage does not take this token as collateral now"],
  CLOSED: ["LISTINGS_PAUSED", "New loans are paused"],
  SELF: ["SELF_DEALING", "This wallet is one of gage's own routers or fillers: no vault funds it"],
  NO_SUGGESTION: ["NO_SUGGESTION", "gage's rates model offers no loan against this pledge now"],
  HOURS: ["ONE_DAY_CLOSED", "A 1-day loan cannot open now: the market closes during its day"],
};

const instantSchema = z.object({
  schema: z.literal("gage-intent-instant-v1"),
  status: z.string(),
  refusal: refusal.nullable(),
  expiresAt: z.number().int(),
  answer: z.object({
    collateral: digits, valueUSDG: digits, principal: digits, cap: digits, costBps: z.number(), suggestedBps: z.number().nullable().optional(),
    ltvBps: z.number(), binds: z.string(), room: digits, vaults: z.number().int(),
  }).loose().nullable(),
  reason: z.string().nullable().optional(),
}).loose();

/** The largest loan the vaults fund whole for at most `wallet` raw tokens (the borrow card's Instant loan, D182). */
export async function instant(rates: Upstream, engine: Address, token: Address, wallet: bigint, term: number, borrower?: Address) {
  const q = `token=${token.toLowerCase()}&wallet=${wallet}&term=${term}${borrower ? `&borrower=${borrower.toLowerCase()}` : ""}`;
  const r = answer(instantSchema, await rates.raw(`/intent/instant/${engine.toLowerCase()}?${q}`), "instant loans");
  if (!r.answer) {
    const known = !r.refusal && r.reason && Object.hasOwn(INSTANT_REASONS, r.reason) ? INSTANT_REASONS[r.reason] : undefined;
    if (known) throw new ApiError(known[0], known[1], 409);
    throw refused(r.refusal?.code, "The partner vaults fund no loan for this pledge now");
  }
  const a = r.answer, collateral = BigInt(a.collateral);
  // The loan pledges some of the tokens asked about, never more (the service clamps to them): an answer that pledges
  // more would reach a quote's prepare object and a loop as the wallet's own pledge (the audit of 18 October 2026).
  if (collateral <= 0n || collateral > wallet) throw new ApiError("RATES_UNAVAILABLE", "The rates service answered a pledge outside the one asked about", 503);
  return {
    collateral, valueUSDG: BigInt(a.valueUSDG), principal: BigInt(a.principal), cap: BigInt(a.cap),
    costBps: a.costBps, ltvBps: a.ltvBps, vaults: a.vaults, expiresAt: r.expiresAt,
  };
}

const planAllocation = z.object({
  vault: address, units: z.number().int().min(1).max(4), principal: digits, interest: digits, minimum: digits, executionFee: digits,
  maxReserveShares: digits, minRateGrade: z.number().int().min(0).max(255), capBps: z.number().int().min(0).max(10_000), managerBps: z.number().int().min(0).max(10_000),
});
export const planSchema = z.object({
  engine: address, listingId: digits, filler: address, token: address, kind: z.number().int(), collateral: digits, principal: digits, cap: digits,
  term: z.number().int(), costBps: z.number().int().positive(), feePolicy: z.number().int(), epoch: digits, issuedAt: z.number().int(), expiry: z.number().int(),
  evidence: z.string().regex(/^0x[0-9a-fA-F]{64}$/), allocations: z.array(planAllocation).min(1).max(4),
});
const quoteSchema = z.object({
  schema: z.literal("gage-intent-quote-v2"),
  status: z.enum(["authorized", "eligible", "refused"]),
  refusal: refusal.nullable(),
  unsigned: refusal.nullable(),
  authorization: z.object({
    plan: planSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), expiresAt: z.number().int(), pricing: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  }).loose().nullable(),
}).loose();

/** A signed plan's fields as the chain takes them (`IntentQuoteVerifier.Plan`), from the service's decimal strings. */
function planOf(raw: z.output<typeof planSchema>): SignedPlan["plan"] {
  return {
    engine: raw.engine as Address, listingId: BigInt(raw.listingId), filler: raw.filler as Address, token: raw.token as Address, kind: raw.kind,
    collateral: BigInt(raw.collateral), principal: BigInt(raw.principal), cap: BigInt(raw.cap), term: raw.term, costBps: raw.costBps, feePolicy: raw.feePolicy,
    epoch: BigInt(raw.epoch), issuedAt: raw.issuedAt, expiry: raw.expiry, evidence: raw.evidence as Hex,
    allocations: raw.allocations.map((x) => ({ vault: x.vault as Address, units: x.units, principal: BigInt(x.principal), interest: BigInt(x.interest), minimum: BigInt(x.minimum),
      executionFee: BigInt(x.executionFee), maxReserveShares: BigInt(x.maxReserveShares), minRateGrade: x.minRateGrade, capBps: x.capBps, managerBps: x.managerBps })),
  };
}

export interface SignedPlan {
  plan: {
    engine: Address; listingId: bigint; filler: Address; token: Address; kind: number; collateral: bigint; principal: bigint; cap: bigint; term: number;
    costBps: number; feePolicy: number; epoch: bigint; issuedAt: number; expiry: number; evidence: Hex;
    allocations: { vault: Address; units: number; principal: bigint; interest: bigint; minimum: bigint; executionFee: bigint; maxReserveShares: bigint; minRateGrade: number; capBps: number; managerBps: number }[];
  };
  signature: Hex;
  pricing: Hex;
}

/**
 * Leverage's plan, signed ahead of the listing for the loop router and bound to `borrower` (30 seconds of life), checked
 * field by field against what was asked. PRICING_EXPIRED is asked again a few seconds on, as the card does.
 */
export async function loopPlan(
  rates: Upstream, a: { engine: Address; router: Address; borrower: Address; terms: Terms; deadline: number; allocations: Allocation[]; now: number },
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<SignedPlan> {
  const allocations = a.allocations.map((x) => `${x.vault.toLowerCase()}:${x.units}`).join(",");
  const path = `/intent/loop/quotes/${a.engine.toLowerCase()}?${termsQuery(a.terms, a.borrower)}&deadline=${a.deadline}&allocations=${allocations}`;
  for (let attempt = 1; ; attempt += 1) {
    const body = answer(quoteSchema, await rates.raw(path), "leverage quotes");
    const said = body.refusal ?? body.unsigned;
    if (body.status !== "authorized" || !body.authorization) {
      if (said?.code === "PRICING_EXPIRED" && attempt < 4) { await sleep(5_000); continue; }
      throw refused(said?.code, "The rates service did not sign this loop", "UNSIGNED");
    }
    const plan = planOf(body.authorization.plan), t = a.terms;
    const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    const asked = [...a.allocations].sort((x, y) => (BigInt(x.vault) < BigInt(y.vault) ? -1 : 1));
    const ok = same(plan.engine, a.engine) && same(plan.filler, a.router) && same(plan.token, t.token) && plan.kind === 0 && plan.collateral === t.collateral
      && plan.principal === t.principal && plan.cap === t.cap && plan.term === t.term && plan.expiry > a.now && plan.expiry === body.authorization.expiresAt
      && plan.allocations.length === asked.length && plan.allocations.every((x, i) => same(x.vault, asked[i]!.vault) && x.units === asked[i]!.units);
    const pricing = body.authorization.pricing as Hex | undefined;
    if (!ok || !pricing) throw new ApiError("PLAN_MISMATCH", "The signed plan is not the loop asked for; nothing was prepared", 409);
    return { plan, signature: body.authorization.signature as Hex, pricing };
  }
}

const rollSchema = z.object({
  schema: z.literal("gage-intent-roll-quote-v1"),
  status: z.enum(["authorized", "eligible", "refused"]),
  refusal: refusal.nullable(),
  unsigned: refusal.nullable(),
  router: address.nullable(),
  terms: z.object({ token: address, collateral: digits, principal: digits, cap: digits, term: z.number().int() }).loose().nullable(),
  wallet: z.object({ feeBps: z.number().int(), fee: digits, payout: digits, repayment: digits, topUp: digits, surplus: digits, allInBps: z.number().int() }).loose().nullable(),
  authorization: z.object({
    plans: z.array(z.object({ listingId: digits, plan: planSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).loose()).min(1).max(8),
    expiresAt: z.number().int(),
    pricing: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }).loose().nullable(),
}).loose();

/** A roll's new loan, raw units of the loan's asset. */
export interface RollTerms { principal: bigint; cap: bigint; term: number }
/** The roll in the wallet: the new loan's payout (its principal less the core's fee) against the old repayment. */
export interface RollWallet { feeBps: number; fee: bigint; payout: bigint; repayment: bigint; topUp: bigint; surplus: bigint }
export interface SignedRoll { plans: SignedPlan["plan"][]; signatures: Hex[]; pricing: Hex; expiresAt: number; terms: RollTerms; wallet: RollWallet }

/** What a roll asks the rates service: the loan, its holder and the new loan's term; `principal` is always the old one's. */
interface RollAsk { engine: Address; loanId: bigint; borrower: Address; term: number; count?: number }
const rollPath = (a: RollAsk) =>
  `/intent/roll/quotes/${a.engine.toLowerCase()}?loan=${a.loanId}&borrower=${a.borrower.toLowerCase()}&term=${a.term}&count=${a.count ?? 3}`;

/**
 * The wallet's part, held to the loan as the app holds it: the payout is the principal less the core's fee, rounded down
 * as the core rounds it, and the top-up what the payout leaves short of the old repayment `oldCap`, read from the chain.
 */
function walletOf(w: NonNullable<z.output<typeof rollSchema>["wallet"]>, t: RollTerms, oldCap: bigint): RollWallet | null {
  const fee = (t.principal * BigInt(w.feeBps)) / 10_000n, payout = t.principal - fee;
  const wallet = { feeBps: w.feeBps, fee: BigInt(w.fee), payout: BigInt(w.payout), repayment: BigInt(w.repayment), topUp: BigInt(w.topUp), surplus: BigInt(w.surplus) };
  const fits = wallet.fee === fee && wallet.payout === payout && wallet.repayment === oldCap
    && wallet.topUp === (oldCap > payout ? oldCap - payout : 0n) && wallet.surplus === (payout > oldCap ? payout - oldCap : 0n);
  return fits ? wallet : null;
}

/**
 * The roll's figures now: the new loan and the wallet's part, or the service's refusal as its own code. A roll keeps
 * the loan's size, as a roll by itself must (`PrincipalMismatch`): the new principal is the old one, or nothing is planned.
 */
export async function rollFigures(rates: Upstream, a: RollAsk & { oldPrincipal: bigint; oldCap: bigint }): Promise<{ terms: RollTerms; wallet: RollWallet }> {
  const body = answer(rollSchema, await rates.raw(rollPath(a)), "roll quotes");
  if (body.status === "refused" || !body.terms || !body.wallet) {
    const said = body.refusal ?? body.unsigned;
    throw refused(said?.code, "The partner vaults fund no roll of this loan now");
  }
  const terms = { principal: BigInt(body.terms.principal), cap: BigInt(body.terms.cap), term: body.terms.term };
  const wallet = walletOf(body.wallet, terms, a.oldCap);
  if (!wallet || terms.principal !== a.oldPrincipal || terms.term !== a.term) throw new ApiError("PLAN_MISMATCH", "The quoted roll is not this loan's; nothing was prepared", 409);
  return { terms, wallet };
}

/**
 * The roll's signed plans, checked field by field before anything is sent, as the app checks them: each for the loan's
 * core and named to its generation's router, on the old pledge to the unit, all on the same terms (the old principal)
 * for the core's next ids in a row, bound to the borrower (`evidence = keccak256(abi.encode(borrower, pricing))`, as
 * `RolloverRouter.evidenceFor`), and alive. PRICING_EXPIRED is asked again a few seconds on, as the app does.
 */
export async function rollPlan(
  rates: Upstream, a: RollAsk & { router: Address; token: Address; collateral: bigint; oldPrincipal: bigint; oldCap: bigint; now: () => number },
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<SignedRoll> {
  for (let attempt = 1; ; attempt += 1) {
    const body = answer(rollSchema, await rates.raw(rollPath(a)), "roll quotes");
    const said = body.refusal ?? body.unsigned;
    if (body.status !== "authorized" || !body.authorization || !body.terms || !body.wallet) {
      if (said?.code === "PRICING_EXPIRED" && attempt < 4) { await sleep(5_000); continue; }
      throw refused(said?.code, "The rates service did not sign this roll", "UNSIGNED");
    }
    const auth = body.authorization;
    const terms = { principal: BigInt(body.terms.principal), cap: BigInt(body.terms.cap), term: body.terms.term };
    const wallet = walletOf(body.wallet, terms, a.oldCap);
    const plans = auth.plans.map((p) => planOf(p.plan)), pricing = auth.pricing as Hex;
    const evidence = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [a.borrower, pricing])).toLowerCase();
    const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    const first = plans[0]!.listingId, now = a.now();
    const ok = wallet !== null && body.router !== null && same(body.router, a.router) && terms.principal === a.oldPrincipal && terms.term === a.term
      && plans.every((p, i) => same(p.engine, a.engine) && same(p.filler, a.router) && same(p.token, a.token) && p.kind === 0 && p.collateral === a.collateral
        && p.principal === terms.principal && p.cap === terms.cap && p.term === terms.term && p.listingId === first + BigInt(i) && p.listingId === BigInt(auth.plans[i]!.listingId)
        && p.evidence.toLowerCase() === evidence && p.expiry === auth.expiresAt && p.expiry > now);
    if (!ok) throw new ApiError("PLAN_MISMATCH", "The signed plans are not this roll; nothing was sent", 409);
    return { plans, signatures: auth.plans.map((p) => p.signature as Hex), pricing, expiresAt: auth.expiresAt, terms, wallet };
  }
}
