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
npx -y gage-mcp init                      # the agent's own wallet on this computer: prints its address, never its key
claude mcp add gage -- npx -y gage-mcp    # Claude Code
codex mcp add gage -- npx -y gage-mcp     # Codex
```

Fund that wallet with only what the agent may use, and a little ETH for gas. The agent then borrows and earns when you
ask, under spend limits: at most 100 USDG a loan, loop or deposit, and 250 USDG of loans and 250 USDG of deposits in any
24 hours, unless you change them (`off` lifts one).

To sign every step yourself instead, connect your agent to gage's hosted server, `https://mcp.gage.cash/mcp`: it
prepares, and you confirm each step on gage.cash.

## What you can do

| To | Use |
| --- | --- |
| **Borrow** | quote a loan (`borrowQuote`), `borrow`, or `leverage` (a loop in one transaction, USDG only); `cancel` a listing no vault has funded yet |
| **Repay or move on** | `reclaim` (repay early, collateral back), `cash_out` (sell the collateral, repay, keep the rest), `roll` into a new loan, or `auto_roll` near the end of each term |
| **Earn** | `earnVaults`, then `earn_deposit` and `earn_redeem` with the partner vaults that lend |
| **Collect** | `collect`: loan credits, collateral back, vault earnings and sGAGE |
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

[`packages/sdk/examples`](packages/sdk/examples), typechecked and tested in CI:

| Example | What it shows |
| --- | --- |
| [`quote.ts`](packages/sdk/examples/quote.ts) | What gage lends against now, and a quote. Reads only. |
| [`deposit.ts`](packages/sdk/examples/deposit.ts) | A USDG deposit into a partner vault, with your own key. |
| [`agent-tools.ts`](packages/sdk/examples/agent-tools.ts) | The tool catalogue for your own agent framework. |

Run one from `packages/sdk` after `pnpm install && pnpm build`: `npx tsx examples/quote.ts NVDA`.

## Docs and changes

- Guides: [the SDK](https://docs.gage.cash/ai-agents/sdk) and [the MCP servers](https://docs.gage.cash/ai-agents/mcp)
  on docs.gage.cash
- Reference: the [gage-sdk](packages/sdk/README.md) and [gage-mcp](packages/mcp/README.md) READMEs
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

## Security

Report a vulnerability privately, never in an issue or a pull request: see [SECURITY.md](SECURITY.md). Both packages
are in scope of gage's [bug bounty](https://docs.gage.cash/protocol/bug-bounty#agent-software).

## License

[MIT](LICENSE)
