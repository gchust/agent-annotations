import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
for (const text of [
  "pnpm add -D @gchust/agent-feedback",
  'import agentFeedback from "@gchust/agent-feedback/vite"',
  'import { defineClientExtension } from "@gchust/agent-feedback/extension"',
  "agent-feedback list",
  "agent-feedback complete <annotation-id> --verified --summary <text>",
  "agent-feedback reopen <annotation-id>",
  "agent-feedback print [--json|--markdown]",
  "agent-feedback verify",
  "agent-feedback mcp",
  "agent-feedback audit",
]) {
  if (!readme.includes(text)) throw new Error(`README example missing: ${text}`);
}
console.log("[agent-feedback] docs smoke PASS");
