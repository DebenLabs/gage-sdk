# gage-mcp

gage's MCP server for an AI agent that holds its own money: it borrows and earns on [gage](https://gage.cash),
fixed-cost loans with no liquidation (a loan is never closed early because a price moves; unpaid at the end of its term,
the lenders keep the collateral and nothing else is taken). **Robinhood Chain (4663)**, under spend limits you may
lift, and its testnet (46630, see Testnet).

```bash
npx -y gage-mcp init
```

`init` makes the agent's own wallet on this computer: its key in `~/.gage/agent-4663.key`, readable only by this user,
made once and never overwritten. It prints the address, its spend limits and how to add the server, never the key.
Nobody funds it but you: send it only what the agent may use, and a little ETH for gas. Then add the server to the
agent:

```bash
claude mcp add gage -- npx -y gage-mcp     # Claude Code
codex mcp add gage -- npx -y gage-mcp      # Codex
```

Any client with an `mcpServers` file (Claude Desktop, Cursor, Hermes, …):

```json
{ "mcpServers": { "gage": { "command": "npx", "args": ["-y", "gage-mcp"] } } }
```

With the wallet `init` made, the server has 33 tools on mainnet (`gage_limits`, rolling over and the rating among
them), and 24 on the testnet:
- seven reads (`gage_capabilities`, `gage_assets`, `gage_borrow_quote`, `gage_leverage_quote`, `gage_loan`,
  `gage_portfolio`, `gage_earn_vaults`) and `gage_wallet`;
- a preview that sends nothing for each action (`gage_prepare_*`);
- an action that signs and sends every step from the agent's wallet: `gage_borrow`, `gage_leverage`, `gage_cancel`,
  `gage_reclaim` (repay), `gage_cash_out`, `gage_earn_deposit`, `gage_earn_redeem` and `gage_collect`, and where the
  network has gage's rollover router (mainnet; the testnet has none) `gage_roll`, `gage_auto_roll` and
  `gage_cancel_auto_roll`. Approvals come first, for the exact amount, and every step is simulated before it is sent.
  Each action answers with every transaction's hash, and a borrow, a loop or a roll with its loan's id.
- on mainnet, a rating of gage: `gage_prepare_feedback` and `gage_feedback`, the wallet's own score from 0 to 100 for
  gage's ERC-8004 entry (#8845), once a wallet. An action's answer says when a rating is open; it is optional, and gage
  offers nothing for it.

`gage_borrow_quote` gives the largest loan the partner vaults fund for a pledge (`maxCollateral`), or prices one exact
loan (`collateral` and `principal`). `gage_cash_out` sells a running loan's collateral through an aggregator, repays the
loan from the sale and pays the rest to the wallet, never under the `minNet` you name, nor clearly under gage's own
route where one sells the collateral. `gage_roll` rolls a running loan into a new one of the same size;
`gage_auto_roll` leaves it to gage's keeper to roll in its last hours, up to four times at a cost ceiling (twice what a
roll of it costs now unless set), and is the one action that leaves standing approvals to gage's rollover router, which
its plan names. `gage_loan` lists what can be done with a loan now, its standing instruction to roll and what closed
it; `gage_portfolio` each loan's sGAGE to claim; `gage_assets` and `gage_earn_vaults` each token's and vault's page on
gage.cash. `gage_collect` collects what is ready here and leaves out a claim that would revert now, saying so; the
first vault's credits and claims, earlier engines' lender recoveries, retired Earn strategies and the GAGE/sGAGE pool's
rewards and Drip are collected on gage.cash.

Where gage lends more than USDG, the same tools borrow and earn in its lend assets: `lendAsset` on a borrow quote and a
borrow, and on Earn the asset each vault takes. Leverage stays USDG's.

Without a key it keeps the reads and the previews: the agent prepares, and you sign elsewhere. For a person who signs
every step on gage.cash, the hosted server is the one to use (Steward, /agents/steward on gage.cash).

## Testnet

`GAGE_NETWORK=testnet` serves Robinhood Chain testnet, with test assets only:

```bash
GAGE_NETWORK=testnet npx -y gage-mcp init
```

makes the agent's testnet wallet (`~/.gage/agent-46630.key`, apart from the mainnet one) and funds it from gage's
faucet. Then add the server, told its network:

```bash
claude mcp add gage -e GAGE_NETWORK=testnet -- npx -y gage-mcp     # Claude Code
codex mcp add gage --env GAGE_NETWORK=testnet -- npx -y gage-mcp    # Codex
```

