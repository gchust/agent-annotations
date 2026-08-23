import { createAgentAnnotationsId } from "../../core/index.js";
import { PACKAGE_VERSION } from "../../metadata.js";
import type {
  AgentAnnotationsBrowserStatusConfig,
  AgentAnnotationsTask,
} from "../../types/index.js";
import { now } from "./annotated.js";
import {
  clearBrowserSessionState,
  restoreBrowserSessionState,
  saveBrowserSessionState,
} from "./browser-session.js";

type AnnotationHealth = Array<{
  annotationId: string;
  resolved: number;
  total: number;
  reason: "unresolved" | "identity mismatch" | "identity unverifiable" | "iframe unsupported" | null;
}>;

export type BrowserStatusBindings = {
  config: AgentAnnotationsBrowserStatusConfig | null;
  task(): AgentAnnotationsTask;
  setTaskValue(task: AgentAnnotationsTask): void;
  routeKey(): string;
  destroyed(): boolean;
  annotationHealth(): AnnotationHealth;
  resetResolutionSnapshots(): void;
  scheduleTimer(callback: () => void, delay: number): number;
};

const taskSourceFiles = (task: AgentAnnotationsTask): string[] => [
  ...new Set(task.annotations.flatMap((annotation) =>
    (annotation.targets ?? []).flatMap((target) =>
      [target.inspection.source, ...target.inspection.sourceStack]
        .flatMap((source) => source?.filePath ?? [])
    )
  )),
].sort();

export const createBrowserStatusController = (b: BrowserStatusBindings) => {
  const session = b.config
    ? restoreBrowserSessionState(b.config.endpoint, b.config.runtimeId)
    : { runtimeId: createAgentAnnotationsId(), browserUpdateRevision: 0 };
  const runtimeId = session.runtimeId;
  const mountedAt = now();
  let browserUpdateRevision = session.browserUpdateRevision;
  let referencedSourceRevision: string | null = null;
  let referencedSourceFiles = taskSourceFiles(b.task());
  let referencedSourceRevisionRequest = 0;
  let requestActive = false;
  let pendingHeartbeat: string | null = null;
  let heartbeatsStopped = false;

  const postHeartbeat = (body: string): void => {
    requestActive = true;
    const finish = () => {
      requestActive = false;
      if (heartbeatsStopped || b.destroyed()) {
        pendingHeartbeat = null;
        return;
      }
      const pending = pendingHeartbeat;
      pendingHeartbeat = null;
      if (pending !== null) postHeartbeat(pending);
    };
    try {
      void fetch(`${b.config!.endpoint}/heartbeat`, {
        method: "POST",
        headers: {
          "x-agent-annotations-token": b.config!.token,
          "content-type": "application/json",
        },
        body,
      }).then(finish, finish);
    } catch {
      finish();
    }
  };

  const sendHeartbeat = (): void => {
    if (heartbeatsStopped || b.destroyed() || !b.config) return;
    const snapshot = JSON.stringify({
      schema: "agent-annotations.browser-state.v2",
      runtimeId,
      clientVersion: PACKAGE_VERSION,
      routeKey: b.routeKey(),
      taskId: b.task().taskId,
      taskRevision: b.task().taskRevision,
      browserUpdateRevision,
      referencedSourceRevision,
      referencedSourceFiles: [...referencedSourceFiles],
      annotationHealth: b.annotationHealth().map((entry) => ({ ...entry })),
      mountedAt,
      lastHeartbeatAt: now(),
    });
    if (requestActive) {
      pendingHeartbeat = snapshot;
      return;
    }
    postHeartbeat(snapshot);
  };

  const stopHeartbeats = (): void => {
    heartbeatsStopped = true;
    pendingHeartbeat = null;
  };

  const setTask = (next: AgentAnnotationsTask): void => {
    const nextFiles = taskSourceFiles(next);
    if (nextFiles.length !== referencedSourceFiles.length ||
      nextFiles.some((file, index) => file !== referencedSourceFiles[index])) {
      referencedSourceRevision = null;
      referencedSourceFiles = nextFiles;
    }
    b.setTaskValue(next);
    b.resetResolutionSnapshots();
    sendHeartbeat();
  };

  const scheduleHeartbeat = (): void => {
    if (heartbeatsStopped || b.destroyed() || !b.config) return;
    b.resetResolutionSnapshots();
    sendHeartbeat();
    b.scheduleTimer(scheduleHeartbeat, 5_000);
  };

  const reportBrowserUpdate = (): void => {
    if (heartbeatsStopped || b.destroyed() || !b.config) return;
    // ponytail: Browser State v2 is safe-integer bounded; widen that schema to raise this ceiling.
    if (browserUpdateRevision === Number.MAX_SAFE_INTEGER) return;
    browserUpdateRevision += 1;
    saveBrowserSessionState(b.config.endpoint, { runtimeId, browserUpdateRevision });
    referencedSourceRevision = null;
    sendHeartbeat();
    const request = ++referencedSourceRevisionRequest;
    const reportedTaskId = b.task().taskId;
    const reportedTaskRevision = b.task().taskRevision;
    const run = async (): Promise<void> => {
      try {
        const response = await fetch(`${b.config!.endpoint}/revision`, {
          headers: { "x-agent-annotations-token": b.config!.token },
        });
        if (!response.ok) return;
        const payload = await response.json() as {
          taskId?: unknown;
          taskRevision?: unknown;
          referencedSourceRevision?: unknown;
          referencedSourceFiles?: unknown;
        };
        if (
          request === referencedSourceRevisionRequest &&
          b.task().taskId === reportedTaskId &&
          b.task().taskRevision === reportedTaskRevision &&
          payload.taskId === reportedTaskId &&
          payload.taskRevision === reportedTaskRevision &&
          (payload.referencedSourceRevision === null ||
            (typeof payload.referencedSourceRevision === "string" &&
              /^[0-9a-f]{64}$/i.test(payload.referencedSourceRevision))) &&
          Array.isArray(payload.referencedSourceFiles) &&
          payload.referencedSourceFiles.length <= 256 &&
          payload.referencedSourceFiles.every((file) =>
            typeof file === "string" && file.length > 0 && file.length <= 2_048) &&
          (payload.referencedSourceFiles.length > 0 || payload.referencedSourceRevision === null)
        ) {
          referencedSourceRevision = payload.referencedSourceRevision?.toLowerCase() ?? null;
          referencedSourceFiles = [...payload.referencedSourceFiles].sort();
          sendHeartbeat();
        }
      } catch {
        // Best-effort; the next browser update reconnects.
      }
    };
    run().catch(() => undefined);
  };

  const removeBrowserState = (): void => {
    if (!b.config) return;
    stopHeartbeats();
    clearBrowserSessionState(b.config.endpoint);
    fetch(`${b.config.endpoint}/heartbeat`, {
      method: "DELETE",
      headers: {
        "x-agent-annotations-token": b.config.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runtimeId }),
      keepalive: true,
    }).catch(() => undefined);
  };

  return {
    runtimeId,
    setTask,
    sendHeartbeat,
    stopHeartbeats,
    scheduleHeartbeat,
    reportBrowserUpdate,
    removeBrowserState,
    browserUpdateRevision: () => browserUpdateRevision,
    referencedSourceRevision: () => referencedSourceRevision,
  };
};
