/**
 * gage's tools for your own agent: the names, inputs and descriptions gage's MCP servers serve, each answering through
 * `execute(input)`. Without a signer they read and prepare only. Hand them to any framework that takes a name, a
 * description, a zod schema and a function (the Vercel AI SDK, OpenAI's or Anthropic's agent SDKs).
 *
 * Run from packages/sdk, after `pnpm install && pnpm build`: npx tsx examples/agent-tools.ts
 */
import { pathToFileURL } from "node:url";
import { createGage, gageTools, type Gage } from "gage-sdk";

/** The tool catalogue, and two calls a model would make first: what gage is, and what it takes as collateral. */
export async function agentTools(gage: Gage) {
  const tools = gageTools(gage);
  const call = (name: string, input: unknown) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`gage serves no tool named ${name}`);
    return tool.execute(input);
  };
  return {
    tools: tools.map((t) => `${t.name}: ${t.title}`),
    capabilities: await call("gage_capabilities", {}),
    collateral: await call("gage_assets", {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.dir(await agentTools(createGage()), { depth: 3 });
}
