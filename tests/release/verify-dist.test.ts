import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/verify-dist.mjs", import.meta.url));
const roots: string[] = [];
const fixture = (exports: unknown, bin: unknown, files: string[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-verify-dist-"));
  roots.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0", exports, bin }));
  for (const file of files) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "export {};\n");
  }
  return root;
};
const run = (root: string): { status: number; stdout: string; stderr: string } => {
  try {
    execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    return { status: 0, stdout: "", stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("verify-dist prepack gate", () => {
  it("passes when every exported entry and bin target exists", () => {
    const root = fixture(
      { ".": { types: "./dist/client/index.d.ts", import: "./dist/client/index.js" } },
      { "agent-annotations": "./dist/cli/index.mjs" },
      ["dist/client/index.d.ts", "dist/client/index.js", "dist/cli/index.mjs"],
    );
    expect(run(root).status).toBe(0);
  });

  it("fails when an exported declaration entry is missing", () => {
    const root = fixture(
      { ".": { types: "./dist/client/index.d.ts", import: "./dist/client/index.js" } },
      {},
      ["dist/client/index.js"],
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/client/index.d.ts");
  });

  it("fails when a bin target is missing", () => {
    const root = fixture({}, { "agent-annotations": "./dist/cli/index.mjs" }, []);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/cli/index.mjs");
  });
});
