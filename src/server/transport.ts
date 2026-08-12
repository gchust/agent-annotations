import type {
  AgentFeedbackMutationRequest,
  AgentFeedbackTask,
  TaskTransport,
} from "../types/index.js";

export type HttpTaskTransportOptions = {
  endpoint: string;
  token: string;
  pollInterval?: number;
};

const TOKEN_HEADER = "x-agent-feedback-token";
const HEARTBEAT_INTERVAL = 5_000;

export class HttpTaskTransport implements TaskTransport {
  readonly endpoint: string;
  readonly token: string;
  readonly pollInterval: number;

  constructor(options: HttpTaskTransportOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.pollInterval = options.pollInterval ?? 500;
  }

  async #request(init?: RequestInit): Promise<AgentFeedbackTask> {
    const response = await fetch(`${this.endpoint}/task`, {
      ...init,
      headers: {
        [TOKEN_HEADER]: this.token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
    const payload = (await response.json()) as {
      error?: string;
      task?: AgentFeedbackTask;
    };
    if (!response.ok || !payload.task) throw new Error(payload.error ?? "request_failed");
    return payload.task;
  }

  read(): Promise<AgentFeedbackTask> {
    return this.#request();
  }

  mutate(request: AgentFeedbackMutationRequest): Promise<AgentFeedbackTask> {
    return this.#request({ method: "POST", body: JSON.stringify(request) });
  }

  subscribe(listener: (task: AgentFeedbackTask) => void): () => void {
    let revision: number | undefined;
    const poll = async () => {
      try {
        const task = await this.read();
        if (revision !== undefined && task.taskRevision !== revision) listener(task);
        revision = task.taskRevision;
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
