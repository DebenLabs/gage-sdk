/**
 * docs/reference.md is generated from the SDK itself: every method's input, every action's input and description, and
 * every tool's name, title, hints and input, from the very schemas and catalogue the SDK serves. It fails until a changed
 * schema or tool is written back: `pnpm --filter gage-sdk test -u` regenerates it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Gage } from "../src/client.js";
import { createPoolVaultsInput, poolVaultsInput } from "../src/pools.js";
import {
  ACTIONS, actionShapes, borrowQuoteInput, leverageQuoteInput, loanInput, lpQuoteInput, parkPositionsInput, putQuoteInput, vaultInput, walletInput,
} from "../src/schemas.js";
import { gageTools, poolVaultTools, type GageTool } from "../src/tools.js";
import { WALLET } from "../src/testing.js";

/** Words for the few fields whose schema carries none, by name. */
const FALLBACK: Record<string, string> = {
  wallet: "The wallet: in a quote, the one that will act (optional); in an action, the one that signs, which `run` sets to the signer's",
  token: "A token's address, as `assets()` lists it",
  vault: "A partner vault, as `earnVaults()` lists it",
  loanId: "The loan's id, a decimal string",
  curator: "Only this curator's vaults",
};

interface Property { type?: string; pattern?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; description?: string; items?: Schema; anyOf?: Property[] }
interface Schema extends Property { properties?: Record<string, Property>; required?: string[] }

/** A field's type in a few words. */
function typeOf(p: Property): string {
  if (p.anyOf) return p.anyOf.map(typeOf).join(" or ");
  // A bound past what a number holds exactly is no bound a caller meets.
  const hi = p.maximum !== undefined && p.maximum < Number.MAX_SAFE_INTEGER ? p.maximum : undefined;
  const range = (lo?: number) => (p.exclusiveMinimum === 0 && hi === undefined ? ", positive" : lo === undefined && hi === undefined ? "" : ` ${lo ?? "…"} to ${hi ?? "…"}`);
  if (p.type === "string") {
    if (p.pattern === "^0x[0-9a-fA-F]{40}$") return "address";
    if (p.pattern?.startsWith("^[1-9]")) return "raw amount";
    if (p.pattern?.startsWith("^\\d{1,78}")) return "id (decimal string)";
    if (p.pattern?.includes("{64}")) return "address or v4 pool id";
    return `string${p.maxLength === undefined ? "" : ` (at most ${p.maxLength})`}`;
  }
  if (p.type === "integer") return `integer${range(p.minimum)}`;
  if (p.type === "number") return `number${range(p.minimum)}`;
  if (p.type === "array") return `list${p.maxItems === undefined ? "" : ` of at most ${p.maxItems}`}`;
  if (p.type === "object") return "object";
  return p.type ?? "any";
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A schema's fields as a table, nested objects in a list flattened as `field[].name`. */
function fields(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: "input" }) as Schema;
  const rows: string[] = [];
  const walk = (s: Schema, prefix: string) => {
    for (const [name, p] of Object.entries(s.properties ?? {})) {
      const required = (s.required ?? []).includes(name) ? "yes" : "no";
      rows.push(`| \`${prefix}${name}\` | ${typeOf(p)} | ${required} | ${cell(p.description ?? FALLBACK[name] ?? "")} |`);
      if (p.type === "array" && p.items?.properties) walk(p.items, `${prefix}${name}[].`);
    }
  };
  walk(json, "");
  return rows.length ? ["| Field | Type | Required | Meaning |", "|---|---|---|---|", ...rows].join("\n") : "No input.";
}

/** The SDK method behind each read tool. */
const METHOD: Record<string, string> = {
  gage_capabilities: "capabilities()", gage_assets: "assets()", gage_borrow_quote: "borrowQuote(input)", gage_leverage_quote: "leverageQuote(input)",
  gage_loan: "loan(input)", gage_portfolio: "portfolio(wallet)", gage_earn_vaults: "earnVaults()", gage_vault_free_cash: "vaultFreeCash(input)",
  gage_put_quote: "putQuote(input)", gage_lp_positions: "lpPositions(wallet)", gage_lp_quote: "lpQuote(input)", gage_lp_loans: "lpLoans(wallet)",
  gage_lp_vaults: "lpVaults()", gage_park_positions: "parkPositions(wallet, also)", gage_wallet: "balances(signer.address)",
  gage_pool_vaults: "poolVaults(input)", gage_create_pool_vaults: "createPoolVaults(input)",
};

