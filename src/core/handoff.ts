import { parseAgentAnnotationsTask } from "./schema.js";
import {
  agentAnnotationsAnnotationDisplayNumber,
  selectAgentAnnotations,
} from "./selectors.js";
import type {
  AgentAnnotation,
  AgentAnnotationsHandoffConfig,
  AgentAnnotationsTarget,
  AgentAnnotationsTask,
} from "../types/index.js";

export type AgentAnnotationsHandoffOptions = AgentAnnotationsHandoffConfig & {
  browserUpdateRevision?: number | null;
  referencedSourceRevision?: string | null;
  runtimeId?: string | null;
  routeKey?: string | null;
  generatedAt?: string | null;
};

export type NormalizedAgentAnnotationsHandoffConfig = {
  command: string;
  verificationCommands: string[];
  includeCompleted: boolean;
};

const DEFAULT_COMMAND = "agent-annotations";
const MAX_COMMAND = 512;
const MAX_VERIFICATION_COMMANDS = 10;
const MAX_VERIFICATION_ITEM = 512;
// Line-boundary controls: C0 (U+0000-U+001F), C1 (U+007F-U+009F), and the
// Unicode line/paragraph separators U+2028/U+2029. Non-global on purpose:
// safeEvidenceRef and the config validator call .test() on it, and a global
// regex would keep a stateful lastIndex.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Shared single-line sanitizer for untrusted displayed values: every
// line-boundary control becomes a space, so task-provided strings can never
// forge an extra instruction line. Its own global literal is only ever used
// with String.replace.
const singleLine = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
// Evidence refs are included only when they pass the same segment validation
// the server evidence boundary uses (first segment `evidence`, at least one
// file segment, no empty/dot/dot-dot/backslash segments) plus an explicit
// query/fragment exclusion; safe nested refs like evidence/subdir/file.png
// are allowed.
const safeEvidenceRef = (ref: string): boolean => {
  if (typeof ref !== "string") return false;
  // Control characters (C0/DEL) could forge extra handoff lines.
  if (CONTROL.test(ref) || ref.includes("?") || ref.includes("#")) return false;
  const segments = ref.split("/");
  if (segments[0] !== "evidence" || segments.length < 2) return false;
  return segments.slice(1).every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\")
  );
};

const knownKeys = new Set(["command", "verificationCommands", "includeCompleted"]);

