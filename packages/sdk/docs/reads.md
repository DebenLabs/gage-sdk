# Reads

Reads sign nothing and need no key. Each answers plain JSON with raw amounts as decimal strings.
[examples/reads.ts](../examples/reads.ts) runs the market, wallet and loan reads below; [examples/quote.ts](../examples/quote.ts)
a quote.

## The market

```ts
const [caps, { assets }, { vaults }] = await Promise.all([gage.capabilities(), gage.assets(), gage.earnVaults()]);
const lending = vaults.filter((v) => v.lends);
return {
network: caps.network,
terms: caps.terms.map((t) => `${t.days} days`),
originationFeeBps: caps.originationFeeBps,
newLoansPaused: caps.newLoansPaused,
// USDG first, then each lend asset a generation lends (a stock token or a stablecoin), each with its own terms.
lends: ["USDG", ...(caps.lendAssets ?? []).map((a) => a.symbol)],
collateral: assets.map((a) => a.symbol),
vaults: lending.map((v) => v.name),
```

- **`capabilities()`**: the network and chain, gage's contracts (USDG, the core new loans are listed on, the partner
  vault factory, the loop router), the terms offered, the origination fee, whether new loans are paused
  (`newLoansPaused`), the actions served, the rules in words, and gage.cash's address (`app`). Where gage lends more
  than USDG, `lendAssets`: each asset's token, symbol, decimals, whether it is a stablecoin (`stable`), its core,
  factory and terms, and its loop and put routers where it names them. Where the LP lane is public, `lpLane`; where
  park is served, `parkPools`.
- **`assets()`**: the tokens taken as collateral now, each with its minimum (`minAmount`, raw), its most per loan where
  a registry sets one (`maxPerLoan`, else `null`), whether leverage buys it, its Borrow page on gage.cash (`link`), and,
  once gage lends more than USDG, the asset it is borrowed in (`asset`). A token two generations take has a row for each.
- **`earnVaults()`**: the partner vaults: name, the tokens they lend against (`tokens`), performance fee, longest loan
  (`longestLoanDays`), size, free cash, share value, whether they fund loans now (`lends`) and their page on gage.cash
  (`link`). A USDG vault names its figures in USDG (`totalAssetsUSDG`, `freeCashUSDG`, `usdgPerShare`); another asset's
  vault names them in that asset (`totalAssets`, `freeCash`, `assetsPerShare`), and, once gage lends more than USDG,
  every row names its `asset`.
- **`vaultFreeCash({ vault })`**: what one vault pays withdrawals from now (`freeCashUSDG`, or `freeCash` in a lend
  asset's vault), what comes back to it as its loans end, one entry a day (`schedule`), what loans past their end bring
  back once settled (`settlingUSDG`), only if their borrowers repay, and the share of the vault a new loan must leave free
  (`bufferBps`).
- **`lpVaults()`**, **`poolVaults()`**: the LP lane's vaults ([LP lane](lp-lane.md)) and the pools among the partner
  vaults ([Earn](earn.md#pool-vaults-for-a-dex)).

## Fixed costs

A quote is a read: nothing is signed or reserved.

- **`borrowQuote({ token, term, maxCollateral })`**: the largest loan the partner vaults fund now for at most
  `maxCollateral`, pledging only what it needs, at the lowest fixed cost they accept. **`borrowQuote({ token, term,
  collateral, principal, costBps? })`**: one exact loan, with whether the vaults fund it now, what each Loan grade costs
  and the least they take. [Borrowing](borrowing.md) has both.
- **`leverageQuote({ token, own, multiple, term })`**: a loop's amounts, cost and the most its purchase costs.
- **`putQuote({ lendAsset, margin, size, term })`**: a put's margin, purchase, pledge, loan and cost ([Puts](puts.md)).
- **`lpQuote({ adapter, tokenId, wallet, term })`**: a loan against one liquidity position ([LP lane](lp-lane.md)).

Each quote answers a `summary` in words, the figures, and a `prepare` object: pass it to `run` or `prepare` without its
`action` key, as the action it names. The cost is a fixed amount for the term, shown with its share of the loan
(`costBps`): 0.5% for 7 days is `costBps: 50`.

## A wallet

```ts
const [portfolio, balances] = await Promise.all([gage.portfolio(address), gage.balances(address)]);
```

- **`portfolio(wallet)`**: the wallet's loans as borrower, open, running and closed (each with its core `engine`, id,
  state, amounts, end `endsAt`, the sGAGE it has earned and not claimed `sgageClaimable`, and whether it rolls by itself
  `autoRoll`), its Earn holdings (shares, value, what can be withdrawn now, claims ready, sGAGE, and where a release names
  the chain's exit desk, its open exit `exit`), its USDG credit (`usdgCredit`) and each lend asset's apart (`credits`),
  what exit sales paid it (`exitOwed`), and where the LP lane is public, `lp`. A core or vault that could not be read
  just now is named in `unread`: those parts are missing, not empty; read again shortly.
- **`balances(wallet)`**: ETH for gas, USDG, the lend assets and the collateral tokens the wallet holds.
- **`lpPositions(wallet)`**, **`lpLoans(wallet)`**: its liquidity positions the LP lane lends against, and its LP loans.
- **`parkPositions(wallet, also?)`**: its out-of-range positions in the pools park serves ([Park and unpark](park.md)).

## A loan

```ts
const loan = await gage.loan(engine === undefined ? { loanId } : { loanId, engine });
return { state: loan.state, actions: loan.actions, autoRoll: loan.autoRoll, closedBy: loan.closedBy };
```

**`loan({ loanId, engine? })`** reads one loan from its core (the current USDG core when `engine` is omitted: name the
core for a loan in a lend asset, or on an earlier core). It answers its state (`FUNDING` while listed, `ACTIVE` while it
runs, then `REPAID`, `DEFAULTED` or `CANCELLED`), its
amounts and deadlines, and:

- `actions`: what can be done with it now and by whom, each as the planner would take it, such as
  `reclaim (borrower, before endsAt)`; an action done on gage.cash rather than here reads `… on gage.cash (…)`.
- `autoRoll`: its standing instruction to roll by itself, as the rollover router keeps it (`rollsLeft`, `until`,
  `maxCost`, …), or `null`; on a core with a put router, also `putAutoRoll`.
- `closedBy`: what closed a repaid loan whose collateral does not come back, `roll` or `cash_out`, or `null`.
- `note`: on a generation the release has retired, which nothing rolls any more, why: repay such a loan before it ends.

`waitForFill({ loanId, engine? })` waits for a listing to be funded ([Borrowing](borrowing.md#wait-for-funding)).
