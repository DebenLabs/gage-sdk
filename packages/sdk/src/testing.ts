/**
 * gage-sdk/testing: a chain and gage's services as fakes, for this package's tests, the servers built on it, and any
 * integration that wants to exercise gage without a network. Everything answers "in order" unless a test changes it.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { testnetAggregatorAbi } from "./aggregatorCall.js";
import type { Chain, Loan, PoolState, Sent, TokenConfig, V3PoolState, VaultBook } from "./chain.js";
import { parseDeployment, type Deployment } from "./deployment.js";
import { ApiError } from "./errors.js";
import type { Ctx } from "./plans.js";
import type { Signer, SignerTransaction } from "./signer.js";
import type { Upstream } from "./upstream.js";

export const NOW = 1_800_000_000;
export const WALLET = "0x35FC9eCcD25E0F9333969a9b41f23bfa6CB4BC07" as Address;
export const OTHER = "0x9999999999999999999999999999999999999999" as Address;
export const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
export const USDG = A(0x10), NVDA = A(0x11), CORE = A(0x20), OLD = A(0x21), REG = A(0x30), REWARDS = A(0x40), FACTORY = A(0x50), ROUTER = A(0x60), VAULT = A(0x70), ACCOUNT = A(0x80), STATE_VIEW = A(0x90);
/** The loop router's V3 factory, as the fake chain answers `V3_FACTORY()` (D242). */
export const V3_FACTORY = A(0xa0);
/** The core's rollover router and gage's keeper, the one account a roll instruction names (D285). */
export const ROLL_ROUTER = A(0xb0), KEEPER = A(0xc0);
/** The core's cash-out router (D245). */
export const CASHOUT = A(0xd8);
/** A private-lane router of the core (D201): the fixture manifests name none, so a test that wants the lane adds it. */
export const PRIVATE_ROUTER = A(0x61);
/**
 * A lend-asset generation (D251, Intent D55): GLDx, an 18-decimal stock token, lent by its own core, registry, factory
 * and vault against SCHIFFYx, a meme the release does not otherwise list. `assetManifest()` publishes it.
 */
export const GLDX = A(0x12), SCHIFFY = A(0x13), GLD_CORE = A(0x22), GLD_REG = A(0x31), GLD_REWARDS = A(0x41), GLD_FACTORY = A(0x51), GLD_VAULT = A(0x71);

/** The fixture manifest with GLDx's generation public (and a second one, NVDAx's, hidden), as `intentV1Assets` names them. */
export const assetManifest = (over: { public?: boolean } = {}) => {
  const entry = (symbol: string, token: Address, core: Address, registry: Address, rewards: Address, factory: Address, collateral: Address, collateralSymbol: string, open: boolean) => ({
    lendAsset: { token, symbol, decimals: 18, stable: false }, public: open, generation: `lend-${symbol.toLowerCase()}-r1-20261016`,
    factory, core, reserve: A(0xf0), reserveLens: null, reserveKind: "closed", mandateVersion: 12, quoteVerifier: A(0xf1), fillRouter: A(0xf2),
    gradeRegistry: A(0xf3), feeProcessor: A(0xf4), startBlock: 2,
    engine: { registry, registryArtifact: "GageV2TokenRegistry", rewards, cashoutRouter: A(0xf5), flashPool: A(0xf6), startBlock: 1, grace: 0, terms: [604_800, 1_814_400], bridged: false, rewardTerms: "none" },
    collateral: [{ symbol: collateralSymbol, token: collateral, category: "MEME" }],
    cashoutPools: [],
  });
  return {
    ...manifest(),
    intentV1Assets: {
      GLDx: entry("GLDx", GLDX, GLD_CORE, GLD_REG, GLD_REWARDS, GLD_FACTORY, SCHIFFY, "SCHIFFYx", over.public ?? true),
      NVDAx: entry("NVDAx", A(0x14), A(0x23), A(0x32), A(0x42), A(0x52), A(0x15), "AIx", false),
    },
  };
};

