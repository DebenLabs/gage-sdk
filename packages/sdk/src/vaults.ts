/**
 * A partner vault of one's own (root D424): created with a free name, as gage.cash's Create makes one, and managed by its
 * curator, as its Manage does, each from the chain alone: no gage service is asked, so a manager never waits on one. A
 * vault's `vaultOnChain` read is the same: what its book and settings are, and what it can pay a holder now, while gage's
 * index does not answer. A curator cannot withdraw depositors' assets, and nothing here can; what a sale of a running
 * loan gives up above its book value, they bear.
 */
import { encodeFunctionData, getAddress, type Address, type Hex, type Log } from "viem";
import type { z } from "zod";
import { assetPolicyAbi, factoryAbi, lenderMarketAbi, partnerVaultAbi, vaultManagerAbi } from "./abi.js";
import type { VaultManagerState } from "./chain.js";
import type { Generation } from "./deployment.js";
import { publicOnChain } from "./data.js";
import { ApiError, requireThat } from "./errors.js";
import { EXIT_KEEP_BPS } from "./exitChoice.js";
import * as f from "./format.js";
import { nameClaims, plainName } from "./format.js";
import { bookGas, capped } from "./gas.js";
import { assetScale, eventOf, generationFor, inAsset, redeemableShares, refOf, slip, VIRTUAL_SHARES, type Ctx, type InAsset, type Plan, type Step, type TokenRef } from "./plans.js";
import { admitted, createCall, MAX_LOAN_UNITS, NAME_MAX_BYTES, NAMED, parsePoolName, SECONDARY_AUCTION_MANDATE, universeOf, WEIGHTS, type Universe } from "./pools.js";
import { safeBatch, type SafeBatch } from "./safe.js";
import type { ActionInput, createVaultInput, vaultOnChainInput } from "./schemas.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes = (text: string) => new TextEncoder().encode(text).length;
const GRADE_WORDS = ["any", "D", "C", "B", "A"];
/** The longest vault name shown, in characters (`IntentFactory.MAX_NAME_BYTES` counts bytes). */
const NAME_CHARS = 48;

/** A vault's figures as `prepare` and `run` answer them; an agent reads `summary`. */
export type VaultView =
  | ({
    action: "create_vault"; curator: Address; name: string; factory: Address; collateral: { token: Address; symbol: string }[]; universe: "rwa" | "ecosystem"; term: number; feeBps: number;
    maxLoan: string; cashKeptFreeBps: number; priorityFeeBps: number; minRateGrade: number; buysLoans: boolean; buyExtraBps: number; buysOnly: boolean;
  } & InAsset)
  | ({ action: "vault_manage"; vault: Address; name: string; manager: Address; changes: VaultChange[]; feeRecipient?: Address; listing?: VaultListing } & InAsset);
/** One change a manager's plan makes: what it moves, to what, and whether it applies at once or waits three hours (`readyAt`, about). */
/** A running loan listed for sale: how far its price falls, and what the vault's depositors bear of it. */
export interface VaultListing { loanId: string; until: number; startKeepBps: number; floorKeepBps: number; floorAfterSeconds: number; tradeFeeBps: number }
export interface VaultChange { what: string; to: string; applies: "now" | "waits"; readyAt: number | null }

/** One vault, ready to create: the call, and the same call as a Safe's Transaction Builder file. */
export interface VaultCreation {
  name: string; curator: Address; chainId: number; asset: TokenRef; factory: Address; collateral: { token: Address; symbol: string }[];
  maxLoan: string; cashKeptFreeBps: number; buysLoans: boolean; buysOnly: boolean;
  calls: { to: Address; data: Hex; value: "0" }[];
  safeBatch: SafeBatch;
  notes: string[];
}

type CreateFields = Omit<z.output<typeof createVaultInput>, "curator"> & { curator: string };

