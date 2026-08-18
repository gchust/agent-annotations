import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
for (const text of [
  "pnpm add -D @gchust/agent-annotations",
  'import agentAnnotations from "@gchust/agent-annotations/vite"',
  'import { defineClientExtension } from "@gchust/agent-annotations/extension"',
  "agent-annotations list",
  "agent-annotations complete <annotation-id> --verified --summary <text>",
  "agent-annotations reopen <annotation-id>",
  "agent-annotations print [--json|--markdown]",
  "agent-annotations verify",
  "agent-annotations audit",
]) {
  if (!readme.includes(text)) throw new Error(`README example missing: ${text}`);
}
if (/\bmcp\b/i.test(readme)) {
  throw new Error("README must not mention MCP");
}
console.log("[agent-annotations] docs smoke PASS");
