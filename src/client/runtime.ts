import {
  createAgentAnnotationsId,
  formatAgentAnnotationsHandoff,
  formatAgentAnnotationsShortcut,
  matchesAgentAnnotationsShortcut,
  MAX_TARGETS_PER_ANNOTATION,
  redactAgentAnnotationsMutationRequest,
  redactAgentAnnotationsTask,
  redactAgentAnnotationsText,
  resolveAgentAnnotationsPlacement,
  RevisionConflictError,
  toAgentAnnotationsDocumentRegion,
  validateAgentAnnotationsHandoffConfig,
} from "../core/index.js";
import { ClientExtensionRegistry } from "../extension/index.js";
import { createValidatedTaskTransport } from "./validated-transport.js";
import { isTaskIdentityNewer, taskIdentity } from "../core/transport.js";
import { PACKAGE_VERSION } from "../metadata.js";
import type {
  AgentAnnotation,
  AgentAnnotationsCaptureMode,
  AgentAnnotationsDiagnosticsEntry,
  AgentAnnotationsIconProps,
  AgentAnnotationsHostTheme,
  AgentAnnotationsMutationOperation,
  AgentAnnotationsRect,
  AgentAnnotationsScreenshotEvidenceMode,
  AgentAnnotationsTarget,
  AgentAnnotationsTask,
  HostIntegration,
  MountedAgentAnnotations,
  MountAgentAnnotationsOptions,
  StudioPublicApi,
  StudioPublicSnapshot,
  ToolbarCommandContext,
} from "../types/index.js";
import { Component, createElement, useLayoutEffect, useRef, useSyncExternalStore, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  disposeInspectionEngine,
  inspectTarget,
  resolvePersistedTarget,
  resolveTargetResult,
  sampleRegionTargets,
  setInspectionFrozen,
  targetBounds,
  targetFromEvent,
  targetAtPoint,
} from "./inspection-engine.js";
import { createBuiltinClientExtension } from "./builtin-extension.js";
import {
  validateAgentAnnotationsBuiltinsConfig,
  validateAgentAnnotationsInitialState,
} from "../core/configuration.js";
import {
  AnnotationsIcon,
  CaptureIcon,
  CloseIcon,
  CompleteIcon,
  DeleteIcon,
  GripIcon,
  ReopenIcon,
  SaveIcon,
} from "./icons.js";
import { captureViewportPng, type CapturedScreenshot, type ScreenshotRect } from "./screenshot.js";
import { AGENT_ANNOTATIONS_STYLES } from "./styles.js";

const HOST_ID = "agent-annotations-root";
const IGNORE_ATTRIBUTE = "data-react-grab-ignore";
type RegisteredToolbarContribution = ReturnType<
  ClientExtensionRegistry["getToolbarContributions"]
>[number];
type RegisteredTargetEnricher = ReturnType<
  ClientExtensionRegistry["getTargetEnrichers"]
>[number];

const isEditable = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return !!element?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element?.tagName ?? "");
};

const REGION_TARGET_CONCURRENCY = 4;

const mapBounded = async <T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
};

const pageContext = (host?: HostIntegration) => ({
  url: location.href,
  routeKey: host?.routeKey?.() ?? `${location.pathname}${location.search}${location.hash}`,
  title: document.title,
  viewport: { width: innerWidth, height: innerHeight },
  scroll: { x: scrollX, y: scrollY },
});

const now = (): string => new Date().toISOString();

const regionAnnotation = async (
  rect: AgentAnnotationsRect,
  elements: Element[],
  comment: string,
  host: HostIntegration | undefined,
  enrichers: readonly RegisteredTargetEnricher[],
  reportDiagnostic: (message: string) => void
): Promise<AgentAnnotation> => {
  const inspected = await mapBounded(
    elements,
    REGION_TARGET_CONCURRENCY,
    async (element) => {
      try {
        return { element, target: await inspectTarget(element, host) };
      } catch {
        // Uninspectable region elements are skipped; the region rect remains authoritative.
        return null;
      }
    }
  );
  const resolved = inspected
    .filter(
      (entry): entry is { element: Element; target: AgentAnnotationsTarget } => entry !== null
    )
    .slice(0, MAX_TARGETS_PER_ANNOTATION);
  const targets = resolved.map(({ target }) => target);
  const extensions: AgentAnnotation["extensions"] = {};
  for (const enricher of enrichers) {
    try {
      const values = await mapBounded(
        resolved,
        REGION_TARGET_CONCURRENCY,
        async ({ element, target }) =>
          enricher.enrich({ element, inspection: target.inspection })
      );
      const data = values.filter((value) => value !== null);
      if (data.length > 0) {
        extensions[enricher.extensionId] = {
          ...(extensions[enricher.extensionId] ?? {}),
          [enricher.id]: data.length === 1 ? data[0]! : { targets: data },
        };
      }
    } catch (error) {
      // A faulty enricher is skipped with a redacted diagnostic; capture continues.
      reportDiagnostic(`target enricher failed: ${String(error)}`);
    }
  }
  return {
    annotationId: createAgentAnnotationsId(),
    kind: "region",
    comment,
    status: "open",
    createdAt: now(),
    pageContext: pageContext(host),
    region: toAgentAnnotationsDocumentRegion(rect, { x: scrollX, y: scrollY }),
    targets,
    extensions,
  };
};

const elementAnnotation = async (
  kind: "element" | "multi",
  elements: Element[],
  comment: string,
  host: HostIntegration | undefined,
  enrichers: readonly RegisteredTargetEnricher[],
  reportDiagnostic: (message: string) => void
): Promise<AgentAnnotation> => {
  const targets = await Promise.all(elements.map((element) => inspectTarget(element, host)));
  const extensions: AgentAnnotation["extensions"] = {};
  for (const enricher of enrichers) {
    try {
      const values = await Promise.all(
        elements.map((element, index) =>
          enricher.enrich({ element, inspection: targets[index].inspection })
        )
      );
      const data = values.filter((value) => value !== null);
      if (data.length > 0) {
        extensions[enricher.extensionId] = {
          ...(extensions[enricher.extensionId] ?? {}),
          [enricher.id]: data.length === 1 ? data[0]! : { targets: data },
        };
      }
    } catch (error) {
      // A faulty enricher is skipped with a redacted diagnostic; capture continues.
      reportDiagnostic(`target enricher failed: ${String(error)}`);
    }
  }
  return {
    annotationId: createAgentAnnotationsId(),
    kind,
    comment,
    status: "open",
    createdAt: now(),
    pageContext: pageContext(host),
    targets,
    extensions,
  };
};

type PanelErrorBoundaryProps = {
  onError: (message: string) => void;
  children: import("react").ReactNode;
};
type PanelErrorBoundaryState = { failed: boolean };

class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PanelErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(String(error));
  }

  render(): import("react").ReactNode {
    if (this.state.failed) {
      return createElement("p", { className: "aa-panel-error" }, "Panel failed to render");
    }
    return this.props.children;
  }
}

