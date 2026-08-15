import type {
  AgentAnnotation,
  AgentAnnotationsFormatOptions,
  AgentAnnotationsSourceLocation,
  AgentAnnotationsTarget,
  AgentAnnotationsTask,
} from "../types/index.js";
import { parseAgentAnnotationsTask } from "./schema.js";
import {
  agentAnnotationsAnnotationDisplayNumber,
  selectAgentAnnotations,
} from "./selectors.js";

const formatSource = (source: AgentAnnotationsSourceLocation): string =>
  `${source.filePath}:${source.lineNumber}:${source.columnNumber}${
    source.componentName ? ` (${source.componentName})` : ""
  }`;

const formatTarget = (
  target: AgentAnnotationsTarget,
  index: number,
  targetCount: number
): string[] => {
  const inspection = target.inspection;
  const lines = [
    `${targetCount > 1 ? `#### Target ${index + 1}` : "#### Target"}`,
    "",
    `- selector: ${target.selector}`,
    `- bounds: ${target.bounds.x},${target.bounds.y} ${target.bounds.width}x${target.bounds.height}`,
    `- element: <${inspection.tagName}>`,
    `- component: ${inspection.componentName ?? "(unresolved)"}`,
    `- source: ${inspection.source ? formatSource(inspection.source) : "(unresolved)"}`,
  ];
  if (inspection.sourceStack.length) {
    lines.push("- source stack:");
    lines.push(...inspection.sourceStack.map((source) => `  - ${formatSource(source)}`));
  }
  return lines;
};

const formatAnnotation = (
  task: AgentAnnotationsTask,
  annotation: AgentAnnotation
): string[] => {
  const displayNumber =
    agentAnnotationsAnnotationDisplayNumber(task.annotations, annotation.annotationId) ??
    1;
  const lines = [
    `### Annotation ${displayNumber}: [${annotation.kind}] ${annotation.annotationId}`,
    "",
    `Comment: ${annotation.comment || "(empty)"}`,
    "",
    `- status: ${annotation.status}${
      annotation.completedAt ? ` @ ${annotation.completedAt}` : ""
    }`,
    `- page: ${annotation.pageContext.routeKey} (${annotation.pageContext.title})`,
  ];
  if (annotation.region) {
    lines.push(
      `- region: ${annotation.region.x},${annotation.region.y} ${annotation.region.width}x${annotation.region.height}`
    );
  }
  if (annotation.targets) {
    annotation.targets.forEach((target, index) => {
      lines.push("", ...formatTarget(target, index, annotation.targets?.length ?? 0));
    });
  }
  const extensionIds = Object.keys(annotation.extensions).sort();
  if (extensionIds.length) {
    lines.push("", "#### Extension context", "");
    for (const extensionId of extensionIds) {
      lines.push(
        `- ${extensionId}: ${JSON.stringify(annotation.extensions[extensionId])}`
      );
    }
  }
  return [...lines, ""];
};

export function formatAgentAnnotationsTaskMarkdown(
  input: unknown,
  options: Omit<AgentAnnotationsFormatOptions, "format"> = {}
): string {
  const task = parseAgentAnnotationsTask(input);
  const annotations = selectAgentAnnotations(
    task.annotations,
    options.annotations ?? "open"
  );
  const lines = [
    `# Agent Annotations Task ${task.taskId}`,
    "",
    `- schema: ${task.schema}`,
    `- schemaVersion: ${task.schemaVersion}`,
    `- revision: ${task.taskRevision}`,
    `- status: ${task.status}`,
    `- createdAt: ${task.createdAt}`,
    `- updatedAt: ${task.updatedAt}`,
    "",
    `## Annotations (${annotations.length})`,
    "",
  ];
  for (const annotation of annotations) {
    lines.push(...formatAnnotation(task, annotation));
  }
  return lines.join("\n");
}

export function formatAgentAnnotationsTaskJson(input: unknown): string {
  return JSON.stringify(parseAgentAnnotationsTask(input), null, 2);
}

export function formatAgentAnnotationsTask(
  input: unknown,
  options: AgentAnnotationsFormatOptions = {}
): string {
  return options.format === "json"
    ? formatAgentAnnotationsTaskJson(input)
    : formatAgentAnnotationsTaskMarkdown(input, options);
}
