import { applyAgentFeedbackMutation } from "../core/mutation.js";
import { createAgentFeedbackId } from "../core/ids.js";
import { createAgentFeedbackTask, parseAgentFeedbackTask } from "../core/schema.js";
import type {
  AgentFeedbackMutationRequest,
  AgentFeedbackTask,
  TaskTransport,
} from "../types/index.js";

export class MemoryTaskTransport implements TaskTransport {
  #task: AgentFeedbackTask;

  constructor(task?: AgentFeedbackTask) {
    const now = new Date().toISOString();
    this.#task = task ?? createAgentFeedbackTask({ taskId: createAgentFeedbackId(), createdAt: now });
  }

  async read(): Promise<AgentFeedbackTask> {
    return structuredClone(this.#task);
  }

  async mutate(request: AgentFeedbackMutationRequest): Promise<AgentFeedbackTask> {
    const result = applyAgentFeedbackMutation(
      this.#task,
      request,
      new Date(Math.max(Date.now(), Date.parse(this.#task.updatedAt) + 1)).toISOString()
    );
    if (!result.ok) throw new Error(`Agent Feedback mutation failed: ${result.error}`);
    this.#task = parseAgentFeedbackTask(result.task);
    return structuredClone(this.#task);
  }

  async writeEvidence(input: {
    taskId: string;
    expectedRevision: number;
    annotationId: string;
    png: string;
    width: number;
    height: number;
  }): Promise<AgentFeedbackTask> {
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
