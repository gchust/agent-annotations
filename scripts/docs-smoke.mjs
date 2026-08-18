import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const name = manifest.name;
const bin = Object.keys(manifest.bin)[0];
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
for (const text of [
  `pnpm add -D ${name}`,
  `import agentAnnotations from "${name}/vite"`,
  `import { defineClientExtension } from "${name}/extension"`,
  `${bin} list`,
  `${bin} complete <annotation-id> --verified --summary <text>`,
  `${bin} reopen <annotation-id>`,
  `${bin} print [--json|--markdown]`,
  `${bin} verify`,
]) {
  if (!readme.includes(text)) throw new Error(`README example missing: ${text}`);
}
if (/\bmcp\b/i.test(readme)) {
  throw new Error("README must not mention MCP");
}
console.log("[agent-annotations] docs smoke PASS");
