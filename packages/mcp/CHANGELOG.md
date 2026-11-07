# Changelog

## 0.9.0

Built on exactly gage-sdk 0.9.0; what it changes for every tool is in its changelog.

- **Mainnet's LP lane takes Ouro v3 positions,** as gage-sdk's bundled release says, and the instructions and tools name it.
- **Reserve LP vaults, once a release names them,** as gage-sdk reads them: `gage_lp_vaults` adds a reserve vault's `reserve`,
  `gage_portfolio`'s `lp.vaults` its `sgageClaimable`, and `gage_lp_redeem` pays above its free cash, up to `maxRedeem`. An LP
  vault with no reserve reads and acts as before.
- **`gage_lp_claim_rewards` and `gage_prepare_lp_claim_rewards`, new,** claim a holder's sGAGE from a reserve vault. They are
  served where the lane names its rewards bridge: on the testnet and on mainnet since 7 November 2026, so mainnet serves the claim's
  prepare without a key (59 tools) and both with one (102). A claim
  moves no USDG and counts against no limit; the limits' amounts and defaults are unchanged.

## 0.8.0

Built on exactly gage-sdk 0.8.0; what it changes for every tool is in its changelog, whose Breaking list a client reading
tool answers may meet too: a `partial` status, and some refusals' codes. The spend limits' amounts and defaults are unchanged.

- **A put's margin in USDG counts against the deposit limits,** as all it can lose, where a put counted nothing. The stock
  token it borrows still does not count.
- **The commands name their release.** What `gage-mcp init` tells an agent to add, this README and the guide run
  `gage-mcp@0.8.0`, as the server they add holds the wallet's key: a new publish reaches a wallet when its owner moves to it, not on
  its next start. To move, run the new release's `init` again and add what it prints. A token gage admits after a release
  is refused until then.
- **A vault's fee recipient stays this wallet under the limits.** While any limit is on, `gage_vault_manage` refuses a
  `feeRecipient` other than the wallet (`FEE_RECIPIENT_LIMIT`), as it takes fees not yet claimed too, unless the owner names
  the address in `GAGE_ALLOW_FEE_RECIPIENT`.
- **A partner vault of one's own.** `gage_create_vault` and `gage_prepare_create_vault` create one with a free name;
  `gage_vault_manage` and `gage_prepare_vault_manage` carry its manager's calls; `gage_create_partner_vault` answers the call
  and a Safe's Transaction Builder file; `gage_vault_on_chain` reads a vault, and what it can pay a holder now, from the
  chain alone. 58 tools without a key on mainnet, 100 with one. None of them counts against the spend limits: they take no
  money from the wallet.
- **Refusals and failures read as gage-sdk's**, retryable where asking again can help: `gage_assets` adds `vaults` and
  `uiMultiplier`, a token no vault lends against answers `NO_VAULT_LENDS`, a mis-cased address is read as the address it
  is, and `gage_collect` and `gage_portfolio` answer `partial` where part of them did not answer.
- **`@modelcontextprotocol/server` 2.4.0**, that package's current release. The server runs over stdio, as before.

## 0.7.0

Built on exactly gage-sdk 0.7.0, the first release on npm after 0.6.0: it also carries 0.6.1 and 0.6.2 below, prepared
but never published. The spend limits' settings and defaults are unchanged; what each new action counts is in its entry.

- **An MCP client example over stdio** (`examples/stdio-client.ts`): it starts gage-mcp, lists what it serves, whether
  it signs and what is left of its spend limits, tested against this package's own CLI (`test/examples.test.ts`). The
  README's tool counts and its LP lane, park and exit desk lines say what mainnet serves since the lane went public, and
  it links gage-sdk's guides. Documentation only: the tools and their spend limits are unchanged.
- **`gage_create_pool_vaults` from any curator where creation is open (root D424)**, as gage-sdk 0.7.0 reads each
  factory's `openCreation`: once mainnet's founders' batches of 5 November 2026 execute, a curator gage has not admitted
  gets the calls too. The tool's description and the server's instructions say so; its spend limits are unchanged.
- **Mainnet's LP lane is public (5 November 2026)**, as gage-sdk's bundled release says: on mainnet the server adds the
  lane's four reads and a prepare for each of its fourteen actions, Fables' wrap and unwrap and a curator's
  `lp_create_vault` among them, and with a wallet each action's signed twin (54 tools without a key, 94 with one), and
  its instructions say what they are for. The spend limits count an LP loan by its principal and an LP vault deposit by
  its amount, as on the testnet.
