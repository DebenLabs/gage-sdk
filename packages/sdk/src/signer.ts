/**
 * The agent's own signer (D224). gage never holds a key: an SDK user or the local MCP passes one in, and every action acts
 * for its address only. Any wallet that signs and sends EVM transactions fits; a viem wallet client (a local key, a
 * server wallet, an embedded wallet) and a raw private key have adapters here.
 */
import { createWalletClient, http, type Address, type Chain, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor, robinhoodTestnet } from "./chains.js";
import { ApiError, requireThat } from "./errors.js";
import { networkNamed, type Network } from "./networks.js";

export interface SignerTransaction { to: Address; data: Hex; value: bigint; gas: bigint; chainId: number }
export interface Signer {
  /** The wallet that signs: every action acts for it, and only for it. */
  readonly address: Address;
  /** Signs and sends one transaction; resolves with its hash once the network has it. */
  sendTransaction(tx: SignerTransaction): Promise<Hex>;
}

/** A signer over a viem wallet client that carries its account, for `chain`: the client's own, else the testnet. */
export function viemSigner(client: WalletClient, chain: Chain = client.chain ?? robinhoodTestnet): Signer {
  const account = client.account;
  if (!account) throw new ApiError("NO_ACCOUNT", "The wallet client has no account to sign with", 400);
  return {
    address: account.address,
    sendTransaction(tx) {
      requireThat(tx.chainId === chain.id, "CHAIN_MISMATCH", "The transaction is for another chain than the signer's", 400);
      return client.sendTransaction({ account, chain, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas });
    },
  };
}

/**
 * A signer holding a raw private key in memory, for `network`'s chain (Robinhood Chain by default since D311; "testnet"
 * is its testnet), sending through `rpcUrl` (that chain's public RPC by default). The key is never echoed: a malformed
 * one is refused in fixed words.
 */
export function privateKeySigner(key: string, options: { rpcUrl?: string; network?: Network } = {}): Signer {
  requireThat(/^0x[0-9a-fA-F]{64}$/.test(key), "INVALID_KEY", "The private key must be 0x and 64 hex digits", 400);
  const account = privateKeyToAccount(key as Hex);
  const chain = chainFor(networkNamed(options.network ?? "mainnet").chainId);
  const rpcUrl = options.rpcUrl ?? chain.rpcUrls.default.http[0];
  return viemSigner(createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }) }), chain);
}
