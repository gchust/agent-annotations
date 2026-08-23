import {
  formatAgentAnnotationsHandoff,
  formatAgentAnnotationsShortcut,
  matchesAgentAnnotationsShortcut,
  redactAgentAnnotationsTask,
  redactAgentAnnotationsText,
  resolveAgentAnnotationsPlacement,
  validateAgentAnnotationsHandoffConfig,
} from "../../core/index.js";
import { ClientExtensionRegistry } from "../../extension/index.js";
import { createValidatedTaskTransport } from "../validated-transport.js";
import { isTaskIdentityNewer, taskIdentity } from "../../core/transport.js";
import type {
  AgentAnnotationsCaptureMode,
  AgentAnnotationsHostTheme,
  AgentAnnotationsRect,
  AgentAnnotationsScreenshotEvidenceMode,
  AgentAnnotationsTask,
  MountedAgentAnnotations,
  MountAgentAnnotationsOptions,
  StudioPublicApi,
  StudioPublicSnapshot,
  ToolbarCommandContext,
} from "../../types/index.js";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  disposeInspectionEngine,
  sampleRegionTargets,
  setInspectionFrozen,
  targetFromEvent,
  targetAtPoint,
} from "../inspection-engine.js";
import { createBuiltinClientExtension } from "../builtin-extension.js";
import {
  validateAgentAnnotationsBuiltinsConfig,
  validateAgentAnnotationsDiagnosticsConfig,
  validateAgentAnnotationsInitialState,
} from "../../core/configuration.js";

import { localeMessages, MESSAGES } from "../messages.js";
import { CloseIcon } from "../icons.js";
import { AGENT_ANNOTATIONS_STYLES } from "../styles.js";
import {
  HOST_ID,
  IGNORE_ATTRIBUTE,
  createSafePageContext,
  isEditable,
  now,
  type RegisteredToolbarContribution,
} from "./annotated.js";
import { StudioChrome, type ChromeBindings } from "./chrome.js";
import { createMarkerController } from "./markers.js";
import { createDiagnosticsController } from "./diagnostics.js";
import { createTaskController } from "./task.js";
import { createEvidenceController } from "./evidence.js";
import { createCaptureController } from "./capture.js";
import { createGuardedHostIntegration, createHostController, type GuardedHostIntegration } from "./host.js";
import { createOverlayController } from "./overlays.js";
import { createBrowserStatusController } from "./browser-status.js";
import { createUiCommitCoordinator } from "./ui-state.js";

