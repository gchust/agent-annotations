#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  formatAgentAnnotationsTask,
  parseAgentAnnotationsTask,
} from "../core/index.js";
import { clearDiagnostics, readDiagnostics } from "../server/diagnostics.js";
import { listEvidence } from "../server/evidence.js";
import { createSourcePathService } from "../server/source-path.js";
import { FileTaskStore } from "../server/store.js";
import { PACKAGE_VERSION } from "../metadata.js";
import { parseCliArguments } from "./arguments.js";
import { resolveCliPaths } from "./paths.js";
import type { AgentAnnotationsMutationOperation, AgentAnnotationsTask } from "../types/index.js";

const HELP = `Agent Annotations ${PACKAGE_VERSION}

Usage: agent-annotations [--root <path>] [--dir <path>] <command> [options]

Global options:
  --root <path>  Workspace root (also AGENT_ANNOTATIONS_ROOT)
  --dir <path>   Runtime data directory (also AGENT_ANNOTATIONS_DIR)

Commands:
  list [--json]
  complete <annotation-id> --verified --summary <text>
  reopen <annotation-id>
  print [--json|--markdown]
  validate-task [--json]
  revision [--json]
  wait --source-revision <sha256> [--timeout-ms <n>] [--json]
  diagnostics [--json|--clear]
  evidence [--json]
`;

const KNOWN_COMMANDS = new Set([
  "list",
  "complete",
  "reopen",
  "print",
  "validate-task",
  "revision",
  "wait",
  "diagnostics",
  "evidence",
]);

const fail = (message: string, code = 1): never => {
  process.stderr.write(`[agent-annotations] ${message}\n`);
  process.exitCode = code;
  throw new Error("__handled__");
};

const taskPath = (runtimeRoot: string): string =>
  path.join(runtimeRoot, "tasks", "active-task.json");

