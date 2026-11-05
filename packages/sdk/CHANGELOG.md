# Changelog

## 0.7.0

The first release on npm after 0.6.0: it also carries 0.6.1 and 0.6.2 below, prepared but never published. Breaking
for code that calls the exit-now helpers (`exitNeed`, `exitEligible`, `exitMayTakeOver`, `chooseExitHolding`,
`chooseExitLoan`) or implements `ExitReads` or `Chain`: see the entries marked Breaking. `Chain` also adds `rights` (0.6.2).

- **Guides for every integration path, shipped with the package (`docs/`).** Getting started, reads, borrowing (the
  lowest fixed cost in one click, exact terms and Loan grades, 1-day loans, rolling over, cash-outs, leverage), Earn
  (deposits, withdrawals, exit now, a rehypo pool's exit now, pool vaults), puts, the LP lane's fourteen actions, lend
  generations (stablecoin markets found through the GenerationDeployer), park and unpark, signing (`run()`, signing each
  step yourself, signers, spend limits) and agents (tools for frameworks, gage-mcp, the hosted service's review links).
  Every TypeScript block in them is a slice of an example, line for line (`test/docs.test.ts`). `docs/reference.md`, every
  method, action and tool with its inputs, is generated from the SDK's own schemas and catalogue and fails its test until
  written back (`pnpm --filter gage-sdk test -u`). The package's `files` add `docs`. Documentation only: no API changes.
- **Eleven more examples, each tested against gage's fakes** (`test/examples.test.ts`, every input checked against the
  schema `prepare` and `run` take): `reads.ts`, `borrow.ts` (one click, the exact quote, a loop, a refusal's minimum),
  `loan.ts` (repay, roll, roll by itself, cash out), `exit-now.ts`, `put.ts`, `lp.ts`, `generations.ts`, `park.ts`,
  `sign-yourself.ts`, `spend-limit.ts` and `hosted-review.ts`.
- **Mainnet's LP lane is public (5 November 2026).** The bundled mainnet release now carries `lpLane.public: true`,
  so on mainnet `deployment.lpLane` is r13's lane, no longer null: positions in its ten pools (ETH/USDG on Uniswap v3,
  SushiSwap v3, Ramses, Uniswap v4 and Fables; NVDA, SPY and GLD against USDG on Uniswap v3 and v4), every vault a
  curator's through its factory. `actionsOn` adds its fourteen actions there (`lp_borrow` to `lp_roll`, `lp_wrap`,
  `lp_unwrap`, `lp_create_vault`, `lp_vault_add_pool`, `lp_vault_remove_pool`) beside park and unpark, which it served
  already, and `gageTools` their four reads and their prepare and signed tools. Until a curator's vault holds USDG for a
  pool, every quote in it refuses (`VAULT_CANNOT_FUND`).
