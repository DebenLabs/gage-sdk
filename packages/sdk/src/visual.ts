/**
 * gage-sdk/visual: a plan's preview drawn as gage's card, one self-contained SVG with nothing to fetch and nothing to
 * run. A partner shows it as it is (inline, or as an image), an agent's host draws it beside its words, and gage's own
 * pages use the same card. It names gage's fonts (Space Mono for figures, Libre Franklin for words) and falls back to
 * the system's where the host does not load them. Pure: no DOM, no dependency.
 */
import * as f from "./format.js";
import type { Preview } from "./preview.js";

/** How the card sits on its host: gage's light paper, or its dark theme (D138). */
export interface PreviewStyle { theme?: "light" | "dark" }

/** gage's tokens (web/src/app/globals.css), light and dark. */
const THEMES = {
  light: { panel: "#fcfaf4", rule: "#ded9cc", ink: "#1c1a15", mute: "#9a927e", mute2: "#6f6858", amber: "#e89a1f" },
  dark: { panel: "#1d1a15", rule: "#332e25", ink: "#ebe5d6", mute: "#7d7563", mute2: "#a69d89", amber: "#e89a1f" },
} as const;
type Theme = (typeof THEMES)[keyof typeof THEMES];

const MONO = "'Space Mono', ui-monospace, Menlo, monospace";
const SANS = "'Libre Franklin', Helvetica, Arial, sans-serif";
const W = 360, PAD = 24, RIGHT = W - PAD, H = 236;
/** About how wide a character of a step's words is, on the wide side: Libre Franklin at 11.5px, and Space Mono at 9.5px
 * with its spacing; and the least room between two steps' words. */
