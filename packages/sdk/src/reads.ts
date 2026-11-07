/** The read tools: what an agent needs to decide, from the chain and gage's own services, private loans left out. */
import { maxUint256, zeroAddress, type Address } from "viem";
import type { AutoRollState } from "./chain.js";
import { accounting, claimablePockets, eachRead, everyPartnerVault, FOUND_UNREAD, fundsLoans, holding, indexerOf, listedPartnerVaults, loanRecord, partnerVaults, stateName, vaultLinks, vaultName, walletLoans } from "./data.js";
import { assetOf, lendAssetOf, lendsMore, putGenerations, putRouterOf, retiredCore, rolloverRouterOf, type Generation, type LendAsset } from "./deployment.js";
import { exitDesks, exitLine, exitOwed } from "./earnExit.js";
import { ApiError, requireThat } from "./errors.js";
import * as f from "./format.js";
import { instant, preview } from "./intent.js";
import { LP_RULE, lpCapabilities, lpHoldings } from "./lp.js";
import { actionsOn, defaultsFor } from "./networks.js";
import { PARK_RULE, parkPoolsIn, poolRow } from "./park.js";
import { pausedNow, aboveMinimum, capAt, checked, collateralOf, engineNamed, generationFor, leverageTerms, loopGenerationFor, listedPartner, lowestCost, priceExact, putGenerationFor, putTerms, refOf, termsOf, type Ctx } from "./plans.js";
import type { ActionName } from "./schemas.js";

/** What gage for agents leaves out (D222): a private loan stays private, so no read or action serves one. */
export const PRIVATE_RULE = "Private loans are never served: no read shows one and no action acts on one. They are opened and managed on gage.cash alone.";
/** The rules an agent must know before acting, in the design brief's words: no liquidation always with its definition. */
export const RULES = [
  "Loans have a fixed cost and a fixed term. There is no liquidation: the loan is never closed early because a price moves.",
  "If a loan is not repaid by the end of its term, the lenders keep the collateral, and nothing else is taken from the borrower.",
  "There is no grace period: repay before the term's last second.",
  "Lending goes through partner vaults only: deposit USDG into one with earn_deposit. A wallet cannot fund a loan directly.",
  "gage never signs, sends or holds a key. Every prepare answer is an unsigned transaction; the wallet's owner, or the owner's own agent, signs it.",
  PRIVATE_RULE,
] as const;
/**
 * What a loan in another asset means (D251), said once a lend asset is public. It names no term: each core's terms are
 * in `terms` and `lendAssets`, and mainnet offers no 1-day term (D241, D311).
 */
export const LEND_ASSET_RULE =
  "A loan in a lend asset (lendAssets) is paid out and repaid in that asset, and its vaults take and pay out that asset: in dollars, what you repay moves with its price. Leverage and sGAGE rewards are USDG's only.";
/** What a put is (docs/api.md "Puts on lend-asset generations"), said once a lend asset offers puts, with no liquidation's definition. */
export const PUT_RULE =
  "A put (put_open) borrows a lend asset against USDG, and its loan buys more USDG pledged with your margin: it gains as the asset falls, and its loss stops at the margin, since the loan is never closed early because a price moves. put_close repays it out of its own pledge and returns the rest in USDG.";

const lower = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);
const rawStr = (v: bigint) => v.toString();
/** The asset an answer's amounts are in, once a lend asset is public (D251); nothing before, so answers read as they did. */
const named = (c: Ctx, a: LendAsset) => (lendsMore(c.d) ? { asset: refOf(a) } : {});
/** A token's Borrow page on the network's own app by its short link (D290), as gage.cash gives it; null without one. */
const tokenLink = (c: Ctx, token: string) => {
  const link = c.d.tokenLinks.get(lower(token));
  return link === undefined ? null : `${defaultsFor(c.d.chainId).appUrl}/borrow/${link}`;
};
/** A partner vault's page on the network's own app by the short link the index names (D290); null without one. */
const vaultLink = (c: Ctx, links: ReadonlyMap<string, string>, vault: string) => {
  const link = links.get(lower(vault));
  return link === undefined ? null : `${defaultsFor(c.d.chainId).appUrl}/v/${link}`;
};
/** A registry's per-loan maximum, null where it sets none: a token listed on the Intent core has a minimum only (D276). */
const perLoan = (max: bigint) => (max === maxUint256 ? null : rawStr(max));

/** A term as gage's answers name one. */
const termRow = (seconds: number) => ({ seconds, days: seconds / 86_400 });

/** `actions`: the actions this Gage serves (all by default; the hosted service serves those its review page draws). */
export async function capabilities(c: Ctx, actions: readonly ActionName[] = actionsOn(c.d)) {
  const reg = c.d.core.registry;
  const [terms, feeBps, paused] = await Promise.all([termsOf(c, reg), c.chain.feeBps(reg), c.chain.paused(reg)]);
  // Each public lend asset (D251): its core, factory and terms, and the routers its loops and puts go through where it
  // names them; amounts of it are in its own decimals.
  const lent = c.d.generations.filter((g) => !g.primary);
  const lendAssets = await Promise.all(lent.map(async (g) => ({
    token: g.lendAsset.token, symbol: g.lendAsset.symbol, decimals: g.lendAsset.decimals, stable: g.lendAsset.stable, core: g.core.engine, factory: g.factory,
    terms: (await termsOf(c, g.core.registry)).map(termRow),
    ...(g.loopRouter ? { loopRouter: g.loopRouter } : {}), ...(g.putRouter ? { putRouter: g.putRouter } : {}),
    ...(g.rolloverRouter ? { rolloverRouter: g.rolloverRouter } : {}), ...(g.core.cashoutRouter ? { cashoutRouter: g.core.cashoutRouter } : {}),
  })));
  const n = defaultsFor(c.d.chainId);
  // What a rule says is what this Gage carries out: a lane or a put it does not serve is said by no rule of its.
  const puts = putGenerations(c.d).length > 0 && actions.includes("put_open");
  // The LP lane (D314, D315) once the release makes it public: its contracts, pools and the registry's settings.
  const lp = c.d.lpLane ? await lpCapabilities(c) : null;
  // Park and unpark (D334) where a pool is served: the pools, by the manager and id their actions name.
  const parks = actions.includes("park");
  const rules = [...RULES, ...(lent.length ? [LEND_ASSET_RULE, ...(puts ? [PUT_RULE] : [])] : []), ...(lp && actions.some((a) => a.startsWith("lp_")) ? [LP_RULE] : []), ...(parks ? [PARK_RULE] : [])];
  return {
    service: "gage for agents", network: n.network, chainId: c.d.chainId,
    contracts: { usdg: c.d.usdg, core: c.d.core.engine, factory: c.d.factory, loopRouter: c.d.loopRouter, rolloverRouter: rolloverRouterOf(c.d, c.d.core.engine), cashoutRouter: c.d.core.cashoutRouter },
    terms: terms.map(termRow), originationFeeBps: feeBps, newLoansPaused: paused,
    usdgDecimals: 6, actions: [...actions], rules: rules.length === RULES.length ? RULES : rules, app: n.appUrl,
    ...(lent.length ? { lendAssets } : {}),
    ...(lp ? { lpLane: lp } : {}),
    ...(parks ? { parkPools: parkPoolsIn(c).map(poolRow) } : {}),
  };
}

