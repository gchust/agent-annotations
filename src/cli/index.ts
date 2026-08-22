#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  formatAgentAnnotationsTask,
  parseAgentAnnotationsTask,
  redactAgentAnnotationsText,
} from "../core/index.js";
import {
  parseAgentAnnotationsRouteKey,
  parseAgentAnnotationsRuntimeId,
  readAgentAnnotationsBrowserStates,
  selectAgentAnnotationsBrowserState,
  type AgentAnnotationsBrowserStateSelector,
} from "../server/browser-state.js";
import { clearDiagnostics, readDiagnostics } from "../server/diagnostics.js";
import { listEvidence, pruneOrphanEvidence } from "../server/evidence.js";
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
  complete <annotation-id> --verified (--summary <text>|--summary-file <path>)
  reopen <annotation-id>
  print [--json|--markdown]
  validate-task [--json]
  status [--json] [--check] [--runtime <runtime-id>|--route <route-key>] [--annotation <id>] [--fail-on-diagnostics --diagnostics-since <ISO>]
  revision [--json]
  wait --browser-update-revision <integer> [--runtime <runtime-id>|--route <route-key>] [--timeout-ms <n>] [--json]
  wait --referenced-source-revision <sha256> [--timeout-ms <n>] [--json]
  diagnostics [--json|--clear]
  evidence [--json|--prune [--json]]