const LABEL_EM = 6.2, WHEN_EM = 6.5, LABEL_GAP = 10;
/** What each kind of preview is called in the card's corner. */
const TITLES: Record<Preview["kind"], string> = { exit_now: "EXIT NOW" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface TextStyle { mono?: boolean; size?: number; fill: string; anchor?: "start" | "middle" | "end"; spacing?: number }
function text(x: number, y: number, s: string, o: TextStyle): string {
  return `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : SANS}" font-size="${o.size ?? 12}" fill="${o.fill}"`
    + `${o.anchor && o.anchor !== "start" ? ` text-anchor="${o.anchor}"` : ""}${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(s)}</text>`;
}

/** gage's wordmark (site/brand/logo.svg), its letters in the theme's ink, `h` high with its top left at (x, y). */
function wordmark(ink: string, x: number, y: number, h: number): string {
  return `<g transform="translate(${x} ${y}) scale(${h / 252})"><g transform="translate(24 187.2)"><path fill="#e89a1f" transform="translate(0.00 0.00) scale(0.240000 -0.240000)" d="M341 -156Q307 -156 285.5 -134.0Q264 -112 264 -78V778Q264 812 285.5 834.0Q307 856 341 856H438V784H369Q342 784 342 754V-54Q342 -84 369 -84H438V-156Z"/><path fill="${ink}" transform="translate(137.28 0.00) scale(0.240000 -0.240000)" d="M142 -200V-128H437Q464 -128 464 -98V76H452Q428 31 386.5 8.5Q345 -14 296 -14Q230 -14 174.5 15.5Q119 45 85.5 102.0Q52 159 52 240V256Q52 337 86.0 393.5Q120 450 175.0 480.0Q230 510 294 510Q348 510 389.0 486.5Q430 463 452 418H464V496H542V-122Q542 -156 520.5 -178.0Q499 -200 465 -200ZM298 60Q345 60 382.5 82.5Q420 105 442.0 146.0Q464 187 464 242V254Q464 307 441.5 348.0Q419 389 381.5 412.5Q344 436 298 436Q251 436 213.5 413.5Q176 391 154.0 350.5Q132 310 132 256V240Q132 185 153.5 144.5Q175 104 212.5 82.0Q250 60 298 60Z"/><path fill="${ink}" transform="translate(274.56 0.00) scale(0.240000 -0.240000)" d="M279 -14Q214 -14 161.5 15.5Q109 45 78.0 101.5Q47 158 47 240V256Q47 337 78.0 394.0Q109 451 161.5 480.5Q214 510 277 510Q328 510 369.5 487.5Q411 465 435 418H447V496H525V102Q525 72 552 72H577V0H524Q493 0 470.0 20.0Q447 40 447 84H435Q411 35 368.5 10.5Q326 -14 279 -14ZM287 60Q357 60 402.0 110.0Q447 160 447 242V254Q447 307 426.0 348.0Q405 389 369.0 412.5Q333 436 287 436Q241 436 205.0 413.5Q169 391 148.0 350.5Q127 310 127 256V240Q127 156 172.0 108.0Q217 60 287 60Z"/><path fill="${ink}" transform="translate(411.84 0.00) scale(0.240000 -0.240000)" d="M142 -200V-128H437Q464 -128 464 -98V76H452Q428 31 386.5 8.5Q345 -14 296 -14Q230 -14 174.5 15.5Q119 45 85.5 102.0Q52 159 52 240V256Q52 337 86.0 393.5Q120 450 175.0 480.0Q230 510 294 510Q348 510 389.0 486.5Q430 463 452 418H464V496H542V-122Q542 -156 520.5 -178.0Q499 -200 465 -200ZM298 60Q345 60 382.5 82.5Q420 105 442.0 146.0Q464 187 464 242V254Q464 307 441.5 348.0Q419 389 381.5 412.5Q344 436 298 436Q251 436 213.5 413.5Q176 391 154.0 350.5Q132 310 132 256V240Q132 185 153.5 144.5Q175 104 212.5 82.0Q250 60 298 60Z"/><path fill="${ink}" transform="translate(549.12 0.00) scale(0.240000 -0.240000)" d="M308 -14Q237 -14 182.5 18.5Q128 51 97.0 108.5Q66 166 66 242V266Q66 336 98.0 391.0Q130 446 185.5 478.0Q241 510 310 510Q371 510 415.5 488.0Q460 466 488.5 432.0Q517 398 530.5 359.5Q544 321 544 288V224H144Q147 151 190.5 105.5Q234 60 310 60Q381 60 416.0 90.0Q451 120 464 162L538 142Q517 73 460.5 29.5Q404 -14 308 -14ZM146 296H466Q464 339 441.5 370.5Q419 402 384.0 419.0Q349 436 310 436Q244 436 199.0 396.0Q154 356 146 296Z"/><path fill="#e89a1f" transform="translate(686.40 0.00) scale(0.240000 -0.240000)" d="M174 -156V-84H243Q270 -84 270 -54V754Q270 784 243 784H174V856H271Q305 856 326.5 834.0Q348 812 348 778V-78Q348 -112 326.5 -134.0Q305 -156 271 -156Z"/></g></g>`;
}

/** The steps along one line, in amber up to the last but one; the way to the last, where the action ends, dashed. */
function track(t: Theme, steps: Preview["steps"], y: number): string {
  const n = steps.length;
  if (n === 0) return "";
  const x = (i: number) => (n === 1 ? PAD : PAD + (i * (RIGHT - PAD)) / (n - 1));
  const anchor = (i: number) => (i === 0 ? "start" : i === n - 1 ? "end" : "middle");
  // Where each step's words sit: under its dot, unless they would run into the next step's, whose own place holds; the
  // last keeps to the card's edge. Widths are estimated on the wide side, so the system's fonts fit too.
  const wide = (i: number) => Math.max(steps[i]!.what.length * LABEL_EM, steps[i]!.when.length * WHEN_EM);
  const from = (i: number, at: number) => (anchor(i) === "start" ? at : anchor(i) === "end" ? at - wide(i) : at - wide(i) / 2);
  const place = steps.map((_, i) => x(i));
  for (let i = n - 2; i >= 0; i--) {
    const over = from(i, place[i]!) + wide(i) + LABEL_GAP - from(i + 1, place[i + 1]!);
    if (over > 0) place[i] = place[i]! - over;
  }
  let out = "";
  if (n > 2) out += `<rect x="${PAD}" y="${y - 1}" width="${x(n - 2) - PAD}" height="2" fill="${t.amber}"/>`;
  if (n > 1) out += `<line x1="${x(n - 2)}" y1="${y}" x2="${x(n - 1)}" y2="${y}" stroke="${t.mute}" stroke-width="1" stroke-dasharray="3 3"/>`;
  steps.forEach((s, i) => {
    out += i < n - 1 || n === 1 ? `<circle cx="${x(i)}" cy="${y}" r="4" fill="${t.amber}"/>` : `<circle cx="${x(i)}" cy="${y}" r="3.5" fill="${t.panel}" stroke="${t.mute}"/>`;
    out += text(place[i]!, y + 22, s.when.toUpperCase(), { mono: true, size: 9.5, fill: t.mute, anchor: anchor(i), spacing: 0.8 });
    out += text(place[i]!, y + 38, s.what, { size: 11.5, fill: t.ink, anchor: anchor(i) });
  });
  return out;
}

/**
 * The card for `p`: what the wallet receives as its one headline, the action's steps in time, and about what it gives
 * up (a dash while that is unknown). Every text it draws is escaped.
 */
export function renderPreview(p: Preview, style: PreviewStyle = {}): string {
  const t = THEMES[style.theme ?? "light"];
  const giveUp = p.giveUp === null ? "—" : p.giveUp === "0" ? "Nothing" : `about ${f.money(BigInt(p.giveUp), p.asset)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="${t.panel}" stroke="${t.rule}"/>`
    + text(PAD, 34, `${TITLES[p.kind]} · ${p.asset.symbol}`, { mono: true, size: 10, fill: t.mute, spacing: 1.2 })
    + wordmark(t.ink, RIGHT - 48, 22, 14)
    + text(PAD, 70, "You receive", { fill: t.mute2 })
    + text(PAD, 104, f.money(BigInt(p.receive), p.asset), { mono: true, size: 28, fill: t.ink })
    + track(t, p.steps, 136)
    + `<rect x="${PAD}" y="198" width="${W - 2 * PAD}" height="1" fill="${t.rule}"/>`
    + text(PAD, 222, "You give up", { fill: t.mute2 })
    + text(RIGHT, 222, giveUp, { mono: true, fill: t.ink, anchor: "end" })
    + "</svg>";
}
