/**
 * The LP lane's actions as what is left to send from the wallet's current state (docs/api.md "LP lane"), as every plan
 * here is: exact approvals first, then the calls, every figure read from the chain and gage's rates service, nothing
 * an agent wrote shown. Borrowing is `borrow` then `withdraw(USDG)`: the core credits the principal less its fee, and
 * the plan takes the credit to the wallet; a roll (D317) moves only the difference, credited or paid. Fables receipts
 * (D316) are wrapped into a position NFT before they are borrowed against. Served only where the release makes the lane
 * public (`actionsOn`).
 */
import { encodeFunctionData, erc20Abi, getAddress, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { fablesHookAbi, fablesWrapperAbi, lpCoreAbi, lpVaultAbi, lpCompanionAbi, lpVaultFactoryAbi, positionManagerAbi } from "./abi.js";
import type { FablesReceipts, LpLoan } from "./chain.js";
import { ApiError, requireThat } from "./errors.js";
import * as f from "./format.js";
import {
  adapterOf, amountText, askQuote, costCeiling, costWithin, creditTokens, fablesPoolOf, feeOf, laneOf, loanById, lpCostBps, positionNotes,
  mandateWords, positionRef, QUOTE_MARGIN, scanLoans, termsText, tokenRefs, vaultOf, walletCredits, type LpPositionRef, type SignedLpQuote,
} from "./lp.js";
import { lpSharesText, lpShareUnit } from "./lpShares.js";
import { lpPoolOf, type LpAdapter, type LpLane } from "./deployment.js";
import { FREE_CASH_MARGIN_BPS, type Ctx, type Plan, type Row, type Step, type TokenRef, type Tx } from "./plans.js";
import type { ActionInput } from "./schemas.js";

/** An amount of a token, as a view lists one. */
export type LpAmount = TokenRef & { amount: string };
/**
 * The figures of each LP action, raw amounts as decimal strings (USDG: 6 decimals; LP vault shares: `shareDecimals`, the vault's own). A borrow
 * planned once its loan is open (only its USDG is left to receive) answers `lp_withdraw`'s view: it borrows nothing new.
 */
export type LpView =
  | ({ action: "lp_borrow" } & LpPositionRef & {
    vault: Address; vaultName: string; collateralValue: string; principal: string; fee: string; feeBps: number; payout: string; repayment: string;
    term: number; costBps: number | null; maxCostBps: number; ltvBps: number | null; receive: string; expiresAt: number;
  })
  | ({ action: "lp_repay" } & LpPositionRef & { loanId: string; repayment: string; endsAt: number; repaid: boolean; returned: boolean })
  | ({ action: "lp_return_position" } & LpPositionRef & { loanId: string; returned: boolean })
  /** A running loan's fees as collecting them now would credit them (`fees`), whether its DEX's rewards are claimed too, and the credits received (`receive`). */
  | ({ action: "lp_collect" } & LpPositionRef & { loanId: string; fees: LpAmount[]; rewards: boolean; receive: LpAmount[] })
  | { action: "lp_withdraw"; credits: LpAmount[] }
  | { action: "lp_deposit"; vault: Address; name: string; amount: string; minShares: string; shareDecimals: number; performanceFeeBps: number }
  | { action: "lp_redeem"; vault: Address; name: string; shares: string; shareDecimals: number; assets: string; minAssets: string; all: boolean }
  | { action: "lp_claim_bonus"; vault: Address; name: string; bonuses: { loanId: string; amount: string }[]; total: string }
  /** A reserve vault's sGAGE (D454) claimed from its companion, `amount` raw sGAGE (18 decimals). */
  | { action: "lp_claim_rewards"; vault: Address; name: string; companion: Address; amount: string }
  /**
   * A running loan rolled into a new one on the same position (D317): the old loan's principal and repayment (`owed`),
   * the new loan's, and what the wallet pays (`pay`) or receives now (`receive`, with what the core credited it before).
   */
  | ({ action: "lp_roll" } & LpPositionRef & {
    loanId: string; vault: Address; vaultName: string; oldPrincipal: string; owed: string; principal: string; fee: string; feeBps: number; repayment: string;
    net: string; pay: string; receive: string; term: number; endsAt: number; costBps: number | null; maxCostBps: number; expiresAt: number;
  })
  /** A wallet's Fables receipts of one range wrapped into a position (D316): its receipts and how many of them are staked. */
  | { action: "lp_wrap"; adapter: Address; rangeId: string; pool: Address; poolName: string; shares: string; staked: string }
  /** A wrapped Fables position given back as its receipts, with their fees. */
  | ({ action: "lp_unwrap" } & LpPositionRef)
  // A curator's vault (D318): opening one through the lane's factory, and adding a pool to its mandate or dropping one.
  | { action: "lp_create_vault"; name: string; performanceFeeBps: number; maxLoanPrincipal: string; pools: { adapter: Address; pool: Address; poolName: string }[] }
  | { action: "lp_vault_add_pool"; vault: Address; name: string; adapter: Address; pool: Address; poolName: string; fundsFrom: number }
  | { action: "lp_vault_remove_pool"; vault: Address; name: string; adapter: Address; pool: Address; poolName: string };

/** A loan an `lp_roll` closed (`LP_STATE`): its position secures the running loan, and nothing of it is left to act on. */
const ROLLED = 5, ROLLED_WORDS = "This loan rolled into a new one on the same position: act on that loan";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tx = (to: Address, data: Hex): Tx => ({ to, data, value: 0n });
const call = (label: string, to: Address, data: Hex, final = false): Step => ({ label, kind: "action", final, build: () => Promise.resolve(tx(to, data)) });
/** The most a plan's slippage room takes off a figure quoted now (50 bps when omitted), rounded down. */
const slip = (quoted: bigint, maxBps = 50) => quoted - (quoted * BigInt(maxBps)) / 10_000n;
/** The most bonus claims one plan sends: what one review asks the wallet to confirm. */
const MAX_BONUS_CLAIMS = 20;
const NO_LIQUIDATION = "The position is unwound for the lenders. Nothing else is taken, and the loan is never closed early because a price moves.";

/** USDG approved to `spender` for exactly `amount`, unless it is approved already. */
async function usdgApproval(c: Ctx, wallet: Address, spender: Address, amount: bigint): Promise<Step[]> {
  if (amount === 0n || await c.chain.allowance(c.d.usdg, wallet, spender) >= amount) return [];
  return [{ label: "Approve USDG", kind: "approve", final: false, build: () => Promise.resolve(tx(c.d.usdg, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }))) }];
}
/** The core's `withdraw(token)`: the wallet's whole credit of it. */
const receive = (lane: LpLane, r: TokenRef, amount: bigint) => call(`Receive ${amountText(r, amount)}`, lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "withdraw", args: [r.token] }));
/** One of the wallet's own LP loans; another's is refused, as a loan on a core is. */
async function ownLoan(c: Ctx, lane: LpLane, wallet: Address, id: string): Promise<LpLoan> {
  const l = await loanById(c, lane, id);
  requireThat(same(l.borrower, wallet), "NOT_YOUR_LOAN", "This wallet did not borrow this LP loan", 403);
  return l;
}
const positionText = (ref: LpPositionRef) => `position #${ref.tokenId} (${ref.poolName})`;
const amounts = (list: readonly LpAmount[]) => list.map((x) => amountText(x, BigInt(x.amount))).join(", ");

/**
 * Borrowing USDG against a position (docs/api.md "LP lane"): the position is approved to the core on its own position
 * manager (Uniswap v3's, SushiSwap v3's, Ramses V3's or Uniswap v4's PositionManager), unless the core may move it
 * already, then the borrow on a signed quote, then the credit it makes (the principal less the registry's fee, with any
 * USDG the wallet had credited already) withdrawn to the wallet. The quote is asked for when the action is planned and
 * checked (`askQuote`); held to `maxCostBps`, refused above it. When the borrow is sent, the quote planned is used while
 * it has a minute left; past that it is asked for again, for the same vault, held to `maxCostBps`, to the fee planned and
 * to the loan planned (no larger, at most 1% smaller: a spend limit was asked about this one), else PRICE_MOVED. Planned
 * again once the loan is open, the position sits in that loan's escrow: only its USDG is left to receive. A Uniswap v4
 * position leaves any subscription it has as it moves, and a native ETH pool's fees are collected as WETH: its summary
 * says so. Fables receipts not wrapped yet (`rangeId`) are wrapped first (`wrapping`), and the borrow is planned again
 * on the position they make once that is mined.
 */