/** A vault's terms checked against the chain now, as a pool's sides are (`createPoolVaults`), and its call. */
async function plannedVault(c: Ctx, i: CreateFields) {
  const curator = i.curator as Address, g = generationFor(c, i.asset);
  requireThat(bytes(i.name) <= NAME_MAX_BYTES, "NAME_TOO_LONG", `The name must fit in ${NAME_MAX_BYTES} bytes: shorten it`, 400);
  const { factory, tokens: allowed } = await admitted(c, g, curator);
  requireThat(same(factory.core, g.core.engine) && factory.mandateVersion >= NAMED, "FACTORY_CHANGED", `${g.lendAsset.symbol}'s factory is not the one this release publishes; read gage again`, 409);
  requireThat(factory.isCreator || factory.openCreation, "NOT_A_PARTNER", `${g.lendAsset.symbol}'s vaults are created by admitted partners only, and gage has not admitted this curator`);
  const scale = 10n ** BigInt(Math.max(g.lendAsset.decimals - 6, 0));
  requireThat(BigInt(i.maxLoan) <= MAX_LOAN_UNITS * scale, "MAX_LOAN_TOO_HIGH", `${g.lendAsset.symbol}'s largest loan is above what a vault may lend in one loan`, 400);
  // A stock's vault lends against the memes paired with it (D249).
  const forced: Universe | null = g.lendAsset.stable ? null : "RH_ECO";
  let picked: typeof allowed;
  if (i.collateral) {
    picked = i.collateral.map((t) => {
      const found = allowed.find((a) => same(a.token, t));
      requireThat(found, "UNSUPPORTED_COLLATERAL", `${g.lendAsset.symbol}'s vaults cannot lend against ${t}`, 400);
      return found;
    });
  } else {
    const universe: Universe = i.universe === "ecosystem" ? "RH_ECO" : i.universe === "rwa" ? "RWA" : forced ?? "RWA";
    picked = allowed.filter((a) => universeOf(a.category) === universe);
  }
  const universes = new Set(picked.map((a) => universeOf(a.category)));
  requireThat(picked.length > 0, "UNSUPPORTED_COLLATERAL", `${g.lendAsset.symbol}'s vaults can lend against no admitted token in that universe now`, 400);
  requireThat(universes.size === 1 && (!forced || universes.has(forced)), "MIXED_COLLATERAL", "A vault lends against real-world assets or the Robinhood ecosystem, never both; a stock's vault against memes", 400);
  const universe = [...universes][0]!;
  const asked: Universe | null = i.universe === "ecosystem" ? "RH_ECO" : i.universe === "rwa" ? "RWA" : null;
  requireThat(!asked || asked === universe, "UNIVERSE_MISMATCH", "These tokens are not of the universe named, and a vault's universe is fixed for good: name one or the other", 400);
  // From mandate 13 every generation's vaults buy running loans and may buy alone (Intent D56); before it, USDG's alone buy.
  const auction = factory.mandateVersion >= SECONDARY_AUCTION_MANDATE;
  const buys = i.buyLoans !== undefined;
  requireThat(!i.buysOnly || buys, "BUY_LOANS_NEEDED", "A vault that buys running loans alone names what it asks of them: buyLoans", 400);
  requireThat(!buys || g.primary || auction, "BUY_LOANS_CLOSED", `${g.lendAsset.symbol}'s vaults do not buy running loans on this factory`);
  requireThat(!i.buysOnly || auction, "BUY_LOANS_CLOSED", "This factory makes no vault that buys running loans alone");
  const mandate = {
    curator, categoryWeights: WEIGHTS[universe], assets: picked.map((a) => a.token), maxLoanTerm: i.term, feeBps: i.feeBps, minGrade: 0, minRateGrade: i.minRateGrade ?? 3,
    maxLoanPrincipal: BigInt(i.maxLoan), maxAssetBps: 10_000, bufferBps: i.cashKeptFreeBps ?? 0, executionCapBps: i.priorityFeeBps ?? 2_000,
  };
  const extra = i.buyLoans?.extraBps ?? 0, buysOnly = i.buysOnly === true;
  const data = createCall(factory.mandateVersion, mandate, buys, extra, buysOnly, i.name);
  const collateral = picked.map(({ token, symbol }) => ({ token, symbol }));
  const notes = [
    "It lends nothing until depositors bring its asset. gage_earn_vaults lists it once gage's index has it, and gage's Earn hides a vault with no deposits and no team badge behind its empty ones.",
    ...(parsePoolName(i.name) ? ["A name ending in two symbols joined by a slash reads as one side of a pool: name it otherwise if it is not one."] : []),
  ];
  return { g, curator, data, mandate, collateral, buys, extra, buysOnly, universe, notes };
}

