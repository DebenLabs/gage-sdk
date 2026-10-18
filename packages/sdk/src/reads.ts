/** The read tools: what an agent needs to decide, from the chain and gage's own services, private loans left out. */
import { maxUint256, zeroAddress, type Address } from "viem";
import type { AutoRollState } from "./chain.js";
import { accounting, allPartnerVaults, claimablePockets, holding, loanRecord, stateName, vaultLinks, vaultName, walletLoans } from "./data.js";
import { assetOf, engineOf, lendAssetOf, lendsMore, rolloverRouterOf, type LendAsset } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import * as f from "./format.js";
import { instant, preview, suggestCurve } from "./intent.js";
import { actionsOn, defaultsFor } from "./networks.js";
import { aboveMinimum, collateralOf, generationFor, leverageTerms, refOf, termsOf, usdgOnly, type Ctx } from "./plans.js";
import type { ActionName } from "./schemas.js";

/** The rules an agent must know before acting, in the design brief's words: no liquidation always with its definition. */
export const RULES = [
  "Loans have a fixed cost and a fixed term. There is no liquidation: the loan is never closed early because a price moves.",
  "If a loan is not repaid by the end of its term, the lenders keep the collateral, and nothing else is taken from the borrower.",
  "There is no grace period: repay before the term's last second.",
  "Lending goes through partner vaults only: deposit USDG into one with earn_deposit. A wallet cannot fund a loan directly.",
  "gage never signs, sends or holds a key. Every prepare answer is an unsigned transaction; the wallet's owner, or the owner's own agent, signs it.",
] as const;
/** What a loan in another asset means (D251), said once a lend asset is public. */
export const LEND_ASSET_RULE =
  "A loan in a lend asset (lendAssets) is paid out and repaid in that asset, and its vaults take and pay out that asset: in dollars, what you repay moves with its price. Leverage, 1-day loans and sGAGE rewards are USDG's only.";

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

/** `actions`: the actions this Gage serves (all by default; the hosted service serves those its review page draws). */
export async function capabilities(c: Ctx, actions: readonly ActionName[] = actionsOn(c.d)) {
  const reg = c.d.core.registry;
  const [terms, feeBps, paused] = await Promise.all([termsOf(c, reg), c.chain.feeBps(reg), c.chain.paused(reg)]);
  // Each public lend asset (D251): its core, factory and terms; amounts of it are in its own decimals.
  const lent = c.d.generations.filter((g) => !g.primary);
  const lendAssets = await Promise.all(lent.map(async (g) => ({
    token: g.lendAsset.token, symbol: g.lendAsset.symbol, decimals: g.lendAsset.decimals, stable: g.lendAsset.stable, core: g.core.engine, factory: g.factory,
    terms: (await termsOf(c, g.core.registry)).map((t) => ({ seconds: t, days: t / 86_400 })),
  })));
  const n = defaultsFor(c.d.chainId);
  return {
    service: "gage for agents", network: n.network, chainId: c.d.chainId,
    contracts: { usdg: c.d.usdg, core: c.d.core.engine, factory: c.d.factory, loopRouter: c.d.loopRouter },
    terms: terms.map((t) => ({ seconds: t, days: t / 86_400 })), originationFeeBps: feeBps, newLoansPaused: paused,
    usdgDecimals: 6, actions: [...actions], rules: lent.length ? [...RULES, LEND_ASSET_RULE] : RULES, app: n.appUrl,
    ...(lent.length ? { lendAssets } : {}),
  };
}

