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
  pollInterval?: number;
};

const TOKEN_HEADER = "x-agent-annotations-token";
const HEARTBEAT_INTERVAL = 5_000;
const MIN_POLL_INTERVAL = 100;
const MAX_POLL_INTERVAL = 10_000;
const DEFAULT_POLL_INTERVAL = 500;

export class HttpTaskTransport implements TaskTransport {
  readonly endpoint: string;
  readonly token: string;
  readonly pollInterval: number;
  #lastSeen: TaskIdentity | null = null;

  constructor(options: HttpTaskTransportOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    if (!Number.isInteger(pollInterval) || pollInterval < MIN_POLL_INTERVAL || pollInterval > MAX_POLL_INTERVAL) {
      throw new TypeError(
        `pollInterval must be a finite integer between ${MIN_POLL_INTERVAL} and ${MAX_POLL_INTERVAL} ` +
          `(received ${options.pollInterval})`
      );
    }
    this.pollInterval = pollInterval;
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
    let pollInFlight = false;
    let heartbeatInFlight = false;
    let pollTimer: number | undefined;
    let heartbeatTimer: number | undefined;

    const poll = async () => {
      if (stopped || pollInFlight) return;
      pollInFlight = true;
      try {
        const task = parseValidatedTask(
          await this.#request({ signal: controller.signal }),
          "read"
        );
        if (stopped) return;
        // The shared last-seen identity also covers successful reads,
        // mutations, and evidence writes, so a poll never re-delivers the
        // version the runtime already saw, and a late stale poll can never
        // overwrite a newer task or revision.
        if (isTaskIdentityNewer(taskIdentity(task), this.#lastSeen)) {
          listener(task);
          this.#lastSeen = taskIdentity(task);
        }
      } catch {
        // The dev server may be restarting (or the subscription was aborted);
        // the next poll reconnects.
      } finally {
        pollInFlight = false;
        if (!stopped) pollTimer = window.setTimeout(() => void poll(), this.pollInterval);
      }
    };
    const heartbeat = async () => {
      if (stopped || heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        await fetch(`${this.endpoint}/heartbeat`, {
          method: "POST",
          headers: { [TOKEN_HEADER]: this.token },
          signal: controller.signal,
        });
      } catch {
        // The dev server may be restarting (or the subscription was aborted);
        // the next heartbeat reconnects.
      } finally {
        heartbeatInFlight = false;
        if (!stopped) heartbeatTimer = window.setTimeout(() => void heartbeat(), HEARTBEAT_INTERVAL);
      }
    };
    heartbeatTimer = window.setTimeout(() => void heartbeat(), 0);
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer);
    };
  }
}
