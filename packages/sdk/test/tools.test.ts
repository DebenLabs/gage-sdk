import { describe, expect, it } from "vitest";
import { gageFrom } from "../src/client.js";
import { ApiError } from "../src/errors.js";
import { gageTools } from "../src/tools.js";
import { parseDeployment } from "../src/deployment.js";
import { MAINNET_MANIFEST } from "../src/deployments/mainnet.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { actionsOn } from "../src/networks.js";
import { A, ctx, fakeChain, fakeSigner, mainnetManifest, manifest, NVDA, OTHER, WALLET } from "../src/testing.js";
/** NVDAx's puts, once its generation's own puts release names its put router: #760 for r4, after its activation for r11's r5. */
const TESTNET_PUTS = Boolean((TESTNET_MANIFEST as unknown as { intentV1Assets?: Record<string, { putRouter?: string }> }).intentV1Assets?.NVDAx?.putRouter);
/** The testnet's current generations as bundled: the USDG one and each lend asset's. */
const TESTNET_GENERATIONS = [(TESTNET_MANIFEST as unknown as { intentV1: { rolloverRouter?: string; exitDesk?: string } }).intentV1,
  ...Object.values((TESTNET_MANIFEST as unknown as { intentV1Assets?: Record<string, { rolloverRouter?: string; exitDesk?: string }> }).intentV1Assets ?? {})];
/** Retained asset routers only close positions and end instructions; they enable no new put or roll. */
const TESTNET_RETAINED = Object.values((TESTNET_MANIFEST as unknown as { intentV1AssetsPrevious?: Record<string, { entry: { rolloverRouter?: string; putRouter?: string } }[]> }).intentV1AssetsPrevious ?? {})
  .flatMap((rows) => rows.map(({ entry }) => entry));
/** Rolling over, once a testnet generation's rollover release names its router (r11's, 23 October 2026; a fresh USDG
 * generation names none until its own, as r13's on 29 October, while the lend assets keep theirs), and rolling over by
 * itself once the release also names the keeper (`rolloverExecutor`, D285). */
const TESTNET_ROLLS = TESTNET_GENERATIONS.some((g) => Boolean(g.rolloverRouter));
const TESTNET_KEEPER = Boolean((TESTNET_MANIFEST as unknown as { rolloverExecutor?: string }).rolloverExecutor);
const TESTNET_AUTO_ROLL = TESTNET_ROLLS && TESTNET_KEEPER;
const TESTNET_CANCEL_ROLLS = TESTNET_ROLLS || TESTNET_RETAINED.some((g) => Boolean(g.rolloverRouter));
const TESTNET_PUT_CLOSES = TESTNET_PUTS || TESTNET_RETAINED.some((g) => Boolean(g.putRouter));
/** The testnet's LP lane, once public: the bundled release drops a hidden one (sync-deployment). */
const TESTNET_LP = Boolean((TESTNET_MANIFEST as unknown as { lpLane?: { public?: boolean } }).lpLane?.public);
// The testnet's lane serves Fables (29 October 2026): its wrap and unwrap actions come with it.
const TESTNET_FABLES = Boolean((TESTNET_MANIFEST as unknown as { lpLane?: { adapters?: { kind: string }[] } }).lpLane?.adapters?.some((a) => a.kind === "fables"));
// The testnet's lane moved to reserve vaults (D454, 7 November 2026): with its rewards bridge named, a holder claims sGAGE.
const TESTNET_LP_REWARDS = Boolean((TESTNET_MANIFEST as unknown as { lpLane?: { rewardsBridge?: string } }).lpLane?.rewardsBridge);
/** Park and unpark (D334) are served wherever the release names an LP lane, its switch on or off: its pools are parked from. */
const TESTNET_PARK = Boolean((TESTNET_MANIFEST as unknown as { lpLane?: unknown }).lpLane);
/** Exit now (Intent D57, root D357), once a current generation names the chain's exit desk (r13's, 29 October 2026). */
const TESTNET_EXIT = TESTNET_GENERATIONS.some((g) => Boolean(g.exitDesk));