async function lpBorrow(c: Ctx, i: Extract<ActionInput, { action: "lp_borrow" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, adapter = adapterOf(lane, i.adapter);
  requireThat((i.tokenId === undefined) !== (i.rangeId === undefined), "INVALID_INPUT", "Name the position by tokenId, or Fables receipts by rangeId: one of them", 400);
  const vault = i.vault ? await vaultOf(c, lane, i.vault) : null;
  let tokenId: bigint, owner: Address | null;
  if (i.rangeId !== undefined) {
    const fables = fablesOf(adapter), rangeId = BigInt(i.rangeId);
    const r = await c.chain.fablesReceipts(fables.hook, wallet, rangeId, fables.positionManager);
    // Receipts still in the wallet are wrapped first; the borrow is planned again on the position they make.
    if (r.set && r.shares > 0n) return wrapping(c, lane, fables, wallet, rangeId, r, true);
    const found = await wrappedOf(c, lane, fables, wallet, rangeId);
    requireThat(found, "POSITION_NOT_FOUND", "This wallet holds no Fables receipts of this range, nor a position wrapped from them", 404);
    ({ tokenId, owner } = found);
  } else {
    tokenId = BigInt(i.tokenId!);
    owner = await c.chain.positionOwner(adapter.positionManager, tokenId);
    requireThat(owner, "POSITION_NOT_FOUND", "No position has this id at this position manager", 404);
  }
  if (!same(owner, wallet)) return borrowed(c, lane, wallet, adapter.address, tokenId, owner);
  const reg = await c.chain.lpRegistry(lane.registry);
  requireThat(!reg.newLoansPaused, "LOANS_PAUSED", "New LP loans are paused");
  requireThat(reg.terms.includes(i.term), "TERM_NOT_ALLOWED", `Allowed terms: ${termsText(reg.terms)}`);
  const planned = await askQuote(c, lane, { adapter, tokenId, borrower: wallet, term: i.term, vault: vault?.address ?? null }, reg);
  const q = planned.quote;
  requireThat(costWithin(q, i.maxCostBps), "PRICE_ABOVE_LIMIT", `The loan costs ${f.bps(lpCostBps(q.principal, q.repayment) ?? costCeiling(q))} now, above the ${f.bps(i.maxCostBps)} limit set`);
  const [approved, [credited]] = await Promise.all([c.chain.positionApproved(adapter.positionManager, tokenId, wallet, lane.core), c.chain.lpCredits(lane.core, wallet, [c.d.usdg])]);
  const fee = feeOf(q.principal, q.feeBps), payout = q.principal - fee, ref = positionRef(lane, adapter.address, planned.pool.pool, tokenId);
  const borrowing = (s: SignedLpQuote) => tx(lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "borrow", args: [s.quote, s.signature] }));
  const send = async (): Promise<Tx> => {
    if (q.deadline > BigInt(c.now() + QUOTE_MARGIN)) return borrowing(planned);
    const fresh = await askQuote(c, lane, { adapter, tokenId, borrower: wallet, term: i.term, vault: q.vault }, await c.chain.lpRegistry(lane.registry));
    const n = fresh.quote;
    requireThat(costWithin(n, i.maxCostBps), "PRICE_ABOVE_LIMIT", `The loan costs ${f.bps(lpCostBps(n.principal, n.repayment) ?? costCeiling(n))} now, above the ${f.bps(i.maxCostBps)} limit set`);
    requireThat(n.feeBps === q.feeBps && n.principal <= q.principal && n.principal * 100n >= q.principal * 99n, "PRICE_MOVED",
      "The position supports another loan now than the one planned; prepare the borrow again");
    return borrowing(fresh);
  };
  const vaultName = planned.vault.name, cost = lpCostBps(q.principal, q.repayment);
  const rewards = adapter.kind === "ramses-v3" ? " and Ramses rewards" : "";
  // A native ETH pool's fees are collected as WETH (`UniV4PositionAdapter`); a v4 position leaves any subscription it has.
  const asWeth = planned.pool.native ? ", its ETH as WETH" : "";
  const subscription: Row[] = adapter.kind === "uniswap-v4"
    ? [{ label: "Its v4 subscription", value: "Moving the position into escrow ends any subscription it has: a rewards program that tracks it stops counting it" }] : [];
  return {
    view: {
      action: "lp_borrow", ...ref, vault: q.vault, vaultName, collateralValue: q.collateralValue.toString(), principal: q.principal.toString(), fee: fee.toString(),
      feeBps: q.feeBps, payout: payout.toString(), repayment: q.repayment.toString(), term: i.term, costBps: cost, maxCostBps: i.maxCostBps,
      ltvBps: q.collateralValue > 0n ? Number((q.principal * 10_000n) / q.collateralValue) : null, receive: (credited! + payout).toString(), expiresAt: planned.expiresAt,
    },
    summary: {
      title: `Borrow ${f.usdg(q.principal)} against ${positionText(ref)}`,
      rows: [
        { label: "You pledge", value: `Position #${tokenId}, ${ref.poolName}, worth about ${f.usdg(q.collateralValue)}` },
        { label: "You receive", value: `${f.usdg(payout)} after the ${f.bps(q.feeBps)} fee` },
        { label: `You repay within ${f.days(i.term)}`, value: f.owed(q.repayment) },
        { label: "Loan cost", value: `${f.bps(cost ?? costCeiling(q))}, under the ${f.bps(i.maxCostBps)} limit set` },
        { label: "Lent by", value: vaultName },
        { label: "While it runs", value: `You collect the position's fees${rewards} with lp_collect${asWeth}; its liquidity stays in place` },
        ...subscription,
        { label: "If you don't repay", value: NO_LIQUIDATION },
      ],
    },
    steps: [
      ...(approved ? [] : [{
        label: `Approve position #${tokenId}`, kind: "approve" as const, final: false,
        build: () => Promise.resolve(tx(adapter.positionManager, encodeFunctionData({ abi: positionManagerAbi, functionName: "approve", args: [lane.core, tokenId] }))),
      }]),
      { label: "Borrow", kind: "action", final: true, build: send },
      receive(lane, { token: c.d.usdg, symbol: "USDG", decimals: 6 }, credited! + payout),
    ],
    made: (logs: readonly Log[]) => {
      const own = logs.filter((l) => same(l.address, lane.core));
      const opened = (parseEventLogs({ abi: lpCoreAbi, eventName: "LoanOpened", logs: own }) as unknown as { args: { loanId: bigint; borrower: Address } }[])
        .find((l) => same(l.args.borrower, wallet));
      return opened ? { engine: lane.core, loanId: opened.args.loanId.toString() } : null;
    },
    notes: [
      "The quote is signed for this wallet for five minutes at most: past a minute before it runs out, the borrow is quoted again when it is sent and refused above maxCostBps.",
      `The position waits in its own escrow while the loan runs. Repay before ${f.days(i.term)} are up (lp_repay) and it comes back to the wallet.`,
      ...positionNotes(adapter.kind, planned.pool),
    ],
  };
}

/**
 * A borrow planned again once its loan is open: the position sits in the escrow of the wallet's running loan against it,
 * and what is left is the USDG the core credits the wallet. Any other holder of the position is refused NOT_OWNER.
 */
