import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  applyAgentFeedbackMutation,
  createAgentFeedbackTask,
  parseAgentFeedbackTask,
} from "../core/index.js";
import type {
  AgentFeedbackMutationRequest,
  AgentFeedbackTask,
} from "../types/index.js";

export const ACTIVE_TASK_FILE = "tasks/active-task.json";

export type AgentFeedbackSession = {
  endpoint: string;
  origin: string;
  pid: number;
  startedAt: string;
  token: string;
};

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

const atomicWrite = (file: string, value: unknown, mode = 0o600): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    renameSync(temporary, file);
    chmodSync(file, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const acquireLock = async (file: string): Promise<() => void> => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      return () => {
        closeSync(descriptor);
        rmSync(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const busy = new Error("write_busy") as Error & { code: string };
        busy.code = "write_busy";
        throw busy;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

export class FileTaskStore {
  readonly root: string;
  readonly taskPath: string;
  readonly sessionPath: string;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.taskPath = path.join(this.root, ACTIVE_TASK_FILE);
    this.sessionPath = path.join(this.root, "session.json");
  }

  read(): AgentFeedbackTask | null {
    try {
      return parseAgentFeedbackTask(readJson(this.taskPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  readOrCreate(): AgentFeedbackTask {
    const existing = this.read();
    if (existing) return existing;
    return this.create();
  }

  create(): AgentFeedbackTask {
    const createdAt = new Date().toISOString();
    const task = createAgentFeedbackTask({ taskId: randomUUID(), createdAt });
    atomicWrite(this.taskPath, task);
    return task;
  }

  mutate(request: AgentFeedbackMutationRequest): Promise<AgentFeedbackTask> {
    const write = async (): Promise<AgentFeedbackTask> => {
      const unlock = await acquireLock(path.join(this.root, "tasks/.write.lock"));
      try {
        const task = this.read();
        if (!task) {
          const missing = new Error("no_active_task") as Error & { code: string };
          missing.code = "no_active_task";
          throw missing;
        }
        const updatedAt = new Date(
          Math.max(Date.now(), Date.parse(task.updatedAt) + 1)
        ).toISOString();
        const result = applyAgentFeedbackMutation(task, request, updatedAt);
        if (!result.ok) {
          const error = new Error(result.error) as Error & {
            code: string;
            task?: AgentFeedbackTask;
          };
          error.code = result.error;
          if (result.error === "revision_conflict") error.task = result.task;
          throw error;
        }
        atomicWrite(this.taskPath, result.task);
        return result.task;
      } finally {
        unlock();
      }
    };
    const queued = this.#writes.then(write, write);
    this.#writes = queued.catch(() => undefined);
    return queued;
  }

  async writeEvidence(
    request: AgentFeedbackMutationRequest,
    input: { annotationId: string; bytes: Buffer; mediaType: "image/png" }
  ): Promise<AgentFeedbackTask> {
    if (!input.bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw new Error("invalid_png");
    }
    if (input.bytes.length > 2 * 1024 * 1024) throw new Error("evidence_too_large");
    const file = `evidence/${input.annotationId}-${randomUUID()}.png`;
    const absolute = path.join(this.root, file);
    mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, input.bytes, { mode: 0o600 });
    try {
      return await this.mutate({
        ...request,
        operations: [{
          op: "addEvidence",
          annotationId: input.annotationId,
          evidence: {
            kind: "screenshot",
            ref: file,
            mediaType: input.mediaType,
            capturedAt: new Date().toISOString(),
          },
        }],
      });
    } catch (error) {
      rmSync(absolute, { force: true });
      throw error;
    }
  }

  writeSession(session: AgentFeedbackSession): void {
    atomicWrite(this.sessionPath, session);
  }

  close(token: string): Promise<void> {
    return this.#writes.then(() => this.closeSession(token));
  }

  closeSession(token: string): void {
    try {
      const session = readJson(this.sessionPath) as { token?: unknown };
      if (session.token === token) rmSync(this.sessionPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