const borrow = { token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 604_800 };
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const byName = (tools: ReturnType<typeof gageTools>, name: string) => tools.find((t) => t.name === name)!;

describe("the tool catalogue", () => {
  it("is eight reads and a prepare per action, and a signer adds its wallet and each action, which move funds", () => {
    const gage = gageFrom(ctx());
    const tools = gageTools(gage);
    expect(tools.map((t) => t.name)).toEqual([
      "gage_capabilities", "gage_assets", "gage_borrow_quote", "gage_leverage_quote", "gage_loan", "gage_portfolio", "gage_earn_vaults", "gage_vault_free_cash",
      "gage_prepare_borrow", "gage_prepare_leverage", "gage_prepare_cancel", "gage_prepare_reclaim", "gage_prepare_cash_out", "gage_prepare_roll", "gage_prepare_auto_roll",
      "gage_prepare_cancel_auto_roll", "gage_prepare_earn_deposit", "gage_prepare_earn_redeem", "gage_prepare_collect", "gage_prepare_create_vault", "gage_prepare_vault_manage",
    ]);
    expect(tools.filter((t) => t.annotations.readOnlyHint)).toHaveLength(8);
    expect(tools.some((t) => t.annotations.destructiveHint)).toBe(false);
    const signed = gageTools(gage, { signer: fakeSigner() });
    expect(signed.slice(21).map((t) => t.name)).toEqual([
      "gage_wallet", "gage_borrow", "gage_leverage", "gage_cancel", "gage_reclaim", "gage_cash_out", "gage_roll", "gage_auto_roll", "gage_cancel_auto_roll",
      "gage_earn_deposit", "gage_earn_redeem", "gage_collect", "gage_create_vault", "gage_vault_manage",
    ]);
    expect(signed.slice(22).every((t) => t.annotations.destructiveHint && !t.annotations.readOnlyHint)).toBe(true);
    expect(byName(signed, "gage_borrow").description).toContain("0x35FC…BC07");
    expect(signed.every((t) => t.title.length > 0)).toBe(true);
  });

  it("answers in plain JSON, every raw amount a decimal string", async () => {
    const tools = gageTools(gageFrom(ctx({ chain: fakeChain({ allowance: () => Promise.resolve(10n ** 30n) }) })));
    const prepared = await byName(tools, "gage_prepare_borrow").execute({ wallet: WALLET, ...borrow });
    expect(prepared).toMatchObject({ status: "ready", next: { final: true, transaction: { value: "0", gas: "100000", chainId: 46630 } } });
    expect(await code(byName(tools, "gage_prepare_borrow").execute({ wallet: "nope", ...borrow }))).toBe("INVALID_INPUT");
  });

  it("serves only the actions its Gage serves: their tools, its capabilities, and a refusal for any other", async () => {
    const actions = ["borrow", "collect"] as const;
    const gage = gageFrom(ctx(), { actions });
    const tools = gageTools(gage, { signer: fakeSigner() });
    expect(tools.filter((t) => /^gage_(prepare_)?(borrow|collect|roll)$/.test(t.name)).map((t) => t.name))
      .toEqual(["gage_prepare_borrow", "gage_prepare_collect", "gage_borrow", "gage_collect"]);
    expect(await byName(tools, "gage_capabilities").execute({})).toMatchObject({ actions: ["borrow", "collect"] });
    expect(await code(gage.prepare({ action: "roll", wallet: WALLET, loanId: "7" }))).toBe("ACTION_NOT_SERVED");
    expect(await code(gage.run({ action: "cancel", loanId: "7" }, fakeSigner()))).toBe("ACTION_NOT_SERVED");
    expect(await code(gage.prepare({ action: "nope", wallet: WALLET }))).toBe("INVALID_INPUT");
  });

  it("lets the hosted service answer prepares its own way and end their description", async () => {
    const tools = gageTools(gageFrom(ctx()), { prepare: (i) => Promise.resolve({ asked: i.action }), prepareNote: "And a review link." });
    expect(await byName(tools, "gage_prepare_collect").execute({ wallet: WALLET })).toEqual({ asked: "collect" });
    expect(byName(tools, "gage_prepare_collect").description).toMatch(/And a review link\.$/);
  });

  it("acts for the signer's wallet only: an action's input never names a wallet", async () => {
    const signer = fakeSigner();
    const tools = gageTools(gageFrom(ctx()), { signer });
    expect(await code(byName(tools, "gage_borrow").execute({ wallet: OTHER, ...borrow }))).toBe("INVALID_INPUT");
    const done = await byName(tools, "gage_borrow").execute(borrow);
    expect(done).toMatchObject({ status: "done", wallet: WALLET, sent: [{ label: "Approve NVDAx" }, { label: "Borrow" }] });
    expect(await byName(tools, "gage_wallet").execute({})).toMatchObject({ wallet: WALLET, eth: "1000000000000000000" });
  });
});

