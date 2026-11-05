# Earn

Only partner vaults lend on gage: a wallet or a contract lends by depositing into one, never by funding a loan itself.
A partner vault is run by its curator under a mandate (the tokens it lends against, its longest loan, its Loan grade
floor, its fee), and every loan it funds is a fixed-cost loan with no liquidation: never closed early
because a price moves, and if it is not repaid by the end of its term the vault keeps the collateral, and nothing else is
taken. **You may end up holding the collateral instead of USDG**: a vault that keeps a loan's collateral holds it for its
holders, who share it.

[examples/deposit.ts](../examples/deposit.ts) deposits; [examples/exit-now.ts](../examples/exit-now.ts) withdraws, exits
the rest now and collects.

## Choose a vault

`earnVaults()` lists the partner vaults: the tokens each lends against, its fee, longest loan, size, free cash, share
value, whether it funds loans now (`lends`) and its page on gage.cash. `vaultFreeCash({ vault })` says what it can pay
withdrawals from now, and what comes back to it as its loans end, if they are repaid.

```ts
const { vaults } = await gage.earnVaults();
// A vault that lends USDG names its figures in USDG; one that lends another asset names them in that asset.
const vault = vaults.find((v) => v.lends && "totalAssetsUSDG" in v);
```

## Deposit

```ts
return gage.run({ action: "earn_deposit", vault: vault.vault, amount: parseUnits(usdg, 6).toString() }, signer);
```

`earn_deposit` takes `amount` in the vault's own asset (USDG, or the lend asset of a lend asset's vault), approves exactly
that, and deposits for at least what it buys now less `maxSlippageBps` (50 when omitted). The vault's shares (18
decimals) come to the wallet. A vault refuses a deposit while it is paused or over its cap, among others (`PAUSED`,
`CAP_EXCEEDED`, `FUNDING_CLOSED`, …).

**A vault with a loan past its end comes first.** While a loan past its end is not booked, a vault takes no deposit or
withdrawal: the plan settles those loans first (anyone may, and gage's keeper does each pass), answers `again: true`, and
`run()` plans the deposit again once the settle is mined. Booking a loan past its end unpaid writes it off, which lowers
the share price, so the deposit's least shares are set once the settle is mined.

## Withdraw

`earn_redeem` withdraws `shares`, or everything the vault can pay the wallet now when omitted. A vault pays withdrawals
out of its free cash: what it has lent comes back as its loans repay or end.

```ts
const withdrawn = await gage.run({ action: "earn_redeem", vault }, signer);
```

## Exit now

A holder whose balance is more than the vault can pay now need not wait for loans to repay: where a release names the
chain's exit desk, `earn_exit_now` sells one of the vault's loans for them, as gage.cash's Exit now does. Preview it first:

```ts
const plan = await gage.prepare({ action: "earn_exit_now", wallet, vault });
return { holding, exit: holding.exit ?? null, summary: plan.summary, preview: plan.preview ?? null, next: plan.next?.label ?? null, notes: plan.notes };
```

- **What it does.** Your shares (`amount` of the vault's asset at today's share value, or all of them) are committed at
  the desk, and the desk lists one of the vault's loans: over ten minutes its price falls from book value plus 99% of what
  the loan has still to earn, no further than your own share of that loan can pay the buyer's discount, which you pay. A
  small share sets a high floor, so the listing may not sell. Your shares stay yours until a sale.
- **Then.** The first vault that buys the loan pays you at today's share value, in the sale's own transaction; the desk
  owes it to you until you collect it. A listing that ends unsold leaves the next one to list (`earn_exit_list`, which
  gage's keeper may also send). `earn_exit_cancel` withdraws the exit at any time before a sale. A request lasts 24 hours
  (`lapsesAt`).
- **What you give up.** You leave at book value: your share of what the vault's loans have still to earn, if they are
  repaid, less the buyer's discount on the loan sold for you. The plan's `preview` says about how much (`giveUp`), what
  you receive and the steps in time. Like a withdrawal, exit now avoids losses on loans that default after you leave;
  the holders who stay bear them.
- **Where it stands.** `portfolio(wallet)` gives each holding's open `exit`: its `stage` (`listed`, with `loanId` for sale
  until `listingEndsAt`; `next`; `closed` while exits are closed; `payable`, the vault can pay the rest now; `lapsed`), and
  `exitOwed`, what the desk owes the wallet.

```ts
const withdrawn = await gage.run({ action: "earn_redeem", vault }, signer);
const exited = await gage.run({ action: "earn_exit_now", vault }, signer);
const { earn } = await gage.portfolio(signer.address);
```

Collect what the sales paid with `earn_exit_collect` (or `collect`, with everything else):

```ts
const { exitOwed } = await gage.portfolio(signer.address);
if (!exitOwed?.some((x) => BigInt(x.amount) > 0n)) return null;
return gage.run({ action: "earn_exit_collect" }, signer);
```

Refusals: `NOTHING_TO_EXIT` when the wallet holds no shares or the vault can pay the amount now (withdraw it instead),
`EXCEEDS_BALANCE`, `TOO_SMALL`, `EXIT_OPEN` beside an exit already open, `EXITS_CLOSED`, `PAUSED`, and the retryable
`NO_SHORTFALL` and `NO_LOAN_TO_LIST`. The README's [Exit now](../README.md#exit-now) has every case.

### Previews

An action that pays out over time answers a `preview`: what the wallet receives, what of it can be paid now, about what
it gives up (`giveUp`, `null` while gage's index cannot say), and its steps in time, as raw amounts in `preview.asset`
and a few words. Draw it in your own design, or as gage's card: `renderPreview(plan.preview, { theme })` from
`gage-sdk/visual` returns one SVG that fetches and runs nothing.

## A rehypo pool's exit now

A rehypo pool's hook lends the part of each of its tokens the swaps do not need through a gage source, into a partner
vault. An LP whose share of one token is more than that token's source can pay now asks the source to leave now for it:
`rehypo_exit_now { source }`. The source commits its vault shares at the exit desk, which lists one of the vault's loans
as above; the buyer's discount comes out of the source's share, which belongs to the pool's LPs who stay, so they pay it,
not you. Once a buyer takes the loan, remove your liquidity on the pool's hook as usual, within the hour the source holds
what the sale paid. Refused with `NOTHING_TO_EXIT` when the source can pay your share now, and `NOT_A_REHYPO_SOURCE` for
an address that is not one. The README's [Rehypo pools](../README.md#rehypo-pools) has every case.

## Collect

`collect` gathers what is ready here for the wallet: vault earnings, collateral the vaults recovered from loans written
off, backing anyone added to such loans, the sGAGE of partner vaults, and what exit sales paid, at most twenty claims at a
time. A claim that would revert now is left out, and its note says so.

## Pool vaults, for a DEX

A DEX that lends its pool's tokens through gage keeps one partner vault per pool token, each on the generation that lends
that token, both named after the pool (`Fables NVDA/USDG`) and run by one curator. `createPoolVaults` answers the calls
that create them, simulated from the curator now, for one wallet batch, and the same as a Safe{Wallet} Transaction
Builder file (`safeBatch`); gage signs and proposes nothing. `poolVaults({ curator? })` reads a pool's vaults back. The
README's [Pool vaults](../README.md#pool-vaults) has the rules.
