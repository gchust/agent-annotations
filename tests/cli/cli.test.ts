import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentFeedbackTask } from "../../src/core/index.js";
import { createSourcePathService } from "../../src/server/source-path.js";
import { annotationFixture, targetFixture } from "../core/test-data.js";

const script = path.resolve("dist/cli/index.mjs");
const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-feedback-cli-"));
  roots.push(root);
  mkdirSync(path.join(root, "tasks"), { recursive: true });
  const task = createAgentFeedbackTask({
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
  env: { ...process.env, AGENT_FEEDBACK_DIR: root },
});

const sourceFixture = () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "agent-feedback-cli-source-"));
  roots.push(workspace);
  const runtime = path.join(workspace, ".agent-feedback");
  const selected = path.join(workspace, "src/a/Card.tsx");
  const wrong = path.join(workspace, "src/b/Card.tsx");
  mkdirSync(path.dirname(selected), { recursive: true });
  mkdirSync(path.dirname(wrong), { recursive: true });
  mkdirSync(path.join(runtime, "tasks"), { recursive: true });
  writeFileSync(selected, "export const A = 1;\n");
  writeFileSync(wrong, "export const B = 1;\n");
  const task = createAgentFeedbackTask({
    taskId: "task-source",
    createdAt: "2026-08-12T12:00:00.000Z",
    annotations: [annotationFixture({
      targets: [targetFixture({
        inspection: {
          ...targetFixture().inspection,
          source: { filePath: "src/a/Card.tsx", lineNumber: 1, columnNumber: 14, componentName: "A" },
          sourceStack: [],
        },
      })],
    })],
  });
  writeFileSync(path.join(runtime, "tasks/active-task.json"), JSON.stringify(task));
  return { workspace, runtime, selected, wrong, task };
};

describe("public CLI processes", () => {
  it("shows help from the built public binary", () => {
    expect(run(fixture(), ["--help"])).toContain("Usage: agent-feedback");
  });

  it("runs every command help plus list, complete, reopen, print, and verify", () => {
    const root = fixture();
    for (const command of ["list", "complete", "reopen", "print", "verify", "mcp", "audit"]) {
      expect(run(root, [command, "--help"])).toContain("Agent Feedback");
    }
    expect(run(root, ["list"])).toContain("ann-1");
    expect(run(root, ["complete", "ann-1", "--verified", "--summary", "browser checked"])).toContain("taskRevision 1");
    expect(run(root, ["reopen", "ann-1"])).toContain("taskRevision 2");
    expect(JSON.parse(run(root, ["print", "--json"]))).toMatchObject({ schema: "agent-feedback.task.v1", taskRevision: 2 });
    expect(run(root, ["print", "--markdown"])).toContain("# Agent Feedback Task task-cli");
    expect(JSON.parse(run(root, ["verify"]))).toMatchObject({ ok: true, taskId: "task-cli", taskRevision: 2 });
  });

  it("offers read-only MCP initialize, tools/list, and task reads", async () => {
    const root = fixture();
    const child = spawn(process.execPath, [script, "mcp"], {
      env: { ...process.env, AGENT_FEEDBACK_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "print_task", arguments: {} } },
    ];
    const responses = await new Promise<any[]>((resolve, reject) => {
      const values: any[] = [];
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line) values.push(JSON.parse(line));
        if (values.length === requests.length) resolve(values);
      });
      child.on("error", reject);
      for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    });
    child.kill();
    expect(responses[0].result.serverInfo.name).toBe("agent-feedback");
    const tools = responses[1].result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_annotations",
      "print_task",
      "verify_task",
      "read_diagnostics",
      "list_screenshots",
      "wait_verification",
    ]);
    expect(JSON.stringify(tools)).not.toMatch(/capture_task|portal.studio|schema v[2-9]/i);
    expect(responses[2].result.content[0].text).toContain("agent-feedback.task.v1");

    const unknown = spawn(process.execPath, [script, "mcp"], {
      env: { ...process.env, AGENT_FEEDBACK_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const failed = await new Promise<any>((resolve) => {
      unknown.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk))));
      unknown.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "capture_task" } })}\n`);
    });
    unknown.kill();
    expect(failed.result).toMatchObject({ isError: true });
  });

  it("waits on the exact source revision in a real MCP process", async () => {
    const { workspace, runtime, selected, wrong, task } = sourceFixture();
    const baseline = createSourcePathService(workspace).revision(task);
    const child = spawn(process.execPath, [script, "mcp"], {
      cwd: workspace,
      env: { ...process.env, AGENT_FEEDBACK_DIR: runtime },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const response = new Promise<any>((resolve, reject) => {
      child.stdout.once("data", (chunk) => {
        settled = true;
        resolve(JSON.parse(String(chunk)));
      });
      child.once("error", reject);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wait_verification", arguments: { sourceRevision: baseline, timeoutMs: 2_000 } },
    })}\n`);
    writeFileSync(wrong, "export const B = 2;\n");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);
    writeFileSync(selected, "export const A = 2;\n");
    const result = await response;
    child.kill();
    const payload = JSON.parse(result.result.content[0].text);
    expect(payload).toEqual({
      changed: true,
      sourceRevision: createSourcePathService(workspace).revision(task),
    });
    expect(payload.sourceRevision).not.toBe(baseline);
    expect(payload).not.toHaveProperty("taskRevision");
  });
});
