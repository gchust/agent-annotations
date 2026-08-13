#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  formatAgentFeedbackTask,
  parseAgentFeedbackTask,
} from "../core/index.js";
import { FileTaskStore } from "../server/store.js";
import { createSourcePathService } from "../server/source-path.js";
import type { AgentFeedbackMutationOperation, AgentFeedbackTask } from "../types/index.js";

const HELP = `Agent Feedback 0.1.0-alpha.0

Usage: agent-feedback <command> [options]

Commands:
  list
  complete <annotation-id> --verified --summary <text>
  reopen <annotation-id>
  print [--json|--markdown]
  verify
  mcp
  audit
`;

const runtimeRoot = (): string => path.resolve(
  process.env.AGENT_FEEDBACK_DIR ?? path.join(process.cwd(), ".agent-feedback")
);

const fail = (message: string, code = 1): never => {
  process.stderr.write(`[agent-feedback] ${message}\n`);
  process.exitCode = code;
  throw new Error("__handled__");
};

const task = (): AgentFeedbackTask => {
  const found = new FileTaskStore(runtimeRoot()).read();
  if (!found) return fail(`no task found at ${path.join(runtimeRoot(), "tasks", "active-task.json")}`);
  return found;
};

const readMcpTask = (): AgentFeedbackTask => {
  const found = new FileTaskStore(runtimeRoot()).read();
  if (!found) throw new Error(`no task found at ${path.join(runtimeRoot(), "tasks", "active-task.json")}`);
  return found;
};

const sourceRevision = (current: AgentFeedbackTask): string =>
  createSourcePathService(process.cwd()).revision(current);

