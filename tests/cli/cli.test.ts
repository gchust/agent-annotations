import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import pkg from "../../package.json" with { type: "json" };
import { createAgentAnnotationsTask } from "../../src/core/index.js";
import { appendDiagnostics } from "../../src/server/diagnostics.js";
import { createSourcePathService } from "../../src/server/source-path.js";
import { annotationFixture, targetFixture } from "../core/test-data.js";

const script = path.resolve("dist/cli/index.mjs");
const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-cli-"));
  roots.push(root);
  mkdirSync(path.join(root, "tasks"), { recursive: true });
  const task = createAgentAnnotationsTask({
    taskId: "task-cli",
    createdAt: "2026-08-12T12:00:00.000Z",
    annotations: [annotationFixture()],
  });
  writeFileSync(path.join(root, "tasks/active-task.json"), JSON.stringify(task));
  return root;
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

// Clean environment: no AGENT_ANNOTATIONS_DIR/ROOT leak from the host shell.
const cleanEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.AGENT_ANNOTATIONS_DIR;
  delete env.AGENT_ANNOTATIONS_ROOT;
  return { ...env, ...overrides };
};

const runWith = (cwd: string, args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(process.execPath, [script, ...args], { encoding: "utf8", cwd, env });

const run = (root: string, args: string[]): string =>
  runWith(root, args, cleanEnv({ AGENT_ANNOTATIONS_DIR: root }));

const runExpectingFailure = (root: string, args: string[], env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } => {
  try {
    execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd: root,
      env: env ?? cleanEnv({ AGENT_ANNOTATIONS_DIR: root }),
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
  throw new Error(`expected ${args.join(" ")} to fail`);
};

const sessionFixture = () => {
  const parent = mkdtempSync(path.join(tmpdir(), "agent-annotations-cli-roots-"));
  roots.push(parent);
  const workspace = path.join(parent, "mono");
  const app = path.join(workspace, "packages", "app");
  const src = path.join(app, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, "settings.tsx"), "export const A = 1;\n");
  const runtime = path.join(workspace, ".agent-annotations");
  mkdirSync(path.join(runtime, "tasks"), { recursive: true });
  const task = createAgentAnnotationsTask({
    taskId: "task-mono",
    createdAt: "2026-08-12T12:00:00.000Z",
    annotations: [annotationFixture({
      targets: [targetFixture({
        inspection: {
          ...targetFixture().inspection,
          source: { filePath: "packages/app/src/settings.tsx", lineNumber: 1, columnNumber: 20, componentName: "A" },
          sourceStack: [],
        },
      })],
    })],
  });
  writeFileSync(path.join(runtime, "tasks/active-task.json"), JSON.stringify(task));
  const writeSession = (target: string, workspaceRoot: string, runtimeRoot: string) => {
    writeFileSync(path.join(target, "session.json"), JSON.stringify({
      endpoint: "/__agent-annotations",
      origin: "http://127.0.0.1:5173",
      pid: 4242,
      startedAt: "2026-08-12T12:00:00.000Z",
      token: "session-token",
      workspaceRoot,
      runtimeRoot,
    }));
  };
  writeSession(runtime, workspace, runtime);
  return { parent, workspace, app, src, runtime, task, writeSession };
};

// A nested Vite-style runtime under the app package with a task whose source
// paths are relative to the app root (like `packages/app` running its own
// Vite server inside a monorepo).
const nestedAppFixture = (session: ReturnType<typeof sessionFixture>) => {
  const { app, writeSession } = session;
  const runtime = path.join(app, ".agent-annotations");
  mkdirSync(path.join(runtime, "tasks"), { recursive: true });
  const task = createAgentAnnotationsTask({
    taskId: "task-app",
    createdAt: "2026-08-12T12:00:00.000Z",
    annotations: [annotationFixture({
      targets: [targetFixture({
        inspection: {
          ...targetFixture().inspection,
          source: { filePath: "src/settings.tsx", lineNumber: 1, columnNumber: 20, componentName: "A" },
          sourceStack: [],
        },
      })],
    })],
  });
  writeFileSync(path.join(runtime, "tasks/active-task.json"), JSON.stringify(task));
  writeSession(runtime, app, runtime);
  return { runtime, task };
};

describe("public CLI processes", () => {
  it("shows help from the built public binary", () => {
    const help = run(fixture(), ["--help"]);
    expect(help).toContain("Usage: agent-annotations");
    expect(help).toContain(`Agent Annotations ${pkg.version}`);
    expect(help).toContain("validate-task");
    expect(help).not.toContain("mcp");
    expect(help).not.toContain("audit");
    expect(help).not.toContain("verify");
  });

  it("runs every command help plus list, complete, reopen, print, and validate-task", () => {
    const root = fixture();
    for (const command of ["list", "complete", "reopen", "print", "validate-task", "revision", "wait", "diagnostics", "evidence"]) {
      expect(run(root, [command, "--help"])).toContain("Agent Annotations");
    }
    expect(run(root, ["list"])).toContain("ann-1");
    expect(run(root, ["complete", "ann-1", "--verified", "--summary", "browser checked"])).toContain("taskRevision 1");
    expect(run(root, ["reopen", "ann-1"])).toContain("taskRevision 2");
    expect(JSON.parse(run(root, ["print", "--json"]))).toMatchObject({ schema: "agent-annotations.task.v1", taskRevision: 2 });
    expect(run(root, ["print", "--markdown"])).toContain("# Agent Annotations Task task-cli");
    expect(JSON.parse(run(root, ["validate-task", "--json"]))).toEqual({
      ok: true,
      taskId: "task-cli",
      taskRevision: 2,
      schema: "agent-annotations.task.v1",
    });
    expect(run(root, ["validate-task"])).toContain("task task-cli is valid (taskRevision 2, schema agent-annotations.task.v1)");
  });

  it("rejects the old verify command as unknown with exit code 2 and no alias", () => {
    const root = fixture();
    for (const args of [["verify"], ["verify", "--json"], ["verify", "--help"]]) {
      const result = runExpectingFailure(root, args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown command: verify");
    }
  });

  it("rejects mcp as an unknown command with exit code 2", () => {
    const result = runExpectingFailure(fixture(), ["mcp"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command: mcp");
  });

  it("redacts a secret in the complete summary before it reaches active-task.json", () => {
    const root = fixture();
    run(root, ["complete", "ann-1", "--verified", "--summary", "Bearer UNIQUE_SECRET_SENTINEL_cli"]);
    const persisted = readFileSync(path.join(root, "tasks/active-task.json"), "utf8");
    expect(persisted).not.toContain("UNIQUE_SECRET_SENTINEL_cli");
    expect(persisted).toContain("[REDACTED]");
  });

  it("treats completion of an absent annotation as an idempotent skip", () => {
    const root = fixture();
    expect(run(root, ["complete", "ann-missing", "--verified", "--summary", "already absent"]))
      .toBe("skipped ann-missing (annotation not found)\n");
    expect(JSON.parse(run(root, ["print", "--json"]))).toMatchObject({
      taskRevision: 0,
      annotations: [{ annotationId: "ann-1", status: "open" }],
    });
    expect(runExpectingFailure(root, ["reopen", "ann-missing"]).stderr)
      .toContain('annotation "ann-missing" not found');
  });

  it("reads UTF-8 completion summaries from files with strict validation", () => {
    const completeFrom = (contents: string | Uint8Array, name = "summary.txt") => {
      const root = fixture();
      const file = path.join(root, name);
      writeFileSync(file, contents);
      return { root, file };
    };
    const valid = completeFrom("Implemented the fix and ran pnpm test. Bearer UNIQUE_SECRET_FILE");
    expect(run(valid.root, ["complete", "ann-1", "--verified", "--summary-file", valid.file]))
      .toContain("taskRevision 1");
    const completed = JSON.parse(readFileSync(path.join(valid.root, "tasks/active-task.json"), "utf8"));
    expect(completed.annotations[0].completionEvidence.summary).toContain("Implemented the fix");
    expect(JSON.stringify(completed)).not.toContain("UNIQUE_SECRET_FILE");

    for (const contents of ["", "   ", "x".repeat(2_001)]) {
      const sample = completeFrom(contents);
      expect(runExpectingFailure(sample.root, ["complete", "ann-1", "--verified", "--summary-file", sample.file]).status).toBe(2);
    }
    const invalid = completeFrom(Uint8Array.from([0xc3, 0x28]));
    expect(runExpectingFailure(invalid.root, ["complete", "ann-1", "--verified", "--summary-file", invalid.file]))
      .toMatchObject({ status: 2, stderr: expect.stringContaining("readable UTF-8") });
    const missing = fixture();
    expect(runExpectingFailure(missing, ["complete", "ann-1", "--verified", "--summary-file", path.join(missing, "missing")]).status).toBe(2);
    expect(runExpectingFailure(missing, ["complete", "ann-1", "--verified", "--summary", "text", "--summary-file", "x"]).status).toBe(2);

    const expanding = completeFrom(`${"x".repeat(1_985)} Bearer a`);
    expect(run(expanding.root, ["complete", "ann-1", "--verified", "--summary-file", expanding.file]))
      .toContain("taskRevision 1");
    const expanded = JSON.parse(readFileSync(path.join(expanding.root, "tasks/active-task.json"), "utf8"));
    expect(expanded.annotations[0].completionEvidence.summary).toHaveLength(2_000);
    expect(expanded.annotations[0].completionEvidence.summary).toMatch(/…\[truncated\]$/);
    expect(expanded.annotations[0].completionEvidence.summary).not.toContain("Bearer a");
  });

  it("prints and clears persisted diagnostics without touching the task", async () => {
    const root = fixture();
    await appendDiagnostics(root, [{
      source: "console",
      message: "cli-diagnostic",
      timestamp: "2026-08-12T12:00:00.000Z",
    }]);
    expect(JSON.parse(run(root, ["diagnostics", "--json"]))).toEqual([{
      source: "console",
      message: "cli-diagnostic",
      timestamp: "2026-08-12T12:00:00.000Z",
    }]);
    expect(run(root, ["diagnostics"])).toContain("cli-diagnostic");
    run(root, ["diagnostics", "--clear"]);
    expect(JSON.parse(run(root, ["diagnostics", "--json"]))).toEqual([]);
    expect(JSON.parse(run(root, ["validate-task", "--json"]))).toMatchObject({ ok: true, taskRevision: 0 });
  });

  it("renders structured network fields in the human diagnostics output", async () => {
    const root = fixture();
    await appendDiagnostics(root, [{
      source: "network",
      message: "caller-controlled text that must not be relied on",
      timestamp: "2026-08-12T12:00:00.000Z",
      method: "GET",
      url: "https://example.test/a",
      status: 404,
      transport: "fetch",
    }]);
    const output = run(root, ["diagnostics"]);
    // The server-validated structured fields are rendered explicitly, not
    // derived from the caller-controlled message.
    expect(output).toContain("[network] 2026-08-12T12:00:00.000Z fetch GET https://example.test/a 404");
    expect(JSON.parse(run(root, ["diagnostics", "--json"]))[0]).toMatchObject({
      source: "network",
      transport: "fetch",
      method: "GET",
      url: "https://example.test/a",
      status: 404,
    });
  });

  it("lists task-referenced evidence with annotation metadata", () => {
    const root = fixture();
    mkdirSync(path.join(root, "evidence"), { recursive: true });
    writeFileSync(path.join(root, "evidence", "ann-1.png"), "png");
    const task = JSON.parse(readFileSync(path.join(root, "tasks/active-task.json"), "utf8"));
    task.annotations[0].evidence = [{ kind: "screenshot", ref: "evidence/ann-1.png" }];
    writeFileSync(path.join(root, "tasks/active-task.json"), JSON.stringify(task));
    expect(JSON.parse(run(root, ["evidence", "--json"]))).toEqual([{
      ref: "evidence/ann-1.png",
      size: 3,
      annotationIds: ["ann-1"],
    }]);
  });

  it("prunes only orphan evidence and reports safe refs", () => {
    const root = fixture();
    mkdirSync(path.join(root, "evidence"), { recursive: true });
    writeFileSync(path.join(root, "evidence", "orphan.png"), "orphan");
    writeFileSync(path.join(root, "evidence", "kept.png"), "kept");
    const task = JSON.parse(readFileSync(path.join(root, "tasks/active-task.json"), "utf8"));
    task.annotations[0].evidence = [{ kind: "screenshot", ref: "evidence/kept.png" }];
    writeFileSync(path.join(root, "tasks/active-task.json"), JSON.stringify(task));
    // The orphan is inside the grace window on first run: it must be skipped.
    const first = JSON.parse(run(root, ["evidence", "--prune", "--json"]));
    expect(first.deleted).toBe(0);
    expect(first.skipped).toBe(1);
    expect(first.refs.skipped).toEqual(["evidence/orphan.png"]);
    expect(existsSync(path.join(root, "evidence", "orphan.png"))).toBe(true);
    // Backdate the orphan, then the prune deletes it while keeping refs.
    const orphan = path.join(root, "evidence", "orphan.png");
    const past = new Date(Date.now() - 70_000);
    utimesSync(orphan, past, past);
    const second = JSON.parse(run(root, ["evidence", "--prune", "--json"]));
    expect(second.deleted).toBe(1);
    expect(second.refs.deleted).toEqual(["evidence/orphan.png"]);
    expect(existsSync(path.join(root, "evidence", "orphan.png"))).toBe(false);
    expect(existsSync(path.join(root, "evidence", "kept.png"))).toBe(true);
  });

  it("emits pure JSON for list and validate-task and human text otherwise", () => {
    const root = fixture();
    const list = run(root, ["list", "--json"]);
    expect(JSON.parse(list)).toMatchObject({
      taskId: "task-cli",
      taskRevision: 0,
      annotations: [{ annotationId: "ann-1", status: "open" }],
    });
    expect(JSON.parse(run(root, ["validate-task", "--json"]))).toMatchObject({ ok: true, taskId: "task-cli" });
    const text = run(root, ["validate-task"]);
    expect(text).not.toMatch(/^\{/);
    expect(text).toContain("is valid");
  });

  it("reports exact source revision and waits for a referenced-source change", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-cli-wait-"));
    roots.push(root);
    mkdirSync(path.join(root, "tasks"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "src", "other"), { recursive: true });
    writeFileSync(path.join(root, "src", "settings.tsx"), "export const A = 1;\n");
    const task = createAgentAnnotationsTask({
      taskId: "task-rev",
      createdAt: "2026-08-12T12:00:00.000Z",
      annotations: [annotationFixture({
        targets: [targetFixture({
          inspection: {
            ...targetFixture().inspection,
            source: { filePath: "src/settings.tsx", lineNumber: 1, columnNumber: 14, componentName: "A" },
            sourceStack: [],
          },
        })],
      })],
    });
    writeFileSync(path.join(root, "tasks/active-task.json"), JSON.stringify(task));
    const sourcePaths = createSourcePathService(root);
    const expected = sourcePaths.revision(task)!;
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(run(root, ["revision", "--json"]))).toEqual({
      taskRevision: 0,
      referencedSourceRevision: expected,
      referencedSourceFiles: ["src/settings.tsx"],
    });
    const text = run(root, ["revision"]);
    expect(text).toContain("taskRevision 0");
    expect(text).toContain(`referencedSourceRevision ${expected}`);
    expect(text).toContain("referencedSourceFiles: src/settings.tsx");
    expect(text).not.toMatch(/^\{/);
    // Human and JSON wait output share the same facts.
    expect(run(root, ["wait", "--referenced-source-revision", expected, "--timeout-ms", "0"]))
      .toBe(`changed: false, referencedSourceRevision: ${expected}\n`);
    expect(JSON.parse(run(root, ["wait", "--referenced-source-revision", expected, "--timeout-ms", "0", "--json"])))
      .toEqual({ changed: false, referencedSourceRevision: expected });
    // Unrelated and duplicate-basename files never move the revision.
    writeFileSync(path.join(root, "src", "unrelated.tsx"), "export const B = 1;\n");
    writeFileSync(path.join(root, "src", "other", "settings.tsx"), "export const C = 1;\n");
    expect(JSON.parse(run(root, ["revision", "--json"])).referencedSourceRevision).toBe(expected);
    expect(JSON.parse(run(root, ["wait", "--referenced-source-revision", expected, "--timeout-ms", "0", "--json"])))
      .toEqual({ changed: false, referencedSourceRevision: expected });
    // A delayed change to the referenced source flips the wait to changed: true.
    const child = spawn(process.execPath, [script, "wait", "--referenced-source-revision", expected, "--timeout-ms", "10000", "--json"], {
      cwd: root,
      env: cleanEnv({ AGENT_ANNOTATIONS_DIR: root }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = new Promise<string>((resolve) => {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => { buffer += String(chunk); });
      child.on("close", () => resolve(buffer));
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    writeFileSync(path.join(root, "src", "settings.tsx"), "export const A = 2;\n");
    const waited = JSON.parse(await output);
    expect(waited).toMatchObject({ changed: true });
    expect(waited.referencedSourceRevision).not.toBe(expected);
    expect(waited.referencedSourceRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid revision wait arguments with exit code 2", () => {
    const root = fixture();
    const missing = runExpectingFailure(root, ["wait"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("--referenced-source-revision");
    const badSha = runExpectingFailure(root, ["wait", "--referenced-source-revision", "short"]);
    expect(badSha.status).toBe(2);
    expect(badSha.stderr).toContain("64-character hex");
    const badTimeout = runExpectingFailure(root, ["wait", "--referenced-source-revision", "0".repeat(64), "--timeout-ms", "99999"]);
    expect(badTimeout.status).toBe(2);
    expect(badTimeout.stderr).toContain("between 0 and 30000");
    const badRange = runExpectingFailure(root, ["wait", "--referenced-source-revision", "0".repeat(64), "--timeout-ms", "-1"]);
    expect(badRange.status).toBe(2);
    expect(runExpectingFailure(root, ["wait", "--browser-update-revision", "1"]).status).toBe(2);
    expect(runExpectingFailure(root, ["wait", "--source-revision", "0".repeat(64)]).status).toBe(2);
    expect(runExpectingFailure(root, ["wait", "--browser-source-revision", "0".repeat(64)]).status).toBe(2);
    const unknown = runExpectingFailure(root, ["revision", "--bogus"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown option");
  });

  it("rejects duplicate global options, missing values, and unknown flags with exit code 2", () => {
    const root = fixture();
    const duplicateRoot = runExpectingFailure(root, ["--root", root, "--root", root, "list"]);
    expect(duplicateRoot.status).toBe(2);
    expect(duplicateRoot.stderr).toContain("duplicate --root");
    const duplicateDir = runExpectingFailure(root, ["--dir", root, "--dir", root, "list"]);
    expect(duplicateDir.status).toBe(2);
    expect(duplicateDir.stderr).toContain("duplicate --dir");
    const missingValue = runExpectingFailure(root, ["revision", "--root"]);
    expect(missingValue.status).toBe(2);
    expect(missingValue.stderr).toContain("--root requires a value");
    const unknownFlag = runExpectingFailure(root, ["--bogus", "list"]);
    expect(unknownFlag.status).toBe(2);
    expect(unknownFlag.stderr).toContain("unknown option: --bogus");
  });

  it("reports explicit nonexistent paths as stable errors", () => {
    const root = fixture();
    const missingRoot = runExpectingFailure(root, ["--root", path.join(root, "missing"), "revision"]);
    expect(missingRoot.status).toBe(2);
    expect(missingRoot.stderr).toContain("workspace root does not exist");
    const missingDir = runExpectingFailure(root, ["--dir", path.join(root, "missing"), "list"]);
    expect(missingDir.status).toBe(2);
    expect(missingDir.stderr).toContain("runtime root does not exist");
  });

  it("canonicalizes a symlinked workspace/runtime root", () => {
    const original = fixture();
    mkdirSync(path.join(original, "tasks"), { recursive: true });
    const link = path.join(path.dirname(original), `agent-annotations-cli-link-${path.basename(original)}`);
    try {
      symlinkSync(original, link, "dir");
      expect(JSON.parse(run(link, ["list", "--json"]))).toMatchObject({ taskId: "task-cli" });
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });

  it("resolves workspace and runtime roots from a session in an ancestor directory (monorepo subdirectory)", () => {
    const { workspace, src, task } = sessionFixture();
    // Deep, real subdirectory; no flags and no environment variables.
    const output = runWith(src, ["revision", "--json"], cleanEnv());
    expect(JSON.parse(output)).toEqual({
      taskRevision: 0,
      referencedSourceRevision: createSourcePathService(workspace).revision(task),
      referencedSourceFiles: ["packages/app/src/settings.tsx"],
    });
    expect(JSON.parse(runWith(src, ["validate-task", "--json"], cleanEnv()))).toMatchObject({ ok: true, taskId: "task-mono" });
  });

  it("--root overrides the session workspace root before or after the command", () => {
    const fixture = sessionFixture();
    const { app, src } = fixture;
    const nested = nestedAppFixture(fixture);
    const anchored = {
      taskRevision: 0,
      referencedSourceRevision: createSourcePathService(app).revision(nested.task),
      referencedSourceFiles: ["src/settings.tsx"],
    };
    expect(JSON.parse(runWith(src, ["--root", app, "revision", "--json"], cleanEnv()))).toEqual(anchored);
    expect(JSON.parse(runWith(src, ["revision", "--json", "--root", app], cleanEnv()))).toEqual(anchored);
  });

  it("--dir and AGENT_ANNOTATIONS_DIR select a custom runtime root while the session still anchors the workspace", () => {
    const { parent, workspace, src, task, writeSession } = sessionFixture();
    const outside = path.join(parent, "outside-runtime");
    mkdirSync(path.join(outside, "tasks"), { recursive: true });
    writeFileSync(path.join(outside, "tasks/active-task.json"), readFileSync(path.join(workspace, ".agent-annotations", "tasks/active-task.json")));
    writeSession(outside, workspace, outside);
    const expected = {
      taskRevision: 0,
      referencedSourceRevision: createSourcePathService(workspace).revision(task),
      referencedSourceFiles: ["packages/app/src/settings.tsx"],
    };
    expect(JSON.parse(runWith(src, ["--dir", outside, "revision", "--json"], cleanEnv()))).toEqual(expected);
    expect(JSON.parse(runWith(src, ["revision", "--json"], cleanEnv({ AGENT_ANNOTATIONS_DIR: outside })))).toEqual(expected);
  });

  it("AGENT_ANNOTATIONS_ROOT overrides the session and --root beats the environment", () => {
    const fixture = sessionFixture();
    const { app, workspace, src } = fixture;
    const nested = nestedAppFixture(fixture);
    expect(JSON.parse(runWith(src, ["revision", "--json"], cleanEnv({ AGENT_ANNOTATIONS_ROOT: app })))).toEqual({
      taskRevision: 0,
      referencedSourceRevision: createSourcePathService(app).revision(nested.task),
      referencedSourceFiles: ["src/settings.tsx"],
    });
    // --root beats the environment: the flag re-anchors the same task at the
    // monorepo root, where the app-relative source path does not resolve.
    expect(JSON.parse(runWith(src, ["revision", "--json", "--root", workspace], cleanEnv({ AGENT_ANNOTATIONS_ROOT: app }))).referencedSourceFiles)
      .toEqual([]);
  });

  it("falls back to the nearest ancestor package.json when no session exists", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-annotations-cli-fallback-"));
    roots.push(parent);
    const pkg = path.join(parent, "pkg");
    const deep = path.join(pkg, "src", "deep");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pkg" }));
    writeFileSync(path.join(pkg, "src", "settings.tsx"), "export const A = 1;\n");
    mkdirSync(path.join(pkg, ".agent-annotations", "tasks"), { recursive: true });
    const task = createAgentAnnotationsTask({
      taskId: "task-pkg",
      createdAt: "2026-08-12T12:00:00.000Z",
      annotations: [annotationFixture({
        targets: [targetFixture({
          inspection: {
            ...targetFixture().inspection,
            source: { filePath: "src/settings.tsx", lineNumber: 1, columnNumber: 20, componentName: "A" },
            sourceStack: [],
          },
        })],
      })],
    });
    writeFileSync(path.join(pkg, ".agent-annotations", "tasks/active-task.json"), JSON.stringify(task));
    expect(JSON.parse(runWith(deep, ["revision", "--json"], cleanEnv()))).toEqual({
      taskRevision: 0,
      referencedSourceRevision: createSourcePathService(pkg).revision(task),
      referencedSourceFiles: ["src/settings.tsx"],
    });
  });

  it("returns an explicit unavailable referenced-source wait result", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-cli-source-null-"));
    roots.push(root);
    mkdirSync(path.join(root, "tasks"), { recursive: true });
    const task = createAgentAnnotationsTask({ taskId: "task-source-null", createdAt: "2026-08-12T12:00:00.000Z" });
    writeFileSync(path.join(root, "tasks/active-task.json"), JSON.stringify(task));
    const baseline = "0".repeat(64);
    expect(JSON.parse(run(root, ["wait", "--referenced-source-revision", baseline, "--timeout-ms", "10000", "--json"])))
      .toEqual({ changed: false, referencedSourceRevision: null });
    expect(run(root, ["wait", "--referenced-source-revision", baseline, "--timeout-ms", "0"]))
      .toBe("changed: false, referencedSourceRevision: unavailable\n");
  });

  it("rejects a session whose runtime root escapes the workspace root unless --dir is explicit", () => {
    const { parent, workspace, src, runtime, writeSession } = sessionFixture();
    const outside = path.join(parent, "escaped-runtime");
    mkdirSync(path.join(outside, "tasks"), { recursive: true });
    const escaped = createAgentAnnotationsTask({
      taskId: "task-escaped",
      createdAt: "2026-08-12T12:00:00.000Z",
      annotations: [],
    });
    writeFileSync(path.join(outside, "tasks/active-task.json"), JSON.stringify(escaped));
    writeSession(runtime, workspace, outside);
    // Without --dir the escaping session is rejected: the task under the
    // workspace runtime is used, not the escaped one.
    expect(JSON.parse(runWith(src, ["validate-task", "--json"], cleanEnv()))).toMatchObject({ ok: true, taskId: "task-mono" });
    // With explicit --dir the user's runtime wins.
    expect(JSON.parse(runWith(src, ["--dir", outside, "validate-task", "--json"], cleanEnv()))).toMatchObject({ ok: true, taskId: "task-escaped" });
  });
});
