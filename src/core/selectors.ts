import type {
  AgentFeedbackAnnotation,
  AgentFeedbackAnnotationFilter,
} from "../types/index.js";

export const selectAgentFeedbackAnnotations = (
  annotations: AgentFeedbackAnnotation[],
  filter: AgentFeedbackAnnotationFilter = "open"
): AgentFeedbackAnnotation[] =>
  filter === "all"
    ? annotations
    : annotations.filter((annotation) => annotation.status === "open");

export const countOpenAgentFeedbackAnnotations = (
  annotations: AgentFeedbackAnnotation[]
): number => selectAgentFeedbackAnnotations(annotations).length;

export function agentFeedbackAnnotationDisplayNumber(
  annotations: AgentFeedbackAnnotation[],
  annotationId: string
): number | undefined {
  const index = annotations.findIndex(
    (annotation) => annotation.annotationId === annotationId
  );
  return index === -1 ? undefined : index + 1;
}