export async function mountAgentAnnotations(
  options: MountAgentAnnotationsOptions
): Promise<MountedAgentAnnotations> {
  if (typeof document === "undefined") throw new Error("Agent Annotations requires a browser document");
  if (document.getElementById(HOST_ID)) throw new Error("Agent Annotations is already mounted");

  const registry = new ClientExtensionRegistry();
  const builtinsConfig = validateAgentAnnotationsBuiltinsConfig(options.builtins === false ? undefined : options.builtins);
  const initialState = validateAgentAnnotationsInitialState(options.initialState);
  const registrations: Array<() => void> = [];
  const registrationByExtension = new Map<string, () => void>();
  let builtin: ReturnType<typeof createBuiltinClientExtension> | undefined;
  try {
    builtin = options.builtins === false
      ? undefined
      : createBuiltinClientExtension({
          actions: builtinsConfig,
          shortcuts: builtinsConfig.shortcuts,
        });
    for (const extension of [...(builtin ? [builtin] : []), ...(options.extensions ?? [])]) {
      const unregister = registry.register(extension);
      registrations.push(unregister);
      registrationByExtension.set(extension.id, unregister);
    }
  } catch (error) {
    for (const unregister of registrations.reverse()) unregister();
    throw error;
  }
  let host: GuardedHostIntegration | undefined;

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
  // Diagnostics capture configuration (console/network), both enabled by
  // default; the network patch only exists while the runtime is mounted.
  const diagnosticsConfig = validateAgentAnnotationsDiagnosticsConfig(options.diagnostics);

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
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  let collapseAction: string | null = null;
  let pendingActions = new Set<string>();
  let focusPanel = false;
  let panelReturnAction: string | null = null;
  let studioRoot: Root | null = null;
  let studioRenders = 0;
  let destroyed = false;
  let routeKey = createSafePageContext().routeKey;
  let hostLocale = document.documentElement.lang || "en-US";
  let hostTheme: AgentAnnotationsHostTheme = "light";
  let appRoot: Element | Document = document.body;
  const listeners = new Set<(snapshot: StudioPublicSnapshot) => void>();
  const uiListeners = new Set<() => void>();
  const notifyUi = () => {
    for (const listener of uiListeners) listener();
  };
  const uiSubscribe = (listener: () => void): (() => void) => {
    uiListeners.add(listener);
    return () => uiListeners.delete(listener);
  };
  let emit: () => void = () => undefined;
  let refreshChrome: () => void = () => undefined;

  const cleanups: Array<() => void> = [];
  cleanups.push(() => disposeSystemTheme());
  const timers = new Set<number>();
  const frames = new Set<number>();
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

  const browserStatus = options.browserStatus ?? null;
  let annotationHealth = (): Array<{
    annotationId: string;
    resolved: number;
    total: number;
    reason: "unresolved" | "identity mismatch" | "identity unverifiable" | "iframe unsupported" | null;
  }> => [];
  let resetHeartbeatResolutionSnapshots = (): void => undefined;
  const browserStatusController = createBrowserStatusController({
    config: browserStatus,
    task: () => task,
    setTaskValue: (next) => { task = next; },
    routeKey: () => routeKey,
    destroyed: () => destroyed,
    annotationHealth: () => annotationHealth(),
    resetResolutionSnapshots: () => resetHeartbeatResolutionSnapshots(),
    scheduleTimer,
  });
  const {
    runtimeId,
    setTask,
    sendHeartbeat: sendBrowserHeartbeat,
    stopHeartbeats: stopBrowserHeartbeats,
    scheduleHeartbeat: scheduleBrowserHeartbeat,
    reportBrowserUpdate,
    removeBrowserState,
  } = browserStatusController;
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
      setTask(next);
      scheduleFrame(() => commit());
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
  const hostController = createHostController({
    host: () => host,
    hostTheme: () => hostTheme,
    setHostTheme: (value) => { hostTheme = value; },
    hostLocale: () => hostLocale,
    setHostLocale: (value) => { hostLocale = value; },
    messages: () => messages,
    setMessages: (value) => { messages = value; },
    appRoot: () => appRoot,
    setAppRoot: (value) => { appRoot = value; },
    routeKey: () => routeKey,
    setRouteKey: (value) => {
      routeKey = value;
      resetHeartbeatResolutionSnapshots();
      sendBrowserHeartbeat();
    },
    pageContext: () => safePageContext(),
    shortcuts: () => shortcuts,
    setShortcuts: (value) => { shortcuts = value as typeof shortcuts; },
    captureMode: () => captureMode,
    setCaptureMode: (value) => { captureMode = value; },
    selected: () => selected,
    setSelected: (value) => { selected = value; },
    hover: () => hover,
    setHover: (value) => { hover = value; },
    areaStart: () => areaStart,
    setAreaStart: (value) => { areaStart = value; },
    areaRect: () => areaRect,
    setAreaRect: (value) => { areaRect = value; },
    composer: () => composer,
    setComposer: (value) => { composer = value; },
    editingId: () => editingId,
    setEditingId: (value) => { editingId = value; },
    editorAnchorRect: () => editorAnchorRect,
    setEditorAnchorRect: (value) => { editorAnchorRect = value; },
    registry: () => registry,
    hostElement: () => hostElement,
    root: () => root,
    destroyed: () => destroyed,
    buildShortcuts: () => buildShortcuts(),
    setMarkerHighlight: (id) => setMarkerHighlight(id),
    resetTrackedTargets: () => resetTrackedTargets(),
    setInspectionFrozen,
    clearCaptureDocuments: () => captureController.clearCaptureDocuments(),
    refreshCaptureDocuments: () => captureController.refreshCaptureDocuments(),
    scheduleMarkerRefresh: () => scheduleMarkerRefresh(),
    scheduleFrame,
    render: () => render(),
    commit: () => commit(),
  });
  const {
    applyTheme,
    refreshSystemThemeListener,
    applyHostChange,
    refreshRoute,
    disposeSystemTheme,
  } = hostController;
  applyTheme();
  refreshSystemThemeListener();

  // Host messages override registry messages override the builtin
  // dictionary: the host is always the last layer.
  let messages = {
    ...localeMessages(hostLocale),
    ...registry.getExtensionMessages(),
    ...host?.messages,
  };
  root.lang = hostLocale;

  const localized = (
    value: string | Readonly<Record<string, string>>,
    params?: Record<string, string | number>
  ): string => {
    let text: string;
    if (typeof value !== "string") {
      // Extension/host locale records keep their exact contract.
      text = value[hostLocale] ??
        value[hostLocale.split("-")[0]] ??
        value["en-US"] ??
        Object.values(value)[0] ??
        "";
    } else {
      const builtin = (MESSAGES as Record<string, Record<string, string> | undefined>)[value];
      text = messages[value] ?? builtin?.[hostLocale] ?? builtin?.["en-US"] ?? value;
    }
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name: string) =>
      params[name] !== undefined ? String(params[name]) : match
    );
  };
  const platform = /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other";
  let toolbar = registry.getToolbarContributions();
  collapseAction = toolbar.find(
    (contribution) => contribution.id === "agent-annotations.builtin:toggle"
  )?.id ?? null;
  let collapseContribution = toolbar.find((contribution) => contribution.id === collapseAction);
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
  let exporters = registry.getExporters();
  // Rebuild the registry-derived views after an isolated extension rollback
  // so no contribution, shortcut, host, panel, or message of the failed
  // extension survives in the running chrome.
  const refreshRegistryViews = (): void => {
    const registeredHost = registry.getHostRegistration();
    host = registeredHost
      ? createGuardedHostIntegration(registeredHost.extensionId, registeredHost.value, (method, error) =>
          recordExtensionFailure(registeredHost.extensionId, method === "pageContext" || method === "routeKey" ? "pageContext" : "host", method, error))
      : undefined;
    toolbar = registry.getToolbarContributions();
    collapseAction = toolbar.find(
      (contribution) => contribution.id === "agent-annotations.builtin:toggle"
    )?.id ?? null;
    collapseContribution = toolbar.find((contribution) => contribution.id === collapseAction);
    shortcuts = buildShortcuts();
    exporters = registry.getExporters();
    messages = {
      ...localeMessages(hostLocale),
      ...registry.getExtensionMessages(),
      ...host?.messages,
    };
    // Re-derive every host-derived state (theme/locale/messages/appRoot/route)
    // from the surviving host; a rolled-back failed host leaves the defaults.
    applyHostChange();
    commit();
  };

  const diagnosticsController = createDiagnosticsController({
    registry,
    transport: () => transport,
    scheduleFrame: (cb) => scheduleFrame(cb),
    emit: () => emit(),
    refreshChrome: () => refreshChrome(),
    browserStatus: () => browserStatus,
    destroyed: () => destroyed,
  });
  const {
    diagnostics,
    record,
    recordExtensionFailure,
    guardedPredicate,
    guardedRedactors,
    onError,
    onRejection,
    installConsoleLogging,
    installNetworkDiagnostics,
  } = diagnosticsController;
  const safePageContext = () => createSafePageContext(host, (error) => recordExtensionFailure(
    host?.extensionId ?? "host",
    "pageContext",
    undefined,
    error
  ));
  const registeredHost = registry.getHostRegistration();
  host = registeredHost
    ? createGuardedHostIntegration(registeredHost.extensionId, registeredHost.value, (method, error) =>
        recordExtensionFailure(registeredHost.extensionId, method === "pageContext" || method === "routeKey" ? "pageContext" : "host", method, error))
    : undefined;
  hostLocale = host?.locale?.() ?? hostLocale;
  hostTheme = host?.theme?.() ?? hostTheme;
  appRoot = host?.appRoot?.() ?? appRoot;
  messages = {
    ...localeMessages(hostLocale),
    ...registry.getExtensionMessages(),
    ...host?.messages,
  };
  root.lang = hostLocale;
  applyTheme();
  refreshSystemThemeListener();
  routeKey = safePageContext().routeKey;
  if (diagnosticsConfig.console !== false) {
    cleanups.push(installConsoleLogging());
  }
  const unsubscribeNetworkDiagnostics = diagnosticsConfig.network === false
    ? null
    : installNetworkDiagnostics();
  if (unsubscribeNetworkDiagnostics) {
    cleanups.push(unsubscribeNetworkDiagnostics);
  }

  const taskController = createTaskController({
    task: () => task,
    setTask,
    transport: () => transport,
    guardedRedactors,
    commit: () => commit(),
    destroyed: () => destroyed,
  });
  const { mutate, adoptTask, mutateCommand } = taskController;

  const evidenceController = createEvidenceController({
    task: () => task,
    routeKey: () => routeKey,
    destroyed: () => destroyed,
    screenshotMode: () => screenshotMode,
    canWriteEvidence: () => !!transport.writeEvidence,
    adoptTask,
    record,
    setStatus: (message) => setStatus(message),
    localized: (value, params) => localized(value, params),
    scheduleTimer,
    appRoot: () => appRoot,
    host: () => host,
    isInAppRoot: (element) => isInAppRoot(element),
    setInspectionFrozen,
    transport: () => transport,
  });
  const { prepareScreenshotEvidence, scheduleScreenshotEvidence, captureEvidence } = evidenceController;

  const publicPayload = (): StudioPublicSnapshot => ({
      task,
      captureMode,
      collapsed,
      markersVisible,
      openPanel,
      diagnostics: [...diagnostics],
      shortcuts,
      exporters: exporters.map(({ id, extensionId }) => ({ id, extensionId })),
      messages: { ...messages },
    });
  let commitCoordinator: ReturnType<typeof createUiCommitCoordinator> | null = null;
  const snapshot = (): StudioPublicSnapshot => commitCoordinator!.getSnapshot();
  refreshChrome = () => commitCoordinator?.refreshChrome();
  emit = () => {
    if (destroyed) return;
    commitCoordinator?.commitPublic();
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
    chip.setAttribute("aria-label", localized("Complete selection", { count: selected.length }));
    chip.textContent = localized("Finish", { count: selected.length });
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
  // Best-effort evidence write with exactly one conflict retry: the parsed
  // latest task is adopted (never overridden by an older identity), the retry
  // uses its revision, and a deleted annotation abandons the write. All
  // failures are recorded through the existing redacted diagnostics path.
  const exportTask = async (
    filter: "open" | "all",
    exporterId?: string
  ): Promise<string> => {
    const redacted = redactAgentAnnotationsTask(task, guardedRedactors()).task;
    if (exporterId) {
      const exporter = exporters.find(({ id }) => id === exporterId);
      if (!exporter) throw new TypeError(`Unknown exporter ID: ${exporterId}`);
      try {
        return await exporter.export({ task: redacted, annotations: filter });
      } catch (error) {
        recordExtensionFailure(exporter.extensionId, "export", exporter.id, error);
        throw error;
      }
    }
    // The built-in default Copy is the Agent Handoff contract: instructions,
    // the browser update generation baseline and referenced-source evidence,
    // plus exact completion commands. A final generic text redaction over the
    // complete output keeps config/instruction interpolation from leaking.
    const output = formatAgentAnnotationsHandoff(redacted, {
      command: handoff.command,
      verificationCommands: handoff.verificationCommands,
      includeCompleted: handoff.includeCompleted || filter === "all",
      browserUpdateRevision: browserStatusController.browserUpdateRevision(),
      referencedSourceRevision: browserStatusController.referencedSourceRevision(),
      runtimeId,
      routeKey,
      generatedAt: now(),
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
      setStatus(localized("Copied open annotations"));
    } catch {
      if (destroyed) return;
      copyFallback = output;
      render();
    }
  };
  const copyOpen = () => copyOutput();
  let editorAnchorRect: AgentAnnotationsRect | null = null;
  // Lazy wrappers: positionComposer/positionEditor/isInAppRoot are declared
  // later in the mount closure, so bindings must not evaluate them at creation.
  const markers = createMarkerController({
    task: () => task,
    routeKey: () => routeKey,
    markersVisible: () => markersVisible,
    appRoot: () => appRoot,
    host: () => host,
    overlayMount: () => overlayMount,
    hostElement: () => hostElement,
    editingId: () => editingId,
    hasElementComposer: () => !!composer && composer.kind !== "region",
    scheduleFrame,
    cancelFrame: (frame) => {
      window.cancelAnimationFrame(frame);
      frames.delete(frame);
    },
    isInAppRoot: (element) => isInAppRoot(element),
    positionComposer: () => positionComposer(),
    positionEditor: () => positionEditor(),
    localized: (value, params) => localized(value, params),
    resolutionChanged: () => {
      refreshChrome();
      sendBrowserHeartbeat();
    },
  });
  const {
    resolutionSnapshot,
    resetResolutionSnapshots,
    setMarkerHighlight,
    renderMarkerHighlights,
    stopMarkerTracking,
    resetTrackedTargets,
    scheduleMarkerRefresh,
    syncMarkerTracking,
  } = markers;
  resetHeartbeatResolutionSnapshots = resetResolutionSnapshots;
  annotationHealth = () => task.annotations
    .filter((annotation) => annotation.status === "open" && annotation.pageContext.routeKey === routeKey)
    .map((annotation) => ({ annotationId: annotation.annotationId, ...resolutionSnapshot(annotation).summary }));

  const overlays = createOverlayController({
    localized: (value, params) => localized(value, params),
    scheduleTimer,
    cancelTimer,
    scheduleFrame,
    overlayMount: () => overlayMount,
    root: () => root,
    task: () => task,
    routeKey: () => routeKey,
    pageContext: () => safePageContext(),
    markersVisible: () => markersVisible,
    editingId: () => editingId,
    editorAnchorRect: () => editorAnchorRect,
    composer: () => composer,
    cancelCapture: () => cancelCapture(),
    render: () => render(),
    destroyed: () => destroyed,
    screenshotMode: () => screenshotMode,
    canWriteEvidence: () => !!transport.writeEvidence,
    host: () => host,
    enrichers: () => registry.getTargetEnrichers(),
    mutate,
    recordExtensionFailure,
    focusAnnotation: (id) => focusAnnotation(id),
    closeEditor: () => closeEditor(),
    captureEvidence,
    clearTransientSelection: () => clearTransientSelection(),
    prepareScreenshotEvidence: (input) => prepareScreenshotEvidence(input),
    scheduleScreenshotEvidence: (input) => scheduleScreenshotEvidence(input),
    setStatus: (message) => setStatus(message),
    markers: {
      resolutionSnapshot,
      setMarkerHighlight,
    },
  });
  const {
    iconButton,
    showTooltip,
    hideTooltip,
    positionTooltip,
    addOutline,
    renderMarkers,
    renderComposer,
    renderEditor,
    positionComposer,
    positionEditor,
  } = overlays;

  const captureDocumentOf = (): Document =>
    appRoot.nodeType === 9
      ? (appRoot as unknown as Document)
      : (appRoot as Element).ownerDocument!;
  const captureController = createCaptureController({
    markersVisible: () => markersVisible,
    setMarkersVisibleValue: (value) => { markersVisible = value; },
    collapsed: () => collapsed,
    setCollapsedValue: (value) => { collapsed = value; },
    captureMode: () => captureMode,
    setCaptureModeValue: (value) => { captureMode = value; },
    selected: () => selected,
    setSelectedValue: (value) => { selected = value; },
    hover: () => hover,
    setHoverValue: (value) => { hover = value; },
    composer: () => composer,
    setComposerValue: (value) => { composer = value; },
    editingId: () => editingId,
    setEditingIdValue: (value) => { editingId = value; },
    openPanel: () => openPanel,
    setOpenPanelValue: (value) => { openPanel = value; },
    areaStart: () => areaStart,
    setAreaStartValue: (value) => { areaStart = value; },
    areaRect: () => areaRect,
    setAreaRectValue: (value) => { areaRect = value; },
    editorAnchorRect: () => editorAnchorRect,
    setEditorAnchorRectValue: (value) => { editorAnchorRect = value; },
    task: () => task,
    destroyed: () => destroyed,
    routeKey: () => routeKey,
    host: () => host,
    overlayMount: () => overlayMount,
    root: () => root,
    scheduleFrame,
    render: () => render(),
    commit: () => commit(),
    setStatus: (message) => setStatus(message),
    localized: (value, params) => localized(value, params),
    captureListeners: () => [
      ["pointermove", onPointerMove as EventListener],
      ["pointerdown", onPointerDown as EventListener],
      ["pointerup", onPointerUp as EventListener],
      ["click", onClick as EventListener],
    ],
    appRoot: () => appRoot,
    captureDocumentOf: () => captureDocumentOf(),
    setInspectionFrozen,
    setMarkerHighlight,
  });
  const {
    setMarkersVisible,
    setCollapsed,
    toggleCollapsed,
    clearTransientSelection,
    cancelCapture,
    startCapture,
    closeEditor,
    focusAnnotation,
    refreshCaptureDocuments,
    clearCaptureDocuments,
  } = captureController;
  // Unmount and failure teardown must remove every capture document and
  // iframe listener binding (same lifecycle guarantee as the pre-split mount).
  cleanups.push(clearCaptureDocuments);

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
        targetSummary: (annotationId) => {
          const annotation = task.annotations.find((entry) => entry.annotationId === annotationId);
          return annotation
            ? resolutionSnapshot(annotation).summary
            : { resolved: 0, total: 0, reason: null };
        },
      },
      markers: {
        show: () => setMarkersVisible(true),
        hide: () => setMarkersVisible(false),
        focus: focusAnnotation,
        highlight: setMarkerHighlight,
      },
      panels: {
        open: (id) => {
          if (!registry.getPanels().some((panel) => panel.id === id)) {
            throw new TypeError(`Unknown panel ID: ${id}`);
          }
          openPanel = id;
          focusPanel = true;
          commit();
        },
        close: (id) => {
          if (!id || openPanel === id) {
            const returnAction = panelReturnAction;
            openPanel = null;
            panelReturnAction = null;
            commit();
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
      guardedPredicate(contribution.extensionId, contribution.id, "visible", true, () =>
        contribution.isVisible?.(current) === false
      ) && contribution.id !== collapseAction
    ) return;
    if (guardedPredicate(contribution.extensionId, contribution.id, "enabled", true, () =>
      contribution.isEnabled?.(current) === false
    )) return;
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
      refreshChrome();
      try {
        await contribution.execute?.({
          studio: api,
          extensionId: contribution.extensionId,
        } satisfies ToolbarCommandContext);
      } catch (error) {
        if (destroyed) return;
        // A faulty action is caught and reported; capture stays usable.
        recordExtensionFailure(contribution.extensionId, "execute", contribution.id, error);
      } finally {
        if (destroyed) return;
        pendingActions.delete(contribution.id); // Only this action is released.
        refreshChrome();
      }
    };
    // All action failures are caught inside execute's own try/catch/finally.
    execute();
  };

  let hoverOutline: HTMLElement | null = null;
  let areaNode: HTMLElement | null = null;
  let overlayFrame: number | null = null;
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
    resetResolutionSnapshots();
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
    renderMarkerHighlights();
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
      fallback.setAttribute("aria-label", localized("Manual copy fallback"));
      const textarea = document.createElement("textarea");
      textarea.className = "aa-textarea";
      textarea.readOnly = true;
      textarea.value = copyFallback;
      const close = iconButton(localized("Close"), CloseIcon, () => { copyFallback = ""; render(); });
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
  };
  const commit = () => commitCoordinator?.commit();
  commitCoordinator = createUiCommitCoordinator({
    payload: publicPayload,
    refreshOverlays,
    notifyChrome: notifyUi,
    listeners,
    destroyed: () => destroyed,
    committed: (count) => { hostElement.dataset.publicCommits = String(count); },
  });

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
      const rootNode = current.getRootNode();
      if (rootNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in rootNode) {
        current = (rootNode as ShadowRoot).host;
        continue;
      }
      const frameElement: Element | null = current.ownerDocument.defaultView?.frameElement ?? null;
      if (!frameElement) return false;
      current = frameElement;
    }
    return false;
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
    // Escape closes an open editor first (clearing the highlight and
    // returning focus to a visible Dock control) before panel/capture
    // handling; the editor surface never lingers and blocks the page.
    if (event.key === "Escape" && editingId) {
      event.preventDefault();
      closeEditor();
      return;
    }
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

  for (const [type, listener, target] of [
    ["keydown", onKeyDown as EventListener, window],
    ["error", onError as EventListener, window],
    ["unhandledrejection", onRejection as EventListener, window],
  ] satisfies Array<[string, EventListener, Window]>) {
    target.addEventListener(type, listener, true);
    cleanups.push(() => target.removeEventListener(type, listener, true));
  }
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
  hostElement.dataset.markerRefreshes = "0";
  cleanups.push(stopMarkerTracking);
  const onViewport = () => {
    clampDockPosition();
    positionPanel();
    positionMultiComplete();
    if (markers.hasTracking() || editingId || composer) scheduleMarkerRefresh();
  };
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);
  cleanups.push(() => window.removeEventListener("resize", onViewport));
  cleanups.push(() => window.removeEventListener("scroll", onViewport, true));
  // Dock drag callbacks (moved out of the chrome component) and the panel
  // focus-return helpers stay orchestration-owned.
  const onGripPointerDown = (event: import("react").PointerEvent<HTMLButtonElement>, dock: HTMLDivElement) => {
    const rect = dock.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onGripPointerMove = (event: import("react").PointerEvent<HTMLButtonElement>, dock: HTMLDivElement | null) => {
    if (!drag || !dock) return;
    dockPosition = {
      left: Math.max(0, Math.min(innerWidth - dock.offsetWidth, drag.left + event.clientX - drag.x)),
      top: Math.max(0, Math.min(innerHeight - dock.offsetHeight, drag.top + event.clientY - drag.y)),
    };
    dock.style.left = `${dockPosition.left}px`;
    dock.style.top = `${dockPosition.top}px`;
    dock.style.bottom = "auto";
    const grip = root.querySelector<HTMLElement>(".aa-grip");
    if (grip) positionTooltip(grip);
    positionPanel();
    positionMultiComplete();
  };
  const onGripPointerUp = () => {
    drag = null;
    persistDockPosition();
  };
  const focusPanelControl = (panel: HTMLElement): void => {
    scheduleFrame(() => {
      const target = panel.querySelector<HTMLElement>(
        "button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])"
      );
      if (target && target.isConnected) target.focus();
      else if (panel.isConnected) panel.focus();
    });
  };
  const closePanel = (id: string): void => {
    api.commands.panels.close(id);
  };
  const chromeBindings: ChromeBindings = {
    registry,
    localized,
    showTooltip,
    hideTooltip,
    positionPanel,
    executeContribution,
    setCollapsed,
    guardedPredicate,
    recordExtensionFailure,
    pendingActions,
    getCollapseAction: () => collapseAction,
    getCollapseContribution: () => collapseContribution,
    getShortcuts: () => shortcuts,
    getToolbar: () => toolbar,
    getDockPosition: () => dockPosition,
    takeFocusPanel: () => {
      const value = focusPanel;
      focusPanel = false;
      return value;
    },
    studioRenders,
    hostElement,
    api,
    onGripPointerDown,
    onGripPointerMove,
    onGripPointerUp,
    focusPanelControl,
    closePanel,
  };
  studioRoot = createRoot(uiMount);
  flushSync(() => studioRoot!.render(createElement(StudioChrome, {
    b: chromeBindings,
    uiSubscribe,
    uiGetSnapshot: commitCoordinator!.getChromeSnapshot,
  })));
  render();
  const savedDockPosition = readDockPosition();
  if (savedDockPosition) {
    dockPosition = savedDockPosition;
    clampDockPosition();
  }
  const setupCleanups: Array<{ extensionId: string; dispose: () => void }> = [];
  const safeTeardown = (): void => {
    for (const { extensionId, dispose } of setupCleanups.reverse()) {
      try {
        dispose();
      } catch (error) {
        recordExtensionFailure(extensionId, "dispose", undefined, error);
      }
    }
    for (const unregister of registrations.reverse()) {
      try {
        unregister();
      } catch (error) {
        if (!destroyed) record("console", `extension unregister failed: ${String(error)}`);
      }
    }
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        if (!destroyed) record("console", `runtime cleanup failed: ${String(error)}`);
      }
    }
  };
  try {
    for (const extension of registry.getExtensions()) {
      try {
        const dispose = extension.setup?.({ studio: api });
        if (dispose) setupCleanups.push({ extensionId: extension.id, dispose });
      } catch (error) {
        // A faulty third-party setup is isolated: its contributions are rolled
        // back atomically and mounting continues. The trusted builtin fails fast.
        // Trusted builtins fail fast by object identity; a third party that
        // merely reuses the reserved id is still isolated.
        if (extension === builtin) throw error;
        recordExtensionFailure(extension.id, "setup", undefined, error);
        registrationByExtension.get(extension.id)?.();
        refreshRegistryViews();
      }
    }
  } catch (error) {
    studioRoot?.unmount();
    studioRoot = null;
    safeTeardown();
    hostElement.remove();
    throw error;
  }
  const unmount = (preserveBrowserState = false) => {
    if (destroyed) return;
    stopBrowserHeartbeats();
    if (!preserveBrowserState) removeBrowserState();
    destroyed = true;
    setMarkerHighlight(null);
    editorAnchorRect = null;
    hideTooltip();
    studioRoot?.unmount();
    studioRoot = null;
    delete hostElement.dataset.studioRenders;
    delete hostElement.dataset.publicCommits;
    safeTeardown();
    listeners.clear();
    uiListeners.clear();
    disposeInspectionEngine();
    hostElement.remove();
  };
  // Host subscriptions and the default history listeners are bound only
  // after every setup attempt has settled, so a rolled-back failed host can
  // never leak a subscription or intercept route/history behavior.
  const hostSubscription = host?.subscribeChanges(() => applyHostChange()) ?? null;
  if (hostSubscription) {
    cleanups.push(hostSubscription);
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
  // The browser status loop starts only after every setup step succeeded, so
  // a failed mount can never persist a browserConnected state.
  scheduleBrowserHeartbeat();
  return { api, unmount, reportBrowserUpdate };
}
