import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  createSourceFile,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
} from "typescript";

export type AuditProblem = { check: string; file: string; line: number };

const SOLE_PRIMITIVES_IMPORTER = "src/client/inspection-engine.ts";
const SCOPES = ["src", "scripts", "tests", "fixtures", "playgrounds"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
const ALLOWLIST = new Set([
  "src/audit/index.ts",
  "tests/audit/architecture-audit.test.ts",
  "tests/cli/cli.test.ts",
]);

// The browser runtime layer is mounted from every top-level .ts file in the
// runtime directory (no name-shape allowlist, so a mixed-case or underscored
// module can never bypass the audit). mount is the single orchestrating sink;
// helpers/controllers (everything except mount/chrome/overlays) must stay
// below chrome/overlays.
const runtimeModules = (root: string): string[] => {
  const directory = path.join(root, "src/client/runtime");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.startsWith("."))
    .map((entry) => entry.slice(0, -".ts".length))
    .sort();
};

const CHECKS = [
  ["react-grab-ui", /(?:from\s*["']react-grab["']|import\s*["']react-grab["']|react-grab\/(?:dist|src)\/)/],
  ["element-source", /element-source/],
  ["fiber-private-source", /__reactFiber\$|findFiberKey|collectComponentChain|readFiberTypeName|\.fiber\b/],
  ["transformed-code-guess", /transformResult\s*\??\s*\.\s*code|resolveComponentSources|assignSourceCandidates/],
  ["basename-lookup", /(?:path\.)?basename\s*\([^)]*filePath|readdirSync[\s\S]{0,120}basename/],
  ["old-schema", /PortalStudio|portal-studio|\.portal-studio|TASK_SCHEMA_VERSION_V[1-6]|normalizeLegacy|capture_task/],
  ["nocobase", /\x40nocobase|data\x2dnb-|data\x2dai\x2dpage\x2delement|NOCO\x42ASE_/],
  ["builtin-bypass", /switch\s*\([^)]*(?:action|contribution)[^)]*\)|case\s+["'](?:pick|multi|area|copy|visibility|help|list)["']/],
  ["legacy-heartbeat", /HEARTBEAT_INTERVAL|heartbeatInFlight|heartbeatTimer/],
  ["vite-source-endpoint", /resolvedEndpoint\}\/source/],
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
  const packageSourcePresent = existsSync(path.join(root, SOLE_PRIMITIVES_IMPORTER));
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
  if (packageSourcePresent && (sourceImporters.length !== 1 || sourceImporters[0] !== SOLE_PRIMITIVES_IMPORTER)) {
    problems.push({ check: "sole-primitives-importer", file: SOLE_PRIMITIVES_IMPORTER, line: 1 });
  }
  // Goal 14: parse every runtime module with the TypeScript AST (covering
  // static import/export specifiers including side-effect imports), build the
  // real directed graph, and reject (a) any cycle, (b) any non-mount module
  // importing mount, and (c) any helper/controller importing chrome/overlays
  // (the top UI layer below mount).
  const runtimeNames = runtimeModules(root);
  const runtimeSet = new Set(runtimeNames);
  const runtimeEdges = new Map<string, Set<string>>();
  const runtimeLines = new Map<string, Map<string, number>>();
  for (const name of runtimeNames) {
    const file = `src/client/runtime/${name}.ts`;
    if (!files.includes(file)) continue;
    const sourceText = readFileSync(path.join(root, file), "utf8");
    const sourceFile = createSourceFile(file, sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
    const edges = new Set<string>();
    const lines = new Map<string, number>();
    // Single-React-Root rule, two AST passes per module. Pass 1 collects
    // every static react-dom/client import (named, aliased, or namespace);
    // any non-mount module importing it fails outright. Pass 2 counts
    // createRoot calls only through those real import bindings (named alias
    // calls and namespaceAlias.createRoot property calls), so a local
    // function that happens to be named createRoot is never misreported.
    const rootImportLines: number[] = [];
    const rootAliases = new Set<string>();
    const rootNamespaces = new Set<string>();
    const visitImports = (node: import("typescript").Node): void => {
      if (isImportDeclaration(node) || isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && isStringLiteralLike(specifier)) {
          const relative = /^\.\/([^/]+)\.(?:js|ts)$/.exec(specifier.text);
          if (relative) {
            const target = relative[1]!;
            if (runtimeSet.has(target)) {
              edges.add(target);
              const position = specifier.getStart(sourceFile);
              lines.set(target, sourceText.slice(0, position).split(/\r?\n/).length);
            }
          }
        }
      }
      if (
        isImportDeclaration(node) &&
        node.moduleSpecifier &&
        isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "react-dom/client"
      ) {
        const importLine = sourceText.slice(0, node.getStart(sourceFile)).split(/\r?\n/).length;
        rootImportLines.push(importLine);
        const named = node.importClause?.namedBindings;
        if (named) {
          if (isNamedImports(named)) {
            for (const element of named.elements) {
              const local = element.name.text;
              const imported = element.propertyName?.text ?? local;
              if (imported === "createRoot") rootAliases.add(local);
            }
          } else if (isNamespaceImport(named)) {
            rootNamespaces.add(named.name.text);
          }
        }
      }
      node.forEachChild(visitImports);
    };
    visitImports(sourceFile);
    if (name !== "mount" && rootImportLines.length > 0) {
      problems.push({ check: "runtime-second-root", file, line: rootImportLines[0]! });
    }
    const rootCalls: number[] = [];
    const visitCalls = (node: import("typescript").Node): void => {
      if (isCallExpression(node)) {
        const expression = node.expression;
        if (isIdentifier(expression) && rootAliases.has(expression.text)) {
          rootCalls.push(sourceText.slice(0, node.getStart(sourceFile)).split(/\r?\n/).length);
        } else if (
          isPropertyAccessExpression(expression) &&
          expression.name.text === "createRoot" &&
          isIdentifier(expression.expression) &&
          rootNamespaces.has(expression.expression.text)
        ) {
          rootCalls.push(sourceText.slice(0, node.getStart(sourceFile)).split(/\r?\n/).length);
        }
      }
      node.forEachChild(visitCalls);
    };
    visitCalls(sourceFile);
    if (name === "mount" && rootCalls.length > 1) {
      problems.push({ check: "runtime-second-root", file, line: rootCalls[1]! });
    }
    if (name !== "mount" && rootCalls.length > 0) {
      problems.push({ check: "runtime-second-root", file, line: rootCalls[0]! });
    }
    runtimeEdges.set(name, edges);
    runtimeLines.set(name, lines);
  }
  // DFS with proper unwinding: when a cycle is found, the traversal state of
  // every node on the current path is cleaned before propagating. Every
  // detected path is canonicalized (rotated to start at its smallest member)
  // and deduplicated, so one physical cycle yields exactly one finding no
  // matter which root reaches it first.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const detectCycle = (name: string): string[] | null => {
    if (visiting.has(name)) {
      const from = stack.indexOf(name);
      return [...stack.slice(from), name];
    }
    if (visited.has(name)) return null;
    visiting.add(name);
    stack.push(name);
    for (const next of runtimeEdges.get(name) ?? []) {
      const cycle = detectCycle(next);
      if (cycle) {
        stack.pop();
        visiting.delete(name);
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  };
  const canonicalCycle = (path: string[]): string => {
    const members = path.slice(0, -1);
    let best = members.join(" -> ");
    for (let index = 1; index < members.length; index += 1) {
      const rotated = [...members.slice(index), ...members.slice(0, index)].join(" -> ");
      if (rotated < best) best = rotated;
    }
    return best;
  };
  const seenCycles = new Set<string>();
  for (const name of runtimeNames) {
    const cycle = detectCycle(name);
    if (!cycle) continue;
    const key = canonicalCycle(cycle);
    if (seenCycles.has(key)) continue;
    seenCycles.add(key);
    problems.push({ check: "runtime-cycle", file: `src/client/runtime/${cycle[0]}.ts`, line: 1 });
  }
  for (const [name, edges] of runtimeEdges) {
    if (name === "mount") continue;
    if (edges.has("mount")) {
      problems.push({
        check: "runtime-controller-imports-mount",
        file: `src/client/runtime/${name}.ts`,
        line: runtimeLines.get(name)?.get("mount") ?? 1,
      });
    }
    if (name !== "chrome" && name !== "overlays" && (edges.has("chrome") || edges.has("overlays"))) {
      problems.push({
        check: "runtime-helper-imports-ui-layer",
        file: `src/client/runtime/${name}.ts`,
        line: Math.min(runtimeLines.get(name)?.get("chrome") ?? Infinity, runtimeLines.get(name)?.get("overlays") ?? Infinity),
      });
    }
  }
  return { ok: problems.length === 0, problems, importerFiles };
};
