# Changelog

## 0.6.0

- **Mainnet is the default.** `createGage()` is Robinhood Chain (4663) with gage.cash's own services, and
  `privateKeySigner(key)` signs for it. The testnet is `createGage({ network: "testnet" })` and
  `privateKeySigner(key, { network: "testnet" })`; a manifest given without a network still decides it. Breaking:
  code that relied on the testnet default must name it.
- **`gageTools` serves a signer's tools on mainnet with or without a spend limit.** Whether an agent signs under limits
  is its wallet owner's choice. `SIGNING_CLOSED` and `signingToolsOpen` are gone.
- **The rules say what is left out.** `capabilities().rules` adds that private loans are never served
  (`PRIVATE_RULE`), and the lend-asset rule no longer names 1-day loans, which mainnet does not offer; each core's
  terms are in `terms` and `lendAssets`.

## 0.5.1

- **A loan the private lane opened stays private, whatever gage's index says.** The chain must show that no
  private-lane router of the loan's core opened it (`opened`), read in one call per core at one block: `loan()` and
  every action on a loan answer `NOT_FOUND`, and `portfolio()` and `collect` leave it and its vault pockets out. The
  release's routers are bundled (`privateRouters`). A read that fails fails the call (`UNAVAILABLE`, retryable),
  never an empty portfolio.
