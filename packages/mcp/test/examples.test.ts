/** The example (packages/mcp/examples) runs as written against this package's own CLI over stdio, with no network. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { gageOverStdio, type ServerCommand } from "../examples/stdio-client.js";

const local: ServerCommand = {
  command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url))], cwd: fileURLToPath(new URL("..", import.meta.url)),
};
const home = () => mkdtempSync(path.join(tmpdir(), "gage-home-"));

describe("the example", () => {
  it("stdio-client: without a key, mainnet's reads and prepares and nothing that signs", async () => {
    const served = await gageOverStdio({ GAGE_HOME: home() }, local);
    expect(served.instructions).toContain("Robinhood Chain (4663)");
    expect(served.reads).toContain("gage_capabilities");
    expect(served.prepares).toContain("gage_prepare_borrow");
    expect(served.signing).toEqual([]);
    expect(served.limits).toBeNull();
  }, 60_000);

  it("stdio-client: with a wallet, its signing tools and what is left of the owner's limits", async () => {
    // A key made for this test alone, never funded: listing tools and reading the limits sends nothing.
    const served = await gageOverStdio({ GAGE_HOME: home(), GAGE_PRIVATE_KEY: generatePrivateKey(), GAGE_MAX_BORROW_USDG: "20", GAGE_MAX_DEPOSIT_DAY_USDG: "off" }, local);
    expect(served.signing).toContain("gage_borrow");
    expect(served.signing).toContain("gage_earn_deposit");
    expect(served.reads).toContain("gage_limits");
    expect(served.limits).toMatchObject({
      borrow: { perAction: "20000000", per24Hours: "250000000", used: "0", left: "250000000" },
      deposit: { perAction: "100000000", per24Hours: null, left: null },
    });
  }, 60_000);
});