export const manifest = () => ({
  chainId: 46630, USDG, StateView: STATE_VIEW,
  nativeV2: {
    engines: [
      { engine: OLD, registry: REG, rewards: REWARDS, name: "Old" },
      { engine: CORE, registry: REG, rewards: REWARDS, name: "Core", cashoutRouter: CASHOUT },
    ],
    assets: [{ token: NVDA, symbol: "NVDAx", name: "NVIDIA (testnet)", decimals: 18, lane: "STOCK" }],
  },
  intentV1: { core: CORE, factory: FACTORY, loopRouter: ROUTER, rolloverRouter: ROLL_ROUTER },
  rolloverExecutor: KEEPER,
  pools: {
    nvdaxUsdg: { currency0: NVDA, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: A(0) },
    usdgEth: { currency0: A(0), currency1: USDG, fee: 3000, tickSpacing: 60, hooks: A(0) },
  },
});

/** The fixture manifest as mainnet's (D260): chain 4663, its Intent core public, as the SDK requires there. */
export const mainnetManifest = () => ({ ...manifest(), chainId: 4663, intentV1: { ...manifest().intentV1, public: true } });

export const loan = (over: Partial<Loan> = {}): Loan => ({
  originator: WALLET, account: ACCOUNT, token: NVDA, collateralBeneficiary: A(0), state: 2, filled: 4, term: 604_800,
  fundingDeadline: NOW + 86_400, fundedAt: NOW - 3600, closedAt: 0, principal: 1_000_000_000n, cap: 1_010_000_000n, originationFee: 10_000_000n,
  collateral: 5n * 10n ** 18n, ...over,
});

/**
 * The fake NVDAx/USDG pool: NVDAx (currency0, 18 decimals) at 200 USDG (currency1, 6 decimals), a 0.3% LP fee and
 * deep active liquidity, so a buy of a few tokens costs its value, the fee and a sliver of price impact.
 */
export const POOL: PoolState = { sqrtPriceX96: 1_120_455_419_495_722_798_374_638n, tick: -223_339, liquidity: 10n ** 24n, lpFee: 3000, protocolFee: 0 };
/**
 * A fake USDG/NVDAx V3 pool, for a manifest that names one (the fixture manifest names none, as the testnet's): USDG
 * sorts first (token0), NVDAx at 200 USDG, a 0.05% fee tier and deep active liquidity, so it sells cheaper than POOL.
 */
export const V3_POOL: V3PoolState = { sqrtPriceX96: 5_602_277_097_478_613_991_873_193_822_745_817n, tick: 223_338, liquidity: 10n ** 18n, fee: 500, tickSpacing: 10 };

