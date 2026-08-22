import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

// Runs the packed consumer under a relative Vite base (/app/): the dev server
// starts with AGENT_ANNOTATIONS_PACKED_BASE=/app/ and the spec navigates to
// /app/, proving the runtime mounts and persists under a non-root base.
export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(process.env.AGENT_ANNOTATIONS_EVIDENCE
    ?? path.join(tmpdir(), "agent-annotations-packed-react-vite-evidence"), "playwright-results-relative-base"),
  reporter: "list",
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  testMatch: "**/relative-base.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:4180",
    screenshot: "only-on-failure",
    trace: "on",
  },
  webServer: {
    command: "node -e \"require('node:fs').rmSync('.agent-annotations',{recursive:true,force:true})\" && AGENT_ANNOTATIONS_PACKED_BASE=/app/ pnpm dev --port 4180",
    port: 4180,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
