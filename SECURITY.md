# Security

Report a vulnerability privately. Never put it in a public issue, pull request, reply or group chat.

- **gage's report form:** [gage.cash/bugbounty/report](https://gage.cash/bugbounty/report). It follows the Immunefi
  template and takes a refundable 15 USDC deposit on Base, returned with every valid report. A bounty is paid through
  this form.
- **GitHub:** [report a vulnerability](https://github.com/DebenLabs/gage-sdk/security/advisories/new) privately on this
  repository.

## Scope

gage-sdk and gage-mcp from 0.5.0, and the hosted agent service at `mcp.gage.cash` with its review links, are in scope of
gage's [bug bounty](https://docs.gage.cash/protocol/bug-bounty#agent-software) for the funds and keys of the wallets
that use them: a transaction or approval beyond the plan shown or beyond gage-mcp's spend limits, funds sent anywhere
but the wallet and gage's contracts, a review link that shows one action and asks for another signature, a wallet key
another user can read, or text from gage's services, an index or the chain that leads gage-mcp to sign.

## Supported versions

The latest release. Versions before 0.5.0 are deprecated on npm.

## Testing

Use a local install, a local fork of Robinhood Chain and throwaway keys. Never point a key that holds real funds at an
exploit, never broadcast one to a public network, and keep requests to gage's hosted services at ordinary volume. The
[bug bounty's rules](https://docs.gage.cash/protocol/bug-bounty#rules-of-engagement) apply, to agents too.
