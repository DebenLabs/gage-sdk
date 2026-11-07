# Borrowing

A loan pledges a token and pays out USDG (or a lend asset), with a fixed amount to repay within a fixed term. There is
no liquidation: the loan is never closed early because a price moves, and if it is not repaid by the end of its term the
lenders keep the collateral and nothing else is taken. Only partner vaults lend: a borrow lists the loan, gage's keeper
funds it from the vaults on its next pass, and the payout waits for the wallet to collect it. A token gage does not
accept yet: [List a token](https://github.com/DebenLabs/gage-contracts/issues/new?template=token-listing.yml).

[examples/borrow.ts](../examples/borrow.ts) runs the one-click borrow, the exact quote, a loop and the refusal below;
[examples/loan.ts](../examples/loan.ts) repays, rolls, leaves to roll by itself and cashes out.

## The lowest fixed cost, in one click

Name the token, the most of it to pledge and the term. The quote is the largest loan the partner vaults fund whole now,
pledging only what it needs, at the lowest fixed cost the vaults funding it accept:

```ts
const [asset, term] = await Promise.all([collateralOf(gage, symbol), termOf(gage, days)]);
const quote = await gage.borrowQuote({ token: asset.token, maxCollateral: parseUnits(amount, asset.decimals).toString(), term, wallet: signer.address });
const { action: _, ...terms } = quote.prepare;
// Lists the loan: an exact approval of the pledge first, each step simulated before it is sent.
const listed = await gage.run({ action: "borrow", ...terms }, signer);
```

How the cost is found:

- Each partner vault takes loans down to its own Loan grade's share of the rates model's cost of the loan: A 100%, B 90%,
  C 75%, D 50%. The quote keeps the loan's size and lowers its cost as far as the vaults funding it still take all of it,
  checked with gage's funding preview, and never under grade D.
- A listing waits for the keeper's next pass, and a vault's floor rises as the pledge's worth falls, so the cost must
  also hold for a pledge worth less by a cushion: 2% for a meme, 0.5% for a stock or ETH.
- The quote names the model's cost of the loan (`modelCostBps`) and the loan's `grade`. Where the preview cannot be asked,
  the cost is the model's.
- `summary` says the loan in words: "Pledge 1.5 NVDA, receive 498.50 USDG, repay 502.75 USDG within 7 days". The cost is a
  fixed amount for the term; `costBps` is its share of the loan (50 is 0.5% for the term), never an annual figure.

A pledge under the token's minimum is refused with the minimum (`COLLATERAL_BELOW_MINIMUM`, the least raw pledge in
`details.minimum.raw`), so ask again for it:

```ts
const minimum = (error.details?.minimum as { raw?: string } | undefined)?.raw;
if (minimum === undefined) throw error;
return gage.borrowQuote({ ...input, maxCollateral: minimum });
```

## Advanced: the borrower's own terms

An app that lets its users choose the loan to value and the cost uses the exact quote: `collateral` and `principal`,
with `costBps` for a cost of the borrower's own, to a tenth of a basis point.

```ts
const quote = await gage.borrowQuote(input);
if (!("fundsNow" in quote)) throw new Error("An exact quote names collateral and principal");
```

It answers whether the vaults fund it now (`fundsNow`) or it would wait for their cash (`waitsFor`), what each Loan grade
A to D costs for this loan and how many vaults would take it at that cost now (`grades`), the lowest cost their settings
take it at (`lowestAcceptedCostBps`) and the largest loan they take at this cost (`largestAccepted`). An amount the pledge
cannot support is refused with the most it can (`PRINCIPAL_TOO_HIGH`, `details.maxPrincipal`), and a borrow no vault's
settings take at its exact terms is refused before anything is sent (`TERMS_NOT_ACCEPTED`, with `details.lowestCostBps`
and `details.largestPrincipal`). Terms a vault takes, but without the cash or room for them now, still list, and wait.

Offer these controls or leave them out: the one-click quote needs none of them.

## Terms, and 1-day loans

`termOf` picks a term `capabilities()` offers, and refuses one it does not:

```ts
const { terms } = await gage.capabilities();
const term = terms.find((t) => t.days === days);
```

On mainnet gage-sdk offers 7 and 21 days. Where a network's `capabilities().terms` lists a 1-day term (86,400 seconds),
a 1-day loan is offered on a token whose rates offer it (NVDA) while the generation's 1-day settlement is switched on,
gage's keeper settles it at its end, and a new one opens only while the market stays open through its day, or, on a
token priced by Kaskad's Nuntius, while that price is fresh (`ONE_DAY_CLOSED` otherwise). A term no core here offers is refused (`TERM_NOT_ALLOWED`). A lend asset's core
has its own terms, in `capabilities().lendAssets[].terms`.

## In a lend asset

