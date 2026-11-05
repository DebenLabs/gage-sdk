import type { Address } from "viem";
import type { Chain, FoundGenerationRead } from "./chain.js";
import { parseDeployment } from "./deployment.js";
import type { Ctx } from "./plans.js";

/**
 * Lend generations found on chain (r13; docs/api.md, "Lend generations found on chain"). From r13 a release publishes its
 * own generations, and every later lend generation is deployed by one Safe batch through the release's GenerationDeployer
 * (the manifest's `generationDeployer`). gage's indexer serves each one it found, as the manifest entry it would be, at
 * `GET /intent/generations`; gage-sdk reads each on chain as one that deployer built, as served
 * (`proveFoundGenerations`), and adds those to the manifest it was built with, so a new stablecoin market reaches
 * builders and agents with no new SDK release, and none is prepared into a contract the indexer alone names. The
 * manifest's own generations never depend on that answer.
 */

const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const address = (x: unknown): x is Address => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x) && BigInt(x) !== 0n;

/**
 * `raw` (a release manifest) with each found generation of `body` added to its `intentV1Assets`, each only where the SDK
 * reads the manifest with it; `raw` itself when it names no deployer or the body is not an answer for its chain. `body`
 * is one proved on chain (`proveFoundGenerations`), never an answer as the indexer sent it.
 */
export function mergeFoundGenerations(raw: unknown, body: unknown): unknown {
  if (!record(raw) || !record(raw.generationDeployer)) return raw;
  if (!record(body) || body.schemaVersion !== 1 || body.chainId !== raw.chainId || !record(body.generations)) return raw;
  let merged = raw;
  for (const [symbol, entry] of Object.entries(body.generations)) {
    const assets = record(merged.intentV1Assets) ? merged.intentV1Assets : {};
    if (Object.hasOwn(assets, symbol) || !record(entry) || entry.discovered !== true) continue;
    const next = { ...merged, intentV1Assets: { ...assets, [symbol]: entry } };
    try {
      parseDeployment(next);
    } catch {
      continue;
    }
    merged = next;
  }
  return merged;
}

/** The first path at which two JSON values differ (`""` for the values themselves), or null where they are equal. */
function difference(a: unknown, b: unknown, path = ""): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return path;
    for (let i = 0; i < a.length; i += 1) {
      const at = difference(a[i], b[i], `${path}[${i}]`);
      if (at !== null) return at;
    }
    return null;
  }
  if (record(a) && record(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const at = difference(a[key], b[key], path ? `${path}.${key}` : key);
      if (at !== null) return at;
    }
    return null;
  }
  return Object.is(a, b) ? null : path;
}

/** A found entry without its `testnetAggregator`, the testnet's stand-in for KyberSwap's router: the SDK never reads it,
 * and no contract proves it, so it is never kept. */
const withoutAggregator = ({ testnetAggregator: _aggregator, ...entry }: Record<string, unknown>): Record<string, unknown> => entry;

/**
 * The entry a found generation has, built from what the chain records of it (`read`), with the served terms, admissions
 * and cash-out routes, and the exit desk its factory is bound to where the served entry names one: shared/
 * generation-discovery.mjs `foundEntry`, ported here (test/foundGenerations.test.ts holds the two to each other in gage's
 * main repository). Throws where the served lists cannot be built from.
 */
function builtEntry(served: Record<string, unknown>, read: FoundGenerationRead): Record<string, unknown> {
  const d = read.deployed;
  const terms = record(served.engine) ? served.engine.terms : undefined;
  const collateral = served.collateral === undefined ? [] : (served.collateral as unknown[]).map((c) => {
    if (typeof (c as { token?: unknown } | null)?.token !== "string") throw new Error("a collateral row names no token");
    const row = c as { symbol: unknown; token: string; category: unknown };
    return { symbol: row.symbol, token: row.token.toLowerCase(), category: row.category };
  });
  const cashoutPools = served.cashoutPools === undefined ? [] : (served.cashoutPools as unknown[]).map((p) => ({ ...(p as object) }));
  return {
    lendAsset: { token: d.asset, symbol: read.symbol, decimals: read.decimals, stable: true },
    public: read.listed,
    generation: d.name,
    factory: d.factory,
    core: d.core,
    reserve: d.reserve,
    reserveLens: null,
    reserveKind: "closed",
    mandateVersion: read.mandateVersion,
    quoteVerifier: d.quoteVerifier,
    fillRouter: d.fillRouter,
    gradeRegistry: d.gradeRegistry,
    feeProcessor: d.feeProcessor,
    startBlock: d.blockNumber,
    rolloverRouter: d.rolloverRouter,
    engine: {
      registry: d.registry, registryArtifact: "GageV2TokenRegistry", rewards: d.rewards, cashoutRouter: d.cashoutRouter, flashPool: read.flashPool,
      startBlock: d.blockNumber, grace: 0, terms: Array.isArray(terms) ? [...(terms as unknown[])] : terms, bridged: false, rewardTerms: "registry",
    },
    collateral,
    cashoutPools,
    ...("exitDesk" in served && read.exitDesk !== null && read.mandateVersion >= 13 ? { exitDesk: read.exitDesk } : {}),
    discovered: true,
  };
}

