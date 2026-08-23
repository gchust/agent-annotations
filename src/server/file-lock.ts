import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Shared cross-process file lock with stale-lock recovery, extracted from the
// FileTaskStore write path. Both task writes and diagnostics writes use the
// same algorithm so recovery semantics never drift.

export const MALFORMED_LOCK_GRACE_MS = 5_000;
export const LOCK_POLL_MS = 10;
export const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;

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

const claimStaleLock = async (
  lockPath: string,
  inspected: string
): Promise<"claimed" | "wait" | "retry"> => {
  // The claim is a hard link to the current inode at the lock path, so it
  // never moves or removes the lock; a live lock can never be displaced by a
  // recovery.
  const claimPath = `${lockPath}.claim`;
  try {
    linkSync(lockPath, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "retry"; // The lock vanished: another process recovered it.
    }
    if (code !== "EEXIST" && !(process.platform === "win32" && code === "EPERM")) {
      throw error;
    }
    // Another process already holds the claim: it must target the same stale
    // lock and be fresh; a stale claim is only a hard link, so taking it over
    // never touches the lock at the path.
    try {
      const claimStat = statSync(claimPath);
      const lockStat = statSync(lockPath);
      if (claimStat.ino === lockStat.ino) {
        if (Date.now() - claimStat.ctimeMs >= MALFORMED_LOCK_GRACE_MS) {
          unlinkSync(claimPath);
          return "retry";
        }
        return "wait";
      }
      // The claim targets a different inode: it is orphaned (its lock was
      // replaced, or its claimer crashed between unlinking the lock and
      // cleaning the claim). Removing the hard link never touches the lock.
      unlinkSync(claimPath);
      return "retry";
    } catch {
      return "retry"; // The claim or the lock vanished.
    }
  }
  // I own the claim: creating the hard link refreshed the inode ctime. Verify
  // it links the exact inspected stale lock before touching the lock path.
  try {
    const claimStat = statSync(claimPath);
    const lockStat = statSync(lockPath);
    if (claimStat.ino !== lockStat.ino || readFileSync(claimPath, "utf8") !== inspected) {
      rmSync(claimPath, { force: true });
      return "retry";
    }
    // Verified: the path still holds exactly the inspected stale lock.
    // Waiting processes observe the fresh claim and never replace the path.
    unlinkSync(lockPath);
    rmSync(claimPath, { force: true });
    return "claimed";
  } catch (error) {
    rmSync(claimPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "retry";
  }
};

// Acquires an exclusive file lock with stale-lock recovery; resolves with a
// release function. The claim file is always `${lockPath}.claim`.
export const acquireFileLock = async (
  lockPath: string,
  timeoutMs: number
): Promise<() => void> => {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        const metadata: LockMetadata = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          owner,
        };
        writeFileSync(descriptor, JSON.stringify(metadata));
      } catch (error) {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
        throw error;
      }
      return () => {
        try {
          closeSync(descriptor);
        } catch {
          // The descriptor is already closed.
        }
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as { owner?: unknown };
          if (current.owner === owner) rmSync(lockPath, { force: true });
        } catch {
          // Unreadable or already removed locks need no further action.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && !(process.platform === "win32" && code === "EPERM")) throw error;
      const inspected = inspectLock(lockPath);
      if (inspected && inspected.recoverable) {
        const claimed = await claimStaleLock(lockPath, inspected.content);
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
