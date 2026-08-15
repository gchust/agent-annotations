import type {
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

  async #request(init?: RequestInit): Promise<AgentAnnotationsTask> {
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
    if (!response.ok || !payload.task) throw new Error(payload.error ?? "request_failed");
    return payload.task;
  }

  async read(): Promise<AgentAnnotationsTask> {
    const task = await this.#request();
    this.#lastReadRevision = task.taskRevision;
    return task;
  }

  mutate(request: AgentAnnotationsMutationRequest): Promise<AgentAnnotationsTask> {
    return this.#request({ method: "POST", body: JSON.stringify(request) });
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
    if (!response.ok || !payload.task) throw new Error(payload.error ?? "request_failed");
    return payload.task;
  }

  subscribe(listener: (task: AgentAnnotationsTask) => void): () => void {
    let revision = this.#lastReadRevision;
    const poll = async () => {
      try {
        const task = await this.#request();
        if (task.taskRevision !== revision) {
          listener(task);
          revision = task.taskRevision;
          this.#lastReadRevision = revision;
        }
      } catch {
        // The dev server may be restarting; the next poll reconnects.
      }
    };
    const timer = window.setInterval(() => void poll(), this.pollInterval);
    const heartbeat = () => void fetch(`${this.endpoint}/heartbeat`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: this.token },
    }).catch(() => undefined);
    const heartbeatTimer = window.setInterval(heartbeat, HEARTBEAT_INTERVAL);
    heartbeat();
    void poll();
    return () => {
      window.clearInterval(timer);
      window.clearInterval(heartbeatTimer);
    };
  }
}
