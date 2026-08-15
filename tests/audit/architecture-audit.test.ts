import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    ["basename-lookup", `readdirSync(root)\n  .find((file) => path.\n    basename(file) === target);`],
    ["builtin-bypass", `switch (\n  action\n) {\n  case "pick": break;\n}`],
  ])("fails an injected multiline %s violation", (check, content) => {
    const result = runArchitectureAudit(fixture(content));
    expect(result.problems.some((problem) => problem.check === check)).toBe(true);
  });
});
