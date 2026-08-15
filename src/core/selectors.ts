import type {
  AgentAnnotation,
  AgentAnnotationFilter,
} from "../types/index.js";

export const selectAgentAnnotations = (
  annotations: AgentAnnotation[],
  filter: AgentAnnotationFilter = "open"
): AgentAnnotation[] =>
  filter === "all"
    ? annotations
    : annotations.filter((annotation) => annotation.status === "open");

export const countOpenAgentAnnotations = (
  annotations: AgentAnnotation[]
): number => selectAgentAnnotations(annotations).length;

export function agentAnnotationsAnnotationDisplayNumber(
  annotations: AgentAnnotation[],
  annotationId: string
): number | undefined {
  const index = annotations.findIndex(
    (annotation) => annotation.annotationId === annotationId
  );
  return index === -1 ? undefined : index + 1;
}