const boundedText = (value: unknown, name: string, maxLength: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`handoff ${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (CONTROL.test(value)) {
    throw new TypeError(`handoff ${name} must not contain control characters`);
  }
  return value;
};

// Strict, JSON-safe handoff configuration boundary shared by the Vite plugin
// and mountAgentAnnotations. It only shapes output text; it never executes.
export const validateAgentAnnotationsHandoffConfig = (
  input: unknown
): NormalizedAgentAnnotationsHandoffConfig => {
  if (input === undefined || input === null) {
    return { command: DEFAULT_COMMAND, verificationCommands: [], includeCompleted: false };
  }
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new TypeError("handoff must be a plain object");
  }
  const candidate = input as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!knownKeys.has(key)) throw new TypeError(`unknown handoff option: ${key}`);
  }
  const command = candidate.command === undefined
    ? DEFAULT_COMMAND
    : boundedText(candidate.command, "command", MAX_COMMAND);
  let verificationCommands: string[] = [];
  if (candidate.verificationCommands !== undefined) {
    if (!Array.isArray(candidate.verificationCommands)) {
      throw new TypeError("handoff verificationCommands must be an array of strings");
    }
    if (candidate.verificationCommands.length > MAX_VERIFICATION_COMMANDS) {
      throw new TypeError(`handoff verificationCommands allows at most ${MAX_VERIFICATION_COMMANDS} items`);
    }
    verificationCommands = candidate.verificationCommands.map((item, index) =>
      boundedText(item, `verificationCommands[${index}]`, MAX_VERIFICATION_ITEM)
    );
  }
  if (
    candidate.includeCompleted !== undefined &&
    typeof candidate.includeCompleted !== "boolean"
  ) {
    throw new TypeError("handoff includeCompleted must be a boolean");
  }
  return {
    command,
    verificationCommands,
    includeCompleted: candidate.includeCompleted === true,
  };
};

const formatSource = (source: NonNullable<AgentAnnotationsTarget["inspection"]["source"]>): string =>
  `${singleLine(source.filePath)}:${source.lineNumber}:${source.columnNumber}${
    source.componentName ? ` (${singleLine(source.componentName)})` : ""
  }`;

// Plain filename placeholders stay runnable across shells without quoting.
const summaryFile = (annotationId: string): string => `agent-annotations-summary-${annotationId}.txt`;

const completionCommand = (command: string, annotationId: string): string =>
  `${command} complete ${annotationId} --verified --summary-file ${summaryFile(annotationId)}`;

const formatAnnotation = (
  task: AgentAnnotationsTask,
  command: string,
  annotation: AgentAnnotation
): string[] => {
  const displayNumber =
    agentAnnotationsAnnotationDisplayNumber(task.annotations, annotation.annotationId) ?? 1;
  const lines = [
    `### Annotation ${displayNumber}: [${annotation.kind}] ${annotation.annotationId}`,
    "",
    `Comment: ${singleLine(annotation.comment) || "(empty)"}`,
    "",
    `- route: ${singleLine(annotation.pageContext.routeKey)} (${singleLine(annotation.pageContext.title)})`,
  ];
  if (annotation.region) {
    lines.push(
      `- region: ${annotation.region.x},${annotation.region.y} ${annotation.region.width}x${annotation.region.height}`
    );
  }
  const targets = annotation.targets ?? [];
  if (targets.length > 0) {
    for (const [index, target] of targets.entries()) {
      const inspection = target.inspection;
      lines.push(
        `- selector: ${singleLine(target.selector)}`,
        `- bounds: ${target.bounds.x},${target.bounds.y} ${target.bounds.width}x${target.bounds.height}`,
        `- element: <${singleLine(inspection.tagName)}>`,
        `- source: ${inspection.source ? formatSource(inspection.source) : "(unresolved)"}`
      );
      if (inspection.sourceStack.length) {
        lines.push(...inspection.sourceStack.map((source) => `  - source stack: ${formatSource(source)}`));
      }
      if (targets.length > 1) {
        lines.push(`- target ${index + 1}/${targets.length}`);
      }
    }
  }
  if (annotation.evidence && annotation.evidence.length > 0) {
    const safe = annotation.evidence
      .map((entry) => entry.ref)
      .filter(safeEvidenceRef);
    lines.push(...safe.map((ref) => `- evidence: ${ref}`));
  }
  const extensionIds = Object.keys(annotation.extensions).sort();
  if (extensionIds.length > 0) {
    lines.push(
      ...extensionIds.flatMap((extensionId) => [
        `- extension ${extensionId}: ${JSON.stringify(annotation.extensions[extensionId])}`,
      ])
    );
  }
  lines.push(
    `- summary file: ${summaryFile(annotation.annotationId)}`,
    `- completion: ${completionCommand(command, annotation.annotationId)}`
  );
  return [...lines, ""];
};

// Pure default handoff formatter for source edits, project checks, task
// validation, and completion.
export function formatAgentAnnotationsHandoff(
  input: unknown,
  options: AgentAnnotationsHandoffOptions = {}
): string {
  const task = parseAgentAnnotationsTask(input);
  const config = validateAgentAnnotationsHandoffConfig({
    command: options.command,
    verificationCommands: options.verificationCommands,
    includeCompleted: options.includeCompleted,
  });
  const command = config.command;
  const annotations = selectAgentAnnotations(
    task.annotations,
    config.includeCompleted ? "all" : "open"
  );
  const lines = [
    `# Agent Annotations Handoff ${task.taskId}`,
    "",
    `- task revision: ${task.taskRevision}`,
    `- schema: ${task.schema}`,
    `- command: ${command}`,
    "",
    "## Instructions",
    "",
    "- Modify the real application source code; editing active-task.json is not a solution.",
    `- As soon as the relevant source is modified, write a UTF-8 implementation summary and run the exact ${command} complete command below.`,
    "- Run the project-relevant typecheck and tests.",
    ...config.verificationCommands.map((verification) => `  - Run: ${verification}`),
    `- Run ${command} validate-task --json to confirm the task file itself is valid.`,
    "",
    `## Annotations (${annotations.length})`,
    "",
  ];
  for (const annotation of annotations) {
    lines.push(...formatAnnotation(task, command, annotation));
  }
  return lines.join("\n");
}
