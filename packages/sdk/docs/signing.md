# Signing

gage never holds a key and never signs. There are two ways to carry an action out: `run()` with a signer your code holds,
or `prepare()` and any wallet that signs what it is handed. Both plan from the chain and gage's services, approve exact
amounts only (`auto_roll` and `put_auto_roll` leave the two standing approvals, and their plans say so), and simulate each
step before it is sent.

[examples/sign-yourself.ts](../examples/sign-yourself.ts) signs each step itself; [examples/spend-limit.ts](../examples/spend-limit.ts)
is a spend limit for an agent.

## run() with your signer

```ts
const listed = await gage.run({ action: "borrow", ...terms }, signer);
if (listed.status !== "done" || !listed.loan) return { quote: quote.summary, listed, funded: null, collected: null };
```

`run(input, signer, options?)` carries the whole action out for the signer's own wallet: an input naming another wallet is
refused (`WALLET_MISMATCH`). It plans once, then builds, simulates, sends and waits for each step in order. A vault's
settle comes first where one is due, then the action is planned again.

A refusal found before any step throws an `ApiError`. Once planned, `run` answers:

| Field | |
|---|---|
| `status` | `done` (every step succeeded), `nothing_to_do` (the plan had no step), or `stopped` (see `error`; what is in `sent` stands) |
| `sent` | each transaction sent: `label`, `kind` (`approve` or `action`), `hash`, `outcome` (`succeeded`, `reverted`, or `pending`: not mined within two minutes, so look it up before acting again) |
| `unsent` | the steps never sent, by label |
| `error` | why it stopped, in fixed words: `{ code, message, retryable }` |
| `loan` | the loan the action opened, read from its receipt (`{ engine, loanId }`): a borrow's listing, a loop's, a roll's new loan, a put opened or rolled, an LP loan borrowed or rolled; `null` otherwise |
| `summary`, `notes` | the plan in words |

`options.onStep(step)` is called as each sent step settles, for progress, and `options.limit` is a spend limit (below).
Once a transaction has gone out, `run` always answers: what `onStep` throws or rejects with, or a limit's `release`, stops
nothing, and `notes` say what failed.

`SEND_FAILED`: the signer did not send and the wallet's nonce did not move, so nothing went out. `SEND_UNKNOWN`: the signer
failed after the wallet sent a transaction, which may be this step's; look up the wallet's latest transaction before
sending the action again.

## Signers

A signer is `{ address, sendTransaction(tx) }`, where `tx` is `{ to, data, value, gas, chainId }` and the answer is the
transaction's hash once the network has it. Any wallet fits.

- `privateKeySigner(key, { network?, rpcUrl? })` holds a raw key in memory, for mainnet unless `network` is `"testnet"`. A
  malformed key is refused in fixed words, never echoed (`INVALID_KEY`).
- `viemSigner(walletClient, chain?)` wraps a viem wallet client that carries its account (`NO_ACCOUNT` otherwise): a local
  account, a server wallet, an embedded wallet. It signs for the client's own chain, or for the chain you pass, and
  Robinhood Chain where neither names one; another chain's transaction is refused (`CHAIN_MISMATCH`), which `run` answers
  as itself.
- An ethers signer in three lines:
  `{ address: await wallet.getAddress(), sendTransaction: async (tx) => (await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gas, chainId: tx.chainId })).hash }`.

## Sign each step yourself

For a browser wallet, a custody API or anything that signs what it is handed: prepare, sign `next`, wait for it, prepare
again.

```ts
const plan = await gage.prepare(input);
if (plan.status === "done" || !plan.next) return { status: "done" as const, sent, summary: plan.summary };
// Park and unpark answer every call at once, from one reading of the chain: send those together (examples/park.ts).
if (plan.calls) throw new Error("This action's calls go together: send plan.calls in order, without preparing again");
const hash = await wallet.sendTransaction(plan.next.transaction);
sent.push({ label: plan.next.label, hash });
const receipt = await wallet.waitForReceipt(hash);
if (receipt.status !== "success") return { status: "reverted" as const, sent, summary: plan.summary };
// The action itself went out: preparing again would plan it a second time.
if (plan.next.final && !plan.again) return { status: "done" as const, sent, summary: plan.summary };
```

`prepare({ action, wallet, … })` answers:

- `status`: `approval_required` (the next transaction is an exact-amount approval), `ready`, `done`, or `partial` (nothing
  to send from what could be read, but part of it did not answer, so more may be ready: `notes` say what, and prepare again
  shortly).
- `next`: `{ label, kind, final, transaction: { from, to, data, value, chainId, gas } }`, simulated now, or `null`. `gas` is
  the simulation's estimate, to which a wallet adds its own headroom; a partner vault's settle, deposit or withdrawal
  already carries a floor for the reward claims it makes.
- `then`: the labels of the steps after it. `summary` (a title and rows of figures in words) and `view` (the figures,
  raw) say what the action does; `notes` what to know.
- `again: true`: `next` is a step that comes first (a vault's settle), and the action itself is prepared again once it is
  mined, so `next` is not its last transaction although `then` is empty.
- `calls`: for park and unpark, every transaction at once, built from one reading of the chain: send them in order or as
  one batch, and do not prepare again between them.
- `preview`: for an action that pays out over time, what it pays and when ([Earn](earn.md#previews)).

When `status` is `ready` and `next.final` is true, send it once: a second send would list, loop, roll, deposit or redeem
again. Never send an earlier answer's `next` after the state has changed: prepare again.

## Spend limits

`run(input, signer, { limit })` and `gageTools(gage, { signer, limit })` take a spend limit: a function asked with each
action's plan (its `view`) before anything is sent. It throws to refuse, and nothing is sent; or it holds the amount and
returns `{ release(sent) }`, called when the run ends with whether the action itself went out, so a hold for an action
that never went out can be given back.

```ts
return (view) => {
const amount = counted(view, usdg);
if (amount === 0n) return { release: () => undefined };
if (amount > each) throw new ApiError("SPEND_LIMIT", "Over this agent's limit for one action", 403);
```

gage-mcp builds its limits on this ([Agents](agents.md#spend-limits)): loans, loops and LP loans in USDG count their
principal, deposits (into an LP vault too, and a park) their amount, a roll only what it borrows beyond the loan it
repays; repaying, withdrawing, cashing out, collecting, exiting now and actions in another asset than USDG count nothing.
Whether an agent signs under a limit is its wallet owner's choice.

## Batches

Park and unpark are built as one batch (`parkCalls`, `unparkCalls`, and `prepare`'s `calls`), for EIP-5792
`wallet_sendCalls`, simulated whole first ([Park and unpark](park.md)). Sent one by one instead, each call's gas limit is
its own estimate plus its `extraGas`. A DEX's pool vaults come as one batch from their
curator, or a Safe{Wallet} Transaction Builder file ([Earn](earn.md#pool-vaults-for-a-dex)). `run()` waits on each
transaction's hash, so a Safe signs through `prepare` or the Transaction Builder, not `run`.
