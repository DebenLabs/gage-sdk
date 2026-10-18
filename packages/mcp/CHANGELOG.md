# Changelog

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