- **One read that fails leaves the rest of a portfolio and of Collect standing (D412)**, as gage-sdk does:
  `gage_portfolio` names a core or vault it could not read just now in `unread` instead of failing whole, and
  `gage_prepare_collect` plans what answered and says what it left out.
- **Exit now says what it leaves to those who stay (D396)**, as gage-sdk does: `gage_prepare_earn_exit_now`'s and
  `gage_prepare_rehypo_exit_now`'s descriptions and their plans' notes say that exit now, like a withdrawal, avoids
  losses on loans that default after the wallet leaves, and that those who stay bear them. Wording only.
- **Each current generation is read from the index its release names (D403)**, as gage-sdk does: a release that names
  the index of its current generations (`intentV1IndexerUrl`, a lend asset's own `indexerUrl`) has their vaults,
  holdings, previews and loans read there, as the app and gage's keeper read them. `GAGE_INDEXER_URL` names the
  network's index, which serves a generation only where the release names none. The bundled mainnet release names none
  today; the tools and their spend limits are unchanged.
- **An exit's need counts the vault's reserve at its value (D394)**, as gage-sdk does: on the next generations
  `gage_prepare_earn_exit_now` sizes an exit against the vault's cash and its reserve at value, not what the reserve can
  pay out at that instant, and a wallet whose claim the reserve holds but cannot pay out yet is told it waits for the
  reserve (`NO_SHORTFALL`).
- **Exit now charges the leaver its own discount (SEC-01, D391)**, as gage-sdk does: on the next generations the exit
  desk takes the buyer's discount below a listing's start out of the leaver's own share of what the sold loan has still
  to earn, so a listing falls no further than that share allows and a small holder's may not sell.
  `gage_prepare_earn_exit_now`, `gage_earn_exit_list` and a listing `gage_prepare_rehypo_exit_now` pick the loan by where
  the desk would stop it for the exit (the larger of that floor and the need's) first, then by size, and say where its
  price stops (`floorBps`), that it may not sell (at 99%, that it does not fall), and that you pay the buyer's discount
  yourself; for a rehypo pool, that the pool's LPs who stay pay it. A loan another exit's live listing holds is chosen only where the desk would stop it lower
  for this exit than for that one (`floorOf`), no longer for a larger need. The tools and their spend limits are
  unchanged.
- **Exit now takes over a smaller exit's live listing (D390)**, as gage-sdk does: `gage_prepare_earn_exit_now`,
  `gage_earn_exit_list` and a listing `gage_prepare_rehypo_exit_now` may name a loan another exit's live listing holds
  when that exit was cancelled or needs less than this one; the next generations' exit desk passes the listing over as
  it stands, and an earlier generation's desk refuses it (`ListingLive`), as a race can: such a takeover is chosen only
  once the wallet's own transactions simulate, else the next loan is. The tools and their spend limits are unchanged.
- **`gage_borrow_quote` quotes the lowest fixed cost the partner vaults funding the loan accept (D384)**, never under
  Loan grade D, with a cushion for the pledge's fall while the listing waits (2% for a meme, 0.5% for a stock or ETH),
  the model's cost (`modelCostBps`) and the Loan `grade`. An exact quote takes `costBps` for a cost of your own and lists
  what each grade costs (`grades`).
- **`gage_borrow` and `gage_prepare_borrow` refuse terms no partner vault's settings take** (`TERMS_NOT_ACCEPTED`, with
  the lowest cost and the largest loan they take), where they listed a loan that would never be funded. The spend
  limits are unchanged.
- **A partner vault's exit now (Intent D57)**: `gage_prepare_earn_exit_now` and, with a key, `gage_earn_exit_now`, for a
  holder whose balance is more than the vault can pay now: the wallet's shares are committed at the chain's exit desk,
  which lists the loan gage's app would list; then `gage_earn_exit_list` (the exit's next loan), `gage_earn_exit_cancel`
  and `gage_earn_exit_collect` (what its sales paid), each with its prepare tool. `gage_prepare_earn_exit_now` carries
  gage's card; `gage_portfolio` says where each exit stands and `gage_collect` collects what the desk owes. Served where a
  current generation's manifest names its exit desk, so on the testnet from r13; mainnet's tool counts are unchanged.
  The spend limits leave all four free, as money comes back.
- **gage's card in the chat (MCP Apps).** `gage_prepare_rehypo_exit_now` names a `ui://gage/preview` view, and its
  answer carries the plan's preview drawn as gage's card, light and dark (gage-sdk/visual), in the result's `_meta`
  (`cash.gage/card`). A client that draws apps shows the card beside the words; any other keeps the plan as text, which
  is unchanged. The view greets its host, takes its theme and shows the card; it fetches and loads nothing.