async function borrowed(c: Ctx, lane: LpLane, wallet: Address, adapter: Address, tokenId: bigint, owner: Address): Promise<Plan> {
  const { loans } = await scanLoans(c, lane);
  const l = loans.find((x) => x.state === 1 && same(x.borrower, wallet) && same(x.adapter, adapter) && x.tokenId === tokenId && same(x.escrow, owner));
  requireThat(l, "NOT_OWNER", "This wallet does not hold this position");
  const credits = await walletCredits(c, lane, wallet, [c.d.usdg]);
  const ref = positionRef(lane, adapter, l.pool, tokenId);
  return {
    view: { action: "lp_withdraw", credits: credits.map((x) => ({ ...x, amount: x.amount.toString() })) },
    summary: {
      title: credits.length ? `LP loan #${l.id} is open against ${positionText(ref)}: receive its USDG` : `LP loan #${l.id} is open against ${positionText(ref)}`,
      rows: [
        ...credits.map((x): Row => ({ label: "To receive", value: amountText(x, x.amount) })),
        { label: `You repay before ${f.date(l.end)}`, value: f.owed(l.repayment) },
      ],
    },
    steps: credits.map((x) => receive(lane, x, x.amount)),
    notes: ["The loan is open already: nothing more is borrowed."],
  };
}

/** A Fables adapter of the lane: its position manager is the wrapper, and it names the hook whose receipts it wraps. */
type FablesAdapter = LpAdapter & { hook: Address };
/** The lane's adapter as a Fables one; any other is refused (NOT_FABLES). */
function fablesOf(adapter: LpAdapter): FablesAdapter {
  requireThat(adapter.kind === "fables" && adapter.hook, "NOT_FABLES", "This adapter does not take Fables receipts: name the lane's Fables adapter", 400);
  return adapter as FablesAdapter;
}
/** How far back from the wrapper's newest position a range just wrapped is looked for. */
const WRAPPED_SCAN = 256;
/**
 * The position the wallet's Fables receipts of `rangeId` were wrapped into, and who holds it: the wrapper cannot list a
 * holder's positions, so its newest positions are read back (at most WRAPPED_SCAN, where a wrap just mined is), the
 * newest one of the wallet's of that range kept; else the position of the wallet's running loan on that adapter, which
 * its escrow holds. Null where neither is found.
 */
async function wrappedOf(c: Ctx, lane: LpLane, adapter: FablesAdapter, wallet: Address, rangeId: bigint): Promise<{ tokenId: bigint; owner: Address } | null> {
  const next = await c.chain.fablesNextTokenId(adapter.positionManager);
  const ids: bigint[] = [];
  for (let id = next - 1n; id >= 1n && ids.length < WRAPPED_SCAN; id -= 1n) ids.push(id);
  const read = await c.chain.fablesWrapped(adapter.positionManager, ids);
  const n = read.findIndex((w) => w !== null && w.rangeId === rangeId && same(w.owner, wallet));
  if (n >= 0) return { tokenId: ids[n]!, owner: wallet };
  const running = (await scanLoans(c, lane)).loans.filter((l) => l.state === 1 && same(l.borrower, wallet) && same(l.adapter, adapter.address));
  const pledged = running.length ? await c.chain.fablesWrapped(adapter.positionManager, running.map((l) => l.tokenId)) : [];
  const k = pledged.findIndex((w) => w !== null && w.rangeId === rangeId);
  return k >= 0 ? { tokenId: running[k]!.tokenId, owner: pledged[k]!.owner } : null;
}

/**
 * Wrapping a wallet's Fables receipts of one range into a position NFT (`FablesPositionWrapper.wrap`, D316): every
 * receipt it holds of the range, its staked ones unstaked first (`unstake`, which Fables never pauses), the receipts
 * approved to the wrapper (ERC-6909 `approve`, unless it may move them already), then the wrap, which mints the position
 * to the wallet. The amounts are read again as each step is built, after the one before it is mined. Refused while the
 * hook's pause stops transfers (FABLES_PAUSED), and for a range in a pool the lane does not list (POOL_NOT_ALLOWED).
 * Within lp_borrow (`borrowing`), the borrow is planned again once the wrap is mined (`again`).
 */
function wrapping(c: Ctx, lane: LpLane, adapter: FablesAdapter, wallet: Address, rangeId: bigint, r: FablesReceipts, borrowing: boolean): Plan {
  if (r.paused) throw new ApiError("FABLES_PAUSED", "Fables has paused moving its receipts: they cannot be wrapped now; try again later", 409, true);
  const pool = lpPoolOf(lane, adapter.address, fablesPoolOf(r.key));
  requireThat(pool, "POOL_NOT_ALLOWED", "gage's LP lane does not lend against this range's pool", 409);
  const hook = adapter.hook, wrapper = adapter.positionManager;
  const held = async () => (await c.chain.fablesReceipts(hook, wallet, rangeId, wrapper)).shares;
  const receipts = `${r.shares} receipts of ${pool.name}`;
  const steps: Step[] = [
    ...(r.staked > 0n ? [call("Unstake the Fables receipts", hook, encodeFunctionData({ abi: fablesHookAbi, functionName: "unstake", args: [r.key, r.tickLower, r.tickUpper, r.staked] }))] : []),
    ...(r.operator || r.allowance >= r.shares ? [] : [{
      label: "Approve the Fables receipts", kind: "approve" as const, final: false,
      build: async () => tx(hook, encodeFunctionData({ abi: fablesHookAbi, functionName: "approve", args: [wrapper, rangeId, await held()] })),
    }]),
    {
      label: "Wrap the Fables receipts", kind: "action", final: !borrowing,
      build: async () => tx(wrapper, encodeFunctionData({ abi: fablesWrapperAbi, functionName: "wrap", args: [r.key, r.tickLower, r.tickUpper, await held(), wallet] })),
    },
  ];
  return {
    view: { action: "lp_wrap", adapter: adapter.address, rangeId: rangeId.toString(), pool: pool.pool, poolName: pool.name, shares: r.shares.toString(), staked: r.staked.toString() },
    summary: {
      title: borrowing ? `Wrap Fables receipts of ${pool.name} into a position, then borrow against it` : `Wrap Fables receipts of ${pool.name} into a position`,
      rows: [
        { label: "You wrap", value: receipts },
        ...(r.staked > 0n ? [{ label: "Staked first", value: `${r.staked} of them are staked for Fables' emissions: they are unstaked, and stop earning them` }] : []),
        { label: "While wrapped", value: "They earn the pool's swap fees, not Fables' emissions; lp_unwrap gives them back with their fees" },
      ],
    },
    steps,
    notes: borrowing
      ? ["Once the wrap is mined, the borrow is planned on the new position (run() does so itself): its quote, the position's approval and the borrow."]
      : ["The new position is in gage_lp_positions once the wrap is mined; lp_borrow borrows against it."],
    ...(borrowing ? { again: true as const } : {}),
  };
}

