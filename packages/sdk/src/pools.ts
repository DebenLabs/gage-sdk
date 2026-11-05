/**
 * Pool vaults (D333): a DEX pool's lending on gage, one partner vault for each pool token gage lends, each on the
 * generation that lends that token (a vault lends one asset), created together and read back as one pool. Nothing on
 * chain links them. Both carry one name, ending in the pool's tag (its two tokens' symbols: `Fables NVDA/USDG`), and
 * share their curator, which never changes. The rule is gage.cash's own (shared/pool-vaults.mjs), ported here as the
 * short links are (src/links.ts): the app, gage's index and gage-sdk group vaults alike.
 */
import { encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { factoryAbi } from "./abi.js";
import { allPartnerVaults, vaultLinks, vaultName } from "./data.js";
import type { Generation } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import { defaultsFor } from "./networks.js";
import type { Ctx } from "./plans.js";
import { safeBatch, type SafeBatch } from "./safe.js";
import { address, raw } from "./schemas.js";

/** The longest vault name, in bytes of UTF-8 (`IntentFactory.MAX_NAME_BYTES`). */
export const NAME_MAX_BYTES = 48;
/** The most a vault may put into one loan, in six-decimal units of its asset (`IntentVaultState.INTENT_MAX_LOAN_PRINCIPAL`). */
const MAX_LOAN_UNITS = 1_000_000_000_000_000n;
/** The first factory version that names its vaults (Intent D54): a pool's link is in its vaults' names. */
const NAMED = 12;
/** From this factory version every generation's vaults buy running loans and may be created to buy only (Intent D56). */
const SECONDARY_AUCTION_MANDATE = 13;

const SYMBOL = /^[^\s/]{1,20}$/u;
const TAGGED = /^(?:(.*\S)\s+)?([^\s/]+)\/([^\s/]+)$/u;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const lower = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);

/** A pool's tag: its two tokens' symbols, in the pool's order, joined by a slash. Null for symbols no tag can carry. */
export function poolTag(tokens: readonly string[]): string | null {
  const [a, b] = tokens;
  if (!SYMBOL.test(a ?? "") || !SYMBOL.test(b ?? "") || same(a!, b!)) return null;
  return `${a}/${b}`;
}

/** The name a pool's vaults carry: the label, a space and the tag (the tag alone without a label); null past 48 bytes. */
export function poolVaultName(label: string | null | undefined, tokens: readonly string[]): string | null {
  const tag = poolTag(tokens);
  if (tag === null) return null;
  const words = (label ?? "").trim().replace(/\s+/gu, " ");
  const name = words ? `${words} ${tag}` : tag;
  return bytes(name) <= NAME_MAX_BYTES ? name : null;
}

/** What a name says of a pool: its label (`""` for none) and its two tokens, where it ends in a tag; null otherwise. */
export function parsePoolName(name: string | null | undefined): { label: string; tokens: [string, string] } | null {
  const match = TAGGED.exec((name ?? "").trim());
  if (!match) return null;
  const tokens: [string, string] = [match[2]!, match[3]!];
  if (poolTag(tokens) === null) return null;
  return { label: (match[1] ?? "").replace(/\s+/gu, " "), tokens };
}

export interface PoolSideVault { address: string; curator: string; name: string | null | undefined; asset: string }
export interface PoolOf<V extends PoolSideVault> {
  curator: string;
  name: string;
  label: string;
  tokens: [string, string];
  /** In `tokens`' order; null where no vault lends that token. */
  sides: [V | null, V | null];
}

/**
 * The pools among `vaults`, given in the order they were created, each with the symbol of the asset it lends. A vault is
 * a side where its name ends in a tag naming its own asset. Sides of one curator whose names agree (the label as
 * written, the tag's symbols in any order and case) make one pool, with at most one vault per token: a later vault of a
 * side already taken opens another pool of the same name.
 */
export function poolsOf<V extends PoolSideVault>(vaults: Iterable<V>): PoolOf<V>[] {
  const pools: (PoolOf<V> & { key: string })[] = [];
  for (const vault of vaults) {
    const parsed = parsePoolName(vault.name);
    if (!parsed) continue;
    const side = parsed.tokens.findIndex((t) => same(t, vault.asset));
    if (side === -1) continue;
    const token = parsed.tokens[side]!;
    const key = [lower(vault.curator), parsed.label, ...parsed.tokens.map(lower).sort()].join("\n");
    let pool = pools.find((p) => p.key === key && p.sides[p.tokens.findIndex((t) => same(t, token))] === null);
    if (!pool) {
      pool = { key, curator: vault.curator, name: (vault.name ?? "").trim(), label: parsed.label, tokens: parsed.tokens, sides: [null, null] };
      pools.push(pool);
    }
    pool.sides[pool.tokens.findIndex((t) => same(t, token))] = vault;
  }
  return pools.map(({ key: _key, ...pool }) => pool);
}

