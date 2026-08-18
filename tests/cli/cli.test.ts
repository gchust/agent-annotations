import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentAnnotationsTask } from "../../src/core/index.js";
import { annotationFixture } from "../core/test-data.js";

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

const run = (root: string, args: string[]) => execFileSync(process.execPath, [script, ...args], {
  encoding: "utf8",
  env: { ...process.env, AGENT_ANNOTATIONS_DIR: root },
});

const runExpectingFailure = (root: string, args: string[]): { status: number; stdout: string; stderr: string } => {
  try {
    execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, AGENT_ANNOTATIONS_DIR: root },
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
  throw new Error(`expected ${args.join(" ")} to fail`);
};

describe("public CLI processes", () => {
  it("shows help from the built public binary", () => {
    const help = run(fixture(), ["--help"]);
    expect(help).toContain("Usage: agent-annotations");
    expect(help).not.toContain("mcp");
  });

  it("runs every command help plus list, complete, reopen, print, and verify", () => {
    const root = fixture();
    for (const command of ["list", "complete", "reopen", "print", "verify", "audit"]) {
      expect(run(root, [command, "--help"])).toContain("Agent Annotations");
    }
    expect(run(root, ["list"])).toContain("ann-1");
    expect(run(root, ["complete", "ann-1", "--verified", "--summary", "browser checked"])).toContain("taskRevision 1");
    expect(run(root, ["reopen", "ann-1"])).toContain("taskRevision 2");
    expect(JSON.parse(run(root, ["print", "--json"]))).toMatchObject({ schema: "agent-annotations.task.v1", taskRevision: 2 });
    expect(run(root, ["print", "--markdown"])).toContain("# Agent Annotations Task task-cli");
    expect(JSON.parse(run(root, ["verify"]))).toMatchObject({ ok: true, taskId: "task-cli", taskRevision: 2 });
  });

  it("rejects mcp as an unknown command with exit code 2", () => {
    const result = runExpectingFailure(fixture(), ["mcp"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command: mcp");
  });
});
