/**
 * A partner vault's exit now (Intent D57), as gage's app offers it (web/src/intent/partners/ExitNow.tsx, useExitNow.ts and
 * actions.ts): a holder whose balance is more than the vault can pay now approves the chain's exit desk for its shares,
 * commits them and lists the vault's loan the app and gage's keeper would list for what the vault cannot pay of them
 * (exitChoice.ts). What a buyer pays falls to book value over ten minutes for that part only, and from root D391
 * (SEC-01) never further than the leaver's own share of what that loan has still to earn: the leaver pays the buyer's
 * discount below the start out of it, so the listing may not sell (for a rehypo pool the leaver is its source, so the
 * pool's LPs who stay pay it). The sale redeems the shares in its own transaction,
 * and the desk owes the holder what they paid until the holder collects it. Then the open
 * exit's next listing once its last ended unsold, its cancel (on the desk the factory bound, so while exits are closed
 * too), and the collect; where an exit stands and what the desk owes, for the portfolio read and Collect all.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { exitDeskAbi } from "./abi.js";
import { accounting, indexerOf, stillToEarn, vaultName } from "./data.js";
import type { Generation, LendAsset } from "./deployment.js";
import { ApiError, requireThat } from "./errors.js";
import {
  chooseExitHolding, EXIT_CONFIRM_SECONDS, EXIT_FALL_SECONDS, EXIT_KEEP_BPS, EXIT_LISTING_SECONDS, exitCommitted, exitNeed, exitShares, exitStage, liveExit, RATE_PRECISION,
  type ExitReads, type ExitStake,
} from "./exitChoice.js";
import * as f from "./format.js";
import { approval, inAsset, partner, refOf, settleFirst, settleForExit, type Ctx, type Plan, type Row, type Step, type Tx, type View } from "./plans.js";
import { span, type Preview } from "./preview.js";
import type { ActionInput } from "./schemas.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const call = (label: string, to: Address, data: Hex, final = false): Step => ({ label, kind: "action", final, build: () => Promise.resolve({ to, data, value: 0n }) });
const NO_EXIT = "This wallet has no exit open from this vault";
const NO_LOAN = "None of the vault's loans can be listed for you right now; try again in a few minutes";
/** A request's life in the app's words: "24 hours". */
const hours = (seconds: number) => (seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}` : f.days(seconds));

/** What choosing an exit's holding reads (exitChoice.ts), for `vault` of generation `g`, at `desk` and the vault's
 * `market`; with `leaver`, what it carried of each holding (SEC-01, its stake floor). */
export function exitReads(c: Ctx, g: Generation, vault: Address, desk: Address, market: Address, leaver?: Address): ExitReads {
  return {
    records: () => c.chain.exitRecords(g.factory, vault),
    record: (x) => c.chain.exitRecord(vault, x),
    accrualEnd: (x) => c.chain.accrualEnd(g.core.engine, x),
    saleSlots: (x) => c.chain.saleSlots(vault, x),
    coreLoan: async (x) => {
      const l = await c.chain.loan(g.core.engine, x);
      return { state: l.state, term: l.term, fundedAt: l.fundedAt };
    },
    listing: (x) => c.chain.exitListing(desk, vault, x),
    ask: (x) => c.chain.exitAsk(market, x),
    withinAverage: (x) => c.chain.withinAverage(desk, vault, x),
    shortfall: (owner) => c.chain.exitShortfall(desk, vault, owner as Address),
    floorOf: (x, owner) => c.chain.exitFloorOf(desk, vault, x, owner as Address),
    ...(leaver ? { exitShares: (ids: readonly bigint[]) => c.chain.exitShares(g.factory, vault, ids, leaver) } : {}),
  };
}

/**
 * ED2 (root D390): whether the desk would take over the standing exit listing of a holding for this wallet now, as the
 * wallet's own transactions simulated at the head say: `first` (the approval, where one is needed), then `last`, the call
 * that lists it. Through eth_simulateV1 where the RPC has it, else `last` alone where nothing comes before it; true where
 * neither can say, and the wallet simulates before it signs. A takeover the desk refuses is passed over for the next
 * holding (`chooseExitHolding`), so preparing the action again never chooses it again.
 */
export async function takesOver(c: Ctx, wallet: Address, first: readonly Step[], last: Tx): Promise<boolean> {
  const calls = [...await Promise.all(first.map((s) => s.build())), last];
  const batch = await c.chain.simulateCalls(wallet, calls);
  if (batch) return batch.every(Boolean);
  if (first.length) return true;
  try {
    await c.chain.simulate({ from: wallet, ...last });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "SIMULATION_FAILED") return false;
    throw error;
  }
}

/**
 * SEC-01 (root D391): the shares the desk will redeem for `owner` at a sale, the least of what its exit commits, its
 * balance and its approval of the desk, as the desk's stake floor counts them, beside that balance.
 */
export async function exitStake(c: Ctx, vault: Address, owner: Address, desk: Address, committed: bigint): Promise<ExitStake> {
  const [held, approved] = await Promise.all([c.chain.vaultShares(vault, owner), c.chain.allowance(vault, owner, desk)]);
  return { committed: [committed, held, approved].reduce((a, b) => (a < b ? a : b)), held };
}

/**
 * About what leaving with `shares` of `vault` gives up, as the app's exit sheet counts it (`exitGiveUp`; D29: a holder
 * leaves at book value): their share of what the vault's loans have still to earn, if they are repaid (`stillToEarn`).
 * Null while the index cannot say, or does not answer: the plan still stands without it.
 */
export async function exitGiveUp(c: Ctx, g: Generation, vault: Address, shares: bigint): Promise<bigint | null> {
  try {
    const acc = await indexerOf(c, g).get(`/intent/partners/vaults/${vault.toLowerCase()}/accounting`, accounting);
    const left = stillToEarn(acc), supply = BigInt(acc.pricing.totalSupply);
    return left === null ? null : supply === 0n ? 0n : (left * shares) / supply;
  } catch {
    return null;
  }
}

/**
 * What a listing of holding `id` of the vault `name` does for an exit that needs `need` of it (raw, in `cash`): over ten
 * minutes the part the need covers falls to book value, the rest keeping 99% of what it has still to earn
 * (`IntentExitDesk.floorBps`); a holding the need covers whole (`book`, scaled by 1e18) falls all to book. Where the desk
 * charges the leaver its own discount (`floorBps` known, SEC-01), the price falls no further than `floorBps` of what the
 * loan has still to earn above book value, and the listing may not sell; at the start itself (9900: the leaver's share
 * of that loan pays no discount) the price does not fall at all, and a vault is unlikely to buy it.
 */
export function soldFor(id: bigint, name: string, need: bigint, book: bigint, cash: LendAsset, floorBps: number | null = null): string {
  if (floorBps !== null && floorBps >= EXIT_KEEP_BPS) {
    return `Loan #${id} of ${name}: its price stays at book value plus ${f.bps(EXIT_KEEP_BPS)} of what it has still to earn and does not fall. `
      + "A vault is unlikely to buy it";
  }
  if (floorBps !== null) {
    return `Loan #${id} of ${name}: over ten minutes its price falls from book value plus ${f.bps(EXIT_KEEP_BPS)} of what it has still to earn to `
      + `${floorBps === 0 ? "book value" : `book value plus ${f.bps(floorBps)} of it`}. A vault buys only if the price falls far enough for it, so it may not sell`;
  }
  return `Loan #${id} of ${name}: over ten minutes ${need * RATE_PRECISION >= book
    ? "all of it falls to book value"
    : `${f.money(need, cash)} of it falls to book value, the rest keeps ${f.bps(EXIT_KEEP_BPS)} of what it has still to earn`}`;
}

