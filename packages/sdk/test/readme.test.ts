/** The README's error table names every refusal the SDK can give, so an integrator can handle each one. */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = new URL("../src/", import.meta.url);
const code = readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "testing.ts").map((f) => readFileSync(new URL(f, src), "utf8")).join("\n");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** Every code the SDK refuses with: thrown, asserted, answered by run(), or named in a table of refusals. */
function codes(): string[] {
  const found = new Set<string>();
  const add = (re: RegExp) => { for (const m of code.matchAll(re)) found.add(m[1]!); };
  add(/new ApiError\("([A-Z][A-Z0-9_]+)"/g);
  add(/requireThat\((?:[^;"]|"[^"]*")*?, "([A-Z][A-Z0-9_]+)"/g);
  add(/code: "([A-Z][A-Z0-9_]+)"/g);
  add(/: \["([A-Z][A-Z0-9_]+)", "/g);
  for (const table of code.matchAll(/const REFUSALS: Record<string, string> = \{([\s\S]*?)\};/g)) for (const m of table[1]!.matchAll(/([A-Z][A-Z0-9_]+): "/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("the README", () => {
  it("names every refusal the SDK can give", () => {
    const all = codes();
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((c) => !readme.includes(`\`${c}\``))).toEqual([]);
  });

  it("cites no internal decision numbers", () => {
    expect(readme.match(/\bD\d{2,3}\b/g)).toBeNull();
  });
});