/** Wrapping a wallet's Fables receipts of one range into a position (D316), every one it holds. */
async function lpWrap(c: Ctx, i: Extract<ActionInput, { action: "lp_wrap" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, adapter = fablesOf(adapterOf(lane, i.adapter)), rangeId = BigInt(i.rangeId);
  const r = await c.chain.fablesReceipts(adapter.hook, wallet, rangeId, adapter.positionManager);
  requireThat(r.set && r.shares > 0n, "NOTHING_TO_WRAP", "This wallet holds no Fables receipts of this range", 404);
  return wrapping(c, lane, adapter, wallet, rangeId, r, false);
}

/**
 * Giving a wrapped Fables position back as its receipts (`FablesPositionWrapper.unwrap`): the position must be the
 * wallet's (a pledged one is its loan's escrow's: repay and take it back first), and the hook's pause, which stops
 * transfers, must be off. Its fees come with it, less the claim fee Fables keeps.
 */
async function lpUnwrap(c: Ctx, i: Extract<ActionInput, { action: "lp_unwrap" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, adapter = fablesOf(adapterOf(lane, i.adapter)), tokenId = BigInt(i.tokenId);
  const [[w], [fx]] = await Promise.all([c.chain.fablesWrapped(adapter.positionManager, [tokenId]), c.chain.lpFacts(adapter.address, [tokenId])]);
  requireThat(w && fx, "POSITION_NOT_FOUND", "No wrapped Fables position has this id", 404);
  requireThat(same(w.owner, wallet), "NOT_OWNER", "This wallet does not hold this position: a pledged one comes back once its loan is repaid (lp_repay)");
  const r = await c.chain.fablesReceipts(adapter.hook, wallet, w.rangeId, adapter.positionManager);
  if (r.paused) throw new ApiError("FABLES_PAUSED", "Fables has paused moving its receipts: the position cannot be unwrapped now; try again later", 409, true);
  const ref = positionRef(lane, adapter.address, fx.pool, tokenId);
  return {
    view: { action: "lp_unwrap", ...ref },
    summary: {
      title: `Unwrap ${positionText(ref)} into its Fables receipts`,
      rows: [{ label: "Back to your wallet", value: `Its ${fx.liquidity} Fables receipts, with their fees less the claim fee Fables keeps` }],
    },
    steps: [call(`Unwrap position #${tokenId}`, adapter.positionManager, encodeFunctionData({ abi: fablesWrapperAbi, functionName: "unwrap", args: [tokenId, wallet] }), true)],
    notes: [],
  };
}

/**
 * Rolling the wallet's own running LP loan into a new loan on the same position before its end (`LPCore.roll`, D317):
 * the rates service's quote for the loan (`loan=`), checked as a borrow's is and for what it settles (`askQuote`), held
 * to `maxCostBps`. The new loan repays the old one in full and only the difference moves: what the new principal, less
 * its fee, leaves over the old repayment is credited (and withdrawn to the wallet after), or the wallet pays what it lacks
 * (USDG approved to the core for exactly that first). The position stays in its escrow. When it is sent, the quote planned
 * is used while it has a minute left; past that it is asked for again, held to `maxCostBps`, the fee planned, no larger a
 * loan and no worse a settlement than planned (which the approval covers), else PRICE_MOVED.
 */
async function lpRoll(c: Ctx, i: Extract<ActionInput, { action: "lp_roll" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, l = await ownLoan(c, lane, wallet, i.loanId);
  requireThat(l.state === 1, "NOT_RUNNING", "Only a running LP loan rolls");
  requireThat((await c.chain.head()).timestamp < l.end, "TERM_ENDED", "The term has ended: the position goes to the lenders");
  const adapter = adapterOf(lane, l.adapter), vault = i.vault ? await vaultOf(c, lane, i.vault) : null;
  const reg = await c.chain.lpRegistry(lane.registry);
  requireThat(!reg.newLoansPaused, "LOANS_PAUSED", "New LP loans are paused");
  requireThat(reg.terms.includes(i.term), "TERM_NOT_ALLOWED", `Allowed terms: ${termsText(reg.terms)}`);
  const ask = { adapter, tokenId: l.tokenId, borrower: wallet, term: i.term, vault: vault?.address ?? null, rolling: l };
  const planned = await askQuote(c, lane, ask, reg);
  const q = planned.quote, net = planned.roll!.net, pay = net < 0n ? -net : 0n;
  requireThat(costWithin(q, i.maxCostBps), "PRICE_ABOVE_LIMIT", `The new loan costs ${f.bps(lpCostBps(q.principal, q.repayment) ?? costCeiling(q))} now, above the ${f.bps(i.maxCostBps)} limit set`);
  requireThat(pay === 0n || await c.chain.balance(c.d.usdg, wallet) >= pay, "INSUFFICIENT_BALANCE", `Rolling takes ${f.usdg(pay)} from the wallet now; it holds less`);
  const [credited] = await c.chain.lpCredits(lane.core, wallet, [c.d.usdg]);
  const fee = feeOf(q.principal, q.feeBps), receiving = credited! + (net > 0n ? net : 0n), ref = positionRef(lane, l.adapter, l.pool, l.tokenId);
  const rolling = (s: SignedLpQuote) => tx(lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "roll", args: [l.id, s.quote, s.signature] }));
  const send = async (): Promise<Tx> => {
    if (q.deadline > BigInt(c.now() + QUOTE_MARGIN)) return rolling(planned);
    const fresh = await askQuote(c, lane, { ...ask, vault: q.vault }, await c.chain.lpRegistry(lane.registry));
    const n = fresh.quote;
    requireThat(costWithin(n, i.maxCostBps), "PRICE_ABOVE_LIMIT", `The new loan costs ${f.bps(lpCostBps(n.principal, n.repayment) ?? costCeiling(n))} now, above the ${f.bps(i.maxCostBps)} limit set`);
    requireThat(n.feeBps === q.feeBps && n.principal <= q.principal && fresh.roll!.net >= net, "PRICE_MOVED", "The roll settles differently now than planned; prepare it again");
    return rolling(fresh);
  };
  const vaultName = planned.vault.name, cost = lpCostBps(q.principal, q.repayment);
  return {
    view: {
      action: "lp_roll", ...ref, loanId: i.loanId, vault: q.vault, vaultName, oldPrincipal: l.principal.toString(), owed: planned.roll!.owed.toString(),
      principal: q.principal.toString(), fee: fee.toString(), feeBps: q.feeBps, repayment: q.repayment.toString(), net: net.toString(), pay: pay.toString(),
      receive: receiving.toString(), term: i.term, endsAt: c.now() + i.term, costBps: cost, maxCostBps: i.maxCostBps, expiresAt: planned.expiresAt,
    },
    summary: {
      title: `Roll LP loan #${i.loanId} on ${positionText(ref)} into a new ${f.days(i.term)} loan`,
      rows: [
        net < 0n ? { label: "You pay now", value: f.usdg(pay) } : net > 0n ? { label: "You receive now", value: f.usdg(net) } : { label: "Now", value: "Nothing to pay or receive" },
        { label: `Then you repay within ${f.days(i.term)}`, value: f.owed(q.repayment) },
        { label: "New loan", value: `${f.usdg(q.principal)}, after the ${f.bps(q.feeBps)} fee, repays the old loan's ${f.owed(planned.roll!.owed)}` },
        { label: "Loan cost", value: `${f.bps(cost ?? costCeiling(q))}, under the ${f.bps(i.maxCostBps)} limit set` },
        { label: "Lent by", value: vaultName },
        { label: "The position", value: "It stays in its escrow: nothing is unwound, nothing moves" },
        { label: "If you don't repay", value: NO_LIQUIDATION },
      ],
    },
    steps: [
      ...await usdgApproval(c, wallet, lane.core, pay),
      { label: "Roll over", kind: "action", final: true, build: send },
      ...(receiving > 0n ? [receive(lane, { token: c.d.usdg, symbol: "USDG", decimals: 6 }, receiving)] : []),
    ],
    made: (logs: readonly Log[]) => {
      const own = logs.filter((x) => same(x.address, lane.core));
      const rolled = (parseEventLogs({ abi: lpCoreAbi, eventName: "Rolled", logs: own }) as unknown as { args: { loanId: bigint; newLoanId: bigint } }[])
        .find((x) => x.args.loanId === l.id);
      return rolled ? { engine: lane.core, loanId: rolled.args.newLoanId.toString() } : null;
    },
    notes: [
      "The quote is signed for this wallet for five minutes at most, and never past the loan's end: past a minute before it runs out, the roll is quoted again when it is sent and refused above maxCostBps.",
    ],
  };
}

/**
 * Repaying the wallet's own LP loan in full in USDG before its end (`repay`; the core allows anyone to, gage-sdk only
 * the borrower, as only the holder of a loan's right repays on a core), then taking the position back
 * (`returnPosition`). Planned again once it is repaid, only the return is left, or nothing.
 */
async function lpRepay(c: Ctx, i: Extract<ActionInput, { action: "lp_repay" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, l = await ownLoan(c, lane, wallet, i.loanId), id = l.id;
  const ref = positionRef(lane, l.adapter, l.pool, l.tokenId);
  const back = call(`Take back position #${ref.tokenId}`, lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "returnPosition", args: [id] }));
  const steps: Step[] = [];
  if (l.state === 1) {
    requireThat((await c.chain.head()).timestamp < l.end, "TERM_ENDED", "The term has ended: the position goes to the lenders");
    requireThat(await c.chain.balance(c.d.usdg, wallet) >= l.repayment, "INSUFFICIENT_BALANCE", `Repaying takes ${f.owed(l.repayment)}; the wallet holds less`);
    steps.push(...await usdgApproval(c, wallet, lane.core, l.repayment), call("Repay", lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "repay", args: [id] })), back);
  } else {
    requireThat(l.state !== ROLLED, "NOT_REPAYABLE", ROLLED_WORDS);
    requireThat(l.state === 2, "NOT_REPAYABLE", "The term ended unpaid: the position went to the lenders");
    if (!l.positionReturned) steps.push(back);
  }
  const rewards = (await c.chain.lpRewardTokens(l.adapter)).length > 0;
  return {
    view: { action: "lp_repay", ...ref, loanId: i.loanId, repayment: l.repayment.toString(), endsAt: l.end, repaid: l.state === 2, returned: l.positionReturned },
    summary: {
      title: !steps.length ? `LP loan #${i.loanId} is repaid and ${positionText(ref)} is back` : `Repay LP loan #${i.loanId} and take back ${positionText(ref)}`,
      rows: [
        ...(l.state === 1 ? [{ label: "You pay", value: f.owed(l.repayment) }, { label: "Repay before", value: `${f.date(l.end)} (the loan's last day)` }] : []),
        { label: "Back to your wallet", value: `Position #${ref.tokenId}, ${ref.poolName}` },
      ],
    },
    steps,
    notes: rewards && steps.length ? ["Rewards that reached the position's escrow are credited to the wallet when it comes back: lp_withdraw takes them."] : [],
  };
}

