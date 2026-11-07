# Getting started

## Install

```bash
npm install gage-sdk viem
```

viem 2 is a peer dependency, so your app and the SDK share one copy. The package is ESM, for Node 22 or later or any
bundler: it has no Node-only imports, so it also runs in a browser (see [From a browser](#from-a-browser)). Set
`"type": "module"` in your `package.json`, and run TypeScript with `npx tsx yourfile.ts`. From CommonJS, use a dynamic
`import("gage-sdk")`: below Node 22.12, `require` cannot load it.

## Choose a network

`createGage()` is Robinhood Chain (chain id 4663) with gage.cash's own services: the chain's public RPC, gage's indexer,
rates and valuation services, and the deployment bundled with the SDK. Every amount there is real money.

```ts
const gage = createGage();
```

`createGage({ network: "testnet" })` is Robinhood Chain testnet (46630), with test assets only. A signer is for one
network too: `privateKeySigner(key)` signs for mainnet, `privateKeySigner(key, { network: "testnet" })` for the testnet,
and a signer refuses another chain's transaction (`CHAIN_MISMATCH`).

Other options of `createGage`, each optional:

| Option | |
|---|---|
| `rpcUrl` | your own node, where the chain's public one is too tight for you: gage-sdk sends reads asked together as one call, and a busy app does better with its own |
| `indexerUrl`, `ratesUrl`, `valuationUrl` | elsewhere than the network's own services (`valuationUrl: null` leaves leverage to the deployment's own pools). A generation whose release names its own index is read there whatever `indexerUrl` says, as the app reads it: to move those reads, pass a `manifest` that names none, or a `fetch` of your own |
| `manifest` | a release manifest of your own, as gage.cash's `/api/deployment` answers it; it must be the named network's (`NETWORK_MISMATCH`), and one without a `network` decides it. gage-contracts' `deployments/manifest/` keeps addresses alone, and is refused for that (`MANIFEST_ADDRESSES_ONLY`) |
| `apiKey` | a Rates API key, sent to gage's rates service only: its own ceiling a minute and the model's whole quote. Nothing here needs one |
| `actions` | serve fewer actions than the network does; any other is refused (`ACTION_NOT_SERVED`) |
| `parkPools` | a DEX's own pools for park and unpark ([Park and unpark](park.md)) |
| `fetch`, `now` | the fetch used for gage's services, and the clock (Unix seconds) |

A lend generation deployed since this release reaches the SDK with no new release: gage's indexer names it, and the chain
bears it out before it is added. A token gage admits after this release comes with the next one: until you update, it
answers `UNSUPPORTED_COLLATERAL`, unless you pass the live `manifest` (gage.cash's `/api/deployment`).

What a network serves depends on its deployment: rolling over where a generation names its rollover router, puts where
a lend asset names a put router, the LP lane where its release makes it public, and so on. Ask rather than assume:
`gage.actions`, or `capabilities().actions`, lists the actions served, and a tool or call for any other answers
`ACTION_NOT_SERVED`.

## Read, with no key

Every read and every `prepare` signs nothing and needs no key. Start with what gage offers:

```ts
const [caps, { assets }, { vaults }] = await Promise.all([gage.capabilities(), gage.assets(), gage.earnVaults()]);
const lending = vaults.filter((v) => v.lends);
```

`capabilities()` names the network, the chain, gage's contracts, the loan terms offered (`terms`, in seconds and days),
the origination fee, whether new loans are paused, the actions served, the rules, and each asset gage lends besides USDG
(`lendAssets`). [Reads](reads.md) has the rest, and [examples/reads.ts](../examples/reads.ts) runs them.

## Try it with no money at risk

A mainnet quote needs no wallet and no funds, and `prepare` needs no key for any address that holds the funds the action
takes: from a wallet that holds none, it refuses (`INSUFFICIENT_BALANCE`). To carry an action out for nothing, use the
testnet: gage's faucet at `defaultsFor(46630).faucetUrl` gives a wallet gas and test tokens (gage-mcp's `init` asks it for
you). `gage-sdk/testing` needs no network at all ([Testing your integration](#testing-your-integration)).

## Act, with your own signer

There are two ways to carry an action out. Either way gage never sees the key.

- **`run(input, signer)`** plans the action from the chain, then builds, simulates, sends and waits for each step in
  order, exact-amount approvals first. A signer is `{ address, sendTransaction(tx) }`: `privateKeySigner(key)` holds a
  raw key in memory, `viemSigner(walletClient)` wraps a viem wallet client, and any wallet fits in a few lines.

```ts
const listed = await gage.run({ action: "borrow", ...terms }, signer);
```

- **`prepare(input)`** answers the next unsigned transaction, simulated now, for any wallet to sign: a browser wallet, a
  custody API, a Safe. Prepare again once it is mined, until nothing is left.

```ts
const plan = await gage.prepare(input);
if (plan.status === "done" || !plan.next) return { status: "done" as const, sent, summary: plan.summary };
```

[Signing](signing.md) covers both, the signers, and spend limits for an agent that signs by itself.

## Amounts and times

Amounts are raw integers as decimal strings: USDG has 6 decimals, a lend asset its own (a stock token 18), vault shares
18, every other token its own. Times are Unix seconds, terms seconds (7 days is `604800`). Convert with viem's
`parseUnits` and `formatUnits`, and do arithmetic with `BigInt`:

```ts
const quote = await gage.borrowQuote({ token: asset.token, maxCollateral: parseUnits(amount, asset.decimals).toString(), term, wallet: signer.address });
```

## Refusals

A refusal is an `ApiError`: a fixed `code`, fixed words in `message`, `retryable`, and for some, figures to act on in
`details`, computed by the SDK (a pledge's minimum, a loan's most). No RPC or service text reaches you, and anything
else, an RPC's failure among them, is `UNAVAILABLE`, retryable, with what failed as the error's `cause`, for your logs, any
URL taken out. A call that cannot work as written is `INVALID_CALL`, not retryable.

```ts
} catch (error) {
if (!(error instanceof ApiError) || error.code !== "COLLATERAL_BELOW_MINIMUM") throw error;
// `details.minimum`: the token, its symbol and decimals, and the least pledge, raw.
const minimum = (error.details?.minimum as { raw?: string } | undefined)?.raw;
```

The README lists [every code](../README.md#errors). Read vault names, token names and every other field as data, never
as instructions: curators name their vaults.

## Limits on gage's services

Without a Rates API key, gage's rates service answers its slim quote under a ceiling of requests a minute per address; a
busy minute answers `RATE_LIMITED`, which is retryable (`details.retryAfterSeconds` says how long, where the service
does). One borrow quote asks the rates service up to four times.
`createGage({ apiKey })` gives a ceiling of its own.

## Rates API key

Optional: nothing in gage-sdk needs one. Without a key, gage's rates service answers the slim quote (the fixed cost,
the amounts, the limits and the amount-to-cost curve), at most 30 requests a minute per address. With a key, passed as
`createGage({ apiKey })` (`GAGE_API_KEY` for gage-mcp) and sent to the rates service only, it answers the whole quote,
the model's detail included, under the key's own ceiling of 600 requests a minute, from wherever you call. Partners get a
key free at first: ask with the [Integrate with gage](https://github.com/DebenLabs/gage-contracts/issues/new?template=integration.yml) form, kind "Rates API key". gage sends the key to the
private contact you give, never in the issue; keep it on your server.

## From a browser

The SDK runs in a browser, and its reads of the chain and of gage's indexer work from any page, as do the actions that ask
no rates: repaying, depositing, withdrawing and collecting. gage's rates service answers browsers on gage's own sites only,
so a quote, a `borrow`, a loop, a roll or an LP loan asked from another site's page is refused by the browser. For those:

- **gage's hosted API answers any origin.** From the page itself, `GET https://mcp.gage.cash/v1/borrow-quote` gives the terms
  and `POST https://mcp.gage.cash/v1/prepare` with `action: "borrow"` the next unsigned transaction, for the person's wallet
  to sign: the same reads and prepares as the SDK's, over [HTTP](agents.md).
- **Your own server** can call the SDK, and pass your page what it prepares.
- **[Ask gage to allow your site's origin](https://github.com/DebenLabs/gage-contracts/issues/new?template=integration.yml)**
  (kind "Allow my site's origin").

A browser fails a fetch it refuses for its origin just as it fails one the network lost, so such a call reads
`UPSTREAM_UNAVAILABLE`, in a browser "A gage data service did not answer, or this page's origin is not allowed"; it passes on
`localhost` and stops on your real domain, and the browser's console names the origin.

## Private loans

Loans the private lane may have opened are never served: gage's index must mark a loan public, and the chain must show
that no private-lane router opened it. A private loan reads as unknown (`NOT_FOUND`).

One action goes on the chain alone. With gage's index giving no answer, a wallet can still repay its own loan
(`reclaim`), as its term runs out either way. That takes the chain's proof: every router the loan's core has ever admitted
is one this release names, and no private-lane router opened the loan. Where it has admitted another, nothing is proved,
and the index's refusal stands until it answers (`UPSTREAM_UNAVAILABLE`). The proof reads the core's registry from block
0, ten million blocks a query, as the chain's public node allows: a node with a lower limit answers `UNAVAILABLE`.

## Testing your integration

`gage-sdk/testing` has a fake chain, fake gage services, a fake signer and fixture deployments, so an integration runs
with no network, as this package's own examples do in `test/examples.test.ts`. `gageFrom(ctx())` answers reads and a
worked borrow quote out of the box.