// ---------------------------------------------------------------------------------------------------------- inputs

const poolToken = z.string().regex(/^(0x[0-9a-fA-F]{40}|[^\s/]{1,20})$/, "a lend asset's symbol, or a token's 0x address")
  .describe("A token of the pool: a lend asset's symbol or address (USDG, or one gage_capabilities lists under lendAssets), or any token's address");
const side = z.object({
  token: poolToken.describe("The pool token this side lends, as `pool` names it"),
  maxLoan: raw.describe("The most this vault puts into one loan, raw units of its token (USDG: 6 decimals)"),
  cashKeptFreeBps: z.number().int().min(0).max(10_000).optional()
    .describe("The share of the vault a new loan must leave free in cash, bps, 0 to 10000: what the pool can draw on. 1000 (10%) when omitted"),
  collateral: z.array(address).min(1).max(64).optional()
    .describe("The tokens this vault lends against, of one universe (real-world assets, or the Robinhood ecosystem). When omitted: every token its generation admits in the universe of the pool's other token, less the pool's own two tokens (a stock's vault: the memes paired with it). Naming a pool token is refused unless allowPoolTokens is true"),
}).strict();
export const createPoolVaultsInput = z.object({
  curator: address.describe("Who manages both vaults, for good: the wallet or Safe that sends the calls. Any address while a generation's creation is open (mainnet's since 5 November 2026), otherwise one gage admitted as a partner there"),
  name: z.string().regex(/^[^\p{Cc}\p{Cf}]{1,40}$/u, "1 to 40 characters, no control characters")
    .describe("The name before the pool's tag: \"Fables\" names both vaults \"Fables NVDA/USDG\""),
  pool: z.tuple([poolToken, poolToken]).describe("The pool's two tokens, in its order"),
  term: z.union([z.literal(604_800), z.literal(1_814_400)]).describe("The longest loan both vaults fund, in seconds: 604800 (7 days) or 1814400 (21 days)"),
  feeBps: z.number().int().min(500).max(1_500).describe("The performance fee both charge on each loan's profit, bps, 500 to 1500; the protocol receives 10% of it"),
  priorityFeeBps: z.number().int().min(0).max(5_000).optional()
    .describe("The most each vault pays the protocol for a loan, bps of its profit, 0 to 5000: the vault paying most is funded first. 2000 when omitted"),
  minRateGrade: z.number().int().min(0).max(4).optional()
    .describe("The lowest Loan grade both fund, 0 (any) to 4 (A, the model's price or more). 3 (B, 90% of it) when omitted"),
  buyLoans: z.object({ extraBps: z.number().int().min(0).max(10_000).describe("The extra return a year asked above the model's, bps") }).strict().optional()
    .describe("Each vault buys running loans other vaults of its generation sell, when they pay at least the model's return plus this; off when omitted. Before mandate 13 (Intent D56) only the USDG vault buys"),
  sides: z.array(side).min(1).max(2).describe("What is counted in each token, one entry for each pool token gage lends: its largest loan, and the cash it keeps free"),
  allowPoolTokens: z.boolean().optional()
    .describe("true lets a side's collateral name one of the pool's own two tokens, which a fall in that token would then hit twice: in the pool and in the vault's loans. When omitted or false, naming one is refused (POOL_TOKEN_COLLATERAL); a side that names no collateral never lends against them either way"),
}).strict();
export const poolVaultsInput = z.object({
  curator: address.optional().describe("Only this curator's pools; every curator's when omitted"),
}).strict();

// ---------------------------------------------------------------------------------------------------------- reads

/** The factory's categories (`IntentCategory`): a universe takes two whole (D41), real-world assets STOCK and COMMODITY,
 * the Robinhood ecosystem MEME and RH_ECOSYSTEM. */
const RWA = [0, 3];
const WEIGHTS = { RWA: [10_000, 0, 0, 10_000], RH_ECO: [0, 10_000, 10_000, 0] } as const;
type Universe = keyof typeof WEIGHTS;
const universeOf = (category: number): Universe => (RWA.includes(category) ? "RWA" : "RH_ECO");

