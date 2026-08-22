import {
  redactAgentAnnotationsMutationRequest,
  RevisionConflictError,
} from "../../core/index.js";
import { isTaskIdentityNewer, taskIdentity } from "../../core/transport.js";
import type {
  AgentAnnotationsJsonObject,
  AgentAnnotationsMutationOperation,
  AgentAnnotationsTask,
} from "../../types/index.js";

export type TaskBindings = {
  task(): AgentAnnotationsTask;
  setTask(next: AgentAnnotationsTask): void;
  transport(): { mutate(request: unknown): Promise<AgentAnnotationsTask> };
  guardedRedactors(): Array<{
    extensionId: string;
    id: string;
    redact(data: AgentAnnotationsJsonObject, context: { annotationId: string; extensionId: string }): AgentAnnotationsJsonObject | null;
  }>;
  commit(): void;
  destroyed(): boolean;
};

export type TaskController = {
  mutate(operations: AgentAnnotationsMutationOperation[]): Promise<AgentAnnotationsTask | undefined>;
  adoptTask(candidate: AgentAnnotationsTask): void;
  mutateCommand(operations: AgentAnnotationsMutationOperation[]): Promise<void>;
};

export const createTaskController = (b: TaskBindings): TaskController => {
  const mutate = async (operations: AgentAnnotationsMutationOperation[]): Promise<AgentAnnotationsTask | undefined> => {
    if (b.destroyed()) return undefined;
    const attempt = async (expectedRevision: number): Promise<AgentAnnotationsTask | undefined> => {
      const redactors = b.guardedRedactors();
      // Every delegated mutation passes the unified boundary first: the
      // current task and request are validated, every data-carrying operation
      // is redacted (generic + extension redactors), and the redacted payload
      // is re-validated before the transport sees it.
      const redactedRequest = redactAgentAnnotationsMutationRequest(b.task(), {
        taskId: b.task().taskId,
        expectedRevision,
        operations,
      }, redactors);
      const next = await b.transport().mutate(redactedRequest);
      if (b.destroyed()) return undefined;
      // A successful mutation updates last-seen only when the identity rule
      // accepts it; an older result can never regress the current task.
      if (isTaskIdentityNewer(taskIdentity(next), taskIdentity(b.task()))) {
        b.setTask(next);
        b.commit();
      }
      return next;
    };
    try {
      return await attempt(b.task().taskRevision);
    } catch (error) {
      if (b.destroyed() || !(error instanceof RevisionConflictError)) throw error;
      // Adopt the latest task, then retry the rejected mutation exactly once.
      b.setTask(error.latestTask);
      b.commit();
      try {
        return await attempt(error.latestTask.taskRevision);
      } catch (retryError) {
        // A second conflict also adopts the latest task, then stops.
        if (b.destroyed() || !(retryError instanceof RevisionConflictError)) throw retryError;
        b.setTask(retryError.latestTask);
        b.commit();
        throw retryError;
      }
    }
  };
  const mutateCommand = async (operations: AgentAnnotationsMutationOperation[]): Promise<void> => {
    await mutate(operations);
  };
  const adoptTask = (candidate: AgentAnnotationsTask): void => {
    if (b.destroyed()) return;
    if (isTaskIdentityNewer(taskIdentity(candidate), taskIdentity(b.task()))) {
      b.setTask(candidate);
      b.commit();
    }
  };
  return { mutate, adoptTask, mutateCommand };
};