/**
 * The partner vaults of each generation that lend against a token now: those whose mandate names it and that fund loans,
 * a vault that buys running loans alone never among them (D452). Null where that generation's vaults could not be read:
 * unknown, never none. A listing is not a loan: a token no vault names is admitted and cannot be borrowed against yet.
 */
async function lendersOf(c: Ctx) {
  const { read } = await eachRead(c.d.generations, (g) => partnerVaults(indexerOf(c, g), c.d, g), (g) => g.id);
  const lending = (g: Generation, token: string) => read.find(({ x }) => x === g)?.r?.filter((v) => fundsLoans(v) && v.assets.some((t) => same(t, token))) ?? null;
  return {
    count: (g: Generation, token: string) => lending(g, token)?.length ?? null,
    /** The terms of `offered` that one of those vaults takes: a term only a stopped vault or none takes is not one a loan can be funded for now. */
    terms: (g: Generation, token: string, offered: readonly number[]) => {
      const vaults = lending(g, token);
      return vaults ? offered.filter((t) => vaults.some((v) => v.maxLoanTerm >= t)).map(termRow) : null;
    },
  };
}

export async function assets(c: Ctx) {
  const reg = c.d.core.registry;
  const stocks = c.d.assets.filter((a) => a.lane === "STOCK").map((a) => a.token);
  const [lenders, multipliers, stopped] = await Promise.all([lendersOf(c), c.chain.uiMultipliers(stocks), c.chain.tokensPaused(stocks)]);
  const shown = new Map(stocks.map((token, n) => [lower(token), multipliers[n] ?? null]));
  const multiple = (token: string) => shown.get(lower(token))?.toString() ?? null;
  // Whether a Stock Token is paused now (D213): what would move it waits, a pledge, a sale or a roll of it among them.
  const halted = new Set(stocks.filter((_, n) => stopped[n] === true).map(lower));
  const usdg = c.d.generations[0]!;
  const offered = await termsOf(c, reg);
  const rows = await Promise.all(c.d.assets.map(async (a) => {
    const cfg = await c.chain.tokenConfig(reg, a.token);
    return {
      token: a.token, symbol: a.symbol, name: a.name, decimals: a.decimals, lane: a.lane, allowed: cfg.allowed,
      minAmount: rawStr(cfg.minAmount), maxPerLoan: perLoan(cfg.maxDealRaw), leverage: c.d.loopRouter !== null && (c.d.loopPools.get(lower(a.token))?.length ?? 0) > 0,
      vaults: lenders.count(usdg, a.token), terms: lenders.terms(usdg, a.token, offered), paused: halted.has(lower(a.token)), uiMultiplier: multiple(a.token), link: tokenLink(c, a.token), ...named(c, usdg.lendAsset),
    };
  }));
  // A lend asset's generation lends against its own tokens (D249), each admitted by its own registry: one row per lend
  // asset a token is borrowed in, never leveraged: a lend asset's loop router opens puts alone (put_open, D313).
  const lent = await Promise.all(c.d.generations.filter((g) => !g.primary).map(async (g) => Promise.all(g.collateral.map(async (x) => {
    const a = await collateralOf(c, g, x.token);
    const [cfg, own] = await Promise.all([c.chain.tokenConfig(g.core.registry, a.token), termsOf(c, g.core.registry)]);
    return {
      token: a.token, symbol: a.symbol, name: a.name, decimals: a.decimals, lane: a.lane, allowed: cfg.allowed,
      minAmount: rawStr(cfg.minAmount), maxPerLoan: perLoan(cfg.maxDealRaw), leverage: false, vaults: lenders.count(g, a.token), terms: lenders.terms(g, a.token, own), paused: halted.has(lower(a.token)), uiMultiplier: multiple(a.token), link: tokenLink(c, a.token), asset: refOf(g.lendAsset),
    };
  }))));
  return { assets: [...rows, ...lent.flat()].filter((r) => r.allowed), ...(c.generationsUnread ? { status: "partial" as const, unread: [FOUND_UNREAD] } : {}) };
}

type QuoteInput = {
  token: string; term: number; wallet?: string | undefined; lendAsset?: string | undefined; maxCollateral?: string | undefined; collateral?: string | undefined;
  principal?: string | undefined; costBps?: number | undefined;
};

/**
 * A borrow quote: the largest loan the partner vaults fund now for at most `maxCollateral` (the borrow card's instant
 * loan), or, given an exact `collateral` and `principal`, that loan priced as the card prices an amount (D261); either at
 * the lowest fixed cost the vaults funding it accept (D384), or the exact loan at the borrower's own `costBps`.
 */
