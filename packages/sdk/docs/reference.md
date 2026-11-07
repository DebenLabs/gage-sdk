# gage-sdk reference

Generated from the SDK's own schemas and tool catalogue by `test/reference.test.ts`, which fails until a change is written
back (`pnpm --filter gage-sdk test -u`). Amounts are raw integers as decimal strings, times Unix seconds, terms seconds.
Answers are described in the [README](../README.md#reads), and every refusal code in its [Errors](../README.md#errors).
Which actions a network serves: `gage.actions` and `capabilities().actions`.

## Methods

`createGage(options?)` takes `network` (`"mainnet"`, the default, or `"testnet"`), `manifest`, `rpcUrl`, `indexerUrl`,
`ratesUrl`, `valuationUrl` (`null` leaves leverage to the deployment's pools), `apiKey`, `fetch`, `now`, `actions` (serve
fewer) and `parkPools`. `capabilities()`, `assets()`, `earnVaults()`, `lpVaults()` and `refreshGenerations()` take no
input. `prepare(input)` and `run(input, signer, options?)` take an action below (`run` without `wallet`);
`parkCalls(input)` and `unparkCalls(input)` take `park`'s and `unpark`'s input without `action`.

### `borrowQuote(input)`

`maxCollateral` for the largest loan the vaults fund, or `collateral` and `principal` (with `costBps` for a cost of your own) for one exact loan.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `token` | address | yes | A token's address, as `assets()` lists it |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `wallet` | address | no | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `lendAsset` | address | no | The asset the loan is paid in and repaid in: USDG when omitted, or a lend asset gage_capabilities lists (its token address) |
| `maxCollateral` | raw amount | no | Most of the token to pledge, raw units: quotes the largest loan the vaults fund for it, at the lowest fixed cost they accept |
| `collateral` | raw amount | no | With principal: the exact pledge of one chosen loan, raw units |
| `principal` | raw amount | no | With collateral: the exact amount to borrow, raw units of the loan's asset; priced at the lowest fixed cost the vaults funding it accept, or at costBps |
| `costBps` | number 0.1 to 5000 | no | With collateral and principal: your own fixed cost for the loan instead, bps of the amount borrowed, to a tenth (more digits are rounded); the quote's grades say what each Loan grade costs |

### `leverageQuote(input)`

A loop's amounts and cost.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `token` | address | yes | A token's address, as `assets()` lists it |
| `own` | raw amount | yes | The tokens you put in, raw units |
| `multiple` | number 1.1 to 3 | yes | Leverage, 1.1 to 3 with at most two decimals (2 = twice the pledge held for the loan) |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `wallet` | address | no | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `lendAsset` | address | no | USDG only: leverage lends USDG (a loop in a lend asset is refused; a lend asset's puts open with put_open) |

### `putQuote(input)`

A put's pledge, loan and cost, where a lend asset offers puts.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `lendAsset` | address | yes | The asset the put borrows against USDG: a lend asset gage_capabilities lists with a putRouter (its token address) |
| `margin` | raw amount | yes | The USDG you put in, raw units (6 decimals): the most the put can lose |
| `size` | number 1.1 to 10 | yes | The put's size, 1.1 to 10 with at most two decimals: its whole USDG pledge over the margin you put in (4 = the margin and three times it bought with the loan) |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `wallet` | address | no | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |

### `loan(input)`

One loan.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted |

### `waitForFill(input, options?)`

Waits for a listing to be funded; `options`: `timeoutSeconds` (300), `pollSeconds` (10).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted |

### `vaultFreeCash(input)`

One partner vault's free cash.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `vault` | address | yes | A partner vault, as gage_earn_vaults lists it |

### `portfolio(wallet), balances(wallet), lpPositions(wallet), lpLoans(wallet)`

A wallet's loans and holdings, its balances, its LP positions, its LP loans.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that will sign |

### `parkPositions(wallet, also?)`

A wallet's out-of-range positions in the pools park serves.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that holds the positions |
| `also` | list of at most 100 | no | Positions to read beside those found, by their manager and id: a Uniswap v4 PositionManager and a Fables hook cannot list a wallet's |
| `also[].manager` | address | yes |  |
| `also[].id` | id (decimal string) | yes | The position's id at its manager (gage_park_positions id): its NFT's token id, or a Fables range's id |

### `lpQuote(input)`

A quote against one LP position.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `adapter` | address | yes | The position's adapter: one gage_capabilities lists under lpLane.adapters (Uniswap v3, SushiSwap v3, Ouro v3, Ramses V3, Uniswap v4 or Fables; gage_lp_positions names each position's) |
| `tokenId` | id (decimal string) | yes | The position's id: its NFT's token id at the adapter's position manager (gage_lp_positions) |
| `wallet` | address | yes | The wallet that holds the position and will borrow: the quote is signed for it |
| `term` | integer, positive | yes | Loan term in seconds, one of gage_capabilities lpLane.terms |
| `vault` | address | no | The LP vault to borrow from; the lane's first one that can fund the loan whole when omitted |

### `poolVaults(input?)`

The pools among the partner vaults.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `curator` | address | no | Only this curator's pools; every curator's when omitted |

### `createPoolVaults(input)`

The calls that create a pool's vaults, from its curator.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `curator` | address | yes | Who manages both vaults, for good: the wallet or Safe that sends the calls. Any address while a generation's creation is open (mainnet's since 5 November 2026), otherwise one gage admitted as a partner there |
| `name` | string | yes | The name before the pool's tag: "Fables" names both vaults "Fables NVDA/USDG" |
| `pool` | list of at most 2 | yes | The pool's two tokens, in its order |
| `term` | number or number | yes | The longest loan both vaults fund, in seconds: 604800 (7 days) or 1814400 (21 days) |
| `feeBps` | integer 500 to 1500 | yes | The performance fee both charge on each loan's profit, bps, 500 to 1500; the protocol receives 10% of it |
| `priorityFeeBps` | integer 0 to 5000 | no | The most each vault pays the protocol for a loan, bps of its profit, 0 to 5000: the vault paying most is funded first. 2000 when omitted |
| `minRateGrade` | integer 0 to 4 | no | The lowest Loan grade both fund, 0 (any) to 4 (A, the model's price or more). 3 (B, 90% of it) when omitted |
| `buyLoans` | object | no | Each vault buys running loans other vaults of its generation sell, when they pay at least the model's return plus this; off when omitted. Before mandate 13 (Intent D56) only the USDG vault buys |
| `sides` | list of at most 2 | yes | What is counted in each token, one entry for each pool token gage lends: its largest loan, and the cash it keeps free |
| `sides[].token` | string | yes | The pool token this side lends, as `pool` names it |
| `sides[].maxLoan` | raw amount | yes | The most this vault puts into one loan, raw units of its token (USDG: 6 decimals) |
| `sides[].cashKeptFreeBps` | integer 0 to 10000 | no | The share of the vault a new loan must leave free, in cash or in its reserve, bps, 0 to 10000: what the pool can draw on. 1000 (10%) when omitted |
| `sides[].collateral` | list of at most 64 | no | The tokens this vault lends against, of one universe (real-world assets, or the Robinhood ecosystem). When omitted: every token its generation admits in the universe of the pool's other token, less the pool's own two tokens (a stock's vault: the memes paired with it). Naming a pool token is refused unless allowPoolTokens is true |
| `allowPoolTokens` | boolean | no | true lets a side's collateral name one of the pool's own two tokens, which a fall in that token would then hit twice: in the pool and in the vault's loans. When omitted or false, naming one is refused (POOL_TOKEN_COLLATERAL); a side that names no collateral never lends against them either way |

### `createVault(input)`

The call that creates one partner vault, from its curator.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `curator` | address | yes | Who manages the vault, for good: the wallet or Safe that sends the call. Any address while its generation's creation is open (mainnet's since 5 November 2026), otherwise one gage admitted as a partner there |
| `name` | string | yes | The vault's name, as depositors see it: 1 to 48 bytes, no control or invisible characters. Its manager may change it |
| `asset` | address | no | The asset the vault lends: USDG when omitted, or a lend asset gage_capabilities lists (its token address) |
| `universe` | string | no | What it lends against: rwa (stocks and commodities) or ecosystem (meme and utility coins); it can never lend against both. rwa when omitted, a non-stable asset's vault always ecosystem |
| `collateral` | list of at most 64 | no | The tokens it lends against, of one universe; every token its generation admits in `universe` when omitted |
| `term` | number or number | yes | The longest loan it funds, in seconds: 604800 (7 days) or 1814400 (21 days) |
| `feeBps` | integer 500 to 1500 | yes | The performance fee on each loan's profit, bps, 500 to 1500; the protocol receives 10% of it. Fixed for good |
| `maxLoan` | raw amount | yes | The most it puts into one loan, raw units of its asset (USDG: 6 decimals) |
| `cashKeptFreeBps` | integer 0 to 10000 | no | The share of the vault a new loan must leave free, in cash or in its reserve, bps; 0 when omitted |
| `priorityFeeBps` | integer 0 to 5000 | no | The most it pays the protocol for a loan, bps of its profit, 0 to 5000: the vault paying most is funded first. 2000 when omitted |
| `minRateGrade` | integer 0 to 4 | no | The lowest Loan grade it funds, 0 (any) to 4 (A, the model's price or more). 3 (B, 90% of it) when omitted |
| `buyLoans` | object | no | It buys running loans other vaults of its generation sell, when they pay at least the model's return plus this; off when omitted |
| `buysOnly` | boolean | no | true: it buys running loans alone and funds no new loan, for good; needs buyLoans |

### `vaultOnChain(input)`

One partner vault from the chain alone, and what it can pay a holder now.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `vault` | address | yes | A partner vault |
| `wallet` | address | no | A holder: adds its shares, what they are worth, what the vault can pay it now, and the call that withdraws that |

## Actions

Each action is prepared with `prepare({ action, wallet, … })` and carried out with `run({ action, … }, signer)`. Its tools
are `gage_prepare_<action>` and, for a signer, `gage_<action>`.

### `borrow`: Borrow

Borrow: pledge a token, receive USDG (or the lend asset named by lendAsset), repay a fixed amount of it within the term. Use the prepare object of gage_borrow_quote, without its action.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `token` | address | yes | A token's address, as `assets()` lists it |
| `collateral` | raw amount | yes | Tokens to pledge, raw units |
| `principal` | raw amount | yes | To borrow, raw units of the loan's asset (USDG: 6 decimals) |
| `cap` | raw amount | yes | To repay, raw units of the loan's asset, above principal |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `lendAsset` | address | no | The asset the loan is paid in and repaid in: USDG when omitted, or a lend asset gage_capabilities lists (its token address) |

### `leverage`: Open a loop

Open a leveraged loop: the loan buys more of the pledged token in one transaction. USDG only. Refused above maxCostBps.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `token` | address | yes | A token's address, as `assets()` lists it |
| `own` | raw amount | yes | The tokens you put in, raw units |
| `multiple` | number 1.1 to 3 | yes | Leverage, 1.1 to 3 with at most two decimals (2 = twice the pledge held for the loan) |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `maxCostBps` | integer 1 to 5000 | yes | Highest loan cost you accept, bps of the amount borrowed; the loop is refused above it |
| `lendAsset` | address | no | USDG only: leverage lends USDG (a loop in a lend asset is refused; a lend asset's puts open with put_open) |

### `cancel`: Cancel a listing

Cancel a loan still waiting for funding and take its collateral back.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted, the loan's own core for a loan in a lend asset |

### `reclaim`: Repay a loan

Repay a running loan in full, in the asset it is paid in, and take the collateral back, before its term ends.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted, the loan's own core for a loan in a lend asset |

### `cash_out`: Cash a loan out

Cash a running loan out: its whole collateral is sold through an aggregator, the loan repaid from the sale, and the rest less gage's 0.5% fee paid to the wallet, in one transaction.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted, the loan's own core for a loan in a lend asset |
| `maxSlippageBps` | integer 1 to 100 | no | Most the net you receive may fall below the quote, in bps of it; 50 when omitted |
| `minNet` | raw amount | no | The least you accept to receive, raw units of the loan's asset (USDG: 6 decimals): the cash-out is refused under it, and its transaction reverts under it |

### `roll`: Roll a loan over

Roll a running loan over: a new loan of the same size on the same pledge repays it in full, and the wallet adds the difference (the old loan's cost and the new fee) or keeps what is over.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted, the loan's own core for a loan in a lend asset |
| `term` | integer, positive | no | The new loan's term in seconds, one gage_capabilities lists; the loan's own term when omitted |

### `auto_roll`: Roll a loan over by itself

Leave a loan to roll over by itself: gage's keeper rolls it in its last hours into a loan of the same size and term, at most maxCost each, up to four times. Leaves standing approvals to gage's rollover router.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted, the loan's own core for a loan in a lend asset |
| `maxCost` | raw amount | no | The most each new loan may cost, its fixed cost and origination fee together, raw units of the loan's asset, at most the loan's principal; when omitted, twice what a roll of the loan costs now, held to four times the loan's own cost and fee (a listing not funded yet: twice its own cost and fee) |

### `cancel_auto_roll`: Stop rolling a loan over

End a loan's instruction to roll over by itself.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted, the loan's own core for a loan in a lend asset |

### `earn_deposit`: Deposit into Earn

Deposit into a partner vault (lending), in the asset the vault takes: USDG, or its lend asset.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | A partner vault, as `earnVaults()` lists it |
| `amount` | raw amount | yes | To deposit, raw units of the vault's asset (USDG: 6 decimals) |
| `maxSlippageBps` | integer 0 to 500 | no | Most the conversion may move against you, in bps; 50 when omitted |

### `earn_redeem`: Withdraw from Earn

Withdraw from a partner vault, everything it can pay when shares is omitted.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | A partner vault, as `earnVaults()` lists it |
| `shares` | raw amount | no | Shares to redeem, raw (18 decimals); all when omitted, less what a vault of an asset with more than 6 decimals cannot pay after a loss (a millionth of the asset at most) |
| `maxSlippageBps` | integer 0 to 500 | no | Most the conversion may move against you, in bps; 50 when omitted |

### `collect`: Collect what is ready

Collect what is ready here: USDG and lend assets from loans, collateral back, vault earnings, the collateral and backing of loans the vaults wrote off (never counted as earnings), the sGAGE of loans and partner vaults, and what exit now sales paid; a claim that would revert now is left out, and said. The first vault's credits and claims, earlier engines' lender recoveries, retired Earn strategies and the GAGE/sGAGE pool's rewards and Drip are collected on gage.cash.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that will sign |

### `feedback`: Rate gage

Rate gage (agent #8845 in ERC-8004) in its Reputation Registry: your own score from 0 to 100, once a wallet, public on chain. Optional: gage offers nothing for a rating.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `score` | integer 0 to 100 | yes | Your own rating of gage, a whole number from 0 (worst) to 100 (best) |

### `put_open`: Open a put

Open a put: borrow a lend asset (lendAsset) against USDG, whose loan buys more USDG and pledges it with your margin, size times the margin in all, in one transaction. It gains as the asset falls, and its loss stops at the margin. Refused above maxCostBps. Use the prepare object of gage_put_quote, without its action.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `lendAsset` | address | yes | The asset the put borrows against USDG: a lend asset gage_capabilities lists with a putRouter (its token address) |
| `margin` | raw amount | yes | The USDG you put in, raw units (6 decimals): the most the put can lose |
| `size` | number 1.1 to 10 | yes | The put's size, 1.1 to 10 with at most two decimals: its whole USDG pledge over the margin you put in (4 = the margin and three times it bought with the loan) |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `maxCostBps` | integer 1 to 5000 | yes | Highest loan cost you accept, bps of the amount borrowed; the put is refused above it |

### `put_close`: Close a put

Close a put, or any loan on a core with a put router, out of its own pledge: the pledge buys the repayment back and the rest comes back to the wallet, in one transaction (a loan of a lend asset against USDG, opened with put_open: it gains as the asset falls, and its loss stops at the USDG put in).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | yes | The loan's core: its lend asset's (gage_capabilities lendAssets) |
| `maxSlippageBps` | integer 1 to 500 | no | Most the purchase may cost over its quote when it is sent, in bps; 50 when omitted |
| `minBack` | raw amount | no | The least of the pledge you accept back, raw units (USDG: 6 decimals): the close is refused under it, and its transaction reverts under it |

### `put_roll`: Roll a put over

Roll a put over through its put router: a new loan of the same size on the same pledge repays it in full, and the wallet's USDG buys what the new payout leaves short.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | yes | The loan's core: its lend asset's (gage_capabilities lendAssets) |
| `term` | integer, positive | no | The new loan's term in seconds, one gage_capabilities lists; the loan's own term when omitted |
| `maxSlippageBps` | integer 1 to 500 | no | Most the purchase may cost over its quote when it is sent, in bps; 50 when omitted |

### `put_auto_roll`: Roll a put over by itself

Leave a put to roll over by itself: gage's keeper rolls it in its last hours through its put router, at most maxCost each, buying each top-up with at most maxSpend of the wallet's USDG, up to four times. Leaves standing approvals to the put router.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | yes | The loan's core: its lend asset's (gage_capabilities lendAssets) |
| `maxCost` | raw amount | no | The most each new loan may cost, its fixed cost and origination fee together, raw units of the loan's asset, at most the loan's principal; when omitted, as auto_roll starts it |
| `maxSpend` | raw amount | no | The most of the pledge's token (USDG: 6 decimals) each roll may spend buying what the new loan leaves short, at most the loan's pledge; when omitted, twice what buying the largest top-up costs now |

### `put_cancel_auto_roll`: Stop rolling a put over

End a put's instruction to roll over by itself through its put router.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | yes | The loan's core: its lend asset's (gage_capabilities lendAssets) |

### `lp_borrow`: Borrow against an LP position

Borrow against an LP position (a fixed-cost USDG loan against an ETH/USDG or stock/USDG liquidity position on Uniswap v3 or v4, SushiSwap v3, Ouro v3, Ramses or Fables, with no liquidation: it is never closed early because a price moves, and if it is not repaid by its end the position is unwound for its lenders and nothing else is taken): the position is approved to the lane's core and moves into its own escrow, and the loan's USDG less the fee comes to the wallet. A Uniswap v4 position leaves any subscription it has (a rewards program that tracks it) as it moves. Fables receipts not wrapped yet (rangeId, gage_lp_positions fablesReceipts) are wrapped into a position first, any staked ones unstaked, and the borrow follows once the wrap is mined. Refused above maxCostBps. Use the prepare object of gage_lp_quote, without its action.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `adapter` | address | yes | The position's adapter: one gage_capabilities lists under lpLane.adapters (Uniswap v3, SushiSwap v3, Ouro v3, Ramses V3, Uniswap v4 or Fables; gage_lp_positions names each position's) |
| `tokenId` | id (decimal string) | no | The position's id (gage_lp_positions); or rangeId for Fables receipts not wrapped yet |
| `rangeId` | id (decimal string) | no | Fables receipts not wrapped yet (gage_lp_positions fablesReceipts), with the Fables adapter: they are wrapped into a position first, unstaking any staked, then borrowed against; name tokenId or rangeId, not both |
| `term` | integer, positive | yes | Loan term in seconds, one of gage_capabilities lpLane.terms |
| `maxCostBps` | integer 1 to 5000 | yes | Highest loan cost you accept, bps of the amount borrowed; refused above it |
| `vault` | address | no | The LP vault to borrow from; the lane's first one that can fund the loan whole when omitted |

### `lp_repay`: Repay an LP loan

Repay an LP loan in full in USDG before its end, and take its position back.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The LP loan's id on the lane's core (gage_lp_loans) |

### `lp_return_position`: Take an LP position back

Take back the position of an LP loan repaid before its end.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The LP loan's id on the lane's core (gage_lp_loans) |

### `lp_collect`: Collect an LP position's fees

Collect a running LP loan's trading fees (a native ETH pool's as WETH), and a Ramses position's rewards, to the wallet; the liquidity stays in place.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The LP loan's id on the lane's core (gage_lp_loans) |

### `lp_withdraw`: Withdraw LP credits

Withdraw what the LP lane's core credits the wallet (a loan's USDG, fees, rewards), every token when token is omitted.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `token` | address | no | The token to withdraw; every token the LP lane credits the wallet when omitted |

### `lp_deposit`: Deposit into an LP vault

Deposit USDG into an LP vault, which lends against LP positions in the pools of its mandate. Refused while the vault is impaired, its deposits are closed or the registry no longer lets it lend.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | An LP vault: one gage_lp_vaults lists (the manifest's, or one a curator opened through the lane's factory) |
| `amount` | raw amount | yes | USDG to deposit, raw units (6 decimals) |
| `maxSlippageBps` | integer 0 to 500 | no | Most the conversion may move against you, in bps; 50 when omitted |

### `lp_redeem`: Withdraw from an LP vault

Withdraw from an LP vault the wallet's own shares (those it received by transfer too), every share it can pay now when shares is omitted (from its free cash, and a reserve vault's reserve).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | An LP vault: one gage_lp_vaults lists (the manifest's, or one a curator opened through the lane's factory) |
| `shares` | raw amount | no | Shares to redeem, raw, in the vault's own decimals (its shareDecimals in gage_lp_vaults and the portfolio, 18 or 12: 10^shareDecimals shares were worth 1 USDG when the vault opened); every share the vault can pay now when omitted (from its free cash, and a reserve vault's reserve) |
| `maxSlippageBps` | integer 0 to 500 | no | Most the conversion may move against you, in bps; 50 when omitted |

### `lp_claim_bonus`: Claim an LP vault's bonus

Claim an LP vault's bonus (what a defaulted LP loan's sale brought above its book value, shared by the lenders by their share of the vault and the time they held it while the loan ran), every loan with one when loanId is omitted.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | An LP vault: one gage_lp_vaults lists (the manifest's, or one a curator opened through the lane's factory) |
| `loanId` | id (decimal string) | no | The defaulted LP loan whose bonus to claim; every loan of the vault with a bonus for this wallet when omitted |

### `lp_claim_rewards`: Claim an LP vault's sGAGE

Claim a reserve LP vault's sGAGE: what its loans earned its holders, outside the share price and with no fee, each holder's by its share of the vault while it arrived, shares held now or not; it moves no USDG. Refused on a vault with no reserve, which pays no sGAGE, and with nothing to claim.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | A reserve LP vault: one gage_lp_vaults lists with a reserve |

### `lp_roll`: Roll an LP loan over

Roll an LP loan over: a new loan on the same position repays the running LP loan in full before its end: the position stays in its escrow, and only the difference moves, the new loan's USDG less its fee over the old repayment credited to the wallet, or what it lacks paid by the wallet. Refused above maxCostBps.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `loanId` | id (decimal string) | yes | The LP loan's id on the lane's core (gage_lp_loans) |
| `term` | integer, positive | yes | Loan term in seconds, one of gage_capabilities lpLane.terms |
| `maxCostBps` | integer 1 to 5000 | yes | Highest loan cost you accept, bps of the amount borrowed; refused above it |
| `vault` | address | no | The LP vault the new loan comes from; the loan's own vault first when omitted |

### `lp_wrap`: Wrap Fables receipts into a position

Wrap Fables receipts into a position: every Fables receipt the wallet holds of one range (rangeId, gage_lp_positions fablesReceipts) becomes one position NFT the LP lane lends against: staked receipts are unstaked first (they stop earning Fables' emissions), and the wrapped ones earn the pool's swap fees.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `adapter` | address | yes | The lane's Fables adapter (gage_capabilities lpLane.adapters, kind fables) |
| `rangeId` | id (decimal string) | yes | A Fables range's id: the receipts gage_lp_positions lists under fablesReceipts |

### `lp_unwrap`: Unwrap a Fables position

Unwrap a Fables position the wallet holds back into its receipts, with their fees less the claim fee Fables keeps.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `adapter` | address | yes | The lane's Fables adapter (gage_capabilities lpLane.adapters, kind fables) |
| `tokenId` | id (decimal string) | yes | The position's id: its NFT's token id at the adapter's position manager (gage_lp_positions) |

### `lp_create_vault`: Open an LP vault

Open an LP vault, for a wallet the LP registry lets open one (a curator it allows, or anyone once it opens vault creation): its name, performance fee (500 to 1,500 bps of each loan's fixed cost, fixed for good), largest loan and the pools it funds (gage_capabilities lpLane.pools). A wallet the LP registry lets open one (a curator it allows, or anyone once it opens vault creation) opens a vault through the lane's factory and curates it: it funds loans only in the pools of its mandate, a pool added funding three hours later and one dropped stopping at once (open loans run on); the curator never touches its lenders' money.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `name` | string (at most 64) | yes | The vault's name, as depositors see it (at most 64 bytes) |
| `performanceFeeBps` | integer 500 to 1500 | yes | Your share of each loan's fixed cost, in bps: 500 to 1,500 (5% to 15%); fixed for good |
| `maxLoanPrincipal` | raw amount | yes | The largest loan the vault funds, raw USDG (6 decimals), at most 10,000,000 USDG; you may change it later |
| `pools` | list of at most 32 | yes | The pools the vault funds loans in (its mandate), each once: from gage_capabilities lpLane.pools |
| `pools[].adapter` | address | yes | The pool's adapter (gage_capabilities lpLane.pools) |
| `pools[].pool` | address | yes | The pool, as gage_capabilities lpLane.pools names it under that adapter |

### `lp_vault_add_pool`: Add a pool to an LP vault

Add a pool to the mandate of an LP vault this wallet curates: it funds new loans there three hours later. A wallet the LP registry lets open one (a curator it allows, or anyone once it opens vault creation) opens a vault through the lane's factory and curates it: it funds loans only in the pools of its mandate, a pool added funding three hours later and one dropped stopping at once (open loans run on); the curator never touches its lenders' money.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | An LP vault this wallet curates (gage_lp_vaults curator) |
| `adapter` | address | yes | The pool's adapter (gage_capabilities lpLane.pools) |
| `pool` | address | yes | The pool, as gage_capabilities lpLane.pools names it under that adapter |

### `lp_vault_remove_pool`: Drop a pool from an LP vault

Drop a pool from the mandate of an LP vault this wallet curates: it funds no new loan there from then on; loans already open run to their ends. A wallet the LP registry lets open one (a curator it allows, or anyone once it opens vault creation) opens a vault through the lane's factory and curates it: it funds loans only in the pools of its mandate, a pool added funding three hours later and one dropped stopping at once (open loans run on); the curator never touches its lenders' money.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | An LP vault this wallet curates (gage_lp_vaults curator) |
| `adapter` | address | yes | The pool's adapter (gage_capabilities lpLane.pools) |
| `pool` | address | yes | The pool, as gage_capabilities lpLane.pools names it under that adapter |

### `park`: Park an out-of-range position

Park an out-of-range position: an out-of-range liquidity position's whole liquidity is pulled out on its own DEX (manager and id from gage_park_positions), and the one token it holds is deposited into the partner vault named, which must take it (USDG, or a lend asset; ETH is not parked yet); its fees come to the wallet. Refused while the position is in range.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `manager` | address | yes | Where the position is held: its position manager (a Uniswap v3, SushiSwap v3, Ouro v3 or Ramses V3 NonfungiblePositionManager, or a Uniswap v4 PositionManager), or a Fables hook for its receipts (gage_park_positions manager) |
| `id` | id (decimal string) | yes | The position's id at its manager (gage_park_positions id): its NFT's token id, or a Fables range's id |
| `vault` | address | yes | The partner vault to park in: one that takes the token the position holds now (gage_park_positions vaults; a DEX names its own) |
| `maxSlippageBps` | integer 0 to 500 | no | Most the conversion may move against you, in bps; 50 when omitted |

### `unpark`: Unpark into a new position

Unpark: the partner vault named pays the wallet (amount, or all it can pay now: its free cash), and a new position is opened in [tickLower, tickUpper] of a pool gage_capabilities parkPools lists that pairs the vault's asset; a range around the price takes the pool's other token too, from the wallet.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `vault` | address | yes | The partner vault to withdraw from: one whose asset the pool pairs |
| `manager` | address | yes | Where the new position is minted: the pool's manager (gage_capabilities parkPools manager) |
| `pool` | address or v4 pool id | yes | The pool: a v3-style pool's address, or a v4 pool's id (gage_capabilities parkPools pool) |
| `tickLower` | integer -887272 to 887272 | yes | The new range's lower tick, a multiple of the pool's tick spacing |
| `tickUpper` | integer -887272 to 887272 | yes | The new range's upper tick, a multiple of the pool's tick spacing, above tickLower |
| `amount` | raw amount | no | How much to withdraw, raw units of the vault's asset; everything the vault can pay the wallet now when omitted |
| `maxSlippageBps` | integer 0 to 500 | no | Most the conversion may move against you, in bps; 50 when omitted |

### `rehypo_exit_now`: Exit a rehypo pool now

Exit a rehypo pool now, for a pool LP whose share of one of the pool's tokens is more than that token's rehypo source can pay now (source: the hook's source for that token, which lends it through a partner vault). The source commits the vault shares its cash leaves short of the wallet's share at the chain's exit desk, which lists one of the vault's loans, first the one whose price can fall furthest for this exit. Over ten minutes its price falls from book value plus 99% of what the loan has still to earn, no further than the source's share of that loan can pay: the buyer's discount comes out of the source's share, so the pool's LPs who stay pay it, not the wallet, and the listing may not sell. Once a buyer takes it, remove the liquidity on the pool's hook as usual: the source pays from what the sale paid, held for its LPs for an hour. Refused while the source can pay the share now, or while exits are closed. Like a withdrawal, it avoids losses on loans that default after the wallet leaves; the LPs and holders who stay bear them.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that holds the pool's LP shares |
| `source` | address | yes | The rehypo source of the pool's token your share is short of: the hook's source for that token, which lends it through a partner vault |

### `earn_exit_now`: Exit a partner vault now

Exit a partner vault now, for a holder whose balance is more than the vault can pay now: the wallet's vault shares (amount, raw in the vault's asset at today's share value; the whole balance when omitted) are committed at the chain's exit desk, approved to it for exactly those shares, and the desk lists one of the vault's loans: first the one whose price can fall furthest for this exit, then the smallest that covers what the vault cannot pay of them. Over ten minutes its price falls from book value plus 99% of what the loan has still to earn: only the part the vault cannot pay can reach book value, and the price falls no further than the wallet's own share of that loan can pay, since the wallet pays the buyer's discount, so the listing may not sell. The sale pays the wallet at today's share value in its own transaction, to collect with earn_exit_collect; the request lasts 24 hours. Refused while the vault can pay the amount now (withdraw it with earn_redeem), beside an exit already open, or while exits are closed. Like a withdrawal, it avoids losses on loans that default after the wallet leaves; the holders who stay bear them.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that holds the vault's shares |
| `vault` | address | yes | A partner vault, as gage_earn_vaults lists it |
| `amount` | raw amount | no | What to exit, raw units of the vault's asset (USDG: 6 decimals) at today's share value; the whole balance when omitted |

### `earn_exit_list`: List an exit's next loan

List the next loan for the wallet's open exit from a partner vault, once its last listing ended unsold and the vault still cannot pay the rest: the next of the vault's loans, chosen as earn_exit_now chooses it; gage's keeper may also list it.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet whose exit it is |
| `vault` | address | yes | The partner vault its exit leaves |

### `earn_exit_cancel`: Cancel an exit

Cancel the wallet's exit from a partner vault, before a sale: its shares stay the wallet's, and nothing more is listed or sold for it; it goes to the desk the vault's factory bound, so it works while exits are closed.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet whose exit it is |
| `vault` | address | yes | The partner vault its exit leaves |

### `earn_exit_collect`: Collect what an exit paid

Collect what exit now sales paid the wallet, from the exit desk: asset (USDG or a lend asset), or every asset it owes when omitted.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `asset` | address | no | The asset to collect: USDG, or a lend asset gage_capabilities lists; every asset the exit desk owes the wallet when omitted |

### `create_vault`: Create a partner vault

Create one partner vault of the wallet's own, with a free name, lending one asset (USDG, or a lend asset) against tokens of one universe: the wallet manages it for good, and it lends what depositors bring. Who may create: anyone while its generation's creation is open, otherwise a partner gage admitted.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | Who manages the vault, for good: the wallet that signs |
| `name` | string | yes | The vault's name, as depositors see it: 1 to 48 bytes, no control or invisible characters. Its manager may change it |
| `asset` | address | no | The asset the vault lends: USDG when omitted, or a lend asset gage_capabilities lists (its token address) |
| `universe` | string | no | What it lends against: rwa (stocks and commodities) or ecosystem (meme and utility coins); it can never lend against both. rwa when omitted, a non-stable asset's vault always ecosystem |
| `collateral` | list of at most 64 | no | The tokens it lends against, of one universe; every token its generation admits in `universe` when omitted |
| `term` | number or number | yes | The longest loan it funds, in seconds: 604800 (7 days) or 1814400 (21 days) |
| `feeBps` | integer 500 to 1500 | yes | The performance fee on each loan's profit, bps, 500 to 1500; the protocol receives 10% of it. Fixed for good |
| `maxLoan` | raw amount | yes | The most it puts into one loan, raw units of its asset (USDG: 6 decimals) |
| `cashKeptFreeBps` | integer 0 to 10000 | no | The share of the vault a new loan must leave free, in cash or in its reserve, bps; 0 when omitted |
| `priorityFeeBps` | integer 0 to 5000 | no | The most it pays the protocol for a loan, bps of its profit, 0 to 5000: the vault paying most is funded first. 2000 when omitted |
| `minRateGrade` | integer 0 to 4 | no | The lowest Loan grade it funds, 0 (any) to 4 (A, the model's price or more). 3 (B, 90% of it) when omitted |
| `buyLoans` | object | no | It buys running loans other vaults of its generation sell, when they pay at least the model's return plus this; off when omitted |
| `buysOnly` | boolean | no | true: it buys running loans alone and funds no new loan, for good; needs buyLoans |

### `vault_manage`: Manage a partner vault

Manage a partner vault: its name, pause, automatic funding, priority fee ceiling, fee recipient, risk limits (a lower cap or higher floor applies at once; a looser one waits three hours, then apply), buying running loans, its tokens, and a running loan listed for sale, each field one transaction; what the vault has already is left out. For the vault's manager alone, read from the chain, no gage service asked. A manager cannot withdraw depositors' assets; a fee recipient other than the wallet takes fees not yet claimed too, and a loan listed for sale can sell for as little as book value plus half of what it has still to earn, which depositors bear.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The vault's manager: the one wallet its curator's calls take |
| `vault` | address | yes | A partner vault this wallet manages |
| `name` | string | no | A new name, as depositors see it: 1 to 48 bytes, no control or invisible characters |
| `paused` | boolean | no | true pauses new investment (deposits, funding and loan sales); withdrawals go on. false resumes it |
| `fillersOpen` | boolean | no | Whether gage's automatic funding may fund loans within the vault's mandate; open loans are untouched either way |
| `priorityFeeBps` | integer 0 to 5000 | no | The most it pays the protocol for a loan, bps of its profit, 0 to 5000; applies at once, up or down |
| `feeRecipient` | address | no | Where the manager's share of the performance fee is paid, what is not yet claimed included; not the vault itself. In mixed case, its checksum must hold |
| `maxLoan` | id (decimal string) | no | The most it puts into one loan, raw units of its asset. Lower applies at once, higher waits three hours |
| `maxPerTokenBps` | integer 0 to 10000 | no | The most of the vault lent against one token, bps. Lower applies at once, higher waits three hours |
| `cashKeptFreeBps` | integer 0 to 10000 | no | The share of the vault a new loan must leave free, in cash or in its reserve, bps. Higher applies at once, lower waits three hours |
| `minRateGrade` | integer 0 to 4 | no | The lowest Loan grade it funds, 0 (any) to 4 (A). Higher applies at once, lower waits three hours |
| `stockBps` | integer 0 to 10000 | no | The most of the vault lent against stocks, bps; a category outside its universe stays closed. Lower applies at once, higher waits three hours |
| `memeBps` | integer 0 to 10000 | no | The same for meme coins |
| `ecosystemBps` | integer 0 to 10000 | no | The same for utility coins |
| `commodityBps` | integer 0 to 10000 | no | The same for commodities |
| `buyLoans` | object | no | Whether it buys running loans. Stopping, or asking more, applies at once; starting, or asking less, waits three hours |
| `addTokens` | list of at most 64 | no | Tokens to lend against, of its universe: each waits three hours, then applyTokens |
| `removeTokens` | list of at most 64 | no | Tokens to stop lending against, at once; open loans run on |
| `applyTokens` | list of at most 64 | no | Tokens added whose three hours are over: they lend from now |
| `dropTokens` | list of at most 64 | no | Tokens added and still waiting: dropped |
| `apply` | list of at most 9 | no | Changes whose three hours are over, by the field that made them: they apply now |
| `drop` | list of at most 9 | no | Changes still waiting, by the field that made them: dropped |
| `listLoan` | object | no | Lists a running loan of the vault for sale to other vaults; mandate 13. Its price falls in about five minutes to book value plus half of what it has still to earn, and what a sale gives up, the vault's depositors bear |
| `cancelListing` | id (decimal string) | no | Takes a loan of the vault off sale |

## Read tools

The reads of `gageTools(gage)`, each answering as its method does, and the pool vault tools of `poolVaultTools(gage)`,
which sign nothing. `gage_put_quote` comes where puts open, the `gage_lp_` reads where the LP lane is public,
`gage_park_positions` where park is served, and `gage_wallet` with a signer.

### `gage_capabilities`: gage capabilities

`gage.capabilities()`, reads. Chain, contracts, allowed loan terms, fees, the rules and any lend assets besides USDG. Start here.

No input.

### `gage_assets`: Collateral gage takes

`gage.assets()`, reads. Tokens gage admits as collateral now: each one's minimum pledge, its most per loan where one is set (maxPerLoan, null where there is none), whether leverage buys it, how many partner vaults lend against it now (vaults: 0 means none does yet, null that gage's index cannot say; a vault that buys running loans alone funds none and is not counted), a stock's display multiplier (uiMultiplier; amounts here are raw) and its Borrow link on gage.cash; a row names the lend asset it is borrowed in, once there is more than USDG.

No input.

### `gage_borrow_quote`: Borrow quote

`gage.borrowQuote(input)`, reads. The largest loan the partner vaults fund now for at most maxCollateral of a token, at the lowest fixed cost they accept; or one exact loan (collateral and principal) at the lowest cost that funds it now, or at your own costBps, with what each Loan grade costs; in USDG or the lend asset named, with a prepare object for gage_prepare_borrow.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `token` | address | yes | A token's address, as `assets()` lists it |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `wallet` | address | no | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `lendAsset` | address | no | The asset the loan is paid in and repaid in: USDG when omitted, or a lend asset gage_capabilities lists (its token address) |
| `maxCollateral` | raw amount | no | Most of the token to pledge, raw units: quotes the largest loan the vaults fund for it, at the lowest fixed cost they accept |
| `collateral` | raw amount | no | With principal: the exact pledge of one chosen loan, raw units |
| `principal` | raw amount | no | With collateral: the exact amount to borrow, raw units of the loan's asset; priced at the lowest fixed cost the vaults funding it accept, or at costBps |
| `costBps` | number 0.1 to 5000 | no | With collateral and principal: your own fixed cost for the loan instead, bps of the amount borrowed, to a tenth (more digits are rounded); the quote's grades say what each Loan grade costs |

### `gage_leverage_quote`: Leverage quote

`gage.leverageQuote(input)`, reads. Preview a leveraged loop for a pledge and a multiple: amounts, cost and the most the purchase costs. Signs nothing.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `token` | address | yes | A token's address, as `assets()` lists it |
| `own` | raw amount | yes | The tokens you put in, raw units |
| `multiple` | number 1.1 to 3 | yes | Leverage, 1.1 to 3 with at most two decimals (2 = twice the pledge held for the loan) |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `wallet` | address | no | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |
| `lendAsset` | address | no | USDG only: leverage lends USDG (a loop in a lend asset is refused; a lend asset's puts open with put_open) |

### `gage_loan`: Loan

`gage.loan(input)`, reads. One loan: state, amounts, deadlines, what can be done with it now (here, or on gage.cash for an action this server does not serve), its standing instruction to roll by itself, and what closed it (a roll or a cash-out).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `loanId` | id (decimal string) | yes | The loan's id, a decimal string |
| `engine` | address | no | The engine; the current core when omitted |

### `gage_portfolio`: Portfolio

`gage.portfolio(wallet)`, reads. A wallet's loans (each one's sGAGE to claim, raw, and whether it rolls by itself), Earn holdings and credits (USDG, and each lend asset's apart); where a release names the chain's exit desk, each holding's open exit now and where it stands, and what exit sales paid the wallet. A core or vault that could not be read just now is named in unread, never shown as empty.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that will sign |

### `gage_earn_vaults`: Earn vaults

`gage.earnVaults()`, reads. The partner vaults that take deposits now, in each current generation: each one's manager, tokens, fees, size, free cash, share value and link on gage.cash; lends is false, with buysOnly true, for one that buys running loans alone. Not every vault: LP vaults are gage_lp_vaults', and the withdraw-only vaults of replaced generations and gage's earlier Earn strategies are not listed, so these sizes do not add up to what gage's vaults hold.

No input.

### `gage_vault_free_cash`: Vault free cash

`gage.vaultFreeCash(input)`, reads. One partner vault's free cash: what withdrawals are paid from now, what comes back to it as its loans end, by day, and what loans past their end bring back once settled, only if their borrowers repay; and the share of the vault a new loan must leave free (bufferBps).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `vault` | address | yes | A partner vault, as gage_earn_vaults lists it |

### `gage_put_quote`: Put quote

`gage.putQuote(input)`, reads. Preview a put for a margin and a size: a loan of a lend asset against USDG, opened with put_open: it gains as the asset falls, and its loss stops at the USDG put in. Its pledge, purchase, loan, repayment, cost and the most the purchase costs, with a prepare object for gage_prepare_put_open. Signs nothing.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `lendAsset` | address | yes | The asset the put borrows against USDG: a lend asset gage_capabilities lists with a putRouter (its token address) |
| `margin` | raw amount | yes | The USDG you put in, raw units (6 decimals): the most the put can lose |
| `size` | number 1.1 to 10 | yes | The put's size, 1.1 to 10 with at most two decimals: its whole USDG pledge over the margin you put in (4 = the margin and three times it bought with the loan) |
| `term` | integer, positive | yes | Loan term in seconds, one of the terms gage_capabilities lists |
| `wallet` | address | no | The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's |

### `gage_lp_positions`: LP positions

`gage.lpPositions(wallet)`, reads. A wallet's liquidity positions on Uniswap v3 or v4, SushiSwap v3, Ouro v3, Ramses or Fables in a pool gage's LP lane lends against: range, liquidity, amounts and worth in USDG at the pool's price now, and whether the lane takes it now. Uniswap v4 positions are found through gage's index and checked on chain; the note says when some may be missing. Start here to borrow against one.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that will sign |

### `gage_lp_quote`: LP loan quote

`gage.lpQuote(input)`, reads. A quote for a fixed-cost USDG loan against an ETH/USDG or stock/USDG liquidity position on Uniswap v3 or v4, SushiSwap v3, Ouro v3, Ramses or Fables, with no liquidation: it is never closed early because a price moves, and if it is not repaid by its end the position is unwound for its lenders and nothing else is taken: what the wallet receives and repays, its cost and loan-to-value, signed for the wallet for five minutes at most, with a prepare object for gage_prepare_lp_borrow. Signs nothing.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `adapter` | address | yes | The position's adapter: one gage_capabilities lists under lpLane.adapters (Uniswap v3, SushiSwap v3, Ouro v3, Ramses V3, Uniswap v4 or Fables; gage_lp_positions names each position's) |
| `tokenId` | id (decimal string) | yes | The position's id: its NFT's token id at the adapter's position manager (gage_lp_positions) |
| `wallet` | address | yes | The wallet that holds the position and will borrow: the quote is signed for it |
| `term` | integer, positive | yes | Loan term in seconds, one of gage_capabilities lpLane.terms |
| `vault` | address | no | The LP vault to borrow from; the lane's first one that can fund the loan whole when omitted |

### `gage_lp_loans`: LP loans

`gage.lpLoans(wallet)`, reads. A wallet's LP loans (state, amounts, end, its position now, what can be done with it now) and what the lane's core credits the wallet.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that will sign |

### `gage_lp_vaults`: LP vaults

`gage.lpVaults()`, reads. The LP vaults that lend against LP positions, the release's and those curators opened: size, free cash, loans out, share value, fee, its curator, the pools it funds (its mandate, in plain words in funds), whether the registry still lets it lend, and whether each takes deposits and pays out now; a reserve vault's reserve too: what it holds, what the vault can pay out now and the least a loan must cost it.

No input.

### `gage_park_positions`: Out-of-range positions

`gage.parkPositions(wallet, also)`, reads. A wallet's out-of-range liquidity positions in the pools gage parks from (gage_capabilities parkPools): each one's pool, range, the one token it holds now and the partner vaults that take it, or why none can. Start here to park one.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `wallet` | address | yes | The wallet that holds the positions |
| `also` | list of at most 100 | no | Positions to read beside those found, by their manager and id: a Uniswap v4 PositionManager and a Fables hook cannot list a wallet's |
| `also[].manager` | address | yes |  |
| `also[].id` | id (decimal string) | yes | The position's id at its manager (gage_park_positions id): its NFT's token id, or a Fables range's id |

### `gage_wallet`: This wallet

`gage.balances(signer.address)`, reads. The wallet this server signs with (0x35FC…BC07): its address, ETH for gas, USDG, lend assets and collateral tokens.

No input.

### `gage_pool_vaults`: Pool vaults

`gage.poolVaults(input)`, reads. The pools among the partner vaults (a curator's alone where one is named): one curator's vaults whose names end in the pool's tag (Fables NVDA/USDG), one for each pool token gage lends, each side its vault and gage.cash page, or none.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `curator` | address | no | Only this curator's pools; every curator's when omitted |

### `gage_create_pool_vaults`: Create pool vaults

`gage.createPoolVaults(input)`, reads. The calls that create a DEX pool's vaults on gage, one for each pool token gage lends, each on its own factory, from any curator while its creation is open (mainnet's since 5 November 2026), otherwise one gage admitted as a partner: what both share named once (fee, longest loan, Loan grade floor, priority fee), and for each token its largest loan and the cash it keeps free. Neither vault lends against the pool's own two tokens unless a side names one and allowPoolTokens is true. Answers the calls for one wallet batch (EIP-5792, atomic) and the same as a Safe{Wallet} Transaction Builder file (safeBatch), each simulated from the curator now; a token gage does not lend gets no vault, and the answer says why. Never signs.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `curator` | address | yes | Who manages both vaults, for good: the wallet or Safe that sends the calls. Any address while a generation's creation is open (mainnet's since 5 November 2026), otherwise one gage admitted as a partner there |
| `name` | string | yes | The name before the pool's tag: "Fables" names both vaults "Fables NVDA/USDG" |
| `pool` | list of at most 2 | yes | The pool's two tokens, in its order |
| `term` | number or number | yes | The longest loan both vaults fund, in seconds: 604800 (7 days) or 1814400 (21 days) |
| `feeBps` | integer 500 to 1500 | yes | The performance fee both charge on each loan's profit, bps, 500 to 1500; the protocol receives 10% of it |
| `priorityFeeBps` | integer 0 to 5000 | no | The most each vault pays the protocol for a loan, bps of its profit, 0 to 5000: the vault paying most is funded first. 2000 when omitted |
| `minRateGrade` | integer 0 to 4 | no | The lowest Loan grade both fund, 0 (any) to 4 (A, the model's price or more). 3 (B, 90% of it) when omitted |
| `buyLoans` | object | no | Each vault buys running loans other vaults of its generation sell, when they pay at least the model's return plus this; off when omitted. Before mandate 13 (Intent D56) only the USDG vault buys |
| `sides` | list of at most 2 | yes | What is counted in each token, one entry for each pool token gage lends: its largest loan, and the cash it keeps free |
| `sides[].token` | string | yes | The pool token this side lends, as `pool` names it |
| `sides[].maxLoan` | raw amount | yes | The most this vault puts into one loan, raw units of its token (USDG: 6 decimals) |
| `sides[].cashKeptFreeBps` | integer 0 to 10000 | no | The share of the vault a new loan must leave free, in cash or in its reserve, bps, 0 to 10000: what the pool can draw on. 1000 (10%) when omitted |
| `sides[].collateral` | list of at most 64 | no | The tokens this vault lends against, of one universe (real-world assets, or the Robinhood ecosystem). When omitted: every token its generation admits in the universe of the pool's other token, less the pool's own two tokens (a stock's vault: the memes paired with it). Naming a pool token is refused unless allowPoolTokens is true |
| `allowPoolTokens` | boolean | no | true lets a side's collateral name one of the pool's own two tokens, which a fall in that token would then hit twice: in the pool and in the vault's loans. When omitted or false, naming one is refused (POOL_TOKEN_COLLATERAL); a side that names no collateral never lends against them either way |

### `gage_create_partner_vault`: Create a partner vault

`gage.createVault(input)`, reads. The call that creates one partner vault of the wallet's own, with a free name, lending one asset (USDG, or a lend asset) against tokens of one universe: the wallet manages it for good, and it lends what depositors bring. Who may create: anyone while its generation's creation is open, otherwise a partner gage admitted. Answers the call for a wallet (simulated from the curator now) and the same as a Safe{Wallet} Transaction Builder file (safeBatch). Never signs; gage_create_vault signs with this server's own wallet, where it has one.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `curator` | address | yes | Who manages the vault, for good: the wallet or Safe that sends the call. Any address while its generation's creation is open (mainnet's since 5 November 2026), otherwise one gage admitted as a partner there |
| `name` | string | yes | The vault's name, as depositors see it: 1 to 48 bytes, no control or invisible characters. Its manager may change it |
| `asset` | address | no | The asset the vault lends: USDG when omitted, or a lend asset gage_capabilities lists (its token address) |
| `universe` | string | no | What it lends against: rwa (stocks and commodities) or ecosystem (meme and utility coins); it can never lend against both. rwa when omitted, a non-stable asset's vault always ecosystem |
| `collateral` | list of at most 64 | no | The tokens it lends against, of one universe; every token its generation admits in `universe` when omitted |
| `term` | number or number | yes | The longest loan it funds, in seconds: 604800 (7 days) or 1814400 (21 days) |
| `feeBps` | integer 500 to 1500 | yes | The performance fee on each loan's profit, bps, 500 to 1500; the protocol receives 10% of it. Fixed for good |
| `maxLoan` | raw amount | yes | The most it puts into one loan, raw units of its asset (USDG: 6 decimals) |
| `cashKeptFreeBps` | integer 0 to 10000 | no | The share of the vault a new loan must leave free, in cash or in its reserve, bps; 0 when omitted |
| `priorityFeeBps` | integer 0 to 5000 | no | The most it pays the protocol for a loan, bps of its profit, 0 to 5000: the vault paying most is funded first. 2000 when omitted |
| `minRateGrade` | integer 0 to 4 | no | The lowest Loan grade it funds, 0 (any) to 4 (A, the model's price or more). 3 (B, 90% of it) when omitted |
| `buyLoans` | object | no | It buys running loans other vaults of its generation sell, when they pay at least the model's return plus this; off when omitted |
| `buysOnly` | boolean | no | true: it buys running loans alone and funds no new loan, for good; needs buyLoans |

### `gage_vault_on_chain`: A partner vault, from the chain

`gage.vaultOnChain(input)`, reads. One partner vault read from the chain alone, gage's index not asked, so it answers while the index does not: which generation, its book, whether a settlement is due, its manager's settings and what waits (the figures Manage shows), and with a wallet its shares, what they are worth, what the vault can pay it now and the call that withdraws that. Signs nothing.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `vault` | address | yes | A partner vault |
| `wallet` | address | no | A holder: adds its shares, what they are worth, what the vault can pay it now, and the call that withdraws that |