/**
 * Why `entry`, served under `symbol`, is not the found generation the chain records (`read`), or null when it is: the
 * entry built from what the chain records must be the served one exactly, its testnet aggregator aside, so no address
 * reaches the SDK that the release's deployer did not build, nor any key a found generation never has. The rule is
 * gage.cash's own (shared/generation-discovery.mjs `foundProblem`), ported here.
 */
export function foundProblem(symbol: string, entry: unknown, read: FoundGenerationRead | null): string | null {
  if (read === null) return "the release's GenerationDeployer logged no deployment of its factory at its startBlock";
  if (!read.recorded) return "the release's GenerationDeployer has not recorded its factory (isFactory)";
  if (!record(entry)) return "not a found generation's entry";
  let built: Record<string, unknown>;
  try {
    built = builtEntry(entry, read);
  } catch (error) {
    return `what the chain records does not make its entry (${error instanceof Error ? error.message.slice(0, 80) : "unknown"})`;
  }
  if (read.symbol !== symbol) return `its key is not its asset's symbol ${JSON.stringify(read.symbol)}`;
  const at = difference(built, withoutAggregator(entry));
  return at === null ? null : `${at} is not what the chain records`;
}

/** One JSON text of a value, every object's keys sorted: the same entry always reads the same. */
const canonical = (x: unknown): string => JSON.stringify(x, (_key, v: unknown) => (record(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/**
 * `body`, an indexer answer, with only the found generations `chain` proves the manifest `raw`'s GenerationDeployer built,
 * as served (`foundProblem`), each without its testnet aggregator; each other one is added to its `refused` with the
 * reason. Null when the body is no answer for this release. `proven` remembers each entry proved, by its content, so a
 * generation is read once while the indexer serves it unchanged; a refused one is read again on the next answer.
 */
export async function proveFoundGenerations(chain: Chain, raw: unknown, body: unknown, proven: Set<string> = new Set()): Promise<Record<string, unknown> | null> {
  if (!record(raw) || !record(raw.generationDeployer) || !address(raw.generationDeployer.address)) return null;
  if (!record(body) || body.schemaVersion !== 1 || body.chainId !== raw.chainId || !record(body.generations)) return null;
  const deployer = raw.generationDeployer.address.toLowerCase() as Address;
  const from = raw.generationDeployer.startBlock;
  const checked = await Promise.all(Object.entries(body.generations).map(async ([symbol, entry]) => {
    const key = `${String(raw.chainId)}:${deployer}:${symbol}:${canonical(entry)}`;
    if (proven.has(key)) return { symbol, entry, reason: null };
    let reason: string | null;
    try {
      reason = !record(entry) || entry.discovered !== true || !address(entry.factory) || !Number.isSafeInteger(entry.startBlock)
          || typeof from !== "number" || (entry.startBlock as number) < from
        ? "not a found generation's entry"
        : foundProblem(symbol, entry, await chain.foundGeneration(deployer, entry.factory, entry.startBlock as number));
    } catch {
      reason = "it could not be read on chain now";
    }
    if (reason === null) proven.add(key);
    return { symbol, entry, reason };
  }));
  const refused = checked.filter((c) => c.reason !== null)
    .map(({ symbol, entry, reason }) => ({ id: null, core: record(entry) && typeof entry.core === "string" ? entry.core : null, symbol, reason }));
  return { ...body, generations: Object.fromEntries(checked.filter((c) => c.reason === null).map((c) => [c.symbol, withoutAggregator(c.entry as Record<string, unknown>)])),
    refused: [...(Array.isArray(body.refused) ? (body.refused as unknown[]) : []), ...refused] };
}

/**
 * Asks gage's indexer (`ctx.indexer`) for the found generations at most once per `intervalMs` (60 seconds by default),
 * proves them on chain (`ctx.chain`), and sets `ctx.d` to the manifest `raw` with those; a failed ask keeps what it had.
 */
export function foundGenerationsRefresher(ctx: Ctx, raw: unknown, { intervalMs = 60_000, now = Date.now }: { intervalMs?: number; now?: () => number } = {}) {
  let askedAt = -Infinity, flight: Promise<void> | null = null;
  const proven = new Set<string>();
  return (force = false): Promise<void> => {
    if (flight) return flight;
    if (!force && now() - askedAt < intervalMs) return Promise.resolve();
    askedAt = now();
    flight = (async () => {
      try {
        const { status, body } = await ctx.indexer.raw("/intent/generations");
        if (status !== 200) return;
        const proved = await proveFoundGenerations(ctx.chain, raw, body, proven);
        if (proved !== null) ctx.d = parseDeployment(mergeFoundGenerations(raw, proved));
      } catch {
        // The last good deployment stays.
      }
    })().finally(() => { flight = null; });
    return flight;
  };
}