/** One vault as the call that creates it from its curator, simulated now, and as a Safe's Transaction Builder file. Signs nothing. */
export async function createVault(c: Ctx, i: z.output<typeof createVaultInput>): Promise<VaultCreation> {
  const p = await plannedVault(c, i), to = p.g.factory;
  await c.chain.simulate({ from: p.curator, to, data: p.data, value: 0n });
  const calls = [{ to, data: p.data, value: "0" as const }];
  return {
    name: i.name, curator: p.curator, chainId: c.d.chainId, asset: refOf(p.g.lendAsset), factory: to, collateral: p.collateral, maxLoan: i.maxLoan, cashKeptFreeBps: p.mandate.bufferBps,
    buysLoans: p.buys, buysOnly: p.buysOnly, calls,
    safeBatch: safeBatch({ chainId: c.d.chainId, safe: p.curator, name: `gage partner vault: ${i.name}`, calls, description: `Creates the ${p.g.lendAsset.symbol} vault ${i.name} on gage's factory, managed by this Safe.` }),
    notes: ["Send the call from the curator: a factory creates only for its caller, who manages the vault for good. A Safe loads safeBatch in Safe{Wallet}'s Transaction Builder and signs there; gage never signs or proposes.", ...p.notes],
  };
}

/** `create_vault`: the same vault for `prepare` and `run`, whose wallet is its curator. */
export async function createVaultPlan(c: Ctx, i: Extract<ActionInput, { action: "create_vault" }>): Promise<Plan> {
  const p = await plannedVault(c, { ...i, curator: i.wallet }), cash = p.g.lendAsset, to = p.g.factory, { mandate } = p;
  const lendsAgainst = p.collateral.slice(0, 8).map((t) => t.symbol).join(", ") + (p.collateral.length > 8 ? ` and ${p.collateral.length - 8} more` : "");
  return {
    view: {
      action: "create_vault", curator: p.curator, name: i.name, factory: to, collateral: p.collateral, universe: p.universe === "RWA" ? "rwa" : "ecosystem", term: i.term, feeBps: i.feeBps, maxLoan: i.maxLoan,
      cashKeptFreeBps: mandate.bufferBps, priorityFeeBps: mandate.executionCapBps, minRateGrade: mandate.minRateGrade, buysLoans: p.buys, buyExtraBps: p.extra, buysOnly: p.buysOnly, ...inAsset(c, cash),
    },
    summary: {
      title: `Create the partner vault "${i.name}"`,
      rows: [
        { label: "It lends", value: cash.symbol },
        { label: "It lends against", value: lendsAgainst },
        { label: "Longest loan", value: f.days(i.term) },
        { label: "Largest loan", value: f.money(BigInt(i.maxLoan), cash) },
        { label: "Performance fee", value: `${f.bps(i.feeBps)} of each loan's profit; fixed for good` },
        { label: "Priority fee ceiling", value: f.bps(mandate.executionCapBps) },
        { label: "Cash kept free", value: f.bps(mandate.bufferBps) },
        { label: "Lowest Loan grade", value: GRADE_WORDS[mandate.minRateGrade]! },
        { label: "Buys running loans", value: p.buysOnly ? `Only those, asking ${f.bps(p.extra)} a year above the model's return` : p.buys ? `Yes, asking ${f.bps(p.extra)} a year above the model's return` : "No" },
        { label: "You manage it", value: "For good: its limits, tokens, name and pause, with vault_manage. You cannot withdraw its depositors' assets, and a loan you list for sale can sell for as little as book value plus half of what it has still to earn" },
      ],
    },
    steps: [{ label: "Create the vault", kind: "action", final: true, build: () => Promise.resolve({ to, data: p.data, value: 0n }) }],
    notes: p.notes,
    vault: (logs: readonly Log[]) => {
      const made = eventOf(factoryAbi, "VaultCreated", to, logs, (x) => same(String(x.curator), p.curator));
      return made ? getAddress(String(made.vault)) : null;
    },
  };
}

/** A partner vault of any generation gage keeps, identified on chain alone: its factory made it, on that generation's core. */
export async function vaultOfChain(c: Ctx, vault: string): Promise<{ address: Address; g: Generation }> {
  const address = vault as Address;
  for (const g of [...c.d.generations, ...c.d.retired]) {
    if (await c.chain.isVault(g.factory, address)) {
      requireThat(same(await c.chain.vaultCore(address), g.core.engine), "UNKNOWN_VAULT", "This is not a partner vault of one of gage's cores", 404);
      return { address, g };
    }
  }
  throw new ApiError("UNKNOWN_VAULT", "This is not a partner vault of one of gage's cores", 404);
}

