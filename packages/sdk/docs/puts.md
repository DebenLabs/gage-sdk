# Puts

Where a lend asset's generation names a put router, a put is a loan of that asset against USDG: your USDG margin and the
USDG the loan's payout buys are pledged together, `size` times the margin in all. It gains as the asset falls, and its
loss stops at the margin you put in, since the loan is never closed early because a price moves: there is no
liquidation, and if it is not repaid by the end of its term the lenders keep the pledge and nothing else is taken.

[examples/put.ts](../examples/put.ts) finds the asset, opens a put and closes it.

## Find the asset

```ts
const { lendAssets = [] } = await gage.capabilities();
const asset = lendAssets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
if (!asset || !("putRouter" in asset)) throw new Error(`gage offers no put on ${symbol} now`);
```

A lend asset offers puts when `capabilities().lendAssets` names its `putRouter` (and its `loopRouter`, through which a
put opens). `put_open` is served where at least one does (`gage.actions`); the put router's other actions wherever a
current generation names one.

## Open

```ts
const quote = await gage.putQuote({ lendAsset: asset.token, margin: parseUnits(marginUsdg, 6).toString(), size, term: term.seconds, wallet: signer.address });
const { action: _, ...put } = quote.prepare;
const opened = await gage.run({ action: "put_open", ...put }, signer);
```

- `margin` is the USDG you put in, raw (6 decimals): the most the put can lose. `size` is 1.1 to 10: the whole pledge
  over the margin (4 pledges the margin and three times it bought with the loan).
- The quote answers the pledge, the purchase, the loan and repayment in the asset, its cost (`costBps`, of the loan, for
  the term), the most the purchase may cost, and a `prepare` object. The loan is the least whose payout buys the purchase
  through the asset's cheapest pool with 25 bp of it spare, and its cost is priced on the whole pledge.
- `put_open` approves the margin and the purchase's most exactly, and is refused above `maxCostBps`, or beyond what the
  pledge supports (`SIZE_TOO_HIGH`, with `details.maxPrincipal`).

## Close, roll, roll by itself

```ts
const closed = await gage.run({ action: "put_close", loanId, engine, ...(minBack ? { minBack } : {}) }, signer);
```

- **`put_close`** repays a running put out of its own pledge through the put router: the pledge buys the repayment back
  and the rest comes back to you, in one transaction, never spending more than `maxSlippageBps` over the quote, nor
  returning less than `minBack`. A pledge that cannot buy the repayment back now cannot close it (`PLEDGE_SHORT`): repay
  it in the asset with `reclaim`, or leave it to end.
- **`put_roll`** rolls a put into a new loan of the same size on the same pledge; your USDG buys what the new payout
  leaves short.
- **`put_auto_roll`** leaves a put to roll by itself: gage's keeper rolls it in its last hours, at most `maxCost` each,
  buying each top-up with at most `maxSpend` of your USDG, up to four times. It leaves standing approvals to the put
  router. **`put_cancel_auto_roll`** ends it.

Every put action names the loan's core (`engine`): its lend asset's, `capabilities().lendAssets[].core`. A retired
generation's puts still close, and never roll (`PUT_CLOSED`). While a put router is paused, `PUT_PAUSED`: the loan can
still be repaid.
