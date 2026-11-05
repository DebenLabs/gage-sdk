import type { GageOptions, Network } from "gage-sdk";

/**
 * gage-sdk's options from gage-mcp's environment: GAGE_NETWORK, the services' URLs (GAGE_RPC_URL, GAGE_INDEXER_URL,
 * GAGE_RATES_URL, GAGE_VALUATION_URL) and GAGE_API_KEY, a Rates API key (D382) that gage-sdk sends to the rates service
 * only. Without one, borrowing and earning work as ever.
 */
export function gageOptions(env: NodeJS.ProcessEnv): GageOptions {
  const options: GageOptions = {};
  // createGage refuses a network it does not know rather than read it as the testnet.
  if (env.GAGE_NETWORK) options.network = env.GAGE_NETWORK as Network;
  if (env.GAGE_RPC_URL) options.rpcUrl = env.GAGE_RPC_URL;
  if (env.GAGE_INDEXER_URL) options.indexerUrl = env.GAGE_INDEXER_URL;
  if (env.GAGE_RATES_URL) options.ratesUrl = env.GAGE_RATES_URL;
  if (env.GAGE_VALUATION_URL) options.valuationUrl = env.GAGE_VALUATION_URL;
  if (env.GAGE_API_KEY?.trim()) options.apiKey = env.GAGE_API_KEY.trim();
  return options;
}