/** A pool token as `pool` names it: a public generation's lend asset, or any other token by its address. */
type Token = { token: Address | null; symbol: string; g: Generation | null };
async function poolTokenOf(c: Ctx, ref: string): Promise<Token> {
  if (isAddress(ref, { strict: false })) {
    const g = c.d.generations.find((x) => same(x.lendAsset.token, ref)) ?? null;
    if (g) return { token: g.lendAsset.token, symbol: g.lendAsset.symbol, g };
    const info = await c.chain.tokenInfo(ref);
    requireThat(SYMBOL.test(info.symbol), "UNKNOWN_TOKEN", "That token's symbol cannot name a pool: name the pool with a lend asset and a token whose symbol has no space or slash", 400);
    return { token: ref, symbol: info.symbol, g: null };
  }
  const g = c.d.generations.find((x) => same(x.lendAsset.symbol, ref)) ?? null;
  requireThat(g, "UNKNOWN_TOKEN", "gage lends no asset of that symbol: name a token gage does not lend by its address", 400);
  return { token: g.lendAsset.token, symbol: g.lendAsset.symbol, g };
}

/** What a generation's vault may lend against now: the tokens its core's registry admits and its factory classified. */
async function admitted(c: Ctx, g: Generation, curator: Address) {
  const offered = g.primary ? c.d.assets.map((a) => ({ token: a.token, symbol: a.symbol })) : g.collateral.map((x) => ({ token: x.token, symbol: x.symbol }));
  const [factory, configs] = await Promise.all([
    c.chain.intentFactory(g.factory, curator, offered.map((t) => t.token)),
    Promise.all(offered.map((t) => c.chain.tokenConfig(g.core.registry, t.token))),
  ]);
  const tokens = offered.flatMap((t, i) => {
    const category = factory.categories[i];
    return configs[i]!.allowed && category !== null && category !== undefined ? [{ ...t, category }] : [];
  });
  return { factory, tokens };
}

/** One side of a pool as `createPoolVaults` plans it: its vault, or why its token gets none. */
export type PoolSidePlan =
  | {
      token: Address; symbol: string; created: true; factory: Address; collateral: { token: Address; symbol: string }[];
      maxLoan: string; cashKeptFreeBps: number; buysLoans: boolean;
      /** Its call's place in `calls`. */
      call: number;
    }
  | { token: Address | null; symbol: string; created: false; reason: "NOT_LENT" | "NOT_A_PARTNER"; why: string };

/** A pool's vaults, ready to create: the calls, one per vault, and the same calls as a Safe's Transaction Builder file. */
export interface PoolVaultsCreation {
  /** The name both vaults carry. */
  name: string;
  curator: Address;
  chainId: number;
  sides: [PoolSidePlan, PoolSidePlan];
  /** In the pool's order, each to its own generation's factory, all from `curator`: one wallet batch (EIP-5792 `wallet_sendCalls`, atomic), or one transaction each. */
  calls: { to: Address; data: Hex; value: "0" }[];
  /** The same calls from `curator` as a Safe{Wallet} Transaction Builder file: for a curator that is a Safe. */
  safeBatch: SafeBatch;
  notes: string[];
}

/**
 * A pool's vaults (D333) as the calls that create them, one per pool token gage lends, each on that token's own
 * generation, checked against the chain now: the factory's core and version, the curator admitted there, the collateral
 * its generation admits in one universe, and each call simulated from the curator. What both share (the fee, the
 * longest loan, the Loan grade floor, the priority fee) is named once; what is counted in each token (the largest loan,
 * the cash kept free) for each. Loans are bought and sold between USDG vaults only (D251): another asset's vault buys
 * none. Signs nothing.
 */