export async function assets(c: Ctx) {
  const reg = c.d.core.registry;
  const rows = await Promise.all(c.d.assets.map(async (a) => {
    const cfg = await c.chain.tokenConfig(reg, a.token);
    return {
      token: a.token, symbol: a.symbol, name: a.name, decimals: a.decimals, lane: a.lane, allowed: cfg.allowed,
      minAmount: rawStr(cfg.minAmount), maxPerLoan: perLoan(cfg.maxDealRaw), leverage: c.d.loopRouter !== null && (c.d.loopPools.get(lower(a.token))?.length ?? 0) > 0,
      link: tokenLink(c, a.token), ...named(c, c.d.generations[0]!.lendAsset),
    };
  }));
  // A lend asset's generation lends against its own tokens (D249), each admitted by its own registry: one row per lend
  // asset a token is borrowed in, never leveraged.
  const lent = await Promise.all(c.d.generations.filter((g) => !g.primary).map(async (g) => Promise.all(g.collateral.map(async (x) => {
    const a = await collateralOf(c, g, x.token);
    const cfg = await c.chain.tokenConfig(g.core.registry, a.token);
    return {
      token: a.token, symbol: a.symbol, name: a.name, decimals: a.decimals, lane: a.lane, allowed: cfg.allowed,
      minAmount: rawStr(cfg.minAmount), maxPerLoan: perLoan(cfg.maxDealRaw), leverage: false, link: tokenLink(c, a.token), asset: refOf(g.lendAsset),
    };
  }))));
  return { assets: [...rows, ...lent.flat()].filter((r) => r.allowed) };
}

type QuoteInput = { token: string; term: number; wallet?: string | undefined; lendAsset?: string | undefined; maxCollateral?: string | undefined; collateral?: string | undefined; principal?: string | undefined };

/**
 * A borrow quote: the largest loan the partner vaults fund now for at most `maxCollateral` (the borrow card's instant
 * loan), or, given an exact `collateral` and `principal`, that loan priced as the card prices an amount (D261).
 */
export async function borrowQuote(c: Ctx, i: QuoteInput) {
  const exact = i.collateral !== undefined || i.principal !== undefined;
  requireThat(exact ? i.collateral !== undefined && i.principal !== undefined && i.maxCollateral === undefined : i.maxCollateral !== undefined, "INVALID_INPUT",
    "Name maxCollateral for the largest loan the vaults fund, or collateral and principal for one exact loan", 400);
  // The generation the loan is borrowed from (D251): its core is asked, its registry's fee taken, its asset counted in.
  const g = generationFor(c, i.lendAsset), cash = g.lendAsset;
  const a = g.primary ? assetOf(c.d, i.token) : await collateralOf(c, g, i.token);
  requireThat(a, "UNSUPPORTED_COLLATERAL", "gage does not take this token as collateral");
  // Under the token's minimum no vault can fund it: said with the minimum, before the rates service is asked.
  aboveMinimum(a, BigInt(exact ? i.collateral! : i.maxCollateral!), (await c.chain.tokenConfig(g.core.registry, a.token)).minAmount);
  if (exact) return exactQuote(c, i, g, a, BigInt(i.collateral!), BigInt(i.principal!));
  const q = await instant(c.rates, g.core.engine, a.token, BigInt(i.maxCollateral!), i.term, i.wallet as Address | undefined);
  const feeBps = await c.chain.feeBps(g.core.registry);
  const fee = (q.principal * BigInt(feeBps)) / 10_000n;
  return {
    summary: `Pledge ${f.token(q.collateral, a.decimals, a.symbol)}, receive ${f.money(q.principal - fee, cash)}, repay ${f.owedIn(q.cap, cash)} within ${f.days(i.term)}`,
    pledge: rawStr(q.collateral),
    // The instant answer's value is in the generation's asset: USDG's keeps its name, another asset's names its asset.
    ...(g.primary ? { collateralValueUSDG: rawStr(q.valueUSDG) } : { collateralValue: rawStr(q.valueUSDG) }),
    principal: rawStr(q.principal), receive: rawStr(q.principal - fee), originationFee: rawStr(fee),
    repay: rawStr(q.cap), costBps: q.costBps, ltvBps: q.ltvBps, term: i.term, vaultsThatCanFund: q.vaults, expiresAt: q.expiresAt, ...named(c, cash),
    prepare: { action: "borrow", token: a.token, collateral: rawStr(q.collateral), principal: rawStr(q.principal), cap: rawStr(q.cap), term: i.term, ...(g.primary ? {} : { lendAsset: cash.token }) },
    note: g.primary
      ? "The largest loan the partner vaults fund whole now, pledging only what it needs. Prices move: prepare soon after quoting."
      : `The largest loan the ${cash.symbol} vaults fund whole now, pledging only what it needs; it is paid out and repaid in ${cash.symbol}. Prices move: prepare soon after quoting.`,
  };
}