- **Open source** at [github.com/DebenLabs/gage-sdk](https://github.com/DebenLabs/gage-sdk), from where npm's copy is
  published with provenance. `repository` and `bugs` in package.json; Uniswap's MIT notice for the tick and price
  arithmetic it follows (`v4math`).

## 0.5.0

- **A service's refusal comes only by a code gage-sdk knows, in its own words.** The rates service's refusals pass by
  the codes the README lists; any other is `RATES_REFUSED` (or `UNSIGNED`), and a partner vault's refusal gage-sdk does
  not know is `VAULT_REFUSED`. A cash-out sale's `source` is kept only as a short name.
- **KyberSwap's loop route is ranked by its own spend, flash fee and output**, never the cost its answer claims; a route
  whose most is not its spend and fee, or whose output is claimed more than 1% over its least, is no source.
- **Every loop source keeps the loan's spare** (`loopSpendable`), not only the cheapest: a route that breaks it no
  longer refuses a pool that keeps it, and no fallback is held to the whole payout.
- **An upstream's answer is read up to 4 MB and 25 seconds, body included**, in bytes, cancelled past either.
- **A transaction another took the nonce of** (a cancellation or replacement) is `TX_FAILED`, never succeeded; one that
  only repriced it still is. `Sent` carries its block's time (`at`).
- **Rollover.** `roll` rolls a running loan into a new loan of the same size on the same pledge; `auto_roll` leaves it
  to gage's keeper to roll in its last hours, up to four times at a cost ceiling (`maxCost`), with standing approvals
  its plan names; `cancel_auto_roll` ends that. Without `maxCost` the ceiling is twice what a roll of the loan costs
  now, quoted as a roll is, and refused when no roll can be quoted; a listing not funded yet, which no roll can be
  quoted for, starts at twice its own fixed cost and fee. The default is held to four times the loan's own cost, read
  from the chain (`ROLL_COST_HIGH` above it: name `maxCost`), and a `maxCost` named to the loan's principal
  (`MAX_COST_TOO_HIGH`).
- **Rating.** On mainnet, `feedback` rates gage, agent #8845 in ERC-8004: the wallet's own score from 0 to 100, once a
  wallet, and nothing else (`NO_ENTRY`, `OWN_ENTRY`, `ALREADY_RATED`). The `notes` of an action's last step, and of a
  `done` run, say a rating is open; a step that comes first never does.
- **Cash-out.** `cash_out` sells a running loan's whole collateral through an aggregator, repays the loan from the sale
  and pays the rest to the wallet, in one transaction. The net never falls more than `maxSlippageBps` below the quote, nor under an
  optional `minNet`; a sale paying more than 1% less than gage's own route for the collateral is refused
  (`SALE_BELOW_ROUTE`), and one under `minNet` (`BELOW_MIN_NET`).
- **A send whose outcome is unknown.** When the signer fails after the wallet's nonce moved, `run()` stops with
  `SEND_UNKNOWN` (not retryable) instead of `SEND_FAILED`: the step may have gone out, and sending it again could list,
  loop or deposit twice. `SEND_FAILED` now means nothing went out. A `Chain` names the wallet's `nonce` and
  `cashoutRouteNet`.
- **An instant answer outside the pledge asked about** (more than `maxCollateral` or `own`, or nothing) is refused
  (`RATES_UNAVAILABLE`) rather than quoted, prepared or looped as the wallet's pledge.
- **Exact quotes.** `borrowQuote({ token, term, collateral, principal })` prices one chosen loan as gage.cash prices
  it, and says whether the vaults fund it now (`fundsNow`), would make it wait (`waitsFor`), and the largest they take.
- **The loan a borrow opens.** `run()` answers with `loan` (a borrow's listing, a loop's or a roll's new loan), and
  `waitForFill()` waits for a listing to be funded.
- **Earn.** A deposit or withdrawal from a vault due a settlement settles first, then is planned again. `prepare()`
  answers `again: true` while those steps come first, and the withdrawal's `view.assets` is what its shares are worth
  before the settlement, never 0.
- **Collect.** A claim that would revert now (a bridged sGAGE claim whose source awaits an unlock) is left out and said
  in `notes`, so the steps after it still go out. Its words say what stays gage.cash's to collect. It calls only vaults
  the chain bears out as partner vaults of gage's cores (`isVault`, `vaultCore`), cancels a listing and takes collateral
  back only as the core has the loan, plans at most twenty claims at a time (more are said in `notes`) and no claim of
  sGAGE under a millionth. An indexer page is read for no more rows than it asked for.
- **Loans.** `loan()` lists every action open on the loan now (repay, cash out, roll, roll by itself, end that,
  collect), saying which are done on gage.cash where the Gage does not serve them; it returns the standing instruction
  to roll as the router keeps it (`autoRoll`) and what closed a repaid loan whose collateral does not come back
  (`closedBy`: `roll` or `cash_out`), and offers no collect once the collateral is taken. `portfolio()` gives each
  loan's sGAGE to claim, raw (`sgageClaimable`), and whether it rolls by itself (`autoRoll`).
- **Links.** `link`: a token's Borrow page on gage.cash on `assets()` rows, by ticker, and a partner vault's page on
  `earnVaults()` and `portfolio().earn` rows, on the network's own app; `null` without one.
- **Limits.** `assets()` gives `maxPerLoan: null` where a token has no per-loan cap, as on the Intent core.
- **Refusals.** A pledge under the minimum is refused with the minimum, rounded up and raw (`details.minimum`); the
  rates service's reasons for offering no loan are their own codes; refusals carry `details` where the SDK computed one.
- **Terms.** On mainnet `capabilities()` and the planner offer the 7 and 21 days gage.cash offers.
- **Safety.** Leverage's and cash-out's aggregator calls are decoded before they are used (`aggregatorCallOk`).
- **Scope.** `createGage({ actions })` and `gageFrom(ctx, { actions })` serve fewer actions (`ACTION_NOT_SERVED`), and
  every Gage serves only what its deployment carries out (`actionsOn(deployment)`): no `roll`, `auto_roll` or
  `cancel_auto_roll` without a rollover router, as on the testnet, and no `cash_out` without a cash-out router.
- **Packaging.** viem is a peer dependency (`^2.56.3`); the homepage is the public docs.

## 0.4.0

- Spend limits for a signer's actions (`limit`), and leverage's headroom: a multiple only while the purchase keeps 25 bp
  of the loan spare.

## 0.3.0

- Robinhood Chain mainnet (`network: "mainnet"`).