- **Pool vaults from any curator where creation is open (root D424).** `createPoolVaults` reads the factory's
  `openCreation` beside `isCreator` (`IntentFactoryState.openCreation`, a new field of `Chain.intentFactory`'s answer) and
  creates a side for any curator while it is on, as the factory's `create` allows (Intent D43). Mainnet's factories open
  creation to everyone with the founders' batches of 5 November 2026; until a factory's batch executes, its side is still
  `NOT_A_PARTNER` for a curator gage has not admitted. Breaking only for code that implements `Chain`: its
  `intentFactory` answers `openCreation` too.
- **A written-off loan's backing comes summed by loan (D414).** gage's index now answers a partner position's backing
  (`recapitalize`'s pockets) as one entry a loan, `backing: { loanId, token, pockets, claimable, next: { ids,
  claimable } }`, instead of listing every pocket, which past about 30,000 pockets took the answer over the 4 MB this
  package takes in (`UPSTREAM_TOO_LARGE`). `holding` reads it, `portfolio` counts each loan's pockets in `claimsReady`,
  and Collect all claims each loan's backing on its own, its next claim's pockets (`next.ids`, the oldest 64), counting
  what that claim pays. An index before D414 still lists backing among `pockets`, which is summed by loan here.
  Collect all now says "More claims are ready" when a claim leaves pockets for the next collect: a vault's earnings
  and collateral past one claim's 64 pockets, or a loan's backing past its next claim. Earlier versions of this
  package read backing among `pockets` only: against an index from D414 they show and collect none until updated, while
  it stays claimable on chain.
- **One read that fails leaves the rest of a portfolio and of Collect standing (D412).** `portfolio` and Collect all read
  each core's loans and credit, each generation's vault list and each vault holding on its own: one whose index or
  chain read does not answer is left out and named, where it failed the whole read for every wallet. `portfolio` adds
  `unread` (one line each, only when something was not read) and its note says those parts are missing, not empty;
  Collect plans what answered and says in a note what it could not read. `eachRead` and `everyPartnerVault` are new.
- **Exit now says what it leaves to those who stay (D396).** `earn_exit_now`'s and `rehypo_exit_now`'s descriptions,
  both exit-now plans' notes and the README say that exit now, like a withdrawal, avoids losses on loans that default
  after the wallet leaves, and that the holders (a rehypo pool's LPs and the vault's holders) who stay bear them.
  Wording only.
- **A pocket's loan is asked about once, however many pockets name it (D404).** `portfolio` and Collect all hold each
  claimable pocket's loan to the private lane on chain; a loan is now asked once, not once a pocket, so a written-off
  loan carrying thousands of backing pockets costs one read. The indexer now answers a position of a vault past 4,096
  pockets, read by loan, where it answered `503`, so such a vault no longer fails every wallet's portfolio.
- **Each current generation is read from the index its release names (D403).** A release names the index of its
  current generations (`intentV1IndexerUrl`) and may name a lend asset's own (`intentV1Assets.<SYMBOL>.indexerUrl`), as
  the app and gage's keeper read them. The bundled manifests now carry both, `Generation` adds `indexerUrl` (a lend
  asset's own, else `intentV1IndexerUrl`; absent where the release names neither), and every read of a current
  generation goes there: its vault lists, accounting, deposit and park previews, holdings, and its core's loans. A
  retained generation keeps its own index, as before. `indexerUrl` in `createGage`'s options is the network's index: it
  serves a generation only where the release names none, and everything else as before (the vault links, the list of
  generations found on chain, earlier engines, the LP lane). The bundled mainnet release names none today, so nothing
  changes there until a release does; the testnet's names `indexer-rehearsal`, its default. `gage-sdk/testing`'s
  `ctx()` serves every generation's own index from its one fake indexer unless `indexerAt` names others, so a test over
  a release that names its origins reaches no network.
- **An exit's need counts the vault's reserve at its value (D394).** The exit desk of the next generations measures what
  a commitment needs against the vault's cash and its reserve at the reserve's own value (`totalAssets` less the loan
  book), no longer against what the reserve can pay out at that instant (`freeLiquidity`), so a reserve's liquidity moved
  inside one transaction lists no loan and moves no floor. `exitNeed` follows it, and so `earn_exit_now`'s `need` and its
  choice of loan: a wallet whose claim the reserve holds but cannot pay out yet gets `NO_SHORTFALL`, whose message now
  says so, and waits for the reserve as a withdrawal does. Breaking: `exitNeed` takes `held` (cash and the reserve at
  value) where it took `free`, and `ExitVaultBook` adds `held`; `Chain.exitVaultBook` reads `totalAssets` too.
- **Exit now charges the leaver its own discount (SEC-01, D391).** The exit desk of the next generations records, at
  each exit sale, the buyer's discount below the listing's start as a debit on the leaver (`exitDebit(vault, id)`,
  `ExitDebited`), and that sale's earnings claim pays every other holder its share of the start: the leaver pays the
  discount out of its own share of what the sold loan has still to earn. So a listing falls no further than that share
  allows (the desk's stake floor), and a small holder's listing may not sell. `earn_exit_now`, `earn_exit_list` and a
  listing `rehypo_exit_now` now try the vault's holdings first by where the desk would stop each for the exit (the
  larger of that floor and the need's), in whole percent, the lowest first, then by size as before, as gage's keeper and
  app do; their `view` adds `floorBps` (where the price stops, in basis points of
  what the loan has still to earn kept above book value; null where the share views answer no `exitShare`), the row
  `Sold for you` says where it stops and that it may not sell (at 99%, that its price does not fall and a vault is
  unlikely to buy it), and `You give up` that you pay the buyer's discount on that loan yourself; for a rehypo pool, that
  the pool's LPs who stay pay it, since the source is the leaver. `chooseExitHolding(reads, need, now, slack?, takes?, stake?)` takes the leaver's `{ committed, held }` and
  answers the holding with its `floorBps`; `ExitReads` adds an optional `exitShares(ids)`; `exitStakeFloor`,
  `exitNeedFloor`, `exitFloor` and `exitStakes` are exported. `Chain` adds `exitShares(factory, vault, ids, who)` (the
  share views' `exitShare`, null from views before D391) and `exitDebit(desk, vault, id)` (null from a desk before
  D391); each takes only an empty revert for an earlier generation and throws on any other failure, a node's refusal
  included. An earlier generation's desk sets no such floor, and its plans read as before.
- **A live exit listing passes to a lower floor, not a larger need (D391, with D390).** Under the stake floor a larger
  shortfall could raise where a falling listing stops, so the desk now takes a listing over only for an exit whose
  floor at that holding is strictly lower than the floor of the exit it serves (`floorOf(vault, id, owner)`), or once
  that exit needs nothing (its `shortfall` zero), or was cancelled. Breaking: `ExitReads` adds `floorOf(id, owner)`
  (null from a desk that answers none, which takes no listing over); `exitEligible(reads, id, now, mine, slack?)` and
  `exitMayTakeOver(reads, id, holder, mine)` take this exit's floor at that holding (`exitFloor`) where they took its
  need; `chooseExitHolding` and `chooseExitLoan` take the stake after `takes`; and `Chain` adds
  `exitFloorOf(desk, vault, id, owner)`.
- **Breaking, for 0.7.0: exit now takes over a smaller exit's live listing (D390).** The exit desk of the next generations passes another
  exit's live listing of a holding, as it stands (its nonce, start and end), to an exit whose shortfall is strictly larger
  than that exit's, and to any exit once that one cancelled; the exit it served is dropped and may list another holding at
  once. `earn_exit_now`, `earn_exit_list` and a listing `rehypo_exit_now` choose such a holding the same way, so a holder
  is no longer kept from the vault's only listable loan by a smaller exit that cannot be paid. The desk of an earlier
  generation (the testnet's r13d) still refuses such a listing, with its `ListingLive`, until its generation is
  replaced, and a race can too: a takeover is chosen only once the wallet's own transactions simulate (the approval
  first where one is needed), and one the desk refuses is passed over for the next holding, so preparing the action
  again never chooses it again (`chooseExitHolding` and `chooseExitLoan` take an optional `takes`). Breaking for code
  that calls or implements these: `exitEligible(reads, id, now, need, slack?)` takes the exit's `need` before `slack`
  (a `slack` passed by position must move); `ExitReads` must answer `shortfall(owner)`, and its `listing(id)`, like
  `Chain.exitListing`, answers `{ owner, nonce }` where it answered the nonce alone. The next release is therefore
  0.7.0.
- **The one-click borrow takes the best fixed cost a partner vault funds (D384).** Each vault takes loans down to its
  own Loan grade's share of the rates model's cost: on 2 November every USDG vault on mainnet took grade B, 90% of it,
  while `borrowQuote` priced every loan at the model's cost or above. `borrowQuote({ maxCollateral })` keeps the
  instant answer's size and lowers its cost to the cheapest floor at which the vaults funding it still take all four
  quarters, never under grade D, half the model's cost. The listing waits for gage's keeper, and a vault's floor rises
  as the pledge's worth falls (a meme's model cost about 4–5% for each 1%), so the cost must also hold on a pledge worth
  less by a cushion: 2% for a meme, 0.5% for a stock or ETH. Three readings of the funding preview follow the instant
  answer at most: its terms, the smaller pledge's, the cheaper cost's. A reading that fails or does not fund the loan
  whole leaves the instant answer's cost. Both quotes add `modelCostBps` and the Loan `grade`; `costBps` may now carry
  a tenth of a basis point.
- **An advanced mode for the borrower's own terms (D384).** The exact quote prices a loan the vaults fund whole now at
  the lowest cost they accept too, and a loan that would wait for their cash as before. `costBps` names the borrower's
  own cost instead, read as it is. It adds `grades` (each Loan grade A to D: its cost and how many vaults would take
  the loan now at it) and `lowestAcceptedCostBps`.
- **A borrow no partner vault's settings take is refused (D247).** `borrow` answers `TERMS_NOT_ACCEPTED`, with the
  lowest cost and the largest loan they take (`details.lowestCostBps`, `details.largestPrincipal`), where it listed a
  loan that would never be funded. One that fits a vault without the cash for it now still lists, and its note says so.
- **Lend generations the indexer finds are proved on chain before they are used.** `foundGenerationsRefresher` (so
  `createGage` with a manifest naming a `generationDeployer`) first reads each generation the indexer serves: the
  deployer's own `GenerationDeployed` in the entry's block, then one multicall (the deployer's `isFactory` and
  `listed`, the factory's bound exit desk and mandate version, the asset's symbol and decimals, the cash-out router's
  flash source). Only an entry exactly as the chain records it joins the deployment (its terms, admissions and routes
  taken as served, which its own contracts enforce), so nothing is prepared into a contract the indexer alone names; an
  unchanged entry is not read again. `proveFoundGenerations(chain, manifest, body)` is exported for a builder who merges
  the answer itself, before `mergeFoundGenerations`. `Chain` adds `foundGeneration`.
- **Exit now settles first what the exit desk waits on.** From r13d the desk lists nothing while a record of the vault
  awaits its booking (a repayment, a refund, a loan past its end), and refuses the listing (`SettlementPending`).
  `earn_exit_now`, `earn_exit_list` and a listing `rehypo_exit_now` read those records (`pendingSettlements(vault)`) and
  settle them first: one `settle(ids)` step on the vault per 32, `again`, the view's `loanId` and `need` null; the action
  is prepared again once they are booked. A desk before r13d answers no such read, and the plans list as before.
  `earn_exit_list`'s view now has `loanId` and `need` nullable. `Chain` adds `pendingSettlements`.
- **A partner vault's exit now (Intent D57), as gage.cash offers it.** `earn_exit_now { wallet, vault, amount? }` (and
  `gage_prepare_earn_exit_now`, `gage_earn_exit_now`) is for a holder whose balance is more than the vault can pay now:
  an exact approval of the chain's exit desk for the shares when the one standing falls short, then `exitNow(vault,
  shares, id)`, the shares worth `amount` of the vault's asset at today's share value (all of them when omitted) and the
  holding `id` chosen as the app and keeper choose it for what the vault cannot pay of them. Its `preview` (`kind:
  "exit_now"`) has what the wallet receives, what the vault can pay now, about what it gives up (the app's
  `exitGiveUp`), and the steps: ask now, the loan sold in about ten minutes, collect any time, the request ending after
  the desk's `EXIT_LIFE` (24 h). Refused, in fixed words, for what the vault can pay now (a withdrawal, not an exit) or no
  balance (`NOTHING_TO_EXIT`), past the balance (`EXCEEDS_BALANCE`), under one share (`TOO_SMALL`), while exits are
  closed (`EXITS_CLOSED`), beside an exit already open (`EXIT_OPEN`), while the vault is paused (`PAUSED`), and
  `NO_SHORTFALL` and `NO_LOAN_TO_LIST` (both retryable); a lapsed exit is committed again, and a vault due a settlement
  is settled first. Then `earn_exit_list` (the next holding once the last listing ended unsold: `NO_EXIT`, `LISTING_LIVE`,
  `EXIT_LAPSED`, `NO_SHORTFALL`, `NO_LOAN_TO_LIST`), `earn_exit_cancel` (`cancel(vault)` on the desk the factory bound, so
  while exits are closed too) and `earn_exit_collect { wallet, asset? }` (`withdraw(asset)` for what the desk owes,
  every asset when omitted). `portfolio` adds each Earn holding's open exit (`exit`: shares, `committed`, `stage`
  listed, next, closed, payable or lapsed, `loanId`, `listingEndsAt`, `lapsesAt`) and `exitOwed`, and `collect`
  withdraws what the desk owes beside the rest (`view.exits`), where a release names a desk. Served where a current
  generation names its exit desk, so on the bundled testnet from r13, not yet on mainnet; not limited by `gage-mcp`'s
  spend limits. `Chain` adds `boundExitDeskOf`, `exitShortfall` and `earliestMaturity`; `exitShares`, `exitCommitted`,
  `exitStage`, `chooseExitHolding`, `exitFit`, `exitNeed` and `EXIT_KEEP_BPS` are exported with the rest of the choice. A
  preview's `when` says a day in hours (`24 h`), as the app counts a request.
- **Previews, and gage's card for them (`gage-sdk/visual`).** An action that pays out over time adds `preview` to its
  prepared plan: what the wallet receives, what of it can be paid now, about what it gives up (its share of what the
  vault's loans have still to earn, read from gage's index as the app reads it; null while the index cannot say), and
  its steps in time, as raw amounts and a few words. A rehypo pool's exit now has one: ask now, a loan sold in about ten
  minutes, remove before the source's hour ends. `renderPreview(preview, { theme })` from the new `gage-sdk/visual`
  entry draws it as gage's card, one self-contained SVG, light or dark. The vault accounting read gains the index's
  `loans` and `asOf`, and `stillToEarn` reads them.
- **A rehypo pool's exit now (root D357).** `rehypo_exit_now` (and `gage_prepare_rehypo_exit_now`, `gage_rehypo_exit_now`)
  prepares `exitNow(id)` on a rehypo source for an LP whose share of it is more than it can pay now: the source commits
  its partner-vault shares at the chain's exit desk (Intent D57), which lists the loan `id` chosen as gage's app and
  keeper choose it (`chooseExitLoan(reads, need, now)`, or `chooseExitHolding` for the holding, exported with
  `exitFit`, `exitNeed` and the rest of the choice): the smallest holding that covers what the vault cannot pay of the
  source's commitment, else the largest,
  since only that part falls to book; or none while the source's own listing is live. The view carries `need`,
  `endsAt` (the source's `EXIT_HOLD` after this ask: remove before it, since gage's keeper then ends the exit) and
  `lapsed` (the source's open commitment had passed the desk's `EXIT_LIFE`, and this ask renews it); `NO_SHORTFALL` refuses an ask the desk would not list for. Served where a current generation names its exit desk (`Generation.exitDesk`, from `intentV1.exitDesk` and
  `intentV1Assets.<SYM>.exitDesk`); the bundled testnet's names r13's, mainnet's none yet. A vault due a settlement is settled first.
  `Chain` adds `rehypoSource`, `exitDeskOf`, `lenderMarket`, `exitOf`, `exitOwed`, `vaultPreviewWithdraw`,
  `exitVaultBook`, `exitRecords`, `exitRecord`, `accrualEnd`, `saleSlots`, `exitListing`, `exitAsk` and `withinAverage`. Not limited by `gage-mcp`'s spend limits: money comes back.
- **`sync-deployment` bundles the exit desk each generation names** (`exitDesk`, Intent D57), current or retained, which
  the SDK reads to serve exit now and to collect what its sales paid. Without it a bundled release served none of the
  exit actions where the live one names a desk.
- **Lend generations found on chain (r13).** Where the bundled manifest names the release's `generationDeployer`, a Gage
  adds every lend generation deployed through it since, read from gage's index (`GET /intent/generations`) at most once a
  minute before a method runs, so a new stablecoin market reaches builders and agents with no new release. Each joins the
  manifest's generations as any other, listed once its owner lists it; an answer that cannot be read leaves the bundled
  generations as they are. `refreshGenerations()` asks now; `mergeFoundGenerations` and `foundGenerationsRefresher` serve a
  context built by hand (the hosted service's). A Gage's `deployment` is the latest one read.
- **sGAGE on a stablecoin lend market (R2 option C).** A generation whose release says its own registry quotes its
  rewards (`engine.rewardTerms` "registry", unbridged) pays them from its core's ledger, a treasury-funded budget that
  reverts the fill activating a loan when it is short. A listing there asks for them (`withRewards`) only while that
  budget covers the registry's quote for the core's fee, read as the transaction is built: `borrow`, a put's opening
  loop, `roll` and `put_roll`. Everywhere else, USDG's bridged core included, a listing asks for none and reads nothing
  more, as before; an instruction to roll by itself keeps asking for none. `Engine` adds `registryRewards`; `Chain`
  adds `rewardsQuote` and `rewardsBudget`.
- **A vault's free cash and when more comes back.** `vaultFreeCash({ vault })` (and `gage_vault_free_cash`) says what
  one partner vault pays withdrawals from now (`freeCashUSDG`, or `freeCash` in a lend asset's vault), what comes back
  to it as its loans end, one entry a day (`schedule: [{ by, amountUSDG }]`, `by` the day's last end in Unix seconds),
  and what loans past their end bring back once settled (`settlingUSDG`), all only if their borrowers repay: a loan not
  repaid brings back its collateral, for the vault's holders, instead of cash. With them, `bufferBps`, the share of the
  vault a new loan must leave free ("Cash kept free", set at creation and in Manage), and `settlementDue`. The figures
  come from gage's index (`liquidity.schedule` and `liquidity.settling` on a vault's accounting); an index that does not
  serve them yet answers `schedule` and `settlingUSDG` as `null`, never as nothing to come. A vault is re-identified on
  chain first, as the actions do (`UNKNOWN_VAULT` otherwise). The input schema is exported as `vaultInput`.
- **Pool vaults (D333).** `createPoolVaults` answers the calls that create a DEX pool's vaults, one for each pool token
  gage lends, each on its own generation's factory and simulated from the curator: what both share named once (`term`,
  `feeBps`, `priorityFeeBps`, `minRateGrade`, `buyLoans` for the USDG vault alone), and in `sides` each token's largest
  loan and the cash it keeps free (`cashKeptFreeBps`, 10% when omitted). Neither vault lends against the pool's own
  two tokens: a side's default collateral leaves them out, and a side naming one is refused unless `allowPoolTokens`
  is true. It answers `calls` for one wallet batch
  (EIP-5792) and `safeBatch`, the same calls as a Safe{Wallet} Transaction Builder file with its checksum. A pool token
  gage lends no vault of, or one whose generation does not admit the curator, gets none, and the answer says why.
  `poolVaults` finds the pools among the partner vaults: one curator's vaults whose names end in the pool's tag
  (`Fables NVDA/USDG`), each side its vault and gage.cash page. `poolVaultTools(gage)` serves both as tools
  (`gage_pool_vaults`, `gage_create_pool_vaults`), apart from `gageTools`. New refusals: `POOL_TOKENS_SAME`,
  `UNKNOWN_TOKEN`, `NAME_TOO_LONG`, `SIDE_NEEDED`, `MAX_LOAN_TOO_HIGH`, `MIXED_COLLATERAL`, `POOL_TOKEN_COLLATERAL`,
  `NOT_LENT`, `NOT_A_PARTNER`, `FACTORY_CHANGED`. `Chain` adds `intentFactory`.
- **Park and unpark.** An out-of-range liquidity position holds one token and earns no fees: `park` pulls its whole
  liquidity out on its own DEX and deposits that token into the partner vault named, which must take it (USDG in a USDG
  vault, a lend asset in its own; ETH and WETH are refused, `ETH_NOT_SUPPORTED`); `unpark` withdraws from a vault, up to
  what it can pay the wallet now, and mints a new position in [`tickLower`, `tickUpper`]. Both run from the LP's own
  wallet with no gage contract between, their calls built from one reading of the chain: `parkCalls` and `unparkCalls`
  answer them as one batch for `wallet_sendCalls` (EIP-5792), simulated whole first; `prepare` answers every
  transaction at once (`calls`); `run` sends them in order. Uniswap v3 and SushiSwap v3 positions are pulled with
  `decreaseLiquidity` then `collect`, Uniswap v4 ones (hooked pools too) with DECREASE_LIQUIDITY then TAKE_PAIR, Ramses
  ones after three minutes from their last liquidity change (`RAMSES_WAIT`), Fables receipts with the hook's
  `withdraw`; the minimum is the amount the position holds, so a price back in its range reverts the pull. A vault of a
  native ERC-4626 generation takes `deposit(assets, receiver)` and pays `withdraw(assets, receiver, owner)` within
  `maxWithdraw`; an earlier one its slippage-held entries. A v4 mint goes through Permit2, its native ETH sent along and
  swept back.
- **Park pools.** `parkPositions(wallet, also?)` (tool `gage_park_positions`) lists a wallet's out-of-range positions,
  read straight from each DEX, never through the LP lane: the release's LP lane pools whatever the lane's switch
  (`deployment.parkPools`, `capabilities().parkPools`), and a DEX's own (`createGage({ parkPools })`: a v3-style pool by
  its address, tokens, fee and tick spacing; a Uniswap v4 or Fables pool by its key). `sync-deployment` now bundles a
  hidden LP lane, which serves no lending action, and the release's `WETH` (`deployment.weth`). Park and unpark are
  served where there is a pool (`actionsOn`): the testnet's release today. New refusals: `UNKNOWN_POOL`, `IN_RANGE`,
  `NOTHING_TO_PARK`, `PRICE_UNAVAILABLE`, `RAMSES_WAIT`, `ETH_NOT_SUPPORTED`, `VAULT_ASSET_MISMATCH`,
  `VAULT_ASSET_NOT_IN_POOL`, `RANGE_WITHOUT_ASSET`, `RANGE_NEEDS_ETH`, `INVALID_RANGE`.
- **Puts, where a lend asset offers them.** A release may name a lend asset's loop router and put router and list USDG
  among its collateral; then `put_open` borrows that asset against your USDG margin and the USDG the loan buys, `size`
  times the margin pledged in all, sized so the loan buys its purchase with 25 bp spare; `put_close` repays a loan out
  of its own pledge and returns the rest; `put_roll`, `put_auto_roll` and `put_cancel_auto_roll` roll it through the put
  router, buying each top-up with USDG. `putQuote` (and `gage_put_quote`) previews one. Served only where the deployment
  names the routers (`actionsOn`): the testnet's release on NVDAx since 22 October 2026, mainnet's none yet.
  `leverage` still lends USDG alone: on a lend asset it is refused `LEVERAGE_CLOSED`, pointing to `put_open`.
- **A put's approvals count the wallet's other puts as the chain holds them** (the class of F18, the audit of 1
  November 2026), as a roll's do (0.6.2): `put_roll` and `put_auto_roll` read each loan gage's index names from its
  core, its principal and its pledge the core's, and refuse while the index leaves out a right the core counts
  (`UPSTREAM_UNAVAILABLE`, retryable).
- **The deployment carries each generation's `loopRouter`, `putRouter` and `loopPools`**, and a lend asset's
  `cashoutPools` are bundled.
- **`collect` counts a vault's pocket in any token but its own asset as collateral recovered** (`view.recovered`), never
  as earnings: a USDG pocket of a lend asset's vault is a defaulted put's pledge.
- **`collect` counts backing added to a written-off loan apart from earnings** (`view.backing`, by asset, on its own
  row: "Backing for written-off loans", "… in GLDx" for a lend asset's vault): a vault's pocket in its own asset that
  gage's index names `RECAPITALIZATION` (`recapitalize`), never counted as earnings.
- **The LP lane, where a release makes it public.** Fixed-cost USDG loans against an ETH/USDG liquidity position on
  Uniswap v3 or v4, SushiSwap v3 or Ramses, with no liquidation: a loan is never closed early because a price moves, and
  one not repaid by its end is settled by unwinding the position for its lenders. Uniswap v4 positions are found
  through gage's index (`GET /lp/positions`) and checked on chain, and valued at their pool's price read from the
  StateView by pool id; a native ETH pool's fees come as WETH, and a v4 position leaves any subscription it has when it
  moves into escrow, as `lp_borrow`'s summary says.
  Reads `lpPositions`, `lpQuote`, `lpLoans` and `lpVaults` (tools `gage_lp_positions`, `gage_lp_quote`, `gage_lp_loans`,
  `gage_lp_vaults`), the lane in `capabilities()` (`lpLane` and one rule, `LP_RULE`) and in `portfolio()` (`lp`). Actions
  `lp_borrow` (the position approved to the lane's core, the borrow on a quote asked for again past a minute before it
  runs out, then the USDG credited withdrawn), `lp_repay`, `lp_return_position`, `lp_collect`, `lp_withdraw`,
  `lp_deposit`, `lp_redeem` and `lp_claim_bonus`. Served only where the deployment names a public `lpLane`
  (`actionsOn`): the testnet's release since 22 October 2026, mainnet's none yet; the LP reads are served whatever
  actions a Gage serves.
- **The deployment carries `lpLane`**, read and checked by the rules of `shared/lp-lane.mjs` (`parseLpLane`; a Uniswap v4
  or Fables adapter names its PoolManager, and its pools their `poolId`, `native` and `hooks`): a hidden
  lane reads as none, and `sync-deployment` bundles the lane only while it is public. New refusals: `LP_CLOSED`,
  `UNKNOWN_ADAPTER`, `POSITION_NOT_FOUND`, `NOT_OWNER`, `NOT_REPAID`, `VAULT_IMPAIRED`, `DEPOSITS_CLOSED`,
  `NOTHING_TO_WITHDRAW`, `NO_BONUS`, and the rates service's LP refusals by their own codes.
- **LP rolls and Fables positions.** `lp_roll` rolls a running LP loan, before its end, into a new loan on the same
  position on the rates service's quote for it (`loan=`, held to the old repayment and the net it names): the wallet
  pays what the new loan, less its fee, lacks of the old repayment (approved exactly), or is credited the rest and
  withdraws it; the new loan is named from the `Rolled` event. Fables positions (wrapped receipts) list and borrow as
  v4 ones; receipts not wrapped yet are listed apart (`lpPositions(...).fablesReceipts`), and `lp_borrow` takes them by
  `rangeId`, unstaking any staked, approving them to the wrapper and wrapping them before it borrows against the
  position they make. `lp_wrap` and `lp_unwrap` wrap and unwrap alone, served where the lane has a Fables adapter. New
  refusals: `NOT_FABLES`, `NOTHING_TO_WRAP`, `FABLES_PAUSED` (retryable), and the rates service's roll refusals
  (`NOT_ACTIVE`, `PAST_TERM`, `NOT_BORROWER`, `NOT_SAME_POSITION`). `run()` asks a spend limit again when a plan
  planned again is another action's, so a borrow against receipts is limited by its loan once the wrap is mined.
- **The deployment reads the lane's D318 keys** as shared/lp-lane.mjs does: `vaultFactory` (`lpLane.vaultFactory`, null
  where the release names none) and a `v4-one-pool` sale executor named by its pool's id (`poolId`).
- **`sync-deployment` bundles a public lane whole**: its `vaultFactory` and each `v4-one-pool` executor's `poolId`, and a
  lane that names no list of vaults. Without them the SDK's own reader refused the bundle (a D319 lane lists no vault of
  its own), and with it `createGage()` on that network.
- **Curators' vaults, mandates and stock LPs (D318).** `lpVaults()` lists the vaults curators opened through the lane's
  factory beside the release's (`factory`), each with its `curator`, its `mandate` (each pool, from when it funds) and
  the plain words of `funds`, and `allowed` (false once the registry stops it lending, when `lends` is false too).
  Quotes, borrows, rolls, deposits, withdrawals and bonuses take a factory vault as any other (checked on chain with
  `isVault`, named by `nameOf`); `lp_deposit` is refused `VAULT_NOT_LENDING` for a vault the registry no longer lets
  lend. New actions: `lp_create_vault` (a curator the registry allows; served where the release names the factory),
  `lp_vault_add_pool` (funding three hours later) and `lp_vault_remove_pool` (at once), refused `NOT_CURATOR`,
  `NO_VAULT_FACTORY`, `NO_MANDATE`, `POOL_IN_MANDATE`, `POOL_NOT_IN_MANDATE`, `TOO_MANY_POOLS` or `POOL_NOT_ALLOWED`.
  Stock LPs (a Stock Token paired with USDG, in either order, on Uniswap v3 or v4) list, value and borrow as ETH ones;
  `VAULT_CANNOT_FUND` and `PRICING_UNAVAILABLE` say in fixed words that a vault funds only its mandate's pools and a
  stock position is priced only while its market is open.
- **ERC-4626 LP vaults (D319).** An LP vault's shares are an ERC-20 (`gLP`) that moves between wallets, counted in the
  vault's own decimals: `shareDecimals` in `lpVaults()`, `portfolio().lp`, `lp_deposit` and `lp_redeem` is read from its
  `decimals()` (`lpShareUnit`, `lpSharesText`), 18 for a vault opened since D331 and 12 for one opened before it:
  holdings are read with `balanceOf`, so `portfolio().lp` and `lp_redeem` count shares the wallet received by
  transfer, and `lpVaults()`'s `totalShares` is the token's `totalSupply()`. `lp_deposit` calls
  `deposit(assets, wallet, minShares)` and `lp_redeem` `redeem(shares, wallet, wallet, minAssets)`, every share the free
  cash pays being the vault's own `maxRedeem` when none are named; refusals stay `VAULT_IMPAIRED`, `DEPOSITS_CLOSED`,
  `EXCEEDS_BALANCE` and `INSUFFICIENT_LIQUIDITY`. `lp_create_vault` asks the registry's `mayOpenVault`, so it serves
  any wallet once the registry's owner opens vault creation (`NOT_CURATOR` until then for a wallet it does not allow).
- **A deposit into a partner vault, or a withdrawal from one, carries the gas its reward claims take.** Each claims
  sGAGE for every open reward record of the vault, which an estimate taken in a second with nothing to claim does not
  see: sent with the estimate and a fifth, all 28 such calls of a mainnet fork ran out of gas or reverted
  `RewardsPending` (21 October 2026). The step now adds 250,000 for each open record and two more, the count read from
  the vault's storage for its mandate version (`mandateVersion` of the index's vault), and a full book's 64 when it
  cannot be read, as gage.cash sends them. `prepare`'s `gas` includes it, and `run()` adds it to its fifth. A limit is
  held to the chain's 32,000,000 a transaction and its L1 part, never under the estimate. A `Chain` names `storageAt`.
- **Nothing rolls a loan on a retired generation, and gage-sdk no longer says it does.** A generation the release keeps
  for its positions alone (`intentV1Previous`, `intentV1AssetsPrevious`) keeps its routers, but gage's keeper rolls
  through current generations' routers only and the rates service quotes no roll of a retained one. On a loan there,
  `roll`, `auto_roll`, `put_roll` and `put_auto_roll` are refused before anything is priced (`ROLLOVER_CLOSED`,
  `PUT_CLOSED`, "generation retired"); `loan()` lists none of them and shows neither instruction (`autoRoll` and
  `putAutoRoll` are `null`), `portfolio()` reads its `autoRoll` as false, and an open loan there carries a `note`
  saying so. `cancel_auto_roll`, `put_cancel_auto_roll` and `put_close` still go through its own routers, and
  `actionsOn` serves them wherever a retired generation names one. Before, such a loan was offered rolls, and read as
  rolling by itself, that nothing would run: left to one, it would end unpaid and its lenders keep the collateral.

## 0.6.2 (never published; released in 0.7.0)

- **A Rates API key, for the model's whole quote (D382).** `createGage({ apiKey })` sends it as `Authorization: Bearer`
  to gage's rates service, and only there (`createUpstream(url, fetch, { apiKey })`). Nothing here needs one: without a
  key the rates service answers its slim quote (the cost, amounts, limits and the amount-to-cost curve every action
  reads) under a ceiling a minute per address. A `429` from any of gage's services is now `RATE_LIMITED` (retryable),
  where a borrow's curve read it as `NO_SUGGESTION`.
- **A roll's approval covers the wallet's other loans rolling over by themselves** (the staging review's R4, F20 of
  the first). `roll` and `auto_roll` approve the loan's asset to the rollover router for this loan's need plus what
  the wallet's other standing instructions on that router still need: each counts its loan's repayment for its next
  roll, then its principal and `maxCost` for each roll after. An approval replaces the one before it, so one sized for
  a single loan took the others' budgets, and their rolls missed. `auto_roll`'s `allowance` is the whole approval and
  its view adds `otherAutoRolls`; both plans say so in a note when other loans count. Nothing is prepared while the
  wallet's loans cannot be read (`UPSTREAM_UNAVAILABLE`). `cancel_auto_roll` still approves nothing.
- **That approval counts the wallet's loans as the chain holds them** (the class of F18, the audit of 1 November 2026).
  gage's index only names the wallet's loans waiting for funding or running: each is read from its core (`ownerOf`,
  then `getLoan`), counted once while the wallet holds its right, at the core's principal and cap, and the list is held
  to the core's count of the wallet's rights (`balanceOf`). A wrong or hostile index could otherwise inflate the
  approval, or leave a loan out and the router short of its rolls, which then missed. While the index leaves out a
  right the core counts, a lagging one included, nothing is prepared (`UPSTREAM_UNAVAILABLE`, retryable). `Chain` adds
  `rights(engine, owner)`, which `fakeChain` answers with 1.

## 0.6.1 (never published; released in 0.7.0)

- **Mainnet's rollover executor is gage's new filler** `0xCB14554904b86b3472F960740aE377b5b711A659` (D324). A standing roll
  instruction made with 0.6.0 named the old one, which no longer rolls loans; set it again with 0.6.1.

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