export async function borrowQuote(c: Ctx, i: QuoteInput) {
  const exact = i.collateral !== undefined || i.principal !== undefined;
  requireThat(exact ? i.collateral !== undefined && i.principal !== undefined && i.maxCollateral === undefined : i.maxCollateral !== undefined && i.costBps === undefined, "INVALID_INPUT",
    "Name maxCollateral for the largest loan the vaults fund, or collateral and principal (and costBps, for a cost of your own) for one exact loan", 400);
  // The generation the loan is borrowed from (D251): its core is asked, its registry's fee taken, its asset counted in.
  const g = generationFor(c, i.lendAsset), cash = g.lendAsset;
  const a = g.primary ? assetOf(c.d, i.token) : await collateralOf(c, g, i.token);
  requireThat(a, "UNSUPPORTED_COLLATERAL", "gage does not take this token as collateral");
  // A term gage does not offer is said as that, never as something of the token's.
  const terms = await termsOf(c, g.core.registry);
  requireThat(terms.includes(i.term), "TERM_NOT_ALLOWED", `Allowed terms: ${terms.map(f.days).join(", ")}`);
  // Under the token's minimum no vault can fund it: said with the minimum, before the rates service is asked.
  aboveMinimum(a, BigInt(exact ? i.collateral! : i.maxCollateral!), (await c.chain.tokenConfig(g.core.registry, a.token)).minAmount);
  if (exact) return exactQuote(c, i, g, a, BigInt(i.collateral!), BigInt(i.principal!));
  const core = g.core.engine, borrower = (i.wallet ?? core) as Address;
  const q = await instant(c.rates, core, a.token, BigInt(i.maxCollateral!), i.term, i.wallet as Address | undefined);
  // D384: the instant answer's size at the lowest cost the vaults funding it accept, from a reading of its own terms. A
  // reading that fails or no longer funds it whole leaves the instant answer's cost.
  const t = { token: a.token, collateral: q.collateral, principal: q.principal, term: i.term }, asked = Math.round(q.costBps * 10);
  const start = await checked(preview(c.rates, core, { ...t, cap: q.cap }, borrower));
  const low = start?.fills ? await lowestCost(c, core, t, a.lane, borrower, { tenths: asked, reading: start }) : null;
  const lowered = low !== null && low.tenths < asked, tenths = lowered ? low.tenths : asked, cap = lowered ? capAt(q.principal, tenths) : q.cap;
  const modelBps = low?.reading.modelBps ?? q.suggestedBps;
  const feeBps = await c.chain.feeBps(g.core.registry);
  const fee = (q.principal * BigInt(feeBps)) / 10_000n;
  return {
    summary: `Pledge ${f.token(q.collateral, a.decimals, a.symbol)}, receive ${f.money(q.principal - fee, cash)}, repay ${f.owedIn(cap, cash)} within ${f.days(i.term)}`,
    pledge: rawStr(q.collateral),
    // The instant answer's value is in the generation's asset: USDG's keeps its name, another asset's names its asset.
    ...(g.primary ? { collateralValueUSDG: rawStr(q.valueUSDG) } : { collateralValue: rawStr(q.valueUSDG) }),
    principal: rawStr(q.principal), receive: rawStr(q.principal - fee), originationFee: rawStr(fee),
    repay: rawStr(cap), costBps: tenths / 10, modelCostBps: modelBps, grade: gradeOf(tenths, modelBps), ltvBps: q.ltvBps, term: i.term,
    vaultsThatCanFund: low ? low.reading.vaults.filter((v) => v.options.length > 0).length : q.vaults,
    expiresAt: lowered && low.reading.expiresAt !== null ? Math.min(q.expiresAt, low.reading.expiresAt) : q.expiresAt, ...named(c, cash),
    prepare: { action: "borrow", token: a.token, collateral: rawStr(q.collateral), principal: rawStr(q.principal), cap: rawStr(cap), term: i.term, ...(g.primary ? {} : { lendAsset: cash.token }) },
    note: g.primary
      ? "The largest loan the partner vaults fund whole now, pledging only what it needs, at the lowest fixed cost they accept. Prices move: prepare soon after quoting."
      : `The largest loan the ${cash.symbol} vaults fund whole now, pledging only what it needs, at the lowest fixed cost they accept; it is paid out and repaid in ${cash.symbol}. Prices move: prepare soon after quoting.`,
  };
}

/** The Loan grades (D125), each with the least share of the model's cost of the loan it takes; F is under D. */
const GRADES = [["A", 100], ["B", 90], ["C", 75], ["D", 50]] as const;
/** A cost's Loan grade (D125), tenths of a basis point against the model's cost of the loan in bps; null without the model's. */
const gradeOf = (tenths: number, modelBps: number | null) => (modelBps === null ? null : GRADES.find(([, pct]) => tenths * 10 >= modelBps * pct)?.[0] ?? "F");
/**
 * The cheapest cost of each Loan grade A to D for the loan a reading prices, and how many vaults would take it now at that
 * cost, counted as the borrow card's ladder counts them (D189); null without the model's cost or the vaults' floors.
 */
function gradesOf(r: Awaited<ReturnType<typeof preview>>) {
  const { modelBps, floors } = r;
  if (modelBps === null || floors === null) return null;
  return GRADES.map(([grade, pct]) => {
    const tenths = Math.max(1, Math.ceil((modelBps * pct) / 10));
    return { grade, costBps: tenths / 10, vaults: floors.filter((floor) => floor <= tenths).length };
  });
}

/**
 * One exact loan priced as the borrow card prices an amount (D261, `priceExact`): the model's cost for that amount on
 * this pledge, raised while the vaults do not fund it whole to the model's for these exact terms and to the lowest the
 * vaults' settings take it whole at, and once they do, lowered to the lowest cost those funding it accept (D384);
 * `costBps`, the borrower's own, is read as it is. Whether the vaults fund it now, or it would wait for their room, and
 * the largest loan they take at this cost, are the funding preview's.
 */