/** A chain where everything is in order unless a test changes it; every sent transaction is mined successfully. */
export function fakeChain(over: Partial<Record<keyof Chain, unknown>> = {}): Chain & { simulated: unknown[] } {
  const simulated: unknown[] = [];
  const cfg: TokenConfig = { allowed: true, lane: 0, minAmount: 10n ** 18n, maxDealRaw: 1000n * 10n ** 18n, maxOpenRaw: 10_000n * 10n ** 18n };
  const base: Chain = {
    head: () => Promise.resolve({ number: 1n, timestamp: NOW }),
    loan: () => Promise.resolve(loan()),
    ownerOf: () => Promise.resolve(WALLET),
    // No private-lane router opened any loan, unless a test says so.
    privateLoans: (_core, _routers, ids) => Promise.resolve(ids.map(() => false)),
    released: () => Promise.resolve(false),
    cashCredit: () => Promise.resolve(0n),
    tokenConfig: () => Promise.resolve(cfg),
    terms: () => Promise.resolve([604_800, 1_814_400]),
    feeBps: () => Promise.resolve(100),
    paused: () => Promise.resolve(false),
    balance: () => Promise.resolve(10n ** 30n),
    nativeBalance: () => Promise.resolve(10n ** 18n),
    allowance: () => Promise.resolve(0n),
    poolState: () => Promise.resolve(POOL),
    v3PoolState: () => Promise.resolve(V3_POOL),
    // No initialized tick anywhere: each pool is one range, its active liquidity all the way.
    tickBitmap: () => Promise.resolve(0n),
    tickLiquidityNet: () => Promise.resolve(0n),
    loopV3Factory: () => Promise.resolve(V3_FACTORY),
    loopExecutorAllowed: () => Promise.resolve(true),
    loanRewards: () => Promise.resolve(0n),
    approvedFor: () => Promise.resolve(A(0)),
    approvedForAll: () => Promise.resolve(false),
    autoRoll: () => Promise.resolve(null),
    rolloverPaused: () => Promise.resolve(false),
    cashoutExecutorAllowed: () => Promise.resolve(true),
    // No route of gage's own goes through, so an aggregator's sale is weighed against none unless a test says so.
    cashoutRouteNet: () => Promise.resolve(null),
    // Every vault is the USDG factory's, on the core, but GLDx's vault, which is GLDx's factory's, on GLDx's core.
    isVault: (factory: Address, vault: Address) => Promise.resolve(vault.toLowerCase() === GLD_VAULT ? factory.toLowerCase() === GLD_FACTORY : factory.toLowerCase() !== GLD_FACTORY),
    vaultCore: (vault: Address) => Promise.resolve(vault.toLowerCase() === GLD_VAULT ? GLD_CORE : CORE),
    vaultShares: () => Promise.resolve(10n ** 18n),
    // Every vault has a million units' worth of other holders' shares, worth what they started at, all of it free cash.
    vaultBook: (vault: Address): Promise<VaultBook> => Promise.resolve({
      totalAssets: vault.toLowerCase() === GLD_VAULT ? 10n ** 24n : 10n ** 12n, totalSupply: 10n ** 24n,
      free: vault.toLowerCase() === GLD_VAULT ? 10n ** 24n : 10n ** 12n, performing: 0n,
    }),
    pocketClaimable: () => Promise.resolve(0n),
    vaultRewards: () => Promise.resolve(0n),
    // What each core and vault pays in: GLDx's own, USDG everywhere else.
    coreAsset: (core: Address) => Promise.resolve(core.toLowerCase() === GLD_CORE ? GLDX : USDG),
    vaultAsset: (vault: Address) => Promise.resolve(vault.toLowerCase() === GLD_VAULT ? GLDX : USDG),
    tokenInfo: (token: Address) => Promise.resolve(token.toLowerCase() === SCHIFFY ? { symbol: "SCHIFFYx", decimals: 18 } : { symbol: "TOKEN", decimals: 18 }),
    // No wallet owns or operates gage's ERC-8004 entry, and none has rated it yet.
    agentAuthorized: () => Promise.resolve(false),
    feedbackCount: () => Promise.resolve(0n),
    // The wallet's nonce stays put: a signer that fails took nothing to the network.
    nonce: () => Promise.resolve(0),
    simulate: (call) => { simulated.push(call); return Promise.resolve(100_000n); },
    sent: (): Promise<Sent | null> => Promise.resolve(null),
    wait: () => Promise.resolve(true),
  };
  return Object.assign(base, over, { simulated });
}

