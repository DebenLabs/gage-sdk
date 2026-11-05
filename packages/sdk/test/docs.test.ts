/**
 * The guides (docs/) show only code that runs: every TypeScript block is a slice of a tested example (examples/, and
 * gage-mcp's), line for line, so a guide cannot drift from the API the examples are tested against. Their links lead
 * somewhere, and, as the README, they cite no internal decision numbers. In gage's main repository the public pages that
 * mirror them (gitbook/developers/sdk*.md) are held to the same examples; the public mirror has no gitbook/.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const docs = new URL("../docs/", import.meta.url);
const guides = readdirSync(docs).filter((f) => f.endsWith(".md") && f !== "reference.md");
const exampleDirs = [new URL("../examples/", import.meta.url), new URL("../../mcp/examples/", import.meta.url)];
/** Each example's lines, trimmed, blank ones left out. */
const examples = exampleDirs.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => ({
  file: f, lines: readFileSync(new URL(f, d), "utf8").split("\n").map((l) => l.trim()).filter(Boolean),
})));
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
/** Whether `want` appears as consecutive lines of `have`. */
const within = (want: string[], have: string[]) => have.some((_, i) => want.every((line, j) => have[i + j] === line));

/** The TypeScript blocks of `text` no example holds, each as its lines. */
const strays = (text: string) => [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!)
  .flatMap((block) => block.split(/^\s*\/\/ …\s*$/m).map(lines).filter((slice) => slice.length > 0))
  .filter((slice) => !examples.some((e) => within(slice, e.lines)))
  .map((slice) => slice.join("\n"));

const gitbook = new URL("../../../gitbook/developers/", import.meta.url);
const publicPages = existsSync(gitbook) ? readdirSync(gitbook).filter((f) => /^sdk.*\.md$/.test(f)) : [];

describe.runIf(publicPages.length > 0)("the public SDK pages", () => {
  it.each(publicPages)("%s: every TypeScript block is a slice of a tested example", (page) => {
    expect(strays(readFileSync(new URL(page, gitbook), "utf8"))).toEqual([]);
  });
});

describe("the guides", () => {
  it("are there", () => {
    expect(guides.length).toBeGreaterThan(8);
  });

  it.each(guides)("%s: every TypeScript block is a slice of a tested example (`// …` joins slices)", (guide) => {
    expect(strays(readFileSync(new URL(guide, docs), "utf8"))).toEqual([]);
  });

  it.each(guides)("%s: every relative link leads to a file", (guide) => {
    const text = readFileSync(new URL(guide, docs), "utf8");
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((t) => !/^[a-z]+:/i.test(t) && !t.startsWith("#"));
    expect(targets.filter((t) => !existsSync(new URL(t.split("#")[0]!, docs)))).toEqual([]);
  });

  it.each(guides)("%s: cites no internal decision numbers", (guide) => {
    expect(readFileSync(new URL(guide, docs), "utf8").match(/\bD\d{2,3}\b/g)).toBeNull();
  });
});
