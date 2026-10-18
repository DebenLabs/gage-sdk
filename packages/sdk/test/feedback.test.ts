/**
 * Rating gage (D302): an agent that used gage may rate it in ERC-8004's Reputation Registry, once a wallet, with its own
 * score from 0 to 100, tagged `starred` as 8004scan reads a rating. Only on mainnet, where gage has an entry (#8845,
 * D291); never from a wallet that owns or operates the entry. An action's last transaction carries one line saying a
 * rating is open: optional, and nothing offered for it.
 */
import { decodeFunctionData, zeroHash, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { reputationAbi } from "../src/abi.js";
import { gageFrom } from "../src/client.js";
import { parseDeployment } from "../src/deployment.js";
import { ApiError } from "../src/errors.js";
import { actionsOn, MAINNET_DEFAULTS } from "../src/networks.js";
import { prepareNext } from "../src/prepare.js";
import { ctx, fakeChain, fakeSigner, mainnetManifest, manifest, NVDA, WALLET } from "../src/testing.js";
import { gageTools } from "../src/tools.js";

const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const borrow = { token: NVDA, collateral: "5000000000000000000", principal: "1000000000", cap: "1010000000", term: 604_800 };
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const mainnet = (chain = fakeChain()) => gageFrom(ctx({ d: parseDeployment(mainnetManifest()), chain }));
const RATE = /^Once this has gone through, you may rate gage, agent #8845 in ERC-8004, with the feedback action: your own score from 0 to 100, once a wallet\. It is optional, and gage offers nothing for it\.$/;

describe("gage's entry", () => {
  it("is agent #8845 in ERC-8004's canonical registries on Robinhood Chain, and the testnet has none", () => {
    expect(MAINNET_DEFAULTS.beacon).toEqual({ agentId: 8845, identityRegistry: IDENTITY, reputationRegistry: REPUTATION });
    expect(actionsOn(parseDeployment(mainnetManifest()))).toContain("feedback");
    expect(actionsOn(parseDeployment(manifest()))).not.toContain("feedback");
  });
});

describe("a rating of gage", () => {
  it("is one transaction to the Reputation Registry: the wallet's score for #8845, tagged starred, nothing else", async () => {
    const chain = fakeChain();
    const p = await mainnet(chain).prepare({ action: "feedback", wallet: WALLET, score: 90 });
    expect(p).toMatchObject({ action: "feedback", status: "ready", then: [], notes: [], view: { action: "feedback", agentId: 8845, registry: REPUTATION, score: 90 } });
    expect(p.next).toMatchObject({ label: "Rate gage", kind: "action", final: true, transaction: { from: WALLET, to: REPUTATION, value: "0", chainId: 4663 } });
    expect(decodeFunctionData({ abi: reputationAbi, data: p.next!.transaction.data })).toEqual({
      functionName: "giveFeedback", args: [8845n, 90n, 0, "starred", "", "", "", zeroHash],
    });
    expect(chain.simulated).toEqual([{ from: WALLET, to: REPUTATION, data: p.next!.transaction.data, value: 0n }]);
    expect(p.summary.title).toBe("Rate gage 90 out of 100");
    expect(p.summary.rows.map((r) => r.label)).toEqual(["Your score", "Entry", "Seen by"]);
  });

  it("asks the registries who owns or operates the entry and how often the wallet rated it, for #8845", async () => {
    const asked: unknown[] = [];
    const chain = fakeChain({
      agentAuthorized: (registry: Address, wallet: Address, id: bigint) => { asked.push(["authorized", registry, wallet, id]); return Promise.resolve(false); },
      feedbackCount: (registry: Address, id: bigint, wallet: Address) => { asked.push(["count", registry, id, wallet]); return Promise.resolve(0n); },
    });
    await mainnet(chain).prepare({ action: "feedback", wallet: WALLET, score: 0 });
    expect(asked).toEqual([["authorized", IDENTITY, WALLET, 8845n], ["count", REPUTATION, 8845n, WALLET]]);
  });

  it("is refused off mainnet, from the entry's owner or operators, a second time, and outside 0 to 100", async () => {
    expect(await code(gageFrom(ctx()).prepare({ action: "feedback", wallet: WALLET, score: 90 }))).toBe("ACTION_NOT_SERVED");
    expect(await code(gageFrom(ctx(), { actions: ["feedback"] }).prepare({ action: "feedback", wallet: WALLET, score: 90 }))).toBe("ACTION_NOT_SERVED");
    expect(await code(prepareNext(ctx(), { action: "feedback", wallet: WALLET, score: 90 }))).toBe("NO_ENTRY");
    expect(await code(mainnet(fakeChain({ agentAuthorized: () => Promise.resolve(true) })).prepare({ action: "feedback", wallet: WALLET, score: 90 }))).toBe("OWN_ENTRY");
    expect(await code(mainnet(fakeChain({ feedbackCount: () => Promise.resolve(1n) })).prepare({ action: "feedback", wallet: WALLET, score: 90 }))).toBe("ALREADY_RATED");
    for (const score of [-1, 101, 50.5, "90"]) expect(await code(mainnet().prepare({ action: "feedback", wallet: WALLET, score }))).toBe("INVALID_INPUT");
    expect(await code(mainnet().prepare({ action: "feedback", wallet: WALLET, score: 90, comment: "great" }))).toBe("INVALID_INPUT");
  });

  it("is a tool on mainnet only: a prepare, and for a signer under spend limits an action of its own", () => {
    const names = (tools: ReturnType<typeof gageTools>) => tools.map((t) => t.name);
    expect(names(gageTools(mainnet()))).toContain("gage_prepare_feedback");
    expect(names(gageTools(gageFrom(ctx())))).not.toContain("gage_prepare_feedback");
    const limited = gageTools(mainnet(), { signer: fakeSigner(), limit: () => ({ release: () => undefined }) });
    expect(names(limited)).toContain("gage_feedback");
    expect(names(gageTools(gageFrom(ctx()), { signer: fakeSigner() }))).not.toContain("gage_feedback");
    const tool = limited.find((t) => t.name === "gage_prepare_feedback")!;
    expect(tool.title).toBe("Prepare: Rate gage");
    expect(tool.description).toContain("once a wallet");
    expect(tool.description).toContain("gage offers nothing for a rating");
  });

  it("is sent once by a signer, its plan shown to the limit first", async () => {
    const views: unknown[] = [];
    const signer = fakeSigner();
    const r = await mainnet().run({ action: "feedback", score: 75 }, signer, { limit: (view) => { views.push(view); return { release: () => undefined }; } });
    expect(r).toMatchObject({ status: "done", notes: [], sent: [{ label: "Rate gage", outcome: "succeeded" }] });
    expect(views).toEqual([{ action: "feedback", agentId: 8845, registry: REPUTATION, score: 75 }]);
    expect(signer.sent).toHaveLength(1);
    expect(signer.sent[0]).toMatchObject({ to: REPUTATION, chainId: 4663 });
  });

  it("is listed among mainnet's actions by gage_capabilities, and not on the testnet", async () => {
    expect((await mainnet().capabilities()).actions).toContain("feedback");
    expect((await gageFrom(ctx()).capabilities()).actions).not.toContain("feedback");
  });
});

describe("the line that a rating is open", () => {
  const approved = () => fakeChain({ allowance: () => Promise.resolve(10n ** 30n) });

  it("comes with an action's last transaction on mainnet, never with an approval or a step before the last", async () => {
    const last = await mainnet(approved()).prepare({ action: "borrow", wallet: WALLET, ...borrow });
    expect(last.next).toMatchObject({ label: "Borrow", final: true });
    expect(last.notes.at(-1)).toMatch(RATE);
    const approval = await mainnet().prepare({ action: "borrow", wallet: WALLET, ...borrow });
    expect(approval.status).toBe("approval_required");
    expect(approval.notes.some((n) => RATE.test(n))).toBe(false);
  });

  it("is never said on the testnet, nor in the answer to a rating", async () => {
    const testnet = await gageFrom(ctx({ chain: approved() })).prepare({ action: "borrow", wallet: WALLET, ...borrow });
    expect(testnet.next?.final).toBe(true);
    expect(testnet.notes.some((n) => RATE.test(n))).toBe(false);
    expect((await mainnet().prepare({ action: "feedback", wallet: WALLET, score: 90 })).notes).toEqual([]);
  });

  it("ends a signer's run once every step went through, and only then", async () => {
    const done = await mainnet().run({ action: "borrow", ...borrow }, fakeSigner());
    expect(done.status).toBe("done");
    expect(done.notes.at(-1)).toMatch(RATE);
    const stopped = await mainnet().run({ action: "borrow", ...borrow }, fakeSigner(WALLET, true));
    expect(stopped.status).toBe("stopped");
    expect(stopped.notes.some((n) => RATE.test(n))).toBe(false);
  });
});