const readDiagnostics = (): unknown => {
  try {
    return JSON.parse(readFileSync(path.join(runtimeRoot(), "diagnostics.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const screenshots = (): string[] => {
  const directory = path.join(runtimeRoot(), "evidence");
  try {
    return readdirSync(directory).filter((file) => file.endsWith(".png")).sort().map((file) => `evidence/${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const parseMutationArgs = (command: "complete" | "reopen", args: string[]): {
  annotationId: string;
  operation: AgentFeedbackMutationOperation;
} => {
  const annotationId = args.shift();
  if (!annotationId) return fail(`${command} requires an annotation id`, 2);
  if (command === "reopen") {
    if (args.length) return fail("reopen accepts exactly one annotation id", 2);
    return { annotationId, operation: { op: "reopen", annotationId } };
  }
  let verified = false;
  let summary = "";
  while (args.length) {
    const option = args.shift();
    if (option === "--verified") verified = true;
    else if (option === "--summary") summary = args.shift() ?? "";
    else return fail(`unknown option: ${option}`, 2);
  }
  if (!verified) fail("complete requires --verified", 2);
  if (!summary.trim()) fail("complete requires a non-empty --summary", 2);
  if (summary.length > 2_000) fail("--summary must be at most 2000 characters", 2);
  return {
    annotationId,
    operation: {
      op: "complete",
      annotationId,
      evidence: { verified: true, summary, source: "cli" },
    },
  };
};

const mutate = async (command: "complete" | "reopen", args: string[]): Promise<void> => {
  const current = task();
  const { annotationId, operation } = parseMutationArgs(command, args);
  if (!current.annotations.some((annotation) => annotation.annotationId === annotationId)) {
    fail(`annotation "${annotationId}" not found`);
  }
  const next = await new FileTaskStore(runtimeRoot()).mutate({
    taskId: current.taskId,
    expectedRevision: current.taskRevision,
    operations: [operation],
  });
  process.stdout.write(`${command === "complete" ? "completed" : "reopened"} ${annotationId} (taskRevision ${next.taskRevision})\n`);
};

const TOOLS = [
  {
    name: "list_annotations",
    description: "Read the active Agent Feedback task and list its annotations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "print_task",
    description: "Read the active Agent Feedback task as schema v1 JSON.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "verify_task",
    description: "Read and validate the active agent-feedback.task.v1 task without changing it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_diagnostics",
    description: "Read the persisted Agent Feedback runtime diagnostics without changing state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_screenshots",
    description: "List persisted PNG screenshot evidence references without changing state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait_verification",
    description: "Boundedly wait until the exact source revision for the active agent-feedback.task.v1 differs from a caller-provided revision.",
    inputSchema: {
      type: "object",
      properties: { sourceRevision: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["sourceRevision"],
    },
  },
] as const;

const mcp = async (): Promise<void> => {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        request = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        continue;
      }
      if (request.id === undefined) continue;
      try {
        let result: unknown;
        if (request.method === "initialize") {
          result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-feedback", version: "0.1.0-alpha.0" } };
        } else if (request.method === "tools/list") {
          result = { tools: TOOLS };
        } else if (request.method === "tools/call") {
          const name = request.params?.name;
          const args = request.params?.arguments ?? {};
          let text: string;
          if (name === "read_diagnostics") text = JSON.stringify(readDiagnostics(), null, 2);
          else if (name === "list_screenshots") text = JSON.stringify(screenshots(), null, 2);
          else if (name === "wait_verification") {
            const baseline = args.sourceRevision;
            const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 10_000), 0), 30_000);
            if (typeof baseline !== "string" || !/^[a-f\d]{64}$/.test(baseline) || !Number.isFinite(timeoutMs)) {
              throw new Error("wait_verification requires a SHA-256 sourceRevision and optional finite timeoutMs");
            }
            const deadline = Date.now() + timeoutMs;
            let current = readMcpTask();
            let revision = sourceRevision(current);
            while (revision === baseline && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              current = readMcpTask();
              revision = sourceRevision(current);
            }
            text = JSON.stringify({ changed: revision !== baseline, sourceRevision: revision });
          } else {
            const current = readMcpTask();
            text = name === "list_annotations"
              ? current.annotations.map((annotation) => `${annotation.annotationId}: ${annotation.comment}`).join("\n") || "No annotations."
              : name === "print_task" || name === "verify_task"
                ? JSON.stringify(current, null, 2)
                : (() => { throw new Error(`unknown tool: ${name}`); })();
          }
          result = { content: [{ type: "text", text }], isError: false };
        } else {
          throw new Error(`unsupported method: ${request.method}`);
        }
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: (error as Error).message }], isError: true } })}\n`);
      }
    }
  }
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "list") {
    for (const [index, annotation] of task().annotations.entries()) {
      process.stdout.write(`${index + 1}. [${annotation.status}] ${annotation.annotationId}: ${annotation.comment}\n`);
    }
    return;
  }
  if (command === "complete" || command === "reopen") return mutate(command, args);
  if (command === "print") {
    const format = args[0] === "--markdown" ? "markdown" : args[0] === "--json" || !args.length ? "json" : fail(`unknown option: ${args[0]}`, 2);
    process.stdout.write(`${formatAgentFeedbackTask(task(), { format, annotations: "all" })}\n`);
    return;
  }
  if (command === "verify") {
    const verified = parseAgentFeedbackTask(JSON.parse(readFileSync(path.join(runtimeRoot(), "tasks", "active-task.json"), "utf8")));
    process.stdout.write(`${JSON.stringify({ ok: true, taskId: verified.taskId, taskRevision: verified.taskRevision })}\n`);
    return;
  }
  if (command === "mcp") return mcp();
  if (command === "audit") {
    const { runArchitectureAudit } = await import("../audit/index.js");
    const result = runArchitectureAudit(process.cwd());
    if (!result.ok) fail(`architecture audit failed: ${result.problems.map(({ check, file, line }) => `${check}:${file}:${line}`).join(", ")}`);
    process.stdout.write("[agent-feedback] architecture audit PASS\n");
    return;
  }
  fail(`unknown command: ${command}`, 2);
};

main().catch((error) => {
  if ((error as Error).message !== "__handled__") {
    process.stderr.write(`[agent-feedback] ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
});