/** The limits in the asset policy's order (`IntentLimit`): a field's index is its limit's. */
const LIMITS = ["maxLoan", "maxPerTokenBps", "cashKeptFreeBps", "minRateGrade", "stockBps", "memeBps", "ecosystemBps", "commodityBps"] as const;
type LimitField = (typeof LIMITS)[number];
const LIMIT_WORDS: Record<LimitField, string> = {
  maxLoan: "the largest loan", maxPerTokenBps: "the most per token", cashKeptFreeBps: "the cash kept free", minRateGrade: "the lowest Loan grade",
  stockBps: "the most in stocks", memeBps: "the most in meme coins", ecosystemBps: "the most in utility coins", commodityBps: "the most in commodities",
};
/** What a loosening waits (`LIMIT_LOOSEN_DELAY`, `SECONDARY_LOOSEN_DELAY`, an asset addition's). */
const LOOSEN_SECONDS = 3 * 3_600;
/** How long a loan stays listed by default, and the least left of a loan worth listing, in seconds, as gage.cash's Manage holds them. */
const LISTING_SECONDS = 86_400, LEAST_LISTING = 3_600;
/**
 * A curator's listing (`IntentLenderMarket`): the share of what a loan has still to earn it keeps above book value, falling
 * from `EXIT_KEEP_BPS` over ten minutes and stopping at `CURATOR_FLOOR_BPS`, which takes about five.
 */
const LISTING_FLOOR_BPS = 5_000, AUCTION_SECONDS = 600;
const LISTING_FLOOR_AFTER = Math.ceil(((EXIT_KEEP_BPS - LISTING_FLOOR_BPS) * AUCTION_SECONDS) / EXIT_KEEP_BPS);
/** A private loan is never acted on here, as nowhere in gage-sdk: it reads as unknown (M7). */
async function publicLoan(c: Ctx, g: Generation, id: bigint) {
  requireThat((await publicOnChain(c, [{ engine: g.core.engine, id }]))[0], "NOT_FOUND", "gage has no record of that", 404);
}

const limitNow = (s: VaultManagerState, n: number): bigint => {
  if (n === 0) return s.maxLoanPrincipal;
  if (n === 1) return BigInt(s.maxAssetBps);
  if (n === 2) return BigInt(s.bufferBps);
  if (n === 3) return BigInt(s.minRateGrade);
  return BigInt(s.categoryWeights[n - 4] ?? 0);
};

/**
 * `vault_manage`: what a vault's curator names, each field one transaction, from one reading of the chain: its name, then
 * its switches, limits, buying loans, tokens, what waits, and a loan's sale. What the vault has already is left out, so
 * preparing again after a transaction leaves what is still to send, down to `done`. A vault before mandate 12 is managed on gage.cash.
 */
