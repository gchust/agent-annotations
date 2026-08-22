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
  `${bin} list [--json]`,
  `${bin} complete <annotation-id> --verified --summary <text>`,
  `${bin} reopen <annotation-id>`,
  `${bin} print [--json|--markdown]`,
  `${bin} validate-task [--json]`,
  `${bin} status [--json] [--check]`,
  `${bin} --root <path> --dir <path> <command> [options]`,
  `${bin} revision [--json]`,
  `${bin} wait --source-revision <sha256> [--timeout-ms <n>] [--json]`,
  `${bin} wait --browser-source-revision <sha256> [--timeout-ms <n>] [--json]`,
  `${bin} diagnostics [--json|--clear]`,
  `${bin} evidence [--json]`,
]) {
  if (!readme.includes(text)) throw new Error(`README example missing: ${text}`);
}
if (/\bmcp\b/i.test(readme)) {
  throw new Error("README must not mention MCP");
}
// Node 20 compatibility guards: the Vite config example must use the form
// supported on every Node >= 20 minor (fileURLToPath(new URL(...))), never
// import.meta.dirname. Compilation of the example is proven once by the
// external packed consumer gate, not by this smoke.
if (readme.includes("import.meta.dirname")) {
  throw new Error("README must not use import.meta.dirname (Node 20 example)");
}
if (!readme.includes('import { fileURLToPath } from "node:url"')) {
  throw new Error("README Vite example must import node:url for fileURLToPath");
}
if (!readme.includes('fileURLToPath(new URL("./src/annotation-extension.ts", import.meta.url))')) {
  throw new Error("README Vite example must use the fileURLToPath(new URL(...)) form");
}
console.log("[agent-annotations] docs smoke PASS");
