/**
 * Retained generations (docs/api.md "Historical service retention") beside puts (docs/api.md "Puts on lend-asset
 * generations"): a release that replaces GLDx's put generation keeps the old one for its positions, so a put loan on the
 * old core still closes through the old core's own put router, buying through the old entry's pools, while a new put
 * opens on the current generation alone. Nothing rolls a loan on the old core any more, by hand or by itself: gage's
 * keeper rolls through current generations' routers alone and the rates service quotes no roll of a retained one, so
 * gage-sdk neither offers nor prepares one there, and an instruction left on the old routers can still be ended.
 */
import { decodeFunctionData, getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { putRouterAbi, rolloverRouterAbi } from "../src/abi.js";
import { gageFrom } from "../src/client.js";
import { generationOfCore, parseDeployment, putGenerations, putRouterOf, rolloverRouterOf, type Deployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { actionsOn } from "../src/networks.js";
import { prepareNext } from "../src/prepare.js";
import { loan as readLoan, portfolio } from "../src/reads.js";
import type { ActionName } from "../src/schemas.js";
import {
  A, ctx, fakeChain, fakeUpstream, GLD_CORE, GLD_FACTORY, GLD_LOOP, GLD_PUT, GLDX, KEEPER, loan, manifest, NOW, OLD, position, PUT_POOL, putManifest, rollQuote,
  USDG, WALLET,
} from "../src/testing.js";

const RETAINED = "https://old-indexer.example";
const NEW = { factory: A(0x5a), core: A(0x2a), registry: A(0x3a), rewards: A(0x4a), loop: A(0x6a), put: A(0x7a), roll: A(0x8a) };
/** The old generation's rollover router (D285), which its entry names beside its loop and put routers. */
const GLD_ROLL = A(0xb6);
/** The parser checksums every address it reads. */
const C = getAddress;
const E18 = 10n ** 18n;

/**
 * The put fixture after GLDx's generation is replaced: the old entry, its routers and pools included, is kept with its own
 * index. `current` changes the new entry.
 */
function replaced(current: Record<string, unknown> = {}) {
  const m = putManifest();
  const old = { ...m.intentV1Assets.GLDx, rolloverRouter: GLD_ROLL };
  const next = {
    ...old, factory: NEW.factory, core: NEW.core, loopRouter: NEW.loop, putRouter: NEW.put, rolloverRouter: NEW.roll,
    engine: { ...old.engine, registry: NEW.registry, rewards: NEW.rewards }, ...current,
  };
  return { ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: next }, intentV1AssetsPrevious: { GLDx: [{ entry: old, indexerUrl: RETAINED }] } };
}

describe("a retained put generation", () => {
  it("keeps its loop, put and rollover routers and its pools, for its own loans only", () => {
    const d = parseDeployment(replaced());
    const [old] = d.retired;
    expect([old?.id, old?.factory, old?.core.engine, old?.retired?.indexerUrl]).toEqual(["GLDx", C(GLD_FACTORY), C(GLD_CORE), RETAINED]);
    expect([old?.loopRouter, old?.putRouter, old?.rolloverRouter]).toEqual([C(GLD_LOOP), C(GLD_PUT), C(GLD_ROLL)]);
    expect(old?.loopPools.get(USDG.toLowerCase())?.length).toBe(2);
    // A loan on the old core closes, and ends an instruction left for it, through its own core's routers; a new put
    // opens on the current generation alone.
    expect(putRouterOf(d, GLD_CORE)).toBe(C(GLD_PUT));
    expect(rolloverRouterOf(d, GLD_CORE)).toBe(C(GLD_ROLL));
    expect([putRouterOf(d, NEW.core), rolloverRouterOf(d, NEW.core)]).toEqual([C(NEW.put), C(NEW.roll)]);
    expect(generationOfCore(d, GLD_CORE)?.retired?.indexerUrl).toBe(RETAINED);
    expect(putGenerations(d).map((g) => [g.core.engine, g.lendAsset.token])).toEqual([[C(NEW.core), C(GLDX)]]);
  });

  it("is a USDG one with no loop or put router, buying through USDG's pools", () => {
    const m = manifest();
    const d = parseDeployment({ ...m, intentV1Previous: [{ intentV1: { core: OLD, factory: A(0x52) }, intentV1IndexerUrl: RETAINED }] });
    const [old] = d.retired;
    expect([old?.primary, old?.loopRouter, old?.putRouter, old?.retired?.indexerUrl]).toEqual([true, null, null, RETAINED]);
    expect(old?.loopPools).toBe(d.loopPools);
    expect(putRouterOf(d, OLD)).toBeNull();
  });
});

/** A put on the old core, as its retained index lists it: 400 USDG pledged for 1.5 GLDx, repaying 1.506 within 7 days. */
const oldPut = () => position("7", { engine: GLD_CORE }, { token: USDG, collateral: "400000000", principal: "1500000000000000000", cap: "1506000000000000000" });
const putLoan = (over: Parameters<typeof loan>[0] = {}) =>
  loan({ token: USDG, collateral: 400_000_000n, principal: 3n * E18 / 2n, cap: 1_506_000_000_000_000_000n, originationFee: 15n * 10n ** 15n, ...over });
/** The instruction the wallet left on both old routers before the release replaced the generation: three rolls and months left. */
const standing = { borrower: WALLET, executor: KEEPER, term: 604_800, window: 21_600, rollsLeft: 3, withRewards: false, until: NOW + 10 ** 7, maxCost: 1n, maxTopUp: 1n };
const leftOn = [GLD_ROLL, GLD_PUT].map((r) => r.toLowerCase());

/**
 * gage's services and a chain where the put runs on the old core, read from the old core's own index, and both old
 * routers keep the wallet's instruction for it. The rates service would quote a roll of it through the old rollover
 * router, so a refusal is the SDK's own.
 */
function onRetained(over: { d?: Deployment; chain?: Record<string, unknown> } = {}) {
  const none = { items: [], nextCursor: null };
  const current = fakeUpstream({ "/v2/positions?": none, "/intent/partners/vaults?": none });
  const retained = fakeUpstream({
    "/v2/positions/": oldPut(),
    "/v2/positions?": (path: string) => ({ status: 200, body: path.includes(`engine=${GLD_CORE}`) ? { items: [oldPut()], nextCursor: null } : none }),
    "/intent/partners/vaults?": none,
  });
  const rates = fakeUpstream({
    "/intent/roll/quotes/": rollQuote({ engine: GLD_CORE, router: GLD_ROLL, token: USDG, collateral: 400_000_000n, principal: 3n * E18 / 2n, cap: 1_506_000_000_000_000_000n, oldCap: 1_506_000_000_000_000_000n }),
  });
  const chain = fakeChain({
    poolState: () => Promise.resolve(PUT_POOL), loan: () => Promise.resolve(putLoan()),
    autoRoll: (router: Address) => Promise.resolve(leftOn.includes(router.toLowerCase()) ? standing : null), ...over.chain,
  });
  const c = { ...ctx({ d: over.d ?? parseDeployment(replaced()), indexer: current, rates, chain }), indexerAt: (url: string) => (url === RETAINED ? retained : current) };
  return { c, rates };
}
const on = { wallet: WALLET, loanId: "7", engine: GLD_CORE };
const refusal = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) { return e instanceof ApiError ? { code: e.code, message: e.message } : { code: String(e), message: "" }; }
};
const RETIRED = expect.stringContaining("generation retired") as string;
/** The hosted service's actions: those its review page draws, none of them a roll. */
const HOSTED: ActionName[] = ["borrow", "leverage", "cancel", "reclaim", "earn_deposit", "earn_redeem", "collect", "feedback"];
const rolling = (actions: readonly string[]) => actions.filter((a) => /roll|put_/.test(a));

