import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      "client/index": "src/client/index.ts",
      "vite/client": "src/vite/client.ts",
      "extension/index": "src/extension/index.ts",
      "types/index": "src/types/index.ts",
      "testing/index": "src/testing/index.ts",
    },
    format: "esm",
    dts: true,
    sourcemap: true,
    clean: true,
    platform: "browser",
  },
  {
    entry: {
      "vite/index": "src/vite/index.ts",
      "cli/index": "src/cli/index.ts",
    },
    format: "esm",
    dts: true,
    sourcemap: true,
    clean: false,
    platform: "node",
  },
]);