async function exactQuote(c: Ctx, i: QuoteInput, g: ReturnType<typeof generationFor>, a: { token: Address; symbol: string; decimals: number; lane: string }, collateral: bigint, principal: bigint) {
  const cash = g.lendAsset, core = g.core.engine, borrower = (i.wallet ?? core) as Address;
  const own = i.costBps !== undefined;
  const { cap, tenths, value, preview: p } = await priceExact(c, g, a, collateral, principal, i.term, borrower, (most) =>
    new ApiError("PRINCIPAL_TOO_HIGH", `This pledge supports a loan of at most ${f.money(most, cash)} now; borrow less or pledge more`, 409, false,
      { details: { maxPrincipal: most.toString() } }), own ? { cost: Math.round(i.costBps! * 10) } : { lowest: true });
  const feeBps = await c.chain.feeBps(g.core.registry), fee = (principal * BigInt(feeBps)) / 10_000n;
  const costBps = Number(((cap - principal) * 100_000n) / principal) / 10;
  return {
    summary: `Pledge ${f.token(collateral, a.decimals, a.symbol)}, receive ${f.money(principal - fee, cash)}, repay ${f.owedIn(cap, cash)} within ${f.days(i.term)}`,
    mode: "exact", pledge: rawStr(collateral),
    ...(g.primary ? { collateralValueUSDG: rawStr(value) } : { collateralValue: rawStr(value) }),
    principal: rawStr(principal), receive: rawStr(principal - fee), originationFee: rawStr(fee), repay: rawStr(cap), costBps,
    modelCostBps: p.modelBps, grade: gradeOf(tenths, p.modelBps), grades: gradesOf(p),
    ltvBps: value > 0n ? Number((principal * 10_000n) / value) : null, term: i.term,
    fundsNow: p.fills, accepted: p.accepts, waitsFor: p.fills ? null : p.reason,
    lowestAcceptedCostBps: p.acceptFloorTenths === null ? null : p.acceptFloorTenths / 10,
    largestAccepted: p.acceptMaxPrincipal === null ? null : rawStr(p.acceptMaxPrincipal), ...named(c, cash),
    prepare: { action: "borrow", token: a.token, collateral: rawStr(collateral), principal: rawStr(principal), cap: rawStr(cap), term: i.term, ...(g.primary ? {} : { lendAsset: cash.token }) },
    note: p.fills
      ? own ? "The partner vaults fund this loan whole at this cost on gage's next pass. Prices move: prepare soon after quoting."
        : "The partner vaults fund this loan whole on gage's next pass, at the lowest fixed cost they accept. Prices move: prepare soon after quoting."
      : p.accepts === false
        ? "No partner vault's settings take this loan whole at this cost: raise it to lowestAcceptedCostBps, borrow up to largestAccepted, or pledge more."
        : "The partner vaults' settings take this loan, but none has the room for it now: listed, it waits for their cash.",
  };
}

/**
 * A loop's preview, in USDG (`loopGenerationFor`: a lend asset is refused, and its puts are quoted by `putQuote`). The
 * figures of a loop in another asset are named for what they are, in that asset, and its `prepare` names it.
 */
export async function leverageQuote(c: Ctx, i: { token: string; own: string; multiple: number; term: number; wallet?: string | undefined; lendAsset?: string | undefined }) {
  const g = loopGenerationFor(c, i.lendAsset), cash = g.lendAsset;
  const x = await leverageTerms(c, i.token, BigInt(i.own), i.multiple, i.term, i.wallet as Address | undefined, {}, g);
  return {
    summary: `Put in ${f.token(x.pledge, x.a.decimals, x.a.symbol)}, hold ${f.token(x.pledge + x.buy, x.a.decimals, x.a.symbol)} for a loan of ${f.money(x.principal, cash)}, repay ${f.owedIn(x.cap, cash)} within ${f.days(i.term)}`,
    own: rawStr(x.pledge), buy: rawStr(x.buy), held: rawStr(x.pledge + x.buy), principal: rawStr(x.principal), repay: rawStr(x.cap), costBps: x.costBps,
    ...(g.primary ? { maxPurchaseCostUSDG: rawStr(x.maxCost), pledgeValueUSDG: rawStr(x.valueUSDG) } : { maxPurchaseCost: rawStr(x.maxCost), pledgeValue: rawStr(x.valueUSDG), asset: refOf(cash) }),
    expiresAt: x.expiresAt,
    prepare: { action: "leverage", token: x.a.token, own: rawStr(x.pledge), multiple: i.multiple, term: i.term, maxCostBps: x.costBps, ...(g.primary ? {} : { lendAsset: cash.token }) },
    note: "A preview: nothing is signed or reserved. gage_prepare_leverage prices it again and refuses above maxCostBps.",
  };
}

/**
 * A put's preview (docs/api.md "Puts on lend-asset generations", `putTerms`): its margin, purchase and pledge in USDG,
 * its loan, repayment and the most its purchase costs in the lend asset (`asset`), the pledge's value in that asset, and
 * a `prepare` object for put_open, without its action.
 */
export async function putQuote(c: Ctx, i: { lendAsset: string; margin: string; size: number; term: number; wallet?: string | undefined }) {
  const g = putGenerationFor(c, i.lendAsset), cash = g.lendAsset;
  const x = await putTerms(c, g, BigInt(i.margin), i.size, i.term, i.wallet as Address | undefined);
  return {
    summary: `Put in ${f.usdg(x.own)}, hold ${f.usdg(x.pledge)} for a loan of ${f.money(x.principal, cash)}, repay ${f.owedIn(x.cap, cash)} within ${f.days(i.term)}`,
    margin: rawStr(x.own), buy: rawStr(x.buy), pledge: rawStr(x.pledge), principal: rawStr(x.principal), repay: rawStr(x.cap), costBps: x.costBps,
    ltvBps: x.value > 0n ? Number((x.principal * 10_000n) / x.value) : null, maxPurchaseCost: rawStr(x.maxCost), lands: rawStr(x.cash), pledgeValue: rawStr(x.value),
    asset: refOf(cash),
    prepare: { action: "put_open", lendAsset: cash.token, margin: rawStr(x.own), size: i.size, term: i.term, maxCostBps: x.costBps },
    note: `A preview: nothing is signed or reserved. It gains as ${cash.symbol} falls, and its loss stops at the margin. gage_prepare_put_open prices it again and refuses above maxCostBps.`,
  };
}