/** Taking back the position of the wallet's own LP loan once it is repaid (`returnPosition`); nothing once it is back. */
async function lpReturnPosition(c: Ctx, i: Extract<ActionInput, { action: "lp_return_position" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, l = await ownLoan(c, lane, wallet, i.loanId);
  requireThat(l.state !== 1, "NOT_REPAID", "The loan is not repaid: lp_repay repays it before its end and takes the position back");
  requireThat(l.state !== ROLLED, "NOT_REPAYABLE", ROLLED_WORDS);
  requireThat(l.state === 2, "NOT_REPAYABLE", "The term ended unpaid: the position went to the lenders");
  const ref = positionRef(lane, l.adapter, l.pool, l.tokenId);
  const rewards = (await c.chain.lpRewardTokens(l.adapter)).length > 0;
  return {
    view: { action: "lp_return_position", ...ref, loanId: i.loanId, returned: l.positionReturned },
    summary: {
      title: l.positionReturned ? `${positionText(ref)} is back in the wallet` : `Take back ${positionText(ref)}`,
      rows: [{ label: "Back to your wallet", value: `Position #${ref.tokenId}, ${ref.poolName}` }],
    },
    steps: l.positionReturned ? [] : [call(`Take back position #${ref.tokenId}`, lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "returnPosition", args: [l.id] }))],
    notes: rewards && !l.positionReturned ? ["Rewards that reached the position's escrow are credited to the wallet when it comes back: lp_withdraw takes them."] : [],
  };
}

/**
 * Collecting a running LP loan's fees (`collectFees`, and `claimRewards` where its adapter's DEX pays rewards, Ramses),
 * then receiving what they credit. What the core credits the wallet in the loan's tokens (its pool's two and its DEX's
 * rewards) comes first: while there is any, the plan receives it, each token a step. Otherwise, while collecting would
 * credit fees now (read with `collectFees`' own call), the plan collects them, with the rewards, and is planned again
 * once that is mined, to receive them (`again`; run() does so itself). With no fee to collect, a Ramses loan's rewards
 * are claimed alone, and lp_withdraw receives them. The liquidity stays in place.
 */
async function lpCollect(c: Ctx, i: Extract<ActionInput, { action: "lp_collect" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, l = await ownLoan(c, lane, wallet, i.loanId), id = l.id;
  const ref = positionRef(lane, l.adapter, l.pool, l.tokenId);
  const [[fx], rewardTokens] = await Promise.all([c.chain.lpFacts(l.adapter, [l.tokenId]), c.chain.lpRewardTokens(l.adapter)]);
  const pool = lane.pools.find((p) => same(p.adapter, l.adapter) && same(p.pool, l.pool));
  const pair = fx ? [fx.token0, fx.token1] : pool ? [pool.token0, pool.token1] : [];
  const tokens = [...new Map([...pair, ...rewardTokens].map((t) => [t.toLowerCase(), getAddress(t)])).values()];
  const credits = await walletCredits(c, lane, wallet, tokens);
  const listed = (xs: { token: Address; amount: bigint }[], refs: Map<string, TokenRef>) => xs.map((x) => ({ ...refs.get(x.token.toLowerCase())!, amount: x.amount.toString() }));
  if (credits.length) {
    const receiving = credits.map((x) => ({ ...x, amount: x.amount.toString() }));
    return {
      view: { action: "lp_collect", ...ref, loanId: i.loanId, fees: [], rewards: false, receive: receiving },
      summary: { title: "Receive what the LP lane credits this wallet", rows: credits.map((x) => ({ label: "To receive", value: amountText(x, x.amount) })) },
      steps: credits.map((x) => receive(lane, x, x.amount)),
      notes: ["What the lane's core credits the wallet in this loan's tokens comes to the wallet first; lp_collect again collects new fees."],
    };
  }
  requireThat(l.state === 1, "NOT_RUNNING", "Only a running LP loan's fees are collected");
  requireThat((await c.chain.head()).timestamp < l.end, "TERM_ENDED", "The term has ended: the position's fees and rewards go to the lenders with it");
  const owed = await c.chain.lpFeesOwed(lane.core, id, wallet);
  const due = owed !== null && (owed.amount0 > 0n || owed.amount1 > 0n), rewards = rewardTokens.length > 0;
  const refs = await tokenRefs(c, pair);
  const fees = due && fx ? listed([{ token: fx.token0, amount: owed.amount0 }, { token: fx.token1, amount: owed.amount1 }].filter((x) => x.amount > 0n), refs) : [];
  const claim = call("Claim the position's rewards", lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "claimRewards", args: [id] }));
  const steps: Step[] = due ? [call("Collect the position's fees", lane.core, encodeFunctionData({ abi: lpCoreAbi, functionName: "collectFees", args: [id] })), ...(rewards ? [claim] : [])]
    : rewards ? [claim] : [];
  return {
    view: { action: "lp_collect", ...ref, loanId: i.loanId, fees, rewards, receive: [] },
    summary: {
      title: steps.length ? `Collect the ${due ? "fees" : "rewards"} of LP loan #${i.loanId}` : "Nothing is ready to collect",
      rows: [
        ...(fees.length ? [{ label: "Fees ready", value: amounts(fees) }] : []),
        ...(rewards && steps.length ? [{ label: "Rewards", value: "The position's DEX rewards are claimed too" }] : []),
        ...(steps.length ? [{ label: "The position", value: "Its liquidity stays in place, pledged to the loan" }] : []),
      ],
    },
    steps,
    notes: due
      ? ["The fees and rewards are credited on the LP lane's core first; once this is mined the action is prepared again to receive them (run() does so itself)."]
      : steps.length ? ["The rewards claimed are credited on the LP lane's core: lp_withdraw receives them."] : [],
    ...(due ? { again: true as const } : {}),
  };
}

