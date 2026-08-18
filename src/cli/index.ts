#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  formatAgentAnnotationsTask,
  parseAgentAnnotationsTask,
} from "../core/index.js";
import { FileTaskStore } from "../server/store.js";
import type { AgentAnnotationsMutationOperation, AgentAnnotationsTask } from "../types/index.js";

const HELP = `Agent Annotations 0.1.0-alpha.0

Usage: agent-annotations <command> [options]

Commands:
  list
  complete <annotation-id> --verified --summary <text>
  reopen <annotation-id>
  print [--json|--markdown]
  verify
  audit
`;

const runtimeRoot = (): string => path.resolve(
  process.env.AGENT_ANNOTATIONS_DIR ?? path.join(process.cwd(), ".agent-annotations")
);

const fail = (message: string, code = 1): never => {
  process.stderr.write(`[agent-annotations] ${message}\n`);
  process.exitCode = code;
  throw new Error("__handled__");
};

const task = (): AgentAnnotationsTask => {
  const found = new FileTaskStore(runtimeRoot()).read();
  if (!found) return fail(`no task found at ${path.join(runtimeRoot(), "tasks", "active-task.json")}`);
  return found;
};

const parseMutationArgs = (command: "complete" | "reopen", args: string[]): {
  annotationId: string;
  operation: AgentAnnotationsMutationOperation;
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
    process.stdout.write(`${formatAgentAnnotationsTask(task(), { format, annotations: "all" })}\n`);
    return;
  }
  if (command === "verify") {
    const verified = parseAgentAnnotationsTask(JSON.parse(readFileSync(path.join(runtimeRoot(), "tasks", "active-task.json"), "utf8")));
    process.stdout.write(`${JSON.stringify({ ok: true, taskId: verified.taskId, taskRevision: verified.taskRevision })}\n`);
    return;
  }
  if (command === "audit") {
    const { runArchitectureAudit } = await import("../audit/index.js");
    const result = runArchitectureAudit(process.cwd());
    if (!result.ok) fail(`architecture audit failed: ${result.problems.map(({ check, file, line }) => `${check}:${file}:${line}`).join(", ")}`);
    process.stdout.write("[agent-annotations] architecture audit PASS\n");
    return;
  }
  fail(`unknown command: ${command}`, 2);
};

main().catch((error) => {
  if ((error as Error).message !== "__handled__") {
    process.stderr.write(`[agent-annotations] ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
});
