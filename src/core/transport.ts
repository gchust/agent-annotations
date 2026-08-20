import { parseAgentAnnotationsTask } from "./schema.js";
import { RevisionConflictError } from "./conflict.js";
import type { AgentAnnotationsTask } from "../types/index.js";

// Shared TaskTransport synchronization rules (internal module; not part of the
// public package surface).

export type TaskIdentity = {
  taskId: string;
  taskRevision: number;
};

export const taskIdentity = (task: AgentAnnotationsTask): TaskIdentity => ({
  taskId: task.taskId,
  taskRevision: task.taskRevision,
});

// Single comparison rule for (taskId, taskRevision):
// - no previous identity: accept;
// - different taskId: the task was replaced — accept even at revision 0;
// - same taskId: accept only a strictly larger revision;
// - same taskId with equal/smaller revision: ignore.
export const isTaskIdentityNewer = (
  candidate: TaskIdentity,
  seen: TaskIdentity | null
): boolean =>
  seen === null ||
  candidate.taskId !== seen.taskId ||
  candidate.taskRevision > seen.taskRevision;

// Stable, locatable error for tasks that fail schema parsing at a transport
// boundary. `source` names the exact entry (read/mutate/writeEvidence/
// subscribe/conflict) that produced the invalid task.
export class TaskTransportValidationError extends Error {
  readonly source: string;

  constructor(source: string, cause: Error) {
    super(`invalid task from transport (${source}): ${cause.message}`);
    this.name = "TaskTransportValidationError";
    this.source = source;
    this.cause = cause;
  }
}

export const parseValidatedTask = (value: unknown, source: string): AgentAnnotationsTask => {
  try {
    return parseAgentAnnotationsTask(value);
  } catch (error) {
    throw new TaskTransportValidationError(source, error as Error);
  }
};

// Re-validates the latest task carried by a conflict error; the original error
// is rethrown unchanged when the task is valid.
export const validateConflictTask = (error: unknown): unknown => {
  if (error instanceof RevisionConflictError) {
    const latestTask = parseValidatedTask(error.latestTask, "conflict");
    return new RevisionConflictError(latestTask, error.expectedRevision, error.actualRevision);
  }
  return error;
};