export async function manageVaultPlan(c: Ctx, i: Extract<ActionInput, { action: "vault_manage" }>): Promise<Plan> {
  const wallet = i.wallet as Address, { vault: _v, wallet: _w, action: _a, ...named } = i;
  requireThat(Object.keys(named).length > 0, "NOTHING_NAMED", "Name what to change: vault_manage takes each field on its own", 400);
  const { address, g } = await vaultOfChain(c, i.vault);
  const s = await c.chain.vaultManager(address);
  requireThat(s && s.mandateVersion >= NAMED, "MANAGE_ON_APP", "This vault is from before named limits: manage it on gage.cash");
  requireThat(same(s.curator, wallet), "NOT_CURATOR", "This wallet does not manage this vault", 403);
  const cash = g.lendAsset, now = (await c.chain.head()).timestamp;
  const steps: Step[] = [], changes: VaultChange[] = [], rows: { label: string; value: string }[] = [], notes: string[] = [];
  let feeRecipient: Address | undefined, listing: VaultListing | undefined;
  // What was named to apply or drop and is no longer there: mined by an earlier transaction, or never queued.
  const gone: string[] = [];
  const add = (label: string, to: Address, data: Hex, what: string, value: string, applies: "now" | "waits" = "now", readyAt: number | null = null) => {
    steps.push({ label, kind: "action", final: false, build: () => Promise.resolve({ to, data, value: 0n }) });
    changes.push({ what, to: value, applies, readyAt });
    rows.push({ label: what, value: applies === "now" ? `${value}, at once` : `${value}, from about ${f.date(readyAt!)} (three hours after this is mined)` });
  };
  if (i.name !== undefined) {
    requireThat(bytes(i.name) <= NAME_MAX_BYTES, "NAME_TOO_LONG", `The name must fit in ${NAME_MAX_BYTES} bytes: shorten it`, 400);
    if (i.name !== s.name) add("Rename the vault", g.factory, encodeFunctionData({ abi: factoryAbi, functionName: "setName", args: [address, i.name] }), "Name", i.name);
  }
  if (i.paused !== undefined && i.paused !== s.paused) {
    add(i.paused ? "Pause new investment" : "Resume new investment", address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "setPaused", args: [i.paused] }), "New investment", i.paused ? "Paused" : "Active");
  }
  if (i.fillersOpen !== undefined && i.fillersOpen !== s.fillersOpen) {
    add(i.fillersOpen ? "Open gage's automatic funding" : "Close gage's automatic funding", address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "setFillersOpen", args: [i.fillersOpen] }), "Automatic funding", i.fillersOpen ? "On" : "Off");
  }
  if (i.priorityFeeBps !== undefined && i.priorityFeeBps !== s.executionCapBps) {
    add("Set the priority fee ceiling", address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "setExecutionCap", args: [i.priorityFeeBps] }), "Priority fee ceiling", f.bps(i.priorityFeeBps));
  }
  if (i.feeRecipient !== undefined) {
    requireThat(BigInt(i.feeRecipient) !== 0n && !same(i.feeRecipient, address), "INVALID_RECIPIENT", "The fee recipient must be an address other than the vault", 400);
    if (!same(i.feeRecipient, s.feeRecipient)) {
      feeRecipient = getAddress(i.feeRecipient);
      add("Set the fee recipient", address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "setFeeRecipient", args: [feeRecipient] }), "Fee recipient", feeRecipient);
      notes.push("Fees not yet claimed go to the new recipient too: anyone may claim them, and they are paid to whoever is the recipient then.");
    }
  }
  const limitText = (field: LimitField, value: bigint) => (field === "maxLoan" ? f.money(value, cash) : field === "minRateGrade" ? GRADE_WORDS[Number(value)]! : f.bps(Number(value)));
  LIMITS.forEach((field, n) => {
    const given = i[field];
    if (given === undefined) return;
    const value = BigInt(given), current = limitNow(s, n), waiting = s.pendingLimits[n]!;
    if (field === "maxLoan") requireThat(value <= MAX_LOAN_UNITS * assetScale(cash), "MAX_LOAN_TOO_HIGH", `${cash.symbol}'s largest loan is above what a vault may lend in one loan`, 400);
    // The category weights follow `IntentCategory`, and the vault's mask says which it may ever use.
    if (n >= 4) requireThat(value === 0n || (s.categoryMask & (1 << (n - 4))) !== 0, "CATEGORY_CLOSED", "This vault lends against one universe: that category stays closed", 400);
    const tightens = field === "cashKeptFreeBps" || field === "minRateGrade" ? value >= current : value <= current;
    if ((value === current && waiting.readyAt === 0) || (!tightens && waiting.readyAt !== 0 && waiting.value === value)) return;
    const words = LIMIT_WORDS[field], capital = words[0]!.toUpperCase() + words.slice(1);
    const data = encodeFunctionData({ abi: assetPolicyAbi, functionName: "setLimit", args: [n, value] });
    if (tightens) add(`Set ${words}`, s.policy, data, capital, limitText(field, value));
    else add(`Queue ${words}`, s.policy, data, capital, limitText(field, value), "waits", now + LOOSEN_SECONDS);
  });
  if (i.buyLoans) {
    requireThat(g.primary || s.mandateVersion >= SECONDARY_AUCTION_MANDATE, "BUY_LOANS_CLOSED", `${cash.symbol}'s vaults do not buy running loans on this factory`);
    const extra = i.buyLoans.extraBps ?? s.buyExtraBps, on = i.buyLoans.enabled;
    const data = encodeFunctionData({ abi: assetPolicyAbi, functionName: "setSecondaryPolicy", args: [on, extra] });
    const waits = on && (!s.buysLoans || extra < s.buyExtraBps);
    const unchanged = waits ? s.pendingBuyReadyAt !== 0 && s.pendingBuyExtraBps === extra : on === s.buysLoans && (!on || extra === s.buyExtraBps) && s.pendingBuyReadyAt === 0;
    if (!unchanged) {
      const to = on ? `Yes, asking ${f.bps(extra)} a year above the model's return` : "No";
      if (waits) add("Queue buying running loans", s.policy, data, "Buys running loans", to, "waits", now + LOOSEN_SECONDS);
      else add(on ? "Set what it asks of running loans" : "Stop buying running loans", s.policy, data, "Buys running loans", to);
    }
  }
  const tokens = [...new Set([...(i.addTokens ?? []), ...(i.removeTokens ?? []), ...(i.applyTokens ?? []), ...(i.dropTokens ?? [])].map((t) => getAddress(t)))];
  if (tokens.length) {
    const held = new Map((await c.chain.policyTokens(s.policy, tokens)).map((t, n) => [tokens[n]!.toLowerCase(), t]));
    const of = (t: string) => held.get(t.toLowerCase())!;
    const symbolOf = async (t: Address) => f.plainSymbol((await c.chain.tokenInfo(t)).symbol) || f.short(t);
    const toAdd = (i.addTokens ?? []).map((t) => getAddress(t)).filter((t) => !of(t).picked && of(t).readyAt === 0);
    if (toAdd.length) {
      // What the policy rechecks: the core's registry admits it, and the factory files it in the vault's universe.
      const [read, configs] = await Promise.all([c.chain.intentFactory(g.factory, wallet, toAdd), Promise.all(toAdd.map((t) => c.chain.tokenConfig(g.core.registry, t)))]);
      for (const [n, t] of toAdd.entries()) {
        const category = read.categories[n];
        requireThat(configs[n]!.allowed && category !== null && category !== undefined && (s.categoryMask & (1 << category)) !== 0, "UNSUPPORTED_COLLATERAL", `This vault cannot lend against ${t}: gage does not admit it in the vault's universe`, 400);
        const symbol = await symbolOf(t);
        add(`Add ${symbol}`, address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "setAsset", args: [t, true] }), "Token added", symbol, "waits", now + LOOSEN_SECONDS);
      }
    }
    // Removing and dropping end in one place, the vault not lending against the token, whichever state it is in now:
    // anyone may turn a queued addition into a picked token once its wait is over.
    for (const t of new Set([...(i.removeTokens ?? []), ...(i.dropTokens ?? [])].map((t) => getAddress(t)))) {
      if (!of(t).picked && of(t).readyAt === 0) continue;
      const symbol = await symbolOf(t);
      if (of(t).picked) add(`Remove ${symbol}`, address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "setAsset", args: [t, false] }), "Token removed", symbol);
      else add(`Drop ${symbol}`, address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "resolveAssetAddition", args: [t, false] }), "Token dropped", symbol);
    }
    for (const t of (i.applyTokens ?? []).map((t) => getAddress(t))) {
      if (of(t).readyAt === 0) {
        requireThat(of(t).picked, "NOTHING_WAITING", `No addition of ${t} is waiting`);
        continue;
      }
      requireThat(of(t).readyAt <= now, "CHANGE_WAITING", `This token can be added from ${f.date(of(t).readyAt)}`);
      const symbol = await symbolOf(t);
      add(`Apply ${symbol}`, address, encodeFunctionData({ abi: vaultManagerAbi, functionName: "resolveAssetAddition", args: [t, true] }), "Token added", symbol);
    }
  }
  for (const field of i.apply ?? []) {
    if (field === "buyLoans") {
      if (s.pendingBuyReadyAt === 0) { gone.push("buying running loans"); continue; }
      requireThat(s.pendingBuyReadyAt <= now, "CHANGE_WAITING", `This change applies from ${f.date(s.pendingBuyReadyAt)}`);
      add("Apply buying running loans", s.policy, encodeFunctionData({ abi: assetPolicyAbi, functionName: "activateSecondaryPolicy" }), "Buys running loans", `Yes, asking ${f.bps(s.pendingBuyExtraBps)} a year above the model's return`);
      continue;
    }
    const n = LIMITS.indexOf(field), waiting = s.pendingLimits[n]!, words = LIMIT_WORDS[field];
    if (waiting.readyAt === 0) { gone.push(words); continue; }
    requireThat(waiting.readyAt <= now, "CHANGE_WAITING", `This change applies from ${f.date(waiting.readyAt)}`);
    add(`Apply ${words}`, s.policy, encodeFunctionData({ abi: assetPolicyAbi, functionName: "activateLimit", args: [n] }), words[0]!.toUpperCase() + words.slice(1), limitText(field, waiting.value));
  }
  for (const field of i.drop ?? []) {
    if (field === "buyLoans") {
      if (s.pendingBuyReadyAt === 0) { gone.push("buying running loans"); continue; }
      add("Drop buying running loans", s.policy, encodeFunctionData({ abi: assetPolicyAbi, functionName: "cancelSecondaryPolicy" }), "Buys running loans", "The change waiting is dropped");
      continue;
    }
    const n = LIMITS.indexOf(field), words = LIMIT_WORDS[field];
    if (s.pendingLimits[n]!.readyAt === 0) { gone.push(words); continue; }
    add(`Drop ${words}`, s.policy, encodeFunctionData({ abi: assetPolicyAbi, functionName: "cancelLimit", args: [n] }), words[0]!.toUpperCase() + words.slice(1), "The change waiting is dropped");
  }
  if (i.listLoan) {
    requireThat(s.mandateVersion >= SECONDARY_AUCTION_MANDATE, "MANAGE_ON_APP", "This vault's sales take a price: list its loans on gage.cash");
    requireThat(!s.paused, "PAUSED", "The vault is paused: it sells no loan");
    requireThat(await c.chain.earliestMaturity(address) > now, "SETTLEMENT_DUE", "A loan of the vault must be settled first");
    const id = BigInt(i.listLoan.loanId), loanId = i.listLoan.loanId;
    await publicLoan(c, g, id);
    const [slots, l, ask] = await Promise.all([c.chain.saleSlots(address, id), c.chain.loan(g.core.engine, id), c.chain.exitAsk(s.market, id)]);
    requireThat(slots > 0, "NOT_FOR_SALE", "The vault holds nothing of this loan that it can sell");
    requireThat(l.state === 2, "NOT_RUNNING", "Only a running loan can be listed");
    const live = ask.listedAt !== 0 && now <= ask.deadline;
    requireThat(!(live && ask.exit), "EXIT_LISTED", "An exit has this loan listed: it stays until that listing ends");
    if (live) {
      // Listing it again would restart its price: what was asked already holds.
      notes.push(`Loan #${loanId} is already for sale, until ${f.date(ask.deadline)}. cancelListing takes it off sale.`);
    } else {
      const ends = l.fundedAt + l.term;
      requireThat(ends - now >= LEAST_LISTING, "LOAN_ENDING", "This loan ends in under an hour: too late to list it");
      const wanted = now + (i.listLoan.hours === undefined ? LISTING_SECONDS : i.listLoan.hours * 3_600), deadline = wanted < ends ? wanted : ends;
      const fee = await c.chain.tradeFeeBps(g.core.registry);
      add(`List loan #${loanId} for sale`, s.market, encodeFunctionData({ abi: lenderMarketAbi, functionName: "list", args: [id, deadline, fee] }), `Loan #${loanId}`, `For sale until ${f.date(deadline)}`);
      listing = { loanId, until: deadline, startKeepBps: EXIT_KEEP_BPS, floorKeepBps: LISTING_FLOOR_BPS, floorAfterSeconds: LISTING_FLOOR_AFTER, tradeFeeBps: fee };
      rows.push({ label: "Its price", value: `Falls to book value plus ${f.bps(LISTING_FLOOR_BPS)} of what it has still to earn` }, { label: "Depositors bear", value: `Up to ${f.bps(10_000 - LISTING_FLOOR_BPS)} of what this loan has still to earn, if it sells at that price` });
      notes.push(`Over about five minutes its price falls from book value plus ${f.bps(EXIT_KEEP_BPS)} of what it has still to earn to book value plus ${f.bps(LISTING_FLOOR_BPS)} of it, and stays there until the listing ends. A sale at that price gives up the other half, which the vault's depositors bear. What the vault books is what the buyer pays less a trade fee of ${f.bps(fee)}, and never under that floor.`);
    }
  }
  if (i.cancelListing !== undefined) {
    const id = BigInt(i.cancelListing);
    await publicLoan(c, g, id);
    const ask = await c.chain.exitAsk(s.market, id);
    if (ask.listedAt === 0) {
      notes.push(`Loan #${i.cancelListing} is not listed for sale.`);
    } else {
      requireThat(!ask.exit || now >= ask.deadline, "EXIT_LISTED", "An exit has this loan listed: it stays until that listing ends");
      add(`Take loan #${i.cancelListing} off sale`, s.market, encodeFunctionData({ abi: lenderMarketAbi, functionName: "cancel", args: [id] }), `Loan #${i.cancelListing}`, "Off sale");
    }
  }
  if (gone.length) notes.push(`No change to ${gone.join(", ")} is waiting.`);
  if (steps.length) steps.at(-1)!.final = true;
  if (changes.some((x) => x.applies === "waits")) notes.push("A change that loosens the vault waits three hours, so depositors see it coming: send it again with apply (a token: applyTokens) once its wait is over. Anyone may apply it.");
  const own = plainName(s.name, NAME_CHARS);
  const shown = nameClaims(own) ? "" : own;
  const view: VaultView = { action: "vault_manage", vault: getAddress(address), name: shown, manager: getAddress(wallet), changes, ...(feeRecipient ? { feeRecipient } : {}), ...(listing ? { listing } : {}), ...inAsset(c, cash) };
  return {
    view,
    summary: { title: steps.length ? `Manage ${shown || "this vault"} (${f.short(address)})` : `${shown || "This vault"} has all of that already, or it is waiting`, rows },
    steps, notes,
    ...(steps.length ? { batch: true as const } : {}),
  };
}

