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

`earnVaults()` lists the partner vaults: who manages each (`manager`), the tokens it lends against, its fee, longest loan, size, free cash, share
value, whether it funds loans now (`lends`) and its page on gage.cash. `vaultFreeCash({ vault })` says what it can pay
withdrawals from now, and what comes back to it as its loans end, if they are repaid.

Anyone can create a partner vault, and the list comes in address order: neither a vault's place in it nor its name says
who runs it or on what rules. Choose by its manager and its rules, then name that vault (`chosen`, its address).

```ts
const { vaults } = await gage.earnVaults();
const vault = vaults.find((v) => v.vault.toLowerCase() === chosen.toLowerCase());
// A vault that lends USDG names its figures in USDG; one that lends another asset names them in that asset.
if (!vault?.lends || !("totalAssetsUSDG" in vault)) throw new Error("That vault takes no USDG deposits now");
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
out of its free cash: what it has lent comes back as its loans repay or end. Where that free cash is what limits it, the
withdrawal stays a basis point under it, as a share's value grows while the transaction is on its way.

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
time. A claim that would revert now is left out, and its note says so. A written-off loan's collateral reaches its pocket
once the vault's `recover` is called, which gage's keeper does each pass and anyone may. A `status` of `partial` says part
of it did not answer: collect again shortly.

## With gage's index off

Leaving goes on while gage's index gives no answer. `earn_redeem`, the exits and `rehypo_exit_now` read the vault itself:
its factory and core, its name, its book and what it can pay this wallet. What the exit gives up reads null. A settlement
due is booked first from the records the factory's exit desk names; a generation with no desk, or one that does not name
them, refuses `SETTLEMENT_DUE` (`retryable`) until the index answers. A deposit, `park`, `unpark` and `vaultFreeCash` still
need the index.

`vaultOnChain({ vault, wallet })` reads one vault from the chain alone: its generation, book, whether a settlement is due,
its manager's settings, and what it can pay the wallet now, with the call that withdraws that and its gas.

```ts
const { holder, settlementDue } = await gage.vaultOnChain({ vault, wallet });
return { settlementDue, payableNow: holder?.payableNow ?? "0", call: holder?.withdraw ?? null };
```

## Your own vault

Where a generation's creation is open (mainnet's since 5 November 2026), anyone may create a partner vault: one asset,
tokens of one universe, a free name. [examples/create-vault.ts](../examples/create-vault.ts) creates and manages one.

```ts
const made = await gage.run({ action: "create_vault", name, term: 604_800, feeBps: 1_000, maxLoan: parseUnits(largestLoan, 6).toString() }, signer);
return { status: made.status, vault: made.vault ?? null, sent: made.sent.map((s) => s.hash) };
```

A vault lends USDG against every stock and commodity gage admits unless the input names otherwise: `asset`, `universe`
(`ecosystem` for meme and utility coins), `collateral`, `cashKeptFreeBps`, `priorityFeeBps`, `minRateGrade`, `buyLoans`,
and `buysOnly` for a vault that buys running loans alone. For a Safe, `createVault` answers the call and its Transaction
Builder file, and signs nothing:

```ts
const { calls, safeBatch, collateral, notes } = await gage.createVault({ curator: safe, name, term: 604_800, feeBps: 1_000, maxLoan: "1500000000" });
```

The creator manages it for good, with `vault_manage`, each field one transaction, read from the chain alone. The name,
pause, automatic funding, priority fee ceiling and fee recipient apply at once. Among the limits, buying and tokens, a
change that tightens the vault applies at once, and one that loosens it waits three hours, then `apply` makes it so. What
it has already is left out, so it can be prepared again until `status` is `done`.

```ts
const { settings, waiting } = await gage.vaultOnChain({ vault });
```

The fields: `name`, `paused`, `fillersOpen`, `priorityFeeBps`, `feeRecipient`, the limits (`maxLoan`, `maxPerTokenBps`,
`cashKeptFreeBps`, `minRateGrade`, `stockBps`, `memeBps`, `ecosystemBps`, `commodityBps`), `buyLoans`, `addTokens`,
`removeTokens`, `applyTokens`, `dropTokens`, `apply`, `drop`, `listLoan` and `cancelListing`. A manager cannot withdraw
depositors' assets. Two calls move money all the same, and the plan says how much of it: a new `feeRecipient` takes the fees
not yet claimed too, and a running loan listed for sale can sell for as little as book value plus half of what it has still
to earn, which depositors bear. The README's [Your own vault](../README.md#your-own-vault) has the rules.

## Pool vaults, for a DEX

A DEX that lends its pool's tokens through gage keeps one partner vault per pool token, each on the generation that lends
that token, both named after the pool (`Fables NVDA/USDG`) and run by one curator. `createPoolVaults` answers the calls
that create them, simulated from the curator now, for one wallet batch, and the same as a Safe{Wallet} Transaction
Builder file (`safeBatch`); gage signs and proposes nothing. `poolVaults({ curator? })` reads a pool's vaults back. The
README's [Pool vaults](../README.md#pool-vaults) has the rules.
