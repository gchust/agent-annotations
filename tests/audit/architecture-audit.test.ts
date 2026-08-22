import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runArchitectureAudit } from "../../src/audit/index.js";

const roots: string[] = [];
const SOLE_PRIMITIVES_IMPORTER = "src/client/inspection-engine.ts";
const primitives = "react-grab" + "/primitives";
const fixture = (offender?: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-audit-"));
  roots.push(root);
  for (const [file, content] of Object.entries({
    [SOLE_PRIMITIVES_IMPORTER]: `import { getElementContext } from "${primitives}";`,
    ...(offender ? { "src/offender.ts": offender } : {}),
  })) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("architecture audit", () => {
  it("passes the repository itself", () => {
    const repo = fileURLToPath(new URL("../..", import.meta.url));
    const result = runArchitectureAudit(repo);
    expect(result.ok).toBe(true);
  });

  it("passes a clean tree", () => expect(runArchitectureAudit(fixture()).ok).toBe(true));

  it("passes a packed consumer without package source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-audit-packed-"));
    roots.push(root);
    writeFileSync(path.join(root, "package.json"), '{"name":"packed-consumer"}');
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/main.ts"), "export const app = true;");
    expect(runArchitectureAudit(root)).toEqual({ ok: true, problems: [], importerFiles: [] });
  });

  it.each([
    ["sole-primitives-importer", `import { freeze } from "${primitives}";`],
    ["react-grab-ui", `import "react-grab";`],
    ["element-source", `import "element-source";`],
    ["fiber-private-source", `element.__reactFiber$abc;`],
    ["transformed-code-guess", `transformResult.code.match(/x/);`],
    ["basename-lookup", `path.basename(filePath);`],
    ["old-schema", `const old = "portal-studio";`],
    ["nocobase", `import "@nocobase/client";`],
    ["builtin-bypass", `switch (action) { case "pick": break; }`],
  ])("fails an injected %s violation", (check, content) => {
    const result = runArchitectureAudit(fixture(content));
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === check)).toBe(true);
  });

  it.each([
    ["transformed-code-guess", `transformResult\n  ?.code.match(/x/);`],
    ["basename-lookup", `readdirSync(root)\n  .find((file) => filePath.\n    basename(file) === target);`],
    ["builtin-bypass", `switch (\n  action\n) {\n  case "pick": break;\n}`],
  ])("fails an injected multiline %s violation", (check, content) => {
    const result = runArchitectureAudit(fixture(content));
    expect(result.problems.some((problem) => problem.check === check)).toBe(true);
  });
});

