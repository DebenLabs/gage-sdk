import { describe, expect, it } from "vitest";
import { gageFrom } from "../src/client.js";
import { ApiError } from "../src/errors.js";
import { gageTools } from "../src/tools.js";
import { parseDeployment } from "../src/deployment.js";
import { MAINNET_MANIFEST } from "../src/deployments/mainnet.js";
import { TESTNET_MANIFEST } from "../src/deployments/testnet.js";
import { actionsOn } from "../src/networks.js";
import { A, ctx, fakeChain, fakeSigner, mainnetManifest, manifest, NVDA, OTHER, WALLET } from "../src/testing.js";

const borrow = { token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 604_800 };
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const byName = (tools: ReturnType<typeof gageTools>, name: string) => tools.find((t) => t.name === name)!;

describe("the tool catalogue", () => {
  it("is seven reads and a prepare per action, and a signer adds its wallet and each action, which move funds", () => {
    const gage = gageFrom(ctx());
    const tools = gageTools(gage);
    expect(tools.map((t) => t.name)).toEqual([
      "gage_capabilities", "gage_assets", "gage_borrow_quote", "gage_leverage_quote", "gage_loan", "gage_portfolio", "gage_earn_vaults",
      "gage_prepare_borrow", "gage_prepare_leverage", "gage_prepare_cancel", "gage_prepare_reclaim", "gage_prepare_cash_out", "gage_prepare_roll", "gage_prepare_auto_roll",
      "gage_prepare_cancel_auto_roll", "gage_prepare_earn_deposit", "gage_prepare_earn_redeem", "gage_prepare_collect",
    ]);
    expect(tools.filter((t) => t.annotations.readOnlyHint)).toHaveLength(7);
    expect(tools.some((t) => t.annotations.destructiveHint)).toBe(false);
    const signed = gageTools(gage, { signer: fakeSigner() });
    expect(signed.slice(18).map((t) => t.name)).toEqual([
      "gage_wallet", "gage_borrow", "gage_leverage", "gage_cancel", "gage_reclaim", "gage_cash_out", "gage_roll", "gage_auto_roll", "gage_cancel_auto_roll",
      "gage_earn_deposit", "gage_earn_redeem", "gage_collect",
    ]);
    expect(signed.slice(19).every((t) => t.annotations.destructiveHint && !t.annotations.readOnlyHint)).toBe(true);
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
    expect(tools).toHaveLength(19);
    expect(tools.at(-1)!.name).toBe("gage_prepare_feedback");
    expect(await byName(tools, "gage_capabilities").execute({})).toMatchObject({ network: "mainnet", chainId: 4663, app: "https://gage.cash" });
    const prepared = await byName(gageTools(gageFrom(ctx({ d: parseDeployment(mainnetManifest()), chain: fakeChain({ allowance: () => Promise.resolve(10n ** 30n) }) }))), "gage_prepare_borrow")
      .execute({ wallet: WALLET, ...borrow });
    expect(prepared).toMatchObject({ status: "ready", next: { transaction: { chainId: 4663 } } });
  });

  it("serves a signer only with spend limits (D225, D297)", () => {
    expect(() => gageTools(mainnet(), { signer: fakeSigner() })).toThrow(ApiError);
    try { gageTools(mainnet(), { signer: fakeSigner() }); } catch (e) { expect((e as ApiError).code).toBe("SIGNING_CLOSED"); }
  });

  it("hands every action of a limited signer's to its limit, with the plan, before anything is sent", async () => {
    const views: string[] = [];
    const limit = (view: { action: string }) => { views.push(view.action); return { release: () => undefined }; };
    const signer = fakeSigner();
    const tools = gageTools(gageFrom(ctx({ d: parseDeployment(mainnetManifest()) })), { signer, limit });
    expect(tools).toHaveLength(32);
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

  it("are every one on mainnet, where every generation has its rollover router and the release names gage's keeper", () => {
    expect(actionsOn(parseDeployment(MAINNET_MANIFEST))).toEqual([
      "borrow", "leverage", "cancel", "reclaim", "cash_out", "roll", "auto_roll", "cancel_auto_roll", "earn_deposit", "earn_redeem", "collect", "feedback",
    ]);
  });

  it("leave rolling over out on the testnet, whose release names no rollover router, and so its tools and capabilities", async () => {
    const d = parseDeployment(TESTNET_MANIFEST);
    expect(actionsOn(d)).toEqual(["borrow", "leverage", "cancel", "reclaim", "cash_out", "earn_deposit", "earn_redeem", "collect"]);
    const gage = gageFrom(ctx({ d }));
    expect(gage.actions.filter((a) => ROLLS.includes(a))).toEqual([]);
    const names = gageTools(gage, { signer: fakeSigner() }).map((t) => t.name);
    expect(names.filter((n) => /roll/.test(n))).toEqual([]);
    expect(names).toHaveLength(24);
    expect((await gage.capabilities()).actions).not.toContain("roll");
    expect(await code(gage.prepare({ action: "roll", wallet: WALLET, loanId: "7" }))).toBe("ACTION_NOT_SERVED");
  });

  it("leave a roll by itself out without the keeper, and a cash-out out where no core has a cash-out router", () => {
    expect(actionsOn(parseDeployment({ ...manifest(), rolloverExecutor: undefined })).filter((a) => ROLLS.includes(a))).toEqual(["roll", "cancel_auto_roll"]);
    expect(actionsOn(parseDeployment({ ...manifest(), intentV1: { ...manifest().intentV1, rolloverRouter: A(0) } })).filter((a) => ROLLS.includes(a))).toEqual([]);
    const routerless = parseDeployment({ ...manifest(), nativeV2: { ...manifest().nativeV2, engines: manifest().nativeV2.engines.map((e) => ({ ...e, cashoutRouter: undefined })) } });
    expect(actionsOn(routerless)).not.toContain("cash_out");
    expect(gageFrom(ctx({ d: routerless }), { actions: ["cash_out", "borrow"] }).actions).toEqual(["borrow"]);
  });
});