export async function createPoolVaults(c: Ctx, input: z.output<typeof createPoolVaultsInput>): Promise<PoolVaultsCreation> {
  const curator = input.curator as Address;
  const tokens = await Promise.all(input.pool.map((ref) => poolTokenOf(c, ref)));
  requireThat(!(tokens[0]!.token && tokens[1]!.token && same(tokens[0]!.token, tokens[1]!.token)), "POOL_TOKENS_SAME", "A pool has two different tokens", 400);
  const name = poolVaultName(input.name, tokens.map((t) => t.symbol));
  requireThat(name !== null, "NAME_TOO_LONG", `With the pool's tag, the name must fit in ${NAME_MAX_BYTES} bytes: shorten it`, 400);
  for (const s of input.sides) requireThat(tokens.some((t) => same(t.symbol, s.token) || (t.token && same(t.token, s.token))), "INVALID_INPUT", "Each side names one of the pool's tokens", 400);
  const sideOf = (t: Token) => input.sides.find((s) => same(s.token, t.symbol) || (t.token !== null && same(s.token, t.token)));

  const reads = await Promise.all(tokens.map(async (t) => (t.g ? { t, g: t.g, ...(await admitted(c, t.g, curator)) } : { t, g: null })));
  const calls: PoolVaultsCreation["calls"] = [];
  const sides = [] as PoolSidePlan[];
  for (const [i, r] of reads.entries()) {
    const other = tokens[i === 0 ? 1 : 0]!;
    if (!r.g) {
      sides.push({ token: r.t.token, symbol: r.t.symbol, created: false, reason: "NOT_LENT", why: `gage lends no vault of ${r.t.symbol}: its depositors would bring the other token alone` });
      continue;
    }
    const { g, factory, tokens: allowed } = r;
    requireThat(same(factory.core, g.core.engine) && factory.mandateVersion >= NAMED, "FACTORY_CHANGED", `${g.lendAsset.symbol}'s factory is not the one this release publishes; read gage again`, 409);
    if (!factory.isCreator && !factory.openCreation) {
      sides.push({ token: g.lendAsset.token, symbol: g.lendAsset.symbol, created: false, reason: "NOT_A_PARTNER", why: `${g.lendAsset.symbol}'s vaults are created by admitted partners only, and gage has not admitted the curator` });
      continue;
    }
    const wanted = sideOf(r.t);
    requireThat(wanted, "SIDE_NEEDED", `Name ${g.lendAsset.symbol}'s side in sides, with its maxLoan`, 400);
    const scale = 10n ** BigInt(Math.max(g.lendAsset.decimals - 6, 0));
    requireThat(BigInt(wanted.maxLoan) <= MAX_LOAN_UNITS * scale, "MAX_LOAN_TOO_HIGH", `${g.lendAsset.symbol}'s largest loan is above what a vault may lend in one loan`, 400);
    // A stock's vault lends against the memes paired with it (D249); USDG's opens on the pool's other token's universe.
    // Neither lends against a token of its own pool unless the caller names it and allowPoolTokens says it is meant: a
    // fall in that token would reach the pool twice, in its own side and in the vault's loans.
    const forced: Universe | null = g.lendAsset.stable ? null : "RH_ECO";
    const ofPool = (token: string) => tokens.some((t) => t.token !== null && same(t.token, token));
    let picked: typeof allowed;
    if (wanted.collateral) {
      picked = wanted.collateral.map((t) => {
        const found = allowed.find((a) => same(a.token, t));
        requireThat(found, "UNSUPPORTED_COLLATERAL", `${g.lendAsset.symbol}'s vaults cannot lend against ${t}`, 400);
        requireThat(input.allowPoolTokens === true || !ofPool(found.token), "POOL_TOKEN_COLLATERAL", `${found.symbol} is a token of this pool: a fall in it would reach the pool twice. Leave it out of ${g.lendAsset.symbol}'s collateral, or set allowPoolTokens if it is meant`, 400);
        return found;
      });
    } else {
      const otherHere = other.token ? allowed.find((a) => same(a.token, other.token!)) : undefined;
      const universe = forced ?? (otherHere ? universeOf(otherHere.category) : "RWA");
      picked = allowed.filter((a) => universeOf(a.category) === universe && !ofPool(a.token));
    }
    const universes = new Set(picked.map((a) => universeOf(a.category)));
    requireThat(picked.length > 0, "UNSUPPORTED_COLLATERAL", `${g.lendAsset.symbol}'s vaults can lend against no admitted token in that universe but the pool's own: name its collateral`, 400);
    requireThat(universes.size === 1 && (!forced || universes.has(forced)), "MIXED_COLLATERAL", "A vault lends against real-world assets or the Robinhood ecosystem, never both; a stock's vault against memes", 400);
    const universe = [...universes][0]!;
    // From mandate 13 every generation's vaults buy running loans (Intent D56); before it, the USDG one's alone (D251).
    const auction = factory.mandateVersion >= SECONDARY_AUCTION_MANDATE;
    const buys = (g.primary || auction) && input.buyLoans !== undefined;
    const mandate = {
      curator,
      categoryWeights: WEIGHTS[universe],
      assets: picked.map((a) => a.token),
      maxLoanTerm: input.term,
      feeBps: input.feeBps,
      minGrade: 0,
      minRateGrade: input.minRateGrade ?? 3,
      maxLoanPrincipal: BigInt(wanted.maxLoan),
      maxAssetBps: 10_000,
      bufferBps: wanted.cashKeptFreeBps ?? 1_000,
      executionCapBps: input.priorityFeeBps ?? 2_000,
    };
    const extra = buys ? input.buyLoans!.extraBps : 0;
    const data = auction ? encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [mandate, buys, extra, false, name] })
      : encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [mandate, buys, extra, name] });
    // Each factory creates for its caller only: simulated from the curator, a Safe included, before anything is handed over.
    await c.chain.simulate({ from: curator, to: g.factory, data, value: 0n });
    sides.push({
      token: g.lendAsset.token, symbol: g.lendAsset.symbol, created: true, factory: g.factory, collateral: picked.map(({ token, symbol }) => ({ token, symbol })),
      maxLoan: wanted.maxLoan, cashKeptFreeBps: mandate.bufferBps, buysLoans: buys, call: calls.length,
    });
    calls.push({ to: g.factory, data, value: "0" });
  }
  if (!calls.length) {
    throw sides.some((s) => !s.created && s.reason === "NOT_A_PARTNER")
      ? new ApiError("NOT_A_PARTNER", "The vaults of this pool's tokens are created by admitted partners only, and gage has not admitted the curator", 409)
      : new ApiError("NOT_LENT", "gage lends neither of the pool's tokens", 409);
  }
  const symbols = sides.filter((s) => s.created).map((s) => s.symbol);
  return {
    name, curator, chainId: c.d.chainId, sides: sides as [PoolSidePlan, PoolSidePlan], calls,
    safeBatch: safeBatch({
      chainId: c.d.chainId, safe: curator, name: `gage pool vaults: ${name}`, calls,
      description: `Creates ${symbols.length === 1 ? `the ${symbols[0]} vault` : `the ${symbols.join(" and ")} vaults`} of ${name}, each on its own gage factory, managed by this Safe.`,
    }),
    notes: [
      "Send calls from the curator: as one wallet batch (EIP-5792 wallet_sendCalls, atomic) or one after the other. A Safe loads safeBatch in Safe{Wallet}'s Transaction Builder and signs there; gage never signs or proposes.",
      "Both vaults carry one name ending in the pool's tag: renaming one of them unlinks it from the pool.",
      ...sides.flatMap((s) => (s.created ? [] : [s.why])),
    ],
  };
}

