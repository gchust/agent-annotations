import path from "node:path";

import react from "@vitejs/plugin-react";
import agentAnnotations from "@gchust/agent-annotations/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    agentAnnotations({
      clientExtensions: [
        path.resolve(import.meta.dirname, "src/demo-extension.ts"),
      ],
    }),
  ],
});
