import { defineConfig } from "@playwright/test";

const artifactRoot = process.env.AGENT_ANNOTATIONS_ARTIFACT_DIR ?? "/tmp/agent-annotations-g03";

export default defineConfig({
  testDir: "./tests",
  outputDir: `${artifactRoot}/playwright-results`,
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:4399",
    trace: "on",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev --port 4399 --strictPort",
    url: "http://localhost:4399",
    reuseExistingServer: false,
    env: {
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
  },
});