/**
 * What leaving gives up, in words: about `lost`, the holder's share of what the vault's loans have still to earn. From
 * root D391 (`sold`, the loan listed for it, where the desk charges the leaver its own discount) the buyer's discount on
 * that loan comes out of the leaver's own share of what it has still to earn: the holder's, when it is the leaver
 * (`pool` false); for a rehypo pool's LP (`pool` true) the leaver is the pool's source, whose share belongs to the LPs who
 * stay, so they pay the discount, not the LP.
 */
export const giveUpText = (lost: bigint | null, cash: LendAsset, sold: bigint | null = null, pool = false) => {
  const base = lost === null ? "Your share of what the vault's loans have still to earn, if they are repaid: you leave at book value"
    : lost === 0n ? "Nothing: the vault's loans have nothing left to earn"
      : `About ${f.money(lost, cash)}: your share of what the vault's loans have still to earn, if they are repaid`;
  if (sold === null || lost === 0n) return base;
  return pool
    ? `${base}. The buyer's discount on loan #${sold} comes out of the pool's share of what that loan has still to earn, so the LPs who stay pay it, not you`
    : `${base}. You pay the buyer's discount on loan #${sold} yourself, out of your share of what that loan has still to earn`;
};

/** What the wallet's committed shares are worth, as the app's card counts them (`exitCommitted`): no more than it still holds. */
async function committedWorth(c: Ctx, vault: Address, wallet: Address, committed: bigint): Promise<bigint> {
  const held = await c.chain.vaultShares(vault, wallet);
  return held === 0n ? 0n : exitCommitted(committed, held, (await c.chain.exitVaultBook(vault, held)).claim);
}