/** A pool's vault on gage.cash by its short link (D290), else by its address. */
const vaultPage = (c: Ctx, links: ReadonlyMap<string, string>, vault: string) => {
  const app = defaultsFor(c.d.chainId).appUrl, link = links.get(lower(vault));
  return link === undefined ? `${app}/earn/partners/${lower(vault)}` : `${app}/v/${link}`;
};

/**
 * The pools among the partner vaults (D333), a curator's alone where one is named: each with its name, its curator and
 * its two sides in the tag's order, each side its vault and gage.cash page, or none, saying whether gage lends that token.
 */
export async function poolVaults(c: Ctx, input: z.output<typeof poolVaultsInput>) {
  const [vaults, links] = await Promise.all([allPartnerVaults(c), vaultLinks(c.indexer)]);
  const sides = vaults.map(({ v, g }) => ({ address: v.address, curator: v.curator, name: vaultName(v, c.d), asset: g.lendAsset.symbol, g }));
  const pools = poolsOf(sides).filter((p) => !input.curator || same(p.curator, input.curator));
  return {
    pools: pools.map((p) => ({
      name: p.name, curator: p.curator,
      sides: p.tokens.map((symbol, i) => {
        const s = p.sides[i];
        if (s) return { symbol: s.g.lendAsset.symbol, token: s.g.lendAsset.token, lent: true, vault: s.address, factory: s.g.factory, link: vaultPage(c, links, s.address) };
        const g = c.d.generations.find((x) => same(x.lendAsset.symbol, symbol));
        return { symbol, token: g?.lendAsset.token ?? null, lent: g !== undefined, vault: null, factory: null, link: null };
      }),
    })),
    note: "A pool is one curator's vaults whose names end in the pool's tag (Fables NVDA/USDG), one for each token gage lends. A side with no vault is a token gage does not lend (lent false) or one with no vault yet.",
  };
}
