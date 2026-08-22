import {
  prepareViewportSnapshot,
  renderPreparedSnapshotPng,
  type PreparedViewportSnapshot,
  type ScreenshotRect,
} from "../screenshot.js";
import { resolvePersistedTarget, targetBounds } from "../inspection-engine.js";
import { safeErrorText } from "./annotated.js";
import { RevisionConflictError } from "../../core/index.js";
import type {
  AgentAnnotationsRect,
  AgentAnnotationsTask,
  HostIntegration,
} from "../../types/index.js";

export type ScreenshotEvidenceInput = {
  annotationId: string;
  taskId: string;
  taskRevision: number;
  routeKey: string;
};

export type EvidenceBindings = {
  task(): AgentAnnotationsTask;
  routeKey(): string;
  destroyed(): boolean;
  screenshotMode(): "auto" | "manual" | "off";
  canWriteEvidence(): boolean;
  adoptTask(candidate: AgentAnnotationsTask): void;
  record(source: string, value: unknown): void;
  setStatus(message: string): void;
  localized(value: string | Readonly<Record<string, string>>, params?: Record<string, string | number>): string;
  scheduleTimer(callback: () => void, delay: number): number;
  appRoot(): Element | Document;
  host(): HostIntegration | undefined;
  isInAppRoot(element: Element): boolean;
  setInspectionFrozen(frozen: boolean, targets?: Element[]): void;
  transport(): {
    writeEvidence?(input: {
      taskId: string;
      expectedRevision: number;
      annotationId: string;
      png: string;
      width: number;
      height: number;
    }): Promise<AgentAnnotationsTask>;
  };
};

export type EvidenceController = {
  writeScreenshotEvidence(
    input: ScreenshotEvidenceInput,
    screenshot: { png: string; width: number; height: number }
  ): Promise<boolean>;
  prepareScreenshotEvidence(
    input: ScreenshotEvidenceInput & { overlays: readonly ScreenshotRect[] }
  ): (ScreenshotEvidenceInput & { snapshot: PreparedViewportSnapshot }) | null;
  scheduleScreenshotEvidence(input: ScreenshotEvidenceInput & { snapshot: PreparedViewportSnapshot }): void;
  captureEvidence(annotationId: string): Promise<void>;
};

