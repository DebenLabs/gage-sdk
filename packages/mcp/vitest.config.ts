import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests read gage-sdk from its source, so they never run against a stale build; typecheck and production use its dist.
const sdk = (file: string) => fileURLToPath(new URL(`../../packages/sdk/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^gage-sdk\/testing$/, replacement: sdk("testing.ts") }, { find: /^gage-sdk$/, replacement: sdk("index.ts") }] },
  test: { include: ["test/**/*.test.ts"], environment: "node", fileParallelism: false },
});