/** gage's services answering from a table of path prefixes (the longest match wins). */
export function fakeUpstream(routes: Record<string, unknown>): Upstream & { asked: string[] } {
  const asked: string[] = [];
  const find = (path: string) => {
    asked.push(path);
    const key = Object.keys(routes).filter((k) => path.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return { status: 404, body: { error: { code: "NOT_FOUND" } } };
    const r = routes[key];
    return typeof r === "function" ? (r as (p: string) => { status: number; body: unknown })(path) : { status: 200, body: r };
  };
  return {
    asked,
    raw: (path) => Promise.resolve(find(path)),
    get(path, schema) {
      const { status, body } = find(path);
      if (status !== 200) return Promise.reject(new ApiError(status === 404 ? "NOT_FOUND" : "UPSTREAM_UNAVAILABLE", "gage has no record of that", status === 404 ? 404 : 503));
      return Promise.resolve(schema.parse(body));
    },
  };
}

export const position = (id: string, over: Record<string, unknown> = {}, loanOver: Record<string, unknown> = {}) => ({
  engine: CORE.toLowerCase(), id,
  loan: { originator: WALLET, account: ACCOUNT, token: NVDA, collateralBeneficiary: A(0), state: 2, filled: 4, term: 604800, fundingDeadline: NOW + 86_400,
    fundedAt: NOW - 3600, closedAt: 0, principal: "1000000000", cap: "1010000000", originationFee: "10000000", borrowerReward: "0", lenderReward: "0", collateral: "5000000000000000000", ...loanOver },
  slots: [A(0), A(0), A(0), A(0)], owner: WALLET, private: false, ...over,
});

export const preview = (fills = true) => ({
  schema: "gage-intent-preview-v1", status: "ok", refusal: null,
  vaults: [{ vault: VAULT, loanPrincipal: "0", totalAssets: "10000000000", options: [1, 2, 3, 4].map((u) => ({ units: u, principal: String(u * 250_000_000), executionFee: String(u * 1000), refusal: null })) }],
  summary: { units: fills ? 4 : 2, fills, reason: fills ? null : "NO_ROOM" },
});

/**
 * The rates service's signed loop plan (`GET /intent/loop/quotes/:engine`), echoing the terms and allocations it is asked
 * for, as a `fakeUpstream` route: every one of its vaults' ceilings is 7 shares.
 */
export const signedLoop = (path: string) => {
  const q = new URL(path, "http://rates.test").searchParams;
  const allocations = (q.get("allocations") ?? "").split(",").map((x) => {
    const [vault, units] = x.split(":");
    return { vault, units: Number(units), principal: "0", interest: "0", minimum: "0", executionFee: "0", maxReserveShares: "7", minRateGrade: 0, capBps: 0, managerBps: 0 };
  });
  return { status: 200, body: { schema: "gage-intent-quote-v2", status: "authorized", refusal: null, unsigned: null, authorization: {
    plan: {
      engine: CORE, listingId: "9", filler: ROUTER, token: q.get("token"), kind: 0, collateral: q.get("collateral"), principal: q.get("principal"), cap: q.get("cap"),
      term: Number(q.get("term")), costBps: 100, feePolicy: 0, epoch: "1", issuedAt: NOW, expiry: NOW + 30, evidence: `0x${"ab".repeat(32)}`, allocations,
    },
    signature: `0x${"cd".repeat(65)}`, expiresAt: NOW + 30, pricing: `0x${"ef".repeat(32)}`,
  } } };
};

/**
 * The rates service's roll quote (`GET /intent/roll/quotes/:engine`, D285) for the fixture loan, as a `fakeUpstream` route:
 * the same 1,000 USDG on the same 5 NVDAx for the term asked, repaying `cap` (1,008 USDG by default), three plans signed
 * for the router and bound to the borrower asked for. Its wallet part is the core's: a 1% fee, against the old 1,010.
 */
export const rollQuote = (over: { cap?: bigint; principal?: bigint; oldCap?: bigint } = {}) => (path: string) => {
  const q = new URL(path, "http://rates.test").searchParams;
  const principal = over.principal ?? 1_000_000_000n, cap = over.cap ?? 1_008_000_000n, oldCap = over.oldCap ?? 1_010_000_000n;
  const fee = principal / 100n, payout = principal - fee, term = Number(q.get("term"));
  const pricing: Hex = `0x${"12".repeat(32)}`;
  const evidence = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [q.get("borrower") as Address, pricing]));
  const allocations = [{ vault: VAULT, units: 4, principal: String(principal), interest: String(cap - principal), minimum: "0", executionFee: "0", maxReserveShares: "7", minRateGrade: 0, capBps: 0, managerBps: 0 }];
  const plans = [9, 10, 11].map((id) => ({
    listingId: String(id), signature: `0x${"cd".repeat(65)}`,
    plan: { engine: CORE, listingId: String(id), filler: ROLL_ROUTER, token: NVDA, kind: 0, collateral: "5000000000000000000", principal: String(principal), cap: String(cap), term,
      costBps: 80, feePolicy: 0, epoch: "1", issuedAt: NOW, expiry: NOW + 30, evidence, allocations },
  }));
  return { status: 200, body: {
    schema: "gage-intent-roll-quote-v1", status: "authorized", refusal: null, unsigned: null, router: ROLL_ROUTER,
    terms: { token: NVDA, collateral: "5000000000000000000", principal: String(principal), cap: String(cap), term },
    wallet: { feeBps: 100, fee: String(fee), payout: String(payout), repayment: String(oldCap), topUp: String(oldCap > payout ? oldCap - payout : 0n), surplus: String(payout > oldCap ? payout - oldCap : 0n), allInBps: 180 },
    authorization: { plans, expiresAt: NOW + 30, pricing },
  } };
};

