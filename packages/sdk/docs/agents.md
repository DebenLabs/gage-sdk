# Agents

Three ways for an AI agent to use gage, from no key at all to a wallet of its own:

| | Who signs | Use |
|---|---|---|
| **Hosted agent service** (Steward) | the wallet's owner, on gage.cash's review page | `https://mcp.gage.cash/mcp` (MCP) or `https://mcp.gage.cash/v1/…` (HTTP); no install, no key |
| **gage-mcp** (Valet) | the agent, with its own wallet, under spend limits its owner sets | `npx -y gage-mcp`, over stdio on the agent's computer |
| **gage-sdk's tools** | your code: no signer, a signer, or a signer under your own limit | `gageTools(gage, { signer?, limit? })` in any agent framework |

All three serve the same tools, with the same names, inputs and words, from one catalogue in gage-sdk: reads, a
`gage_prepare_<action>` for each action served (the next unsigned transaction, signing nothing), and, with a signer,
`gage_wallet` and a `gage_<action>` that signs and sends each step. Every tool's input is in the
[Reference](reference.md). gage never holds a key, and no tool sends arbitrary calldata: text an agent reads (a token's
name, a vault's) cannot make it pay someone.

## Tools in an agent framework

```ts
const tools = gageTools(gage);
const call = (name: string, input: unknown) => {
const tool = tools.find((t) => t.name === name);
if (!tool) throw new Error(`gage serves no tool named ${name}`);
return tool.execute(input);
};
```

Each tool has a `name`, a `title`, a `description` written for a model, a zod `inputSchema`, MCP hints (`readOnlyHint` on
the reads, `destructiveHint` on the tools that sign) and `execute(input)`, which checks the input and answers plain JSON
with amounts as decimal strings. MCP servers, the Vercel AI SDK, and OpenAI's and Anthropic's agent SDKs take that shape;
with the Vercel AI SDK, `tool({ description: t.description, inputSchema: t.inputSchema, execute: t.execute })` for each.
[examples/agent-tools.ts](../examples/agent-tools.ts) lists the catalogue and makes a model's first two calls.

- **Without a signer**: the reads (eight, with the put quote where puts open, four LP reads where the LP lane is public
  and `gage_park_positions` where park is served) and one prepare per action served. Your agent prepares; a person signs.
- **With a signer**: also `gage_wallet` and one tool per action that signs for that wallet. Whether it signs under a
  spend limit is the wallet owner's choice:

```ts
const limit = usdgLimit(gage.deployment.usdg, 100_000_000n, 250_000_000n);
return gageTools(gage, { signer, limit });
```

- `createGage({ actions })` serves fewer actions; `poolVaultTools(gage)` adds `gage_pool_vaults` and
  `gage_create_pool_vaults`, which sign nothing.

## gage-mcp: the agent's own wallet

`gage-mcp` serves the catalogue over stdio, for an agent that runs commands (Claude Code, Codex, Cursor, Hermes, …).

```bash
npx -y gage-mcp init
```

`init` makes the agent's own wallet on that computer: its key in `~/.gage/agent-4663.key`, readable only by that user,
made once and never overwritten. It prints the address, its spend limits and how to add the server, never the key.
Nobody funds it but its owner: send it only what the agent may use, and a little ETH for gas. Then:

```bash
claude mcp add gage -- npx -y gage-mcp
```

Any client with an `mcpServers` file takes `{ "mcpServers": { "gage": { "command": "npx", "args": ["-y", "gage-mcp"] } } }`.
Without a key the server reads and prepares; with `init`'s wallet (or `GAGE_PRIVATE_KEY_FILE`, a key file of the agent's
own) it signs gage's own transactions with it, exact-amount approvals first, each step simulated before it is sent.

From your own code, as an MCP client ([examples/stdio-client.ts](../../mcp/examples/stdio-client.ts), in gage-mcp):

```ts
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(new StdioClientTransport({ ...server, env: { ...getDefaultEnvironment(), ...env }, stderr: "pipe" }));
```

### Spend limits

