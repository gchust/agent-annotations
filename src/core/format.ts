import type {
  AgentFeedbackAnnotation,
  AgentFeedbackFormatOptions,
  AgentFeedbackSourceLocation,
  AgentFeedbackTarget,
  AgentFeedbackTask,
} from "../types/index.js";
import { parseAgentFeedbackTask } from "./schema.js";
import {
  agentFeedbackAnnotationDisplayNumber,
  selectAgentFeedbackAnnotations,
} from "./selectors.js";

const formatSource = (source: AgentFeedbackSourceLocation): string =>
  `${source.filePath}:${source.lineNumber}:${source.columnNumber}${
    source.componentName ? ` (${source.componentName})` : ""
  }`;

const formatTarget = (
  target: AgentFeedbackTarget,
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
  task: AgentFeedbackTask,
  annotation: AgentFeedbackAnnotation
): string[] => {
  const displayNumber =
    agentFeedbackAnnotationDisplayNumber(task.annotations, annotation.annotationId) ??
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

export function formatAgentFeedbackTaskMarkdown(
  input: unknown,
  options: Omit<AgentFeedbackFormatOptions, "format"> = {}
): string {
  const task = parseAgentFeedbackTask(input);
  const annotations = selectAgentFeedbackAnnotations(
    task.annotations,
    options.annotations ?? "open"
  );
  const lines = [
    `# Agent Feedback Task ${task.taskId}`,
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

export function formatAgentFeedbackTaskJson(input: unknown): string {
  return JSON.stringify(parseAgentFeedbackTask(input), null, 2);
}

export function formatAgentFeedbackTask(
  input: unknown,
  options: AgentFeedbackFormatOptions = {}
): string {
  return options.format === "json"
    ? formatAgentFeedbackTaskJson(input)
    : formatAgentFeedbackTaskMarkdown(input, options);
}