`borrowQuote` and `borrow` take `lendAsset`, the token of an asset gage lends besides USDG: the loan is paid out and
repaid in that asset, so in dollars what you repay moves with its price. A row of `assets()` names the asset it is
borrowed in. [Lend generations](lend-generations.md) has more.

## Wait for funding

```ts
// gage's keeper funds a listing from the partner vaults on its next pass; the payout waits on the core until collected.
const funded = await gage.waitForFill({ loanId: listed.loan.loanId, engine: listed.loan.engine });
const collected = funded.status === "funded" ? await gage.run({ action: "collect" }, signer) : null;
```

`run` answers the listing it opened in `loan` (`{ engine, loanId }`). `waitForFill` looks every 10 seconds for 5 minutes
by default (`{ timeoutSeconds, pollSeconds }`) and answers `funded` (with `fundedAt`, `endsAt` and `receive`), `waiting`
(still open to the vaults until `fundingDeadline`, null while gage's index has not shown it), `expired`, `cancelled` or `closed`. An expired or cancelled listing's
collateral comes back with `collect`. `cancel` takes back a listing still waiting.

## Repay, roll over, roll by itself, cash out

Ask the loan what it can do first: `loan().actions` lists each action open now and who may take it.

```ts
const loan = await gage.loan(at);
if (!offers(loan.actions, step.action)) throw new Error(`Loan ${loanId} offers no ${step.action} here now: ${loan.actions.join("; ") || "nothing"}`);
// The loan's own core, so a loan in a lend asset is acted on where it lives.
const result = await gage.run({ ...step, loanId, engine: loan.engine }, signer);
```

- **`reclaim`** repays a running loan in full before its term ends and takes the collateral back. It approves the
  repayment exactly. Repaying is never limited by a spend limit. It goes on while gage's index gives no answer, once the
  chain proves the loan public ([Private loans](getting-started.md#private-loans)); the other moves wait for the index.
- **`roll`** rolls a running loan into a new loan of the same size on the same pledge, in one transaction: you add the old
  loan's fixed cost and the new fee, or keep what is over. `term` names a new term (the loan's own when omitted). The
  roll's price is signed for 30 seconds; one that costs more when it is sent than when it was planned is refused
  (`PRICE_MOVED`): prepare again. Rolled before its last day, the loan is repaid early and the new term starts then.
- **`auto_roll`** leaves a listing or a running loan to roll by itself: gage's keeper rolls it in its last hours into a
  loan of the same size and term, at most `maxCost` each (its fixed cost and fee together, never more than the loan's
  principal), up to four times. Without `maxCost`, twice what a roll of it costs now, held to four times the loan's own
  cost and fee. It leaves standing approvals, as `put_auto_roll` does for a put: gage's rollover router may move the wallet's loans
  on that core and spend the repayments of four rolls, and of the rolls the wallet's other loans rolling by themselves
  there still need, until you withdraw them in your wallet. A `roll` keeps those in its approval too.
  **`cancel_auto_roll`** ends the instruction.
- **`cash_out`** sells a running loan's whole collateral through an aggregator, repays the loan from the sale and pays you
  the rest less gage's 0.5% fee, in one transaction. The sale is quoted again when it is sent, and refused if it pays less
  than planned (`PRICE_MOVED`), under the `minNet` you name (`BELOW_MIN_NET`), or more than 1% under gage's own route
  for the collateral (`SALE_BELOW_ROUTE`); the net never falls more than `maxSlippageBps` below the quote.

Rolling is offered where the loan's generation names a rollover router (and by itself where the release names gage's
keeper), cashing out where its core has a cash-out router. A generation the release has retired rolls nothing: there
`roll` and `auto_roll` are refused (`ROLLOVER_CLOSED`) and the loan's `note` says to repay it before it ends, while
`cancel_auto_roll` still ends an instruction left on it.

## Leverage

A loop pledges your tokens with more of the same token, bought with the loan in the same transaction (USDG only):

```ts
const quote = await gage.leverageQuote({ token, own, multiple, term, wallet: signer.address });
const { action: _, ...terms } = quote.prepare;
const looped = await gage.run({ action: "leverage", ...terms }, signer);
```

`multiple` is 1.1 to 3 (2 holds twice your pledge). The purchase goes through the cheapest source that runs: the
deployment's Uniswap v4 and V3 pools pairing the token with USDG, and an aggregator's route from gage's valuation
service. The wallet approves the most the purchase may cost (`maxPurchaseCostUSDG`), and a loop is refused above its
quoted cost (`maxCostBps`, `PRICE_ABOVE_LIMIT`) or at a multiple the loan cannot buy with room to spare
(`MULTIPLE_TOO_HIGH`).

## Collect

`collect` gathers what is ready for the wallet: a loan's payout, collateral back, vault earnings, the sGAGE of loans and
partner vaults, and what exit sales paid. A claim that would revert now is left out and its note says so.
