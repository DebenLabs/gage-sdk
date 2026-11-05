/**
 * A rehypo pool's exit now (root D357): an LP of a partner's rehypothecation hook whose share of one of the hook's
 * sources is more than that source can pay now asks it to commit its partner-vault shares at the chain's exit desk
 * (`GageRehypoSource.exitNow(id)`, Intent D57). The holding the desk lists is the one gage's app and keeper would list
 * for what the source's commitment needs (exitChoice.ts), or none while the source's own exit listing is live; an ask
 * that lists settles first what the desk waits on (r13d, `settleForExit`). Once a sale lands, the LP removes its
 * liquidity on the hook as usual, and the source pays from what the sale paid, held for its LPs for an hour
 * (docs/rehypo-source.md).
 */
import { encodeFunctionData, type Address } from "viem";
import type { RehypoSourceRead } from "./chain.js";
import { rehypoSourceAbi } from "./abi.js";
import { indexerOf, vaultName } from "./data.js";
import { exitGiveUp, exitReads, giveUpText, soldFor, takesOver } from "./earnExit.js";
import { ApiError, requireThat } from "./errors.js";
import { chooseExitHolding, EXIT_CONFIRM_SECONDS, EXIT_FALL_SECONDS, exitNeed, liveExit } from "./exitChoice.js";
import * as f from "./format.js";
import { inAsset, partner, refOf, settleFirst, settleForExit, type Ctx, type Plan, type Row, type View } from "./plans.js";
import { span, type Preview } from "./preview.js";
import type { ActionInput } from "./schemas.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What the desk's `shortfall` will read for `source` once this ask commits, as `GageRehypoSource.exitNow` commits: the
 * vault shares its float and the desk's debt leave short of the LP's `claim`, or its open commitment (`committed`) if
 * that is more, never their sum, at most the shares it holds (`held`); then what the vault cannot pay of them now
 * (`exitNeed`). The source counts only the shares it bought (`_ownShares`) and the vault's `balanceOf` adds any sent to
 * it, which can only raise this when one LP's claim reaches the whole of what the source lends.
 */
async function sourceNeed(c: Ctx, source: Address, s: RehypoSourceRead, desk: Address, claim: bigint, committed: bigint, held: bigint): Promise<{ need: bigint; shares: bigint }> {
  const cash = s.float + await c.chain.exitOwed(desk, s.asset, source);
  const wanted = claim > cash ? await c.chain.vaultPreviewWithdraw(s.vault, claim - cash) : 0n;
  const most = wanted > committed ? wanted : committed;
  const shares = most < held ? most : held;
  return { need: shares === 0n ? 0n : exitNeed({ ...await c.chain.exitVaultBook(s.vault, shares), shares }), shares };
}

