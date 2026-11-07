/**
 * A command gage prints for gage-mcp runs the code that holds an agent's key, so each names the release it was written for,
 * and moves with each release: one left behind fails here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/server.js";
import { NEXT, NEXT_MAINNET } from "../src/wallet.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const { version, description } = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string; description: string };

/** Every release a text names for gage-mcp, and each way it runs the package with none. */
const pins = (text: string) => [...text.matchAll(/gage-mcp@(\d[^\s`"']*)/g)].map((m) => m[1]);
const unpinned = (text: string) => [...text.matchAll(/npx(?: -y)? gage-mcp(?!@)|"-y", "gage-mcp"(?!@)/g)].map((m) => m[0]);

describe("gage-mcp's pins", () => {
  // The mirror's landing README is its root's there, and this repository's copy only here.
  const files = ["README.md", "examples/stdio-client.ts", "../sdk/docs/agents.md", "../../open-source/gage-sdk/README.md"]
    .map((file) => path.join(packageRoot, file)).filter((file) => existsSync(file));

  it("name this release, the server's own version with them", () => {
    expect(VERSION).toBe(version);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(unpinned(text), file).toEqual([]);
      expect(pins(text).length, file).toBeGreaterThan(0);
      expect(new Set(pins(text)), file).toEqual(new Set([version]));
    }
    expect(unpinned(description)).toEqual([]);
    expect(pins(description)).toEqual([version]);
  });

  it("are what init tells an agent to add, on each network: the server it adds is the one that signs", () => {
    for (const lines of [NEXT, NEXT_MAINNET]) {
      const text = lines.join("\n");
      expect(unpinned(text)).toEqual([]);
      // The first line, and Claude Code's, Codex's, Hermes's and any other agent's.
      expect(pins(text)).toEqual(Array.from({ length: 5 }, () => version));
    }
  });
});