/** The methods that take an input, with its schema. */
const METHODS: [string, string, z.ZodType][] = [
  ["borrowQuote(input)", "`maxCollateral` for the largest loan the vaults fund, or `collateral` and `principal` (with `costBps` for a cost of your own) for one exact loan", borrowQuoteInput],
  ["leverageQuote(input)", "a loop's amounts and cost", leverageQuoteInput],
  ["putQuote(input)", "a put's pledge, loan and cost, where a lend asset offers puts", putQuoteInput],
  ["loan(input)", "one loan", loanInput],
  ["waitForFill(input, options?)", "waits for a listing to be funded; `options`: `timeoutSeconds` (300), `pollSeconds` (10)", loanInput],
  ["vaultFreeCash(input)", "one partner vault's free cash", vaultInput],
  ["portfolio(wallet), balances(wallet), lpPositions(wallet), lpLoans(wallet)", "a wallet's loans and holdings, its balances, its LP positions, its LP loans", walletInput],
  ["parkPositions(wallet, also?)", "a wallet's out-of-range positions in the pools park serves", parkPositionsInput],
  ["lpQuote(input)", "a quote against one LP position", lpQuoteInput],
  ["poolVaults(input?)", "the pools among the partner vaults", poolVaultsInput],
  ["createPoolVaults(input)", "the calls that create a pool's vaults, from its curator", createPoolVaultsInput],
];

/** A catalogue that serves every action, for its words: `gageTools` reads only `actions` and whether a lane is public. */
const everything = { actions: ACTIONS, deployment: { lpLane: {} } } as unknown as Gage;
const signer = { address: WALLET, sendTransaction: () => Promise.reject(new Error("never sent")) };

function render(): string {
  const tools = gageTools(everything, { signer });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const suffix = / Signs and sends every step from .*$/;
  const kind = (t: GageTool) => (t.annotations.destructiveHint ? "signs" : t.annotations.readOnlyHint ? "reads" : "prepares");
  const reads = [...tools.filter((t) => t.annotations.readOnlyHint), ...poolVaultTools(everything)];
  const out = [
    "# gage-sdk reference",
    "",
    "Generated from the SDK's own schemas and tool catalogue by `test/reference.test.ts`, which fails until a change is written",
    "back (`pnpm --filter gage-sdk test -u`). Amounts are raw integers as decimal strings, times Unix seconds, terms seconds.",
    "Answers are described in the [README](../README.md#reads), and every refusal code in its [Errors](../README.md#errors).",
    "Which actions a network serves: `gage.actions` and `capabilities().actions`.",
    "",
    "## Methods",
    "",
    "`createGage(options?)` takes `network` (`\"mainnet\"`, the default, or `\"testnet\"`), `manifest`, `rpcUrl`, `indexerUrl`,",
    "`ratesUrl`, `valuationUrl` (`null` leaves leverage to the deployment's pools), `apiKey`, `fetch`, `now`, `actions` (serve",
    "fewer) and `parkPools`. `capabilities()`, `assets()`, `earnVaults()`, `lpVaults()` and `refreshGenerations()` take no",
    "input. `prepare(input)` and `run(input, signer, options?)` take an action below (`run` without `wallet`);",
    "`parkCalls(input)` and `unparkCalls(input)` take `park`'s and `unpark`'s input without `action`.",
    "",
  ];
  for (const [method, what, schema] of METHODS) out.push(`### \`${method}\``, "", `${what[0]!.toUpperCase()}${what.slice(1)}.`, "", fields(schema), "");
  out.push("## Actions", "", "Each action is prepared with `prepare({ action, wallet, … })` and carried out with `run({ action, … }, signer)`. Its tools",
    "are `gage_prepare_<action>` and, for a signer, `gage_<action>`.", "");
  for (const action of ACTIONS) {
    const sign = byName.get(`gage_${action}`)!;
    out.push(`### \`${action}\`: ${sign.title}`, "", sign.description.replace(suffix, ""), "", fields(actionShapes[action]), "");
  }
  out.push("## Read tools", "", "The reads of `gageTools(gage)`, each answering as its method does, and the pool vault tools of `poolVaultTools(gage)`,",
    "which sign nothing. `gage_put_quote` comes where puts open, the `gage_lp_` reads where the LP lane is public,",
    "`gage_park_positions` where park is served, and `gage_wallet` with a signer.", "");
  for (const t of reads) {
    const method = METHOD[t.name];
    if (!method) throw new Error(`No method named for ${t.name}`);
    out.push(`### \`${t.name}\`: ${t.title}`, "", `\`gage.${method}\`, ${kind(t)}. ${t.description}`, "", fields(t.inputSchema), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

describe("docs/reference.md", () => {
  it("is the SDK's own schemas and catalogue, written out", async () => {
    await expect(render()).toMatchFileSnapshot("../docs/reference.md");
  });

  it("names every action and every tool", () => {
    const text = render();
    for (const action of ACTIONS) expect(text).toContain(`### \`${action}\``);
    for (const t of gageTools(everything, { signer })) if (t.annotations.readOnlyHint) expect(text).toContain(`### \`${t.name}\``);
  });
});
