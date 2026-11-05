# Lend generations

gage lends more than USDG: one generation of partner vaults per lend asset, each with its own core, registry, factory and
vaults. A generation lends a stock token (GLD, NVDA, HIMS on mainnet) or a stablecoin. Every answer that serves amounts
names their `asset` once gage lends more than USDG, and counts them in that asset's raw units.

[examples/generations.ts](../examples/generations.ts) lists every lend market and quotes a loan paid out in one.

## The markets

```ts
// Ask gage's indexer for generations found on chain now; every other read asks at most once a minute.
await gage.refreshGenerations();
const [{ lendAssets = [] }, { assets }, { vaults }] = await Promise.all([gage.capabilities(), gage.assets(), gage.earnVaults()]);
```

`capabilities().lendAssets` names each lend asset: its token, symbol, decimals, whether it is a stablecoin (`stable`), its
core, factory and terms, and its loop and put routers where it names them. A row of `assets()` names the asset it is
borrowed in, and so does each vault of `earnVaults()`.

## Borrowing and earning in a lend asset

- `borrowQuote` and `borrow` take `lendAsset` (the asset's token): the loan is paid out and repaid in that asset, so in
  dollars what you repay moves with its price.
- `reclaim`, `roll` and `cash_out` act in the asset of the loan's own core (`engine`), and `earn_deposit` deposits in the
  vault's own asset. Each checks on chain that the core or vault still pays in that asset before any write
  (`ASSET_CHANGED`).
- Leverage and sGAGE rewards are USDG's alone; a lend asset's loop router opens puts ([Puts](puts.md)).

```ts
const quote = await gage.borrowQuote({ token: row.token, maxCollateral: parseUnits(amount, row.decimals).toString(), term: term.seconds, lendAsset: market.token });
```

## Stablecoin generations, found on chain

A release names its own generations. A later lend market, a stablecoin's, is deployed in one batch through the release's
`GenerationDeployer`, with no new manifest and no new SDK release:

- gage's indexer serves each generation it found (`GET /intent/generations`), as the manifest entry it would be.
- gage-sdk proves each one on chain before it uses it: the deployer's own `GenerationDeployed` event names its factory,
  the deployer confirms the factory is one it built, and the generation's contracts answer as the entry says. A
  generation the chain does not bear out is left out, so nothing is prepared into a contract the indexer alone names.
- Found generations join the deployment as lend assets, with `stable: true`, once their switch makes them public. A
  stablecoin generation lends against the tokens its own registry admits; it names no loop or put router.
- Every method asks at most once a minute; `refreshGenerations()` asks now. The release's own generations never depend
  on the indexer's answer.

`foundGenerationsRefresher`, `proveFoundGenerations` and `mergeFoundGenerations` are exported for a service that builds
its own context.

## Retired generations

A generation the release keeps for its positions alone reads as before, from its own index: its loans can be repaid,
cashed out where its core has a cash-out router, and their collateral collected, and its vaults withdrawn from. Nothing
rolls on it any more: `roll` and `auto_roll` are refused (`ROLLOVER_CLOSED`), a put there still closes but never rolls
(`PUT_CLOSED`), and an open loan's `note` says to repay it before it ends.