const task = (runtimeRoot: string): AgentAnnotationsTask => {
  const found = new FileTaskStore(runtimeRoot).read();
  if (!found) return fail(`no task found at ${taskPath(runtimeRoot)}`);
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

const mutate = async (command: "complete" | "reopen", args: string[], runtimeRoot: string): Promise<void> => {
  const current = task(runtimeRoot);
  const { annotationId, operation } = parseMutationArgs(command, args);
  if (!current.annotations.some((annotation) => annotation.annotationId === annotationId)) {
    fail(`annotation "${annotationId}" not found`);
  }
  const next = await new FileTaskStore(runtimeRoot).mutate({
    taskId: current.taskId,
    expectedRevision: current.taskRevision,
    operations: [operation],
  });
  process.stdout.write(`${command === "complete" ? "completed" : "reopened"} ${annotationId} (taskRevision ${next.taskRevision})\n`);
};

const main = async (): Promise<void> => {
  const parsed = parseCliArguments(process.argv.slice(2));
  if ("error" in parsed) return fail(parsed.error, 2);
  const { command, args, root, dir } = parsed;
  if (command === null || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (!KNOWN_COMMANDS.has(command)) return fail(`unknown command: ${command}`, 2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const resolution = resolveCliPaths({ cwd: process.cwd(), root, dir, env: process.env });
  if (!resolution.ok) return fail(resolution.message, resolution.code);
  const { workspaceRoot, runtimeRoot } = resolution;

  if (command === "list") {
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length) return fail(`unknown option: ${unknown[0]}`, 2);
    const json = args.includes("--json");
    const current = task(runtimeRoot);
    if (json) {
      process.stdout.write(`${JSON.stringify({
        taskId: current.taskId,
        taskRevision: current.taskRevision,
        annotations: current.annotations,
      })}\n`);
      return;
    }
    for (const [index, annotation] of current.annotations.entries()) {
      process.stdout.write(`${index + 1}. [${annotation.status}] ${annotation.annotationId}: ${annotation.comment}\n`);
    }
    return;
  }
  if (command === "complete" || command === "reopen") return mutate(command, args, runtimeRoot);
  if (command === "print") {
    const format = args[0] === "--markdown" ? "markdown" : args[0] === "--json" || !args.length ? "json" : fail(`unknown option: ${args[0]}`, 2);
    process.stdout.write(`${formatAgentAnnotationsTask(task(runtimeRoot), { format, annotations: "all" })}\n`);
    return;
  }
  if (command === "validate-task") {
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length) return fail(`unknown option: ${unknown[0]}`, 2);
    const json = args.includes("--json");
    let raw: string;
    try {
      raw = readFileSync(taskPath(runtimeRoot), "utf8");
    } catch {
      return fail(`no task found at ${taskPath(runtimeRoot)}`);
    }
    let validated: AgentAnnotationsTask;
    try {
      validated = parseAgentAnnotationsTask(JSON.parse(raw));
    } catch (error) {
      return fail(`invalid task: ${(error as Error).message}`, 1);
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        taskId: validated.taskId,
        taskRevision: validated.taskRevision,
        schema: validated.schema,
      })}\n`);
      return;
    }
    process.stdout.write(
      `task ${validated.taskId} is valid (taskRevision ${validated.taskRevision}, schema ${validated.schema})\n`
    );
    return;
  }
  if (command === "revision") {
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length) return fail(`unknown option: ${unknown[0]}`, 2);
    const json = args.includes("--json");
    const current = new FileTaskStore(runtimeRoot).read();
    if (!current) return fail(`no task found at ${taskPath(runtimeRoot)}`);
    const sourcePaths = createSourcePathService(workspaceRoot);
    const revision = {
      taskRevision: current.taskRevision,
      sourceRevision: sourcePaths.revision(current),
      sourceFiles: sourcePaths.files(current),
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(revision)}\n`);
      return;
    }
    process.stdout.write(
      `taskRevision ${revision.taskRevision} sourceRevision ${revision.sourceRevision} sourceFiles: ${revision.sourceFiles.join(", ") || "(none)"}\n`
    );
    return;
  }
  if (command === "wait") {
    let target: string | null = null;
    let timeoutMs = 30_000;
    const json = args.includes("--json");
    const rest = args.filter((arg) => arg !== "--json");
    while (rest.length) {
      const option = rest.shift();
      if (option === "--source-revision") {
        if (target !== null) return fail("duplicate --source-revision", 2);
        target = rest.shift() ?? "";
      } else if (option === "--timeout-ms") {
        const value = rest.shift() ?? "";
        if (!/^\d+$/.test(value)) {
          return fail("--timeout-ms must be an integer between 0 and 30000", 2);
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 30_000) {
          return fail("--timeout-ms must be an integer between 0 and 30000", 2);
        }
        timeoutMs = parsed;
      } else {
        return fail(`unknown option: ${option}`, 2);
      }
    }
    if (target === null) return fail("wait requires --source-revision <sha256>", 2);
    if (!/^[0-9a-f]{64}$/i.test(target)) {
      return fail("--source-revision must be a 64-character hex sha256", 2);
    }
    const baseline = target.toLowerCase();
    const store = new FileTaskStore(runtimeRoot);
    const sourcePaths = createSourcePathService(workspaceRoot);
    const deadline = Date.now() + timeoutMs;
    let observed: string | null = null;
    while (true) {
      const current = store.read();
      observed = current ? sourcePaths.revision(current) : null;
      if (observed !== baseline) {
        if (json) process.stdout.write(`${JSON.stringify({ changed: true, sourceRevision: observed })}\n`);
        else process.stdout.write(`changed: true, sourceRevision: ${observed}\n`);
        return;
      }
      if (Date.now() >= deadline) {
        if (json) process.stdout.write(`${JSON.stringify({ changed: false, sourceRevision: observed })}\n`);
        else process.stdout.write(`changed: false, sourceRevision: ${observed}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (command === "diagnostics") {
    const json = args.includes("--json");
    const clear = args.includes("--clear");
    const unknown = args.filter((arg) => arg !== "--json" && arg !== "--clear");
    if (unknown.length) return fail(`unknown option: ${unknown[0]}`, 2);
    if (clear) {
      clearDiagnostics(runtimeRoot);
      if (json) process.stdout.write("[]\n");
      return;
    }
    const entries = readDiagnostics(runtimeRoot);
    if (json) {
      process.stdout.write(`${JSON.stringify(entries)}\n`);
    } else {
      for (const entry of entries) {
        process.stdout.write(`[${entry.source}] ${entry.timestamp} ${entry.message}\n`);
      }
    }
    return;
  }
  if (command === "evidence") {
    const json = args.includes("--json");
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length) return fail(`unknown option: ${unknown[0]}`, 2);
    const current = new FileTaskStore(runtimeRoot).read();
    const entries = current ? listEvidence(runtimeRoot, current) : [];
    if (json) {
      process.stdout.write(`${JSON.stringify(entries)}\n`);
    } else {
      for (const entry of entries) {
        process.stdout.write(`${entry.ref} (${entry.size} bytes) ${entry.annotationIds.join(",")}\n`);
      }
    }
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
