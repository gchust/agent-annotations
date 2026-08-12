import {
  createAgentFeedbackId,
  formatAgentFeedbackShortcut,
  formatAgentFeedbackTask,
  matchesAgentFeedbackShortcut,
  redactAgentFeedbackText,
  toAgentFeedbackDocumentRegion,
} from "../core/index.js";
import type {
  AgentFeedbackAnnotation,
  AgentFeedbackCaptureMode,
  AgentFeedbackDiagnosticsEntry,
  AgentFeedbackMutationOperation,
  AgentFeedbackRect,
  AgentFeedbackTask,
  FeedbackExporter,
  FeedbackRedactor,
  HostIntegration,
  MountedAgentFeedback,
  MountAgentFeedbackOptions,
  StudioPublicApi,
  StudioPublicSnapshot,
  TargetEnricher,
} from "../types/index.js";
import {
  disposeInspectionEngine,
  inspectTarget,
  resolveTarget,
  sampleRegionTargets,
  targetAtPoint,
} from "./inspection-engine.js";
import { AGENT_FEEDBACK_STYLES } from "./styles.js";

const HOST_ID = "agent-feedback-root";
const IGNORE_ATTRIBUTE = "data-react-grab-ignore";

const labels = {
  pick: "Pick",
  multi: "Multi",
  area: "Area",
  copy: "Copy",
  visibility: "Markers",
  list: "Annotations",
  help: "Shortcut help",
  toggle: "Collapse toolbar",
} as const;

const shortcuts = [
  { id: "pick", key: "P", code: "KeyP", primary: true, alt: true, shift: false },
  { id: "multi", key: "M", code: "KeyM", primary: true, alt: true, shift: false },
  { id: "area", key: "A", code: "KeyA", primary: true, alt: true, shift: false },
  { id: "copy", key: "C", code: "KeyC", primary: true, alt: true, shift: false },
  { id: "visibility", key: "V", code: "KeyV", primary: true, alt: true, shift: false },
  { id: "list", key: "L", code: "KeyL", primary: true, alt: true, shift: false },
  { id: "help", key: "/", code: "Slash", primary: false, alt: false, shift: true },
  { id: "toggle", key: "K", code: "KeyK", primary: true, alt: true, shift: false },
] as const;

const isEditable = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return !!element?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element?.tagName ?? "");
};

const pageContext = (host?: HostIntegration) => ({
  url: location.href,
  routeKey: host?.routeKey?.() ?? `${location.pathname}${location.search}${location.hash}`,
  title: document.title,
  viewport: { width: innerWidth, height: innerHeight },
  scroll: { x: scrollX, y: scrollY },
});

const now = (): string => new Date().toISOString();

const elementAnnotation = async (
  kind: "element" | "multi",
  elements: Element[],
  comment: string,
  host: HostIntegration | undefined,
  enrichers: TargetEnricher[]
): Promise<AgentFeedbackAnnotation> => {
  const targets = await Promise.all(elements.map((element) => inspectTarget(element, host)));
  const extensions: AgentFeedbackAnnotation["extensions"] = {};
  for (const enricher of enrichers) {
    const values = await Promise.all(
      elements.map((element, index) =>
        enricher.enrich({ element, inspection: targets[index].inspection })
      )
    );
    const data = values.filter((value) => value !== null);
    if (data.length === 1) extensions[enricher.id] = data[0]!;
    else if (data.length > 1) extensions[enricher.id] = { targets: data };
  }
  return {
    annotationId: createAgentFeedbackId(),
    kind,
    comment,
    status: "open",
    createdAt: now(),
    pageContext: pageContext(host),
    targets,
    extensions,
  };
};

