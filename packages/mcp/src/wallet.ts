/**
 * Valet's wallet (D225): the agent's own key, made once on this computer in ~/.gage (GAGE_HOME), readable by this
 * user only, and then read by `gage-mcp` whenever it starts. `init` makes it and, on the testnet, funds it from gage's
 * faucet; on mainnet (D297) its owner funds it. The key is never printed: only its address is.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ApiError, MAINNET, privateKeySigner, type Gage, type Signer } from "gage-sdk";
import { generatePrivateKey } from "viem/accounts";
import { limitsSentence, type Limits } from "./limits.js";

/** Where the wallet lives: GAGE_HOME, else ~/.gage. */
export const gageHome = (env: NodeJS.ProcessEnv = process.env) => env.GAGE_HOME ?? path.join(homedir(), ".gage");
/** One key per chain, so a mainnet wallet never reuses a testnet key. */
export const keyFile = (home: string, chainId: number) => path.join(home, `agent-${chainId}.key`);

/** Whether `st` is this user's and nobody else may use it as `bits` say; a system without file modes is not asked. */
const own = (st: Stats, bits: number) => process.platform === "win32" || ((process.getuid === undefined || st.uid === process.getuid()) && (st.mode & bits) === 0);
const unsafe = () => new ApiError("KEY_FILE_UNSAFE",
  "The wallet's key must be this user's own file, readable by no one else (chmod 600), in a folder only this user can write in (chmod 700); it is not used", 400);

/**
 * The wallet's own key in `file`: read only from this user's regular file that no one else can read, a link never
 * followed, in a folder no one else can write in. In a GAGE_HOME another user could write in, a key could be planted or
 * swapped for one they know, and the owner told to fund it (the audit of 18 October 2026).
 */
export function readOwnKey(file: string): string {
  const folder = statSync(path.dirname(file));
  if (!folder.isDirectory() || !own(folder, 0o022)) throw unsafe();
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw unsafe(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !own(st, 0o077)) throw unsafe();
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/** The key in `file`, made first if there is none (a link counts as one, and is refused); an existing file is never overwritten. */
export function ensureKey(file: string): { key: string; created: boolean } {
  if (lstatSync(file, { throwIfNoEntry: false })) return { key: readOwnKey(file), created: false };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const folder = statSync(path.dirname(file));
  if (!own(folder, 0o022)) throw unsafe();
  const key = generatePrivateKey();
  writeFileSync(file, `${key}\n`, { mode: 0o600, flag: "wx" });
  return { key, created: true };
}

/**
 * The key, from its file first, then the variable, then the wallet `init` made; the environment loses it either way. The
 * wallet's own key is read as `readOwnKey` reads it. A file the owner names may be a container's secret (root's, or a
 * link), so it is read as named, and `warn` says when other users can read it.
 */
export function readKey(env: NodeJS.ProcessEnv, made: string, warn: (message: string) => void = () => undefined): string | undefined {
  const file = env.GAGE_PRIVATE_KEY_FILE, inline = env.GAGE_PRIVATE_KEY;
  delete env.GAGE_PRIVATE_KEY;
  if (!file) return inline?.trim() || (lstatSync(made, { throwIfNoEntry: false }) ? readOwnKey(made) : undefined);
  let key: string;
  try {
    key = readFileSync(file, "utf8").trim();
  } catch {
    throw new ApiError("KEY_FILE_UNREADABLE", "GAGE_PRIVATE_KEY_FILE cannot be read", 400);
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) warn("GAGE_PRIVATE_KEY_FILE can be read by other users of this computer: chmod 600 it");
  return key;
}

interface FaucetLine { label: string; hash?: string; error?: string; code?: string }

/** Asks gage's testnet faucet for gas and test tokens; what it sent, by label, and what it refused. */
async function fund(faucetUrl: string, to: string, fetcher: typeof fetch): Promise<{ sent: string[]; refused: string[] }> {
  let body: unknown;
  try {
    const response = await fetcher(`${faucetUrl.replace(/\/+$/, "")}/claim/all`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to }), signal: AbortSignal.timeout(120_000),
    });
    body = await response.json();
  } catch {
    throw new ApiError("FAUCET_UNAVAILABLE", "gage's testnet faucet did not answer", 503, true);
  }
  const results = (body as { results?: FaucetLine[] }).results;
  if (!Array.isArray(results)) throw new ApiError("FAUCET_UNAVAILABLE", "gage's testnet faucet did not fund the wallet", 503, true);
  return {
    sent: results.filter((r) => r.hash).map((r) => r.label),
    refused: results.filter((r) => !r.hash).map((r) => `${r.label}${r.code ? ` (${r.code})` : ""}`),
  };
}

