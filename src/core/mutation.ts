import type {
  AgentFeedbackAnnotation,
  AgentFeedbackMutationOperation,
  AgentFeedbackMutationRequest,
  AgentFeedbackMutationResult,
  AgentFeedbackTask,
} from "../types/index.js";
import {
  MAX_ANNOTATIONS,
  setAnnotationExtension,
  validateAgentFeedbackAnnotation,
  validateAgentFeedbackTask,
} from "./schema.js";

const MAX_MUTATION_OPERATIONS = 100;

const findAnnotation = (
  annotations: AgentFeedbackAnnotation[],
  annotationId: string
): number =>
  annotations.findIndex((annotation) => annotation.annotationId === annotationId);

const nextStatus = (
  annotations: AgentFeedbackAnnotation[],
  previous: AgentFeedbackTask["status"]
): AgentFeedbackTask["status"] => {
  if (annotations.some((annotation) => annotation.status === "open")) {
    return "active";
  }
  return annotations.length > 0 ? "completed" : previous;
};

const applyOperation = (
  task: AgentFeedbackTask,
  operation: AgentFeedbackMutationOperation,
  completedAt: string
): AgentFeedbackMutationResult => {
  const annotations = task.annotations;
  switch (operation.op) {
    case "add": {
      if (annotations.length >= MAX_ANNOTATIONS) {
        return { ok: false, error: "annotation_limit" };
      }
      if (!validateAgentFeedbackAnnotation(operation.annotation).ok) {
        return { ok: false, error: "invalid_annotation" };
      }
      if (
        annotations.some(
          (annotation) => annotation.annotationId === operation.annotation.annotationId
        )
      ) {
        return { ok: false, error: "duplicate_annotation" };
      }
      const next = [...annotations, operation.annotation];
      return {
        ok: true,
        task: { ...task, annotations: next, status: nextStatus(next, task.status) },
      };
    }
    case "update": {
      const index = findAnnotation(annotations, operation.annotationId);
      if (index === -1) return { ok: false, error: "annotation_not_found" };
      const next = annotations.map((annotation, current) =>
        current === index ? { ...annotation, comment: operation.comment } : annotation
      );
      return validateAgentFeedbackAnnotation(next[index]).ok
        ? { ok: true, task: { ...task, annotations: next } }
        : { ok: false, error: "invalid_annotation" };
    }
    case "setExtension": {
      const index = findAnnotation(annotations, operation.annotationId);
      if (index === -1) return { ok: false, error: "annotation_not_found" };
      try {
        const next = annotations.map((annotation, current) =>
          current === index
            ? setAnnotationExtension(
                annotation,
                operation.extensionId,
                operation.data
              )
            : annotation
        );
        return validateAgentFeedbackAnnotation(next[index]).ok
          ? { ok: true, task: { ...task, annotations: next } }
          : { ok: false, error: "invalid_extension" };
      } catch {
        return { ok: false, error: "invalid_extension" };
      }
    }
    case "complete": {
      const index = findAnnotation(annotations, operation.annotationId);
      if (index === -1) return { ok: false, error: "annotation_not_found" };
      const next = annotations.map((annotation, current) =>
        current !== index || annotation.status === "completed"
          ? annotation
          : {
              ...annotation,
              status: "completed" as const,
              completedAt,
              ...(operation.evidence
                ? {
                    completionEvidence: {
                      ...operation.evidence,
                      completedAt,
                    },
                  }
                : {}),
            }
      );
      return {
        ok: true,
        task: { ...task, annotations: next, status: nextStatus(next, task.status) },
      };
    }
    case "reopen": {
      const index = findAnnotation(annotations, operation.annotationId);
      if (index === -1) return { ok: false, error: "annotation_not_found" };
      const next = annotations.map((annotation, current) =>
        current !== index || annotation.status === "open"
          ? annotation
          : {
              ...annotation,
              status: "open" as const,
              completedAt: undefined,
              completionEvidence: undefined,
            }
      );
      return { ok: true, task: { ...task, annotations: next, status: "active" } };
    }
    case "remove": {
      const index = findAnnotation(annotations, operation.annotationId);
      if (index === -1) return { ok: false, error: "annotation_not_found" };
      const next = annotations.filter((_, current) => current !== index);
      return {
        ok: true,
        task: { ...task, annotations: next, status: nextStatus(next, task.status) },
      };
    }
    case "removeCompleted": {
      const next = annotations.filter((annotation) => annotation.status === "open");
      return {
        ok: true,
        task: { ...task, annotations: next, status: nextStatus(next, task.status) },
      };
    }
    default:
      return { ok: false, error: "invalid_operation" };
  }
};

export function applyAgentFeedbackMutation(
  task: AgentFeedbackTask,
  request: AgentFeedbackMutationRequest,
  updatedAt: string
): AgentFeedbackMutationResult {
  if (!validateAgentFeedbackTask(task).ok) {
    return { ok: false, error: "invalid_task" };
  }
  if (request.taskId !== task.taskId) {
    return { ok: false, error: "task_id_mismatch" };
  }
  if (request.expectedRevision !== task.taskRevision) {
    return {
      ok: false,
      error: "revision_conflict",
      expectedRevision: request.expectedRevision,
      actualRevision: task.taskRevision,
      task,
    };
  }
  if (
    !Number.isInteger(request.expectedRevision) ||
    !Array.isArray(request.operations) ||
    request.operations.length === 0 ||
    request.operations.length > MAX_MUTATION_OPERATIONS ||
    Number.isNaN(Date.parse(updatedAt)) ||
    new Date(updatedAt).toISOString() !== updatedAt ||
    Date.parse(updatedAt) < Date.parse(task.updatedAt)
  ) {
    return { ok: false, error: "invalid_operation" };
  }
  let next = task;
  for (const operation of request.operations) {
    if (!operation || typeof operation !== "object") {
      return { ok: false, error: "invalid_operation" };
    }
    const result = applyOperation(next, operation, updatedAt);
    if (!result.ok) return result;
    next = result.task;
  }
  next = {
    ...next,
    taskRevision: task.taskRevision + 1,
    updatedAt,
  };
  return validateAgentFeedbackTask(next).ok
    ? { ok: true, task: next }
    : { ok: false, error: "invalid_operation" };
}