export const createEvidenceController = (b: EvidenceBindings): EvidenceController => {
  // Best-effort evidence write with exactly one conflict retry: the parsed
  // latest task is adopted (never overridden by an older identity), the retry
  // uses its revision, and a deleted annotation abandons the write. All
  // failures are recorded through the existing redacted diagnostics path.
  const writeScreenshotEvidence = async (
    input: ScreenshotEvidenceInput,
    screenshot: { png: string; width: number; height: number }
  ): Promise<boolean> => {
    const attempt = async (expectedRevision: number): Promise<void> => {
      const evidence = await b.transport().writeEvidence!({
        taskId: input.taskId,
        expectedRevision,
        annotationId: input.annotationId,
        png: screenshot.png,
        width: screenshot.width,
        height: screenshot.height,
      });
      if (!b.destroyed() && b.routeKey() === input.routeKey) b.adoptTask(evidence);
    };
    try {
      await attempt(input.taskRevision);
      return true;
    } catch (error) {
      if (b.destroyed() || b.routeKey() !== input.routeKey) return false;
      if (!(error instanceof RevisionConflictError)) {
        b.record("console", `screenshot evidence failed: ${safeErrorText(error)}`);
        return false;
      }
      b.adoptTask(error.latestTask);
      const latest = error.latestTask;
      // Retry only for the same task identity: a replacement task that
      // reuses the annotation id must never receive an old-page screenshot.
      const stillExists =
        latest.taskId === input.taskId &&
        latest.annotations.some(
          (annotation) => annotation.annotationId === input.annotationId
        );
      if (!stillExists || b.destroyed() || b.routeKey() !== input.routeKey) return false;
      try {
        await attempt(latest.taskRevision);
        return true;
      } catch (retryError) {
        // A second conflict still adopts its parsed latest task and records
        // the diagnostic before any route/destroyed early return, so a
        // simultaneous route change never skips the required bookkeeping.
        // adoptTask and record guard `destroyed` internally; there is no
        // further retry and no status update from here.
        if (retryError instanceof RevisionConflictError) b.adoptTask(retryError.latestTask);
        b.record("console", `screenshot evidence failed: ${safeErrorText(retryError)}`);
        return false;
      }
    }
  };

  const prepareScreenshotEvidence = (
    input: ScreenshotEvidenceInput & { overlays: readonly ScreenshotRect[] }
  ): (ScreenshotEvidenceInput & { snapshot: PreparedViewportSnapshot }) | null => {
    const snapshot = prepareViewportSnapshot(input.overlays);
    if (!snapshot) {
      b.record("console", "screenshot evidence failed: snapshot preparation failed");
      return null;
    }
    const { overlays: _overlays, ...identity } = input;
    return { ...identity, snapshot };
  };

  // Background rendering and upload: the sanitized DOM snapshot already
  // exists, so unfreeze and save UI never wait for image decode or transport.
  const scheduleScreenshotEvidence = (
    input: ScreenshotEvidenceInput & { snapshot: PreparedViewportSnapshot }
  ): void => {
    b.scheduleTimer(() => {
      const run = async (): Promise<void> => {
        if (b.destroyed() || b.routeKey() !== input.routeKey) return;
        const screenshot = await renderPreparedSnapshotPng(input.snapshot);
        if (!screenshot || b.destroyed() || b.routeKey() !== input.routeKey) return;
        await writeScreenshotEvidence(input, screenshot);
      };
      run().catch(() => {
        if (!b.destroyed()) b.record("console", "screenshot evidence failed");
      });
    }, 0);
  };

  // Manual capture for an existing annotation on the current route: region
  // annotations use their persisted document rect (converted to viewport),
  // element/multi annotations use identity-validated live target bounds.
  const captureEvidence = async (annotationId: string): Promise<void> => {
    try {
      if (b.destroyed() || b.screenshotMode() === "off" || !b.canWriteEvidence()) return;
      const annotation = b.task().annotations.find((entry) => entry.annotationId === annotationId);
      if (!annotation) {
        b.setStatus(b.localized("Annotation not found"));
        return;
      }
      if (annotation.pageContext.routeKey !== b.routeKey()) {
        b.setStatus(b.localized("Annotation is on another route"));
        return;
      }
      const capturedRouteKey = annotation.pageContext.routeKey;
      const targets: Element[] = [];
      const overlays = annotation.region
        ? [{
            x: annotation.region.x - scrollX,
            y: annotation.region.y - scrollY,
            width: annotation.region.width,
            height: annotation.region.height,
          }]
        : (annotation.targets?.map((target) => {
              const resolution = resolvePersistedTarget(target, { appRoot: b.appRoot(), host: b.host() });
              if (resolution.status !== "resolved" || !b.isInAppRoot(resolution.element)) return null;
              targets.push(resolution.element);
              return targetBounds(resolution.element);
            }) ?? [])
            .filter((rect): rect is AgentAnnotationsRect => rect !== null);
      // Snapshot the write input before the capture: the task identity must
      // never be read after screenshot generation.
      const input: ScreenshotEvidenceInput = {
        annotationId,
        taskId: b.task().taskId,
        taskRevision: b.task().taskRevision,
        routeKey: capturedRouteKey,
      };
      let snapshot: PreparedViewportSnapshot | null = null;
      b.setInspectionFrozen(true, targets);
      try {
        snapshot = prepareViewportSnapshot(overlays);
      } finally {
        b.setInspectionFrozen(false);
      }
      if (!snapshot) {
        b.record("console", "screenshot evidence failed: snapshot preparation failed");
        b.setStatus(b.localized("Screenshot failed"));
        return;
      }
      const screenshot = await renderPreparedSnapshotPng(snapshot);
      if (!screenshot || b.destroyed() || b.routeKey() !== input.routeKey) return;
      // The task identity was replaced while the capture was pending: abandon.
      if (b.task().taskId !== input.taskId) return;
      const saved = await writeScreenshotEvidence(input, screenshot);
      if (!b.destroyed() && b.routeKey() === input.routeKey) {
        b.setStatus(
          saved
            ? b.localized("Screenshot captured")
            : b.localized("Screenshot failed")
        );
      }
    } catch (error) {
      if (!b.destroyed()) b.record("console", `screenshot evidence failed: ${safeErrorText(error)}`);
    }
  };

  return { writeScreenshotEvidence, prepareScreenshotEvidence, scheduleScreenshotEvidence, captureEvidence };
};
