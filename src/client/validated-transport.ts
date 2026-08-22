import { AGENT_ANNOTATIONS_ID_PATTERN } from "../core/index.js";
import {
  parseValidatedTask,
  validateTransportResult,
  validateConflictTask,
} from "../core/transport.js";
import type { TaskTransport } from "../types/index.js";

// Unconditional validation boundary for mountAgentAnnotations: every task
// entering the runtime through read/mutate/writeEvidence/subscribe (including
// the latest task carried by a RevisionConflictError) must pass the strict
// schema parser first. Third-party TaskTransport implementations cannot feed
// an invalid task into the runtime.
export const createValidatedTaskTransport = (transport: TaskTransport): TaskTransport => {
  return {
    read: async () => parseValidatedTask(await transport.read(), "read"),
    mutate: async (request) => {
      try {
        return validateTransportResult(
          "mutate",
          parseValidatedTask(await transport.mutate(request), "mutate"),
          { taskId: request.taskId, taskRevision: request.expectedRevision }
        );
      } catch (error) {
        throw validateConflictTask(error);
      }
    },
    writeEvidence: transport.writeEvidence
      ? async (input) => {
          validateWriteEvidenceMetadata(input);
          try {
            return validateTransportResult(
              "writeEvidence",
              parseValidatedTask(await transport.writeEvidence!(input), "writeEvidence"),
              { taskId: input.taskId, taskRevision: input.expectedRevision },
              input.annotationId
            );
          } catch (error) {
            throw validateConflictTask(error);
          }
        }
      : undefined,
    subscribe: transport.subscribe
      ? (listener) =>
          transport.subscribe!((task) => listener(parseValidatedTask(task, "subscribe")))
      : undefined,
    appendDiagnostics: transport.appendDiagnostics
      ? (entries) => transport.appendDiagnostics!(entries)
      : undefined,
  };
};

// PNG bytes are never string-redacted (screenshot privacy is handled by the
// existing capture sanitizer and the server-side PNG boundary); the metadata
// around them must be validated before it is delegated to a custom transport.
const validateWriteEvidenceMetadata = (input: {
  taskId: string;
  expectedRevision: number;
  annotationId: string;
  png: string;
  width?: number;
  height?: number;
}): void => {
  if (typeof input.taskId !== "string" || input.taskId.length === 0) {
    throw new TypeError("writeEvidence taskId must be a non-empty string");
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError("writeEvidence expectedRevision must be a non-negative integer");
  }
  if (
    typeof input.annotationId !== "string" ||
    !AGENT_ANNOTATIONS_ID_PATTERN.test(input.annotationId)
  ) {
    throw new TypeError("writeEvidence annotationId must be a valid annotation id");
  }
  if (typeof input.png !== "string") {
    throw new TypeError("writeEvidence png must be a string");
  }
  for (const key of ["width", "height"] as const) {
    const value = input[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new TypeError(`writeEvidence ${key} must be a non-negative finite number`);
    }
  }
};
