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
    clean: true,
    platform: "browser",
  },
  {
    // /core builds in its own group so its declaration is never
    // code-split with the browser client: the whole /core declaration
    // closure stays free of React/Vite/DOM/Node imports.
    entry: {
      "core/index": "src/core/index.ts",
    },
    format: "esm",
    dts: true,
    clean: false,
    platform: "browser",
  },
  {
    entry: {
      "vite/index": "src/vite/index.ts",
      "cli/index": "src/cli/index.ts",
    },
    format: "esm",
    dts: true,
    clean: false,
    platform: "node",
  },
]);
