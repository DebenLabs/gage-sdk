# LP lane

Where a release makes it public (`capabilities().lpLane`), gage lends USDG at a fixed cost against a liquidity position:
an ETH/USDG or stock/USDG position on Uniswap v3 or v4, SushiSwap v3, Ramses or Fables, in a pool the lane lists. There
is no liquidation: the loan is never closed early because a price moves, and a loan not repaid by its end is settled by
unwinding the position for its lenders, nothing else taken. The lane has its own core, registry and LP vaults; lending
to it is a deposit into an LP vault. Where the lane is not public its reads and actions refuse (`LP_CLOSED`).

[examples/lp.ts](../examples/lp.ts) lists the wallet's positions, borrows against one, repays, and deposits into an LP
vault.

## The fourteen actions

| Action | Does |
|---|---|
| `lp_borrow` | borrows against a position (`adapter`, `tokenId`), or Fables receipts not wrapped yet (`rangeId`, wrapped first) |
| `lp_repay` | repays an LP loan in full in USDG before its end and takes the position back |
| `lp_return_position` | takes back the position of an LP loan repaid before its end |
| `lp_roll` | rolls a running LP loan into a new loan on the same position; only the difference moves |
| `lp_collect` | collects a running loan's trading fees (a native ETH pool's as WETH), and a Ramses position's rewards |
| `lp_withdraw` | withdraws what the lane's core credits the wallet (a loan's USDG, fees, rewards) |
| `lp_deposit` | deposits USDG into an LP vault |
| `lp_redeem` | withdraws from an LP vault, every share its free cash pays when `shares` is omitted |
| `lp_claim_bonus` | claims an LP vault's bonus for a defaulted loan, or every one with a bonus for the wallet |
| `lp_wrap` | wraps every Fables receipt of one range into one position NFT the lane lends against |
| `lp_unwrap` | gives a wrapped Fables position back as its receipts |
| `lp_create_vault` | opens an LP vault through the lane's factory, for a wallet the LP registry lets open one |
| `lp_vault_add_pool` | adds a pool to the mandate of an LP vault you curate (it funds there three hours later) |
| `lp_vault_remove_pool` | drops a pool from the mandate of an LP vault you curate, at once (open loans run on) |

`lp_wrap` and `lp_unwrap` are served where the lane names a Fables adapter, `lp_create_vault` where it names its vault
factory. Each action's inputs are in the [Reference](reference.md#actions).

## Borrow against a position

```ts
const [{ lpLane }, positions, { vaults }] = await Promise.all([gage.capabilities(), gage.lpPositions(wallet), gage.lpVaults()]);
```

`lpPositions(wallet)` lists the wallet's positions in a pool the lane lends against, newest first: each one's `adapter`,
`tokenId`, pool, range, liquidity, amounts and worth in USDG at the pool's price now, and whether the lane takes it now
(`borrowable`, else `refusal`: `EMPTY_POSITION`, `POOL_NOT_ALLOWED`, `RANGE_TOO_NARROW`). A Uniswap v4 PositionManager
cannot list a wallet's positions, so gage's index names them and each is checked on chain; the `note` says when some may
be missing. Fables LPs hold receipts, not position NFTs: those not wrapped yet are under `fablesReceipts`.

```ts
// Signed for this wallet for five minutes at most: borrow soon after quoting.
const quote = await gage.lpQuote({ adapter: position.adapter, tokenId: position.tokenId, wallet: signer.address, term });
const { action: _, ...loan } = quote.prepare;
const borrowed = await gage.run({ action: "lp_borrow", ...loan }, signer);
```

- `lpQuote` asks gage's rates service for a loan against one position (`vault`: one LP vault, else the lane's first that
  funds it whole), checked field by field and held to the registry's fee and loan cap: what is pledged, received and
  repaid, its cost and loan-to-value, and a `prepare` object. Terms are the lane's own (`capabilities().lpLane.terms`).
- `lp_borrow` approves the position to the lane's core on its own position manager, borrows on the quote, then withdraws
  the USDG the core credits (the principal less the fee). Sent with under a minute of its quote left, it is quoted again,
  refused above `maxCostBps`, and `PRICE_MOVED` when the position supports another loan than the one planned.
- A Uniswap v4 position moved into the loan's escrow leaves any subscription it has: a rewards program that tracks it
  stops counting it. A stock LP is priced only while its market is open.
- With `rangeId` instead of `tokenId`, Fables receipts are wrapped into a position first (as `lp_wrap`: receipts earning
  Fables' emissions are withdrawn from them first and stop earning them), and the borrow follows once the wrap is mined.
  A wrapped position earns its pool's swap fees, and Fables keeps a claim fee on them.

## Repay, roll, collect

```ts
export const repayLpLoan = (gage: Gage, signer: Signer, loanId: string) => gage.run({ action: "lp_repay", loanId }, signer);
```

`lpLoans(wallet)` lists the wallet's LP loans, newest first: state, amounts, end, the position now and what can be done
with it now, and what the lane's core credits the wallet. `lp_roll` asks for the loan's roll, checks what it settles (the
old repayment and the net the core moves), approves exactly what the wallet pays when the new loan nets less than the old
repayment, rolls, and withdraws what is credited when it nets more; the position stays in its escrow.

## Lend to the lane

```ts
const { vaults } = await gage.lpVaults();
const vault = vaults.find((v) => v.takesDeposits);
if (!vault) throw new Error("No LP vault takes deposits now");
return gage.run({ action: "lp_deposit", vault: vault.vault, amount }, signer);
```

`lpVaults()` lists the release's LP vaults and those curators opened: size, free cash, loans out, share value, fee, its
curator, the pools it funds (`mandate`, in words in `funds`), whether the registry still lets it lend (`allowed`), and
whether it takes deposits (`takesDeposits`) and pays out (`paysOut`) now. A vault funds loans only in the pools of its
mandate.

- An LP vault is an ERC-4626 whose shares (`gLP`) move between wallets, counted in the vault's own `shareDecimals` (18,
  or 12 for a vault opened before 24 October 2026). `lp_deposit` mints them for at least what the deposit buys now less
  `maxSlippageBps`; `lp_redeem` redeems the wallet's own, wherever they came from.
- An LP vault is impaired while a loan past its end is not settled or tokens a defaulted position delivered wait to be
  sold: it then takes no deposit and pays nothing out (`VAULT_IMPAIRED`). Its deposits close while value it wrote off may
  still come back (`DEPOSITS_CLOSED`), and a vault the registry no longer lets lend refuses deposits (`VAULT_NOT_LENDING`).
- A defaulted loan's sale that brings more than its book value pays a bonus, shared by the lenders by their share of the
  vault and the time they held it while the loan ran: `lp_claim_bonus`.

## Curators

A wallet the LP registry lets open a vault (a curator it allows, or anyone once its owner opens creation) opens one with
`lp_create_vault`: its `name`, `performanceFeeBps` (500 to 1,500 of each loan's fixed cost, fixed for good), its largest
loan (`maxLoanPrincipal`, which it may change later) and the `pools` it funds, from `capabilities().lpLane.pools`. Its
curator adds a pool (`lp_vault_add_pool`, funding three hours later) or drops one (`lp_vault_remove_pool`, at once; open
loans run on). The curator never touches its lenders' money. Refusals: `NOT_CURATOR`, `NO_VAULT_FACTORY`,
`POOL_IN_MANDATE`, `POOL_NOT_IN_MANDATE`, `TOO_MANY_POOLS`.
