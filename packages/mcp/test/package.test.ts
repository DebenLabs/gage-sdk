import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// gage-mcp signs with the actions gage-sdk defines and counts them against the spend limits by name (`counted`, which
// knows every action of the SDK it is built with). Published against a range, an installed gage-mcp would take a later
// gage-sdk whose new action it has never classified, and sign it uncounted (the audit of 18 October 2026).
describe("gage-mcp's package", () => {
  it("takes exactly the gage-sdk of its own release", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["gage-sdk"]).toBe("workspace:*");
  });
});
