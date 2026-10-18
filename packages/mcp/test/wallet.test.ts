import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, gageFrom, parseDeployment } from "gage-sdk";
import { ctx, mainnetManifest } from "gage-sdk/testing";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { MAINNET_LIMITS } from "../src/limits.js";
import { ensureKey, init, keyFile, readKey } from "../src/wallet.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const home = () => mkdtempSync(path.join(tmpdir(), "gage-home-"));
const faucet = (results: unknown[]) => ((url: string, request: RequestInit) => {
  expect(url).toBe("https://faucet.test/claim/all");
  expect(request.method).toBe("POST");
  return Promise.resolve(new Response(JSON.stringify({ results })));
}) as unknown as typeof fetch;

describe("Valet's wallet", () => {
  it("is made once, readable by this user only, and never overwritten", () => {
    const file = keyFile(home(), 46630);
    const first = ensureKey(file);
    expect(first.created).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const again = ensureKey(file);
    expect(again).toEqual({ key: first.key, created: false });
    expect(readFileSync(file, "utf8").trim()).toBe(first.key);
  });

  // The audit of 18 October 2026 (L3): a key another user could read, swap or have planted is never used or funded.
  it("refuses a key in GAGE_HOME another user could read, swap or have planted", () => {
    if (process.platform === "win32") return;
    const sync = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
    // A link to a key someone else made.
    const linked = keyFile(home(), 46630), planted = path.join(home(), "planted.key");
    writeFileSync(planted, `0x${"22".repeat(32)}\n`, { mode: 0o600 });
    symlinkSync(planted, linked);
    expect(sync(() => ensureKey(linked))).toBe("KEY_FILE_UNSAFE");
    expect(sync(() => readKey({}, linked))).toBe("KEY_FILE_UNSAFE");
    // A key others can read, and a GAGE_HOME others can write in.
    const open = keyFile(home(), 46630);
    writeFileSync(open, `0x${"33".repeat(32)}\n`);
    chmodSync(open, 0o644);
    expect(sync(() => ensureKey(open))).toBe("KEY_FILE_UNSAFE");
    const shared = home();
    chmodSync(shared, 0o777);
    expect(sync(() => ensureKey(keyFile(shared, 46630)))).toBe("KEY_FILE_UNSAFE");
    // A file its owner names is read as named (a container's secret may be root's, or a link), with a warning when
    // others can read it.
    const warned: string[] = [];
    expect(readKey({ GAGE_PRIVATE_KEY_FILE: open }, keyFile(home(), 46630), (m) => warned.push(m))).toBe(`0x${"33".repeat(32)}`);
    expect(warned).toEqual(["GAGE_PRIVATE_KEY_FILE can be read by other users of this computer: chmod 600 it"]);
  });

  it("init prints the address and the next step, funds it on the testnet, and never prints the key", async () => {
    const dir = home(), lines: string[] = [];
    const done = await init({ gage: gageFrom(ctx()), home: dir, faucetUrl: "https://faucet.test/", out: (l) => lines.push(l),
      fetch: faucet([{ label: "0.02 ETH", hash: "0x1" }, { label: "USDG", hash: "0x2" }, { label: "NVDAx", error: "Request failed", code: "COOLDOWN" }]) });
    const key = readFileSync(keyFile(dir, 46630), "utf8").trim();
    expect(done.address).toBe(privateKeyToAccount(key as `0x${string}`).address);
    expect(lines[0]).toContain(done.address);
    expect(lines.join("\n")).toContain("Funded from gage's testnet faucet: 0.02 ETH, USDG.");
    expect(lines.join("\n")).toContain("NVDAx (COOLDOWN)");
    // The server serves mainnet unless told otherwise (D311), so the testnet's next step names the testnet.
    expect(lines.join("\n")).toContain("Claude Code: `claude mcp add gage -e GAGE_NETWORK=testnet -- npx -y gage-mcp`");
    expect(lines.join("\n")).toContain("Codex: `codex mcp add gage --env GAGE_NETWORK=testnet -- npx -y gage-mcp`");
    expect(lines.join("\n")).not.toContain(key.slice(2));
    // Run again: the same wallet.
    const again: string[] = [];
    expect((await init({ gage: gageFrom(ctx()), home: dir, faucetUrl: null, out: (l) => again.push(l) })).address).toBe(done.address);
    expect(again.join("\n")).toContain("It already existed");
    expect(again.join("\n")).toContain(`Fund it: send USDG (or the lend asset a vault you will use takes), and a little ETH for gas, to ${done.address}.`);
  });

  it("init on mainnet makes the wallet its owner funds, and says its spend limits and how to serve mainnet (D297)", async () => {
    const dir = home(), lines: string[] = [];
    const made = await init({ gage: gageFrom(ctx({ d: parseDeployment(mainnetManifest()) })), home: dir, faucetUrl: null, limits: MAINNET_LIMITS, out: (l) => lines.push(l) });
    const key = readFileSync(keyFile(dir, 4663), "utf8").trim();
    expect(made.address).toBe(privateKeyToAccount(key as `0x${string}`).address);
    expect(existsSync(keyFile(dir, 46630))).toBe(false);
    const text = lines.join("\n");
    expect(lines[0]).toBe(`Your gage wallet on Robinhood Chain (4663): ${made.address}`);
    expect(text).toContain(`Fund it with only what the agent may use: send USDG (or the lend asset a vault you will use takes), the tokens it may pledge, and a little ETH for gas, to ${made.address}.`);
    expect(text).toContain("Spend limits: it borrows at most 100 USDG a loan or loop and 250 USDG in any 24 hours, and deposits at most 100 USDG at a time and 250 USDG in any 24 hours.");
    expect(text).toContain("GAGE_MAX_BORROW_USDG, GAGE_MAX_BORROW_DAY_USDG, GAGE_MAX_DEPOSIT_USDG, GAGE_MAX_DEPOSIT_DAY_USDG");
    expect(text).toContain("Claude Code: `claude mcp add gage -e GAGE_NETWORK=mainnet -- npx -y gage-mcp`");
    expect(text).toContain("Codex: `codex mcp add gage --env GAGE_NETWORK=mainnet -- npx -y gage-mcp`");
    expect(text).not.toContain("faucet");
    expect(text).not.toContain(key.slice(2));
  });

  it("init still stands, and says how to fund the wallet, when the faucet does not answer", async () => {
    const lines: string[] = [];
    const down = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
    const done = await init({ gage: gageFrom(ctx()), home: home(), faucetUrl: "https://faucet.test/", out: (l) => lines.push(l), fetch: down });
    expect(lines.join("\n")).toContain(`did not fund it now. Run init again later, or send test USDG and a little ETH for gas to ${done.address}.`);
    expect(lines.join("\n")).not.toContain("ECONNREFUSED");
  });
});