/** How each agent adds the server that signs with this wallet: the prompt on gage.cash says "do what it prints". */
export const NEXT = [
  "Next: add gage's MCP server, which runs `npx -y gage-mcp` and signs with this wallet, then restart so its tools load.",
  "  Claude Code: `claude mcp add gage -- npx -y gage-mcp`",
  "  Codex: `codex mcp add gage -- npx -y gage-mcp`",
  '  Hermes: under mcp_servers in ~/.hermes/config.yaml, `gage: { command: "npx", args: ["-y", "gage-mcp"] }`, then /reload-mcp',
  "  Any other agent: a stdio MCP server named gage that runs `npx -y gage-mcp`.",
] as const;
/** The same on mainnet, where the server is told its network (D260). */
export const NEXT_MAINNET = [
  "Next: add gage's MCP server, which runs `npx -y gage-mcp` on mainnet and signs with this wallet, then restart so its tools load.",
  "  Claude Code: `claude mcp add gage -e GAGE_NETWORK=mainnet -- npx -y gage-mcp`",
  "  Codex: `codex mcp add gage --env GAGE_NETWORK=mainnet -- npx -y gage-mcp`",
  '  Hermes: under mcp_servers in ~/.hermes/config.yaml, `gage: { command: "npx", args: ["-y", "gage-mcp"], env: { GAGE_NETWORK: "mainnet" } }`, then /reload-mcp',
  "  Any other agent: a stdio MCP server named gage that runs `npx -y gage-mcp` with GAGE_NETWORK=mainnet.",
] as const;

export interface InitOptions {
  gage: Gage;
  home: string;
  /** gage's testnet faucet; null skips funding. */
  faucetUrl: string | null;
  fetch?: typeof fetch;
  rpcUrl?: string;
  /** The spend limits the server will sign under (D297), said once the wallet is made; null for none (the testnet's default). */
  limits?: Limits | null;
  out: (line: string) => void;
}

/**
 * `gage-mcp init`: the wallet made or found, funded on the testnet, and the next step, in lines an agent relays. On
 * mainnet (D297) the wallet holds real money and nobody funds it but its owner; the server signs with it under spend
 * limits, which init says.
 */
export async function init(o: InitOptions): Promise<{ address: string; created: boolean; signer: Signer }> {
  const chainId = o.gage.deployment.chainId, mainnet = chainId === MAINNET;
  const file = keyFile(o.home, chainId);
  const { key, created } = ensureKey(file);
  const signer = privateKeySigner(key, { ...(o.rpcUrl ? { rpcUrl: o.rpcUrl } : {}), ...(mainnet ? { network: "mainnet" as const } : {}) });
  o.out(`Your gage wallet on Robinhood Chain${mainnet ? "" : " testnet"} (${chainId}): ${signer.address}`);
  o.out(created ? `Made just now. Its key is in ${file}, readable only by you: never print, share or move it.` : `It already existed; its key is in ${file}.`);
  if (o.faucetUrl) {
    try {
      const { sent, refused } = await fund(o.faucetUrl, signer.address, o.fetch ?? globalThis.fetch);
      if (sent.length) o.out(`Funded from gage's testnet faucet: ${sent.join(", ")}.`);
      if (refused.length) o.out(`The faucet held back: ${refused.join(", ")}. It funds a wallet once a day; what it already sent is in the wallet.`);
    } catch {
      // The wallet stands either way: say how to fund it instead of failing.
      o.out(`gage's testnet faucet did not fund it now. Run init again later, or send test USDG and a little ETH for gas to ${signer.address}.`);
    }
  } else if (mainnet) {
    o.out(`Fund it with only what the agent may use: send USDG (or the lend asset a vault you will use takes), the tokens it may pledge, and a little ETH for gas, to ${signer.address}.`);
  } else {
    o.out(`Fund it: send USDG (or the lend asset a vault you will use takes), and a little ETH for gas, to ${signer.address}.`);
  }
  if (o.limits) {
    o.out(`Spend limits: ${limitsSentence(o.limits)}`);
    o.out("Change them in the server's environment: GAGE_MAX_BORROW_USDG, GAGE_MAX_BORROW_DAY_USDG, GAGE_MAX_DEPOSIT_USDG, GAGE_MAX_DEPOSIT_DAY_USDG (amounts of USDG).");
  }
  for (const line of mainnet ? NEXT_MAINNET : NEXT) o.out(line);
  return { address: signer.address, created, signer };
}