export async function mountAgentAnnotations(
  options: MountAgentAnnotationsOptions
): Promise<MountedAgentAnnotations> {
  if (typeof document === "undefined") throw new Error("Agent Annotations requires a browser document");
  if (document.getElementById(HOST_ID)) throw new Error("Agent Annotations is already mounted");

  const registry = new ClientExtensionRegistry();
  const builtinsConfig = validateAgentAnnotationsBuiltinsConfig(options.builtins === false ? undefined : options.builtins);
  const initialState = validateAgentAnnotationsInitialState(options.initialState);
  const registrations: Array<() => void> = [];
  try {
    const builtin = options.builtins === false
      ? undefined
      : createBuiltinClientExtension({
          actions: builtinsConfig,
          shortcuts: builtinsConfig.shortcuts,
        });
    for (const extension of [...(builtin ? [builtin] : []), ...(options.extensions ?? [])]) {
      registrations.push(registry.register(extension));
    }
  } catch (error) {
    for (const unregister of registrations.reverse()) unregister();
    throw error;
  }
  const host = registry.getHostIntegration();

  // Unconditional transport boundary: every task entering the runtime is
  // schema-parsed, including third-party custom TaskTransport implementations.
  const transport = createValidatedTaskTransport(options.transport);

  const screenshotMode: AgentAnnotationsScreenshotEvidenceMode =
    options.screenshotEvidence ?? "auto";
  if (screenshotMode !== "auto" && screenshotMode !== "manual" && screenshotMode !== "off") {
    throw new TypeError(
      `screenshotEvidence must be "auto", "manual", or "off" (received ${options.screenshotEvidence})`
    );
  }
  // Strict, JSON-safe handoff configuration; it only shapes Copy output text.
  const handoff = validateAgentAnnotationsHandoffConfig(options.handoff);

  let task: AgentAnnotationsTask;
  try {
    task = await transport.read();
  } catch (error) {
    for (const unregister of registrations.reverse()) unregister();
    throw error;
  }
  let captureMode: AgentAnnotationsCaptureMode = "idle";
  let collapsed = initialState.collapsed ?? true;
  let markersVisible = initialState.markersVisible ?? true;
  let openPanel: StudioPublicSnapshot["openPanel"] = null;
  let selected: Element[] = [];
  let hover: Element | null = null;
  let composer:
    | { kind: "element" | "multi"; elements: Element[] }
    | { kind: "region"; rect: AgentAnnotationsRect; sampled: number; elements: Element[] }
    | null = null;
  let editingId: string | null = null;
  let areaStart: { x: number; y: number } | null = null;
  let areaRect: AgentAnnotationsRect | null = null;
  let status = "";
  let copyFallback = "";
  let dockPosition: { left: number; top: number } | null = null;
  let collapseAction: string | null = null;
  let pendingActions = new Set<string>();
  let focusPanel = false;
  let panelReturnAction: string | null = null;
  let studioRoot: Root | null = null;
  let studioRenders = 0;
  let destroyed = false;
  let routeKey = pageContext(host).routeKey;
  let hostLocale = host?.locale?.() ?? (document.documentElement.lang || "en-US");
  let hostTheme: AgentAnnotationsHostTheme = host?.theme?.() ?? "light";
  let appRoot: Element | Document = host?.appRoot?.() ?? document.body;
  let systemThemeCleanup: (() => void) | null = null;
  const effectiveTheme = (): "light" | "dark" =>
    hostTheme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : hostTheme;
  const applyTheme = (): void => {
    hostElement.dataset.theme = effectiveTheme();
  };
  const refreshSystemThemeListener = (): void => {
    const needsSystem = hostTheme === "system";
    if (needsSystem && !systemThemeCleanup) {
      const query = window.matchMedia?.("(prefers-color-scheme: dark)");
      if (query) {
        const onChange = (): void => {
          if (destroyed || hostTheme !== "system") return;
          applyTheme();
        };
        query.addEventListener("change", onChange);
        systemThemeCleanup = () => query.removeEventListener("change", onChange);
      }
    } else if (!needsSystem && systemThemeCleanup) {
      systemThemeCleanup();
      systemThemeCleanup = null;
    }
  };
  const applyRouteKey = (next: string) => {
    if (destroyed || next === routeKey) return;
    routeKey = next;
    if (captureMode !== "idle" || composer || editingId) {
      // Never persist old-route capture state under the new route key.
      setInspectionFrozen(false);
      clearCaptureDocuments();
      captureMode = "idle";
      selected = [];
      hover = null;
      areaStart = null;
      areaRect = null;
      composer = null;
      editingId = null;
    }
    scheduleFrame(() => {
      render();
      emit();
    });
  };
  const applyHostChange = (): void => {
    if (destroyed) return;
    const nextTheme = host?.theme?.() ?? "light";
    if (nextTheme !== hostTheme) {
      hostTheme = nextTheme;
      refreshSystemThemeListener();
      applyTheme();
    } else {
      refreshSystemThemeListener();
    }
    const nextLocale = host?.locale?.() ?? (document.documentElement.lang || "en-US");
    const nextMessages = { ...registry.getMessages(), ...host?.messages };
    if (nextLocale !== hostLocale || JSON.stringify(nextMessages) !== JSON.stringify(messages)) {
      hostLocale = nextLocale;
      messages = nextMessages;
      root.lang = hostLocale;
      shortcuts = buildShortcuts();
      render();
      emit();
    }
    const nextAppRoot = host?.appRoot?.() ?? document.body;
    if (nextAppRoot !== appRoot) {
      appRoot = nextAppRoot;
      trackedMarkerTargets = new WeakSet<Element>();
      if (captureMode !== "idle") {
        clearCaptureDocuments();
        bindCaptureDocument(captureDocumentOf());
      }
      scheduleMarkerRefresh();
      scheduleFrame(() => {
        render();
        emit();
      });
    }
    applyRouteKey(pageContext(host).routeKey);
  };
  const refreshRoute = () => applyRouteKey(pageContext(host).routeKey);
  const listeners = new Set<(snapshot: StudioPublicSnapshot) => void>();
  const uiListeners = new Set<() => void>();
  let uiSnapshot: StudioPublicSnapshot;
  const notifyUi = () => {
    for (const listener of uiListeners) listener();
  };
  const uiSubscribe = (listener: () => void): (() => void) => {
    uiListeners.add(listener);
    return () => uiListeners.delete(listener);
  };
  const uiGetSnapshot = (): StudioPublicSnapshot => uiSnapshot;
  const diagnostics: AgentAnnotationsDiagnosticsEntry[] = [];
  const cleanups: Array<() => void> = [];
  cleanups.push(() => {
    systemThemeCleanup?.();
    systemThemeCleanup = null;
  });
  const timers = new Set<number>();
  const frames = new Set<number>();
  let refreshCaptureDocuments = (): void => undefined;
  let clearCaptureDocuments = (): void => undefined;

  const scheduleTimer = (callback: () => void, delay: number): number => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!destroyed) callback();
    }, delay);
    timers.add(timer);
    return timer;
  };
  const cancelTimer = (timer: number): void => {
    window.clearTimeout(timer);
    timers.delete(timer);
  };

  // Browser runtime status: reported through the authenticated /heartbeat
  // path every 5 seconds and immediately after mount. The state is bounded,
  // redacted (route key), and never carries the token or sensitive text.
  const browserStatus = options.browserStatus ?? null;
  const runtimeId = createAgentAnnotationsId();
  const clientVersion = PACKAGE_VERSION;
  const mountedAt = now();
  let appliedSourceRevision: string | null = null;
  const sendBrowserHeartbeat = (): void => {
    if (destroyed || !browserStatus) return;
    const state = {
      // Protocol literal mirrored with the server parser (browser bundle must
      // stay free of server/node modules).
      schema: "agent-annotations.browser-state.v1",
      runtimeId,
      clientVersion,
      // Privacy: never persist a raw URL query; hash routes stay intact (the
      // server parser rejects only route keys that still contain a query).
      routeKey: redactAgentAnnotationsText(routeKey.split("?", 1)[0] ?? routeKey).slice(0, 500),
      taskId: task.taskId,
      taskRevision: task.taskRevision,
      appliedSourceRevision,
      mountedAt,
      lastHeartbeatAt: now(),
    };
    fetch(`${browserStatus.endpoint}/heartbeat`, {
      method: "POST",
      headers: {
        "x-agent-annotations-token": browserStatus.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(state),
    }).catch(() => {
      // The dev server may be restarting; the next heartbeat reconnects.
    });
  };
  const scheduleBrowserHeartbeat = (): void => {
    if (destroyed || !browserStatus) return;
    sendBrowserHeartbeat();
    scheduleTimer(scheduleBrowserHeartbeat, 5_000);
  };
  const applyReportedSourceRevision = (revision: string | null): void => {
    if (destroyed) return;
    if (revision !== null && !/^[0-9a-f]{64}$/i.test(revision)) return;
    appliedSourceRevision = revision?.toLowerCase() ?? null;
    // The report is immediately reflected in the browser state.
    sendBrowserHeartbeat();
  };
  // Runtime-owned, generation-guarded refresh: every refresh supersedes the
  // previous request, so a stale response can never regress the applied
  // revision. The generated Vite client calls this after mount and after
  // vite:afterUpdate; the runtime calls it on every accepted task change.
  let sourceRevisionRequest = 0;
  const refreshAppliedSourceRevision = (): void => {
    if (destroyed || !browserStatus) return;
    // The previous baseline is no longer trustworthy while a refresh is in
    // flight (it may fail or be superseded): clear it and heartbeat the
    // cleared state immediately, then fetch.
    appliedSourceRevision = null;
    sendBrowserHeartbeat();
    const request = ++sourceRevisionRequest;
    const run = async (): Promise<void> => {
      try {
        const response = await fetch(`${browserStatus.endpoint}/revision`, {
          headers: { "x-agent-annotations-token": browserStatus.token },
        });
        // A non-ok revision response is a failure: never parse or apply it.
        if (!response.ok) return;
        const payload = await response.json() as { sourceRevision?: unknown };
        if (request === sourceRevisionRequest && typeof payload.sourceRevision === "string") {
          applyReportedSourceRevision(payload.sourceRevision);
        }
      } catch {
        // Best-effort; the next refresh reconnects.
      }
    };
    run().catch(() => undefined);
  };
  const scheduleFrame = (callback: () => void): number => {
    const frame = window.requestAnimationFrame(() => {
      frames.delete(frame);
      if (!destroyed) callback();
    });
    frames.add(frame);
    return frame;
  };
  cleanups.push(() => {
    for (const timer of timers) window.clearTimeout(timer);
    for (const frame of frames) window.cancelAnimationFrame(frame);
    timers.clear();
    frames.clear();
  });
  if (transport.subscribe) {
    cleanups.push(transport.subscribe((next) => {
      // Identity rule: a different task id replaces the current task even at
      // revision 0; the same task id only advances on a larger revision.
      if (destroyed || !isTaskIdentityNewer(taskIdentity(next), taskIdentity(task))) return;
      task = next;
      refreshAppliedSourceRevision();
      scheduleFrame(() => {
        render();
        emit();
      });
    }));
  }

  const hostElement = document.createElement("div");
  hostElement.id = HOST_ID;
  hostElement.setAttribute("data-agent-annotations-root", "");
  hostElement.setAttribute(IGNORE_ATTRIBUTE, "");
  document.body.append(hostElement);
  const shadow = hostElement.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = AGENT_ANNOTATIONS_STYLES;
  shadow.append(style);
  const root = document.createElement("div");
  shadow.append(root);
  const uiMount = document.createElement("div");
  uiMount.className = "aa-ui";
  const overlayMount = document.createElement("div");
  overlayMount.className = "aa-overlays";
  root.append(uiMount, overlayMount);
  applyTheme();
  refreshSystemThemeListener();

  let messages = { ...registry.getMessages(), ...host?.messages };
  root.lang = hostLocale;

  const localized = (value: string | Readonly<Record<string, string>>): string =>
    typeof value === "string"
      ? (messages[value] ?? value)
      : value[hostLocale] ??
        value[hostLocale.split("-")[0]] ??
        value["en-US"] ??
        Object.values(value)[0] ??
        "";
  const platform = /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other";
  const toolbar = registry.getToolbarContributions();
  collapseAction = toolbar.find(
    (contribution) => contribution.id === "agent-annotations.builtin:toggle"
  )?.id ?? null;
  const collapseContribution = toolbar.find((contribution) => contribution.id === collapseAction);
  const buildShortcuts = () => toolbar.flatMap((contribution) =>
    contribution.shortcut
      ? [{
          id: contribution.id,
          extensionId: contribution.extensionId,
          label: localized(contribution.label),
          formatted: formatAgentAnnotationsShortcut(
            { id: contribution.id, ...contribution.shortcut },
            platform
          ),
          shortcut: contribution.shortcut,
        }]
      : []
  );
  let shortcuts = buildShortcuts();
  const exporters = registry.getExporters();

  const snapshot = (): StudioPublicSnapshot => ({
    task: structuredClone(task),
    captureMode,
    collapsed,
    markersVisible,
    openPanel,
    diagnostics: [...diagnostics],
    shortcuts,
    exporters: exporters.map(({ id, extensionId }) => ({ id, extensionId })),
    messages: { ...messages },
  });
  uiSnapshot = snapshot();
  const refreshChrome = () => {
    flushSync(() => {
      uiSnapshot = snapshot();
      notifyUi();
    });
  };
  const emit = () => {
    if (destroyed) return;
    refreshChrome();
    const value = uiSnapshot;
    for (const listener of listeners) listener(value);
  };
  const renderStatus = () => {
    overlayMount.querySelector(".aa-status")?.remove();
    if (!status) return;
    const toast = document.createElement("div");
    toast.className = "aa-status";
    toast.setAttribute("role", "status");
    toast.textContent = status;
    overlayMount.append(toast);
  };
  const renderMultiComplete = () => {
    overlayMount.querySelector(".aa-multi-complete")?.remove();
    if (captureMode !== "multi" || composer || selected.length < 2) return;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "aa-multi-complete";
    chip.setAttribute("aria-label", `Complete selection (${selected.length})`);
    chip.textContent = `Finish (${selected.length})`;
    chip.addEventListener("click", () => {
      if (destroyed || captureMode !== "multi" || composer) return;
      composer = { kind: "multi", elements: [...selected] };
      setInspectionFrozen(true, selected);
      render();
    });
    overlayMount.append(chip);
    positionMultiComplete();
  };
  const positionMultiComplete = () => {
    const chip = overlayMount.querySelector<HTMLElement>(".aa-multi-complete");
    const dock = root.querySelector<HTMLElement>(".aa-dock");
    if (!chip || !dock) return;
    const rect = dock.getBoundingClientRect();
    chip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - chip.offsetWidth - 8))}px`;
    chip.style.top = `${Math.max(8, rect.top - chip.offsetHeight - 8)}px`;
  };
  const setStatus = (message: string) => {
    if (destroyed) return;
    status = message;
    renderStatus();
    scheduleTimer(() => {
      if (status === message) {
        status = "";
        renderStatus();
      }
    }, 1800);
  };
  const mutate = async (operations: AgentAnnotationsMutationOperation[]): Promise<AgentAnnotationsTask | undefined> => {
    if (destroyed) return undefined;
    const attempt = async (expectedRevision: number): Promise<AgentAnnotationsTask | undefined> => {
      const redactors = registry.getRedactors().map((redactor) => ({
        extensionId: redactor.extensionId,
        id: redactor.id,
        redact: redactor.redact,
      }));
      // Every delegated mutation passes the unified boundary first: the
      // current task and request are validated, every data-carrying operation
      // is redacted (generic + extension redactors), and the redacted payload
      // is re-validated before the transport sees it.
      const redactedRequest = redactAgentAnnotationsMutationRequest(task, {
        taskId: task.taskId,
        expectedRevision,
        operations,
      }, redactors);
      const next = await transport.mutate(redactedRequest);
      if (destroyed) return undefined;
      // A successful mutation updates last-seen only when the identity rule
      // accepts it; an older result can never regress the current task.
      if (isTaskIdentityNewer(taskIdentity(next), taskIdentity(task))) {
        task = next;
        refreshAppliedSourceRevision();
        render();
        emit();
      }
      return next;
    };
    try {
      return await attempt(task.taskRevision);
    } catch (error) {
      if (destroyed || !(error instanceof RevisionConflictError)) throw error;
      // Adopt the latest task, then retry the rejected mutation exactly once.
      task = error.latestTask;
      refreshAppliedSourceRevision();
      render();
      emit();
      try {
        return await attempt(error.latestTask.taskRevision);
      } catch (retryError) {
        // A second conflict also adopts the latest task, then stops.
        if (destroyed || !(retryError instanceof RevisionConflictError)) throw retryError;
        task = retryError.latestTask;
        refreshAppliedSourceRevision();
        render();
        emit();
        throw retryError;
      }
    }
  };
  const mutateCommand = async (operations: AgentAnnotationsMutationOperation[]): Promise<void> => {
    await mutate(operations);
  };

  type ScreenshotEvidenceInput = {
    annotationId: string;
    taskId: string;
    taskRevision: number;
    routeKey: string;
  };

  const adoptTask = (candidate: AgentAnnotationsTask): void => {
    if (destroyed) return;
    if (isTaskIdentityNewer(taskIdentity(candidate), taskIdentity(task))) {
      task = candidate;
      refreshAppliedSourceRevision();
      render();
      emit();
    }
  };

  // Best-effort evidence write with exactly one conflict retry: the parsed
  // latest task is adopted (never overridden by an older identity), the retry
  // uses its revision, and a deleted annotation abandons the write. All
  // failures are recorded through the existing redacted diagnostics path.
  const writeScreenshotEvidence = async (
    input: ScreenshotEvidenceInput,
    screenshot: { png: string; width: number; height: number }
  ): Promise<boolean> => {
    const attempt = async (expectedRevision: number): Promise<void> => {
      const evidence = await transport.writeEvidence!({
        taskId: input.taskId,
        expectedRevision,
        annotationId: input.annotationId,
        png: screenshot.png,
        width: screenshot.width,
        height: screenshot.height,
      });
      if (!destroyed && routeKey === input.routeKey) adoptTask(evidence);
    };
    try {
      await attempt(input.taskRevision);
      return true;
    } catch (error) {
      if (destroyed || routeKey !== input.routeKey) return false;
      if (!(error instanceof RevisionConflictError)) {
        record("console", `screenshot evidence failed: ${String(error)}`);
        return false;
      }
      adoptTask(error.latestTask);
      const latest = error.latestTask;
      // Retry only for the same task identity: a replacement task that
      // reuses the annotation id must never receive an old-page screenshot.
      const stillExists =
        latest.taskId === input.taskId &&
        latest.annotations.some(
          (annotation) => annotation.annotationId === input.annotationId
        );
      if (!stillExists || destroyed || routeKey !== input.routeKey) return false;
      try {
        await attempt(latest.taskRevision);
        return true;
      } catch (retryError) {
        // A second conflict still adopts its parsed latest task and records
        // the diagnostic before any route/destroyed early return, so a
        // simultaneous route change never skips the required bookkeeping.
        // adoptTask and record guard `destroyed` internally; there is no
        // further retry and no status update from here.
        if (retryError instanceof RevisionConflictError) adoptTask(retryError.latestTask);
        record("console", `screenshot evidence failed: ${String(retryError)}`);
        return false;
      }
    }
  };

  // Background capture: the save UI never waits for it, failures never roll
  // back the annotation, and the promise is always explicitly handled. The
  // capture is deferred through the tracked timer so the save UI paints first
  // and an unmount cancels it before the synchronous DOM clone begins.
  const scheduleScreenshotEvidence = (
    input: ScreenshotEvidenceInput & { overlays: readonly ScreenshotRect[] }
  ): void => {
    scheduleTimer(() => {
      const run = async (): Promise<void> => {
        if (destroyed || routeKey !== input.routeKey) return;
        const screenshot = await captureViewportPng(input.overlays);
        if (!screenshot || destroyed || routeKey !== input.routeKey) return;
        await writeScreenshotEvidence(input, screenshot);
      };
      run().catch(() => {
        if (!destroyed) record("console", "screenshot evidence failed");
      });
    }, 0);
  };

  // Manual capture for an existing annotation on the current route: region
  // annotations use their persisted document rect (converted to viewport),
  // element/multi annotations use identity-validated live target bounds.
  const captureEvidence = async (annotationId: string): Promise<void> => {
    try {
      if (destroyed || screenshotMode === "off" || !transport.writeEvidence) return;
      const annotation = task.annotations.find((entry) => entry.annotationId === annotationId);
      if (!annotation) {
        setStatus("Annotation not found");
        return;
      }
      if (annotation.pageContext.routeKey !== routeKey) {
        setStatus("Annotation is on another route");
        return;
      }
      const capturedRouteKey = annotation.pageContext.routeKey;
      const overlays = annotation.region
        ? [{
            x: annotation.region.x - scrollX,
            y: annotation.region.y - scrollY,
            width: annotation.region.width,
            height: annotation.region.height,
          }]
        : (annotation.targets?.map((target) => {
              const resolution = resolvePersistedTarget(target, { appRoot, host });
              return resolution.status === "resolved" && isInAppRoot(resolution.element)
                ? targetBounds(resolution.element)
                : null;
            }) ?? [])
            .filter((rect): rect is AgentAnnotationsRect => rect !== null);
      // Snapshot the write input before the capture: the task identity must
      // never be read after screenshot generation.
      const input: ScreenshotEvidenceInput = {
        annotationId,
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        routeKey: capturedRouteKey,
      };
      const screenshot = await captureViewportPng(overlays);
      if (!screenshot || destroyed || routeKey !== input.routeKey) return;
      // The task identity was replaced while the capture was pending: abandon.
      if (task.taskId !== input.taskId) return;
      const saved = await writeScreenshotEvidence(input, screenshot);
      if (!destroyed && routeKey === input.routeKey) {
        setStatus(
          saved
            ? localized({ "en-US": "Screenshot captured", "zh-CN": "截图已保存" })
            : localized({ "en-US": "Screenshot failed", "zh-CN": "截图失败" })
        );
      }
    } catch (error) {
      if (!destroyed) record("console", `screenshot evidence failed: ${String(error)}`);
    }
  };

  const exportTask = async (
    filter: "open" | "all",
    exporterId?: string
  ): Promise<string> => {
    const redacted = redactAgentAnnotationsTask(
      task,
      registry.getRedactors().map((redactor) => ({
        extensionId: redactor.extensionId,
        id: redactor.id,
        redact: redactor.redact,
      }))
    ).task;
    if (exporterId) {
      const exporter = exporters.find(({ id }) => id === exporterId);
      if (!exporter) throw new TypeError(`Unknown exporter ID: ${exporterId}`);
      return exporter.export({ task: redacted, annotations: filter });
    }
    // The built-in default Copy is the Agent Handoff contract: instructions,
    // the browser-applied source revision baseline (or explicit unavailable),
    // and exact completion commands. A final generic text redaction over the
    // complete output keeps config/instruction interpolation from leaking.
    const output = formatAgentAnnotationsHandoff(redacted, {
      command: handoff.command,
      verificationCommands: handoff.verificationCommands,
      includeCompleted: handoff.includeCompleted || filter === "all",
      appliedSourceRevision,
    });
    // Final generic text redaction over the complete output. The task and the
    // bounded handoff config already bound the output, so this second pass
    // only replaces secret text and never truncates (a short secret can grow
    // the text, so an output-sized cap could still cut the tail).
    return redactAgentAnnotationsText(output, { maxLength: Number.POSITIVE_INFINITY });
  };
  const copyOutput = async (
    exporterId?: string,
    filter: "open" | "all" = "open"
  ): Promise<void> => {
    const output = await exportTask(filter, exporterId);
    if (destroyed) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(output);
      if (destroyed) return;
      copyFallback = "";
      setStatus("Copied open annotations");
    } catch {
      if (destroyed) return;
      copyFallback = output;
      render();
    }
  };
  const copyOpen = () => copyOutput();

  const setMarkersVisible = (visible: boolean) => {
    markersVisible = visible;
    render();
    emit();
  };
  const setCollapsed = (next: boolean) => {
    if (collapsed === next) return;
    collapsed = next;
    if (next && captureMode !== "idle") {
      // Collapsing cancels invisible capture interception while an open
      // composer/editor draft is deliberately preserved: refreshOverlays
      // carries live drafts into the rebuilt surfaces, so a full render both
      // clears the transient overlays (hover/area/multi chip) and keeps text.
      clearCaptureDocuments();
      setInspectionFrozen(false);
      captureMode = "idle";
      selected = [];
      hover = null;
      areaStart = null;
      areaRect = null;
    }
    render();
    emit();
  };
  const toggleCollapsed = () => setCollapsed(!collapsed);

  const clearTransientSelection = () => {
    setInspectionFrozen(false);
    selected = [];
    hover = null;
    areaStart = null;
    areaRect = null;
    composer = null;
  };
  const cancelCapture = () => {
    clearCaptureDocuments();
    captureMode = "idle";
    clearTransientSelection();
    render();
    emit();
  };
  const startCapture = (mode: Exclude<AgentAnnotationsCaptureMode, "idle">) => {
    captureMode = mode;
    selected = [];
    composer = null;
    editingId = null;
    openPanel = null;
    refreshCaptureDocuments();
    render();
    emit();
  };
  const focusAnnotation = (id: string) => {
    if (destroyed) return;
    const annotation = task.annotations.find((entry) => entry.annotationId === id);
    if (!annotation) return;
    if (annotation.pageContext.routeKey !== routeKey) {
      if (host?.navigate) {
        host.navigate(annotation.pageContext.routeKey);
        setStatus("Navigating to annotation route");
      } else {
        setStatus("Annotation is on another route");
      }
      return;
    }
    editingId = id;
    openPanel = null;
    render();
    scheduleFrame(() => overlayMount.querySelector<HTMLElement>(".aa-editor textarea")?.focus());
  };

  const api: StudioPublicApi = {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commands: {
      capture: {
        startPick: () => startCapture("pick"),
        startMulti: () => startCapture("multi"),
        startArea: () => startCapture("area"),
        cancel: cancelCapture,
      },
      annotations: {
        copyOpen,
        complete: (id) => mutateCommand([{ op: "complete", annotationId: id }]),
        reopen: (id) => mutateCommand([{ op: "reopen", annotationId: id }]),
        remove: (id) => mutateCommand([{ op: "remove", annotationId: id }]),
        removeCompleted: () => mutateCommand([{ op: "removeCompleted" }]),
        captureEvidence,
      },
      markers: {
        show: () => setMarkersVisible(true),
        hide: () => setMarkersVisible(false),
        focus: focusAnnotation,
      },
      panels: {
        open: (id) => {
          if (!registry.getPanels().some((panel) => panel.id === id)) {
            throw new TypeError(`Unknown panel ID: ${id}`);
          }
          openPanel = id;
          focusPanel = true;
          render();
          emit();
        },
        close: (id) => {
          if (!id || openPanel === id) {
            const returnAction = panelReturnAction;
            openPanel = null;
            panelReturnAction = null;
            render();
            emit();
            scheduleFrame(() => {
              if (returnAction) {
                root
                  .querySelector<HTMLElement>(`[data-action-id="${returnAction}"]`)
                  ?.focus();
              }
            });
          }
        },
      },
      toolbar: {
        toggleCollapsed,
      },
      exporters: {
        format: (id, annotations = "open") => exportTask(annotations, id),
        copy: (id, annotations = "open") => copyOutput(id, annotations),
      },
    },
  };

  const executeContribution = (
    contribution: RegisteredToolbarContribution
  ): void => {
    const current = snapshot();
    if (
      contribution.isVisible?.(current) === false &&
      contribution.id !== collapseAction
    ) return;
    if (contribution.isEnabled?.(current) === false) return;
    if (contribution.kind === "panel") {
      const panelId = contribution.panelId!;
      if (openPanel === panelId) api.commands.panels.close(panelId);
      else {
        panelReturnAction = contribution.id;
        api.commands.panels.open(panelId);
      }
      return;
    }
    const execute = async () => {
      if (pendingActions.has(contribution.id)) return; // No re-entry for the same action.
      pendingActions.add(contribution.id);
      render();
      try {
        await contribution.execute?.({
          studio: api,
          extensionId: contribution.extensionId,
        } satisfies ToolbarCommandContext);
      } catch (error) {
        if (destroyed) return;
        // A faulty optional action is caught and re-enabled; capture stays usable.
        record("console", `toolbar action failed: ${String(error)}`);
      } finally {
        if (destroyed) return;
        pendingActions.delete(contribution.id); // Only this action is released.
        render();
      }
    };
    void execute();
  };

  const iconMarkup = (Icon: ComponentType<AgentAnnotationsIconProps>): string =>
    renderToStaticMarkup(createElement(Icon, { className: "aa-icon" }));

  const iconButton = (
    label: string,
    Icon: ComponentType<AgentAnnotationsIconProps>,
    action?: () => void,
    attributes: Record<string, string> = {}
  ): HTMLButtonElement => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "aa-action";
    node.setAttribute("aria-label", attributes["aria-label"] ?? label);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    const slot = document.createElement("span");
    slot.className = "aa-icon-slot";
    slot.innerHTML = iconMarkup(Icon);
    node.append(slot);
    if (action) node.addEventListener("click", action);
    node.addEventListener("mouseenter", () => showTooltip(node));
    node.addEventListener("mouseleave", hideTooltip);
    return node;
  };

  const submitButton = (
    label: string,
    Icon: ComponentType<AgentAnnotationsIconProps>
  ): HTMLButtonElement => {
    const node = iconButton(label, Icon);
    node.type = "submit";
    node.className = "aa-button aa-icon-button aa-primary";
    return node;
  };

  let tooltipTimer: number | null = null;
  const hideTooltip = () => {
    if (tooltipTimer !== null) cancelTimer(tooltipTimer);
    tooltipTimer = null;
    overlayMount.querySelector(".aa-tooltip")?.remove();
  };
  const positionTooltip = (trigger: HTMLElement) => {
    const tooltip = overlayMount.querySelector<HTMLElement>(".aa-tooltip");
    if (!tooltip) return;
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.left, innerWidth - tooltip.offsetWidth - 4));
    const above = rect.top - 34;
    if (above >= 4) {
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${above}px`;
    } else {
      // Flip below the trigger and keep the tooltip fully onscreen.
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.min(rect.bottom + 8, innerHeight - tooltip.offsetHeight - 4)}px`;
    }
  };
  const showTooltip = (trigger: HTMLElement) => {
    hideTooltip();
    tooltipTimer = scheduleTimer(() => {
      tooltipTimer = null;
      const tooltip = document.createElement("div");
      tooltip.className = "aa-tooltip";
      tooltip.role = "tooltip";
      tooltip.textContent = trigger.getAttribute("aria-label") ?? "";
      overlayMount.append(tooltip);
      positionTooltip(trigger);
    }, 300);
  };

  const addOutline = (rect: AgentAnnotationsRect, region = false) => {
    const node = document.createElement("div");
    node.className = region ? "aa-outline" : "aa-outline";
    if (region) node.dataset.region = "true";
    Object.assign(node.style, {
      left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    overlayMount.append(node);
  };

  const renderMarkers = () => {
    const resolved: Element[] = [];
    if (!markersVisible) return resolved;
    task.annotations.forEach((annotation, index) => {
      if (annotation.status === "completed") return;
      if (annotation.pageContext.routeKey !== routeKey) return;
      if (annotation.region) {
        addOutline({
          x: annotation.region.x - scrollX,
          y: annotation.region.y - scrollY,
          width: annotation.region.width,
          height: annotation.region.height,
        }, true);
      }
      const target = annotation.targets?.[0]
        ? resolvePersistedTarget(annotation.targets[0], { appRoot, host })
        : null;
      const targetInRoot =
        target?.status === "resolved" && isInAppRoot(target.element)
          ? target.element
          : null;
      if (targetInRoot) resolved.push(targetInRoot);
      const rect = targetInRoot ? targetBounds(targetInRoot) : null;
      const anchor = rect
        ? { x: rect.x - 8, y: rect.y - 8 }
        : annotation.region
          ? { x: annotation.region.x - scrollX + annotation.region.width - 14, y: annotation.region.y - scrollY + 4 }
          : null;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "aa-marker";
      marker.dataset.status = annotation.status;
      marker.dataset.annotationId = annotation.annotationId;
      marker.setAttribute("aria-label", `Annotation ${index + 1}: edit`);
      marker.textContent = String(index + 1);
      marker.hidden = !anchor;
      if (anchor) Object.assign(marker.style, { left: `${anchor.x}px`, top: `${anchor.y}px` });
      marker.addEventListener("click", () => focusAnnotation(annotation.annotationId));
      overlayMount.append(marker);
    });
    return resolved;
  };

  const renderComposer = (previousDraft: string) => {
    if (!composer) return;
    const surface = document.createElement("form");
    surface.className = "aa-composer";
    surface.setAttribute("aria-label", "Annotation composer");
    const title = document.createElement("strong");
    title.textContent = composer.kind === "region"
      ? `Area (${composer.sampled} sampled targets)`
      : `${composer.kind === "multi" ? "Multi" : "Pick"} annotation`;
    const textarea = document.createElement("textarea");
    textarea.className = "aa-textarea";
    textarea.setAttribute("aria-label", "Annotation comment");
    textarea.placeholder = "Describe the requested change";
    textarea.value = previousDraft;
    const actions = document.createElement("div");
    actions.className = "aa-actions";
    const cancel = iconButton("Cancel", CloseIcon, cancelCapture);
    cancel.className = "aa-button aa-icon-button";
    const save = submitButton("Save annotation", SaveIcon);
    actions.append(cancel, save);
    surface.append(title, textarea, actions);
    surface.addEventListener("submit", async (event) => {
      event.preventDefault();
      const comment = textarea.value.trim();
      if (!comment) return textarea.focus();
      const submittedRouteKey = routeKey;
      save.disabled = true;
      try {
        const annotation = composer?.kind === "region"
          ? await regionAnnotation(
              composer.rect,
              composer.elements,
              comment,
              host,
              registry.getTargetEnrichers(),
              (message) => record("console", message)
            )
          : await elementAnnotation(
              composer!.kind,
              composer!.elements,
              comment,
              host,
              registry.getTargetEnrichers(),
              (message) => record("console", message)
            );
        if (destroyed || routeKey !== submittedRouteKey) return;
        const persisted = await mutate([{ op: "add", annotation }]);
        if (destroyed) return;
        // Copy the immutable data needed for background evidence, then close
        // the composer and show success immediately: the screenshot never
        // blocks the save and never rolls back the annotation.
        let evidenceInput: (ScreenshotEvidenceInput & { overlays: readonly ScreenshotRect[] }) | null = null;
        if (persisted && transport.writeEvidence && screenshotMode === "auto" && routeKey === submittedRouteKey) {
          const overlays = composer?.kind === "region"
            ? [{ ...composer.rect }]
            : composer?.elements.map((element) => ({ ...targetBounds(element) })) ?? [];
          evidenceInput = {
            annotationId: annotation.annotationId,
            taskId: persisted.taskId,
            taskRevision: persisted.taskRevision,
            routeKey: submittedRouteKey,
            overlays,
          };
        }
        clearTransientSelection();
        render();
        emit();
        setStatus("Annotation saved");
        if (evidenceInput) scheduleScreenshotEvidence(evidenceInput);
      } catch (error) {
        save.disabled = false;
        setStatus(error instanceof Error ? error.message : "Save failed");
      }
    });
    overlayMount.append(surface);
    positionComposer();
    scheduleFrame(() => textarea.focus());
  };

  const positionSurface = (surface: HTMLElement, anchor: AgentAnnotationsRect) => {
    const surfaceRect = surface.getBoundingClientRect();
    const edge = 8;
    const maxLeft = Math.max(edge, innerWidth - surfaceRect.width - edge);
    const maxTop = Math.max(edge, innerHeight - surfaceRect.height - edge);
    const below = anchor.y + anchor.height + edge;
    const preferredTop = below + surfaceRect.height <= innerHeight - edge
      ? below
      : anchor.y - edge - surfaceRect.height;
    surface.style.left = `${Math.min(Math.max(edge, anchor.x), maxLeft)}px`;
    surface.style.top = `${Math.min(Math.max(edge, preferredTop), maxTop)}px`;
  };

  function positionComposer(): void {
    const surface = overlayMount.querySelector<HTMLElement>(".aa-composer");
    if (!surface || !composer) return;
    const anchor = composer.kind === "region"
      ? composer.rect
      : composer.elements.at(-1)
        ? targetBounds(composer.elements.at(-1)!)
        : null;
    if (anchor) positionSurface(surface, anchor);
  }

  const positionEditor = () => {
    const surface = overlayMount.querySelector<HTMLElement>(".aa-editor");
    const marker = Array.from(overlayMount.querySelectorAll<HTMLElement>(".aa-marker"))
      .find((node) => node.dataset.annotationId === editingId);
    if (!surface || !marker || marker.hidden) return;
    const markerRect = marker.getBoundingClientRect();
    positionSurface(surface, {
      x: markerRect.x,
      y: markerRect.y,
      width: markerRect.width,
      height: markerRect.height,
    });
  };

  const renderEditor = (previousDraft: string | null) => {
    const annotation = task.annotations.find((entry) => entry.annotationId === editingId);
    if (!annotation) return;
    const surface = document.createElement("form");
    surface.className = "aa-editor";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", "Annotation editor");
    surface.dataset.annotationId = annotation.annotationId;
    const textarea = document.createElement("textarea");
    textarea.className = "aa-textarea";
    textarea.setAttribute("aria-label", "Annotation comment");
    textarea.value = previousDraft ?? annotation.comment;
    const actions = document.createElement("div");
    actions.className = "aa-actions";
    const save = submitButton("Save comment", SaveIcon);
    if (screenshotMode !== "off" && transport.writeEvidence) {
      const capture = iconButton(
        localized({ "en-US": "Capture screenshot", "zh-CN": "截图" }),
        CaptureIcon,
        () => { captureEvidence(annotation.annotationId).catch(() => undefined); }
      );
      capture.className = "aa-button aa-icon-button";
      actions.append(save, capture);
    } else {
      actions.append(save);
    }
    const statusButton = iconButton(
      annotation.status === "open" ? "Complete" : "Reopen",
      annotation.status === "open" ? CompleteIcon : ReopenIcon,
      async () => {
      await mutate([{ op: annotation.status === "open" ? "complete" : "reopen", annotationId: annotation.annotationId }]);
      }
    );
    statusButton.className = "aa-button aa-icon-button";
    const remove = iconButton("Delete", DeleteIcon, async () => {
      await mutate([{ op: "remove", annotationId: annotation.annotationId }]);
      if (destroyed) return;
      editingId = null;
      render();
    });
    remove.className = "aa-button aa-icon-button aa-danger";
    const close = iconButton("Close", CloseIcon, () => { editingId = null; render(); });
    close.className = "aa-button aa-icon-button";
    actions.append(statusButton, remove, close);
    surface.append(textarea, actions);
    surface.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await mutate([{ op: "update", annotationId: annotation.annotationId, comment: textarea.value }]);
        if (destroyed) return;
        editingId = null;
        render();
        setStatus("Comment saved");
      } catch (error) {
        if (destroyed) return;
        save.disabled = false;
        setStatus(error instanceof Error ? error.message : "Save failed");
      }
    });
    overlayMount.append(surface);
    positionEditor();
  };

  const positionPanel = () => {
    const dock = root.querySelector<HTMLElement>(".aa-dock");
    const panel = root.querySelector<HTMLElement>(".aa-panel");
    const contribution = registry.getPanels().find(({ id }) => id === openPanel);
    if (!dock || !panel || !contribution) return;
    const dockRect = dock.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const placement = resolveAgentAnnotationsPlacement({
      trigger: dockRect,
      viewport: { width: innerWidth, height: innerHeight },
      width: panelRect.width,
      maxHeight: panelRect.height,
      surfaceHeight: panelRect.height,
      preferredSide: contribution.placement === "auto"
        ? (dockRect.top >= innerHeight - dockRect.bottom ? "above" : "below")
        : contribution.placement ?? "above",
    });
    Object.assign(panel.style, {
      left: `${placement.left}px`,
      top: `${placement.top}px`,
      bottom: "auto",
    });
  };

  let drag: { x: number; y: number; left: number; top: number } | null = null;
  const dockPositionKey = (): string => `agent-annotations:dock-position:${task.taskId}`;
  const readDockPosition = (): { left: number; top: number } | null => {
    try {
      const raw = localStorage.getItem(dockPositionKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
      if (typeof parsed.left !== "number" || typeof parsed.top !== "number"
        || !Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) {
        return null;
      }
      return { left: parsed.left, top: parsed.top };
    } catch {
      return null;
    }
  };
  const persistDockPosition = (): void => {
    try {
      if (dockPosition) localStorage.setItem(dockPositionKey(), JSON.stringify(dockPosition));
    } catch {
      // Storage can be unavailable (private mode); position persistence is best-effort.
    }
  };
  const clampDockPosition = (): void => {
    const dock = root.querySelector<HTMLElement>(".aa-dock");
    if (!dock || !dockPosition) return;
    const left = Math.max(0, Math.min(innerWidth - dock.offsetWidth, dockPosition.left));
    const top = Math.max(0, Math.min(innerHeight - dock.offsetHeight, dockPosition.top));
    if (left !== dockPosition.left || top !== dockPosition.top) {
      dockPosition = { left, top };
    }
    dock.style.left = `${dockPosition.left}px`;
    dock.style.top = `${dockPosition.top}px`;
    dock.style.bottom = "auto";
  };
  let hoverOutline: HTMLElement | null = null;
  let areaNode: HTMLElement | null = null;
  let overlayFrame: number | null = null;

  const ToolbarButton = (props: {
    contribution: RegisteredToolbarContribution;
    label: string;
    shortcut?: StudioPublicSnapshot["shortcuts"][number];
    current: StudioPublicSnapshot;
  }): import("react").ReactNode => {
    const ref = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
      const node = ref.current!;
      const enter = () => showTooltip(node);
      const leave = () => hideTooltip();
      node.addEventListener("mouseenter", enter);
      node.addEventListener("mouseleave", leave);
      node.addEventListener("focus", enter);
      node.addEventListener("blur", leave);
      return () => {
        node.removeEventListener("mouseenter", enter);
        node.removeEventListener("mouseleave", leave);
        node.removeEventListener("focus", enter);
        node.removeEventListener("blur", leave);
      };
    }, []);
    const { contribution, label, shortcut, current } = props;
    const pressed = contribution.isPressed?.(current);
    return createElement("button", {
      ref,
      key: contribution.id,
      type: "button",
      className: "aa-action",
      disabled: pendingActions.has(contribution.id)
        || contribution.isEnabled?.(current) === false,
      "aria-label": `${label}${shortcut ? ` (${shortcut.formatted})` : ""}`,
      "data-action-id": contribution.id,
      ...(pressed !== undefined ? { "aria-pressed": String(pressed) } : {}),
      ...(contribution.kind === "panel"
        ? { "aria-expanded": String(current.openPanel === contribution.panelId) }
        : {}),
      ...(contribution.id === collapseAction ? { "data-toggle": "true" } : {}),
      onClick: () => executeContribution(contribution),
    }, createElement(contribution.icon, { className: "aa-icon" }));
  };

  const CollapsedCount = (props: {
    openCount: number;
    current: StudioPublicSnapshot;
  }): import("react").ReactNode => {
    const ref = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
      const node = ref.current!;
      const enter = () => showTooltip(node);
      const leave = () => hideTooltip();
      node.addEventListener("mouseenter", enter);
      node.addEventListener("mouseleave", leave);
      node.addEventListener("focus", enter);
      node.addEventListener("blur", leave);
      return () => {
        node.removeEventListener("mouseenter", enter);
        node.removeEventListener("mouseleave", leave);
        node.removeEventListener("focus", enter);
        node.removeEventListener("blur", leave);
      };
    }, []);
    const { openCount, current } = props;
    const listOpen = current.openPanel === "agent-annotations.builtin:list";
    const listPanel = registry.getPanels().find((panel) => panel.id === "agent-annotations.builtin:list");
    const listContribution = toolbar.find((entry) => entry.id === "agent-annotations.builtin:list");
    const collapseContributionId = toolbar.find((entry) => entry.id === "agent-annotations.builtin:toggle")?.id;
    const listShortcut = shortcuts.find((entry) => entry.id === "agent-annotations.builtin:list");
    const listLabel = listPanel ? localized(listPanel.title) : "Annotation list";
    const zeroLabel = listShortcut ? `${listLabel} (${listShortcut.formatted})` : listLabel;
    const hasList = listContribution !== undefined;
    const countLabel = openCount === 0 ? zeroLabel : `${openCount} open annotations`;
    const expandLabel = localized({ "en-US": "Expand toolbar", "zh-CN": "展开工具栏" });
    return createElement("button", {
      ref,
      type: "button",
      className: "aa-collapsed-count",
      "aria-label": hasList
        ? countLabel
        : `${expandLabel}${openCount > 0 ? ` (${openCount} open annotations)` : ""}`,
      "aria-expanded": String(hasList ? listOpen : false),
      // The expand id is a runtime chrome id, never a disabled builtin's id:
      // when both the list and the collapse builtins are absent, this control
      // still expands the dock with an accurate action identity.
      "data-action-id": listContribution?.id ?? collapseContributionId ?? "agent-annotations.builtin:expand",
      onClick: () => {
        if (listContribution) {
          // Route through the registered contribution so closing the panel
          // returns focus to this visible control (same data-action-id as
          // the toolbar list).
          executeContribution(listContribution);
        } else {
          // No list panel registered (list disabled or builtins:false): the
          // visible collapsed control expands the toolbar instead.
          setCollapsed(false);
        }
      },
    }, openCount === 0
      ? createElement(AnnotationsIcon, { className: "aa-icon" })
      : createElement("span", { className: "aa-count-badge" }, openCount > 99 ? "99+" : String(openCount)));
  };

  const StudioChrome = (): import("react").ReactNode => {
    studioRenders += 1;
    hostElement.dataset.studioRenders = String(studioRenders);
    const current = useSyncExternalStore(uiSubscribe, uiGetSnapshot);
    const openCount = current.task.annotations.filter((entry) => entry.status === "open").length;
    const dockRef = useRef<HTMLDivElement | null>(null);
    const gripRef = useRef<HTMLButtonElement | null>(null);
    const panelRef = useRef<HTMLElement | null>(null);
    const panelContribution = registry.getPanels().find(({ id }) => id === current.openPanel);

    useLayoutEffect(() => {
      const grip = gripRef.current!;
      const enter = () => showTooltip(grip);
      const leave = () => hideTooltip();
      grip.addEventListener("mouseenter", enter);
      grip.addEventListener("mouseleave", leave);
      grip.addEventListener("focus", enter);
      grip.addEventListener("blur", leave);
      return () => {
        grip.removeEventListener("mouseenter", enter);
        grip.removeEventListener("mouseleave", leave);
        grip.removeEventListener("focus", enter);
        grip.removeEventListener("blur", leave);
      };
    }, []);

    useLayoutEffect(() => {
      positionPanel();
      if (focusPanel && panelRef.current) {
        focusPanel = false;
        const panel = panelRef.current;
        scheduleFrame(() => {
          const target = panel.querySelector<HTMLElement>(
            "button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])"
          );
          if (target && target.isConnected) target.focus();
          else if (panel.isConnected) panel.focus();
        });
      }
    });

    return createElement("div", { className: "aa-chrome" },
      createElement("div", {
        ref: dockRef,
        className: "aa-dock",
        "data-collapsed": String(current.collapsed),
        style: dockPosition
          ? { left: `${dockPosition.left}px`, top: `${dockPosition.top}px`, bottom: "auto" }
          : undefined,
      },
        createElement("button", {
          ref: gripRef,
          type: "button",
          className: "aa-grip",
          "aria-label": "Drag toolbar",
          onPointerDown: (event: import("react").PointerEvent<HTMLButtonElement>) => {
            const dock = dockRef.current!;
            const rect = dock.getBoundingClientRect();
            drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
            event.currentTarget.setPointerCapture(event.pointerId);
          },
          onPointerMove: (event: import("react").PointerEvent<HTMLButtonElement>) => {
            if (!drag || !dockRef.current) return;
            dockPosition = {
              left: Math.max(0, Math.min(innerWidth - dockRef.current.offsetWidth, drag.left + event.clientX - drag.x)),
              top: Math.max(0, Math.min(innerHeight - dockRef.current.offsetHeight, drag.top + event.clientY - drag.y)),
            };
            dockRef.current.style.left = `${dockPosition.left}px`;
            dockRef.current.style.top = `${dockPosition.top}px`;
            dockRef.current.style.bottom = "auto";
            positionTooltip(gripRef.current!);
            positionPanel();
            positionMultiComplete();
          },
          onPointerUp: () => {
            drag = null;
            persistDockPosition();
          },
        }, createElement(GripIcon, { className: "aa-icon" })),
        ...(current.collapsed
          ? [createElement(CollapsedCount, { key: "collapsed-count", openCount, current })]
          : []),
        ...toolbar.flatMap((contribution) => {
          if (contribution.id === collapseAction) return [];
          const label = localized(contribution.label);
          const shortcut = shortcuts.find(({ id }) => id === contribution.id);
          if (contribution.isVisible?.(current) === false) {
            return [];
          }
          return [createElement(ToolbarButton, {
            key: contribution.id,
            contribution,
            label,
            shortcut,
            current,
          })];
        }),
        ...(collapseContribution
          ? [
              createElement("div", { key: "aa-divider", className: "aa-divider", role: "separator" }),
              createElement(ToolbarButton, {
                key: collapseContribution.id,
                contribution: collapseContribution,
                label: localized(collapseContribution.label),
                shortcut: shortcuts.find(({ id }) => id === collapseContribution.id),
                current,
              }),
            ]
          : [])
      ),
      panelContribution
        ? createElement("section", {
            key: panelContribution.id,
            ref: panelRef,
            className: "aa-panel",
            role: "dialog",
            "aria-modal": "false",
            tabIndex: -1,
            "aria-label": localized(panelContribution.title),
          },
            createElement("h2", null, localized(panelContribution.title)),
            createElement("div", null,
              createElement(PanelErrorBoundary, {
                onError: (message) => record("console", `panel render failed: ${message}`),
                children: createElement(panelContribution.render, {
                  studio: api,
                  close: () => api.commands.panels.close(panelContribution.id),
                }),
              })
            )
          )
        : null
    );
  };

  const refreshInteractiveOverlays = () => {
    overlayFrame = null;
    if (destroyed) return;
    if (captureMode === "idle" || captureMode === "area" || composer || !hover) {
      hoverOutline?.remove();
      hoverOutline = null;
    } else {
      if (!hoverOutline) {
        hoverOutline = document.createElement("div");
        hoverOutline.className = "aa-outline";
        overlayMount.append(hoverOutline);
      }
      const rect = hover.getBoundingClientRect();
      Object.assign(hoverOutline.style, {
        left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      });
    }
    if (areaRect) {
      if (!areaNode) {
        areaNode = document.createElement("div");
        areaNode.className = "aa-area";
        overlayMount.append(areaNode);
      }
      Object.assign(areaNode.style, {
        left: `${areaRect.x}px`, top: `${areaRect.y}px`, width: `${areaRect.width}px`, height: `${areaRect.height}px`,
      });
    } else {
      areaNode?.remove();
      areaNode = null;
    }
  };
  const scheduleInteractiveOverlays = () => {
    if (overlayFrame !== null) return;
    overlayFrame = scheduleFrame(refreshInteractiveOverlays);
  };

  const refreshOverlays = () => {
    if (destroyed) return;
    hideTooltip();
    if (overlayFrame !== null) {
      window.cancelAnimationFrame(overlayFrame);
      frames.delete(overlayFrame);
      overlayFrame = null;
    }
    // Live drafts are captured before the wipe so pending-action rebuilds never
    // lose what the user already typed into the composer or editor. An editor
    // draft only belongs to the annotation it was typed in: switching to another
    // annotation must never inherit the previous textarea.
    const composerDraft = overlayMount.querySelector<HTMLTextAreaElement>(".aa-composer textarea")?.value ?? "";
    const previousEditor = overlayMount.querySelector<HTMLElement>(".aa-editor");
    const editorDraft = previousEditor
      ? (previousEditor.dataset.annotationId === editingId
          ? previousEditor.querySelector<HTMLTextAreaElement>("textarea")?.value ?? null
          : null)
      : null;
    overlayMount.replaceChildren();
    // The shared tracked nodes were detached by replaceChildren: reset the references
    // so the next interactive refresh re-creates them exactly once.
    hoverOutline = null;
    areaNode = null;

    const markerTargets = renderMarkers();
    for (const element of selected) addOutline(element.getBoundingClientRect());
    // Hover and area outlines always go through the shared tracked nodes.
    refreshInteractiveOverlays();
    renderComposer(composerDraft);
    renderEditor(editorDraft);
    renderMultiComplete();
    if (copyFallback) {
      const fallback = document.createElement("div");
      fallback.className = "aa-copy-fallback";
      fallback.setAttribute("role", "dialog");
      fallback.setAttribute("aria-label", "Manual copy fallback");
      const textarea = document.createElement("textarea");
      textarea.className = "aa-textarea";
      textarea.readOnly = true;
      textarea.value = copyFallback;
      const close = iconButton("Close", CloseIcon, () => { copyFallback = ""; render(); });
      close.className = "aa-button aa-icon-button";
      fallback.append(textarea, close);
      overlayMount.append(fallback);
      scheduleFrame(() => textarea.select());
    }
    renderStatus();
    syncMarkerTracking([
      ...markerTargets,
      ...(composer && composer.kind !== "region" ? composer.elements : []),
    ]);
  };

  const render = () => {
    if (destroyed) return;
    refreshOverlays();
    refreshChrome();
  };

  const isHostEvent = (event: Event): boolean =>
    event.composedPath().includes(hostElement);
  const isInAppRoot = (element: Element): boolean => {
    const appRootIsDocument = appRoot.nodeType === 9;
    let current: Element | null = element;
    while (current) {
      if (appRootIsDocument) {
        if (current.ownerDocument === appRoot) return true;
      } else if (appRoot.contains(current)) {
        return true;
      }
      const frameElement: Element | null = current.ownerDocument.defaultView?.frameElement ?? null;
      if (!frameElement) return false;
      current = frameElement;
    }
    return false;
  };
  const resolveTargetInAppRoot = (selector: string): Element | null => {
    const result = resolveTargetResult(
      selector,
      appRoot.nodeType === 9 ? (appRoot as Document) : (appRoot as Element)
    );
    return result.status === "resolved" ? result.element : null;
  };
  const captureTargetFrom = (event: MouseEvent | PointerEvent): Element | null => {
    const target = targetFromEvent(event) ?? targetAtPoint(event.clientX, event.clientY);
    return target && isInAppRoot(target) ? target : null;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (captureMode === "idle" || composer || isHostEvent(event)) return;
    if (captureMode === "area" && areaStart) {
      areaRect = {
        x: Math.min(areaStart.x, event.clientX),
        y: Math.min(areaStart.y, event.clientY),
        width: Math.abs(event.clientX - areaStart.x),
        height: Math.abs(event.clientY - areaStart.y),
      };
      scheduleInteractiveOverlays();
      return;
    }
    hover = captureTargetFrom(event);
    scheduleInteractiveOverlays();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (captureMode !== "area" || composer || isHostEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    areaStart = { x: event.clientX, y: event.clientY };
    areaRect = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
  };
  const onPointerUp = (event: PointerEvent) => {
    if (captureMode !== "area" || !areaStart || !areaRect) return;
    if (isHostEvent(event)) {
      areaStart = null;
      areaRect = null;
      return render();
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = areaRect;
    areaStart = null;
    areaRect = null;
    if (rect.width < 8 || rect.height < 8) return render();
    const targets = sampleRegionTargets(rect).filter((entry) => isInAppRoot(entry));
    const sampled = targets.length;
    composer = { kind: "region", rect, sampled, elements: targets };
    if (targets.length > 0) setInspectionFrozen(true, targets);
    render();
  };
  const onClick = (event: MouseEvent) => {
    if ((captureMode !== "pick" && captureMode !== "multi") || composer || isHostEvent(event)) return;
    const target = captureTargetFrom(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (captureMode === "pick") {
      selected = [target];
      composer = { kind: "element", elements: [target] };
      setInspectionFrozen(true, [target]);
    } else if (event.detail === 2 && selected.length >= 2) {
      composer = { kind: "multi", elements: [...selected] };
      setInspectionFrozen(true, selected);
    } else {
      selected = selected.includes(target)
        ? selected.filter((entry) => entry !== target)
        : [...selected, target].slice(0, 50);
    }
    hover = null;
    render();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") hideTooltip();
    if (isHostEvent(event)) {
      if (event.key === "Escape" && openPanel) {
        event.preventDefault();
        api.commands.panels.close(openPanel);
        return;
      }
      if (event.key === "Escape" && captureMode !== "idle") {
        event.preventDefault();
        cancelCapture();
        return;
      }
      // Non-editable host chrome (toolbar buttons) still receives the global
      // shortcuts so keyboard-only flows keep working after focus lands there.
    }
    if (event.key === "Escape" && captureMode !== "idle") {
      event.preventDefault();
      return cancelCapture();
    }
    if (!isHostEvent(event) && captureMode === "multi" && event.key === "Enter"
      && selected.length >= 2 && !isEditable(event.target)) {
      event.preventDefault();
      composer = { kind: "multi", elements: [...selected] };
      setInspectionFrozen(true, selected);
      return render();
    }
    const shortcut = shortcuts.find((entry) => matchesAgentAnnotationsShortcut({
      id: entry.id,
      ...entry.shortcut,
    }, {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.isComposing,
      editable: isEditable(event.target),
    }, platform));
    if (!shortcut) return;
    event.preventDefault();
    const contribution = toolbar.find(({ id }) => id === shortcut.id);
    if (contribution) {
      // A capture shortcut in a collapsed dock expands the toolbar first and
      // then starts the capture mode; it is never a silent no-op.
      if (collapsed && contribution.group === "capture") setCollapsed(false);
      executeContribution(contribution);
    }
  };
  const record = (source: AgentAnnotationsDiagnosticsEntry["source"], value: unknown) => {
    if (destroyed) return;
    const entry: AgentAnnotationsDiagnosticsEntry = {
      source,
      message: redactAgentAnnotationsText(String(value), { maxLength: 500 }),
      timestamp: now(),
    };
    diagnostics.push(entry);
    if (diagnostics.length > 20) diagnostics.shift();
    emit();
    void transport.appendDiagnostics?.([entry]).catch(() => undefined);
  };
  const onError = (event: ErrorEvent) => record("window", event.message);
  const onRejection = (event: PromiseRejectionEvent) => record("promise", event.reason);
  const originalConsoleError = console.error;
  let recording = false;
  const onConsoleError = (...values: unknown[]) => {
    originalConsoleError.apply(console, values);
    if (recording) return;
    recording = true;
    try {
      record("console", values.map(String).join(" "));
    } finally {
      recording = false;
    }
  };
  console.error = onConsoleError;
  cleanups.push(() => {
    if (console.error === onConsoleError) console.error = originalConsoleError;
  });

  const captureDocuments = new Map<Document, () => void>();
  const captureDocumentOf = (): Document =>
    appRoot.nodeType === 9
      ? (appRoot as unknown as Document)
      : (appRoot as Element).ownerDocument!;
  const bindCaptureDocument = (captureDocument: Document): void => {
    if (captureDocuments.has(captureDocument)) return;
    for (const [type, listener] of [
      ["pointermove", onPointerMove], ["pointerdown", onPointerDown],
      ["pointerup", onPointerUp], ["click", onClick],
    ] as Array<[string, EventListener]>) captureDocument.addEventListener(type, listener, true);
    const cleanup = () => {
      for (const [type, listener] of [
        ["pointermove", onPointerMove], ["pointerdown", onPointerDown],
        ["pointerup", onPointerUp], ["click", onClick],
      ] as Array<[string, EventListener]>) captureDocument.removeEventListener(type, listener, true);
    };
    captureDocuments.set(captureDocument, cleanup);
    const frameScope: ParentNode = captureDocument === captureDocumentOf() ? appRoot : captureDocument;
    for (const frame of frameScope.querySelectorAll("iframe")) {
      const refresh = () => {
        try {
          if (frame.contentDocument) bindCaptureDocument(frame.contentDocument);
        } catch {
          // Cross-origin frames are explicitly unsupported and remain unresolved.
        }
      };
      frame.addEventListener("load", refresh);
      const baseCleanup = captureDocuments.get(captureDocument)!;
      captureDocuments.set(captureDocument, () => {
        frame.removeEventListener("load", refresh);
        baseCleanup();
      });
      try {
        if (frame.contentDocument) bindCaptureDocument(frame.contentDocument);
      } catch {
        // Cross-origin frames are explicitly unsupported and remain unresolved.
      }
    }
  };
  refreshCaptureDocuments = () => {
    clearCaptureDocuments();
    bindCaptureDocument(captureDocumentOf());
  };
  clearCaptureDocuments = () => {
    for (const cleanup of captureDocuments.values()) cleanup();
    captureDocuments.clear();
  };
  cleanups.push(clearCaptureDocuments);

  for (const [type, listener, target] of [
    ["keydown", onKeyDown as EventListener, window],
    ["error", onError as EventListener, window],
    ["unhandledrejection", onRejection as EventListener, window],
  ] satisfies Array<[string, EventListener, Window]>) {
    target.addEventListener(type, listener, true);
    cleanups.push(() => target.removeEventListener(type, listener, true));
  }
  let markerObserver: MutationObserver | null = null;
  let markerResizeObserver: ResizeObserver | null = null;
  let markerFrameCleanups: Array<() => void> = [];
  let markerFrames = new WeakSet<Element>();
  let markerDocuments = new WeakSet<Document>();
  let trackedMarkerTargets = new WeakSet<Element>();
  let markerFrame: number | null = null;
  let markerRefreshes = 0;
  const stopMarkerTracking = () => {
    markerObserver?.disconnect();
    markerResizeObserver?.disconnect();
    for (const cleanup of markerFrameCleanups.splice(0)) cleanup();
    markerFrames = new WeakSet<Element>();
    markerDocuments = new WeakSet<Document>();
    trackedMarkerTargets = new WeakSet<Element>();
    markerObserver = null;
    markerResizeObserver = null;
    if (markerFrame !== null) {
      window.cancelAnimationFrame(markerFrame);
      frames.delete(markerFrame);
      markerFrame = null;
    }
  };
  const scheduleMarkerRefresh = () => {
    if (markerFrame !== null) return;
    markerFrame = scheduleFrame(() => {
      markerFrame = null;
      const resolved: Element[] = [];
      for (const annotation of task.annotations) {
        if (annotation.pageContext.routeKey !== routeKey) continue;
        const marker = Array.from(overlayMount.querySelectorAll<HTMLElement>(".aa-marker"))
          .find((node) => node.dataset.annotationId === annotation.annotationId);
        if (!marker) continue;
        const target = annotation.targets?.[0]
          ? resolvePersistedTarget(annotation.targets[0], { appRoot, host })
          : null;
        const targetInRoot =
          target?.status === "resolved" && isInAppRoot(target.element)
            ? target.element
            : null;
        if (targetInRoot) resolved.push(targetInRoot);
        const rect = targetInRoot ? targetBounds(targetInRoot) : null;
        const anchor = rect
          ? { x: rect.x - 8, y: rect.y - 8 }
          : annotation.region
            ? { x: annotation.region.x - scrollX + annotation.region.width - 14, y: annotation.region.y - scrollY + 4 }
            : null;
        marker.hidden = !anchor;
        if (anchor) Object.assign(marker.style, { left: `${anchor.x}px`, top: `${anchor.y}px` });
      }
      positionComposer();
      positionEditor();
      markerRefreshes += 1;
      hostElement.dataset.markerRefreshes = String(markerRefreshes);
      if (resolved.some((target) => !trackedMarkerTargets.has(target))) {
        syncMarkerTracking(resolved);
      }
    });
  };
  const watchMarkerFrames = (scope: ParentNode, observeSetup: boolean): void => {
    for (const frame of scope.querySelectorAll("iframe")) {
      if (markerFrames.has(frame)) continue;
      markerFrames.add(frame);
      const refresh = () => {
        scheduleMarkerRefresh();
        try {
          const frameDocument = frame.contentDocument;
          if (frameDocument) {
            if (observeSetup && !markerDocuments.has(frameDocument)) {
              markerDocuments.add(frameDocument);
              const observer = new MutationObserver(refresh);
              observer.observe(frameDocument, { childList: true, subtree: true });
              markerFrameCleanups.push(() => observer.disconnect());
            }
            watchMarkerFrames(frameDocument, observeSetup);
            scheduleFrame(scheduleMarkerRefresh);
          }
        } catch {
          // Cross-origin frames are explicitly unsupported and remain unresolved.
        }
      };
      frame.addEventListener("load", refresh);
      markerFrameCleanups.push(() => frame.removeEventListener("load", refresh));
      refresh();
    }
  };
  const hasPersistedFrameTarget = (): boolean => task.annotations.some((annotation) =>
    annotation.status === "open" &&
    annotation.pageContext.routeKey === routeKey &&
    annotation.targets?.some(({ selector }) => selector.includes(">>iframe>>"))
  );
  const hasUnresolvedFrameTarget = (): boolean => task.annotations.some((annotation) => {
    const selector = annotation.status === "open" && annotation.pageContext.routeKey === routeKey
      ? annotation.targets?.[0]?.selector
      : undefined;
    if (!selector?.includes(">>iframe>>")) return false;
    const target = resolveTargetInAppRoot(selector);
    return !target || !isInAppRoot(target);
  });
  function syncMarkerTracking(targets: Element[]): void {
    stopMarkerTracking();
    const watchFrames = markersVisible && hasPersistedFrameTarget();
    trackedMarkerTargets = new WeakSet(targets);
    const hasElementComposer = composer && composer.kind !== "region";
    if ((!markersVisible || targets.length === 0) && !editingId && !hasElementComposer && !watchFrames) return;
    if (watchFrames) watchMarkerFrames(appRoot, hasUnresolvedFrameTarget());
    markerObserver = new MutationObserver(() => {
      if (watchFrames) watchMarkerFrames(appRoot, hasUnresolvedFrameTarget());
      scheduleMarkerRefresh();
    });
    const mutationOptions = { childList: true, subtree: true };
    markerObserver.observe(appRoot, mutationOptions);
    const observed = new Set<Node>([appRoot]);
    for (const target of targets) {
      for (const node of [target.ownerDocument.documentElement, target.getRootNode()]) {
        if (node && !observed.has(node)) {
          markerObserver.observe(node, mutationOptions);
          observed.add(node);
        }
      }
    }
    if (typeof ResizeObserver !== "undefined") {
      markerResizeObserver = new ResizeObserver(scheduleMarkerRefresh);
      for (const target of targets) markerResizeObserver.observe(target);
    }
  }
  hostElement.dataset.markerRefreshes = "0";
  cleanups.push(stopMarkerTracking);
  // Host subscriptions are registered only after every initialization is complete so
  // a synchronous first notification can never hit a not-yet-initialized binding.
  if (host?.subscribe) {
    cleanups.push(host.subscribe(() => applyHostChange()));
  } else {
    const onRouteEvent = () => refreshRoute();
    window.addEventListener("popstate", onRouteEvent);
    window.addEventListener("hashchange", onRouteEvent);
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const wrap = (
      original: typeof history.pushState
    ): typeof history.pushState =>
      function (this: History, ...args: Parameters<typeof history.pushState>) {
        const result = original.apply(this, args);
        refreshRoute();
        return result;
      };
    const pushState = wrap(originalPushState);
    const replaceState = wrap(originalReplaceState);
    history.pushState = pushState;
    history.replaceState = replaceState;
    cleanups.push(() => {
      window.removeEventListener("popstate", onRouteEvent);
      window.removeEventListener("hashchange", onRouteEvent);
      if (history.pushState === pushState) history.pushState = originalPushState;
      if (history.replaceState === replaceState) history.replaceState = originalReplaceState;
    });
  }

  const onViewport = () => {
    clampDockPosition();
    positionPanel();
    positionMultiComplete();
    if (markerObserver || editingId || composer) scheduleMarkerRefresh();
  };
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);
  cleanups.push(() => window.removeEventListener("resize", onViewport));
  cleanups.push(() => window.removeEventListener("scroll", onViewport, true));
  studioRoot = createRoot(uiMount);
  flushSync(() => studioRoot!.render(createElement(StudioChrome)));
  render();
  const savedDockPosition = readDockPosition();
  if (savedDockPosition) {
    dockPosition = savedDockPosition;
    clampDockPosition();
  }
  const setupCleanups: Array<() => void> = [];
  try {
    for (const extension of registry.getExtensions()) {
      const dispose = extension.setup?.({ studio: api });
      if (dispose) setupCleanups.push(dispose);
    }
  } catch (error) {
    studioRoot?.unmount();
    studioRoot = null;
    for (const dispose of setupCleanups.reverse()) dispose();
    for (const unregister of registrations.reverse()) unregister();
    for (const cleanup of cleanups.splice(0)) cleanup();
    hostElement.remove();
    throw error;
  }
  const unmount = () => {
    if (destroyed) return;
    destroyed = true;
    studioRoot?.unmount();
    studioRoot = null;
    delete hostElement.dataset.studioRenders;
    for (const dispose of setupCleanups.reverse()) dispose();
    for (const unregister of registrations.reverse()) unregister();
    for (const cleanup of cleanups.splice(0)) cleanup();
    listeners.clear();
    uiListeners.clear();
    disposeInspectionEngine();
    hostElement.remove();
  };
  // The browser status loop starts only after every setup step succeeded, so
  // a failed mount can never persist a browserConnected state.
  scheduleBrowserHeartbeat();
  return { api, unmount, refreshAppliedSourceRevision };
}
