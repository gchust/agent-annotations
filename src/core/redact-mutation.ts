import { applyAgentAnnotationsMutation } from "./mutation.js";
import {
  parseAgentAnnotationsTask,
} from "./schema.js";
import { redactAgentAnnotationsTask, redactAgentAnnotationsText } from "./redaction.js";
import type {
  AgentAnnotationsExtensionRedactor,
  AgentAnnotationsMutationOperation,
  AgentAnnotationsMutationRequest,
  AgentAnnotationsTask,
} from "../types/index.js";

const invalidRequest = (reason: string): never => {
  throw new TypeError(`invalid mutation request: ${reason}`);
};

const nextUpdatedAt = (task: AgentAnnotationsTask): string =>
  new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();

const redactOperation = (
  currentTask: AgentAnnotationsTask,
  operation: AgentAnnotationsMutationOperation,
  redactors: readonly AgentAnnotationsExtensionRedactor[]
): AgentAnnotationsMutationOperation => {
  switch (operation.op) {
    case "add": {
      // Reuse the task redaction pipeline: generic redaction, then extension
      // redactors in stable (extensionId, redactorId) order (faulty redactors
      // fail closed for their own namespace), then generic redaction again.
      const synthetic: AgentAnnotationsTask = {
        ...currentTask,
        status: operation.annotation.status === "completed" ? "completed" : "active",
        annotations: [operation.annotation],
      };
      const [redacted] = redactAgentAnnotationsTask(synthetic, redactors).task.annotations;
      return { ...operation, annotation: redacted };
    }
    case "update": {
      return { ...operation, comment: redactAgentAnnotationsText(operation.comment) };
    }
    case "setExtension": {
      const annotation = currentTask.annotations.find(
        (entry) => entry.annotationId === operation.annotationId
      );
      if (!annotation) return invalidRequest(`annotation "${operation.annotationId}" not found`);
      const synthetic: AgentAnnotationsTask = {
        ...currentTask,
        status: annotation.status === "completed" ? "completed" : "active",
        annotations: [{
          ...annotation,
          extensions: { ...annotation.extensions, [operation.extensionId]: operation.data },
        }],
      };
      const redacted = redactAgentAnnotationsTask(synthetic, redactors).task.annotations[0];
      // A faulty redactor drops its own namespace: the delegate receives an
      // empty (valid) payload instead of the raw data.
      return { ...operation, data: redacted.extensions[operation.extensionId] ?? {} };
    }
    case "complete": {
      if (operation.evidence === undefined) return operation;
      return {
        ...operation,
        evidence: {
          ...operation.evidence,
          summary: redactAgentAnnotationsText(operation.evidence.summary),
          source: redactAgentAnnotationsText(operation.evidence.source),
        },
      };
    }
    case "addEvidence": {
      // ref/mediaType are redacted; capturedAt is structural (a valid
      // timestamp is required by the schema) and cannot be regex-redacted
      // without breaking the payload.
      return {
        ...operation,
        evidence: {
          ...operation.evidence,
          ref: redactAgentAnnotationsText(operation.evidence.ref),
          ...(operation.evidence.mediaType !== undefined
            ? { mediaType: redactAgentAnnotationsText(operation.evidence.mediaType) }
            : {}),
        },
      };
    }
    default:
      // remove/reopen/removeCompleted carry no user or extension data.
      return operation;
  }
};

// Single pure boundary for mutations leaving the runtime: validates the
// current task and the request, redacts every data-carrying operation, then
// re-validates the redacted payload by applying it to the current task.
// A payload that no longer passes schema or extension-data validation is
// rejected instead of being delegated.
export function redactAgentAnnotationsMutationRequest(
  currentTask: AgentAnnotationsTask,
  request: AgentAnnotationsMutationRequest,
  redactors: readonly AgentAnnotationsExtensionRedactor[] = []
): AgentAnnotationsMutationRequest {
  try {
    parseAgentAnnotationsTask(currentTask);
    if (
      typeof request.taskId !== "string" ||
      !Number.isInteger(request.expectedRevision) ||
      !Array.isArray(request.operations)
    ) {
      return invalidRequest("malformed request");
    }
    // Sequential redaction: each operation is redacted against the task state
    // produced by the previously redacted operations (mirroring
    // applyAgentAnnotationsMutation), so later operations can target
    // annotations added earlier in the same request.
    let state = currentTask;
    const operations: AgentAnnotationsMutationOperation[] = [];
    for (const operation of request.operations) {
      const redacted = redactOperation(state, operation, redactors);
      operations.push(redacted);
      const result = applyAgentAnnotationsMutation(
        state,
        {
          taskId: state.taskId,
          expectedRevision: state.taskRevision,
          operations: [redacted],
        },
        nextUpdatedAt(state)
      );
      if (!result.ok) return invalidRequest(result.error);
      state = result.task;
    }
    // Final whole-request validation: taskId, expectedRevision, operation
    // count, and the full sequential semantics must hold against the original
    // task before anything is delegated.
    const result = applyAgentAnnotationsMutation(
      currentTask,
      { ...request, operations },
      nextUpdatedAt(currentTask)
    );
    if (!result.ok) return invalidRequest(result.error);
    return { ...request, operations };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    // Normalize schema/extension failures into the same stable TypeError
    // family while keeping the locatable message.
    return invalidRequest((error as Error).message);
  }
}