// Review finding F1: a loan on a retained generation was offered and prepared rolls, and read as rolling by itself,
// though nothing runs them: its borrower, told it rolls, could let it run to its end and lose the pledge.
describe("a loan on a retained generation", () => {
  it("is never rolled through its old routers, by hand or by itself: each is refused before anything is priced", async () => {
    const { c, rates } = onRetained();
    expect(await refusal(prepareNext(c, { action: "roll", ...on }))).toEqual({ code: "ROLLOVER_CLOSED", message: RETIRED });
    expect(await refusal(prepareNext(c, { action: "auto_roll", ...on }))).toEqual({ code: "ROLLOVER_CLOSED", message: RETIRED });
    expect(await refusal(prepareNext(c, { action: "put_roll", ...on }))).toEqual({ code: "PUT_CLOSED", message: RETIRED });
    expect(await refusal(prepareNext(c, { action: "put_auto_roll", ...on }))).toEqual({ code: "PUT_CLOSED", message: RETIRED });
    expect(rates.asked).toEqual([]);
  });

  it("still ends the instruction left on either old router, and closes the put through its old put router", async () => {
    const { c } = onRetained();
    const ended = await prepareNext(c, { action: "cancel_auto_roll", ...on });
    expect(ended.next!.transaction.to.toLowerCase()).toBe(GLD_ROLL);
    expect(decodeFunctionData({ abi: rolloverRouterAbi, data: ended.next!.transaction.data })).toMatchObject({ functionName: "cancelAutoRoll", args: [7n] });
    const putEnded = await prepareNext(c, { action: "put_cancel_auto_roll", ...on });
    expect(putEnded.next!.transaction.to.toLowerCase()).toBe(GLD_PUT);
    expect(decodeFunctionData({ abi: putRouterAbi, data: putEnded.next!.transaction.data })).toMatchObject({ functionName: "cancelAutoRoll", args: [7n] });
    // The right approved to the old put router, the close buys the repayment back through the old entry's own v4 pool.
    const closed = await prepareNext(onRetained({ chain: { approvedFor: () => Promise.resolve(GLD_PUT) } }).c, { action: "put_close", ...on });
    expect(closed.next!.transaction.to.toLowerCase()).toBe(GLD_PUT);
    expect(decodeFunctionData({ abi: putRouterAbi, data: closed.next!.transaction.data })).toMatchObject({ functionName: "close", args: [{ loanId: 7n, swap: { venue: 0 } }] });
    expect(closed.notes).toContain("Closing ends this loan's instruction to roll by itself.");
  });

  it("reads as rolling by nothing: no roll offered and no instruction shown, a note saying why, and the close and the ends kept", async () => {
    const { c } = onRetained();
    const l = await readLoan(c, { loanId: "7", engine: GLD_CORE });
    expect(rolling(l.actions)).toEqual([
      "cancel_auto_roll (the wallet that left the instruction)", "put_close (holder of the reclaim right, before endsAt)",
      "put_cancel_auto_roll (the wallet that left the instruction)",
    ]);
    expect(l).toMatchObject({ autoRoll: null, putAutoRoll: null, note: RETIRED });
    // gage.cash offers no roll on a retained generation, nor the end of an instruction there: the hosted service names none.
    expect(rolling((await readLoan(c, { loanId: "7", engine: GLD_CORE }, HOSTED)).actions)).toEqual([]);
    // A listing on the old core is cancelled, never left to roll by itself.
    const listing = onRetained({ chain: { loan: () => Promise.resolve(putLoan({ state: 1, fundedAt: 0 })) } }).c;
    expect((await readLoan(listing, { loanId: "7", engine: GLD_CORE })).actions).toEqual([
      "cancel (borrower)", "cancel_auto_roll (the wallet that left the instruction)", "put_cancel_auto_roll (the wallet that left the instruction)",
    ]);
  });

  it("reads in the portfolio as not rolling by itself, with the note", async () => {
    const p = await portfolio(onRetained().c, WALLET);
    expect(p.loans).toEqual([expect.objectContaining({ engine: C(GLD_CORE), loanId: "7", autoRoll: false, note: RETIRED })]);
  });
});

describe("a release whose only rollover and put routers are a retained generation's", () => {
  /** Neither USDG's generation nor the current GLDx one names a rollover, loop or put router; the old GLDx one names all three. */
  const d = () => parseDeployment({
    ...replaced({ loopRouter: undefined, putRouter: undefined, rolloverRouter: undefined }), intentV1: { ...manifest().intentV1, rolloverRouter: A(0) },
  });
  const ROLLS: ActionName[] = ["roll", "auto_roll", "cancel_auto_roll", "put_open", "put_close", "put_roll", "put_auto_roll", "put_cancel_auto_roll"];

  it("serves the close and the ends of what was left there, and no roll", async () => {
    expect(actionsOn(d()).filter((a) => ROLLS.includes(a))).toEqual(["cancel_auto_roll", "put_close", "put_cancel_auto_roll"]);
    const gage = gageFrom(onRetained({ d: d() }).c);
    const ended = await gage.prepare({ action: "put_cancel_auto_roll", ...on });
    expect(ended.next!.transaction.to.toLowerCase()).toBe(GLD_PUT);
    expect((await refusal(gage.prepare({ action: "put_roll", ...on })))?.code).toBe("ACTION_NOT_SERVED");
  });
});
