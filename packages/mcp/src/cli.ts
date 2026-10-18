#!/usr/bin/env node
/**
 * gage-mcp (D224, D225): gage's local MCP over stdio.
 * - `gage-mcp init` makes the agent's own wallet in ~/.gage (Valet) and, on the testnet, funds it from gage's faucet;
 *   it prints the address and the next step, never the key.
 * - `gage-mcp` serves the tools. Without a key it reads gage and prepares unsigned transactions. With one it also
 *   signs and sends gage's own planned transactions, and the key never leaves this process. The key comes from
 *   GAGE_PRIVATE_KEY_FILE, GAGE_PRIVATE_KEY, or the wallet `init` made.
 * It serves Robinhood Chain (4663, D260) unless GAGE_NETWORK=testnet (D311). There a key signs under spend limits (D297):
 * the owner's GAGE_MAX_BORROW_USDG, GAGE_MAX_BORROW_DAY_USDG, GAGE_MAX_DEPOSIT_USDG and GAGE_MAX_DEPOSIT_DAY_USDG (`off`
 * lifts one, D311), else 100 USDG an action and 250 in 24 hours (limits.ts); on the testnet only those set. GAGE_RPC_URL, GAGE_INDEXER_URL, GAGE_RATES_URL,
 * GAGE_VALUATION_URL and GAGE_FAUCET_URL point it elsewhere than the network's own services. In server mode stdout
 * carries MCP messages only; logs go to stderr.
 */
import path from "node:path";
import { ApiError, createGage, defaultsFor, plain, privateKeySigner, refusalOf, type GageOptions, type Network } from "gage-sdk";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Ledger, limitsFrom } from "./limits.js";
import { createLocalMcp } from "./server.js";
import { gageHome, init, keyFile, readKey } from "./wallet.js";

const log = (fields: Record<string, unknown>) => console.error(JSON.stringify({ service: "gage-mcp", ...fields }));

const [command] = process.argv.slice(2);
try {
  const env = process.env;
  const options: GageOptions = {};
  // createGage refuses a network it does not know rather than read it as the testnet.
  if (env.GAGE_NETWORK) options.network = env.GAGE_NETWORK as Network;
  if (env.GAGE_RPC_URL) options.rpcUrl = env.GAGE_RPC_URL;
  if (env.GAGE_INDEXER_URL) options.indexerUrl = env.GAGE_INDEXER_URL;
  if (env.GAGE_RATES_URL) options.ratesUrl = env.GAGE_RATES_URL;
  if (env.GAGE_VALUATION_URL) options.valuationUrl = env.GAGE_VALUATION_URL;
  const gage = createGage(options);
  const { chainId } = gage.deployment;
  const network = defaultsFor(chainId);
  const home = gageHome(env);
  // A setting that is not an amount refuses to start, rather than sign under a limit nobody meant (D297).
  const limits = limitsFrom(env, chainId);
  if (command === "init") {
    await init({
      gage, home, faucetUrl: env.GAGE_FAUCET_URL ?? network.faucetUrl, limits, out: (line) => console.log(line),
      ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    });
  } else if (command === undefined) {
    const key = readKey(env, keyFile(home, chainId), (message) => log({ event: "warning", message }));
    const signer = key ? privateKeySigner(key, { network: network.network, ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}) }) : undefined;
    // What the limits held, per wallet and chain, counted across every gage-mcp on this computer.
    const limited = signer && limits ? { limits, ledger: new Ledger(path.join(home, "limits", `${chainId}-${signer.address.toLowerCase()}`)) } : undefined;
    serveStdio(() => createLocalMcp(gage, signer, limited), { onerror: (error) => log({ event: "error", kind: error.name }) });
    log({ event: "ready", chainId, signer: signer?.address ?? null, limits: limited ? plain(limited.limits) : null });
  } else {
    throw new ApiError("UNKNOWN_COMMAND", "Usage: gage-mcp (serve the tools) or gage-mcp init (make the agent's wallet)", 400);
  }
} catch (error) {
  log({ event: "refused", ...refusalOf(error) });
  process.exit(1);
}