```json
{ "mcpServers": { "gage": { "command": "npx", "args": ["-y", "gage-mcp"], "env": { "GAGE_NETWORK": "testnet" } } } }
```

## Spend limits

| Setting | On mainnet unless set | |
|---|---|---|
| `GAGE_MAX_BORROW_USDG` | 100 | the most one loan or loop borrows |
| `GAGE_MAX_BORROW_DAY_USDG` | 250 | the most loans and loops borrow in any 24 hours |
| `GAGE_MAX_DEPOSIT_USDG` | 100 | the most one deposit puts into a partner vault |
| `GAGE_MAX_DEPOSIT_DAY_USDG` | 250 | the most deposits put in in any 24 hours |

Amounts of USDG, whole or with up to six decimals; 0 stops that kind of action, `off` lifts that limit, and any other
setting stops the server from starting. Whether the agent signs under limits is your choice: with all four `off` it
signs without any. On the testnet only the limits you set apply. Repaying, cashing out, withdrawing,
cancelling and collecting are not limited: they bring money or collateral back to the wallet. A roll counts only what
it borrows beyond the loan it repays, and the server rolls at the same size, so nothing; leaving a loan to roll by
itself, or ending that, moves nothing. Nor are actions in an asset other than USDG limited, nor a rating of gage, which
moves no money. An action past a limit is refused before anything is sent (`SPEND_LIMIT`, `SPEND_LIMIT_DAY`);
`gage_limits` says what is left.

The 24 hours count across restarts and across every gage-mcp on the computer acting for the wallet: each loan, loop or
deposit holds its amount as a file in `~/.gage/limits/<chain>-<wallet>/`, given back if the action never went out or
reverted. The limits guard against an agent's mistakes and against instructions hidden in what it reads. An agent that
can edit this server's settings or files can lift them, so the wallet's balance is the limit that always holds.

An agent that already keeps its own wallet's key in a file can sign here with the same wallet: point
`GAGE_PRIVATE_KEY_FILE` at that file.

## Settings

| Variable | |
|---|---|
| `GAGE_PRIVATE_KEY_FILE` | a key of your own instead of `init`'s: a file holding only the 0x-prefixed key, mode 600 (the server warns on stderr when other users can read it) |
| `GAGE_PRIVATE_KEY` | the key itself, when a file is not possible; removed from the environment once read |
| `GAGE_HOME` | where `init` keeps the wallet and the limits keep their record; `~/.gage` when unset. It must be yours, writable by no one else, and the wallet's key a file of yours only you can read: otherwise the key is refused (`KEY_FILE_UNSAFE`) and so is a limited action (`LIMITS_UNSAFE`, or `LIMITS_UNREADABLE` when the record cannot be read) |
| `GAGE_NETWORK` | `mainnet` (the default) or `testnet` (see Testnet) |
| `GAGE_MAX_BORROW_USDG`, `GAGE_MAX_BORROW_DAY_USDG`, `GAGE_MAX_DEPOSIT_USDG`, `GAGE_MAX_DEPOSIT_DAY_USDG` | the spend limits (see Spend limits) |
| `GAGE_RPC_URL`, `GAGE_INDEXER_URL`, `GAGE_RATES_URL`, `GAGE_VALUATION_URL`, `GAGE_FAUCET_URL` | elsewhere than the network's own services |

## What it will and will not do

- **The key stays in the process.** It is never logged, echoed or sent to gage. A malformed key is refused in fixed
  words.
- **It signs only what gage's planner builds**, for gage's own contracts and exact-amount approvals (leaving a loan to
  roll by itself is the one standing approval, to gage's rollover router), and a rating of gage for ERC-8004's
  Reputation Registry: a score, no text. No tool sends arbitrary calldata, so text
  injected into a page or a token name cannot make it pay someone; an aggregator's call is decoded before it is used.
- **Clients ask before acting.** The signing tools carry MCP's destructive hint, so a client asks before each one
  unless you allow it.
- **Never past the spend limits it keeps**, checked with each action's plan before anything is sent.
- **Private loans** are never read or acted on.
- **Logs go to stderr.** stdout carries MCP messages only.

## Development

In gage's repository or its public mirror (`packages/mcp`; the engine is `gage-sdk`, `packages/sdk`):

```bash
pnpm --filter gage-mcp test     # in-memory MCP tests, and the CLI over real stdio
pnpm --filter gage-mcp start    # the built CLI
```

The source is at [github.com/DebenLabs/gage-sdk](https://github.com/DebenLabs/gage-sdk), beside gage-sdk's, from where
npm's copy is published with provenance. Report a vulnerability privately (its SECURITY.md).

MIT licensed.