/** A token's symbol for an answer: the release's, a lend-asset generation's own list's (D249), else none. */
const symbolOf = (c: Ctx, token: string) =>
  assetOf(c.d, token)?.symbol ?? c.d.generations.flatMap((g) => g.collateral).find((x) => lower(x.token) === lower(token))?.symbol ?? null;

/** The standing roll instruction as the rollover router keeps it (`autoRolls`, D285), raw amounts in the loan's asset. */
const instructionOf = (a: AutoRollState) => ({
  borrower: a.borrower, executor: a.executor, term: a.term, window: a.window, rollsLeft: a.rollsLeft, withRewards: a.withRewards, until: a.until,
  maxCost: rawStr(a.maxCost), maxTopUp: rawStr(a.maxTopUp),
});
/** The same as a put router keeps it: its `maxCost` in the loan's asset, `maxSpend` in the pledge's token (read in `maxTopUp`'s place). */
const putInstructionOf = (a: AutoRollState) => ({
  borrower: a.borrower, executor: a.executor, term: a.term, window: a.window, rollsLeft: a.rollsLeft, withRewards: a.withRewards, until: a.until,
  maxCost: rawStr(a.maxCost), maxSpend: rawStr(a.maxTopUp),
});
/** Whether an instruction will still roll the loan for the holder of its right: theirs, with rolls and time left (the app's `autoRollOn`). */
const rollsByItself = (a: AutoRollState | null, holder: string | null | undefined, now: number) =>
  a !== null && !!holder && lower(a.borrower) === lower(holder) && a.rollsLeft > 0 && a.until > now;
/**
 * What an open loan on a generation the release keeps for its positions alone says (`retiredCore`): nothing rolls it, so
 * an instruction left on its routers is never run, and a loan left to one ends unpaid.
 */
const RETIRED_NOTE =
  "This loan's generation retired: gage rolls none of its loans over, by hand or by itself, and an instruction left on its routers never runs. Repay it before it ends, or the lenders keep the collateral.";

/**
 * One loan, and what can be done with it now, as the planner would take each action (plans.ts): `cancel` a listing;
 * `reclaim`, `cash_out` and `roll` a running loan before its end; `auto_roll` and `cancel_auto_roll` while it waits for
 * funding or runs; `collect` the collateral of a loan repaid or cancelled until it is taken. Each is listed only where
 * this network has it (a rollover router for the loan's generation, gage's keeper for a roll by itself, a cash-out
 * router that sells for the loan's core), and one this Gage does not serve (`served`; the hosted service serves those its
 * review page draws) is said to be done on the app, where the app offers it then: the app rolls a loan by hand in its
 * last day, and leaves one to roll by itself from its Borrow ticket or once it runs. `closedBy` names the router that
 * closed a repaid loan, whose collateral never comes back: a roll pledged it to the new loan, a cash-out sold it. Where
 * the loan's generation names a put router (docs/api.md "Puts on lend-asset generations"), a loan pledging another token
 * than its asset also closes and rolls through it (`put_close`, `put_roll`, `put_auto_roll`, `put_cancel_auto_roll`),
 * here only, and its standing instruction there is `putAutoRoll`. A loan on a generation the release keeps for its
 * positions alone (`retiredCore`) rolls no more, by hand or by itself: no roll is listed, neither instruction is shown
 * as one that rolls it (`autoRoll` and `putAutoRoll` are null), an open one says why (`note`), and an instruction left
 * there is still ended here (gage.cash offers none of these on it), as a put there still closes.
 */