/**
 * One partner vault read from the chain alone: which generation, its book, whether a settlement is due, its manager's
 * settings and what waits, and with a `wallet` what it holds and what the vault can pay it now, with the call that
 * withdraws that, sized as `earn_redeem` sizes it. gage's index is not asked, so this answers while it does not; a
 * written-off loan's pockets are the index's to name, and `collect` claims them.
 */
export async function vaultOnChain(c: Ctx, i: z.output<typeof vaultOnChainInput>) {
  const { address, g } = await vaultOfChain(c, i.vault);
  const cash = g.lendAsset, wallet = i.wallet as Address | undefined;
  const [s, book, earliest, head] = await Promise.all([c.chain.vaultManager(address), c.chain.vaultBook(address), c.chain.earliestMaturity(address), c.chain.head()]);
  const settlementDue = earliest <= head.timestamp;
  const scale = assetScale(cash);
  const worth = (n: bigint) => (n * (book.totalAssets + scale)) / (book.totalSupply + VIRTUAL_SHARES);
  // As `earn_redeem` sends it: the estimate at the head, and the floor for the vault's open reward records, which an
  // estimate taken while they have nothing to claim does not see (src/gas.ts). A call that would revert now has none.
  const withdrawCall = async (who: Address, data: Hex) => {
    const floor = await bookGas(c.chain, address, s?.mandateVersion);
    const estimate = await c.chain.simulate({ from: who, to: address, data, value: 0n }).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "SIMULATION_FAILED") return null;
      throw error;
    });
    return { to: address, data, value: "0" as const, gas: estimate === null ? null : capped(estimate + floor, estimate).toString() };
  };
  const holderOf = async (who: Address) => {
    const shares = await c.chain.vaultShares(address, who);
    const value = worth(shares);
    const sized = shares === 0n || settlementDue ? 0n : redeemableShares(shares, value, cash, book);
    const payable = worth(sized);
    const withdraw = sized > 0n && payable > 0n ? await withdrawCall(who, encodeFunctionData({ abi: partnerVaultAbi, functionName: "redeem", args: [sized, slip(payable)] })) : null;
    return { wallet: who, shares: shares.toString(), value: value.toString(), payableNow: payable.toString(), sharesPayableNow: sized.toString(), withdraw };
  };
  const holder = wallet ? await holderOf(wallet) : null;
  return {
    vault: getAddress(address), generation: g.id, retired: Boolean(g.retired), asset: refOf(cash), core: g.core.engine, factory: g.factory, name: (s && !nameClaims(s.name) && plainName(s.name, NAME_CHARS)) || null, curator: s?.curator ?? null,
    mandateVersion: s?.mandateVersion ?? null, paused: s?.paused ?? null, settlementDue,
    totalAssets: book.totalAssets.toString(), totalSupply: book.totalSupply.toString(), freeCash: book.free.toString(), loansOut: book.performing.toString(),
    settings: s && {
      maxLoan: s.maxLoanPrincipal.toString(), maxPerTokenBps: s.maxAssetBps, cashKeptFreeBps: s.bufferBps, minRateGrade: s.minRateGrade, priorityFeeBps: s.executionCapBps, feeRecipient: s.feeRecipient,
      fillersOpen: s.fillersOpen, stockBps: s.categoryWeights[0] ?? 0, memeBps: s.categoryWeights[1] ?? 0, ecosystemBps: s.categoryWeights[2] ?? 0, commodityBps: s.categoryWeights[3] ?? 0,
      buysLoans: s.buysLoans, buyExtraBps: s.buyExtraBps, buysOnly: s.buysOnly,
    },
    waiting: s ? [
      ...LIMITS.flatMap((field, n) => (s.pendingLimits[n]!.readyAt === 0 ? [] : [{ change: field, value: s.pendingLimits[n]!.value.toString(), readyAt: s.pendingLimits[n]!.readyAt }])),
      ...(s.pendingBuyReadyAt === 0 ? [] : [{ change: "buyLoans", value: String(s.pendingBuyExtraBps), readyAt: s.pendingBuyReadyAt }]),
    ] : [],
    ...(holder ? { holder } : {}),
    note: "Read from the chain alone, gage's index not asked. Raw units of the vault's asset; shares have 18 decimals. withdraw is an unsigned call for the holder, its gas the estimate at the head and the floor for the vault's open reward records (null: it would revert now); its share value moves a little each second, and it leaves a margin for that. While settlementDue a vault pays nothing out: send settle first, or earn_redeem, which names its loans once gage's index answers.",
  };
}
