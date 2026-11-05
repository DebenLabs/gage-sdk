# gage-sdk

Read [gage](https://gage.cash), prepare unsigned transactions, and carry actions out with your own signer. gage makes
fixed-cost loans with no liquidation: a loan is never closed early because a price moves, and if it is not repaid by
the end of its term the lenders keep the collateral and nothing else is taken.

It runs on Robinhood Chain (4663, the default) and its testnet (46630, `network: "testnet"`). gage never holds a key,
and loans the private lane may have opened are never served: gage's index must mark a loan public, and the chain must
show that no private-lane router opened it. It is the engine of gage's hosted MCP server and of
[`gage-mcp`](https://www.npmjs.com/package/gage-mcp), the local one.

```bash
npm install gage-sdk viem
```

viem 2 is a peer dependency, so your app and the SDK share one copy. Node 22 or later, or any bundler: the SDK has no
Node-only imports.

```ts
import { createGage, privateKeySigner } from "gage-sdk";

const gage = createGage(); // Robinhood Chain; createGage({ network: "testnet" }) for its testnet

// The largest loan the partner vaults fund now for at most 1 SPY, for 7 days, at the lowest fixed cost they accept.
const quote = await gage.borrowQuote({ token: SPY, maxCollateral: "1000000000000000000", term: 604800 });
// Or one exact loan: 500 USDG on 1 SPY, at the lowest cost that funds it now (add costBps for a cost of your own).
const exact = await gage.borrowQuote({ token: SPY, collateral: "1000000000000000000", principal: "500000000", term: 604800 });

// With your own key: every step signed, exact approvals first, each simulated before it is sent.
const signer = privateKeySigner(key); // for Robinhood Chain; { network: "testnet" } for its testnet
const { action: _, ...terms } = exact.prepare;
const listed = await gage.run({ action: "borrow", ...terms }, signer);
const funded = await gage.waitForFill({ loanId: listed.loan!.loanId });
if (funded.status === "funded") await gage.run({ action: "collect" }, signer); // the USDG to the wallet
```

Amounts are raw integers as decimal strings (USDG has 6 decimals, a lend asset its own, vault shares 18, tokens their
own). Times are Unix seconds. Every default is the network's own: its public RPC, gage's indexer, rates and valuation
services, and the deployment bundled with the SDK. `createGage({ rpcUrl, indexerUrl, ratesUrl, valuationUrl, manifest })`
points elsewhere; a generation whose release names its own index (`intentV1IndexerUrl`, a lend asset's `indexerUrl`) is
read there whatever `indexerUrl` says, as the app reads it. `createGage({ apiKey })` sends a Rates API key to gage's rates service, and only there: without one,
everything here works as it does, under the rates service's ceiling a minute for callers without a key (`RATE_LIMITED`);
with one, a ceiling of its own and the model's whole quote. Ask for a key with the
[Integrate with gage](https://github.com/DebenLabs/gage-contracts/issues/new?template=integration.yml) form: partners get one free at first, sent privately, never in an issue. A token gage
should accept: [List a token](https://github.com/DebenLabs/gage-contracts/issues/new?template=token-listing.yml).

## Guides

Each integration path, with an example that runs ([`examples/`](examples), tested against gage's own fakes), in
[`docs/`](docs/README.md):

- [Getting started](docs/getting-started.md): install, networks, reading without a key, signing with your own.
- [Reads](docs/reads.md): markets, fixed costs, loans, a wallet's portfolio.
- [Borrowing](docs/borrowing.md): the lowest fixed cost in one click, exact terms and Loan grades, 1-day loans, waiting
  for funding, repay, roll over, roll by itself, cash out, leverage.
- [Earn](docs/earn.md): partner vaults, deposits and withdrawals, exit now, a rehypo pool's exit now, pool vaults.
- [Puts](docs/puts.md), [LP lane](docs/lp-lane.md), [Lend generations](docs/lend-generations.md) (stablecoin markets
  found through the GenerationDeployer), [Park and unpark](docs/park.md).
- [Signing](docs/signing.md): `run()` with your signer, signing each step yourself, spend limits.
- [Agents](docs/agents.md): tools for agent frameworks, gage-mcp over stdio and its wallet, gage's hosted agent and its
  review links.
- [Reference](docs/reference.md): every method, action and tool with its inputs, generated from the SDK itself.

The sections below are the long form of each rule.

## Reads

| Method | Answers |
|---|---|
| `capabilities()` | chain, contracts, the terms offered, origination fee, pause, the actions served, the rules |
| `assets()` | tokens taken as collateral now: each one's minimum, its most per loan where its registry sets one (`maxPerLoan`, `null` where there is none), whether leverage buys it, and its Borrow page on gage.cash (`link`, `null` without one) |
| `borrowQuote({ token, term, maxCollateral, wallet?, lendAsset? })` | the largest loan the partner vaults fund now for at most `maxCollateral`, at the lowest fixed cost they accept |
| `borrowQuote({ token, term, collateral, principal, costBps?, wallet?, lendAsset? })` | one exact loan: its repayment, cost and fee, whether the vaults fund it now (`fundsNow`) or it would wait (`waitsFor`), the lowest cost (`lowestAcceptedCostBps`) and the largest loan (`largestAccepted`) their settings take, and what each Loan grade costs (`grades`) |
| `leverageQuote({ token, own, multiple, term, wallet? })` | a loop's amounts, cost and the most its purchase costs |
| `putQuote({ lendAsset, margin, size, term, wallet? })` | where a lend asset offers puts: a put's margin, purchase and pledge in USDG, its loan, repayment and the most its purchase costs in the asset, and a `prepare` object for `put_open` |
| `loan({ loanId, engine? })` | one loan's state, amounts and deadlines; what can be done with it now (`actions`: here, or on gage.cash for an action this Gage does not serve); its standing instruction to roll by itself as the router keeps it (`autoRoll`, `null` without one; on a core with a put router, also `putAutoRoll`); and what closed a repaid loan whose collateral does not come back (`closedBy`: `roll` or `cash_out`). On a generation the release has retired, which nothing rolls any more, both instructions read `null`, no roll is listed, and an open loan's `note` says so |
| `portfolio(wallet)` | the wallet's loans (each one's sGAGE earned and not yet claimed, raw: `sgageClaimable`, which a bridged loan may pay in parts as its source unlocks; whether it rolls by itself: `autoRoll`, never on a retired generation, where an open loan's `note` says why), Earn holdings (each vault's `link`) and credits; where the LP lane is open, `lp`: its loans, credits, LP vault shares and the bonuses to claim; where a release names the chain's exit desk, each Earn holding's open exit (`exit`, see "Exit now") and what exit sales paid the wallet (`exitOwed`) |
| `earnVaults()` | the partner vaults: tokens, fee, size, free cash, share value, and each one's page on gage.cash (`link`, `null` without one) |
| `vaultFreeCash({ vault })` | one partner vault's free cash: what withdrawals are paid from now (`freeCashUSDG`; `freeCash` in a lend asset's vault), what comes back as its loans end, one entry a day (`schedule`, `by` in Unix seconds), and what loans past their end bring back once settled (`settlingUSDG`), only if their borrowers repay (a loan not repaid brings back its collateral, for the vault's holders, not cash); `bufferBps`, the share of the vault a new loan must leave free ("Cash kept free"); `schedule` and `settlingUSDG` are `null` from an index that does not serve them yet |
| `balances(wallet)` | ETH for gas, USDG, lend assets and collateral tokens |
| `lpPositions(wallet)` | where the LP lane is open: the wallet's Uniswap v3 and v4, SushiSwap v3 and Ramses positions in a pool it lends against, newest first, each with its range, liquidity, amounts and worth in USDG at the pool's price now, and whether the lane takes it now (`borrowable`, else `refusal`); Uniswap v4 positions are found through gage's index and checked on chain, and the `note` says when some may be missing |
| `lpQuote({ adapter, tokenId, wallet, term, vault? })` | a fixed-cost USDG loan against one position, signed for the wallet for five minutes at most: what is pledged, received and repaid, its cost and loan-to-value, and a `prepare` object for `lp_borrow` |
| `lpLoans(wallet)` | the wallet's LP loans, newest first: state, amounts, end, the position now and what can be done with it now; and what the lane's core credits the wallet |
| `lpVaults()` | the LP vaults: size, free cash, loans out, share value, fee, and whether each takes deposits and pays out now |
| `poolVaults({ curator? })` | the pools among the partner vaults, a curator's alone where one is named: each one's name, curator and two sides, each side its vault and page on gage.cash, or none (see Pool vaults) |
| `createPoolVaults({ curator, name, pool, term, feeBps, sides, ... })` | a DEX pool's vaults, ready to create: one call per pool token gage lends, each simulated from the curator now, for one wallet batch, and the same as a Safe's Transaction Builder file (see Pool vaults) |
| `parkPositions(wallet, also?)` | where a pool is served for parking: the wallet's out-of-range liquidity positions in it, each with its range, the one token it holds now (`holds`) and the partner vaults that take that token (`vaults`), or why none can (`refusal`); `also` names Uniswap v4 or Fables positions to read by their manager and id |
| `parkCalls(input)`, `unparkCalls(input)` | a park or an unpark as one ordered batch of calls for the wallet (`calls`: `to`, `data`, `value`), simulated whole first, for `wallet_sendCalls` (EIP-5792) or to send one by one |
| `waitForFill({ loanId, engine? }, { timeoutSeconds?, pollSeconds? })` | waits for a listing to be funded: `funded`, `waiting`, `expired`, `cancelled` or `closed` |

Both borrow quotes carry a `prepare` object to pass to `borrow` without its `action`, as the leverage, put and LP quotes
do for `leverage`, `put_open` and `lp_borrow`. A pledge under the token's minimum is refused with the minimum
(`COLLATERAL_BELOW_MINIMUM`, the least amount in `details.minimum`), and an exact amount the pledge cannot support with
the most it can (`PRINCIPAL_TOO_HIGH`, `details.maxPrincipal`).

**The best fixed cost, in one click.** Each partner vault takes loans down to its own Loan grade's share of the rates
model's cost (A 100%, B 90%, C 75%, D 50%). A quote whose loan the vaults fund whole now takes the lowest cost the vaults
funding it accept, checked with gage's funding preview: the loan keeps its size, its cost falls as far as they still
take all of it, and never under grade D. A listing waits for gage's keeper, and a vault's floor rises as the pledge's
worth falls, so the cost also holds for a pledge worth less by a cushion: 2% for a meme, 0.5% for a stock or ETH. Each
quote names the model's cost of the loan (`modelCostBps`) and its Loan `grade`. Where the preview cannot be asked, the
cost is the model's.

**Advanced: the borrower's own terms.** The exact quote takes the LTV the borrower picks (`collateral`, `principal`), and
`costBps` names their own cost instead, to a tenth of a basis point. Its `grades` list what each Loan grade A to D costs
for this loan and how many vaults would take it now at that cost; `lowestAcceptedCostBps` and `largestAccepted` are what
the vaults' settings take. Offer these controls or leave them out: the one-click quote needs none of them.

## Actions

| Action | Does | Approves |
|---|---|---|
| `borrow` | lists a loan; gage's keeper funds it from the partner vaults (`waitForFill`), then `collect` sends the payout; refused on terms no vault's settings take (`TERMS_NOT_ACCEPTED`) | the collateral, exactly |
| `leverage` | opens a loop: the loan buys more of the pledged token in the same transaction (USDG only) | the pledge and the purchase's most, exactly |
| `cancel` | cancels a listing still waiting for funding and takes the collateral back | nothing |
| `reclaim` | repays a running loan in full before its term ends and takes the collateral back | the repayment, exactly |
| `cash_out` | sells a running loan's whole collateral through an aggregator, repays the loan from the sale and pays you the rest less gage's 0.5% fee, in one transaction; the net never falls more than `maxSlippageBps` below the quote, nor under the `minNet` you name | the loan's reclaim right to the cash-out router |
| `roll` | rolls a running loan into a new loan of the same size on the same pledge; you add the old loan's cost and the new fee, or keep what is over | the reclaim right and the old repayment, exactly |
| `auto_roll` | leaves a loan to roll by itself: gage's keeper rolls it in its last hours into a loan of the same size and term, at most `maxCost` each (never more than the loan's principal), up to four times. Without `maxCost`, twice what a roll of it costs now as a roll is quoted (refused when none can be), held to four times the loan's own cost and fee, or for a listing not funded yet twice its own cost and fee | standing approvals: the router may move your loans on that core, and spend the repayments of four rolls, until you withdraw them in your wallet |
| `cancel_auto_roll` | ends a loan's instruction to roll by itself | nothing |
| `earn_deposit` | deposits into a partner vault, in the asset it takes | the deposit, exactly |
| `earn_redeem` | withdraws from a partner vault, everything it can pay when `shares` is omitted | nothing |
| `collect` | collects what is ready here: credits from loans, collateral back, vault earnings, collateral the vaults recovered from loans written off (a vault's pocket in any token but its own asset), backing anyone added to loans written off (summed by loan in gage's index, one claim a loan for its next claim's pockets, the oldest 64; from an older index, a vault's pocket in its own asset it names `RECAPITALIZATION`; its own row per asset and `view.backing`), neither ever counted as earnings, the sGAGE of loans and partner vaults, from vaults the chain bears out as gage's, at most twenty claims at a time, and what exit now sales paid (from the exit desk, `view.exits`, where a release names one); a claim that would revert now is left out, and its notes say so, and sGAGE under a millionth is not claimed. The first vault's credits and claims, earlier engines' lender recoveries, retired Earn strategies and the GAGE/sGAGE pool's rewards and Drip are collected on gage.cash | nothing |
| `feedback` | on mainnet only, rates gage, agent #8845 in ERC-8004: the wallet's own `score` from 0 to 100 in the Reputation Registry, tagged `starred`, once a wallet. Optional, and gage offers nothing for it; an action's last step, and a `done` run, carry a note saying a rating is open | nothing |
| `put_open` | opens a put on a lend asset (`lendAsset`): your `margin` of USDG and the USDG the loan buys, `size` times the margin in all, pledged in one loan, in one transaction; refused above `maxCostBps` | the margin and the purchase's most, exactly |
| `put_close` | closes a running loan on a core with a put router out of its own pledge: the pledge buys the repayment back and the rest comes back to you, in one transaction; it never spends more than `maxSlippageBps` over the quote, nor returns less than the `minBack` you name | the loan's reclaim right to the put router |
| `put_roll` | rolls a put into a new loan of the same size on the same pledge; the new payout passes through your wallet and straight back, and your USDG buys what it leaves short | the reclaim right, the payout's pass and the USDG spend, exactly |
| `put_auto_roll` | leaves a put to roll by itself: gage's keeper rolls it in its last hours through the put router, at most `maxCost` each, buying each top-up with at most `maxSpend` of your USDG (twice what buying the largest one costs now when omitted, never more than the pledge), up to four times | standing approvals: the router may move your loans on that core, take back four rolls' payouts and spend four top-ups, until you withdraw them in your wallet |
| `put_cancel_auto_roll` | ends a put's instruction to roll by itself | nothing |
| `lp_borrow` | borrows USDG at a fixed cost against a Uniswap v3 or v4, SushiSwap v3, Ramses or Fables position (`adapter`, `tokenId`): the position moves into its own escrow (a Uniswap v4 position leaves any subscription it has), and the loan's USDG less the fee comes to the wallet; refused above `maxCostBps`. With `rangeId` instead of `tokenId`, Fables receipts not wrapped yet are wrapped first (as `lp_wrap`), and the borrow follows once that is mined | the position to the lane's core, on its own position manager |
| `lp_repay` | repays your LP loan in full in USDG before its end, and takes the position back | the repayment, exactly |
| `lp_return_position` | takes back the position of an LP loan repaid before its end | nothing |
| `lp_collect` | collects a running LP loan's trading fees (a native ETH pool's as WETH), and a Ramses position's rewards, to the wallet; the liquidity stays in place | nothing |
| `lp_withdraw` | withdraws what the LP lane's core credits the wallet (a loan's USDG, fees, rewards), every token when `token` is omitted | nothing |
| `lp_deposit` | deposits USDG into an LP vault, for at least what it buys now less `maxSlippageBps` | the deposit, exactly |
| `lp_redeem` | withdraws from an LP vault, every share its free cash pays when `shares` is omitted | nothing |
| `lp_claim_bonus` | claims an LP vault's bonus for one defaulted loan (`loanId`), or for every one with a bonus for the wallet, twenty at a time | nothing |
| `lp_roll` | rolls your running LP loan into a new loan on the same position before its end (`term`, `maxCostBps`, `vault?`): the position stays in its escrow and only the difference moves, credited to you (then withdrawn) or paid by you; refused above `maxCostBps` | what you pay, exactly, when the new loan nets less than the old repayment |
| `lp_wrap` | wraps every Fables receipt you hold of one range (`adapter`, `rangeId`) into one position NFT the LP lane lends against; staked receipts are unstaked first and stop earning Fables' emissions | the receipts to the wrapper, exactly |
| `lp_unwrap` | gives a wrapped Fables position you hold back as its receipts, with their fees less the claim fee Fables keeps | nothing |
| `lp_create_vault` | opens an LP vault through the lane's factory, for a wallet the LP registry allows as a curator: its `name`, `performanceFeeBps` (500 to 1,500, fixed for good), `maxLoanPrincipal` and the `pools` it funds (its mandate) | nothing |
| `lp_vault_add_pool` | adds a pool to the mandate of an LP vault you curate; it funds new loans there three hours later | nothing |
| `lp_vault_remove_pool` | drops a pool from the mandate of an LP vault you curate, at once; loans already open there run to their ends | nothing |
| `park` | pulls an out-of-range position's whole liquidity out on its own DEX (`manager`, `id`) and deposits the one token it holds into the partner vault named (`vault`), which must take that token; its fees come to the wallet | the deposit to the vault, exactly |
| `unpark` | withdraws from a partner vault (`amount`, or all it can pay you now) and opens a new position in [`tickLower`, `tickUpper`] of a pool served (`manager`, `pool`) that pairs the vault's asset; a range around the price takes the pool's other token too, from the wallet | what the new position takes, exactly (through Permit2 for a Uniswap v4 PositionManager) |
| `rehypo_exit_now` | for an LP of a rehypo pool whose share of one of its tokens is more than that token's source can pay now (`source`): the source commits its partner-vault shares at the chain's exit desk, which lists one of the vault's loans at a price falling over ten minutes toward its book value, no further than the source's share of that loan can pay the buyer's discount (the pool's LPs who stay pay it, not you); once a buyer takes it, you remove your liquidity on the pool's hook as usual (see "Rehypo pools") | nothing |
| `earn_exit_now` | for a holder whose balance in a partner vault (`vault`) is more than it can pay now: commits your shares (`amount` of the vault's asset at today's share value, or all of them) at the chain's exit desk, which lists one of the vault's loans at a price falling over ten minutes toward its book value for what the vault cannot pay, no further than your share of that loan can pay the buyer's discount, which you pay; the sale pays you in its own transaction (see "Exit now") | your vault shares to the exit desk, exactly |
| `earn_exit_list` | lists the next loan for your open exit from `vault`, once its last listing ended unsold and the vault still cannot pay the rest | nothing |
| `earn_exit_cancel` | withdraws your exit from `vault` before a sale; it goes to the desk the vault's factory bound, so it works while exits are closed | nothing |
| `earn_exit_collect` | collects what your exits' sales paid you, from the exit desk: in `asset`, or in every asset it owes when omitted | nothing |

A wallet cannot fund a loan directly: lending is an Earn deposit, because only partner vaults lend.

A Gage serves the actions its network's deployment can carry out (`actionsOn`, and `capabilities().actions`): rolling
over only where a generation has its rollover router, and by itself only where the release names gage's keeper (the
testnet has neither, so it serves no `roll`, `auto_roll` or `cancel_auto_roll`); `cash_out` only where a core has a
cash-out router; `put_open` only where a lend asset offers puts, and the other put actions where a generation names a
put router; the `lp_` actions only where the release makes the LP lane public; `park` and `unpark` where a pool is
served for parking (the release's LP lane's, whatever its switch, or one you add); `rehypo_exit_now` and the
`earn_exit_` actions where a current generation names its exit desk; `feedback` on mainnet alone.