- **A rehypo pool's exit now (root D357)**: `gage_prepare_rehypo_exit_now` and, with a key, `gage_rehypo_exit_now`, for an
  LP whose share of one of a rehypo pool's tokens is more than that token's source can pay now (`source`): the source
  commits its partner-vault shares at the chain's exit desk, which lists the loan gage's app would list. Served where a
  current generation's manifest names its exit desk, so on the testnet from r13; mainnet's tool counts are unchanged.
  The spend limits leave it free, as money comes back.
- **`gage_vault_free_cash`**, a read beside `gage_earn_vaults`: what one partner vault pays withdrawals from now, what
  its loans bring back, by day, and what loans past their end bring back once settled, only if their borrowers repay,
  and the share of the vault a new loan must leave free (`bufferBps`); the instructions say what it is for. 36 tools on
  mainnet with a wallet, 27 on the testnet, the two pool vault tools included.
- **Pool vaults (D333)**: `gage_pool_vaults` finds a DEX pool's vaults on gage, and `gage_create_pool_vaults` answers
  the calls that create them from a partner's curator, for one wallet batch or a Safe{Wallet} Transaction Builder file,
  and a line in the instructions says what they are for. Neither vault lends against the pool's own two tokens unless
  the caller names one and sets `allowPoolTokens`. Neither tool signs, with or without a key; the spend limits count
  nothing for them, since nothing is sent.
- **Park and unpark**, where a pool is served (the testnet's release today): `gage_park_positions` lists a wallet's
  out-of-range liquidity positions and the partner vaults that take what each holds; `gage_park` and `gage_unpark`
  (each with its preview) pull one out on its own DEX into a vault and back into a new range, their transactions sent
  together. A line in the instructions says so. Spend limits count a park's USDG as a deposit; a lend asset's park and
  every unpark are not limited. Five tools more on the testnet: 32 there with a wallet; mainnet's 36 are unchanged.
- **Puts and loops in a lend asset are not limited**, as a loan in it is not: the spend limits count USDG loans and loops
  alone. Closing a put or leaving it to roll by itself counts nothing, and a put's roll only what it borrows beyond the
  loan it repays.
- **The LP lane, where a release makes it public**: its reads (`gage_lp_positions`, `gage_lp_quote`, `gage_lp_loans`,
  `gage_lp_vaults`) and actions (`gage_lp_borrow`, `gage_lp_repay`, `gage_lp_return_position`, `gage_lp_collect`,
  `gage_lp_withdraw`, `gage_lp_deposit`, `gage_lp_redeem`, `gage_lp_claim_bonus`, each with its preview), and a line in
  the instructions saying what they are for: positions on Uniswap v3 or v4, SushiSwap v3 or Ramses, a v4 position
  leaving any subscription it has when pledged, and a native ETH pool's fees coming as WETH. Today's releases serve
  none of them.
- **Spend limits count an LP loan by its principal** against the borrowing limits, and a deposit into an LP vault by its
  amount against the deposit limits. Repaying an LP loan, taking its position back, collecting its fees, withdrawing
  the lane's credits, redeeming LP vault shares and claiming a bonus are not limited, as `notLimited`, the instructions
  and `gage_limits` say.
- **LP rolls and Fables positions**: `gage_lp_roll` rolls an LP loan into a new one on the same position before its
  end, and where a release lends against Fables, `gage_lp_wrap` and `gage_lp_unwrap` wrap a range's receipts into a
  position and back; `gage_lp_borrow` takes receipts not wrapped yet (`rangeId`) and wraps them first. The
  instructions say so. Spend limits count an LP roll only for what its new loan borrows beyond the one it repays, as a
  roll; wrapping and unwrapping are not limited, and a borrow against receipts is limited by its loan once the wrap is
  mined.

- **Curators' vaults and stock LPs**: `gage_lp_vault_add_pool` and `gage_lp_vault_remove_pool` for a vault's curator,
  and `gage_lp_create_vault` where the release names the lane's vault factory; the instructions say a vault funds only
  the pools of its mandate, and name stock LPs beside ETH ones. The spend limits leave the curator's actions out: they
  move no USDG.
- **ERC-4626 LP vaults and open creation (D319)**: the instructions say an LP vault's shares (`gLP`, raw in each vault's
  own `shareDecimals`) move between wallets and `gage_lp_redeem` redeems the wallet's own wherever they came from, and that
  `gage_lp_create_vault` serves any wallet the registry lets open one: a curator it allows, or anyone once it opens vault
  creation. The spend limits are unchanged.

