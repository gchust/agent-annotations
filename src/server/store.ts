import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

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

const MALFORMED_LOCK_GRACE_MS = 5_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
const LOCK_POLL_MS = 10;

type LockMetadata = { pid: number; createdAt: string; owner: string };

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const lockAgeMs = (file: string): number => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const lockContentIsRecoverable = (content: string, file: string): boolean => {
  let metadata: unknown;
  try {
    metadata = JSON.parse(content);
  } catch {
    // Unparseable lock: conservatively recover only after a grace period.
    return lockAgeMs(file) >= MALFORMED_LOCK_GRACE_MS;
  }
  const { pid, createdAt, owner } = (metadata ?? {}) as {
    pid?: unknown;
    createdAt?: unknown;
    owner?: unknown;
  };
  const validPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  const validCreatedAt = typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt));
  const validOwner = typeof owner === "string" && owner.length > 0;
  if (!validPid || !validCreatedAt || !validOwner) {
    // Malformed metadata: conservatively recover only after a grace period.
    return lockAgeMs(file) >= MALFORMED_LOCK_GRACE_MS;
  }
  if (isPidAlive(pid)) return false; // A demonstrably live PID is never broken.
  // Dead PID: recover only when the lock is stale beyond the grace period.
  return Date.now() - Date.parse(createdAt as string) >= MALFORMED_LOCK_GRACE_MS;
};

const inspectLock = (file: string): { content: string; recoverable: boolean } | null => {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null; // Gone or unreadable: retry the acquisition without touching anything.
  }
  return { content, recoverable: lockContentIsRecoverable(content, file) };
};

const CLAIM_FILE = ".write.lock.claim";

const claimStaleLock = async (
  file: string,
  inspected: string
): Promise<"claimed" | "wait" | "retry"> => {
  const claimPath = path.join(path.dirname(file), CLAIM_FILE);
  // The claim is a hard link to the current inode at the lock path: it never moves or
  // removes the lock, so a live lock can never be displaced by a recovery.
  try {
    linkSync(file, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "retry"; // The lock vanished: another process recovered it.
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process already holds the claim: it must target the same stale lock and
    // be fresh; a stale claim is only a hard link, so taking it over never touches
    // the lock at the path.
    try {
      const claimStat = statSync(claimPath);
      const lockStat = statSync(file);
      if (claimStat.ino === lockStat.ino) {
        if (Date.now() - claimStat.mtimeMs >= MALFORMED_LOCK_GRACE_MS) {
          unlinkSync(claimPath);
          return "retry";
        }
        return "wait";
      }
      // The claim targets a different inode: it is orphaned (its lock was replaced,
      // or its claimer crashed between unlinking the lock and cleaning the claim).
      // Removing the hard link never touches the lock at the path, so this is safe.
      unlinkSync(claimPath);
      return "retry";
    } catch {
      return "retry"; // The claim or the lock vanished.
    }
  }
  // I own the claim: mark it fresh, then verify it links the exact inspected stale
  // lock before touching the lock path.
  try {
    utimesSync(claimPath, new Date(), new Date());
    const claimStat = statSync(claimPath);
    const lockStat = statSync(file);
    if (claimStat.ino !== lockStat.ino || readFileSync(claimPath, "utf8") !== inspected) {
      rmSync(claimPath, { force: true });
      return "retry";
    }
    // Verified: the path still holds exactly the inspected stale lock. Waiting
    // processes observe the fresh claim and never replace the path meanwhile.
    unlinkSync(file);
    rmSync(claimPath, { force: true });
    return "claimed";
  } catch (error) {
    rmSync(claimPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "retry";
  }
};

const acquireLock = async (file: string, timeoutMs: number): Promise<() => void> => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      try {
        const metadata: LockMetadata = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          owner,
        };
        writeFileSync(descriptor, JSON.stringify(metadata));
      } catch (error) {
        closeSync(descriptor);
        rmSync(file, { force: true });
        throw error;
      }
      return () => {
        try {
          closeSync(descriptor);
        } catch {
          // The descriptor is already closed.
        }
        try {
          const current = JSON.parse(readFileSync(file, "utf8")) as { owner?: unknown };
          if (current.owner === owner) rmSync(file, { force: true });
        } catch {
          // Unreadable or already removed locks need no further action.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspected = inspectLock(file);
      if (inspected && inspected.recoverable) {
        const claimed = await claimStaleLock(file, inspected.content);
        if (claimed === "claimed") continue;
        // "retry" made progress but must stay bounded; "wait" also waits below.
        if (claimed === "retry" && Date.now() < deadline) continue;
      }
      if (Date.now() >= deadline) {
        const busy = new Error("write_busy") as Error & { code: string };
        busy.code = "write_busy";
        throw busy;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
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
    const unlock = await acquireLock(this.#lockPath(), this.lockTimeoutMs);
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
      const unlock = await acquireLock(this.#lockPath(), this.lockTimeoutMs);
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
