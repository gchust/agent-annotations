import {
  createAgentAnnotationsId,
  formatAgentAnnotationsShortcut,
  formatAgentAnnotationsTask,
  matchesAgentAnnotationsShortcut,
  MAX_TARGETS_PER_ANNOTATION,
  redactAgentAnnotationsTask,
  redactAgentAnnotationsText,
  resolveAgentAnnotationsPlacement,
  RevisionConflictError,
  toAgentAnnotationsDocumentRegion,
} from "../core/index.js";
import { ClientExtensionRegistry } from "../extension/index.js";
import type {
  AgentAnnotation,
  AgentAnnotationsCaptureMode,
  AgentAnnotationsDiagnosticsEntry,
  AgentAnnotationsIconProps,
  AgentAnnotationsMutationOperation,
  AgentAnnotationsRect,
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
  resolveTarget,
  sampleRegionTargets,
  setInspectionFrozen,
  targetBounds,
  targetFromEvent,
  targetAtPoint,
} from "./inspection-engine.js";
import { builtinClientExtension } from "./builtin-extension.js";
import {
  CloseIcon,
  CompleteIcon,
  DeleteIcon,
  GripIcon,
  ReopenIcon,
  SaveIcon,
} from "./icons.js";
import { captureViewportPng } from "./screenshot.js";
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
  const registrations: Array<() => void> = [];
  try {
    for (const extension of [builtinClientExtension, ...(options.extensions ?? [])]) {
      registrations.push(registry.register(extension));
    }
  } catch (error) {
    for (const unregister of registrations.reverse()) unregister();
    throw error;
  }
  const host = registry.getHostIntegration();

  let task: AgentAnnotationsTask;
  try {
    task = await options.transport.read();
  } catch (error) {
    for (const unregister of registrations.reverse()) unregister();
    throw error;
  }
  let captureMode: AgentAnnotationsCaptureMode = "idle";
  let collapsed = false;
  let markersVisible = true;
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
  if (options.transport.subscribe) {
    cleanups.push(options.transport.subscribe((next) => {
      if (destroyed || next.taskRevision <= task.taskRevision) return;
      task = next;
      scheduleFrame(() => {
        render();
        emit();
      });
    }));
  }
  if (host?.subscribe) {
    cleanups.push(host.subscribe((next) => applyRouteKey(next)));
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

  const locale = host?.locale?.() ?? (document.documentElement.lang || "en-US");
  const messages = registry.getMessages();
  root.lang = locale;

  const localized = (value: string | Readonly<Record<string, string>>): string =>
    typeof value === "string"
      ? (messages[value] ?? value)
      : value[locale] ??
        value[locale.split("-")[0]] ??
        value["en-US"] ??
        Object.values(value)[0] ??
        "";
  const platform = /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other";
  const toolbar = registry.getToolbarContributions();
  const shortcuts = toolbar.flatMap((contribution) =>
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
      const redactedOperations = operations.map((operation) =>
        operation.op === "add"
          ? {
              ...operation,
              annotation: redactAgentAnnotationsTask(
                { ...task, annotations: [operation.annotation] },
                redactors
              ).task.annotations[0],
            }
          : operation
      );
      const next = await options.transport.mutate({
        taskId: task.taskId,
        expectedRevision,
        operations: redactedOperations,
      });
      if (destroyed) return undefined;
      task = next;
      render();
      emit();
      return next;
    };
    try {
      return await attempt(task.taskRevision);
    } catch (error) {
      if (destroyed || !(error instanceof RevisionConflictError)) throw error;
      // Adopt the latest task, then retry the rejected mutation exactly once.
      task = error.latestTask;
      render();
      emit();
      try {
        return await attempt(error.latestTask.taskRevision);
      } catch (retryError) {
        // A second conflict also adopts the latest task, then stops.
        if (destroyed || !(retryError instanceof RevisionConflictError)) throw retryError;
        task = retryError.latestTask;
        render();
        emit();
        throw retryError;
      }
    }
  };
  const mutateCommand = async (operations: AgentAnnotationsMutationOperation[]): Promise<void> => {
    await mutate(operations);
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
    const exporter = exporterId
      ? exporters.find(({ id }) => id === exporterId)
      : undefined;
    if (exporterId && !exporter) {
      throw new TypeError(`Unknown exporter ID: ${exporterId}`);
    }
    return exporter
      ? exporter.export({ task: redacted, annotations: filter })
      : formatAgentAnnotationsTask(redacted, { annotations: filter });
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
  const toggleCollapsed = () => {
    const before = snapshot();
    collapsed = !collapsed;
    collapseAction = collapsed
      ? toolbar.find(
          (contribution) =>
            contribution.isPressed?.(before) === false &&
            contribution.isPressed?.(snapshot()) === true
        )?.id ?? null
      : null;
    render();
    emit();
  };

  const cancelCapture = () => {
    setInspectionFrozen(false);
    clearCaptureDocuments();
    captureMode = "idle";
    selected = [];
    hover = null;
    areaStart = null;
    areaRect = null;
    composer = null;
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
    tooltip.style.left = `${Math.max(4, rect.left)}px`;
    tooltip.style.top = `${Math.max(4, rect.top - 34)}px`;
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
        ? resolveTarget(annotation.targets[0].selector)
        : null;
      if (target) resolved.push(target);
      const rect = target ? targetBounds(target) : null;
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

  const renderComposer = () => {
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
        if (persisted && options.transport.writeEvidence && routeKey === submittedRouteKey) {
          const overlays = composer?.kind === "region"
            ? [composer.rect]
            : composer?.elements.map(targetBounds) ?? [];
          const screenshot = await captureViewportPng(overlays);
          if (screenshot && !destroyed && routeKey === submittedRouteKey) {
            try {
              task = await options.transport.writeEvidence({
                taskId: persisted.taskId,
                expectedRevision: persisted.taskRevision,
                annotationId: annotation.annotationId,
                png: screenshot.png,
                width: screenshot.width,
                height: screenshot.height,
              });
              render();
              emit();
            } catch {
              // Screenshot evidence is explicitly best-effort; the annotation is authoritative.
            }
          }
        }
        if (destroyed) return;
        cancelCapture();
        setStatus("Annotation saved");
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

  const renderEditor = () => {
    const annotation = task.annotations.find((entry) => entry.annotationId === editingId);
    if (!annotation) return;
    const surface = document.createElement("form");
    surface.className = "aa-editor";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", "Annotation editor");
    const textarea = document.createElement("textarea");
    textarea.className = "aa-textarea";
    textarea.setAttribute("aria-label", "Annotation comment");
    textarea.value = annotation.comment;
    const actions = document.createElement("div");
    actions.className = "aa-actions";
    const save = submitButton("Save comment", SaveIcon);
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
    actions.append(save, statusButton, remove, close);
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
      return () => {
        node.removeEventListener("mouseenter", enter);
        node.removeEventListener("mouseleave", leave);
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

  const StudioChrome = (): import("react").ReactNode => {
    studioRenders += 1;
    hostElement.dataset.studioRenders = String(studioRenders);
    const current = useSyncExternalStore(uiSubscribe, uiGetSnapshot);
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
      return () => {
        grip.removeEventListener("mouseenter", enter);
        grip.removeEventListener("mouseleave", leave);
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
          },
          onPointerUp: () => { drag = null; },
        }, createElement(GripIcon, { className: "aa-icon" })),
        ...toolbar.flatMap((contribution) => {
          const label = localized(contribution.label);
          const shortcut = shortcuts.find(({ id }) => id === contribution.id);
          if (contribution.isVisible?.(current) === false && contribution.id !== collapseAction) {
            return [];
          }
          return [createElement(ToolbarButton, {
            key: contribution.id,
            contribution,
            label,
            shortcut,
            current,
          })];
        })
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
    overlayMount.replaceChildren();
    // The shared tracked nodes were detached by replaceChildren: reset the references
    // so the next interactive refresh re-creates them exactly once.
    hoverOutline = null;
    areaNode = null;

    const markerTargets = renderMarkers();
    for (const element of selected) addOutline(element.getBoundingClientRect());
    // Hover and area outlines always go through the shared tracked nodes.
    refreshInteractiveOverlays();
    renderComposer();
    renderEditor();
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
    hover = targetFromEvent(event) ?? targetAtPoint(event.clientX, event.clientY);
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
    const targets = sampleRegionTargets(rect);
    const sampled = targets.length;
    composer = { kind: "region", rect, sampled, elements: targets };
    if (targets.length > 0) setInspectionFrozen(true, targets);
    render();
  };
  const onClick = (event: MouseEvent) => {
    if ((captureMode !== "pick" && captureMode !== "multi") || composer || isHostEvent(event)) return;
    const target = targetFromEvent(event) ?? targetAtPoint(event.clientX, event.clientY);
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
    if (isHostEvent(event)) {
      if (event.key === "Escape" && openPanel) {
        event.preventDefault();
        api.commands.panels.close(openPanel);
      } else if (event.key === "Escape" && captureMode !== "idle") {
        event.preventDefault();
        cancelCapture();
      }
      return;
    }
    if (event.key === "Escape" && captureMode !== "idle") {
      event.preventDefault();
      return cancelCapture();
    }
    if (captureMode === "multi" && event.key === "Enter" && selected.length >= 2 && !isEditable(event.target)) {
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
    if (contribution) executeContribution(contribution);
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
    void options.transport.appendDiagnostics?.([entry]).catch(() => undefined);
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
    for (const frame of captureDocument.querySelectorAll("iframe")) {
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
  refreshCaptureDocuments = () => bindCaptureDocument(document);
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
          ? resolveTarget(annotation.targets[0].selector)
          : null;
        if (target) resolved.push(target);
        const rect = target ? targetBounds(target) : null;
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
  const appRoot = document.getElementById("root") ?? document.querySelector("main") ?? document.body;
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
    return !!selector?.includes(">>iframe>>") && !resolveTarget(selector);
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

  const onViewport = () => {
    positionPanel();
    if (markerObserver || editingId || composer) scheduleMarkerRefresh();
  };
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);
  cleanups.push(() => window.removeEventListener("resize", onViewport));
  cleanups.push(() => window.removeEventListener("scroll", onViewport, true));
  studioRoot = createRoot(uiMount);
  flushSync(() => studioRoot!.render(createElement(StudioChrome)));
  render();
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
  return { api, unmount };
}
