import { existsSync, readFileSync } from "node:fs";

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
  `${bin} evidence [--json|--prune [--json]]`,
]) {
  if (!readme.includes(text)) throw new Error(`README example missing: ${text}`);
}
if (/\bmcp\b/i.test(readme)) {
  throw new Error("README must not mention MCP");
}
// Goal 15 governance + public-surface guards: the old `verify` command must
// not reappear as a current usage, governance files must exist, and the
// architecture doc must describe the runtime graph.
const forbiddenVerify = ["README.md", "API.md", "CHANGELOG.md", "docs/architecture.md", "package.json"];
// Built via concatenation so this script's own source does not match the scan.
const oldVerifyUsage = new RegExp("agent-annotations " + "verify" + "\\b");
for (const file of forbiddenVerify) {
  const content = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  if (oldVerifyUsage.test(content)) {
    throw new Error(`${file} must not document the removed verify command`);
  }
}
// Dependency governance: the manifest dependency keys must never couple to
// MCP or NocoBase packages.
for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  for (const key of Object.keys(manifest[section] ?? {})) {
    if (/\bmcp\b|nocobase/i.test(key)) {
      throw new Error(`manifest ${section} must not depend on MCP/NocoBase: ${key}`);
    }
  }
}
const arch = readFileSync(new URL("../docs/architecture.md", import.meta.url), "utf8");
if (/\bmcp\b|\x40nocobase/i.test(arch)) {
  throw new Error("architecture doc must not mention MCP/NocoBase as a dependency");
}
for (const file of [
  "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  "docs/architecture.md",
]) {
  if (!existsSync(new URL(`../${file}`, import.meta.url))) {
    throw new Error(`missing governance/architecture file: ${file}`);
  }
}
// Public exports: every API.md "@gchust/agent-annotations/..." heading must
// map one-to-one with the package.json exports entries (no missing or
// nonexistent public export).
const exportsMap = manifest.exports ?? {};
const apiText = readFileSync(new URL("../API.md", import.meta.url), "utf8");
const headings = [...apiText.matchAll(/^## `(@gchust\/agent-annotations(?:\/[a-z-]+)*)`$/gm)]
  .map((match) => match[1]);
const expectedHeadings = Object.keys(exportsMap).map((key) =>
  key === "." ? name : `${name}/${key.slice(2)}`
);
if (JSON.stringify([...headings].sort()) !== JSON.stringify(expectedHeadings.sort())) {
  throw new Error(`API.md public export headings do not match package.json: ${headings.join(", ")}`);
}

// Node 20 compatibility guards: the Vite config example must use the form
// supported on every Node >= 20 minor (fileURLToPath(new URL(...))), never
// import.meta.dirname. Compilation of the example is proven once by the
// the typecheck probe and external packed consumer gate, not by this smoke.
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