// Mainnet (D260): Steward and Builders open, Valet waits for spend limits (D225). The catalogue reads and prepares there,
// and names mainnet and gage.cash; no AI agent gets a tool that signs with its own key. A rating of gage is served
// there only (D302), where gage has an ERC-8004 entry.
describe("the tool catalogue on mainnet", () => {
  const mainnet = () => gageFrom(ctx({ d: parseDeployment(mainnetManifest()) }));

  it("reads and prepares, and says it is mainnet's", async () => {
    const tools = gageTools(mainnet());
    expect(tools).toHaveLength(22);
    expect(tools.at(-1)!.name).toBe("gage_prepare_vault_manage");
    expect(await byName(tools, "gage_capabilities").execute({})).toMatchObject({ network: "mainnet", chainId: 4663, app: "https://gage.cash" });
    const prepared = await byName(gageTools(gageFrom(ctx({ d: parseDeployment(mainnetManifest()), chain: fakeChain({ allowance: () => Promise.resolve(10n ** 30n) }) }))), "gage_prepare_borrow")
      .execute({ wallet: WALLET, ...borrow });
    expect(prepared).toMatchObject({ status: "ready", next: { transaction: { chainId: 4663 } } });
  });

  it("serves a signer without a spend limit too: the wallet's owner chooses (D311)", async () => {
    const signer = fakeSigner();
    const tools = gageTools(gageFrom(ctx({ d: parseDeployment(mainnetManifest()) })), { signer });
    expect(tools).toHaveLength(37);
    expect(await byName(tools, "gage_borrow").execute(borrow)).toMatchObject({ status: "done" });
    expect(signer.sent.every((t) => t.chainId === 4663)).toBe(true);
  });

  it("hands every action of a limited signer's to its limit, with the plan, before anything is sent", async () => {
    const views: string[] = [];
    const limit = (view: { action: string }) => { views.push(view.action); return { release: () => undefined }; };
    const signer = fakeSigner();
    const tools = gageTools(gageFrom(ctx({ d: parseDeployment(mainnetManifest()) })), { signer, limit });
    expect(tools).toHaveLength(37);
    expect(await byName(tools, "gage_borrow").execute(borrow)).toMatchObject({ status: "done" });
    expect(views).toEqual(["borrow"]);
    expect(signer.sent.every((t) => t.chainId === 4663)).toBe(true);
  });

  it("still lets a builder's own code carry an action out with run() and its own signer", async () => {
    const signer = fakeSigner();
    const r = await gageFrom(ctx({ d: parseDeployment(mainnetManifest()) })).run({ action: "borrow", ...borrow }, signer);
    expect(r.status).toBe("done");
    expect(signer.sent.every((t) => t.chainId === 4663)).toBe(true);
  });
});

describe("the tool catalogue on the testnet", () => {
  it("names the testnet and its app", async () => {
    expect(await byName(gageTools(gageFrom(ctx())), "gage_capabilities").execute({})).toMatchObject({ network: "testnet", chainId: 46630, app: "https://testnet.gage.cash" });
  });
});

