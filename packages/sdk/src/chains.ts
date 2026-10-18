import { defineChain, type Chain } from "viem";
import { MAINNET, type ChainId } from "./deployment.js";

/** Multicall3, at its canonical address on both chains. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Robinhood Chain Testnet, as the app defines it (web/src/chain/chains.ts). */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Robinhood Chain Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
  testnet: true,
});

/** Robinhood Chain mainnet, as the app defines it (web/src/chain/chains.ts): its public RPC and Blockscout. */
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
});

/** The viem chain of a chain gage runs on. */
export const chainFor = (chainId: ChainId): Chain => (chainId === MAINNET ? robinhoodMainnet : robinhoodTestnet);
