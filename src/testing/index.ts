import { RevisionConflictError } from "../core/conflict.js";
import { applyAgentAnnotationsMutation } from "../core/mutation.js";
import { createAgentAnnotationsId } from "../core/ids.js";
import { createAgentAnnotationsTask, parseAgentAnnotationsTask } from "../core/schema.js";
import type {
  AgentAnnotationsMutationRequest,
  AgentAnnotationsTask,
  TaskTransport,
} from "../types/index.js";

export class MemoryTaskTransport implements TaskTransport {
  #task: AgentAnnotationsTask;

  constructor(task?: AgentAnnotationsTask) {
    const now = new Date().toISOString();
    const initial = task ?? createAgentAnnotationsTask({ taskId: createAgentAnnotationsId(), createdAt: now });
    // The initial task is a validation boundary: invalid input is rejected
    // with the strict schema parser instead of being stored and served later.
    this.#task = parseAgentAnnotationsTask(initial);
  }

  async read(): Promise<AgentAnnotationsTask> {
    return structuredClone(this.#task);
  }

  async mutate(request: AgentAnnotationsMutationRequest): Promise<AgentAnnotationsTask> {
    const result = applyAgentAnnotationsMutation(
      this.#task,
      request,
      new Date(Math.max(Date.now(), Date.parse(this.#task.updatedAt) + 1)).toISOString()
    );
    if (!result.ok) {
      if (result.error === "revision_conflict") {
        throw new RevisionConflictError(
          result.task,
          request.expectedRevision,
          result.actualRevision
        );
      }
      throw new Error(`Agent Annotations mutation failed: ${result.error}`);
    }
    this.#task = parseAgentAnnotationsTask(result.task);
    return structuredClone(this.#task);
  }

  async writeEvidence(input: {
    taskId: string;
    expectedRevision: number;
    annotationId: string;
    png: string;
    width: number;
    height: number;
  }): Promise<AgentAnnotationsTask> {
    return this.mutate({
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      operations: [{
        op: "addEvidence",
        annotationId: input.annotationId,
        evidence: {
          kind: "screenshot",
          ref: `memory:${input.png.length}`,
          mediaType: "image/png",
          width: input.width,
          height: input.height,
          capturedAt: new Date().toISOString(),
        },
      }],
    });
  }
}
