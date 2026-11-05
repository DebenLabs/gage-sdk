/**
 * gage-mcp from your own code: an MCP client that starts the server over stdio, as Claude Code, Codex or Cursor does,
 * reads its instructions and tools, and calls one. Without a key it reads and prepares; with the wallet `gage-mcp init`
 * made (or GAGE_PRIVATE_KEY_FILE) it also signs gage's own transactions, under the spend limits `gage_limits` reports.
 * Needs the MCP client: npm install @modelcontextprotocol/client
 *
 * Run from packages/mcp, after `pnpm install && pnpm build`: npx tsx examples/stdio-client.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** How to start gage-mcp: the published package by default. */
export interface ServerCommand { command: string; args: string[]; cwd?: string }
export const NPX: ServerCommand = { command: "npx", args: ["-y", "gage-mcp"] };

/**
 * Starts gage-mcp with `env` (GAGE_NETWORK, the spend limits, GAGE_HOME, …), and answers what it serves: whether it signs,
 * its tools by kind, and, when it signs, what is left of its limits. `read` names a tool to call, with no input.
 */
export async function gageOverStdio(env: Record<string, string> = {}, server: ServerCommand = NPX, read?: string) {
  const client = new Client({ name: "my-agent", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ ...server, env: { ...getDefaultEnvironment(), ...env }, stderr: "pipe" }));
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // The signing tools carry MCP's destructive hint: a client asks before each one unless it is allowed.
    const signing = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    const text = async (name: string) => {
      const result = await client.callTool({ name, arguments: {} });
      const first = (result.content as { type: string; text?: string }[])[0];
      return first?.type === "text" ? JSON.parse(first.text ?? "null") as unknown : null;
    };
    return {
      instructions: client.getInstructions() ?? "",
      reads: names.filter((n) => !n.startsWith("gage_prepare_") && !signing.includes(n)),
      prepares: names.filter((n) => n.startsWith("gage_prepare_")),
      signing,
      limits: names.includes("gage_limits") ? await text("gage_limits") : null,
      read: read ? await text(read) : null,
    };
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.dir(await gageOverStdio({}, NPX, "gage_capabilities"), { depth: 4 });
}