/** How much of a pledge's value a loan may repay, as the model is asked (70% for memes, 90% for stocks and ETH). */
const repaymentLimitBps = (lane: string) => (lane === "MEME" ? 7_000 : 9_000);
/** A cost in tenths of a basis point, as the vaults' floors read it, applied to a principal: the repayment, rounded up. */
const capAt = (principal: bigint, tenths: number) => principal + (principal * BigInt(tenths) + 99_999n) / 100_000n;

/**
 * One exact loan priced as the borrow card prices an amount (D261): its cost is the model's for that amount on this
 * pledge (the size curve's first point at or above it), raised to the model's cost of these exact terms when that is
 * higher, and to the lowest cost at which the vaults' settings take the loan whole when they refuse it at this one, in
 * at most three readings of the funding preview. Whether the vaults fund it now, or it would wait for their room, and
 * the largest loan they take at this cost, are the preview's.
 */
async function exactQuote(c: Ctx, i: QuoteInput, g: ReturnType<typeof generationFor>, a: { token: Address; symbol: string; decimals: number; lane: string }, collateral: bigint, principal: bigint) {
  const cash = g.lendAsset, core = g.core.engine, borrower = (i.wallet ?? core) as Address;
  const terms = await termsOf(c, g.core.registry);
  requireThat(terms.includes(i.term), "TERM_NOT_ALLOWED", `Allowed terms: ${terms.map(f.days).join(", ")}`);
  const sized = await suggestCurve(c.rates, { chainId: c.d.chainId, engine: core, token: a.token, collateral, term: i.term, maxRepaymentBps: repaymentLimitBps(a.lane), ...(g.primary ? {} : { asset: cash.token }) });
  const at = sized.curve.find((p) => p.principal >= principal);
  const most = sized.curve.at(-1)?.principal ?? 0n;
  if (!at) {
    throw new ApiError("PRINCIPAL_TOO_HIGH", `This pledge supports a loan of at most ${f.money(most, cash)} now; borrow less or pledge more`, 409, false,
      { details: { maxPrincipal: most.toString() } });
  }
  let tenths = at.costBps * 10;
  let p = await preview(c.rates, core, { token: a.token, collateral, principal, cap: capAt(principal, tenths), term: i.term }, borrower);
  for (let pass = 1; pass < 3; pass += 1) {
    const model = p.modelBps === null ? 0 : p.modelBps * 10, floor = p.accepts === false ? p.acceptFloorTenths ?? 0 : 0;
    const raised = Math.max(model, floor);
    if (raised <= tenths || raised > 50_000) break;
    tenths = raised;
    p = await preview(c.rates, core, { token: a.token, collateral, principal, cap: capAt(principal, tenths), term: i.term }, borrower);
  }
  const cap = capAt(principal, tenths), feeBps = await c.chain.feeBps(g.core.registry), fee = (principal * BigInt(feeBps)) / 10_000n;
  const costBps = Number(((cap - principal) * 100_000n) / principal) / 10;
  return {
    summary: `Pledge ${f.token(collateral, a.decimals, a.symbol)}, receive ${f.money(principal - fee, cash)}, repay ${f.owedIn(cap, cash)} within ${f.days(i.term)}`,
    mode: "exact", pledge: rawStr(collateral),
    ...(g.primary ? { collateralValueUSDG: rawStr(sized.value) } : { collateralValue: rawStr(sized.value) }),
    principal: rawStr(principal), receive: rawStr(principal - fee), originationFee: rawStr(fee), repay: rawStr(cap), costBps,
    ltvBps: sized.value > 0n ? Number((principal * 10_000n) / sized.value) : null, term: i.term,
    fundsNow: p.fills, accepted: p.accepts, waitsFor: p.fills ? null : p.reason,
    largestAccepted: p.acceptMaxPrincipal === null ? null : rawStr(p.acceptMaxPrincipal), ...named(c, cash),
    prepare: { action: "borrow", token: a.token, collateral: rawStr(collateral), principal: rawStr(principal), cap: rawStr(cap), term: i.term, ...(g.primary ? {} : { lendAsset: cash.token }) },
    note: p.fills
      ? "The partner vaults fund this loan whole on gage's next pass. Prices move: prepare soon after quoting."
      : p.accepts === false
        ? "No partner vault's settings take this loan whole at this cost: borrow up to largestAccepted, or pledge more."
        : "The partner vaults' settings take this loan, but none has the room for it now: listed, it waits for their cash.",
  };
}

