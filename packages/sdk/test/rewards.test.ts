/**
 * sGAGE on a stablecoin lend market (R2 option C, 27 October 2026): its core's own ledger pays a loan's rewards from a
 * treasury-funded budget, and reverts the fill that activates the loan when that budget is short. So gage-sdk lists with
 * `withRewards` only while the ledger's free budget covers what the core's registry quotes for the core's own fee, on a
 * generation whose release says its registry quotes them (`engine.rewardTerms: "registry"`, unbridged). USDG's bridged
 * core and every other lend asset list as before, reading nothing more.
 */
import { existsSync } from "node:fs";
import { decodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { engineAbi, rolloverRouterAbi } from "../src/abi.js";
import { parseDeployment } from "../src/deployment.js";
import { prepareNext } from "../src/prepare.js";
import { listsWithRewards, rewardsCovered } from "../src/rewards.js";
import { A, assetManifest, ctx, fakeChain, fakeUpstream, GLD_CORE, GLD_REG, GLD_REWARDS, GLDX, NVDA, position, registryRewarded, rollQuote, SCHIFFY, WALLET } from "../src/testing.js";

const E18 = 10n ** 18n;
/** GLDx's rollover router, in the stablecoin fixture below. */
const GLD_ROLL = A(0xb6);
/** GLDx's generation as a stablecoin market's: its own registry quotes its sGAGE, and its rollover router rolls its loans. */
const stable = () => {
  const m = registryRewarded(assetManifest());
  return parseDeployment({ ...m, intentV1Assets: { ...m.intentV1Assets, GLDx: { ...m.intentV1Assets.GLDx, rolloverRouter: GLD_ROLL } } });
};
const SIXTY = { borrower: 20n * E18, lender: 40n * E18 };
/** A chain whose registries quote `quote` for any fee and whose ledgers hold `budget`, recording what each is asked. */
const rewardsChain = (budget: bigint, quote = SIXTY, over: Record<string, unknown> = {}) => {
  const asked: unknown[][] = [];
  const chain = fakeChain({
    allowance: () => Promise.resolve(10n ** 30n),
    rewardsQuote: (registry: Address, term: number, fee: bigint) => { asked.push(["quote", registry, term, fee]); return Promise.resolve(quote); },
    rewardsBudget: (rewards: Address) => { asked.push(["budget", rewards]); return Promise.resolve(budget); },
    ...over,
  });
  return Object.assign(chain, { asked });
};
/** A chain that fails any read of reward terms or budgets. */
const noRewardReads = () => fakeChain({
  allowance: () => Promise.resolve(10n ** 30n),
  rewardsQuote: () => Promise.reject(new Error("read the reward terms")),
  rewardsBudget: () => Promise.reject(new Error("read the ledger's budget")),
});
const borrowing = { action: "borrow" as const, wallet: WALLET, token: SCHIFFY, collateral: String(100n * E18), principal: String(E18 / 2n), cap: "504000000000000000", term: 604_800, lendAsset: GLDX };
const listed = async (p: Promise<{ next?: { transaction: { data: `0x${string}` } } | null }>) => decodeFunctionData({ abi: engineAbi, data: (await p).next!.transaction.data }).args[5];

describe("the rule", () => {
  it("covers a quote above zero within the free budget, and nothing else", () => {
    expect(rewardsCovered({ quote: SIXTY, freeBudget: 60n * E18 })).toBe(true);
    expect(rewardsCovered({ quote: SIXTY, freeBudget: 60n * E18 - 1n })).toBe(false);
    expect(rewardsCovered({ quote: { borrower: 0n, lender: 0n }, freeBudget: 10n ** 30n })).toBe(false);
  });

  it("is false without a read on a core whose registry quotes nothing, and asks for the core's own fee where it does", async () => {
    const d = stable(), usdg = d.generations[0]!.core, gld = d.generations[1]!.core;
    expect(gld.registryRewards).toBe(true);
    expect(usdg.registryRewards ?? false).toBe(false);
    expect(await listsWithRewards(noRewardReads(), usdg, 604_800, 10n ** 9n)).toBe(false);
    const chain = rewardsChain(60n * E18);
    // The core's fee: the principal times the registry's 1% (`feeBps`), rounded down as GageV2Vault._list rounds it.
    expect(await listsWithRewards(chain, gld, 1_814_400, 1_000_000_000_000_000_099n)).toBe(true);
    expect(chain.asked).toEqual([["quote", GLD_REG, 1_814_400, 10_000_000_000_000_000n], ["budget", GLD_REWARDS]]);
  });
});

describe("a listing on a stablecoin lend market", () => {
  it("asks for its rewards while the ledger's free budget covers the registry's quote for the core's fee", async () => {
    const chain = rewardsChain(60n * E18);
    expect(await listed(prepareNext(ctx({ d: stable(), chain }), borrowing))).toBe(true);
    // 0.5 GLDx-sized units at the registry's 1%: the fee the core charges, and the ledger the core's activation draws on.
    expect(chain.asked).toEqual([["quote", GLD_REG, 604_800, 5n * 10n ** 15n], ["budget", GLD_REWARDS]]);
  });

  it("asks for none when the budget is short of the quote, or when the registry quotes nothing", async () => {
    expect(await listed(prepareNext(ctx({ d: stable(), chain: rewardsChain(60n * E18 - 1n) }), borrowing))).toBe(false);
    expect(await listed(prepareNext(ctx({ d: stable(), chain: rewardsChain(10n ** 30n, { borrower: 0n, lender: 0n }) }), borrowing))).toBe(false);
  });

  it("reads no reward terms anywhere else: USDG's core and a lend asset whose registry does not quote them list without rewards", async () => {
    expect(await listed(prepareNext(ctx({ d: parseDeployment(assetManifest()), chain: noRewardReads() }), borrowing))).toBe(false);
    const usdg = { action: "borrow" as const, wallet: WALLET, token: NVDA, collateral: String(5n * E18), principal: "1000000000", cap: "1010000000", term: 604_800 };
    expect(await listed(prepareNext(ctx({ d: stable(), chain: noRewardReads() }), usdg))).toBe(false);
  });

  it("rolls over through its rollover router on the same rule, read as the roll is sent", async () => {
    // The loan, and the wallet's loans on its core (`/v2/positions?account=`, R4/F20): this one alone.
    const indexer = fakeUpstream({ "/v2/positions/": position("7", { engine: GLD_CORE }),
      "/v2/positions?": { items: [position("7", { engine: GLD_CORE })], nextCursor: null } });
    const rates = () => fakeUpstream({ "/intent/roll/quotes/": rollQuote({ engine: GLD_CORE, router: GLD_ROLL }) });
    const rolling = { action: "roll" as const, wallet: WALLET, loanId: "7", engine: GLD_CORE };
    const rolled = async (budget: bigint) => {
      const chain = rewardsChain(budget, SIXTY, { approvedFor: () => Promise.resolve(GLD_ROLL) });
      const p = await prepareNext(ctx({ d: stable(), indexer, rates: rates(), chain }), rolling);
      expect(p.next).toMatchObject({ label: "Roll over", final: true });
      const [r] = decodeFunctionData({ abi: rolloverRouterAbi, data: p.next!.transaction.data }).args as unknown as [{ withRewards: boolean }];
      return { withRewards: r.withRewards, asked: chain.asked };
    };
    const covered = await rolled(60n * E18);
    expect(covered.withRewards).toBe(true);
    // The new loan's 1,000,000,000 raw units at the registry's 1%.
    expect(covered.asked).toEqual([["quote", GLD_REG, 604_800, 10_000_000n], ["budget", GLD_REWARDS]]);
    expect((await rolled(60n * E18 - 1n)).withRewards).toBe(false);
  });
});

// gage-sdk is published apart from gage's main repository, so it carries its own copy of the rule (src/rewards.ts). In
// the main repository, that copy is held to shared/lend-rewards.mjs itself.
const SHARED = new URL("../../../shared/lend-rewards.mjs", import.meta.url);
describe.skipIf(!existsSync(SHARED))("the shared rule (shared/lend-rewards.mjs)", () => {
  it("covers exactly what the shared rule covers", async () => {
    const shared = await import(SHARED.href) as { rewardsCovered: (input: { quote: { borrower: bigint; lender: bigint }; freeBudget: bigint }) => boolean };
    const quotes = [[0n, 0n], [1n, 0n], [0n, 1n], [20n, 40n], [10n ** 27n, 2n * 10n ** 27n]] as const;
    const budgets = [0n, 1n, 59n, 60n, 61n, 3n * 10n ** 27n, 10n ** 30n];
    for (const [borrower, lender] of quotes) for (const freeBudget of budgets) {
      expect(rewardsCovered({ quote: { borrower, lender }, freeBudget }), `${borrower}+${lender} of ${freeBudget}`).toBe(shared.rewardsCovered({ quote: { borrower, lender }, freeBudget }));
    }
  });
});