export async function rehypoExitNow(c: Ctx, i: Extract<ActionInput, { action: "rehypo_exit_now" }>): Promise<Plan> {
  const wallet = i.wallet as Address, source = i.source as Address;
  // The source, re-identified on chain: it lends through a partner vault of a generation gage serves, in that vault's asset.
  const s = await c.chain.rehypoSource(source, wallet);
  requireThat(s, "NOT_A_REHYPO_SOURCE", "This is not a rehypo source that lends through a partner vault", 404);
  const { address: vault, v, g } = await partner(c, s.vault);
  requireThat(same(s.asset, g.lendAsset.token), "NOT_A_REHYPO_SOURCE", "This source holds another token than the vault it lends through", 404);
  const desk = await c.chain.exitDeskOf(g.factory);
  requireThat(desk, "EXITS_CLOSED", "Exit now is closed for this vault: your share is paid as its loans repay");
  // The wallet's share, as the source reads it: its part of the hook's LP token, of everything the source holds.
  requireThat(s.lpSupply > 0n && s.lpBalance > 0n, "NOTHING_TO_EXIT", "This wallet holds none of the pool's LP shares");
  const claim = s.totalAssets * s.lpBalance / s.lpSupply;
  const cash = g.lendAsset, name = vaultName(v, c.d);
  const now = (await c.chain.head()).timestamp;
  const view = (loanId: bigint | null, need: bigint | null = null, endsAt = 0, lapsed = false, floorBps: number | null = null): View => ({
    action: "rehypo_exit_now", source, vault, name, loanId: loanId === null ? null : loanId.toString(), claim: claim.toString(), payableNow: s.payableNow.toString(),
    need: need === null ? null : need.toString(), floorBps, endsAt, lapsed, ...refOf(cash), ...inAsset(c, cash),
  });
  const title = `Exit ${f.money(claim, cash)} now from ${name} (${f.short(vault)})`;
  // A loan of the vault past its end and not booked stops the source's exits until a settle books it (`VaultSettling`).
  if (now >= s.earliestMaturity) return settleFirst(c, vault, view(null), title, name, indexerOf(c, g));
  requireThat(claim > s.payableNow, "NOTHING_TO_EXIT", "The source can pay your share now: remove your liquidity on the pool's hook as usual");
  // The source's vault shares: what its commitment is capped at, and the LP's part of them is what its exit gives up.
  const held = await c.chain.vaultShares(vault, source);
  const giveUp = exitGiveUp(c, g, vault, (held * s.lpBalance) / s.lpSupply);
  // The holding to list: none while the source's own exit listing is live (its commitment rises, the listing goes on).
  const market = await c.chain.lenderMarket(vault);
  const open = await c.chain.exitOf(desk, vault, source);
  // The desk drops a commitment `EXIT_LIFE` after it was made: past it nothing is listed or paid for it until an ask renews
  // it. The source's own hour (`EXIT_HOLD`) ends its exits first, while gage's keeper calls `endExit`.
  const lapsed = open.shares !== 0n && now >= open.committedAt + open.life;
  let id = 0n, need: bigint | null = null, book = 0n, floorBps: number | null = null;
  if (!(open.nonce !== 0n && liveExit(await c.chain.exitAsk(market, open.id), open.nonce, now))) {
    const asked = await sourceNeed(c, source, s, desk, claim, open.shares, held);
    need = asked.need;
    // The desk lists only for what the vault cannot pay (`NoShortfall`).
    if (need === 0n) throw new ApiError("NO_SHORTFALL", "The vault can pay what the source would commit now, so the exit desk lists none of its loans; try again in a few minutes", 409, true);
    // The desk lists nothing while a record of the vault awaits its booking (r13d, `SettlementPending`): settled first.
    const pending = await c.chain.pendingSettlements(desk, vault);
    if (pending.length) return settleForExit(vault, pending, view(null), title, name);
    // A takeover the desk refuses (ED2: the r13d desk refuses them all, and a race can) is passed over for the next holding.
    // SEC-01 (root D391): the source is the leaver, and the desk's stake floor counts the shares it commits (it approves
    // the desk for them itself) of the vault shares it holds.
    const chosen = await chooseExitHolding(exitReads(c, g, vault, desk, market, source), need, now, EXIT_CONFIRM_SECONDS,
      (h) => takesOver(c, wallet, [], { to: source, data: encodeFunctionData({ abi: rehypoSourceAbi, functionName: "exitNow", args: [h.id] }), value: 0n }),
      { committed: asked.shares, held });
    if (chosen === null) throw new ApiError("NO_LOAN_TO_LIST", "None of the vault's loans can be listed for an exit now; try again in a few minutes", 409, true);
    [id, book, floorBps] = [chosen.id, chosen.book, chosen.floorBps];
  }
  const rows: Row[] = [
    { label: "Your share", value: f.money(claim, cash) },
    { label: "The source can pay now", value: f.money(s.payableNow, cash) },
    {
      label: "Sold for you",
      value: id !== 0n ? soldFor(id, name, need!, book, cash, floorBps)
        : lapsed ? "Through the source's exit listing already open, whose request had lapsed: this renews it" : "Through the source's exit listing already open",
    },
    // SEC-01: the source is the leaver, so the debit comes off its share of the sale's earnings claim, which its LPs
    // who stay own: they pay this LP's discount.
    { label: "You give up", value: giveUpText(null, cash, floorBps === null || id === 0n ? null : id, true) },
    { label: "Remove within", value: `${f.days(s.hold)} of asking: then gage's keeper ends the exit, and you ask again if you still need to` },
  ];
  const lost = await giveUp;
  const preview: Preview = {
    kind: "exit_now", asset: { token: cash.token, symbol: cash.symbol, decimals: cash.decimals, stable: cash.stable },
    receive: claim.toString(), now: s.payableNow.toString(), giveUp: lost === null ? null : lost.toString(),
    steps: [
      { at: 0, when: "now", what: "You ask" },
      { at: EXIT_FALL_SECONDS, when: `~${span(EXIT_FALL_SECONDS)}`, what: "Loan sold" },
      { at: s.hold, when: `before ${span(s.hold)}`, what: "You remove" },
      { at: s.hold, when: span(s.hold), what: "Exit ends" },
    ],
  };
  return {
    preview,
    view: view(id === 0n ? null : id, need, now + s.hold, lapsed, floorBps),
    summary: { title, rows },
    steps: [{ label: "Exit now", kind: "action", final: true, build: () => Promise.resolve({ to: source, data: encodeFunctionData({ abi: rehypoSourceAbi, functionName: "exitNow", args: [id] }), value: 0n }) }],
    notes: [
      "Once a buyer takes the loan, remove your liquidity on the pool's hook as usual: the source pays your share from what the sale paid, held for its LPs for an hour. After that hour, ask again.",
      "Removing takes the pool's other token too, from its own source: where that side cannot pay you either, exit now there as well.",
      "Exit now, like a withdrawal, avoids losses on loans that default after you leave; the LPs and holders who stay bear them.",
    ],
  };
}
