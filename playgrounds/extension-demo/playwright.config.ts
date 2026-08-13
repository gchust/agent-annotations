import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

const evidenceRoot = process.env.AGENT_FEEDBACK_EVIDENCE
  ?? path.join(tmpdir(), "agent-feedback-extension-demo-evidence");

export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(evidenceRoot, "playwright-results"),
  reporter: "list",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4405",
    screenshot: "only-on-failure",
    trace: "on",
  },
  webServer: {
    command: "node -e \"require('node:fs').rmSync('.agent-feedback',{recursive:true,force:true})\" && pnpm dev --port 4405",
    port: 4405,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
