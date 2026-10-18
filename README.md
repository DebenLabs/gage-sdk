# gage-sdk and gage-mcp

The TypeScript SDK and the MCP server for [gage](https://gage.cash). gage makes fixed-cost loans with no liquidation: a
loan is never closed early because a price moves, and if it is not repaid by the end of its term the lenders keep the
collateral and nothing else is taken. It runs on Robinhood Chain (4663) and its testnet (46630).

| Package | | What it does |
| --- | --- | --- |
| [`gage-sdk`](packages/sdk) | [npm](https://www.npmjs.com/package/gage-sdk) | Reads gage, prepares each transaction unsigned for a wallet, and carries an action out with your own signer. |
| [`gage-mcp`](packages/mcp) | [npm](https://www.npmjs.com/package/gage-mcp) | The same tools over MCP (stdio), and an agent's own wallet that signs under spend limits. |

gage never holds a key. The guides are at [docs.gage.cash](https://docs.gage.cash/ai-agents/sdk); each package's README
covers its API.

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
