# gage-sdk and gage-mcp

[![gage-sdk on npm](https://img.shields.io/npm/v/gage-sdk?label=gage-sdk)](https://www.npmjs.com/package/gage-sdk)
[![gage-mcp on npm](https://img.shields.io/npm/v/gage-mcp?label=gage-mcp)](https://www.npmjs.com/package/gage-mcp)
[![CI](https://github.com/DebenLabs/gage-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/DebenLabs/gage-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Borrow and earn on [gage](https://gage.cash) from your own code or AI agent. gage makes fixed-cost loans with no
liquidation: a loan is never closed early because a price moves, and if it is not repaid by the end of its term the
lenders keep the collateral and nothing else is taken. It runs on Robinhood Chain.

| Package | What it is |
| --- | --- |
| [`gage-sdk`](packages/sdk) | TypeScript: read gage, prepare each transaction unsigned for any wallet, or carry an action out with your own signer. |
| [`gage-mcp`](packages/mcp) | The same tools for an AI agent over MCP, with a wallet of the agent's own that signs under spend limits. |

## Quickstart: your app

```bash
npm install gage-sdk viem
```

```ts
import { createGage, privateKeySigner } from "gage-sdk";

const gage = createGage(); // Robinhood Chain; createGage({ network: "testnet" }) for its testnet

// What 1 NVDA borrows for 7 days. Reads only: no key.
const { assets } = await gage.assets();
const nvda = assets.find((a) => a.symbol === "NVDA")!;
const quote = await gage.borrowQuote({ token: nvda.token, maxCollateral: "1000000000000000000", term: 604800 });
console.log(quote.summary); // Pledge 1 NVDA, receive 187.80 USDG, repay 189.86 USDG within 7 days

// Borrow it with your own key: the exact approval first, every step simulated before it is sent.
const signer = privateKeySigner(process.env.WALLET_KEY!);
const { action: _, ...terms } = quote.prepare;
const { loan } = await gage.run({ action: "borrow", ...terms }, signer);
```

Amounts are raw integers as decimal strings (USDG has 6 decimals, tokens their own), times are seconds.

## Quickstart: your AI agent

```bash
npx -y gage-mcp@0.9.0 init                      # the agent's own wallet on this computer: prints its address, never its key
claude mcp add gage -- npx -y gage-mcp@0.9.0    # Claude Code
codex mcp add gage -- npx -y gage-mcp@0.9.0     # Codex
```

Fund that wallet with only what the agent may use, and a little ETH for gas. The agent then borrows and earns when you
ask, under spend limits: at most 100 USDG a loan, loop or deposit, and 250 USDG of loans and 250 USDG of deposits in any
24 hours, unless you change them (`off` lifts one).

To sign every step yourself instead, connect your agent to gage's hosted server, `https://mcp.gage.cash/mcp`: it
prepares, and you confirm each step on gage.cash.

## What you can do

| To | Use |
| --- | --- |
| **Borrow** | quote a loan at the lowest fixed cost the partner vaults accept (`borrowQuote`), `borrow`, or `leverage` (a loop in one transaction, USDG only); `cancel` a listing no vault has funded yet |
| **Repay or move on** | `reclaim` (repay early, collateral back), `cash_out` (sell the collateral, repay, keep the rest), `roll` into a new loan, or `auto_roll` near the end of each term |
| **Earn** | `earnVaults` and `vaultFreeCash`, then `earn_deposit` and `earn_redeem` with the partner vaults that lend; `earn_exit_now` sells one of a vault's loans for a holder it cannot pay now |
| **Puts** | `putQuote` and `put_open` where a lend asset offers puts, then `put_close`, `put_roll`, `put_auto_roll` |
| **LP lane** | fixed-cost USDG loans against Uniswap, SushiSwap, Ramses and Fables positions: `lpPositions`, `lpQuote`, `lp_borrow` and its thirteen other actions, LP vaults and curators |
| **Park** | an out-of-range position into a partner vault and back (`park`, `unpark`), as one batch from the LP's wallet |
| **Lend markets** | the stock tokens and stablecoins gage lends besides USDG (`lendAsset`), new stablecoin markets found on chain |
| **Collect** | `collect`: loan credits, collateral back, vault earnings, exit sales and sGAGE |
| **Look up** | `capabilities` (terms, fees, rules), `assets`, `loan`, `portfolio`, `balances`, `waitForFill` |
| **Rate gage** | `feedback`: a score from 0 to 100 in ERC-8004, once a wallet |

Every action can be prepared (`prepare`: the next unsigned transaction, for any wallet) or carried out (`run`, with
your signer). `gageTools(gage)` gives your own agent framework the tools gage's MCP servers serve.

## What it will not do

- Hold your key, or sign anything gage's own planner did not build: no tool sends arbitrary calldata.
- Fund a loan directly: lending is a deposit into a partner vault.
- Read or act on private loans.
- Approve more than a transaction needs. Leaving a loan to roll by itself is the one standing approval, and its plan
  says so.

## Defaults

- Robinhood Chain (4663) since 0.6.0, with real money. The testnet is `network: "testnet"`, or `GAGE_NETWORK=testnet`
  for gage-mcp.
- Every step is simulated before it is sent, and a refusal comes as a fixed code (`TERM_NOT_ALLOWED`,
  `INSUFFICIENT_BALANCE`, …), listed in each package's README.
- gage-mcp signs under its spend limits unless its owner lifts them.

## Examples

[`packages/sdk/examples`](packages/sdk/examples) and [`packages/mcp/examples`](packages/mcp/examples), typechecked
and tested in CI, every action they ask for checked against the schema the SDK takes:

| Example | What it shows |
| --- | --- |
| [`reads.ts`](packages/sdk/examples/reads.ts), [`quote.ts`](packages/sdk/examples/quote.ts) | The market, a wallet, a loan, a quote. Reads only. |
| [`borrow.ts`](packages/sdk/examples/borrow.ts) | One click at the lowest fixed cost, the exact quote, a loop, a refusal's minimum. |
| [`loan.ts`](packages/sdk/examples/loan.ts) | Repay, roll over, roll over by itself, cash out. |
| [`deposit.ts`](packages/sdk/examples/deposit.ts), [`exit-now.ts`](packages/sdk/examples/exit-now.ts) | A deposit into a partner vault; a withdrawal, exit now and collecting what it paid. |
| [`put.ts`](packages/sdk/examples/put.ts), [`lp.ts`](packages/sdk/examples/lp.ts), [`park.ts`](packages/sdk/examples/park.ts) | Puts, the LP lane, park and unpark. |
| [`generations.ts`](packages/sdk/examples/generations.ts) | Every asset gage lends, and a loan paid out in one. |
| [`sign-yourself.ts`](packages/sdk/examples/sign-yourself.ts), [`spend-limit.ts`](packages/sdk/examples/spend-limit.ts) | Signing each prepared step with any wallet; a spend limit for an agent. |
| [`agent-tools.ts`](packages/sdk/examples/agent-tools.ts), [`hosted-review.ts`](packages/sdk/examples/hosted-review.ts), [`stdio-client.ts`](packages/mcp/examples/stdio-client.ts) | Tools for your own agent framework, gage's hosted service and its review links, gage-mcp over stdio. |

Run one from `packages/sdk` after `pnpm install && pnpm build`: `npx tsx examples/quote.ts NVDA`.

## Docs and changes

- Guides: [every integration path](packages/sdk/docs/README.md), each with its example, and on docs.gage.cash
  [the SDK](https://docs.gage.cash/ai-agents/sdk) and [the MCP servers](https://docs.gage.cash/ai-agents/mcp)
- Reference: [every method, action and tool](packages/sdk/docs/reference.md) (generated from the SDK itself), and the
  [gage-sdk](packages/sdk/README.md) and [gage-mcp](packages/mcp/README.md) READMEs
- Changes: [gage-sdk](packages/sdk/CHANGELOG.md) and [gage-mcp](packages/mcp/CHANGELOG.md) changelogs

## Develop

Node 22 or later and pnpm 9:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## How this repository is kept

gage's main repository, where the contracts, the app and gage's services live, is the source of these two packages.
Each release is copied here as one commit, and npm's copy is published from this repository with
[provenance](https://docs.npmjs.com/generating-provenance-statements). Issues and pull requests are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Asking gage for something

- **A token gage should accept:** [List a token](https://github.com/DebenLabs/gage-contracts/issues/new?template=token-listing.yml).
- **An integration, a Rates API key, or your site's origin** for browser access to the rates service:
  [Integrate with gage](https://github.com/DebenLabs/gage-contracts/issues/new?template=integration.yml). A key is sent to your private contact, never posted in an issue.
- **Help with a loan, a deposit or the app:** [support](https://gage.cash/support). **The docs:** [docs.gage.cash](https://docs.gage.cash).

## Security

Report a vulnerability privately, never in an issue or a pull request: see [SECURITY.md](SECURITY.md). Both packages
are in scope of gage's [bug bounty](https://docs.gage.cash/protocol/bug-bounty#agent-software).

## License

[MIT](LICENSE)