/**
 * An aggregator's call that makes exactly the sale `want` describes, as the testnet's stand-in builds one (D245): what
 * `aggregatorCallOk` takes, for a fixture route of the valuation service.
 */
export const swapCall = (want: { tokenIn: Address; amountIn: bigint; tokenOut: Address; recipient: Address; minOut: bigint }): Hex =>
  encodeFunctionData({ abi: testnetAggregatorAbi, functionName: "swap", args: [{ ...want, minReturn: want.minOut, deadline: BigInt(NOW + 120), paths: [] }] });

/**
 * The valuation service's sale of the fixture loan's 5 NVDAx (`GET /quote/cashout-sale`, D245), as a `fakeUpstream` route:
 * 1,100 USDG quoted, 25 bps of call slippage (or `callSlippageBps`), the 1,010 USDG cap lent by a 0.01% pool, its call
 * exactly that sale.
 */
export const cashoutSale = (over: { amountOut?: bigint; recipient?: Address; executor?: Address; status?: number; callSlippageBps?: number } = {}) => (path: string) => {
  const q = new URL(path, "http://valuation.test").searchParams;
  const slippage = over.callSlippageBps ?? 25;
  const amountOut = over.amountOut ?? 1_100_000_000n, cap = 1_010_000_000n, minOut = (amountOut * (10_000n - BigInt(slippage))) / 10_000n, fee = (cap * 100n + 999_999n) / 1_000_000n;
  const net = (x: bigint) => { const r = x - cap - fee; return r - (r * 50n) / 10_000n; };
  if (over.status) return { status: over.status, body: { error: { code: "NO_ROUTE" } } };
  return { status: 200, body: {
    schema: "gage-cashout-sale-v1", chainId: 46630, source: "kyberswap", engine: q.get("engine"), router: CASHOUT, loanId: q.get("loanId"), token: NVDA,
    amountIn: "5000000000000000000", cap: String(cap), amountOut: String(amountOut), minOut: String(minOut), executor: over.executor ?? A(0xe8),
    data: swapCall({ tokenIn: NVDA, amountIn: 5n * 10n ** 18n, tokenOut: USDG, recipient: over.recipient ?? CASHOUT, minOut }),
    lender: { pool: A(0xe9), flashToken: A(0xea), flashFee: 100 }, flashFee: String(fee), netAtQuote: String(net(amountOut)), netAtMinimum: String(net(minOut)),
    callSlippageBps: slippage, netToleranceBps: 50, deadline: NOW + 120,
  } };
};

/** A context over the fakes; `d` replaces the fixture manifest's deployment, `valuation` adds the valuation service. */
export function ctx(over: { d?: Deployment; chain?: Chain; indexer?: Upstream; rates?: Upstream; valuation?: Upstream } = {}): Ctx {
  return {
    d: over.d ?? parseDeployment(manifest()), chain: over.chain ?? fakeChain(), indexer: over.indexer ?? fakeUpstream({}),
    rates: over.rates ?? fakeUpstream({ "/intent/preview/": preview() }), now: () => NOW,
    ...(over.valuation ? { valuation: over.valuation } : {}),
  };
}

/** A signer that records what it is asked to send and answers with sequential hashes; `fail` makes it refuse. */
export function fakeSigner(address: Address = WALLET, fail = false): Signer & { sent: SignerTransaction[] } {
  const sent: SignerTransaction[] = [];
  return {
    address, sent,
    sendTransaction(tx) {
      if (fail) return Promise.reject(new Error("insufficient funds for gas * price + value: https://rpc.example/secret"));
      sent.push(tx);
      const hash: Hex = `0x${sent.length.toString(16).padStart(64, "0")}`;
      return Promise.resolve(hash);
    },
  };
}

export const hex = (s: string) => s as Hex;
