import { RevisionConflictError } from "../core/index.js";
import {
  isTaskIdentityNewer,
  parseValidatedTask,
  taskIdentity,
  validateTransportResult,
  type TaskIdentity,
} from "../core/transport.js";
import type {
  AgentAnnotationsDiagnosticsEntry,
  AgentAnnotationsMutationRequest,
  AgentAnnotationsTask,
  TaskTransport,
} from "../types/index.js";

export type HttpTaskTransportOptions = {
  endpoint: string;
  token: string;
};

const TOKEN_HEADER = "x-agent-annotations-token";
const TASK_UPDATE_EVENT = "agent-annotations:task-update";

export class HttpTaskTransport implements TaskTransport {
  readonly endpoint: string;
  readonly token: string;
  #lastSeen: TaskIdentity | null = null;

  constructor(options: HttpTaskTransportOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
  }

  async #request(init?: RequestInit, expectedRevision?: number): Promise<unknown> {
    const response = await fetch(`${this.endpoint}/task`, {
      ...init,
      cache: "no-store",
      headers: {
        [TOKEN_HEADER]: this.token,
        "cache-control": "no-cache",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
    const payload = (await response.json()) as {
      error?: string;
      task?: AgentAnnotationsTask;
    };
    if (response.status === 409 && payload.error === "revision_conflict") {
      if (payload.task !== undefined) {
        // An invalid 409 task is a validation failure, never a silent
        // downgrade to the generic request_failed error.
        const latestTask = parseValidatedTask(payload.task, "conflict");
        throw new RevisionConflictError(
          latestTask,
          expectedRevision ?? latestTask.taskRevision - 1,
          latestTask.taskRevision
        );
      }
      throw new Error(payload.error ?? "request_failed");
    }
    if (!response.ok || payload.task === undefined) {
      throw new Error(payload.error ?? "request_failed");
    }
    return payload.task;
  }

  async read(): Promise<AgentAnnotationsTask> {
    const task = parseValidatedTask(await this.#request(), "read");
    this.#lastSeen = taskIdentity(task);
    return task;
  }

  async mutate(request: AgentAnnotationsMutationRequest): Promise<AgentAnnotationsTask> {
    const task = validateTransportResult(
      "mutate",
      parseValidatedTask(
        await this.#request(
          { method: "POST", body: JSON.stringify(request) },
          request.expectedRevision
        ),
        "mutate"
      ),
      { taskId: request.taskId, taskRevision: request.expectedRevision }
    );
    this.#lastSeen = taskIdentity(task);
    return task;
  }

  async writeEvidence(input: {
    taskId: string;
    expectedRevision: number;
    annotationId: string;
    png: string;
    width: number;
    height: number;
  }): Promise<AgentAnnotationsTask> {
    const response = await fetch(`${this.endpoint}/evidence`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: this.token, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json() as { error?: string; task?: AgentAnnotationsTask };
    if (response.status === 409 && payload.error === "revision_conflict") {
      if (payload.task !== undefined) {
        const latestTask = parseValidatedTask(payload.task, "conflict");
        throw new RevisionConflictError(
          latestTask,
          input.expectedRevision,
          latestTask.taskRevision
        );
      }
      throw new Error(payload.error ?? "request_failed");
    }
    if (!response.ok || payload.task === undefined) {
      throw new Error(payload.error ?? "request_failed");
    }
    const task = validateTransportResult(
      "writeEvidence",
      parseValidatedTask(payload.task, "evidence"),
      { taskId: input.taskId, taskRevision: input.expectedRevision },
      input.annotationId
    );
    this.#lastSeen = taskIdentity(task);
    return task;
  }

  async appendDiagnostics(entries: AgentAnnotationsDiagnosticsEntry[]): Promise<void> {
    const response = await fetch(`${this.endpoint}/diagnostics`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: this.token, "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!response.ok) throw new Error("diagnostics_append_failed");
  }

  subscribe(listener: (task: AgentAnnotationsTask) => void): () => void {
    const controller = new AbortController();
    let stopped = false;
    let requestActive = false;
    let updatePending = false;

    const refresh = async () => {
      if (stopped) return;
      if (requestActive) {
        updatePending = true;
        return;
      }
      requestActive = true;
      try {
        const task = parseValidatedTask(
          await this.#request({ signal: controller.signal }),
          "read"
        );
        if (stopped) return;
        // The shared last-seen identity also covers successful reads,
        // mutations, and evidence writes, so an event never re-delivers the
        // version the runtime already saw or overwrites a newer revision.
        if (isTaskIdentityNewer(taskIdentity(task), this.#lastSeen)) {
          listener(task);
          this.#lastSeen = taskIdentity(task);
        }
      } catch {
        // The dev server may be restarting, or the subscription was aborted.
      } finally {
        requestActive = false;
        if (updatePending && !stopped) {
          updatePending = false;
          void refresh();
        }
      }
    };
    const onTaskUpdate = () => void refresh();
    window.addEventListener(TASK_UPDATE_EVENT, onTaskUpdate);
    return () => {
      stopped = true;
      updatePending = false;
      window.removeEventListener(TASK_UPDATE_EVENT, onTaskUpdate);
      controller.abort();
    };
  }
}
