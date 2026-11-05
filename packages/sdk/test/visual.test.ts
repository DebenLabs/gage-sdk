/**
 * gage-sdk/visual: a plan's preview drawn as gage's card, one self-contained SVG a partner or an agent shows as it is.
 */
import { describe, expect, it } from "vitest";
import type { ExitPreview } from "../src/preview.js";
import { renderPreview } from "../src/visual.js";

const preview: ExitPreview = {
  kind: "exit_now", asset: { token: "0x0000000000000000000000000000000000000010", symbol: "USDG", decimals: 6, stable: true },
  receive: "3000000000", now: "1000000000", giveUp: "7008035",
  steps: [
    { at: 0, when: "now", what: "You ask" },
    { at: 600, when: "~10 min", what: "Loan sold" },
    { at: 3600, when: "before 1 h", what: "You remove" },
    { at: 3600, when: "1 h", what: "Exit ends" },
  ],
};

describe("gage's card for a plan's preview", () => {
  it("draws the headline, the steps in time and what is given up, as one SVG that fetches and runs nothing", () => {
    const svg = renderPreview(preview);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="360" height="\d+" viewBox="0 0 360 \d+">/);
    expect(svg).toContain(">3,000.00 USDG<");
    for (const text of ["EXIT NOW · USDG", "You receive", "NOW", "~10 MIN", "BEFORE 1 H", "You ask", "Loan sold", "You remove", "Exit ends", "You give up", "about 7.00 USDG"]) {
      expect(svg).toContain(text);
    }
    expect(svg).not.toMatch(/<script|href=|url\(|<image|<foreignObject/i);
  });

  it("follows the host's theme", () => {
    expect(renderPreview(preview)).toContain('fill="#fcfaf4"');
    const dark = renderPreview(preview, { theme: "dark" });
    expect(dark).toContain('fill="#1d1a15"');
    expect(dark).not.toContain('fill="#fcfaf4"');
  });

  it("moves a step's words aside where they would run into the next, and leaves room-enough steps under their dots", () => {
    const at = (svg: string, words: string) => Number(new RegExp(`<text x="([0-9.]+)"[^>]*>${words}</text>`).exec(svg)?.[1]);
    // A partner vault's exit: "You collect" would touch "Request ends", which keeps to the card's edge.
    const vault = renderPreview({ ...preview, steps: [
      { at: 0, when: "now", what: "You ask" }, { at: 600, when: "~10 min", what: "Loan sold" },
      { at: 600, when: "any time", what: "You collect" }, { at: 86_400, when: "24 h", what: "Request ends" },
    ] });
    expect(at(vault, "You collect")).toBeLessThan(232);
    expect(at(vault, "Request ends")).toBe(336);
    // A rehypo pool's: every step has room, so each stays under its dot.
    const rehypo = renderPreview(preview);
    expect([at(rehypo, "You ask"), at(rehypo, "Loan sold"), at(rehypo, "You remove"), at(rehypo, "Exit ends")]).toEqual([24, 128, 232, 336]);
  });

  it("says a dash, never a guess, when what is given up is unknown, and escapes every text it draws", () => {
    const svg = renderPreview({ ...preview, giveUp: null, asset: { ...preview.asset, symbol: "<b>&\"" }, steps: [{ at: 0, when: "<now>", what: "A & B" }] });
    expect(svg).toMatch(/You give up<\/text><text[^>]*>—<\/text>/);
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;&amp;&quot;");
    expect(svg).toContain("A &amp; B");
  });
});