// Goal 14: the runtime module graph is built from real relative imports, so
// injected cycles and controller->mount edges must be detected.
const runtimeFixture = (modules: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-audit-runtime-"));
  roots.push(root);
  for (const [name, content] of Object.entries(modules)) {
    const absolute = path.join(root, "src/client/runtime", name);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
};

describe("runtime module graph audit", () => {
  it("passes the repository runtime graph", () => {
    const repo = fileURLToPath(new URL("../..", import.meta.url));
    expect(runArchitectureAudit(repo).ok).toBe(true);
  });

  it("fails an injected A <-> B runtime cycle", () => {
    const root = runtimeFixture({
      "markers.ts": `import { diagnostics } from "./diagnostics.js";\nexport const markers = diagnostics;`,
      "diagnostics.ts": `import { markers } from "./markers.js";\nexport const diagnostics = markers;`,
      "mount.ts": `import { markers } from "./markers.js";\nexport const mount = markers;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-cycle")).toBe(true);
  });

  it("fails an injected controller -> mount import", () => {
    const root = runtimeFixture({
      "capture.ts": `import { mount } from "./mount.js";\nexport const capture = mount;`,
      "mount.ts": `export const mount = 1;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-controller-imports-mount")).toBe(true);
  });

  it("still fails old forbidden patterns when injected into mount.ts", () => {
    const root = runtimeFixture({
      "mount.ts": `import "@nocobase/client";\nimport "react-grab";\nexport const mount = true;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "nocobase")).toBe(true);
    expect(result.problems.some((problem) => problem.check === "react-grab-ui")).toBe(true);
  });

  it("fails a cycle involving a dynamically discovered new module name", () => {
    // The module list is discovered from the directory, never hardcoded, so
    // an arbitrary new file name can form a cycle.
    const root = runtimeFixture({
      "extra.ts": `import { markers } from "./markers.js";\nexport const extra = markers;`,
      "markers.ts": `import { extra } from "./extra.js";\nexport const markers = extra;`,
      "mount.ts": `import { extra } from "./extra.js";\nexport const mount = extra;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    // One physical cycle yields exactly one finding regardless of which root
    // reaches it first.
    expect(result.problems.filter((problem) => problem.check === "runtime-cycle")).toHaveLength(1);
  });

  it("fails a mixed-case/underscore module cycle exactly once", () => {
    // Discovery accepts every top-level .ts file (no name-shape allowlist),
    // so a mixed-case or underscored module can never escape the graph checks.
    const root = runtimeFixture({
      "helper_Name.ts": `import "./secondModule.js";\nexport const helper = 1;`,
      "secondModule.ts": `import { helper } from "./helper_Name.js";\nexport const second = helper;`,
      "mount.ts": `import { helper } from "./helper_Name.js";\nexport const mount = helper;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    // The side-effect/import cycle yields exactly one finding.
    expect(result.problems.filter((problem) => problem.check === "runtime-cycle")).toHaveLength(1);
  });

  it("fails a cycle formed through a side-effect import", () => {
    const root = runtimeFixture({
      "markers.ts": `import "./diagnostics.js";\nexport const markers = 1;`,
      "diagnostics.ts": `import "./markers.js";\nexport const diagnostics = 1;`,
      "mount.ts": `import { markers } from "./markers.js";\nexport const mount = markers;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-cycle")).toBe(true);
  });

  it("fails a non-mount runtime module creating a second React root", () => {
    const root = runtimeFixture({
      "capture.ts": `import { createRoot } from "react-dom/client";\nexport const capture = createRoot;`,
      "mount.ts": `import { createRoot } from "react-dom/client";\nexport const mount = createRoot;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-second-root")).toBe(true);
  });

  it("fails a non-mount module with a namespace react-dom/client import", () => {
    const root = runtimeFixture({
      "capture.ts": `import * as ReactDOM from "react-dom/client";\nexport const capture = ReactDOM.createRoot;`,
      "mount.ts": `export const mount = 1;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-second-root")).toBe(true);
  });

  it("counts namespace createRoot calls inside mount and fails on a second root", () => {
    const root = runtimeFixture({
      "mount.ts": `import * as ReactDOM from "react-dom/client";\nReactDOM.createRoot(document.body);\nReactDOM.createRoot(document.body);\nexport const mount = 1;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-second-root")).toBe(true);
  });

  it("does not count a renamed non-createRoot import as createRoot", () => {
    // `hydrateRoot as createRoot` must not be treated as a createRoot
    // binding; only the imported name createRoot counts.
    const root = runtimeFixture({
      "mount.ts": `import { hydrateRoot as createRoot } from "react-dom/client";\ncreateRoot(document.body);\ncreateRoot(document.body);\nexport const mount = 1;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(true);
    expect(result.problems.some((problem) => problem.check === "runtime-second-root")).toBe(false);
  });

  it("does not flag a local createRoot function without a react-dom/client import", () => {
    const root = runtimeFixture({
      "mount.ts": `function createRoot(node: unknown) { return node; }\ncreateRoot(document.body);\nexport const mount = 1;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(true);
    expect(result.problems.some((problem) => problem.check === "runtime-second-root")).toBe(false);
  });

  it("fails a mount module with a second createRoot call", () => {
    const root = runtimeFixture({
      "mount.ts": `import { createRoot } from "react-dom/client";\ncreateRoot(document.body);\ncreateRoot(document.body);\nexport const mount = 1;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-second-root")).toBe(true);
  });

  it("fails a helper/controller calling chrome or overlays", () => {
    const root = runtimeFixture({
      "capture.ts": `import { chrome } from "./chrome.js";\nexport const capture = chrome;`,
      "chrome.ts": `export const chrome = 1;`,
      "overlays.ts": `export const overlays = 1;`,
      "mount.ts": `import { chrome } from "./chrome.js";\nexport const mount = chrome;`,
    });
    const result = runArchitectureAudit(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === "runtime-helper-imports-ui-layer")).toBe(true);
  });
});