/** Withdrawing what the LP core credits the wallet (`withdraw(token)`): one token, or every token with a credit. */
async function lpWithdraw(c: Ctx, i: Extract<ActionInput, { action: "lp_withdraw" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address;
  const credits = await walletCredits(c, lane, wallet, i.token ? [getAddress(i.token)] : await creditTokens(c, lane));
  requireThat(!i.token || credits.length, "NOTHING_TO_WITHDRAW", "The LP lane credits this wallet none of this token");
  return {
    view: { action: "lp_withdraw", credits: credits.map((x) => ({ ...x, amount: x.amount.toString() })) },
    summary: {
      title: credits.length ? "Withdraw what the LP lane credits this wallet" : "Nothing to withdraw",
      rows: credits.map((x) => ({ label: "To receive", value: amountText(x, x.amount) })),
    },
    steps: credits.map((x) => receive(lane, x, x.amount)),
    notes: credits.length > 1 ? ["Each token is its own transaction."] : [],
  };
}

/** A lane vault, re-read on chain: it still takes USDG and lends through the lane's core. */
async function laneVault(c: Ctx, lane: LpLane, vault: string) {
  const v = await vaultOf(c, lane, vault), st = await c.chain.lpVault(v.address);
  requireThat(same(st.asset, c.d.usdg), "ASSET_CHANGED", "This vault does not take USDG; read it again before acting");
  requireThat(same(st.core, lane.core), "UNKNOWN_VAULT", "This vault does not lend through gage's LP core", 404);
  return { v, st };
}

/**
 * A deposit into an LP vault (ERC-4626, D319: `deposit(assets, receiver, minShares)`, the shares minted to the wallet):
 * USDG approved for exactly the amount, then the deposit, its least shares what it buys now (`previewDeposit`) less
 * `maxSlippageBps` (50 when omitted). Refused while the vault is impaired (VAULT_IMPAIRED) or its deposits are closed
 * (DEPOSITS_CLOSED), as its `maxDeposit` is 0 then. A reserve vault (D454) puts what no loan needs into its reserve, so
 * its review says that, where an LPVault's says what it pays out from is its free cash alone.
 */
async function lpDeposit(c: Ctx, i: Extract<ActionInput, { action: "lp_deposit" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, amount = BigInt(i.amount);
  const { v, st } = await laneVault(c, lane, i.vault);
  requireThat(!st.impaired, "VAULT_IMPAIRED", "The vault is impaired: a loan past its end is not settled yet, or tokens a defaulted position delivered wait to be sold. It takes no deposit now");
  requireThat(!st.depositsClosed, "DEPOSITS_CLOSED", "The vault's deposits are closed while value it wrote off may still come back");
  // D318: a vault the registry no longer lets fund new loans would hold the deposit idle; a reserve vault (D454) would not,
  // but the registry's word still shuts its deposits.
  const [allowed] = await c.chain.lpVaultsAllowed(lane.registry, [v.address]);
  requireThat(allowed === true, "VAULT_NOT_LENDING", st.reserve
    ? "gage's registry no longer lets this vault fund new loans, so it takes no deposit. Its open loans run to their ends"
    : "gage's registry no longer lets this vault fund new loans: a deposit would sit idle. Its open loans run to their ends");
  requireThat(await c.chain.balance(c.d.usdg, wallet) >= amount, "INSUFFICIENT_BALANCE", `The wallet holds less than ${f.usdg(amount)}`);
  const minShares = slip(await c.chain.lpPreviewDeposit(v.address, amount), i.maxSlippageBps);
  requireThat(minShares > 0n, "ZERO_SHARES", "Too small to buy a share");
  const name = `${v.name} (${f.short(v.address)})`, { decimals } = await lpShareUnit(c.chain, v.address);
  return {
    view: { action: "lp_deposit", vault: v.address, name: v.name, amount: amount.toString(), minShares: minShares.toString(), shareDecimals: decimals, performanceFeeBps: st.performanceFeeBps },
    summary: { title: `Deposit ${f.usdg(amount)} into ${name}`, rows: [
      { label: "You deposit", value: f.usdg(amount) },
      { label: "You receive at least", value: lpSharesText(minShares, decimals) },
      { label: "Performance fee", value: `${f.bps(st.performanceFeeBps)} of what the vault's loans return` },
      { label: "Taking it out", value: st.reserve ? "Any time the vault is not impaired, up to what its cash and its reserve can pay" : "Any time the vault is not impaired, up to its free cash" },
      ...(st.reserve ? [{ label: "While it waits for a loan", value: "Cash past its curator's buffer goes into its reserve, an outside ERC-4626 whose return moves and which carries its own risk; loans and withdrawals draw on it. Holders also share sGAGE from its loans, claimed with lp_claim_rewards" }] : []),
      { label: "What it lends against", value: `${mandateWords(lane, st.mandate, c.now())} At a fixed cost and with no liquidation: a loan is never closed early because a price moves, and one not repaid by its end is settled by unwinding its position for the vault` },
    ] },
    steps: [
      ...await usdgApproval(c, wallet, v.address, amount),
      call("Deposit", v.address, encodeFunctionData({ abi: lpVaultAbi, functionName: "deposit", args: [amount, wallet, minShares] }), true),
    ],
    notes: [],
  };
}

/**
 * What a reserve vault pays a redemption of `asked` shares now (D454), up to its `maxRedeem`, which follows its cash and
 * what its reserve can pay, where an LPVault stops at its free cash. `maxRedeem` answers 0 while the reserve cannot be read,
 * and its previews revert then, so none is asked past it. Shares `named` past it are refused (INSUFFICIENT_LIQUIDITY).
 * Everything is cut to a basis point under it: a share's value grows while the transaction is on its way, and when the
 * vault's liquidity is what limits the holding, the most it pays at this block is more than it pays at the next.
 */
async function reserveRedemption(c: Ctx, vault: Address, wallet: Address, asked: bigint, named: boolean): Promise<{ shares: bigint; assets: bigint }> {
  const most = await c.chain.lpMaxRedeem(vault, wallet);
  if (asked <= most) return { shares: asked, assets: await c.chain.lpPreviewRedeem(vault, asked) };
  requireThat(most > 0n, "INSUFFICIENT_LIQUIDITY", "The vault can pay nothing now, while its cash and reserve are short or its reserve cannot be read; try again later", 409, { availableNow: "0" });
  const shares = named ? most : most - most / 10_000n, assets = await c.chain.lpPreviewRedeem(vault, shares);
  requireThat(!named, "INSUFFICIENT_LIQUIDITY", `The vault can pay ${f.usdg(assets)} now; redeem fewer shares`, 409, { availableNow: assets.toString() });
  return { shares, assets };
}

/**
 * A withdrawal from an LP vault (ERC-4626, D319: `redeem(shares, receiver, owner, minAssets)`, the wallet's own shares
 * paid to it), paid from its free cash, and a reserve vault's reserve (D454, `reserveRedemption`): the shares named, or
 * every share the wallet holds (`balanceOf`, those it received by transfer included) when omitted, cut to what the vault
 * pays now (`maxRedeem`), less a basis point of it while a loan runs (a reserve vault's while that is what limits it); its
 * least amount what they redeem for now (`previewRedeem`) less `maxSlippageBps`. Refused while the vault is impaired
 * (VAULT_IMPAIRED), for more shares than the wallet holds (EXCEEDS_BALANCE), and for named shares the vault cannot pay
 * (INSUFFICIENT_LIQUIDITY).
 */
async function lpRedeem(c: Ctx, i: Extract<ActionInput, { action: "lp_redeem" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address;
  const { v, st } = await laneVault(c, lane, i.vault);
  const held = await c.chain.lpShares(v.address, wallet);
  requireThat(held > 0n, "EXCEEDS_BALANCE", "This wallet holds no shares of this vault");
  const asked = i.shares ? BigInt(i.shares) : held;
  requireThat(asked <= held, "EXCEEDS_BALANCE", "More shares than the wallet holds");
  requireThat(!st.impaired, "VAULT_IMPAIRED", "The vault is impaired: a loan past its end is not settled yet, or tokens a defaulted position delivered wait to be sold. It pays nothing out now");
  let { shares, assets } = st.reserve ? await reserveRedemption(c, v.address, wallet, asked, Boolean(i.shares)) : { shares: asked, assets: await c.chain.lpPreviewRedeem(v.address, asked) };
  // While a loan runs (free cash short of what the vault holds), the share's value grows by the second and the free cash
  // does not: a redemption sized to the free cash's last unit reverts once the share has grown (InsufficientLiquidity).
  // Everything is held a basis point under it, as earn_redeem holds a partner vault's (FREE_CASH_MARGIN_BPS): a vault lent
  // out whole at the core's highest cost (50% a year) takes about an hour and three quarters to outgrow it. A reserve
  // vault's limit is `reserveRedemption`'s, which holds its own margin.
  const short = st.totalAssets !== null && st.freeCash < st.totalAssets, margin = (x: bigint) => (short ? x - (x * FREE_CASH_MARGIN_BPS) / 10_000n : x);
  if (!st.reserve && assets > (i.shares ? st.freeCash : margin(st.freeCash))) {
    requireThat(!i.shares, "INSUFFICIENT_LIQUIDITY", `The vault can pay ${f.usdg(st.freeCash)} now; redeem fewer shares`, 409, { availableNow: st.freeCash.toString() });
    // Everything the free cash pays: ERC-4626's `maxRedeem`, the holding up to the most shares whose redemption, at the
    // vault's own price (its virtual shares and asset included), the free cash covers; less the basis point.
    shares = margin(await c.chain.lpMaxRedeem(v.address, wallet));
    assets = shares > 0n ? await c.chain.lpPreviewRedeem(v.address, shares) : 0n;
    requireThat(shares > 0n && assets <= st.freeCash, "INSUFFICIENT_LIQUIDITY", `The vault can pay ${f.usdg(st.freeCash)} now`, 409, { availableNow: st.freeCash.toString() });
  }
  requireThat(assets > 0n, "TOO_SMALL", "What these shares redeem for is too small to withdraw");
  const minAssets = slip(assets, i.maxSlippageBps), all = shares === held;
  const name = `${v.name} (${f.short(v.address)})`, { decimals } = await lpShareUnit(c.chain, v.address);
  const text = lpSharesText(shares, decimals);
  return {
    view: { action: "lp_redeem", vault: v.address, name: v.name, shares: shares.toString(), shareDecimals: decimals, assets: assets.toString(), minAssets: minAssets.toString(), all },
    summary: { title: `Withdraw ${f.usdg(assets)} from ${name}`, rows: [
      { label: "You redeem", value: all ? `${text} (all)` : shares < asked ? `${text} (${st.reserve ? "all the vault can pay now" : "all the vault's free cash pays now"})` : text },
      { label: "You receive at least", value: f.usdg(minAssets) },
    ] },
    steps: [call("Withdraw", v.address, encodeFunctionData({ abi: lpVaultAbi, functionName: "redeem", args: [shares, wallet, wallet, minAssets] }), true)],
    notes: shares < asked ? [st.reserve ? "The rest stays in the vault until its cash and reserve can pay it." : "The rest stays in the vault until it has the free cash to pay it."] : [],
  };
}

/**
 * Claiming an LP vault's bonuses (`claimBonus(loanId)`): what a defaulted loan's sale brought above the book value the
 * vault counted for it, shared by the lenders by their share of the vault and the time they held it while the loan ran
 * (past lenders included). One loan, or every defaulted loan of the vault with a bonus for this wallet, twenty at most.
 */
async function lpClaimBonus(c: Ctx, i: Extract<ActionInput, { action: "lp_claim_bonus" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, v = await vaultOf(c, lane, i.vault);
  let ids: bigint[];
  if (i.loanId) ids = [BigInt(i.loanId)];
  else ids = (await scanLoans(c, lane)).loans.filter((l) => (l.state === 3 || l.state === 4) && same(l.vault, v.address)).map((l) => l.id);
  const owed = await c.chain.lpBonuses(v.address, ids, wallet);
  const ready = ids.flatMap((id, n) => (owed[n]! > 0n ? [{ id, amount: owed[n]! }] : []));
  requireThat(!i.loanId || ready.length, "NO_BONUS", "This wallet has no bonus to claim from this loan in this vault");
  const claims = ready.slice(0, MAX_BONUS_CLAIMS), total = claims.reduce((s, x) => s + x.amount, 0n);
  return {
    view: { action: "lp_claim_bonus", vault: v.address, name: v.name, bonuses: claims.map((x) => ({ loanId: x.id.toString(), amount: x.amount.toString() })), total: total.toString() },
    summary: {
      title: claims.length ? `Claim ${f.usdg(total)} of bonuses from ${v.name} (${f.short(v.address)})` : "No bonus to claim",
      rows: claims.map((x) => ({ label: `Loan #${x.id}`, value: f.usdg(x.amount) })),
    },
    steps: claims.map((x) => call(`Claim the bonus of loan #${x.id}`, v.address, encodeFunctionData({ abi: lpVaultAbi, functionName: "claimBonus", args: [x.id] }))),
    notes: [
      ...(claims.length ? ["A bonus is what a defaulted loan's sale brought above its book value, shared by the lenders by their share of the vault and the time they held it while the loan ran."] : []),
      ...(ready.length > claims.length ? ["More bonuses are ready: claim again once these have gone through."] : []),
    ],
  };
}

/**
 * Claiming a holder's sGAGE from a reserve vault (D454, `LPVaultCompanion.claimRewards`): what its loans earned the vault's
 * holders, outside the share price, paid to the caller, shares held or not. Refused on an LPVault, which has no companion
 * and pays no sGAGE (NOT_RESERVE_VAULT), and with nothing to claim (NOTHING_TO_CLAIM). It moves no USDG.
 */
async function lpClaimRewards(c: Ctx, i: Extract<ActionInput, { action: "lp_claim_rewards" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, v = await vaultOf(c, lane, i.vault);
  const companion = await c.chain.lpCompanion(v.address);
  requireThat(companion, "NOT_RESERVE_VAULT", "This LP vault has no reserve and pays no sGAGE");
  const amount = await c.chain.lpRewardClaimable(companion, wallet);
  requireThat(amount > 0n, "NOTHING_TO_CLAIM", "This wallet has no sGAGE to claim from this LP vault");
  const text = f.money(amount, { symbol: "sGAGE", decimals: 18, stable: false });
  return {
    view: { action: "lp_claim_rewards", vault: v.address, name: v.name, companion, amount: amount.toString() },
    summary: {
      title: `Claim ${text} from ${v.name} (${f.short(v.address)})`,
      rows: [{ label: "You receive", value: text }, { label: "Your shares", value: "They stay as they are, and keep their share of what comes next" }],
    },
    steps: [call(`Claim ${text}`, companion, encodeFunctionData({ abi: lpCompanionAbi, functionName: "claimRewards" }), true)],
    notes: ["This is what the vault's loans earned its holders in sGAGE, outside the share price and with no fee: each holder's by its share of the vault while it arrived."],
  };
}

/** The largest loan a vault may fund (`LPVault.MAX_LOAN_PRINCIPAL_LIMIT`): 10,000,000 USDG. */
export const LP_MAX_LOAN_LIMIT = 10_000_000_000_000n;
/** The most pools a vault's mandate names (`LPVault.MAX_MANDATE_POOLS`). */
export const LP_MAX_MANDATE_POOLS = 32;
/** How long a pool a curator adds waits before it funds new loans (`LPVault.MANDATE_DELAY`): three hours. */
export const LP_MANDATE_DELAY = 3 * 3_600;

/** The lane's pool `pool` under `adapter`, as the release lists it; POOL_NOT_ALLOWED for any other. */
function listedPool(lane: LpLane, adapter: string, pool: string) {
  const p = lpPoolOf(lane, adapter, pool);
  requireThat(p, "POOL_NOT_ALLOWED", "gage's LP lane does not list this pool under this adapter (gage_capabilities lpLane.pools)", 409);
  return p;
}

/**
 * Opening an LP vault through the lane's factory (D318, `create(name, performanceFeeBps, maxLoanPrincipal, pools)`): for a
 * wallet the registry lets open one (`mayOpenVault`: an allowed curator, or anyone once its owner opens creation, D319;
 * NOT_CURATOR otherwise), named, with its performance fee (5% to 15% of each
 * loan's fixed cost, fixed for good), its largest loan (at most 10,000,000 USDG) and the pools it funds (its mandate, each
 * listed by the release, each once). The pools named here fund at once; the vault starts empty and lends what depositors
 * bring.
 */
async function lpCreateVault(c: Ctx, i: Extract<ActionInput, { action: "lp_create_vault" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address;
  requireThat(lane.vaultFactory, "NO_VAULT_FACTORY", "gage's LP lane names no vault factory on this deployment", 404);
  const bytes = new TextEncoder().encode(i.name).length;
  requireThat(i.name.trim() !== "" && bytes <= 64, "INVALID_INPUT", "The name must be 1 to 64 bytes, not only spaces", 400);
  const maxLoan = BigInt(i.maxLoanPrincipal);
  requireThat(maxLoan <= LP_MAX_LOAN_LIMIT, "INVALID_INPUT", `The largest loan is at most ${f.usdg(LP_MAX_LOAN_LIMIT)}`, 400);
  const pools = i.pools.map((p) => listedPool(lane, p.adapter, p.pool));
  const keys = pools.map((p) => `${p.adapter}:${p.pool}`.toLowerCase());
  requireThat(new Set(keys).size === keys.length, "INVALID_INPUT", "Name each pool once", 400);
  requireThat(await c.chain.lpMayOpenVault(lane.registry, wallet), "NOT_CURATOR", "gage's LP registry does not let this wallet open a vault: until its owner opens vault creation to everyone, it allows curators one by one", 403);
  const names = pools.map((p) => p.name).join(", ");
  return {
    view: {
      action: "lp_create_vault", name: i.name, performanceFeeBps: i.performanceFeeBps, maxLoanPrincipal: maxLoan.toString(),
      pools: pools.map((p) => ({ adapter: p.adapter, pool: p.pool, poolName: p.name })),
    },
    summary: { title: `Open the LP vault "${i.name}"`, rows: [
      { label: "It lends against", value: `Positions in ${names}, and nothing else: its mandate` },
      { label: "Performance fee", value: `${f.bps(i.performanceFeeBps)} of each loan's fixed cost, to you; fixed for good` },
      { label: "Largest loan", value: f.usdg(maxLoan) },
      { label: "You curate", value: "Its pools (one you add funds three hours later; one you drop stops at once), its largest loan, and whether it funds new loans" },
      { label: "Its lenders", value: "Deposit USDG, withdraw from its free cash, and keep what a defaulted position brings back; you never touch their money" },
    ] },
    steps: [call("Open the vault", lane.vaultFactory, encodeFunctionData({
      abi: lpVaultFactoryAbi, functionName: "create", args: [i.name, i.performanceFeeBps, maxLoan, pools.map((p) => ({ adapter: p.adapter, pool: p.pool }))],
    }), true)],
    notes: ["gage_lp_vaults lists the vault once its transaction is mined (factory true, curator this wallet). It lends nothing until depositors bring USDG."],
  };
}

/** A vault this wallet curates, re-read on chain, and its mandate: NOT_CURATOR for any other wallet. */
async function curatedVault(c: Ctx, lane: LpLane, wallet: Address, vault: string) {
  const { v, st } = await laneVault(c, lane, vault);
  requireThat(same(st.curator, wallet), "NOT_CURATOR", "This wallet does not curate this LP vault", 403);
  requireThat(st.mandate, "NO_MANDATE", "This vault names no mandate: it was built before vaults funded only their own pools", 409);
  return { v, mandate: st.mandate };
}

/**
 * Adding a pool to a vault's mandate (`addPool(adapter, pool)`), by its curator: it funds new loans there three hours
 * after (`MANDATE_DELAY`), so its lenders see a change before it applies. Refused for a pool already in it
 * (POOL_IN_MANDATE), past 32 pools (TOO_MANY_POOLS), or one the release does not list.
 */
async function lpVaultAddPool(c: Ctx, i: Extract<ActionInput, { action: "lp_vault_add_pool" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address, pool = listedPool(lane, i.adapter, i.pool);
  const { v, mandate } = await curatedVault(c, lane, wallet, i.vault);
  requireThat(!mandate.some((p) => same(p.adapter, pool.adapter) && same(p.pool, pool.pool)), "POOL_IN_MANDATE", "This pool is in the vault's mandate already", 409);
  requireThat(mandate.length < LP_MAX_MANDATE_POOLS, "TOO_MANY_POOLS", `A vault's mandate names at most ${LP_MAX_MANDATE_POOLS} pools`, 409);
  const fundsFrom = c.now() + LP_MANDATE_DELAY;
  return {
    view: { action: "lp_vault_add_pool", vault: v.address, name: v.name, adapter: pool.adapter, pool: pool.pool, poolName: pool.name, fundsFrom },
    summary: { title: `Add ${pool.name} to ${v.name} (${f.short(v.address)})`, rows: [
      { label: "It funds new loans there", value: `From about ${new Date(fundsFrom * 1000).toISOString()}: three hours after it is added, so its lenders see the change first` },
    ] },
    steps: [call(`Add ${pool.name}`, v.address, encodeFunctionData({ abi: lpVaultAbi, functionName: "addPool", args: [pool.adapter, pool.pool] }), true)],
    notes: [],
  };
}

/**
 * Dropping a pool from a vault's mandate (`removePool(adapter, pool)`), by its curator: it funds no new loan there from
 * then on, at once; loans already open in it run to their ends. Refused for a pool not in it (POOL_NOT_IN_MANDATE).
 */
async function lpVaultRemovePool(c: Ctx, i: Extract<ActionInput, { action: "lp_vault_remove_pool" }>): Promise<Plan> {
  const lane = laneOf(c), wallet = i.wallet as Address;
  const { v, mandate } = await curatedVault(c, lane, wallet, i.vault);
  const entry = mandate.find((p) => same(p.adapter, i.adapter) && same(p.pool, i.pool));
  requireThat(entry, "POOL_NOT_IN_MANDATE", "This pool is not in the vault's mandate", 409);
  const poolName = lpPoolOf(lane, entry.adapter, entry.pool)?.name ?? `the pool ${f.short(entry.pool)}`;
  return {
    view: { action: "lp_vault_remove_pool", vault: v.address, name: v.name, adapter: entry.adapter, pool: entry.pool, poolName },
    summary: { title: `Drop ${poolName} from ${v.name} (${f.short(v.address)})`, rows: [
      { label: "New loans there", value: "None from now: it stops at once" },
      { label: "Loans already open", value: "Run to their ends, as agreed" },
    ] },
    steps: [call(`Drop ${poolName}`, v.address, encodeFunctionData({ abi: lpVaultAbi, functionName: "removePool", args: [entry.adapter, entry.pool] }), true)],
    notes: [],
  };
}

/** The plan of an LP action. */
export function lpPlan(c: Ctx, input: Extract<ActionInput, { action: `lp_${string}` }>): Promise<Plan> {
  switch (input.action) {
    case "lp_borrow": return lpBorrow(c, input);
    case "lp_repay": return lpRepay(c, input);
    case "lp_return_position": return lpReturnPosition(c, input);
    case "lp_collect": return lpCollect(c, input);
    case "lp_withdraw": return lpWithdraw(c, input);
    case "lp_deposit": return lpDeposit(c, input);
    case "lp_redeem": return lpRedeem(c, input);
    case "lp_claim_bonus": return lpClaimBonus(c, input);
    case "lp_claim_rewards": return lpClaimRewards(c, input);
    case "lp_roll": return lpRoll(c, input);
    case "lp_wrap": return lpWrap(c, input);
    case "lp_unwrap": return lpUnwrap(c, input);
    case "lp_create_vault": return lpCreateVault(c, input);
    case "lp_vault_add_pool": return lpVaultAddPool(c, input);
    case "lp_vault_remove_pool": return lpVaultRemovePool(c, input);
  }
}