export async function leverageQuote(c: Ctx, i: { token: string; own: string; multiple: number; term: number; wallet?: string | undefined; lendAsset?: string | undefined }) {
  usdgOnly(c, i.lendAsset);
  const x = await leverageTerms(c, i.token, BigInt(i.own), i.multiple, i.term, i.wallet as Address | undefined);
  return {
    summary: `Put in ${f.token(x.pledge, x.a.decimals, x.a.symbol)}, hold ${f.token(x.pledge + x.buy, x.a.decimals, x.a.symbol)} for a loan of ${f.usdg(x.principal)}, repay ${f.owed(x.cap)} within ${f.days(i.term)}`,
    own: rawStr(x.pledge), buy: rawStr(x.buy), held: rawStr(x.pledge + x.buy), principal: rawStr(x.principal), repay: rawStr(x.cap), costBps: x.costBps,
    maxPurchaseCostUSDG: rawStr(x.maxCost), pledgeValueUSDG: rawStr(x.valueUSDG), expiresAt: x.expiresAt,
    prepare: { action: "leverage", token: x.a.token, own: rawStr(x.pledge), multiple: i.multiple, term: i.term, maxCostBps: x.costBps },
    note: "A preview: nothing is signed or reserved. gage_prepare_leverage prices it again and refuses above maxCostBps.",
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
/** Whether an instruction will still roll the loan for the holder of its right: theirs, with rolls and time left (the app's `autoRollOn`). */
const rollsByItself = (a: AutoRollState | null, holder: string | null | undefined, now: number) =>
  a !== null && !!holder && lower(a.borrower) === lower(holder) && a.rollsLeft > 0 && a.until > now;

/**
 * One loan, and what can be done with it now, as the planner would take each action (plans.ts): `cancel` a listing;
 * `reclaim`, `cash_out` and `roll` a running loan before its end; `auto_roll` and `cancel_auto_roll` while it waits for
 * funding or runs; `collect` the collateral of a loan repaid or cancelled until it is taken. Each is listed only where
 * this network has it (a rollover router for the loan's generation, gage's keeper for a roll by itself, a cash-out
 * router that sells for the loan's core), and one this Gage does not serve (`served`; the hosted service serves those its
 * review page draws) is said to be done on the app, where the app offers it then: the app rolls a loan by hand in its
 * last day, and leaves one to roll by itself from its Borrow ticket or once it runs. `closedBy` names the router that
 * closed a repaid loan, whose collateral never comes back: a roll pledged it to the new loan, a cash-out sold it.
 */
export async function loan(c: Ctx, i: { loanId: string; engine?: string | undefined }, served: readonly ActionName[] = actionsOn(c.d)) {
  const engine = i.engine ? engineOf(c.d, i.engine) : c.d.core;
  requireThat(engine, "UNKNOWN_ENGINE", "This engine is not gage's", 404);
  const p = await loanRecord(c, engine.engine, i.loanId);
  const id = BigInt(i.loanId);
  const l = await c.chain.loan(engine.engine, id);
  const endsAt = l.fundedAt > 0 ? l.fundedAt + l.term : null;
  const pay = lendAssetOf(c.d, engine.engine), router = rolloverRouterOf(c.d, engine.engine), seller = engine.cashoutRouter;
  const open = l.state === 1 || l.state === 2, running = l.state === 2 && endsAt !== null && c.now() < endsAt;
  const closedBy = l.state !== 3 ? null : router && same(l.collateralBeneficiary, router) ? "roll" as const
    : seller && same(l.collateralBeneficiary, seller) ? "cash_out" as const : null;
  // A cash-out is this Gage's where its router sells through an aggregator (D245) and a valuation service builds the
  // sale; a router from before such sales answers no `executorAllowed`, and its loans cash out on the app.
  const sells = async () => (served.includes("cash_out") && c.valuation && seller ? await c.chain.cashoutExecutorAllowed(seller, zeroAddress) !== null : false);
  const [instruction, paused, here, released] = await Promise.all([
    router && open ? c.chain.autoRoll(router, id) : null,
    router && open ? c.chain.rolloverPaused(router) : false,
    running && seller && !same(l.token, pay.token) ? sells() : false,
    // Whether the collateral was taken back; an account that does not answer is read as not, so collect is still said.
    (l.state === 3 || l.state === 5) && !closedBy ? c.chain.released(l.account).catch(() => false) : true,
  ]);
  const host = new URL(defaultsFor(c.d.chainId).appUrl).host;
  /** An action and who takes it: here when this Gage serves it, else on the app when the app offers it now (`onApp`). */
  const way = (action: ActionName, who: string, onApp: string | null = who) =>
    (served.includes(action) ? [`${action} (${who})`] : onApp === null ? [] : [`${action} on ${host} (${onApp})`]);
  const holder = "holder of the reclaim right", left = "the wallet that left the instruction";
  const rolls = router !== null && !paused, keeper = rolls && c.d.rolloverExecutor !== null;
  const actions = l.state === 1
    ? [...way("cancel", "borrower"), ...(keeper ? way("auto_roll", holder, null) : []), ...(instruction ? way("cancel_auto_roll", left, null) : [])]
    : running
      ? [
        ...way("reclaim", `${holder}, before endsAt`),
        ...(here ? [`cash_out (${holder}, before endsAt)`] : seller && !same(l.token, pay.token) ? [`cash_out on ${host} (${holder}, before endsAt)`] : []),
        ...(rolls ? way("roll", `${holder}, before endsAt`, `${holder}, in the loan's last day`) : []),
        ...(keeper ? way("auto_roll", holder) : []),
        ...(instruction ? way("cancel_auto_roll", left) : []),
      ]
      : !released ? way("collect", "collateral back to the borrower") : [];
  return {
    engine: engine.engine, loanId: i.loanId, state: stateName(l.state), borrower: l.originator, reclaimRightHolder: p.owner ?? null,
    token: l.token, symbol: symbolOf(c, l.token), collateral: rawStr(l.collateral), principal: rawStr(l.principal), repay: rawStr(l.cap),
    costBps: l.principal > 0n ? Number(((l.cap - l.principal) * 10_000n) / l.principal) : null, term: l.term,
    fundedQuarters: l.filled, fundingDeadline: l.state === 1 ? l.fundingDeadline : null, fundedAt: l.fundedAt || null, endsAt,
    lenders: p.slots.filter((s) => BigInt(s) !== 0n),
    actions, closedBy, autoRoll: instruction ? instructionOf(instruction) : null,
    ...named(c, pay),
  };
}

export async function portfolio(c: Ctx, wallet: Address) {
  const w = lower(wallet), now = c.now();
  // Every core a wallet's loans and credits can sit on: the USDG engines, then each public lend asset's core (D251).
  const cores = [...c.d.engines, ...c.d.generations.filter((g) => !g.primary).map((g) => g.core)];
  const engines = await Promise.all(cores.map(async (e) => ({ e, credit: await c.chain.cashCredit(e.engine, wallet), loans: await walletLoans(c, e.engine, wallet) })));
  // Each loan's sGAGE is read and claimed at its engine's rewards contract, as the app's Portfolio reads it; a loan the
  // index allocated no reward owes none. A loan waiting for funding or running may roll by itself (D285).
  const loans = await Promise.all(engines.flatMap(({ e, loans: ls }) => ls.filter((p) => lower(p.loan.originator) === w || (p.owner && lower(p.owner) === w)).map(async (p) => {
    const id = BigInt(p.id), router = rolloverRouterOf(c.d, e.engine);
    const [sgage, instruction] = await Promise.all([
      BigInt(p.loan.borrowerReward) > 0n || BigInt(p.loan.lenderReward) > 0n ? c.chain.loanRewards(e.rewards, id, wallet) : 0n,
      router && (p.loan.state === 1 || p.loan.state === 2) ? c.chain.autoRoll(router, id) : null,
    ]);
    return {
      engine: e.engine, loanId: p.id, state: stateName(p.loan.state), symbol: symbolOf(c, p.loan.token), collateral: p.loan.collateral, principal: p.loan.principal, repay: p.loan.cap,
      endsAt: p.loan.fundedAt > 0 ? p.loan.fundedAt + p.loan.term : null, sgageClaimable: rawStr(sgage), autoRoll: rollsByItself(instruction, p.owner, now),
      ...named(c, lendAssetOf(c.d, e.engine)),
    };
  })));
  const [vaults, links] = await Promise.all([allPartnerVaults(c.indexer, c.d), vaultLinks(c.indexer)]);
  const held = await Promise.all(vaults.map(async ({ v, g }) => ({ v, g, h: await c.indexer.get(`/intent/partners/vaults/${lower(v.address)}/position/${w}`, holding) })));
  const ready = await claimablePockets(c, held.map(({ g, h }) => ({ engine: g.core.engine, pockets: h.pockets })));
  const holdings = held
    .map(({ v, g, h }, n) => ({ v, g, h, claimable: ready[n]!.length }))
    .filter(({ h, claimable }) => BigInt(h.shares) > 0n || claimable > 0 || BigInt(h.rewards) > 0n)
    // A USDG vault keeps its USDG-named figures; another asset's are named for what they are, in its asset (D251).
    .map(({ v, g, h, claimable }) => ({
      vault: v.address, name: vaultName(v, c.d), link: vaultLink(c, links, v.address), shares: h.shares,
      ...(g.primary ? { valueUSDG: h.value, withdrawableNowUSDG: h.withdrawableNow } : { value: h.value, withdrawableNow: h.withdrawableNow }),
      claimsReady: claimable, rewards: h.rewards, ...named(c, g.lendAsset),
    }));
  const credit = engines.filter(({ e }) => lendAssetOf(c.d, e.engine).token === c.d.usdg).reduce((sum, x) => sum + x.credit, 0n);
  // Each lend asset's credit beside USDG's, never added to it.
  const credits = engines.filter(({ e, credit: x }) => lendAssetOf(c.d, e.engine).token !== c.d.usdg && x > 0n).map(({ e, credit: x }) => ({ ...refOf(lendAssetOf(c.d, e.engine)), amount: rawStr(x) }));
  return {
    wallet, loans, earn: holdings, usdgCredit: rawStr(credit), ...(lendsMore(c.d) ? { credits } : {}),
    note: "Loans this wallet borrowed (open, running and closed) and its Earn holdings; sgageClaimable and rewards are raw sGAGE (18 decimals). gage_prepare_collect gathers what is ready to collect here.",
  };
}

export async function earnVaults(c: Ctx) {
  const [vaults, links] = await Promise.all([allPartnerVaults(c.indexer, c.d), vaultLinks(c.indexer)]);
  const rows = await Promise.all(vaults.map(async ({ v, g }) => {
    const acc = await c.indexer.get(`/intent/partners/vaults/${lower(v.address)}/accounting`, accounting);
    return {
      vault: v.address, name: vaultName(v, c.d), link: vaultLink(c, links, v.address), lends: v.fundingEnabled, performanceFeeBps: v.feeBps, longestLoanDays: v.maxLoanTerm / 86_400,
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
    note: lendsMore(c.d)
      ? "Each vault's figures are raw units of its asset (asset): usdgPerShare or assetsPerShare is what one whole share (10^18) redeems for now. Deposits lend through the vault's loans; withdrawals are paid up to its free cash."
      : "usdgPerShare is the raw USDG one whole share (10^18) redeems for now. Deposits lend through the vault's loans; withdrawals are paid up to its free cash.",
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
