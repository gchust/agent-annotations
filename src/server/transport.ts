import { parseAgentAnnotationsTask, RevisionConflictError } from "../core/index.js";
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

export class HttpTaskTransport implements TaskTransport {
  readonly endpoint: string;
  readonly token: string;
  readonly pollInterval: number;
  #lastReadRevision: number | undefined;

  constructor(options: HttpTaskTransportOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.pollInterval = options.pollInterval ?? 500;
  }

  async #request(init?: RequestInit, expectedRevision?: number): Promise<AgentAnnotationsTask> {
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
    if (!response.ok || !payload.task) {
      if (response.status === 409 && payload.error === "revision_conflict" && payload.task) {
        try {
          const latestTask = parseAgentAnnotationsTask(payload.task);
          throw new RevisionConflictError(
            latestTask,
            expectedRevision ?? latestTask.taskRevision - 1,
            latestTask.taskRevision
          );
        } catch (error) {
          if (error instanceof RevisionConflictError) throw error;
        }
      }
      throw new Error(payload.error ?? "request_failed");
    }
    return payload.task;
  }

  async read(): Promise<AgentAnnotationsTask> {
    const task = await this.#request();
    this.#lastReadRevision = task.taskRevision;
    return task;
  }

  mutate(request: AgentAnnotationsMutationRequest): Promise<AgentAnnotationsTask> {
    return this.#request(
      { method: "POST", body: JSON.stringify(request) },
      request.expectedRevision
    );
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
    if (!response.ok || !payload.task) {
      if (response.status === 409 && payload.error === "revision_conflict" && payload.task) {
        try {
          const latestTask = parseAgentAnnotationsTask(payload.task);
          throw new RevisionConflictError(
            latestTask,
            input.expectedRevision,
            latestTask.taskRevision
          );
        } catch (error) {
          if (error instanceof RevisionConflictError) throw error;
        }
      }
      throw new Error(payload.error ?? "request_failed");
    }
    return payload.task;
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
    let revision = this.#lastReadRevision ?? -1;
    let stopped = false;
    let pollInFlight = false;
    let heartbeatInFlight = false;
    let pollTimer: number | undefined;
    let heartbeatTimer: number | undefined;

    const poll = async () => {
      if (stopped || pollInFlight) return;
      pollInFlight = true;
      try {
        const task = await this.#request();
        if (stopped) return;
        if (task.taskRevision > revision) {
          listener(task);
          revision = task.taskRevision;
          this.#lastReadRevision = revision;
        }
      } catch {
        // The dev server may be restarting; the next poll reconnects.
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
        });
      } catch {
        // The dev server may be restarting; the next heartbeat reconnects.
      } finally {
        heartbeatInFlight = false;
        if (!stopped) heartbeatTimer = window.setTimeout(() => void heartbeat(), HEARTBEAT_INTERVAL);
      }
    };
    heartbeatTimer = window.setTimeout(() => void heartbeat(), 0);
    void poll();
    return () => {
      stopped = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer);
    };
  }
}