export async function loan(c: Ctx, i: { loanId: string; engine?: string | undefined }, served: readonly ActionName[] = actionsOn(c.d)) {
  const engine = engineNamed(c, i.engine);
  const p = await loanRecord(c, engine.engine, i.loanId);
  const id = BigInt(i.loanId);
  const l = await c.chain.loan(engine.engine, id);
  const endsAt = l.fundedAt > 0 ? l.fundedAt + l.term : null;
  const pay = lendAssetOf(c.d, engine.engine), router = rolloverRouterOf(c.d, engine.engine), seller = engine.cashoutRouter;
  const putter = putRouterOf(c.d, engine.engine), puts = putter !== null && !same(l.token, pay.token), retired = retiredCore(c.d, engine.engine);
  // Whether it still runs is the chain's to say: the machine asking may be ahead of it or behind.
  const open = l.state === 1 || l.state === 2, running = l.state === 2 && endsAt !== null && (await c.chain.head()).timestamp < endsAt;
  const closedBy = l.state !== 3 ? null : router && same(l.collateralBeneficiary, router) ? "roll" as const
    : seller && same(l.collateralBeneficiary, seller) ? "cash_out" as const : null;
  // A cash-out is this Gage's where its router sells through an aggregator (D245) and a valuation service builds the
  // sale; a router from before such sales answers no `executorAllowed`, and its loans cash out on the app.
  // One with no flash pool (a v4 router) takes another sale than the SDK builds: its loans cash out on the app too.
  const sells = async () => (served.includes("cash_out") && c.valuation && seller ? await c.chain.cashoutExecutorAllowed(seller, zeroAddress) !== null && await c.chain.cashoutFlashPool(seller) !== null : false);
  // Whether the pledge can move now (D213): a read that fails is no pause, and every action is said as ever.
  const collateralPaused = l.state !== 4 && await pausedNow(c, l.token);
  const [instruction, paused, here, released, putInstruction, putPaused] = await Promise.all([
    router && open ? c.chain.autoRoll(router, id) : null,
    router && open && !retired ? c.chain.rolloverPaused(router) : false,
    running && seller && !same(l.token, pay.token) && !collateralPaused ? sells() : false,
    // Whether the collateral was taken back; an account that does not answer is read as not, so collect is still said.
    (l.state === 3 || l.state === 5) && !closedBy ? c.chain.released(l.account).catch(() => false) : true,
    // The put router keeps its own instructions, and answers the rollover router's reads (`paused`, `autoRolls`).
    putter && puts && open ? c.chain.autoRoll(putter, id) : null,
    putter && puts && open ? c.chain.rolloverPaused(putter) : false,
  ]);
  const host = new URL(defaultsFor(c.d.chainId).appUrl).host;
  /** An action and who takes it: here when this Gage serves it, else on the app when the app offers it now (`onApp`). */
  const way = (action: ActionName, who: string, onApp: string | null = who) =>
    (served.includes(action) ? [`${action} (${who})`] : onApp === null ? [] : [`${action} on ${host} (${onApp})`]);
  const holder = "holder of the reclaim right", left = "the wallet that left the instruction";
  // Nothing rolls a loan on a retained generation; gage.cash offers neither a roll nor the end of an instruction on one.
  const rolls = router !== null && !paused && !retired, keeper = rolls && c.d.rolloverExecutor !== null, movable = !collateralPaused;
  // The put router's actions, done here alone: gage.cash does not offer them.
  const putting = puts && !putPaused && movable, putRolls = putting && !retired, putKeeper = putRolls && c.d.rolloverExecutor !== null;
  const actions = l.state === 1
    ? [
      ...way("cancel", "borrower"), ...(keeper ? way("auto_roll", holder, null) : []), ...(instruction ? way("cancel_auto_roll", left, null) : []),
      ...(putKeeper ? way("put_auto_roll", holder, null) : []), ...(putInstruction ? way("put_cancel_auto_roll", left, null) : []),
    ]
    : running
      ? [
        ...way("reclaim", `${holder}, before endsAt`),
        ...(here ? [`cash_out (${holder}, before endsAt)`] : movable && seller && !same(l.token, pay.token) ? [`cash_out on ${host} (${holder}, before endsAt)`] : []),
        ...(rolls && movable ? way("roll", `${holder}, before endsAt`, `${holder}, in the loan's last day`) : []),
        ...(keeper ? way("auto_roll", holder) : []),
        ...(instruction ? way("cancel_auto_roll", left, retired ? null : left) : []),
        ...(putting ? way("put_close", `${holder}, before endsAt`, null) : []),
        ...(putRolls ? way("put_roll", `${holder}, before endsAt`, null) : []),
        ...(putKeeper ? way("put_auto_roll", holder, null) : []),
        ...(putInstruction ? way("put_cancel_auto_roll", left, null) : []),
      ]
      : !released && movable ? way("collect", "collateral back to the borrower") : [];
  return {
    engine: engine.engine, loanId: i.loanId, state: stateName(l.state), borrower: l.originator, reclaimRightHolder: p.owner ?? null,
    token: l.token, symbol: symbolOf(c, l.token), collateral: rawStr(l.collateral), principal: rawStr(l.principal), repay: rawStr(l.cap),
    costBps: l.principal > 0n ? Number(((l.cap - l.principal) * 10_000n) / l.principal) : null, term: l.term,
    fundedQuarters: l.filled, fundingDeadline: l.state === 1 ? l.fundingDeadline : null, fundedAt: l.fundedAt || null, endsAt, collateralPaused,
    lenders: p.slots.filter((s) => BigInt(s) !== 0n),
    // An instruction left on a retained generation's router is never run: none is shown as one that rolls the loan.
    actions, closedBy, autoRoll: instruction && !retired ? instructionOf(instruction) : null,
    ...(puts ? { putAutoRoll: putInstruction && !retired ? putInstructionOf(putInstruction) : null } : {}),
    ...named(c, pay),
    ...(retired && open ? { note: RETIRED_NOTE } : {}),
  };
}