## 0.6.2 (never published; released in 0.7.0)

- **`GAGE_API_KEY`: a Rates API key (D382)**, sent to gage's rates service only, on gage-sdk 0.6.2. Borrowing and earning
  need none; a busy minute without one answers `RATE_LIMITED`, retryable.
- **Rolling a loan over, or leaving it to roll by itself, approves enough for every loan rolling by itself** on the
  same core (gage-sdk's fix of the staging review's R4/F20): `gage_roll` and `gage_auto_roll`, and their
  `gage_prepare_roll` and `gage_prepare_auto_roll` previews, add what the wallet's other standing instructions still
  need to the approval, and prepare nothing while the wallet's loans cannot be read. The spend limits are unchanged:
  neither action is limited.

## 0.6.1 (never published; released in 0.7.0)

- Built on exactly gage-sdk 0.6.1: mainnet's rollover executor is gage's new filler (D324).

## 0.6.0

- **Mainnet is the default.** Without `GAGE_NETWORK` the server and `init` serve Robinhood Chain (4663);
  `GAGE_NETWORK=testnet` serves the testnet, and `init` there prints the commands that name it. Breaking: a setup that
  relied on the testnet default must set `GAGE_NETWORK=testnet`.
- **The owner may lift a spend limit with `off`**, one setting at a time: `GAGE_MAX_BORROW_USDG=off` and the rest. The
  mainnet defaults (100 USDG an action, 250 in 24 hours) stay where nothing is set.
- Built on exactly gage-sdk 0.6.0.

## 0.5.1

- Built on exactly gage-sdk 0.5.1: a loan the private lane opened stays out of `gage_loan`, `gage_portfolio` and
  `gage_collect`, and every action on it is refused, whatever gage's index says; a chain read that fails is
  `UNAVAILABLE`, to retry.
- Open source at [github.com/DebenLabs/gage-sdk](https://github.com/DebenLabs/gage-sdk), from where npm's copy is
  published with provenance; `repository` and `bugs` in package.json.

## 0.5.0

- Four actions more: `gage_cash_out`, `gage_roll`, `gage_auto_roll` and `gage_cancel_auto_roll`, with their previews.
  The roll tools come only where the network has gage's rollover router (mainnet): the testnet serves 24 tools with a
  key, 15 without, and the instructions name only the action tools served.
- On mainnet, a rating of gage: `gage_prepare_feedback`, and with a key under spend limits `gage_feedback`, the
  wallet's own score from 0 to 100 for gage's ERC-8004 entry (#8845), once a wallet. An action's last step and a done
  run say in `notes` when a rating is open, and the instructions say it once; it is optional, and gage offers nothing
  for it.
- `gage_borrow_quote` prices one exact loan (`collateral` and `principal`) beside the largest one.
- A borrow, a loop or a roll answers with its loan's id.
- Spend limits: a roll counts only what it borrows beyond the loan it repays (the server rolls at the same size, so
  nothing); cashing out is not limited, as repaying is not, nor are leaving a loan to roll by itself, ending that, or
  a rating of gage, as `notLimited`, the instructions and `gage_limits` say.
- `gage_cash_out` takes `minNet`, the least the wallet accepts; a sale is refused under it, or more than 1% under
  gage's own route for the collateral.
- A send that failed after the wallet's nonce moved answers `SEND_UNKNOWN`, not to be sent again before the wallet is read.
- `mcpName` `cash.gage/gage`, the MCP Registry entry it joins.
- Built on exactly gage-sdk 0.5.0: gage-mcp now names the SDK version it was built and tested with, so a later SDK
  release can never hand it an action its spend limits do not know. With it, `gage_loan` says what can be done with a
  loan now (and which on gage.cash), its standing instruction to roll and what closed it; `gage_portfolio` each loan's
  sGAGE; `gage_assets` and `gage_earn_vaults` gage.cash links, and no per-loan cap where a token has none;
  `gage_collect` leaves out a claim that would revert.
- The spend limits' record fails closed: one that cannot be read (`LIMITS_UNREADABLE`), or a folder that is not this
  user's or that others can write in (`LIMITS_UNSAFE`), refuses a limited action.
- The wallet `init` makes is read only from this user's own file that no one else can read, never through a link, in a
  `GAGE_HOME` no one else can write in (`KEY_FILE_UNSAFE`); a `GAGE_PRIVATE_KEY_FILE` others can read is warned of.

## 0.4.0

- Signs on Robinhood Chain mainnet under spend limits (`GAGE_MAX_*`), and `gage_limits`.
