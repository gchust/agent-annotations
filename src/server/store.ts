import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { acquireFileLock, LOCK_ACQUIRE_TIMEOUT_MS } from "./file-lock.js";
import {
  AGENT_ANNOTATIONS_ID_PATTERN,
  applyAgentAnnotationsMutation,
  createAgentAnnotationsTask,
  parseAgentAnnotationsTask,
  prepareAgentAnnotationsTaskForPersistence,
  RevisionConflictError,
} from "../core/index.js";
import { collectEvidenceRefs, removeEvidenceRefs } from "./evidence.js";
import type {
  AgentAnnotation,
  AgentAnnotationsMutationRequest,
  AgentAnnotationsTask,
} from "../types/index.js";

export const ACTIVE_TASK_FILE = "tasks/active-task.json";

export type AgentAnnotationsSession = {
  endpoint: string;
  origin: string;
  pid: number;
  startedAt: string;
  token: string;
  workspaceRoot: string;
  runtimeRoot: string;
};

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

export const atomicWriteJson = (file: string, value: unknown, mode = 0o600): void => {
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

export class FileTaskStore {
  readonly root: string;
  readonly taskPath: string;
  readonly sessionPath: string;
  readonly lockTimeoutMs: number;
  #writes: Promise<unknown> = Promise.resolve();

  #persist(task: AgentAnnotationsTask): AgentAnnotationsTask {
    // Unconditional final defense: Parse → Generic Redaction → Parse. The
    // client-side pre-delegation redaction never replaces this boundary.
    const redacted = prepareAgentAnnotationsTaskForPersistence(task);
    atomicWriteJson(this.taskPath, redacted);
    return redacted;
  }

  constructor(root: string, lockTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS) {
    this.root = path.resolve(root);
    this.taskPath = path.join(this.root, ACTIVE_TASK_FILE);
    this.sessionPath = path.join(this.root, "session.json");
    this.lockTimeoutMs = lockTimeoutMs;
  }

  #lockPath(): string {
    return path.join(this.root, "tasks", ".write.lock");
  }

  read(): AgentAnnotationsTask | null {
    try {
      return parseAgentAnnotationsTask(readJson(this.taskPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readOrCreate(): Promise<AgentAnnotationsTask> {
    const existing = this.read();
    if (existing) return existing;
    return this.create();
  }

  async create(): Promise<AgentAnnotationsTask> {
    const unlock = await acquireFileLock(this.#lockPath(), this.lockTimeoutMs);
    try {
      const existing = this.read();
      if (existing) return existing;
      const createdAt = new Date().toISOString();
      const task = createAgentAnnotationsTask({ taskId: randomUUID(), createdAt });
      return this.#persist(task);
    } finally {
      unlock();
    }
  }

  mutate(
    request: AgentAnnotationsMutationRequest,
    mapAnnotation: (annotation: AgentAnnotation) => AgentAnnotation = (annotation) => annotation
  ): Promise<AgentAnnotationsTask> {
    const write = async (): Promise<AgentAnnotationsTask> => {
      const unlock = await acquireFileLock(this.#lockPath(), this.lockTimeoutMs);
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
        const result = applyAgentAnnotationsMutation(task, {
          ...request,
          operations: request.operations.map((operation) => operation.op === "add"
            ? { ...operation, annotation: mapAnnotation(operation.annotation) }
            : operation),
        }, updatedAt);
        if (!result.ok) {
          if (result.error === "revision_conflict") {
            throw new RevisionConflictError(
              result.task,
              request.expectedRevision,
              result.actualRevision
            );
          }
          const error = new Error(result.error) as Error & { code: string };
          error.code = result.error;
          throw error;
        }
        const redacted = this.#persist(result.task);
        if (request.operations.some(
          (operation) => operation.op === "remove" || operation.op === "removeCompleted"
        )) {
          const before = collectEvidenceRefs(task);
          const after = collectEvidenceRefs(redacted);
          removeEvidenceRefs(this.root, [...before].filter((ref) => !after.has(ref)));
        }
        return redacted;
      } finally {
        unlock();
      }
    };
    const queued = this.#writes.then(write, write);
    this.#writes = queued.catch(() => undefined);
    return queued;
  }

  async writeEvidence(
    request: AgentAnnotationsMutationRequest,
    input: { annotationId: string; bytes: Buffer; mediaType: "image/png"; width?: number; height?: number }
  ): Promise<AgentAnnotationsTask> {
    if (!input.bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw new Error("invalid_png");
    }
    if (input.bytes.length > 2 * 1024 * 1024) throw new Error("evidence_too_large");
    if (
      typeof input.annotationId !== "string" ||
      !AGENT_ANNOTATIONS_ID_PATTERN.test(input.annotationId)
    ) {
      throw new Error("invalid_annotation_id");
    }
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
            ...(input.width ? { width: input.width } : {}),
            ...(input.height ? { height: input.height } : {}),
            capturedAt: new Date().toISOString(),
          },
        }],
      });
    } catch (error) {
      rmSync(absolute, { force: true });
      throw error;
    }
  }

  writeSession(session: AgentAnnotationsSession): void {
    atomicWriteJson(this.sessionPath, session);
  }

  close(token: string): Promise<void> {
    return this.#writes.then(() => this.closeSync(token));
  }

  closeSync(token: string): void {
    try {
      const session = readJson(this.sessionPath) as { token?: unknown };
      if (session.token === token) rmSync(this.sessionPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
