/**
 * The in-chat card (MCP Apps, `ui://`, 2026-01-26): a host that draws apps shows a plan's preview as gage's card beside
 * the words, and a host that does not keeps the text. The card is drawn here with gage-sdk/visual and travels in the
 * result's `_meta`, which the host hands to the view and the model does not need. The view is a page of a few lines: it
 * greets its host (`ui/initialize`), takes its light or dark theme, and shows the card. It fetches and loads nothing.
 */
import type { Preview } from "gage-sdk";
import { renderPreview } from "gage-sdk/visual";

export const CARD_URI = "ui://gage/preview";
export const CARD_MIME = "text/html;profile=mcp-app";
/** Where a result carries its card: gage's reverse-DNS key, as the MCP Registry names gage (`cash.gage/gage`). */
export const CARD_META = "cash.gage/card";
/** The tools whose answers may carry a preview: preparing an action that pays out over time, an exit now. */
export const CARDED: ReadonlySet<string> = new Set(["gage_prepare_rehypo_exit_now", "gage_prepare_earn_exit_now"]);

/** gage's card on its light and dark grounds. */
export interface Card { light: string; dark: string }

/** The card for a tool's answer, or null for an answer with no preview. */
export function cardOf(result: unknown): Card | null {
  const preview = (result as { preview?: Preview } | null | undefined)?.preview;
  return preview ? { light: renderPreview(preview), dark: renderPreview(preview, { theme: "dark" }) } : null;
}

/**
 * The view, speaking the extension's JSON-RPC over `postMessage` with no SDK: `ui/initialize` and its theme, the tool's
 * result with its card, a theme change, and the teardown and ping it must answer. It reports its size as it draws.
 */
export function cardPage(version: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;background:transparent}#card svg{display:block;max-width:100%;height:auto}</style>
</head><body><div id="card"></div><script>
(function () {
  var theme = "light", card = null, el = document.getElementById("card");
  function send(message) { message.jsonrpc = "2.0"; window.parent.postMessage(message, "*"); }
  function themed(t) { return t === "dark" ? "dark" : "light"; }
  function draw() {
    if (!card) return;
    el.innerHTML = theme === "dark" ? card.dark : card.light;
    var box = el.getBoundingClientRect();
    send({ method: "ui/notifications/size-changed", params: { width: Math.ceil(box.width), height: Math.ceil(box.height) } });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id === "gage-init" && m.result) {
      theme = themed(m.result.hostContext && m.result.hostContext.theme);
      send({ method: "ui/notifications/initialized" });
      draw();
    } else if (m.method === "ui/notifications/tool-result") {
      var c = m.params && m.params._meta && m.params._meta["${CARD_META}"];
      if (c && typeof c.light === "string" && typeof c.dark === "string") { card = c; draw(); }
    } else if (m.method === "ui/notifications/host-context-changed") {
      if (m.params && m.params.theme) { theme = themed(m.params.theme); draw(); }
    } else if ((m.method === "ui/resource-teardown" || m.method === "ping") && m.id !== undefined) {
      send({ id: m.id, result: {} });
    }
  });
  send({ id: "gage-init", method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "gage", version: "${version}" }, appCapabilities: {} } });
})();
</script></body></html>`;
}