// An action a deployment cannot carry out is not served: no rollover router in any generation is no roll, nor a roll by
// itself without the keeper the release names; no cash-out router on any core is no cash-out.
describe("the actions a deployment serves", () => {
  const ROLLS = ["roll", "auto_roll", "cancel_auto_roll"];

  it("follow mainnet's release: every current generation rolls, NVDA's puts open and roll, retained routers end instructions, and the public LP lane lends and parks", () => {
    // r13 (4 November 2026) names the chain's exit desk: the five exit actions. Its USDG, NVDA and HIMS generations name
    // their rollover routers since 5 November (and the manifest its executor), GLD's since its own release the same day: a
    // roll by hand and by itself. NVDA's names its loop and put routers since its puts release (5 November): puts open,
    // close and roll, by hand and by themselves. The r3 generations are retained with their rollover routers, which still
    // end an instruction left there (`cancel_auto_roll`). The LP lane, public since the founders' go-live (5 November
    // 2026): its fourteen actions, Fables' wrap and unwrap and a curator's vault through its factory among them, and its
    // pools park and unpark (D334). Since its move to reserve vaults (D454, 7 November 2026) it names its rewards bridge: a
    // holder's sGAGE claim too.
    const d = parseDeployment(MAINNET_MANIFEST);
    expect(d.generations.filter((g) => g.rolloverRouter !== null).map((g) => g.id)).toEqual(["USDG", "GLD", "NVDA", "HIMS"]);
    expect(d.retired.filter((g) => g.rolloverRouter !== null).map((g) => g.id)).toEqual(["GLD", "NVDA", "HIMS"]);
    expect(actionsOn(d)).toEqual([
      "borrow", "leverage", "cancel", "reclaim", "cash_out", "roll", "auto_roll", "cancel_auto_roll", "earn_deposit", "earn_redeem", "collect", "feedback",
      "put_open", "put_close", "put_roll", "put_auto_roll", "put_cancel_auto_roll",
      "lp_borrow", "lp_repay", "lp_return_position", "lp_collect", "lp_withdraw", "lp_deposit", "lp_redeem", "lp_claim_bonus", "lp_claim_rewards", "lp_roll",
      "lp_wrap", "lp_unwrap", "lp_create_vault", "lp_vault_add_pool", "lp_vault_remove_pool",
      "park", "unpark",
      "rehypo_exit_now", "earn_exit_now", "earn_exit_list", "earn_exit_cancel", "earn_exit_collect", "create_vault", "vault_manage",
    ]);
  });

  it("follow the testnet release's rollover routers and keeper, and so its tools and capabilities", async () => {
    const d = parseDeployment(TESTNET_MANIFEST);
    // Its generations roll by hand once their rollover routers are named, and by themselves once the keeper is too.
    // NVDAx's put router serves puts, rolled the same way, once its generation's puts release names it. Its LP lane, while
    // public: the lane's twelve actions, its own loan roll (LPCore.roll) among them. Its exit desk: the five exit actions.
    // Retained routers add only cancellation and put closing, never a new put, quote or roll.
    const rolls = [...(TESTNET_ROLLS ? ["roll", ...(TESTNET_AUTO_ROLL ? ["auto_roll"] : [])] : []), ...(TESTNET_CANCEL_ROLLS ? ["cancel_auto_roll"] : [])];
    const puts = [
      ...(TESTNET_PUTS ? ["put_open"] : []), ...(TESTNET_PUT_CLOSES ? ["put_close"] : []),
      ...(TESTNET_PUTS ? ["put_roll", ...(TESTNET_KEEPER ? ["put_auto_roll"] : [])] : []), ...(TESTNET_PUT_CLOSES ? ["put_cancel_auto_roll"] : []),
    ];
    const exits = TESTNET_EXIT ? ["rehypo_exit_now", "earn_exit_now", "earn_exit_list", "earn_exit_cancel", "earn_exit_collect"] : [];
    expect(actionsOn(d)).toEqual([
      "borrow", "leverage", "cancel", "reclaim", "cash_out", ...rolls, "earn_deposit", "earn_redeem", "collect",
      ...puts,
      ...(TESTNET_LP ? ["lp_borrow", "lp_repay", "lp_return_position", "lp_collect", "lp_withdraw", "lp_deposit", "lp_redeem", "lp_claim_bonus",
        ...(TESTNET_LP_REWARDS ? ["lp_claim_rewards"] : []), "lp_roll",
        ...(TESTNET_FABLES ? ["lp_wrap", "lp_unwrap"] : []), "lp_create_vault", "lp_vault_add_pool", "lp_vault_remove_pool"] : []),
      ...(TESTNET_PARK ? ["park", "unpark"] : []),
      ...exits,
      "create_vault", "vault_manage",
    ]);
    const gage = gageFrom(ctx({ d }));
    expect(gage.actions.filter((a) => ROLLS.includes(a))).toEqual(rolls);
    const names = gageTools(gage, { signer: fakeSigner() }).map((t) => t.name);
    // A prepare and a signed run for each roll action.
    expect(names.filter((n) => /roll/.test(n) && !/put|_lp_/.test(n)).sort()).toEqual(rolls.flatMap((a) => [`gage_prepare_${a}`, `gage_${a}`]).sort());
    // Retained puts add their close and cancellation tools, but no quote or new put/roll tools.
    expect(names.filter((n) => /put/.test(n))).toEqual([
      ...(TESTNET_PUTS ? ["gage_put_quote"] : []), ...puts.map((a) => `gage_prepare_${a}`), ...puts.map((a) => `gage_${a}`),
    ]);
    // 29 without the lane, and its 28 while public: four reads, and a prepare and a signed run for each of its twelve actions,
    // 32 with Fables' wrap and unwrap, and 34 with a reserve vault's sGAGE claim once the lane names its rewards bridge (D454).
    const lpTools = TESTNET_LP ? 28 + (TESTNET_FABLES ? 4 : 0) + (TESTNET_LP_REWARDS ? 2 : 0) : 0;
    expect(names.filter((n) => /_lp_/.test(n))).toHaveLength(lpTools);
    // Park's read, and a prepare and a signed run for park and unpark.
    expect(names.filter((n) => /park/.test(n))).toHaveLength(TESTNET_PARK ? 5 : 0);
    // A prepare and a signed run for each exit action.
    expect(names.filter((n) => /exit/.test(n)).sort()).toEqual(exits.flatMap((a) => [`gage_prepare_${a}`, `gage_${a}`]).sort());
    expect(names).toHaveLength(29 + lpTools + 2 * rolls.length + (TESTNET_PUTS ? 1 : 0) + 2 * puts.length + (TESTNET_PARK ? 5 : 0) + 2 * exits.length);
    if (TESTNET_ROLLS) expect((await gage.capabilities()).actions).toContain("roll");
    else {
      expect((await gage.capabilities()).actions).not.toContain("roll");
      expect(await code(gage.prepare({ action: "roll", wallet: WALLET, loanId: "7" }))).toBe("ACTION_NOT_SERVED");
    }
  });

  it("leave a roll by itself out without the keeper, and a cash-out out where no core has a cash-out router", () => {
    expect(actionsOn(parseDeployment({ ...manifest(), rolloverExecutor: undefined })).filter((a) => ROLLS.includes(a))).toEqual(["roll", "cancel_auto_roll"]);
    expect(actionsOn(parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, rolloverRouter: A(0) } })).filter((a) => ROLLS.includes(a))).toEqual([]);
    const routerless = parseDeployment({ ...manifest(), nativeV2: { ...manifest().nativeV2, engines: manifest().nativeV2.engines.map((e) => ({ ...e, cashoutRouter: undefined })) } });
    expect(actionsOn(routerless)).not.toContain("cash_out");
    expect(gageFrom(ctx({ d: routerless }), { actions: ["cash_out", "borrow"] }).actions).toEqual(["borrow"]);
  });
});