/** `served`: the actions this Gage serves, by which an LP loan's actions are said to be done here or on the app. */
export async function portfolio(c: Ctx, wallet: Address, served: readonly ActionName[] = actionsOn(c.d)) {
  const w = lower(wallet), now = c.now();
  // Every core a wallet's loans and credits can sit on: the USDG engines, then each lend asset's core (D251), current or retained.
  const cores = [...c.d.engines, ...[...c.d.generations, ...c.d.retired].filter((g) => !g.primary).map((g) => g.core)];
  // Each core is read on its own, its credit the chain's and its loans the index's: one that does not answer is named in
  // `unread` (D412), and leaves the other.
  const [creditReads, loanReads] = await Promise.all([
    eachRead(cores, (e) => c.chain.cashCredit(e.engine, wallet), (e) => `${lendAssetOf(c.d, e.engine).symbol} credit on core ${e.engine}`),
    eachRead(cores, (e) => walletLoans(c, e.engine, wallet), (e) => `${lendAssetOf(c.d, e.engine).symbol} loans on core ${e.engine}`),
  ]);
  const engines = cores.map((e) => ({ e, credit: creditReads.read.find(({ x }) => x === e)?.r ?? 0n, loans: loanReads.read.find(({ x }) => x === e)?.r ?? [] }));
  // Each loan's sGAGE is read and claimed at its engine's rewards contract, as the app's Portfolio reads it; a loan the
  // index allocated no reward owes none. A loan waiting for funding or running may roll by itself (D285), unless its
  // generation is one the release keeps for its positions alone, whose loans nothing rolls: such an open loan says so.
  const loans = await Promise.all(engines.flatMap(({ e, loans: ls }) => ls.filter((p) => lower(p.loan.originator) === w || (p.owner && lower(p.owner) === w)).map(async (p) => {
    const id = BigInt(p.id), router = rolloverRouterOf(c.d, e.engine), open = p.loan.state === 1 || p.loan.state === 2;
    // A put rolls by itself through its generation's put router (docs/api.md "Puts on lend-asset generations").
    const putter = putRouterOf(c.d, e.engine), retired = retiredCore(c.d, e.engine), rollable = open && !retired;
    const [sgage, instruction, putInstruction] = await Promise.all([
      BigInt(p.loan.borrowerReward) > 0n || BigInt(p.loan.lenderReward) > 0n ? c.chain.loanRewards(e.rewards, id, wallet) : 0n,
      router && rollable ? c.chain.autoRoll(router, id) : null,
      putter && rollable && !same(p.loan.token, lendAssetOf(c.d, e.engine).token) ? c.chain.autoRoll(putter, id) : null,
    ]);
    return {
      engine: e.engine, loanId: p.id, state: stateName(p.loan.state), token: p.loan.token, symbol: symbolOf(c, p.loan.token), collateral: p.loan.collateral, principal: p.loan.principal, repay: p.loan.cap,
      term: p.loan.term, endsAt: p.loan.fundedAt > 0 ? p.loan.fundedAt + p.loan.term : null, sgageClaimable: rawStr(sgage),
      autoRoll: rollsByItself(instruction, p.owner, now) || rollsByItself(putInstruction, p.owner, now),
      ...named(c, lendAssetOf(c.d, e.engine)),
      ...(retired && open ? { note: RETIRED_NOTE } : {}),
    };
  })));
  const [listed, links] = await Promise.all([everyPartnerVault(c), vaultLinks(c.indexer)]);
  const heldReads = await eachRead(listed.vaults, ({ v, g }) => indexerOf(c, g).get(`/intent/partners/vaults/${lower(v.address)}/position/${w}`, holding),
    ({ v }) => `the holding in ${vaultName(v, c.d)} (${v.address})`);
  const held = heldReads.read.map(({ x: { v, g }, r: h }) => ({ v, g, h }));
  const unread = [...creditReads.unread, ...loanReads.unread, ...listed.unread, ...heldReads.unread];
  const ready = await claimablePockets(c, held.map(({ g, h }) => ({ engine: g.core.engine, pockets: h.pockets, backing: h.backing })));
  // Where the release names the chain's exit desk (Intent D57): each holding's open exit, and what the desk owes the
  // wallet, read from the desk each factory bound, as the app's Portfolio reads them.
  const desks = await exitDesks(c, true);
  const holdings = await Promise.all(held
    // Every pocket ready, a written-off loan's backing counted pocket by pocket as the index sums it (D414).
    .map(({ v, g, h }, n) => ({ v, g, h, claimable: ready[n]!.pockets.length + ready[n]!.backing.reduce((sum, b) => sum + b.pockets, 0) }))
    .filter(({ h, claimable }) => BigInt(h.shares) > 0n || claimable > 0 || BigInt(h.rewards) > 0n)
    // A USDG vault keeps its USDG-named figures; another asset's are named for what they are, in its asset (D251).
    .map(async ({ v, g, h, claimable }) => ({
      vault: v.address, name: vaultName(v, c.d), link: vaultLink(c, links, v.address), shares: h.shares,
      ...(g.primary ? { valueUSDG: h.value, withdrawableNowUSDG: h.withdrawableNow } : { value: h.value, withdrawableNow: h.withdrawableNow }),
      claimsReady: claimable, rewards: h.rewards, ...named(c, g.lendAsset),
      ...(g.exitDesk !== null ? { exit: await exitLine(c, desks, g, v.address as Address, wallet, BigInt(h.shares), BigInt(h.value), now) } : {}),
    })));
  const owed = desks.length ? await exitOwed(c, wallet, desks) : null;
  const credit = engines.filter(({ e }) => lendAssetOf(c.d, e.engine).token === c.d.usdg).reduce((sum, x) => sum + x.credit, 0n);
  // Each lend asset's credit beside USDG's, never added to it.
  const credits = engines.filter(({ e, credit: x }) => lendAssetOf(c.d, e.engine).token !== c.d.usdg && x > 0n).map(({ e, credit: x }) => ({ ...refOf(lendAssetOf(c.d, e.engine)), amount: rawStr(x) }));
  // The LP lane's part (D314, D315) once the release makes it public: its loans, credits, vault shares and bonuses.
  const lp = c.d.lpLane ? await lpHoldings(c, wallet, served) : null;
  return {
    wallet, loans, earn: holdings, usdgCredit: rawStr(credit), ...(lendsMore(c.d) ? { credits } : {}),
    ...(owed ? { exitOwed: owed.map((x) => ({ desk: x.desk, ...refOf(x.asset), amount: rawStr(x.amount) })) } : {}),
    ...(lp ? { lp } : {}),
    ...(unread.length ? { status: "partial" as const, unread } : {}),
    note: (lp
      ? "Loans this wallet borrowed (open, running and closed) and its Earn holdings; sgageClaimable and rewards are raw sGAGE (18 decimals). gage_prepare_collect gathers what is ready to collect here. lp is the LP lane: its loans, what its core credits the wallet (lp_withdraw), and each LP vault's shares (raw, in its shareDecimals), their worth in raw USDG and the bonuses to claim (lp_claim_bonus)."
      : "Loans this wallet borrowed (open, running and closed) and its Earn holdings; sgageClaimable and rewards are raw sGAGE (18 decimals). gage_prepare_collect gathers what is ready to collect here.")
      + (lp?.vaults.some((v) => "sgageClaimable" in v) ? " A reserve LP vault's sgageClaimable is claimed with lp_claim_rewards, apart from what gage_prepare_collect gathers; its null is a read that failed, as is a null valueUSDG." : "")
      + (owed ? ` ${EXIT_NOTE}` : "") + (unread.length ? ` ${UNREAD_NOTE}` : ""),
  };
}

/** What a portfolio says of the parts it could not read just now (D412). */
const UNREAD_NOTE = "unread names what could not be read just now: those loans, credits or holdings are missing here, not empty. Read the portfolio again shortly.";

/** What a portfolio's exits say, where the release names the chain's exit desk (Intent D57). */
const EXIT_NOTE = "exit is the wallet's open exit now from a vault (null for none): its shares (raw) and what they are worth (committed, raw), its stage (listed: loanId is for sale until listingEndsAt; next: earn_exit_list lists the next loan, and gage's keeper may; closed: exits are closed, and nothing is listed until they reopen; payable: the vault can pay the rest now, so withdraw it with earn_redeem; lapsed: nothing is listed or paid for it, and earn_exit_now commits again) and when its request lapses (lapsesAt); earn_exit_cancel withdraws it. exitOwed is what exit sales paid the wallet, raw, by desk and asset: earn_exit_collect receives it, and gage_prepare_collect gathers it with the rest.";