| Setting | On mainnet unless set | |
|---|---|---|
| `GAGE_MAX_BORROW_USDG` | 100 | the most one loan, loop or LP loan borrows |
| `GAGE_MAX_BORROW_DAY_USDG` | 250 | the most loans, loops and LP loans borrow in any 24 hours |
| `GAGE_MAX_DEPOSIT_USDG` | 100 | the most one deposit (a park's too) puts into a partner vault or an LP vault |
| `GAGE_MAX_DEPOSIT_DAY_USDG` | 250 | the most deposits put in in any 24 hours |

Amounts of USDG, whole or with up to six decimals; `0` stops that kind of action, `off` lifts that limit, and any other
setting stops the server from starting (`INVALID_LIMIT`). An action past a limit is refused before anything is sent
(`SPEND_LIMIT`, `SPEND_LIMIT_DAY`), and `gage_limits` says each limit, what was used in the last 24 hours and what is
left. A roll counts only what it borrows beyond the loan it repays (the same size: nothing). Repaying, withdrawing,
unparking, cashing out, exiting now, cancelling, collecting, claiming, leaving a loan to roll by itself, actions in
another asset than USDG and a rating of gage count nothing.

The 24 hours count across restarts and across every gage-mcp on the computer acting for the wallet: each hold is a file
in `~/.gage/limits/<chain>-<wallet>/`, given back if the action never went out or reverted. The limits guard against an
agent's mistakes and against instructions hidden in what it reads; an agent that can edit the server's settings or
files can lift them, so the wallet's balance is the limit that always holds.

Other settings: `GAGE_NETWORK` (`mainnet`, the default, or `testnet`), `GAGE_HOME` (`~/.gage`), `GAGE_PRIVATE_KEY_FILE`,
`GAGE_PRIVATE_KEY` (removed from the environment once read), `GAGE_RPC_URL`, `GAGE_INDEXER_URL`, `GAGE_RATES_URL`,
`GAGE_VALUATION_URL`, `GAGE_API_KEY`. gage-mcp's [README](../../mcp/README.md) has every setting.

## The hosted agent service and its review links

For a person whose agent prepares and who signs each step themselves, there is nothing to install: add
`https://mcp.gage.cash/mcp` to Claude, ChatGPT, Claude Code, Codex or any MCP client, or call the same tools over HTTP.
Every prepare carries a review link, `https://gage.cash/review#<token>`, where the wallet's owner checks each step and
confirms it in their own wallet. The service never signs and holds no key.

```ts
const response = await fetcher(`${HOSTED}/v1/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
```

- **What it prepares**: `borrow`, `leverage`, `cancel`, `reclaim`, `earn_deposit`, `earn_redeem`, `collect` and
  `feedback`, the actions the review page draws, besides every read. Rolling over, cashing out and the rest answer
  `ACTION_NOT_SERVED` there: they are done on gage.cash, or with gage-mcp or gage-sdk.
- **The answer** is `prepare`'s, plus `review: { url, expiresAt }`. A link lasts 30 minutes and plans the action again
  from the chain each time it is opened; the page shows only gage's own words and figures, never text an agent sent,
  and signs a step only if it decodes as a call gage-sdk plans for that action.
- **Reads** over HTTP: `GET /v1/capabilities`, `/v1/assets`, `/v1/borrow-quote`, `/v1/leverage-quote`, `/v1/loans/:id`,
  `/v1/portfolio/:wallet`, `/v1/earn/vaults`. Refusals are `{ error: { code, message, retryable, details? } }`, with the
  same codes as the SDK.
- `https://mcp.gage.cash/` is a plain-text guide for agents, and gage is agent #8845 in ERC-8004's registries on
  Robinhood Chain (`https://gage.cash/.well-known/agent-registration.json`).

[examples/hosted-review.ts](../examples/hosted-review.ts) prepares an action over HTTP and returns its review link.

## Rate gage

On mainnet, `feedback { score }` rates gage, agent #8845 in ERC-8004, with the wallet's own score from 0 to 100, once a
wallet, in the Reputation Registry. It is optional, and gage offers nothing for it.