export async function mountAgentFeedback(
  options: MountAgentFeedbackOptions
): Promise<MountedAgentFeedback> {
  if (typeof document === "undefined") throw new Error("Agent Feedback requires a browser document");
  if (document.getElementById(HOST_ID)) throw new Error("Agent Feedback is already mounted");

  let task = await options.transport.read();
  let captureMode: AgentFeedbackCaptureMode = "idle";
  let collapsed = false;
  let markersVisible = true;
  let openPanel: StudioPublicSnapshot["openPanel"] = null;
  let selected: Element[] = [];
  let hover: Element | null = null;
  let composer:
    | { kind: "element" | "multi"; elements: Element[] }
    | { kind: "region"; rect: AgentFeedbackRect; sampled: number }
    | null = null;
  let editingId: string | null = null;
  let areaStart: { x: number; y: number } | null = null;
  let areaRect: AgentFeedbackRect | null = null;
  let listFilter: "open" | "all" = "open";
  let status = "";
  let copyFallback = "";
  let dockPosition: { left: number; top: number } | null = null;
  let destroyed = false;
  const listeners = new Set<(snapshot: StudioPublicSnapshot) => void>();
  const diagnostics: AgentFeedbackDiagnosticsEntry[] = [];
  const cleanups: Array<() => void> = [];
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

  const hostElement = document.createElement("div");
  hostElement.id = HOST_ID;
  hostElement.setAttribute("data-agent-feedback-root", "");
  hostElement.setAttribute(IGNORE_ATTRIBUTE, "");
  document.body.append(hostElement);
  const shadow = hostElement.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = AGENT_FEEDBACK_STYLES;
  shadow.append(style);
  const root = document.createElement("div");
  shadow.append(root);

  const locale = options.host?.locale?.() ?? (document.documentElement.lang || "en-US");
  root.lang = locale;

  const snapshot = (): StudioPublicSnapshot => ({
    task,
    captureMode,
    collapsed,
    markersVisible,
    openPanel,
    diagnostics: [...diagnostics],
  });
  const emit = () => {
    if (destroyed) return;
    const value = snapshot();
    for (const listener of listeners) listener(value);
  };
  const setStatus = (message: string) => {
    if (destroyed) return;
    status = message;
    render();
    scheduleTimer(() => {
      if (status === message) {
        status = "";
        render();
      }
    }, 1800);
  };
  const mutate = async (operations: AgentFeedbackMutationOperation[]) => {
    if (destroyed) return;
    const next = await options.transport.mutate({
      taskId: task.taskId,
      expectedRevision: task.taskRevision,
      operations,
    });
    if (destroyed) return;
    task = next;
    render();
    emit();
  };

  const applyRedactors = async (value: AgentFeedbackTask): Promise<AgentFeedbackTask> => {
    let next = value;
    for (const redactor of options.redactors ?? []) {
      const redacted = await redactor.redact(next);
      if (redacted) next = redacted;
    }
    return next;
  };
  const exportTask = async (filter: "open" | "all"): Promise<string> => {
    const redacted = await applyRedactors(task);
    const exporter: FeedbackExporter | undefined = options.exporters?.[0];
    return exporter
      ? exporter.export({ task: redacted, annotations: filter })
      : formatAgentFeedbackTask(redacted, { annotations: filter });
  };
  const copyOpen = async (): Promise<void> => {
    const output = await exportTask("open");
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

  const cancelCapture = () => {
    captureMode = "idle";
    selected = [];
    hover = null;
    areaStart = null;
    areaRect = null;
    composer = null;
    render();
    emit();
  };
  const startCapture = (mode: Exclude<AgentFeedbackCaptureMode, "idle">) => {
    captureMode = mode;
    selected = [];
    composer = null;
    editingId = null;
    openPanel = null;
    render();
    emit();
  };
  const focusAnnotation = (id: string) => {
    if (destroyed) return;
    editingId = id;
    openPanel = null;
    render();
    scheduleFrame(() => root.querySelector<HTMLElement>(".af-editor textarea")?.focus());
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
        complete: (id) => mutate([{ op: "complete", annotationId: id }]),
        reopen: (id) => mutate([{ op: "reopen", annotationId: id }]),
        remove: (id) => mutate([{ op: "remove", annotationId: id }]),
        removeCompleted: () => mutate([{ op: "removeCompleted" }]),
      },
      markers: {
        show: () => { markersVisible = true; render(); emit(); },
        hide: () => { markersVisible = false; render(); emit(); },
        focus: focusAnnotation,
      },
      panels: {
        open: (id) => { openPanel = id === "help" ? "help" : "list"; render(); emit(); },
        close: (id) => { if (!id || openPanel === id) openPanel = null; render(); emit(); },
      },
    },
  };

  const nativeButton = (
    label: string,
    action: () => void,
    attributes: Record<string, string> = {}
  ): HTMLButtonElement => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "af-action";
    node.textContent = label;
    node.setAttribute("aria-label", attributes["aria-label"] ?? label);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    node.addEventListener("click", action);
    node.addEventListener("mouseenter", () => showTooltip(node));
    node.addEventListener("mouseleave", hideTooltip);
    return node;
  };

  const submitButton = (label: string): HTMLButtonElement => {
    const node = document.createElement("button");
    node.type = "submit";
    node.className = "af-button af-primary";
    node.textContent = label;
    node.setAttribute("aria-label", label);
    return node;
  };

  let tooltipTimer: number | null = null;
  const hideTooltip = () => {
    if (tooltipTimer !== null) cancelTimer(tooltipTimer);
    tooltipTimer = null;
    root.querySelector(".af-tooltip")?.remove();
  };
  const showTooltip = (trigger: HTMLElement) => {
    hideTooltip();
    tooltipTimer = scheduleTimer(() => {
      tooltipTimer = null;
      const tooltip = document.createElement("div");
      tooltip.className = "af-tooltip";
      tooltip.role = "tooltip";
      tooltip.textContent = trigger.getAttribute("aria-label") ?? "";
      const rect = trigger.getBoundingClientRect();
      tooltip.style.left = `${Math.max(4, rect.left)}px`;
      tooltip.style.top = `${Math.max(4, rect.top - 34)}px`;
      root.append(tooltip);
    }, 300);
  };

  const addOutline = (rect: AgentFeedbackRect, region = false) => {
    const node = document.createElement("div");
    node.className = region ? "af-outline" : "af-outline";
    if (region) node.dataset.region = "true";
    Object.assign(node.style, {
      left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    root.append(node);
  };

  const renderMarkers = () => {
    if (!markersVisible) return;
    task.annotations.forEach((annotation, index) => {
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
      const rect = target?.getBoundingClientRect();
      const anchor = rect
        ? { x: rect.left - 8, y: rect.top - 8 }
        : annotation.region
          ? { x: annotation.region.x - scrollX + annotation.region.width - 14, y: annotation.region.y - scrollY + 4 }
          : null;
      if (!anchor) return;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "af-marker";
      marker.dataset.status = annotation.status;
      marker.setAttribute("aria-label", `Annotation ${index + 1}: edit`);
      marker.textContent = String(index + 1);
      Object.assign(marker.style, { left: `${anchor.x}px`, top: `${anchor.y}px` });
      marker.addEventListener("click", () => focusAnnotation(annotation.annotationId));
      root.append(marker);
    });
  };

  const renderComposer = () => {
    if (!composer) return;
    const surface = document.createElement("form");
    surface.className = "af-composer";
    surface.setAttribute("aria-label", "Annotation composer");
    const title = document.createElement("strong");
    title.textContent = composer.kind === "region"
      ? `Area (${composer.sampled} sampled targets)`
      : `${composer.kind === "multi" ? "Multi" : "Pick"} annotation`;
    const textarea = document.createElement("textarea");
    textarea.className = "af-textarea";
    textarea.setAttribute("aria-label", "Annotation comment");
    textarea.placeholder = "Describe the requested change";
    const actions = document.createElement("div");
    actions.className = "af-actions";
    const cancel = nativeButton("Cancel", cancelCapture);
    cancel.className = "af-button";
    const save = submitButton("Save annotation");
    actions.append(cancel, save);
    surface.append(title, textarea, actions);
    surface.addEventListener("submit", async (event) => {
      event.preventDefault();
      const comment = textarea.value.trim();
      if (!comment) return textarea.focus();
      save.disabled = true;
      try {
        const annotation = composer?.kind === "region"
          ? {
              annotationId: createAgentFeedbackId(),
              kind: "region" as const,
              comment,
              status: "open" as const,
              createdAt: now(),
              pageContext: pageContext(options.host),
              region: toAgentFeedbackDocumentRegion(composer.rect, { x: scrollX, y: scrollY }),
              extensions: {},
            }
          : await elementAnnotation(
              composer!.kind,
              composer!.elements,
              comment,
              options.host,
              options.targetEnrichers ?? []
            );
        if (destroyed) return;
        await mutate([{ op: "add", annotation }]);
        if (destroyed) return;
        cancelCapture();
        setStatus("Annotation saved");
      } catch (error) {
        save.disabled = false;
        setStatus(error instanceof Error ? error.message : "Save failed");
      }
    });
    root.append(surface);
    scheduleFrame(() => textarea.focus());
  };

  const renderEditor = () => {
    const annotation = task.annotations.find((entry) => entry.annotationId === editingId);
    if (!annotation) return;
    const surface = document.createElement("form");
    surface.className = "af-editor";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", "Annotation editor");
    const textarea = document.createElement("textarea");
    textarea.className = "af-textarea";
    textarea.setAttribute("aria-label", "Annotation comment");
    textarea.value = annotation.comment;
    const actions = document.createElement("div");
    actions.className = "af-actions";
    const save = submitButton("Save comment");
    const statusButton = nativeButton(annotation.status === "open" ? "Complete" : "Reopen", async () => {
      await mutate([{ op: annotation.status === "open" ? "complete" : "reopen", annotationId: annotation.annotationId }]);
    });
    statusButton.className = "af-button";
    const remove = nativeButton("Delete", async () => {
      await mutate([{ op: "remove", annotationId: annotation.annotationId }]);
      if (destroyed) return;
      editingId = null;
      render();
    });
    remove.className = "af-button af-danger";
    const close = nativeButton("Close", () => { editingId = null; render(); });
    close.className = "af-button";
    actions.append(save, statusButton, remove, close);
    surface.append(textarea, actions);
    surface.addEventListener("submit", async (event) => {
      event.preventDefault();
      await mutate([{ op: "update", annotationId: annotation.annotationId, comment: textarea.value }]);
      if (destroyed) return;
      setStatus("Comment saved");
    });
    root.append(surface);
  };

  const renderPanel = () => {
    if (!openPanel) return;
    const panel = document.createElement("section");
    panel.className = "af-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", openPanel === "help" ? "Shortcut help" : "Annotation list");
    const heading = document.createElement("h2");
    heading.textContent = openPanel === "help" ? "Shortcuts" : "Annotations";
    panel.append(heading);
    if (openPanel === "help") {
      const list = document.createElement("ul");
      list.className = "af-help-list";
      for (const shortcut of shortcuts) {
        const item = document.createElement("li");
        item.className = "af-help-row";
        item.innerHTML = `<span>${labels[shortcut.id]}</span><kbd>${formatAgentFeedbackShortcut(shortcut, /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other")}</kbd>`;
        list.append(item);
      }
      panel.append(list);
    } else {
      const filters = document.createElement("div");
      filters.className = "af-filter";
      for (const filter of ["open", "all"] as const) {
        const node = nativeButton(filter === "open" ? "Open" : "All", () => { listFilter = filter; render(); }, { "aria-pressed": String(listFilter === filter) });
        node.className = "af-button";
        filters.append(node);
      }
      panel.append(filters);
      const list = document.createElement("ol");
      list.className = "af-list";
      task.annotations.forEach((annotation, index) => {
        if (listFilter === "open" && annotation.status !== "open") return;
        const item = document.createElement("li");
        item.className = "af-list-item";
        const open = document.createElement("button");
        open.className = "af-button";
        open.textContent = `${index + 1}. ${annotation.comment}`;
        open.setAttribute("aria-label", `Edit annotation ${index + 1}`);
        open.addEventListener("click", () => focusAnnotation(annotation.annotationId));
        const meta = document.createElement("span");
        meta.className = "af-muted";
        meta.textContent = annotation.status;
        item.append(open, meta);
        list.append(item);
      });
      panel.append(list);
    }
    root.append(panel);
  };

  const render = () => {
    if (destroyed) return;
    root.replaceChildren();
    const dock = document.createElement("div");
    dock.className = "af-dock";
    dock.dataset.collapsed = String(collapsed);
    if (dockPosition) {
      Object.assign(dock.style, {
        left: `${dockPosition.left}px`,
        top: `${dockPosition.top}px`,
        bottom: "auto",
      });
    }
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "af-grip";
    grip.textContent = "⋮⋮";
    grip.setAttribute("aria-label", "Drag toolbar");
    dock.append(grip);
    const addAction = (id: keyof typeof labels, fn: () => void, pressed?: boolean) => {
      const shortcut = shortcuts.find((entry) => entry.id === id);
      const node = nativeButton(labels[id], fn, {
        "aria-label": `${labels[id]}${shortcut ? ` (${formatAgentFeedbackShortcut(shortcut, /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other")})` : ""}`,
        ...(pressed === undefined ? {} : { "aria-pressed": String(pressed) }),
      });
      if (id === "toggle") node.dataset.toggle = "true";
      dock.append(node);
    };
    addAction("pick", () => startCapture("pick"), captureMode === "pick");
    addAction("multi", () => startCapture("multi"), captureMode === "multi");
    addAction("area", () => startCapture("area"), captureMode === "area");
    addAction("copy", () => void copyOpen());
    addAction("visibility", () => { markersVisible = !markersVisible; render(); emit(); }, markersVisible);
    addAction("list", () => { openPanel = openPanel === "list" ? null : "list"; render(); emit(); }, openPanel === "list");
    addAction("help", () => { openPanel = openPanel === "help" ? null : "help"; render(); emit(); }, openPanel === "help");
    addAction("toggle", () => { collapsed = !collapsed; render(); emit(); }, collapsed);
    root.append(dock);

    let drag: { x: number; y: number; left: number; top: number } | null = null;
    grip.addEventListener("pointerdown", (event) => {
      const rect = dock.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener("pointermove", (event) => {
      if (!drag) return;
      dockPosition = {
        left: Math.max(0, Math.min(innerWidth - dock.offsetWidth, drag.left + event.clientX - drag.x)),
        top: Math.max(0, Math.min(innerHeight - dock.offsetHeight, drag.top + event.clientY - drag.y)),
      };
      dock.style.left = `${dockPosition.left}px`;
      dock.style.top = `${dockPosition.top}px`;
      dock.style.bottom = "auto";
    });
    grip.addEventListener("pointerup", () => { drag = null; });

    renderMarkers();
    if (hover && captureMode !== "area") addOutline(hover.getBoundingClientRect());
    for (const element of selected) addOutline(element.getBoundingClientRect());
    if (areaRect) {
      const node = document.createElement("div");
      node.className = "af-area";
      Object.assign(node.style, { left: `${areaRect.x}px`, top: `${areaRect.y}px`, width: `${areaRect.width}px`, height: `${areaRect.height}px` });
      root.append(node);
    }
    renderComposer();
    renderEditor();
    renderPanel();
    if (copyFallback) {
      const fallback = document.createElement("div");
      fallback.className = "af-copy-fallback";
      fallback.setAttribute("role", "dialog");
      fallback.setAttribute("aria-label", "Manual copy fallback");
      const textarea = document.createElement("textarea");
      textarea.className = "af-textarea";
      textarea.readOnly = true;
      textarea.value = copyFallback;
      const close = nativeButton("Close", () => { copyFallback = ""; render(); });
      close.className = "af-button";
      fallback.append(textarea, close);
      root.append(fallback);
      scheduleFrame(() => textarea.select());
    }
    if (status) {
      const toast = document.createElement("div");
      toast.className = "af-status";
      toast.setAttribute("role", "status");
      toast.textContent = status;
      root.append(toast);
    }
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
      render();
      return;
    }
    hover = targetAtPoint(event.clientX, event.clientY);
    render();
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
    const sampled = sampleRegionTargets(rect).length;
    composer = { kind: "region", rect, sampled };
    render();
  };
  const onClick = (event: MouseEvent) => {
    if ((captureMode !== "pick" && captureMode !== "multi") || composer || isHostEvent(event)) return;
    const target = targetAtPoint(event.clientX, event.clientY);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (captureMode === "pick") {
      selected = [target];
      composer = { kind: "element", elements: [target] };
    } else if (event.detail === 2 && selected.length >= 2) {
      composer = { kind: "multi", elements: [...selected] };
    } else {
      selected = selected.includes(target)
        ? selected.filter((entry) => entry !== target)
        : [...selected, target].slice(0, 50);
    }
    hover = null;
    render();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isHostEvent(event)) return;
    if (event.key === "Escape" && captureMode !== "idle") {
      event.preventDefault();
      return cancelCapture();
    }
    if (captureMode === "multi" && event.key === "Enter" && selected.length >= 2 && !isEditable(event.target)) {
      event.preventDefault();
      composer = { kind: "multi", elements: [...selected] };
      return render();
    }
    const platform = /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other";
    const shortcut = shortcuts.find((entry) => matchesAgentFeedbackShortcut(entry, {
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
    const actions: Record<string, () => void> = {
      pick: () => startCapture("pick"), multi: () => startCapture("multi"), area: () => startCapture("area"),
      copy: () => void copyOpen(), visibility: () => { markersVisible = !markersVisible; render(); },
      list: () => { openPanel = openPanel === "list" ? null : "list"; render(); },
      help: () => { openPanel = openPanel === "help" ? null : "help"; render(); },
      toggle: () => { collapsed = !collapsed; render(); },
    };
    actions[shortcut.id]?.();
    emit();
  };
  const record = (source: AgentFeedbackDiagnosticsEntry["source"], value: unknown) => {
    if (destroyed) return;
    diagnostics.push({
      source,
      message: redactAgentFeedbackText(String(value), { maxLength: 500 }),
      timestamp: now(),
    });
    if (diagnostics.length > 20) diagnostics.shift();
    emit();
  };
  const onError = (event: ErrorEvent) => record("window", event.message);
  const onRejection = (event: PromiseRejectionEvent) => record("promise", event.reason);
  const originalConsoleError = console.error;
  const onConsoleError = (...values: unknown[]) => {
    originalConsoleError.apply(console, values);
    record("console", values.map(String).join(" "));
  };
  console.error = onConsoleError;
  cleanups.push(() => {
    if (console.error === onConsoleError) console.error = originalConsoleError;
  });

  for (const [type, listener, target] of [
    ["pointermove", onPointerMove, document], ["pointerdown", onPointerDown, document],
    ["pointerup", onPointerUp, document], ["click", onClick, document], ["keydown", onKeyDown, window],
    ["error", onError, window], ["unhandledrejection", onRejection, window],
  ] as Array<[string, EventListener, Document | Window]>) {
    target.addEventListener(type, listener, true);
    cleanups.push(() => target.removeEventListener(type, listener, true));
  }
  const onViewport = () => render();
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);
  cleanups.push(() => window.removeEventListener("resize", onViewport));
  cleanups.push(() => window.removeEventListener("scroll", onViewport, true));

  render();
  const unmount = () => {
    if (destroyed) return;
    destroyed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    listeners.clear();
    disposeInspectionEngine();
    hostElement.remove();
  };
  return { api, unmount };
}
