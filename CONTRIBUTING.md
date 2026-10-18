# Contributing

This repository mirrors gage-sdk and gage-mcp from gage's main repository, which stays their source: each release lands
here as one commit. Issues and pull requests are welcome here. An accepted change is applied in the main repository and
comes back with the next release, credited in the package's changelog.

Report a security issue privately instead: see [SECURITY.md](SECURITY.md).

## Before a pull request

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Fix a bug by adding the failing test first, then the fix. Match the surrounding code: its naming, its idiom and its
comments. gage-mcp's tests read gage-sdk from source; its typecheck reads gage-sdk's build, so build first.

## Reading the code

- Comments cite gage's design decisions as `Dnnn`, from gage's own decision log, and reviews and audits by their date.
  They say why the code is as it is.
- A path a comment cites outside `packages/` (`web/`, `contracts/`, `services/`, `shared/`, `docs/`, `launch/`) is in
  gage's main repository, which is not public: the app at gage.cash, the contracts, and gage's indexer, rates and
  valuation services. The public [docs](https://docs.gage.cash), the [API reference](https://docs.gage.cash/developers/api)
  and the [contract addresses](https://docs.gage.cash/protocol/addresses) describe them.
- `packages/sdk/src/deployments/` is generated in the main repository from gage's release manifests
  (`scripts/sync-deployment.mjs`, which runs only there). Do not edit it by hand.
- Amounts are raw integers as decimal strings; use `BigInt` for arithmetic.