/**
 * Exit now (the app's sheet): `amount` of the vault's asset, or the whole balance, committed at the desk the factory
 * names now with the holding listed for it, after an exact approval of the desk for the shares when the one standing
 * falls short. Offered as the app's card offers it: beside no open exit (unless its request lapsed, which this renews),
 * never while the vault is paused, and after a settle while a loan of the vault is past its end, or while the desk waits
 * on a record's booking (r13d). An amount the vault can pay now is a withdrawal, not an exit.
 */
export async function earnExitNow(c: Ctx, i: Extract<ActionInput, { action: "earn_exit_now" }>): Promise<Plan> {
  const wallet = i.wallet as Address;
  const { address: vault, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset, name = vaultName(v, c.d);
  // The desk the factory names now lists exits; none while the protocol has closed them.
  const desk = await c.chain.exitDeskOf(g.factory);
  requireThat(desk, "EXITS_CLOSED", "Exit now is closed for this vault: it pays your balance as its loans repay");
  const held = await c.chain.vaultShares(vault, wallet);
  requireThat(held > 0n, "NOTHING_TO_EXIT", "This wallet holds no shares of this vault");
  const now = (await c.chain.head()).timestamp;
  // An open exit has its own moves: its next listing and its cancel. One whose request lapsed is committed again here,
  // as the app's Exit now on a lapsed exit does.
  const open = await c.chain.exitOf(desk, vault, wallet);
  const lapsed = open.shares !== 0n && now >= open.committedAt + open.life;
  requireThat(open.shares === 0n || lapsed, "EXIT_OPEN", "This wallet's exit from this vault is open: earn_exit_list lists its next loan once its listing ends, and earn_exit_cancel withdraws it");
  requireThat(v.settings?.paused !== true, "PAUSED", "The vault is paused: none of its loans can be sold for an exit until it is unpaused");
  // What the shares are worth at today's share value (`previewRedeem`), and the part the amount asks for.
  const whole = await c.chain.exitVaultBook(vault, held);
  const value = whole.claim, wanted = i.amount ? BigInt(i.amount) : value;
  requireThat(wanted <= value, "EXCEEDS_BALANCE", `More than this wallet holds in this vault: ${f.money(value, cash)}`);
  const { shares, worth } = exitShares(held, value, wanted);
  requireThat(shares > 0n, "TOO_SMALL", "Too small to exit: it is worth less than one share of the vault");
  const all = shares === held;
  const view = (payable: bigint, id: bigint | null, need: bigint | null, floorBps: number | null = null): View => ({
    action: "earn_exit_now", vault, name, shares: shares.toString(), assets: worth.toString(), all, payableNow: payable.toString(), loanId: id === null ? null : id.toString(),
    need: need === null ? null : need.toString(), floorBps, lapsesAt: now + open.life, lapsed, ...inAsset(c, cash),
  });
  const title = `Exit ${f.money(worth, cash)} now from ${name} (${f.short(vault)})`;
  // A loan of the vault past its end and not booked stops its sales and what it pays out until a settle books it.
  if (now >= await c.chain.earliestMaturity(vault)) return settleFirst(c, vault, view(0n, null, null), title, name, g);
  // What the vault can pay this wallet now (`maxWithdraw`) is a withdrawal, not an exit.
  const payable = await c.chain.vaultMaxWithdraw(vault, wallet) ?? (whole.free < value ? whole.free : value);
  requireThat(worth > payable, "NOTHING_TO_EXIT", `The vault can pay ${f.money(payable, cash)} now: withdraw that with earn_redeem, or exit more than that`);
  // What the desk's `shortfall` will read once these shares are committed; it lists only for that (`NoShortfall`).
  const need = exitNeed({ ...(all ? whole : await c.chain.exitVaultBook(vault, shares)), shares });
  if (need === 0n) throw new ApiError("NO_SHORTFALL", "The vault holds what this exit would commit in cash and its reserve, so the exit desk lists none of its loans: withdraw what it can pay now with earn_redeem, and the rest once its reserve pays out, or try again in a few minutes", 409, true);
  // The desk lists nothing while a record of the vault awaits its booking (r13d, `SettlementPending`): settled first.
  const pending = await c.chain.pendingSettlements(desk, vault);
  if (pending.length) return settleForExit(vault, pending, view(payable, null, null), title, name);
  // For these shares and this desk only, and only when what is approved falls short, as the app approves it.
  const approve = await approval(c, vault, "vault shares", wallet, desk, shares);
  const exitNow = (id: bigint): Tx => ({ to: desk, data: encodeFunctionData({ abi: exitDeskAbi, functionName: "exitNow", args: [vault, shares, id] }), value: 0n });
  // SEC-01 (root D391): the desk's stake floor counts these shares, which that approval covers, of the wallet's balance.
  const chosen = await chooseExitHolding(exitReads(c, g, vault, desk, await c.chain.lenderMarket(vault), wallet), need, now, EXIT_CONFIRM_SECONDS,
    (h) => takesOver(c, wallet, approve, exitNow(h.id)), { committed: shares, held });
  if (chosen === null) throw new ApiError("NO_LOAN_TO_LIST", NO_LOAN, 409, true);
  const lost = await exitGiveUp(c, g, vault, shares);
  const rows: Row[] = [
    { label: "You receive", value: `${f.money(worth, cash)}${all ? " (all)" : ""}` },
    { label: "The vault can pay now", value: f.money(payable, cash) },
    { label: "Sold for you", value: soldFor(chosen.id, name, need, chosen.book, cash, chosen.floorBps) },
    { label: "You give up", value: giveUpText(lost, cash, chosen.floorBps === null ? null : chosen.id) },
    { label: "Your request lasts", value: `${hours(open.life)}: then nothing is listed or paid for it, and you exit again to go on` },
  ];
  const preview: Preview = {
    kind: "exit_now", asset: { token: cash.token, symbol: cash.symbol, decimals: cash.decimals, stable: cash.stable },
    receive: worth.toString(), now: payable.toString(), giveUp: lost === null ? null : lost.toString(),
    steps: [
      { at: 0, when: "now", what: "You ask" },
      { at: EXIT_FALL_SECONDS, when: `~${span(EXIT_FALL_SECONDS)}`, what: "Loan sold" },
      { at: EXIT_FALL_SECONDS, when: "any time", what: "You collect" },
      { at: open.life, when: span(open.life), what: "Request ends" },
    ],
  };
  return {
    preview,
    view: view(payable, chosen.id, need, chosen.floorBps),
    summary: { title, rows },
    steps: [
      ...approve,
      call("Exit now", desk, exitNow(chosen.id).data, true),
    ],
    notes: [
      ...(lapsed ? [`Your last request ended after ${hours(open.life)}; this one replaces it.`] : []),
      "Once a vault buys the loan, the sale pays you at today's share value, in its own transaction: collect it with earn_exit_collect (collect gathers it too). You keep your sGAGE, and your part of any earnings the sale sets aside.",
      `If no vault takes it within ${EXIT_LISTING_SECONDS / 60} minutes, list the vault's next loan with earn_exit_list; gage's keeper may also list it. Cancel at any time before a sale with earn_exit_cancel.`,
      "Exit now, like a withdrawal, avoids losses on loans that default after you leave; the holders who stay bear them.",
    ],
  };
}

/**
 * List the next loan (the app's open exit): once the exit's last listing sold or ended unsold while the vault still
 * cannot pay the rest of it (the desk's `shortfall`), the holding chosen as Exit now chooses it, listed through the desk
 * the factory names now (`list`), after a settle while the desk waits on a record's booking (r13d). gage's keeper may
 * also list it.
 */
export async function earnExitList(c: Ctx, i: Extract<ActionInput, { action: "earn_exit_list" }>): Promise<Plan> {
  const wallet = i.wallet as Address;
  const { address: vault, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset, name = vaultName(v, c.d);
  const desk = await c.chain.exitDeskOf(g.factory);
  requireThat(desk, "EXITS_CLOSED", "Exit now is closed for this vault: no loan is listed for your exit until it reopens, and earn_exit_cancel still withdraws it");
  const now = (await c.chain.head()).timestamp;
  const open = await c.chain.exitOf(desk, vault, wallet);
  requireThat(open.shares > 0n, "NO_EXIT", `${NO_EXIT}: start one with earn_exit_now`);
  requireThat(now < open.committedAt + open.life, "EXIT_LAPSED", `Your request ended after ${hours(open.life)}, and nothing is listed for it: exit again with earn_exit_now`);
  const market = await c.chain.lenderMarket(vault);
  if (open.nonce !== 0n) {
    const ask = await c.chain.exitAsk(market, open.id);
    if (liveExit(ask, open.nonce, now)) throw new ApiError("LISTING_LIVE", `Loan #${open.id} is listed for your exit for ${span(ask.deadline - now)} more; the next is listed once it ends unsold`, 409, true);
  }
  const need = await c.chain.exitShortfall(desk, vault, wallet);
  if (need === 0n) throw new ApiError("NO_SHORTFALL", "The vault can pay the rest of your exit now, so the exit desk lists none of its loans; withdraw it with earn_redeem", 409, true);
  const view = (id: bigint | null, floorBps: number | null = null): View => ({
    action: "earn_exit_list", vault, name, shares: open.shares.toString(), loanId: id === null ? null : id.toString(), need: id === null ? null : need.toString(),
    floorBps, lapsesAt: open.committedAt + open.life, ...inAsset(c, cash),
  });
  // The desk lists nothing while a record of the vault awaits its booking (r13d, `SettlementPending`): settled first.
  const pending = await c.chain.pendingSettlements(desk, vault);
  if (pending.length) return settleForExit(vault, pending, view(null), `List the next loan for your exit from ${name} (${f.short(vault)})`, name);
  const list = (id: bigint): Tx => ({ to: desk, data: encodeFunctionData({ abi: exitDeskAbi, functionName: "list", args: [vault, wallet, id] }), value: 0n });
  const chosen = await chooseExitHolding(exitReads(c, g, vault, desk, market, wallet), need, now, EXIT_CONFIRM_SECONDS, (h) => takesOver(c, wallet, [], list(h.id)),
    await exitStake(c, vault, wallet, desk, open.shares));
  if (chosen === null) throw new ApiError("NO_LOAN_TO_LIST", NO_LOAN, 409, true);
  const committed = await committedWorth(c, vault, wallet, open.shares);
  return {
    view: view(chosen.id, chosen.floorBps),
    summary: {
      title: `List the next loan for your exit from ${name} (${f.short(vault)})`,
      rows: [
        { label: "Committed", value: f.money(committed, cash) },
        { label: "The vault cannot pay now", value: f.money(need, cash) },
        { label: "Sold for you", value: soldFor(chosen.id, name, need, chosen.book, cash, chosen.floorBps) },
      ],
    },
    steps: [call("List the next loan", desk, list(chosen.id).data, true)],
    notes: [
      "Once a vault buys the loan, collect what the sale paid with earn_exit_collect.",
      `If no vault takes it within ${EXIT_LISTING_SECONDS / 60} minutes, list the next again; gage's keeper may also list it.`,
    ],
  };
}

/**
 * Cancel (the app's open exit): the exit withdrawn on the desk the factory bound (`cancel`), which keeps it while exits
 * are closed too. The shares stay the wallet's, and nothing more is listed or sold for it; a listing still live stays in
 * the market until it ends, with no exit behind it: any other exit may take it over as it stands (ED2, root D390) and
 * sell it for itself, and otherwise its sale reverts (`onSale`).
 */
export async function earnExitCancel(c: Ctx, i: Extract<ActionInput, { action: "earn_exit_cancel" }>): Promise<Plan> {
  const wallet = i.wallet as Address;
  const { address: vault, v, g } = await partner(c, i.vault);
  const cash = g.lendAsset, name = vaultName(v, c.d);
  const desk = await c.chain.boundExitDeskOf(g.factory);
  requireThat(desk, "NO_EXIT", NO_EXIT);
  const open = await c.chain.exitOf(desk, vault, wallet);
  requireThat(open.shares > 0n, "NO_EXIT", NO_EXIT);
  const now = (await c.chain.head()).timestamp;
  const listed = open.nonce !== 0n && liveExit(await c.chain.exitAsk(await c.chain.lenderMarket(vault), open.id), open.nonce, now) ? open.id : null;
  const committed = await committedWorth(c, vault, wallet, open.shares);
  return {
    view: {
      action: "earn_exit_cancel", vault, name, shares: open.shares.toString(), listed: listed === null ? null : listed.toString(), lapsed: now >= open.committedAt + open.life,
      ...inAsset(c, cash),
    },
    summary: {
      title: `Cancel your exit from ${name} (${f.short(vault)})`,
      rows: [
        { label: "Committed", value: f.money(committed, cash) },
        { label: "Then", value: "Your shares stay yours, in the vault: nothing more is listed or sold for this exit" },
      ],
    },
    steps: [call("Cancel the exit", desk, encodeFunctionData({ abi: exitDeskAbi, functionName: "cancel", args: [vault] }), true)],
    notes: listed === null ? [] : [`Loan #${listed} stays listed in the vault's market until its listing ends. It no longer sells for you: another exit may take the listing over and sell the loan for itself.`],
  };
}

/** Each generation the release names an exit desk for, current or retired, with the desk its factory bound and, with
 * `live`, the one it names now (null while exits are closed). */
export async function exitDesks(c: Ctx, live = false): Promise<{ g: Generation; bound: Address | null; live: Address | null }[]> {
  const gens = [...c.d.generations, ...c.d.retired].filter((g) => g.exitDesk !== null);
  return Promise.all(gens.map(async (g) => ({ g, bound: await c.chain.boundExitDeskOf(g.factory), live: live ? await c.chain.exitDeskOf(g.factory) : null })));
}

/** One claim per desk and asset (`IntentExitDesk.owed` is by asset, whatever vaults the exits left), in the generations' order. */
function exitSources(desks: readonly { g: Generation; bound: Address | null }[]): { desk: Address; asset: LendAsset }[] {
  const out: { desk: Address; asset: LendAsset }[] = [];
  for (const { g, bound } of desks) {
    if (!bound || out.some((s) => same(s.desk, bound) && same(s.asset.token, g.lendAsset.token))) continue;
    out.push({ desk: bound, asset: g.lendAsset });
  }
  return out;
}

/** What the exit desks owe `wallet` from its exits' sales, by desk and asset, nonzero only (the app's Ready to collect). */
export async function exitOwed(c: Ctx, wallet: Address, desks?: readonly { g: Generation; bound: Address | null }[]): Promise<{ desk: Address; asset: LendAsset; amount: bigint }[]> {
  const sources = exitSources(desks ?? await exitDesks(c));
  const owed = await Promise.all(sources.map(async (s) => ({ ...s, amount: await c.chain.exitOwed(s.desk, s.asset.token, wallet) })));
  return owed.filter((x) => x.amount > 0n);
}

/**
 * Collect (the app's claim under Ready to collect): what the desk owes the wallet in `asset`, or in each asset it owes,
 * withdrawn from the desk each factory bound, open or closed (`withdraw(asset)`).
 */
export async function earnExitCollect(c: Ctx, i: Extract<ActionInput, { action: "earn_exit_collect" }>): Promise<Plan> {
  const wallet = i.wallet as Address, asset = i.asset ?? null;
  const desks = await exitDesks(c);
  requireThat(asset === null || desks.some(({ g }) => same(g.lendAsset.token, asset)), "UNKNOWN_LEND_ASSET", "No exit desk here pays out this asset; gage_capabilities lists the assets gage lends", 400);
  const owed = (await exitOwed(c, wallet, desks)).filter((x) => asset === null || same(x.asset.token, asset));
  requireThat(asset === null || owed.length, "NOTHING_TO_WITHDRAW", "The exit desk owes this wallet none of this asset");
  return {
    view: { action: "earn_exit_collect", owed: owed.map((x) => ({ desk: x.desk, ...refOf(x.asset), amount: x.amount.toString() })) },
    summary: { title: owed.length ? "Collect what your exits' sales paid" : "Nothing to collect", rows: owed.map((x) => ({ label: "To receive", value: f.money(x.amount, x.asset) })) },
    steps: owed.map((x) => call(`Receive ${f.money(x.amount, x.asset)}`, x.desk, encodeFunctionData({ abi: exitDeskAbi, functionName: "withdraw", args: [x.asset.token] }))),
    notes: owed.length > 1 ? ["Each asset is its own transaction."] : [],
  };
}

/** The withdrawal of what a desk owes in `asset`, as Collect all sends it. */
export const exitCollectStep = (x: { desk: Address; asset: LendAsset; amount: bigint }): Step =>
  call(`Receive ${f.money(x.amount, x.asset)} from your exit now`, x.desk, encodeFunctionData({ abi: exitDeskAbi, functionName: "withdraw", args: [x.asset.token] }));

/**
 * An open exit as the portfolio reads it (the app's Portfolio line on its holding): the shares committed (raw) and what
 * they are worth (`committed`, raw in the vault's asset), where it stands (`listed`: `loanId` is for sale until
 * `listingEndsAt`; `next`: the next loan is to list; `closed`: exits are closed, so none is listed until they reopen;
 * `payable`: the vault can pay the rest now; `lapsed`: nothing is listed or paid for it), and when its request lapses.
 */
export interface ExitLine {
  shares: string; committed: string; stage: "listed" | "next" | "closed" | "payable" | "lapsed"; loanId: string | null; listingEndsAt: number | null; lapsesAt: number;
}

/**
 * `wallet`'s exit from `vault` of generation `g` at the desk its factory bound (`desks`, from `exitDesks(c, true)`), at
 * `now`; null for none. `held` and `value`: the wallet's shares and their worth, as the index reads them for its line.
 */
export async function exitLine(
  c: Ctx, desks: readonly { g: Generation; bound: Address | null; live: Address | null }[], g: Generation, vault: Address, wallet: Address, held: bigint, value: bigint, now: number,
): Promise<ExitLine | null> {
  const at = desks.find((x) => same(x.g.factory, g.factory));
  if (!at?.bound) return null;
  const e = await c.chain.exitOf(at.bound, vault, wallet);
  const lapsed = now >= e.committedAt + e.life;
  // A lapsed exit reads no shortfall and lists nothing: its stage needs neither read.
  const [ask, shortfall] = e.shares === 0n || lapsed ? [null, 0n] : await Promise.all([
    e.nonce === 0n ? null : c.chain.exitAsk(await c.chain.lenderMarket(vault), e.id),
    c.chain.exitShortfall(at.bound, vault, wallet),
  ]);
  const stage = exitStage({ shares: e.shares, loanId: e.id, nonce: e.nonce, ask, shortfall, committedAt: e.committedAt, life: e.life }, now);
  if (stage === null) return null;
  return {
    shares: e.shares.toString(), committed: exitCommitted(e.shares, held, value).toString(), stage: stage.kind === "next" && !at.live ? "closed" : stage.kind,
    loanId: stage.kind === "listed" ? stage.loanId.toString() : null, listingEndsAt: stage.kind === "listed" ? stage.ends : null, lapsesAt: e.committedAt + e.life,
  };
}
