import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

const artifactRoot = process.env.AGENT_ANNOTATIONS_EVIDENCE
  ?? path.join(tmpdir(), "agent-annotations-packed-react-vite-evidence");

export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(artifactRoot, "playwright-results"),
  reporter: "list",
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:4179",
    screenshot: "only-on-failure",
    trace: "on",
  },
  webServer: {
    command: "node -e \"require('node:fs').rmSync('.agent-annotations',{recursive:true,force:true})\" && pnpm dev --port 4179",
    port: 4179,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