`;

const KNOWN_COMMANDS = new Set([
  "list",
  "complete",
  "reopen",
  "print",
  "validate-task",
  "status",
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

const parseBrowserSelector = (args: string[]): {
  selector: AgentAnnotationsBrowserStateSelector;
  rest: string[];
} => {
  let runtimeId: string | undefined;
  let routeKey: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option !== "--runtime" && option !== "--route") {
      rest.push(option);
      continue;
    }
    const value = args[++index];
    if (value === undefined) fail(`${option} requires a value`, 2);
    if (option === "--runtime") {
      if (runtimeId !== undefined) fail("duplicate --runtime", 2);
      try { runtimeId = parseAgentAnnotationsRuntimeId(value); }
      catch { fail("--runtime must be a valid runtime id", 2); }
    } else {
      if (routeKey !== undefined) fail("duplicate --route", 2);
      try { routeKey = parseAgentAnnotationsRouteKey(value); }
      catch { fail("--route must be a safe query-free route key", 2); }
    }
  }
  if (runtimeId !== undefined && routeKey !== undefined) {
    fail("--runtime and --route are mutually exclusive", 2);
  }
  return { selector: { runtimeId, routeKey }, rest };
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
  let summary: string | null = null;
  let summaryFile: string | null = null;
  while (args.length) {
    const option = args.shift();
    if (option === "--verified") verified = true;
    else if (option === "--summary") {
      if (summary !== null) fail("duplicate --summary", 2);
      summary = args.shift() ?? "";
    } else if (option === "--summary-file") {
      if (summaryFile !== null) fail("duplicate --summary-file", 2);
      summaryFile = args.shift() ?? "";
    }
    else return fail(`unknown option: ${option}`, 2);
  }
  if (!verified) fail("complete requires --verified", 2);
  if (summary !== null && summaryFile !== null) fail("--summary and --summary-file are mutually exclusive", 2);
  if (summaryFile !== null) {
    if (!summaryFile) fail("--summary-file requires a path", 2);
    let size = 0;
    try {
      size = statSync(summaryFile).size;
    } catch {
      fail("--summary-file must be a readable UTF-8 file", 2);
    }
    if (size > 8_000) fail("completion summary must be at most 2000 characters", 2);
    try {
      summary = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(summaryFile));
    } catch {
      fail("--summary-file must be a readable UTF-8 file", 2);
    }
  }
  const completionSummary = summary ?? fail("complete requires a non-empty summary", 2);
  if (!completionSummary.trim()) fail("complete requires a non-empty summary", 2);
  if (completionSummary.length > 2_000) fail("completion summary must be at most 2000 characters", 2);
  const redactedSummary = redactAgentAnnotationsText(completionSummary, { maxLength: Number.POSITIVE_INFINITY });
  return {
    annotationId,
    operation: {
      op: "complete",
      annotationId,
      evidence: {
        verified: true,
        summary: redactedSummary.length > 2_000
          ? `${redactedSummary.slice(0, 1_988)}…[truncated]`
          : redactedSummary,
        source: "cli",
      },
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
  const { workspaceRoot, runtimeRoot, session } = resolution;

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
  if (command === "status") {
    const { selector, rest } = parseBrowserSelector(args);
    let json = false;
    let check = false;
    let failOnDiagnostics = false;
    let annotationId: string | null = null;
    let diagnosticsSince: string | null = null;
    for (let index = 0; index < rest.length; index += 1) {
      const option = rest[index]!;
      if (option === "--json") json = true;
      else if (option === "--check") check = true;
      else if (option === "--fail-on-diagnostics") failOnDiagnostics = true;
      else if (option === "--annotation" || option === "--diagnostics-since") {
        const value = rest[++index];
        if (value === undefined) fail(`${option} requires a value`, 2);
        if (option === "--annotation") {
          if (annotationId !== null) fail("duplicate --annotation", 2);
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) fail("--annotation must be a valid annotation id", 2);
          annotationId = value;
        } else {
          if (diagnosticsSince !== null) fail("duplicate --diagnostics-since", 2);
          if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
            fail("--diagnostics-since must be an ISO-8601 timestamp", 2);
          }
          diagnosticsSince = value;
        }
      } else fail(`unknown option: ${option}`, 2);
    }
    if (failOnDiagnostics && diagnosticsSince === null) {
      fail("--fail-on-diagnostics requires --diagnostics-since", 2);
    }
    const store = new FileTaskStore(runtimeRoot);
    let current: AgentAnnotationsTask | null = null;
    try {
      current = store.read();
    } catch {
      current = null;
    }
    const taskValid = current !== null;
    const browserStates = readAgentAnnotationsBrowserStates(runtimeRoot);
    const selection = selectAgentAnnotationsBrowserState(browserStates, selector);
    const browser = selection.selected;
    const browserConnected = browser !== null;
    const sourcePaths = createSourcePathService(workspaceRoot);
    const referencedSourceRevision = current ? sourcePaths.revision(current) : null;
    const referencedSourceFiles = current ? sourcePaths.files(current) : [];
    const taskSynchronized =
      taskValid &&
      browserConnected &&
      browser.taskId === current!.taskId &&
      browser.taskRevision === current!.taskRevision;
    const referencedSourceSynchronized = referencedSourceRevision === null
      ? null
      : browserConnected && browser.referencedSourceRevision === referencedSourceRevision;
    const annotation = current?.annotations.find((entry) => entry.annotationId === annotationId) ?? null;
    const annotationRouteMatches = annotationId === null
      ? null
      : browserConnected && annotation !== null && annotation.pageContext.routeKey === browser.routeKey;
    const selectedAnnotationHealth = annotationId === null || !browser
      ? null
      : browser.annotationHealth.find((entry) => entry.annotationId === annotationId) ?? null;
    const annotationResolved = annotationId === null
      ? null
      : annotationRouteMatches === true && selectedAnnotationHealth !== null &&
        selectedAnnotationHealth.resolved === selectedAnnotationHealth.total;
    const diagnostics = await readDiagnostics(runtimeRoot);
    const diagnosticsAfterBaseline = diagnosticsSince === null
      ? []
      : diagnostics.filter((entry) => entry.timestamp > diagnosticsSince);
    const report = {
      taskValid,
      // The resolved, shape-validated session (canonical roots, token, pid).
      sessionPresent: session !== null,
      runtimeSelectionError: selection.error,
      selectedRuntimeId: browser?.runtimeId ?? null,
      runtimes: browserStates.map((state) => ({
        runtimeId: state.runtimeId,
        routeKey: state.routeKey,
        connected: selectAgentAnnotationsBrowserState([state]).selected !== null,
        taskId: state.taskId,
        taskRevision: state.taskRevision,
        browserUpdateRevision: state.browserUpdateRevision,
        lastHeartbeatAt: state.lastHeartbeatAt,
      })),
      browserConnected,
      taskSynchronized,
      referencedSourceSynchronized,
      taskId: current?.taskId ?? null,
      taskRevision: current?.taskRevision ?? null,
      browserTaskId: browser?.taskId ?? null,
      browserTaskRevision: browser?.taskRevision ?? null,
      browserUpdateRevision: browser?.browserUpdateRevision ?? null,
      referencedSourceRevision,
      referencedSourceFiles,
      browserReferencedSourceRevision: browser?.referencedSourceRevision ?? null,
      browserReferencedSourceFiles: browser?.referencedSourceFiles ?? [],
      routeKey: browser?.routeKey ?? null,
      lastHeartbeatAt: browser?.lastHeartbeatAt ?? null,
      selectedAnnotationId: annotationId,
      annotationFound: annotationId === null ? null : annotation !== null,
      annotationRouteKey: annotation?.pageContext.routeKey ?? null,
      annotationRouteMatches,
      annotationHealth: selectedAnnotationHealth,
      annotationResolved,
      diagnosticsSince,
      failOnDiagnostics,
      diagnosticCount: diagnostics.length,
      diagnosticsAfterBaseline: diagnosticsAfterBaseline.length,
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      for (const [key, value] of Object.entries(report)) {
        process.stdout.write(`${key}: ${String(value)}\n`);
      }
    }
    if (check && !(
      report.taskValid &&
      report.runtimeSelectionError === null &&
      report.browserConnected &&
      report.taskSynchronized &&
      report.referencedSourceSynchronized !== false &&
      report.annotationResolved !== false &&
      (!report.failOnDiagnostics || report.diagnosticsAfterBaseline === 0)
    )) {
      return fail("status check failed", 1);
    }
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
      referencedSourceRevision: sourcePaths.revision(current),
      referencedSourceFiles: sourcePaths.files(current),
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(revision)}\n`);
      return;
    }
    process.stdout.write(
      `taskRevision ${revision.taskRevision} referencedSourceRevision ${revision.referencedSourceRevision ?? "unavailable"} referencedSourceFiles: ${revision.referencedSourceFiles.join(", ") || "(none)"}\n`
    );
    return;
  }
  if (command === "wait") {
    let browserUpdateTarget: string | null = null;
    let referencedSourceTarget: string | null = null;
    let timeoutMs = 30_000;
    const selected = parseBrowserSelector(args);
    const selector = selected.selector;
    const json = selected.rest.includes("--json");
    const rest = selected.rest.filter((arg) => arg !== "--json");
    while (rest.length) {
      const option = rest.shift();
      if (option === "--browser-update-revision") {
        if (browserUpdateTarget !== null || referencedSourceTarget !== null) {
          return fail("wait accepts exactly one revision option", 2);
        }
        browserUpdateTarget = rest.shift() ?? "";
      } else if (option === "--referenced-source-revision") {
        if (browserUpdateTarget !== null || referencedSourceTarget !== null) {
          return fail("wait accepts exactly one revision option", 2);
        }
        referencedSourceTarget = rest.shift() ?? "";
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
    if (browserUpdateTarget === null && referencedSourceTarget === null) {
      return fail("wait requires --browser-update-revision <integer> or --referenced-source-revision <sha256>", 2);
    }
    let browserUpdateBaseline: number | null = null;
    let referencedSourceBaseline: string | null = null;
    if (browserUpdateTarget !== null) {
      if (!/^\d+$/.test(browserUpdateTarget)) {
        return fail("--browser-update-revision must be a non-negative safe integer", 2);
      }
      browserUpdateBaseline = Number(browserUpdateTarget);
      if (!Number.isSafeInteger(browserUpdateBaseline)) {
        return fail("--browser-update-revision must be a non-negative safe integer", 2);
      }
    } else {
      referencedSourceBaseline = referencedSourceTarget!.toLowerCase();
      if (!/^[0-9a-f]{64}$/i.test(referencedSourceBaseline)) {
        return fail("--referenced-source-revision must be a 64-character hex sha256", 2);
      }
    }
    const store = new FileTaskStore(runtimeRoot);
    const sourcePaths = createSourcePathService(workspaceRoot);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (browserUpdateBaseline !== null) {
        const selection = selectAgentAnnotationsBrowserState(
          readAgentAnnotationsBrowserStates(runtimeRoot),
          selector
        );
        if (selection.error !== null) return fail(selection.error, 1);
        const observed = selection.selected?.browserUpdateRevision ?? null;
        const changed = observed !== null && observed > browserUpdateBaseline;
        if (changed || Date.now() >= deadline) {
          const result = { changed, browserUpdateRevision: observed };
          process.stdout.write(json
            ? `${JSON.stringify(result)}\n`
            : `changed: ${changed}, browserUpdateRevision: ${observed}\n`);
          return;
        }
      } else {
        const current = store.read();
        const observed = current ? sourcePaths.revision(current) : null;
        const changed = observed !== null && observed !== referencedSourceBaseline;
        if (changed || observed === null || Date.now() >= deadline) {
          const result = { changed, referencedSourceRevision: observed };
          process.stdout.write(json
            ? `${JSON.stringify(result)}\n`
            : `changed: ${changed}, referencedSourceRevision: ${observed ?? "unavailable"}\n`);
          return;
        }
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
      await clearDiagnostics(runtimeRoot);
      if (json) process.stdout.write("[]\n");
      return;
    }
    const entries = await readDiagnostics(runtimeRoot);
    if (json) {
      process.stdout.write(`${JSON.stringify(entries)}\n`);
    } else {
      for (const entry of entries) {
        // Network entries render their server-validated structured fields
        // explicitly instead of relying on the caller-controlled message.
        const structured = entry.source === "network"
          ? ` ${entry.transport ?? ""} ${entry.method ?? ""} ${entry.url ?? ""}${entry.status !== undefined ? ` ${entry.status}` : ""}`
          : "";
        process.stdout.write(`[${entry.source}] ${entry.timestamp}${structured} ${entry.message}\n`);
      }
    }
    return;
  }
  if (command === "evidence") {
    const json = args.includes("--json");
    const prune = args.includes("--prune");
    const unknown = args.filter((arg) => arg !== "--json" && arg !== "--prune");
    if (unknown.length) return fail(`unknown option: ${unknown[0]}`, 2);
    const store = new FileTaskStore(runtimeRoot);
    const current = store.read();
    if (prune) {
      // Orphan sweep: delete only unreferenced regular files inside the
      // evidence directory (never symlinks, never referenced evidence, with
      // a grace period for files still awaiting their task mutation).
      const result = current ? pruneOrphanEvidence(runtimeRoot, current) : {
        deleted: [] as string[], skipped: [] as string[], errors: [] as string[],
      };
      if (json) {
        process.stdout.write(`${JSON.stringify({
          deleted: result.deleted.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          refs: { deleted: result.deleted, skipped: result.skipped, errors: result.errors },
        })}\n`);
      } else {
        process.stdout.write(
          `pruned ${result.deleted.length} orphan evidence file(s), ` +
          `skipped ${result.skipped.length}, errors ${result.errors.length}\n`
        );
        for (const ref of result.deleted) process.stdout.write(`${ref}\n`);
      }
      return;
    }
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