describe("gage-mcp init, then gage-mcp", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  it("makes the wallet with the faucet's help, and the server then signs with it", async () => {
    const asked: string[] = [];
    const stub = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        asked.push(`${req.method} ${req.url} ${body}`);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ results: [{ label: "0.02 ETH", hash: "0xab" }] }));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => stub.close(() => resolve())));
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const dir = home();
    const env = { ...getDefaultEnvironment(), GAGE_HOME: dir, GAGE_NETWORK: "testnet", GAGE_FAUCET_URL: `http://127.0.0.1:${address.port}` };

    // Asynchronously: the stub faucet answers from this process, which a synchronous spawn would block.
    const made = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "init"], { cwd, env, encoding: "utf8", timeout: 30_000 });
    const wallet = privateKeyToAccount(readFileSync(keyFile(dir, 46630), "utf8").trim() as `0x${string}`).address;
    expect(made.stdout).toContain(`Your gage wallet on Robinhood Chain testnet (46630): ${wallet}`);
    expect(made.stdout).toContain("Funded from gage's testnet faucet: 0.02 ETH.");
    expect(asked).toEqual([`POST /claim/all {"to":"${wallet}"}`]);

    const client = new Client({ name: "gage-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", cli], cwd, env, stderr: "pipe" }));
    cleanups.push(() => client.close());
    // The testnet's own release names no rollover router: no roll tools there.
    expect((await client.listTools()).tools).toHaveLength(24);
    expect(client.getInstructions()).toContain(wallet);
  }, 60_000);

  it("serves mainnet unless told otherwise (D311): without a key; init makes Valet's wallet, and the server signs with it under spend limits (D297) its owner may lift", async () => {
    const run = promisify(execFile);
    // No GAGE_NETWORK: mainnet is the default.
    const env = { ...getDefaultEnvironment(), GAGE_HOME: home() };
    const refused = async (args: string[], extra: Record<string, string> = {}) => {
      try { await run(process.execPath, ["--import", "tsx", cli, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 }); return "ran"; }
      catch (e) { return String((e as { stderr?: string }).stderr); }
    };
    const serve = async (extra: Record<string, string> = {}) => {
      const client = new Client({ name: "gage-test", version: "1.0.0" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", cli], cwd, env: { ...env, ...extra }, stderr: "pipe" }));
      cleanups.push(() => client.close());
      return client;
    };
    // A limit that is not an amount refuses to start, before any wallet is made.
    expect(await refused(["init"], { GAGE_MAX_BORROW_USDG: "lots" })).toContain('"code":"INVALID_LIMIT"');
    expect(existsSync(keyFile(env.GAGE_HOME, 4663))).toBe(false);

    const keyless = await serve();
    expect((await keyless.listTools()).tools).toHaveLength(19);
    expect(keyless.getInstructions()).toContain("Robinhood Chain (4663)");

    const made = await run(process.execPath, ["--import", "tsx", cli, "init"], { cwd, env, encoding: "utf8", timeout: 30_000 });
    const wallet = privateKeyToAccount(readFileSync(keyFile(env.GAGE_HOME, 4663), "utf8").trim() as `0x${string}`).address;
    expect(made.stdout).toContain(`Your gage wallet on Robinhood Chain (4663): ${wallet}`);
    expect(made.stdout).toContain("Spend limits: it borrows at most 100 USDG a loan or loop");

    const valet = await serve();
    expect((await valet.listTools()).tools).toHaveLength(33);
    expect(valet.getInstructions()).toContain(wallet);
    expect(valet.getInstructions()).toContain("it borrows at most 100 USDG a loan or loop and 250 USDG in any 24 hours");
    const owners = await serve({ GAGE_MAX_BORROW_USDG: "20", GAGE_MAX_DEPOSIT_DAY_USDG: "1000.5" });
    expect(owners.getInstructions()).toContain("it borrows at most 20 USDG a loan or loop and 250 USDG in any 24 hours, and deposits at most 100 USDG at a time and 1000.5 USDG in any 24 hours");
    const lifted = await serve({ GAGE_MAX_BORROW_USDG: "off", GAGE_MAX_BORROW_DAY_USDG: "off", GAGE_MAX_DEPOSIT_USDG: "off", GAGE_MAX_DEPOSIT_DAY_USDG: "off" });
    expect((await lifted.listTools()).tools).toHaveLength(33);
    expect(lifted.getInstructions()).toContain("it borrows without a limit, and deposits without a limit");
  }, 90_000);

  it("refuses a network it does not know", async () => {
    const env = { ...getDefaultEnvironment(), GAGE_HOME: home(), GAGE_NETWORK: "base" };
    const out: { stderr?: string } = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "init"], { cwd, env, encoding: "utf8", timeout: 30_000 })
      .catch((e: { stderr?: string }) => e);
    expect(String(out.stderr)).toContain('"code":"UNKNOWN_NETWORK"');
  }, 60_000);
});