A generation the release has retired, keeping it for its positions alone, rolls nothing: gage's keeper and rates
service roll current generations only. On a loan there `roll`, `auto_roll`, `put_roll` and `put_auto_roll` are refused
(`ROLLOVER_CLOSED`, `PUT_CLOSED`), while `cancel_auto_roll`, `put_cancel_auto_roll` and `put_close` still go through
its own routers, served wherever a retired generation names them. Repay such a loan before it ends.

- `prepare({ action, wallet, … })` returns the next unsigned transaction (simulated now), the steps after it, a
  `summary` in words and the figures (`view`). It signs nothing. Prepare again after each transaction is mined. When
  `status` is `ready` and `next.final` is true, send it once: a second send lists, loops, rolls, deposits or redeems
  again. `again: true` says the steps come first and the action itself is prepared again once they are mined (a
  vault's settle before a deposit or a withdrawal), so `next` is not its last transaction though `then` is empty. An
  action that pays out over time adds a `preview` to draw ([Previews](#previews)).
- `run({ action, … }, signer)` carries the whole action out for the signer's own wallet. It plans from the chain,
  then builds, simulates, sends and waits for each step in order. A refusal found before any step throws an
  `ApiError`. Once planned, it answers with `status` (`done`, `nothing_to_do` or `stopped`), every transaction sent
  with its outcome, the steps never sent, the reason it stopped in fixed words, and `loan`: the loan a borrow, a loop,
  a roll or an LP borrow opened, read from its own receipt (an LP loan's `engine` is the lane's core).

Prices move, so the actions that need a signed price get it when they are sent: a loop's and a roll's plans are signed
for 30 seconds, and a cash-out's sale is quoted again. A roll that costs more, or a sale that pays less, than when it
was planned is refused before it is sent (`PRICE_MOVED`). A sale is also weighed, once the router holds the loan's
right, against gage's own route for the collateral where the release lists a direct pool for it: one that pays more than
1% less is refused (`SALE_BELOW_ROUTE`). Where gage has no such route the plan says so; name `minNet`, the least you
accept, to hold the sale to it (`BELOW_MIN_NET` under it).

A partner vault with a loan past its end that nobody has booked yet takes no deposit or withdrawal. A plan for one
settles those loans first (anyone may, and gage's keeper does each pass), then `run()` plans the deposit or withdrawal
again and sends it. Booking a loan past its end unpaid writes it off, which lowers the share price: until it is booked,
a withdrawal's `view.assets` is what the shares are worth before it, and its least amount is set once the settle is
mined.

## Spend limits

`run(input, signer, { limit })` and `gageTools(gage, { signer, limit })` take a spend limit: a function asked with each
action's plan (its `view`: a loan's `principal`, a deposit's `amount`, …) before anything is sent. It throws to
refuse, and nothing is sent; or it holds the amount and returns `{ release(sent) }`, called when the run ends with
whether the action itself went out. Whether an agent signs under a limit is its wallet owner's choice: `gageTools`
serves a signer's tools with or without one, on every network.

```ts
const limit: SpendLimit = (view) => {
  if (view.action === "borrow" && BigInt(view.principal) > 100_000_000n) throw new ApiError("SPEND_LIMIT", "Over 100 USDG", 403);
  return { release: () => undefined };
};
```

`gage-mcp` builds its limits on this: loans, loops and LP loans in USDG count their principal, deposits (into an LP
vault too) their amount, a roll only what it borrows beyond the loan it repays (the SDK rolls at the same size, so
nothing), and repaying, taking a position back, cashing out, leaving a loan to roll by itself or ending that,
withdrawing, exiting a partner vault or a rehypo pool now and listing an exit's next loan, cancelling, collecting,
claiming an LP vault's bonus, actions in an asset other than USDG (puts among them) and rating gage count nothing. On mainnet its limits are on unless the owner sets them `off`.

## Lend assets

gage can lend more than USDG: one generation of partner vaults per lend asset (a stock token such as GLD, 18
decimals), with its own core, registry and vaults. `deployment.generations` lists the public ones, USDG's first. Once
one is public, every answer that serves amounts names their `asset`.

- `borrowQuote` and `borrow` with `lendAsset` (the asset's token) borrow from that generation; the loan is paid out and
  repaid in the asset. In dollars, what you repay moves with its price.
- `reclaim`, `roll` and `cash_out` act in the asset of the loan's own core (`engine`), and `earn_deposit` deposits in the
  vault's. Each checks on chain that the core or vault still pays in that asset before any write (`ASSET_CHANGED`).
- Leverage and sGAGE rewards are USDG's only: a lend asset's loop router opens puts alone, with `put_open`. Each core's
  terms are in `capabilities()`.

## Puts

Where a lend asset's generation lends against USDG through a loop router and a put router (`capabilities().lendAssets`,
`loopRouter` and `putRouter`), a put is a loan of that asset against USDG: it gains as the asset falls, and its loss
stops at the margin you put in, since the loan is never closed early because a price moves.

- `put_open` pledges your USDG margin and the USDG the loan buys with the asset, `size` times the margin in all. The
  loan is the least whose payout buys that purchase through its cheapest pool with 25 bp of it spare, so next to nothing
  lands besides, and its cost is priced on the whole pledge as an exact loan is (`SIZE_TOO_HIGH` beyond what the pledge
  supports, with `details.maxPrincipal`).
- `put_close` repays a running loan out of its pledge through the put router: the repayment is bought back with the
  pledged tokens through the cheapest of the generation's pools, and the rest comes back in them. A pledge that cannot
  buy the repayment back now cannot close the loan (`PLEDGE_SHORT`): repay it in the asset, or leave it to end.
- `put_roll` and `put_auto_roll` roll a put through the put router, buying the top-up with your USDG; the plans are the
  rates service's, signed for the put router.

The put router's swaps go through the same hookless Uniswap v4 and V3 pools pairing the asset with USDG in the
deployment as the put's loop; no aggregator routes a lend asset's purchase.

## LP lane

Where a release makes it public (`deployment.lpLane`, `capabilities().lpLane`), gage lends USDG at a fixed cost against
an ETH/USDG liquidity position on Uniswap v3 or v4, SushiSwap v3, Ramses or Fables, in a pool the lane lists, through
the lane's own core, registry and vaults. There is no liquidation: the loan is never closed early because a price moves;
a loan not repaid by its end is settled by unwinding the position for its lenders, and nothing else is taken.

- `lpPositions` lists the wallet's positions in a pool the lane lends against, and `lpQuote` asks gage's rates service
  for a quote against one, checked field by field (`PLAN_MISMATCH` otherwise) and held to the registry's fee and loan
  cap. Uniswap v4's PositionManager cannot list a wallet's positions: gage's index names them (`GET /lp/positions`),
  each is checked on chain to be the wallet's, and the `note` says when the index could not name them all.
- A Uniswap v4 pool has no address of its own: the lane names it by its pool id's low 160 bits (`pool`), and its price
  is read from the StateView by its id (`poolId`). A native ETH pool's ETH is booked, collected and unwound as WETH.
- `lp_borrow` approves the position to the lane's core on its own position manager, borrows on the quote, then withdraws
  the USDG the core credits (the principal less the fee). The quote is sent as planned while it has a minute left; past
  that the borrow is quoted again when it is sent, refused above `maxCostBps`, and `PRICE_MOVED` when the position
  supports another loan than the one planned. Planned again once the loan is open, only its USDG is left to receive. A
  Uniswap v4 position moved into escrow leaves any subscription it has (a rewards program that tracks it stops counting
  it); the plan's summary says so.
- `lp_collect` receives first what the core credits the wallet in the loan's tokens; otherwise it collects the fees owed
  now (with a Ramses position's rewards) and is planned again to receive them, which `run()` does itself.
- `lp_roll` asks the rates service for the loan's roll (`loan=`), checks what it settles (the old repayment and the net
  the core moves), approves exactly what the wallet pays when the new loan nets less than the old repayment, rolls, and
  withdraws what is credited when it nets more. Past a minute before the quote runs out it is quoted again, held to
  `maxCostBps`, no larger a loan and no worse a settlement than planned (`PRICE_MOVED` otherwise).
- Fables LPs hold ERC-6909 receipts, not position NFTs: `FablesPositionWrapper` turns one range's receipts into a
  position NFT. `lpPositions` lists wrapped positions with the rest and receipts not wrapped yet under
  `fablesReceipts` (named by gage's index, each read on chain). `lp_wrap` unstakes staked receipts, approves them to
  the wrapper and wraps them; `lp_borrow` with `rangeId` does so first and borrows once the wrap is mined, a spend
  limit asked again with the loan's figures then; `lp_unwrap` gives a position back as its receipts. A wrapped
  position earns its pool's swap fees, not Fables' emissions, and Fables keeps a claim fee on its fees.
- An LP vault is impaired while a loan past its end is not settled, or tokens a defaulted position delivered wait to be
  sold: it then takes no deposit and pays nothing out (`VAULT_IMPAIRED`). Its deposits close while value it wrote off
  may still come back (`DEPOSITS_CLOSED`). It is an ERC-4626 vault: its shares are an ERC-20 (`gLP`) that moves between
  wallets, counted in the vault's own decimals (`shareDecimals`, read from its `decimals()`: 18, or 12 for a vault opened
  before 24 October 2026; 10^shareDecimals shares were worth one USDG when it opened). `lp_deposit` mints them to the
  wallet, and `lp_redeem` redeems the wallet's own (its `balanceOf`, shares it received by transfer included), every
  share the free cash pays (`maxRedeem`) when none are named. A bonus is what a defaulted loan's sale brought above its
  book value,
  shared by the lenders by their share of the vault and the time they held it while the loan ran; it belongs to
  whichever wallet held the shares then.
- Curators: a wallet the LP registry lets open a vault (`mayOpenVault`: a curator it allows, or anyone once its owner
  opens creation) opens one through the lane's factory (`lp_create_vault`) and curates it. A vault funds loans only in the pools of its mandate: one its curator adds funds three hours later, one
  it drops stops at once (open loans run on). `lpVaults` lists the release's vaults and the factory's, each with its
  `curator`, `mandate`, the plain words of `funds`, and `allowed` (false once the registry stops it lending). A quote
  may come from any of them; a stock LP (a Stock Token paired with USDG, in either order) is priced only while its
  market is open.
- The reads come from the chain: the lane's loans are read by id, newest first, two thousand at most; only the ids of
  Uniswap v4 and Fables positions and the ranges of Fables receipts come from gage's index.

## Pool vaults

A DEX that lends its pool's tokens through gage keeps one partner vault per pool token, each on the generation that
lends that token (a vault lends one asset): an NVDA/USDG pool has a USDG vault and an NVDA vault. Both are created
together and read back as one pool. Nothing on chain links them: both carry one name ending in the pool's tag, its two
tokens' symbols (`Fables NVDA/USDG`), and share their curator, which never changes. Renaming one of them unlinks it.

- `createPoolVaults` names what both share once (`term`, `feeBps`, `priorityFeeBps`, `minRateGrade`, and `buyLoans` for
  the USDG vault, since loans are sold between USDG vaults only) and, in `sides`, what is counted in each token: its
  largest loan (`maxLoan`, raw) and the cash it keeps free (`cashKeptFreeBps`, 10% when omitted: what the pool can draw
  on). A side lends against every token its generation admits in the universe of the pool's other token, less the
  pool's own two tokens, unless it names its `collateral`; a stock's vault lends against the memes paired with it.
- Neither vault lends against a token of its own pool, so a fall in that token does not reach the pool twice: a side
  whose `collateral` names one is refused (`POOL_TOKEN_COLLATERAL`) unless `allowPoolTokens` is true.
- It answers `calls`, one per vault in the pool's order, each to its own factory and simulated from the curator now: send
  them from the curator as one wallet batch (EIP-5792 `wallet_sendCalls`, atomic) or one after the other. `safeBatch` is
  the same calls as a Safe{Wallet} Transaction Builder file for a curator that is a Safe: its owners load it, check each
  call and sign there. gage never signs or proposes.
- A pool token gage lends no vault of (frxUSD in frxUSD/USDG) gets none, and so does a token whose generation does not
  admit the curator as a partner yet: `sides` says which and why, and only the other vault is created.
- The curator must be the one sending: each factory creates only for its caller and makes it the vault's curator for
  good.

## Park and unpark

A liquidity position out of range holds one token and earns no fees. `park` pulls it out on its own DEX and deposits
that token into a gage partner vault, which lends it at a fixed cost with no liquidation (a loan is never closed early
because a price moves); `unpark` withdraws and opens a new position in a range you pick. Both run from the LP's own
wallet, with no gage contract between: the DEX's position manager and the vault are called as the wallet would call
them, as one batch where the wallet sends one.

```ts
import { createGage } from "gage-sdk";

const gage = createGage({
  // A DEX adds its own pools: a Uniswap v4 pool by its key (hooked pools too), priced by its PoolManager's StateView.
  parkPools: [{ kind: "uniswap-v4", name: "ETH/USDG 0.3%", manager: POSITION_MANAGER, key: POOL_KEY, stateView: STATE_VIEW }],
});
const { positions } = await gage.parkPositions(wallet, [{ manager: POSITION_MANAGER, id: "1234" }]);
const park = await gage.parkCalls({ wallet, manager: POSITION_MANAGER, id: "1234", vault: DEX_VAULT });
await walletClient.sendCalls({ calls: park.calls.map(({ to, data, value }) => ({ to, data, value })) });
```

- **Pools.** The release's LP lane's pools are served whatever the lane's switch (`capabilities().parkPools`); a DEX
  adds its own with `parkPools`: a v3-style pool by its address, tokens, fee tier and tick spacing at its
  NonfungiblePositionManager (`uniswap-v3`, or `ramses-v3` for pools keyed by tick spacing), a Uniswap v4 pool by its
  key at its PositionManager, or a Fables pool by its key at its hook (`fables`). Positions are read from the DEX itself.
  A v3-style position manager lists a wallet's positions; a Uniswap v4 PositionManager and a Fables hook cannot, so
  name those in `also` (the lane's are found through gage's index).
- **The vault.** You choose it: one that takes the token the position holds (USDG in a USDG vault, a lend asset in its
  own vault), usually the DEX's own. A vault of another asset is refused (`VAULT_ASSET_MISMATCH`), and ETH or WETH is
  not parked yet (`ETH_NOT_SUPPORTED`). A vault of a native ERC-4626 generation takes `deposit(assets, receiver)`; an
  earlier one its slippage-held `deposit(assets, minShares)`.
- **The pull.** Out of range, what the liquidity holds is fixed, and it is the pull's own minimum: should the price come
  back into the range first, the pull reverts and nothing moves. A v3-style position is pulled with
  `decreaseLiquidity` then `collect`, a v4 one with DECREASE_LIQUIDITY then TAKE_PAIR (its native ETH as ETH), Fables
  receipts with the hook's `withdraw`. A Ramses position waits three minutes after its last liquidity change
  (`RAMSES_WAIT`): pulling it out claims its rewards, which Ramses forfeits that soon after.
- **What unpark waits on.** A vault pays out of its free cash: what is lent comes back as loans repay or mature, so
  `unpark` withdraws at most what the vault can pay you now (`maxWithdraw`), and a vault with a loan past its end is
  settled first (`again`). A range that holds only the pool's other token at the price now is refused
  (`RANGE_WITHOUT_ASSET`); one around the price takes the other token from the wallet too, at most what the price asks
  and `maxSlippageBps` more.
- **Sending.** `prepare` answers `calls`, every transaction in order, built from one reading of the chain: send them in
  order or as one batch, and do not prepare again between them. `run` sends them in order itself. `parkCalls` and
  `unparkCalls` answer the same calls for `wallet_sendCalls`, simulated whole first (`SIMULATION_FAILED` names the call
  that would revert).

## Exit now

A partner vault pays withdrawals from its free cash; what it has lent comes back as its loans repay. A holder whose
balance is more than the vault can pay now need not wait: `earn_exit_now` sells one of the vault's loans for it, through
the chain's exit desk, as gage.cash's Exit now does.

- **What it sends.** An exact approval of the desk for your shares when the one standing falls short, then
  `exitNow(vault, shares, id)` on the desk the vault's factory names: your shares (`amount` of the vault's asset at
  today's share value, or every share) are committed, and the desk lists the vault's loan `id`, chosen as gage.cash and
  gage's keeper choose it: among those that run past the listing and are within the vault's average, first the one whose
  price can fall furthest for you (`floorBps`, in whole percent), then the smallest that covers what the vault cannot pay
  of the shares (`need`), else the largest. Over ten minutes its price falls from book value plus 99% of what the loan
  has still to earn: only the part `need` covers can reach book value, and the price falls no further than `floorBps`,
  since you pay the buyer's discount out of your own share of what that loan has still to earn. A small share sets a
  high floor, so the listing may not sell; at 99% (`floorBps` 9900) the price does not fall and a vault is unlikely to
  buy it. Your shares stay yours until a sale.
- **Then.** The first vault that buys the loan pays you at today's share value, in the sale's own transaction: the desk
  owes it to you until you collect it (`earn_exit_collect`, or `collect` with the rest). A listing that ends unsold
  (eleven minutes) leaves the next one to list: `earn_exit_list` lists it, and gage's keeper may. `earn_exit_cancel`
  withdraws the exit at any time before a sale, on the desk the factory bound, so while exits are closed too.
- **How long it lasts.** A request lasts as long as the desk says (`EXIT_LIFE`, 24 hours; `lapsesAt`): after it nothing
  is listed or paid for it, and `earn_exit_now` commits again (`lapsed` in its view).
- **What you give up.** You leave at book value: your share of what the vault's loans have still to earn, if they are
  repaid. The plan's `preview` says about how much (`giveUp`), what you receive and what the vault can pay now, and the
  day in steps ([Previews](#previews)). You keep your sGAGE, and your part of any earnings a sale sets aside, less the
  buyer's discount you pay on the loan sold for you. Exit now, like a withdrawal, avoids losses on loans that default
  after you leave; the holders who stay bear them.
- **Where it stands.** `portfolio(wallet)` gives each Earn holding's open exit (`exit`, null for none): its shares, what
  they are worth (`committed`), its `stage` (`listed`, `loanId` for sale until `listingEndsAt`; `next`; `closed`, while
  exits are closed; `payable`, the vault can pay the rest now; `lapsed`) and `lapsesAt`, and `exitOwed`, what the desk
  owes the wallet by asset.
- **Refusals.** `earn_exit_now`: `NOTHING_TO_EXIT` when you hold no shares, or when the vault can pay the amount now (a
  withdrawal, not an exit: `earn_redeem`), `EXCEEDS_BALANCE` past your balance, `TOO_SMALL` under one share,
  `EXITS_CLOSED` while the factory names no desk, `EXIT_OPEN` beside an exit already open (list its next loan or
  cancel it), `PAUSED` while the vault is paused (none of its loans sells), `NO_SHORTFALL` (retryable) when the desk
  would list nothing, `NO_LOAN_TO_LIST` (retryable) when none of the loans can be listed now. A vault with a loan past
  its end is settled first (`again`), and so are the loans the desk waits on before it lists (a repayment, a refund or a
  loan past its end not yet booked: the desk lists nothing until then), one `settle` per 32 of them. `earn_exit_list`:
  `NO_EXIT`, `EXIT_LAPSED`, `LISTING_LIVE` (retryable, once it ends), `NO_SHORTFALL` (retryable: the vault can pay the
  rest now), `NO_LOAN_TO_LIST`, `EXITS_CLOSED`; it settles first what the desk waits on, as `earn_exit_now` does.
  `earn_exit_cancel`: `NO_EXIT`. `earn_exit_collect`: `NOTHING_TO_WITHDRAW` for an asset it owes none of, and
  `UNKNOWN_LEND_ASSET` for one no desk here pays out.

## Rehypo pools

A rehypo pool's hook lends each of its tokens through a gage source: the part of the pool the swaps do not need
is deposited into a partner vault. An LP whose share of one token is more than its source can pay now (its float, what
the exit desk owes it, the vault's free cash) need not wait for loans to repay: `rehypo_exit_now` asks that source to
leave now for it.

- **What it sends.** One call, `exitNow(id)` on the source. The source reads your share from the hook's LP token and
  commits, at the exit desk its vault's factory names, the vault shares its cash leaves short of it (or its open
  commitment, if larger). The desk lists the vault's loan `id`, chosen as gage's app and keeper choose it: among those
  that run past the listing and are within the vault's average, first the one whose price can fall furthest for the
  source, then the smallest that covers what the vault cannot pay of the commitment (`need`), else the largest. Over ten
  minutes its price falls from book value plus 99% of what the loan has still to earn: only the part `need` covers can
  reach book value, and the price falls no further than the source's share of that loan can pay (`floorBps`). The
  buyer's discount comes out of the source's share of what that loan has still to earn, which belongs to the pool's LPs
  who stay: they pay it, not you, and a listing for a small LP may not sell. While the source's own exit listing is
  live, `id` is 0: the commitment rises and that listing goes on.
- **How long it lasts.** The source holds what the sales pay for its LPs for an hour after each ask (`EXIT_HOLD`;
  `endsAt`): remove before then. gage's keeper then ends the exit, and the next rebalance lends what is left again. The
  desk itself drops a commitment a day after it is made (`EXIT_LIFE`); each ask commits again, so it renews one that
  lapsed (`lapsed`).
- **Then.** Once a buyer takes the loan, the desk owes the source what the sale paid, and you remove your liquidity on
  the pool's hook as usual: the source pays your share from it, held for its LPs for an hour. After the hour anyone ends
  the exit (gage's keeper does), and an LP who has not removed asks again. Removing takes the pool's other token too, from
  its own source: where that side cannot pay you either, exit there as well.
- **What you give up.** As any holder leaving through the desk, you leave at book value: your share of what the
  vault's loans have still to earn, if they are repaid. The plan's `preview` says about how much (`giveUp`), what you
  receive and the hour in steps ([Previews](#previews)). Like a withdrawal, it avoids losses on loans that default after
  you leave; the LPs and holders who stay bear them.
- **Refusals.** `NOTHING_TO_EXIT` when you hold none of the pool's LP shares or the source can pay your share now
  (remove as usual), `EXITS_CLOSED` while the factory names no desk, `NO_SHORTFALL` (retryable) while the vault's free
  cash covers what the source would commit, so the desk would list nothing, `NO_LOAN_TO_LIST` (retryable) when none of the
  vault's loans can be listed now, `NOT_A_REHYPO_SOURCE` for an address that is not one. A vault with a loan past its end
  is settled first (`again`), and so are the loans the desk waits on before an ask that lists, as for a partner vault's
  exit now.

## Previews

An action that pays out over time comes with a `preview`: what the wallet receives, what of it can be paid now, about
what it gives up, and its steps in time, as raw amounts in `preview.asset` and a few words. A partner vault's exit now
has one, and a rehypo pool's (`kind: "exit_now"`).

- **In your own design.** Draw it from the numbers: `receive`, `now`, `giveUp` (null while gage's index cannot say, never
  a guess) and `steps`, each `at` seconds after the wallet sends, with `when` and `what` in a few words.
- **As gage's card.** `renderPreview` from `gage-sdk/visual` returns one SVG with nothing to fetch and nothing to run,
  on gage's light paper or its dark theme. It names gage's fonts (Space Mono, Libre Franklin) and falls back to the
  system's where the page does not load them. The card is apart from the main entry, so an integration that draws its
  own never bundles it.

```ts
import { renderPreview } from "gage-sdk/visual";

const plan = await gage.prepare({ action: "earn_exit_now", wallet, vault });
if (plan.preview) card.innerHTML = renderPreview(plan.preview, { theme: "dark" });
```

## Leverage

`leverage` buys the extra tokens in the loop's own transaction through the cheapest source that runs: each Uniswap v4
and V3 pool pairing the token with USDG in the deployment (with the lend asset, for a loop on a lend asset's
generation), and for USDG an aggregator's route from gage's valuation service (KyberSwap's on mainnet), counted only
once the loop router admits its executor. An aggregator's call is decoded before it is used, for cash-outs too: it must
sell exactly the input to KyberSwap's executor alone, pay no fee, deliver the output to gage's router and accept no less
than its least output (`aggregatorCallOk`). The wallet approves one USDG amount, the cheapest source's bound, and a
multiple is offered only while that bound keeps 25 bp of the loan spare under what the loan pays out
(`MULTIPLE_TOO_HIGH`).

## Signers

A signer is `{ address, sendTransaction(tx) }`, so any wallet fits.

- `privateKeySigner(key, { network?, rpcUrl? })` holds a raw key in memory, for Robinhood Chain unless `network` is
  `"testnet"`.
- `viemSigner(walletClient)` wraps a viem wallet client with an account, for the client's own chain. A signer refuses
  another chain's transaction (`CHAIN_MISMATCH`).
- An ethers signer needs three lines:

```ts
const signer = {
  address: await wallet.getAddress(),
  sendTransaction: async (tx) => (await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gas, chainId: tx.chainId })).hash,
};
```

## Tools for agent frameworks

`gageTools(gage, { signer? })` returns gage's tools, the same ones the MCP servers serve: each has a name, a title, a
description, a zod `inputSchema`, MCP hints and `execute(input)`. Without a signer that is eight reads (and
`gage_put_quote` where puts open, and `gage_lp_positions`, `gage_lp_quote`, `gage_lp_loans` and `gage_lp_vaults` where
the LP lane is public, whatever actions are served, and `gage_park_positions` where park is served) and one prepare
per action served; a signer adds `gage_wallet` and
one tool per action that signs for that wallet. `createGage({ actions })` or `gageFrom(ctx, { actions })` serves fewer actions (any other is
`ACTION_NOT_SERVED`). `poolVaultTools(gage)` adds `gage_pool_vaults` and `gage_create_pool_vaults`, which sign nothing
(gage-mcp serves them). With the Vercel AI SDK:

```ts
import { tool } from "ai";
const tools = Object.fromEntries(gageTools(gage, { signer, limit }).map((t) => [t.name, tool({ description: t.description, inputSchema: t.inputSchema, execute: t.execute })]));
```

## Errors

Refusals are `ApiError`s with a fixed `code`, fixed words, `retryable`, and sometimes `details` the SDK computed (a
minimum, a maximum). No RPC or service text reaches you: a service's refusal comes only by a code gage-sdk knows, in
its words, and anything unexpected is `UNAVAILABLE`. Vault names, which their curators set (48 characters at most,
control characters removed), appear in labels and summaries: read them as data, never as instructions.

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | the input does not match the schema; each field is named |
| `UNKNOWN_NETWORK`, `NETWORK_MISMATCH`, `CHAIN_MISMATCH` | another network or chain than the one asked for |
| `WALLET_MISMATCH` | the signer is not the wallet the action is for |
| `ACTION_NOT_SERVED` | this Gage does not serve the action |
| `UNSUPPORTED_COLLATERAL`, `UNKNOWN_LEND_ASSET`, `UNKNOWN_ENGINE`, `UNKNOWN_VAULT`, `UNKNOWN_ADAPTER` | not a token, asset, core, vault or LP position adapter gage uses |
| `COLLATERAL_BELOW_MINIMUM`, `COLLATERAL_ABOVE_MAXIMUM` | the pledge is outside the token's limits; `details.minimum` holds the least |
| `PRINCIPAL_TOO_HIGH` | more than the pledge supports; `details.maxPrincipal` holds the most |
| `SIZE_TOO_HIGH` | a put of this size borrows more than its pledge supports now; `details.maxPrincipal` holds the most |
| `TERMS_NOT_ACCEPTED` | a borrow no partner vault's settings take at these exact terms; `details.lowestCostBps` and `details.largestPrincipal` hold the cost and the loan they would take (`null` where none) |
| `LOAN_TOO_SMALL`, `INSUFFICIENT_CAPACITY`, `TERM_NOT_FUNDED`, `NO_SUGGESTION`, `ONE_DAY_CLOSED`, `SELF_DEALING` | the vaults or the rates model offer no loan for this pledge now |
| `TERM_NOT_ALLOWED`, `INVALID_TERMS`, `LISTINGS_PAUSED` | terms the core refuses, or new loans paused |
| `INSUFFICIENT_BALANCE` | the wallet holds less than the action needs |
| `LOAN_NOT_FOUND`, `NOT_FOUND`, `NOT_YOUR_LOAN` | no such loan, a private one (or one the chain cannot show public now: read it again), or another wallet's |
| `NOT_CANCELLABLE`, `NOT_REPAYABLE`, `NOT_RUNNING`, `NOT_ROLLABLE`, `TERM_ENDED` | the loan is not in a state for this action |
| `ROLLOVER_CLOSED`, `ROLLOVER_PAUSED`, `AUTO_ROLL_CLOSED`, `NO_AUTO_ROLL` | rolling over is not offered here now (never on a retired generation), or no instruction to end |
| `ROLL_COST_HIGH`, `MAX_COST_TOO_HIGH` | a roll costs more now than four times the loan's own cost (name `maxCost` to accept it), or a `maxCost` above the loan's principal |
| `MAX_COST_TOO_LOW`, `MAX_SPEND_ZERO` | a `maxCost` below the origination fee every roll pays, or a put roll's `maxSpend` of zero: limits no roll could meet (r12 review C8) |
| `CASHOUT_CLOSED`, `NO_SALE` | this loan's core cashes out on gage.cash only, or no aggregator sells its collateral now |
| `BELOW_MIN_NET`, `SALE_BELOW_ROUTE` | the sale pays less than the `minNet` you named (`details.net` holds what it pays now), or clearly less than gage's own route, which gage.cash sells through |
| `LEVERAGE_CLOSED`, `NO_LEVERAGE_POOL`, `POOL_TOO_THIN`, `MULTIPLE_TOO_HIGH`, `PRICE_ABOVE_LIMIT` | leverage cannot buy this purchase at this multiple or cost now |
| `PUT_CLOSED`, `PUT_PAUSED` | puts are not offered for this asset or on this loan's core (a retired generation's still close, and never roll), or its put router is paused (the loan can still be repaid) |
| `PLEDGE_SHORT`, `BELOW_MIN_BACK`, `MAX_SPEND_TOO_HIGH` | the pledge cannot buy the repayment back now, a close returns less than the `minBack` you named (`details.back` holds what it returns now), or a roll's `maxSpend` above the loan's pledge |
| `PRICE_MOVED` | a price moved against the plan before it was sent; prepare again |
| `PLAN_MISMATCH`, `UNSIGNED`, `PRICING_EXPIRED` | gage's rates service signed no plan for exactly this action |
| `FUNDING_CLOSED`, `SETTLEMENT_DUE`, `PAUSED`, `IMPAIRED`, `BELOW_MINIMUM`, `CAP_EXCEEDED`, `ZERO_SHARES`, `EXCEEDS_BALANCE`, `INSUFFICIENT_LIQUIDITY`, `OUTSTANDING_LOANS`, `TOO_SMALL`, `VAULT_REFUSED` | a partner vault refuses this deposit, withdrawal or exit now |
| `ASSET_CHANGED` | the core or vault no longer pays in the asset planned; read again |
| `LP_CLOSED` | the release makes no LP lane public here |
| `POSITION_NOT_FOUND`, `NOT_OWNER` | no position has this id at the adapter's position manager, or the wallet does not hold it (nor has an LP loan open against it) |
| `NOT_REPAID` | an LP loan's position comes back only once the loan is repaid (`lp_repay`) |
| `VAULT_IMPAIRED`, `DEPOSITS_CLOSED` | an LP vault takes no deposit and pays nothing out while a loan past its end is not settled or recovered tokens wait to be sold, or takes no deposit while value it wrote off may still come back |
| `NOTHING_TO_WITHDRAW`, `NO_BONUS` | the LP lane credits the wallet none of this token (or the exit desk owes it none of this asset), or the wallet has no bonus to claim from this loan |
| `NOT_CURATOR`, `NO_VAULT_FACTORY`, `NO_MANDATE`, `POOL_IN_MANDATE`, `POOL_NOT_IN_MANDATE`, `TOO_MANY_POOLS` | the wallet is not a curator the LP registry allows (to open a vault) or not the vault's curator (to change its pools), the lane names no vault factory, the vault names no mandate, the pool is in its mandate already or is not, or the mandate names 32 pools already |
| `VAULT_NOT_LENDING` | the LP registry no longer lets this vault fund new loans: a deposit would sit idle |
| `NOT_FABLES`, `NOTHING_TO_WRAP`, `FABLES_PAUSED` | the adapter named is not the lane's Fables adapter, the wallet holds no Fables receipts of this range, or Fables has paused moving its receipts (retry later; unstaking is never paused) |
| `UNKNOWN_POOL`, `IN_RANGE`, `NOTHING_TO_PARK`, `PRICE_UNAVAILABLE`, `RAMSES_WAIT` | parking: no pool served at this manager (or of this position), the position is in range and earns fees, it holds nothing, its pool's price cannot be read, or a Ramses position changed in the last three minutes (retry later) |
| `ETH_NOT_SUPPORTED`, `VAULT_ASSET_MISMATCH`, `VAULT_ASSET_NOT_IN_POOL` | the position holds ETH, which no gage vault takes yet; the vault takes another token than the position holds; or unparking from a vault whose asset the pool does not pair |
| `RANGE_WITHOUT_ASSET`, `RANGE_NEEDS_ETH`, `INVALID_RANGE` | unparking into a range that holds only the other token at the price now, a Fables range around the price (which takes ETH), or ticks that are not the pool's |
| `NO_ENTRY`, `OWN_ENTRY`, `ALREADY_RATED` | a rating of gage off mainnet, from a wallet that owns or operates gage's entry, or a second time from the same wallet |
| `POOL_TOKENS_SAME`, `UNKNOWN_TOKEN`, `NAME_TOO_LONG`, `SIDE_NEEDED`, `MAX_LOAN_TOO_HIGH`, `MIXED_COLLATERAL`, `POOL_TOKEN_COLLATERAL` | pool vaults of one token twice, a symbol gage lends no asset of (name such a token by its address), a name the pool's tag takes past 48 bytes, a side gage would create that `sides` does not name, a largest loan above what a vault may lend in one loan, collateral of both universes, or a token of the pool named as a side's collateral without `allowPoolTokens` |
| `NOT_A_REHYPO_SOURCE`, `NOTHING_TO_EXIT`, `EXITS_CLOSED`, `NO_SHORTFALL`, `NO_LOAN_TO_LIST` | an exit now: not a rehypo source that lends through a partner vault, nothing to exit (no shares or LP shares, or the vault or source can pay it now: withdraw instead), exits closed on the vault's factory, nothing the vault cannot pay, so nothing to list (retry), or none of its loans can be listed now (retry in a few minutes) |
| `EXIT_OPEN`, `NO_EXIT`, `EXIT_LAPSED`, `LISTING_LIVE` | a partner vault's exit: one already open (list its next loan or cancel it), none open to list or cancel, a request that ended after 24 hours (exit again), or a listing still live (retry once it ends) |
| `NOT_LENT`, `NOT_A_PARTNER`, `FACTORY_CHANGED` | gage lends neither pool token, a token's factory admits partners only and gage has not admitted the curator (creation is open to anyone on mainnet since 5 November 2026), or a factory is not the one the release publishes |
| `SIMULATION_FAILED` | the transaction would revert now |
| `SEND_FAILED`, `SEND_UNKNOWN`, `TX_PENDING`, `TX_FAILED` | the signer did not send and the wallet's nonce did not move (nothing went out; it may be sent again), the signer failed after the wallet sent a transaction (it may have gone out: look up the wallet's latest transaction before sending again), the transaction is not mined yet, or it reverted (`run` answers these) |
| `RATES_REFUSED`, `RATES_UNAVAILABLE`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_INVALID`, `UPSTREAM_TOO_LARGE` | one of gage's services refused, did not answer, or answered outside what was asked (an instant loan pledging more than the tokens asked about) |
| `RATE_LIMITED` | one of gage's services asks for fewer requests a minute; wait and ask again, or give a Rates API key (`apiKey`, [ask for one](https://github.com/DebenLabs/gage-contracts/issues/new?template=integration.yml)) |
| `INVALID_KEY`, `NO_ACCOUNT` | a signer without a usable key or account |
| `UNAVAILABLE` | anything else; retry later |

The rates service's refusals come only by the codes gage-sdk knows, in its words: `ABOVE_MARKET_LIMIT`,
`ASSET_OPEN_CAP`, `COLLATERAL_NOT_ALLOWED`, `FILLER_NOT_ADMITTED`, `FILLS_CLOSED`, `INCOMPLETE_PLAN`, `LOAN_NOT_ACTIVE`,
`NO_COST_OFFERED`, `NO_FILLER`, `NOT_RIGHT_HOLDER`, `PRICING_UNAVAILABLE`, `PRINCIPAL_TOO_SMALL`, `PURCHASE_TOO_SMALL`,
`RETURN_ABOVE_PRINCIPAL`, `ROUTER_NOT_ADMITTED`, `SIGNER_NOT_CONFIGURED`, `TOO_LATE`, and those of the same name above.
An LP quote's refusals come the same way: `ADAPTER_NOT_ALLOWED`, `POOL_NOT_ALLOWED`, `RANGE_TOO_NARROW`,
`EMPTY_POSITION`, `LOANS_PAUSED`, `BELOW_MINIMUM_LOAN`, `ABOVE_LOAN_CAP`, `ABOVE_POOL_CAP`, `ABOVE_DAILY_CAP`,
`VAULT_CANNOT_FUND` and `NOT_REGISTRY_SIGNER`, with `LP_CLOSED`, `NOT_OWNER`, `TERM_NOT_ALLOWED` and
`PRICING_UNAVAILABLE`; a roll's also `NOT_ACTIVE`, `PAST_TERM`, `NOT_BORROWER` and `NOT_SAME_POSITION`. Any other is
`RATES_REFUSED`, or `UNSIGNED` for a plan it did not sign; a partner vault's refusal gage-sdk does not know is
`VAULT_REFUSED`.

## Testing

`gage-sdk/testing` has a fake chain, fake gage services, a fake signer and a fixture deployment, so an integration can
be exercised with no network.

## Development

The source is at [github.com/DebenLabs/gage-sdk](https://github.com/DebenLabs/gage-sdk), a mirror of gage's main
repository, from where npm's copy is published with provenance. Issues and pull requests are welcome there; report a
vulnerability privately (its SECURITY.md). In either repository (`packages/sdk`):

```bash
pnpm --filter gage-sdk build            # dist/, which gage-mcp and the services built on it import
pnpm --filter gage-sdk test
```

The SDK carries the fields it reads of both live deployments (`src/deployments/`, generated), so it works outside gage's
repositories. In gage's main repository, which holds the live deployments, `pnpm --filter gage-sdk sync-deployment`
writes them after a contract generation, and `test/deployment.test.ts` fails until a changed one is synced.

MIT licensed.
