# gage-sdk guides

Every way gage supports an integration, each with an example that runs (`../examples/`, which ships with the package,
tested against gage's own fakes in `../test/examples.test.ts`). The code blocks here are slices of those examples, which
define `gage`, `signer` and the inputs. Start with Getting started; the rest can be read in any order.

| Guide | For |
|---|---|
| [Getting started](getting-started.md) | install, networks, reading without a key, signing with your own |
| [Reads](reads.md) | markets, fixed costs, loans, a wallet's portfolio, a vault's free cash |
| [Borrowing](borrowing.md) | the lowest fixed cost in one click, exact terms and Loan grades, 1-day loans, waiting for funding, repay, roll over, roll by itself, cash out, leverage |
| [Earn](earn.md) | partner vaults: deposits, withdrawals, exit now, collecting, leaving with gage's index off; your own vault, created and managed; a rehypo pool's exit now; a DEX's pool vaults |
| [Puts](puts.md) | puts on a lend asset's generation (a loan of the asset against USDG) |
| [LP lane](lp-lane.md) | loans against liquidity positions, LP vaults, Fables receipts, curators |
| [Lend generations](lend-generations.md) | the assets gage lends besides USDG, stablecoin markets found through the GenerationDeployer |
| [Park and unpark](park.md) | out-of-range positions into a partner vault and back, as one batch |
| [Signing](signing.md) | `run()` with your signer, signing each step yourself, signers, spend limits, what a run answers |
| [Agents](agents.md) | tools for agent frameworks, gage-mcp over stdio and its wallet, gage's hosted agent and its review links |
| [Reference](reference.md) | every method, action and tool with its inputs (generated) |

The package [README](../README.md) is the long form of each rule, and lists every refusal code in
[Errors](../README.md#errors).

gage makes fixed-cost loans with no liquidation: a loan is never closed early because a price moves, and if it is not
repaid by the end of its term the lenders keep the collateral and nothing else is taken. gage never holds a key.
