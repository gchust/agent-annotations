import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type AuditProblem = { check: string; file: string; line: number };

export const SOLE_PRIMITIVES_IMPORTER = "src/client/inspection-engine.ts";
const SCOPES = ["src", "scripts", "tests", "fixtures", "playgrounds"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
const ALLOWLIST = new Set([
  "src/audit/index.ts",
  "tests/audit/architecture-audit.test.ts",
  "tests/cli/cli.test.ts",
]);

const CHECKS = [
  ["react-grab-ui", /(?:from\s*["']react-grab["']|import\s*["']react-grab["']|react-grab\/(?:dist|src)\/)/],
  ["element-source", /element-source/],
  ["fiber-private-source", /__reactFiber\$|findFiberKey|collectComponentChain|readFiberTypeName|\.fiber\b/],
  ["transformed-code-guess", /transformResult\s*\??\s*\.\s*code|resolveComponentSources|assignSourceCandidates/],
  ["basename-lookup", /(?:path\.)?basename\s*\([^)]*filePath|readdirSync[\s\S]{0,120}basename/],
  ["old-schema", /PortalStudio|portal-studio|\.portal-studio|TASK_SCHEMA_VERSION_V[1-6]|normalizeLegacy|capture_task/],
  ["nocobase", /@nocobase|data-nb-|data-ai-page-element|NOCOBASE_/],
  ["builtin-bypass", /switch\s*\([^)]*(?:action|contribution)[^)]*\)|case\s+["'](?:pick|multi|area|copy|visibility|help|list)["']/],
] as const;

const walk = (directory: string, base: string, files: string[]): void => {
  let entries: string[];
  try { entries = readdirSync(directory); } catch { return; }
  for (const entry of entries) {
    if (["node_modules", "dist", ".git", "test-results", "playwright-report"].includes(entry)) continue;
    const absolute = path.join(directory, entry);
    const relative = path.posix.join(base, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) walk(absolute, relative, files);
    else if (EXTENSIONS.has(path.extname(entry))) files.push(relative);
  }
};

export const runArchitectureAudit = (root: string): { ok: boolean; problems: AuditProblem[]; importerFiles: string[] } => {
  const files: string[] = [];
  for (const scope of SCOPES) walk(path.join(root, scope), scope, files);
  for (const manifest of ["package.json", "pnpm-lock.yaml"]) {
    if (existsSync(path.join(root, manifest))) files.push(manifest);
  }
  const problems: AuditProblem[] = [];
  const importerFiles: string[] = [];
  for (const file of files.sort()) {
    if (ALLOWLIST.has(file)) continue;
    const content = readFileSync(path.join(root, file), "utf8");
    if (/react-grab\/primitives/.test(content)) importerFiles.push(file);
    for (const [check, pattern] of CHECKS) {
      const match = pattern.exec(content);
      if (match) problems.push({
        check,
        file,
        line: content.slice(0, match.index).split(/\r?\n/).length,
      });
    }
  }
  const sourceImporters = importerFiles.filter((file) => file.startsWith("src/"));
  if (sourceImporters.length !== 1 || sourceImporters[0] !== SOLE_PRIMITIVES_IMPORTER) {
    problems.push({ check: "sole-primitives-importer", file: SOLE_PRIMITIVES_IMPORTER, line: 1 });
  }
  return { ok: problems.length === 0, problems, importerFiles };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runArchitectureAudit(process.cwd());
  if (result.ok) console.log("[agent-feedback] architecture audit PASS");
  else {
    console.error("[agent-feedback] architecture audit FAIL");
    for (const problem of result.problems) console.error(`  [${problem.check}] ${problem.file}:${problem.line}`);
    process.exitCode = 1;
  }
}
