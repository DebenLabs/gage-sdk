# Park and unpark

A liquidity position out of range holds one token and earns no fees. `park` pulls it out on its own DEX and deposits
that token into a gage partner vault, which lends it at a fixed cost with no liquidation (a loan is never closed early
because a price moves; unpaid at its end, the vault keeps the collateral and nothing else is taken). `unpark` withdraws
and opens a new position in a range you pick. Both run from the LP's own wallet, with no gage contract between: the
DEX's position manager and the vault are called as the wallet would call them, as one batch. You may end up holding the
collateral instead of the token you parked, through the vault.

[examples/park.ts](../examples/park.ts) lists the parkable positions, parks one and unparks.

## The pools

Park serves the release's LP lane's pools (`capabilities().parkPools`), whatever the lane's switch. A DEX adds its own
with `createGage({ parkPools })`: a v3-style pool by its address, tokens, fee tier and tick spacing at its
NonfungiblePositionManager (`uniswap-v3`, or `ramses-v3` for pools keyed by tick spacing), a Uniswap v4 pool by its key
at its PositionManager (hooked pools too) with the StateView that prices it, or a Fables pool by its key at its hook
(`fables`). Each is checked; one that is not refuses the Gage (`INVALID_INPUT`).

## Find what parks

```ts
const { positions } = await gage.parkPositions(wallet, also);
return positions.map((p) => ({ manager: p.manager, id: p.id, pool: p.poolName, holds: p.holds, vaults: p.vaults, refusal: p.refusal }));
```

Each out-of-range position names the one token it holds (`holds`) and the partner vaults that take it (`vaults`, each with
its `manager`, in address order: anyone can create a vault, so choose one rather than the first), or why none can (`refusal`: `ETH_NOT_SUPPORTED`, as no gage vault takes ETH yet, or `NO_VAULT`). A v3-style position manager
lists a wallet's positions; a Uniswap v4 PositionManager and a Fables hook cannot, so name those in `also` by their
manager and id (the lane's own are found through gage's index).

## Send the batch

```ts
const batch = await ask();
await sendCalls({ calls: batch.calls.map(({ to, data, value }) => ({ to, data, value })) });
if (!batch.again) return { summary: batch.summary, calls: batch.calls.length };
```

`parkCalls(input)` and `unparkCalls(input)` answer every call in order (`calls`: `to`, `data`, `value`, `extraGas`),
simulated whole first (`SIMULATION_FAILED` names the call that would revert), for `wallet_sendCalls` (EIP-5792), where
the wallet prices the batch's gas. A wallet that cannot send batches sends them in order, each once the one before is
mined, without asking again between them, each with its own estimate plus its `extraGas` as its gas limit: a vault's
deposit or withdrawal claims for each of the vault's open reward records, which an estimate can miss, and it can run out
of gas without that. `run` does all this itself. A vault with a loan past its end is settled first: that batch answers
`again: true`, and the batch is asked for again once it is mined.

- **Park** (`manager`, `id`, `vault`): the vault must take the token the position holds (`VAULT_ASSET_MISMATCH`
  otherwise); usually the DEX's own. Out of range, what the liquidity holds is fixed and is the pull's own minimum: should
  the price come back into the range first, the pull reverts and nothing moves. The position's fees come to the wallet.
  A Ramses position waits three minutes after its last liquidity change (`RAMSES_WAIT`).
- **Unpark** (`vault`, `manager`, `pool`, `tickLower`, `tickUpper`, `amount?`): withdraws at most what the vault can pay
  the wallet now (its free cash), and mints a new position in a pool served that pairs the vault's asset. A range that
  holds only the pool's other token at the price now is refused (`RANGE_WITHOUT_ASSET`); one around the price takes the
  other token from the wallet too, at most `maxSlippageBps` over what the price asks.

A park counts as a deposit against gage-mcp's spend limits; an unpark brings money back and counts nothing.
