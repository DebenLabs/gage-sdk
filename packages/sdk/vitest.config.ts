import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The examples import "gage-sdk" as an app would; here that is this package's own source, so they test without a build.
const source = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^gage-sdk\/testing$/, replacement: source("./src/testing.ts") },
      { find: /^gage-sdk$/, replacement: source("./src/index.ts") },
    ],
  },
  test: { include: ["test/**/*.test.ts"], environment: "node", fileParallelism: false },
});