export async function earnVaults(c: Ctx) {
  const [{ vaults, cut }, links] = await Promise.all([listedPartnerVaults(c), vaultLinks(c.indexer)]);
  const rows = await Promise.all(vaults.map(async ({ v, g }) => {
    const acc = await indexerOf(c, g).get(`/intent/partners/vaults/${lower(v.address)}/accounting`, accounting);
    return {
      // A vault that buys running loans alone funds no new one: it says so, and is not a lender (D452).
      vault: v.address, name: vaultName(v, c.d), manager: v.curator, link: vaultLink(c, links, v.address), lends: fundsLoans(v), ...(v.buysOnly === true ? { buysOnly: true as const } : {}),
      performanceFeeBps: v.feeBps, longestLoanDays: v.maxLoanTerm / 86_400,
      tokens: v.assets.map((t) => symbolOf(c, t) ?? t),
      // A USDG vault keeps its USDG-named figures; another asset's are named for what they are, in its asset (D251).
      ...(g.primary
        ? { totalAssetsUSDG: acc.pricing.totalAssets, freeCashUSDG: acc.liquidity.free, usdgPerShare: acc.pricing.assetsPerShare }
        : { totalAssets: acc.pricing.totalAssets, freeCash: acc.liquidity.free, assetsPerShare: acc.pricing.assetsPerShare }),
      ...named(c, g.lendAsset),
    };
  }));
  return {
    vaults: rows,
    // The most a list reads is 1,000 vaults a factory, in address order: past it, it says so.
    ...(cut.length ? { status: "partial" as const, unread: cut } : {}),
    note: lendsMore(c.d)
      ? "Each vault's figures are raw units of its asset (asset): usdgPerShare or assetsPerShare is what one whole share (10^18) redeems for now. Deposits lend through the vault's loans; withdrawals are paid up to its free cash. A vault's name is its manager's own text, and anyone may create a vault: choose by vault and manager."
      : "usdgPerShare is the raw USDG one whole share (10^18) redeems for now. Deposits lend through the vault's loans; withdrawals are paid up to its free cash. A vault's name is its manager's own text, and anyone may create a vault: choose by vault and manager.",
  };
}

/** What a free-cash answer says (D335), its figures named as the vault's asset names them. */
const freeCashNote = (free: string, settling: string) =>
  `${free} is what withdrawals are paid from now. schedule says what comes back to it as the vault's loans end, one entry a day (by: unix seconds, the day's last end), and ${settling} what loans past their end bring back once settled: both only if their borrowers repay, at most these amounts, sooner if repaid early. A loan not repaid brings back no cash: its collateral goes to the vault's holders. New loans may use free cash again down to bufferBps of the vault's value (Cash kept free), never below it; withdrawals are never held to it. While settlementDue, withdrawals wait for the next settle.`;

/**
 * One partner vault's free cash (D335): what its withdrawals can be paid from now, what comes back to it as its loans
 * end (`schedule`, by day, and `settling`, what the next settle books), if their borrowers repay, and the share of the
 * vault a new loan must leave free (`bufferBps`). Raw units of the vault's asset.
 */
export async function vaultFreeCash(c: Ctx, i: { vault: string }) {
  const { address, v, g } = await listedPartner(c, i.vault);
  const [acc, links] = await Promise.all([
    indexerOf(c, g).get(`/intent/partners/vaults/${lower(address)}/accounting`, accounting),
    vaultLinks(c.indexer),
  ]);
  // An index before D335 sends neither: unknown, never an empty schedule.
  const { schedule = null, settling = null } = acc.liquidity;
  const units = g.primary ? "Raw USDG (6 decimals)" : `Raw units of the vault's asset (asset, ${g.lendAsset.decimals} decimals)`;
  return {
    vault: v.address, name: vaultName(v, c.d), link: vaultLink(c, links, v.address),
    // A USDG vault keeps its USDG-named figures; another asset's are named for what they are, in its asset (D251).
    ...(g.primary
      ? { freeCashUSDG: acc.liquidity.free, settlingUSDG: settling, schedule: schedule && schedule.map((d) => ({ by: d.by, amountUSDG: d.amount })), totalAssetsUSDG: acc.pricing.totalAssets }
      : { freeCash: acc.liquidity.free, settling, schedule: schedule && schedule.map((d) => ({ by: d.by, amount: d.amount })), totalAssets: acc.pricing.totalAssets }),
    bufferBps: v.settings?.bufferBps ?? null,
    settlementDue: acc.settlement?.due ?? false,
    ...named(c, g.lendAsset),
    note: `${units}. ${g.primary ? freeCashNote("freeCashUSDG", "settlingUSDG") : freeCashNote("freeCash", "settling")}${schedule === null ? " schedule and settling are null: this index does not serve them yet." : ""}`,
  };
}

/** What a wallet holds for gage: ETH for its gas, USDG, and each collateral token and lend asset it has, in raw units. */
export async function balances(c: Ctx, wallet: Address) {
  // Each public lend asset the release does not already list as collateral (D251).
  const lent = c.d.generations.filter((g) => !g.primary && !assetOf(c.d, g.lendAsset.token)).map((g) => g.lendAsset);
  const [eth, usdg, tokens] = await Promise.all([
    c.chain.nativeBalance(wallet), c.chain.balance(c.d.usdg, wallet),
    Promise.all([...c.d.assets, ...lent].map(async (a) => ({ token: a.token, symbol: a.symbol, decimals: a.decimals, balance: await c.chain.balance(a.token, wallet) }))),
  ]);
  return {
    wallet, eth: rawStr(eth), usdg: rawStr(usdg),
    tokens: tokens.filter((t) => t.balance > 0n).map((t) => ({ ...t, balance: rawStr(t.balance) })),
    note: "Raw units: ETH has 18 decimals and pays the gas, USDG 6, each token its own.",
  };
}
