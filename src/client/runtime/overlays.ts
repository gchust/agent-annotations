import {
  CaptureIcon,
  CloseIcon,
  CompleteIcon,
  createIconSvg,
  DeleteIcon,
  ReopenIcon,
  SaveIcon,
  type BuiltinIcon,
} from "../icons.js";
import { elementAnnotation, regionAnnotation, type RegisteredTargetEnricher } from "./annotated.js";
import { targetBounds } from "../inspection-engine.js";
import type { PreparedViewportSnapshot } from "../screenshot.js";
import type { MarkerResolutionSnapshot } from "./markers.js";
import type {
  AgentAnnotation,
  AgentAnnotationsDiagnosticPhase,
  AgentAnnotationsMutationOperation,
  AgentAnnotationsPageContext,
  AgentAnnotationsRect,
  AgentAnnotationsTask,
  HostIntegration,
} from "../../types/index.js";

export type ScreenshotRect = { x: number; y: number; width: number; height: number };
export type ScreenshotEvidenceInput = {
  annotationId: string;
  taskId: string;
  taskRevision: number;
  routeKey: string;
};

type OverlayComposer =
  | { kind: "element" | "multi"; elements: Element[] }
  | { kind: "region"; rect: AgentAnnotationsRect; sampled: number; elements: Element[] };

// Narrow overlay bindings: every dynamic mount value is read through lazy
// getters so the overlay builders never touch mount-time TDZ or stale values.
export type OverlayBindings = {
  localized(value: string | Readonly<Record<string, string>>, params?: Record<string, string | number>): string;
  scheduleTimer(callback: () => void, delay: number): number;
  cancelTimer(timer: number): void;
  scheduleFrame(callback: () => void): number;
  overlayMount(): HTMLElement;
  root(): HTMLElement;
  task(): AgentAnnotationsTask;
  routeKey(): string;
  pageContext(): AgentAnnotationsPageContext;
  markersVisible(): boolean;
  editingId(): string | null;
  editorAnchorRect(): AgentAnnotationsRect | null;
  composer(): OverlayComposer | null;
  cancelCapture(): void;
  render(): void;
  emit(): void;
  destroyed(): boolean;
  screenshotMode(): "auto" | "manual" | "off";
  canWriteEvidence(): boolean;
  host(): HostIntegration | undefined;
  enrichers(): readonly RegisteredTargetEnricher[];
  mutate(operations: AgentAnnotationsMutationOperation[]): Promise<AgentAnnotationsTask | undefined>;
  recordExtensionFailure(
    extensionId: string,
    phase: AgentAnnotationsDiagnosticPhase,
    contributionId: string | undefined,
    error: unknown
  ): void;
  focusAnnotation(id: string): void;
  closeEditor(): void;
  captureEvidence(annotationId: string): Promise<void>;
  clearTransientSelection(): void;
  prepareScreenshotEvidence(
    input: ScreenshotEvidenceInput & { overlays: readonly ScreenshotRect[] }
  ): (ScreenshotEvidenceInput & { snapshot: PreparedViewportSnapshot }) | null;
  scheduleScreenshotEvidence(input: ScreenshotEvidenceInput & { snapshot: PreparedViewportSnapshot }): void;
  setStatus(message: string): void;
  markers: {
    resolutionSnapshot(annotation: AgentAnnotation): MarkerResolutionSnapshot;
    setMarkerHighlight(id: string | null): void;
  };
};

export type OverlayController = {
  iconButton(label: string, Icon: BuiltinIcon, action?: () => void, attributes?: Record<string, string>): HTMLButtonElement;
  submitButton(label: string, Icon: BuiltinIcon): HTMLButtonElement;
  showTooltip(trigger: HTMLElement): void;
  hideTooltip(): void;
  positionTooltip(trigger: HTMLElement): void;
  addOutline(rect: AgentAnnotationsRect, region?: boolean): void;
  renderMarkers(): Element[];
  renderComposer(previousDraft: string): void;
  renderEditor(previousDraft: string | null): void;
  positionComposer(): void;
  positionEditor(): void;
};

export const createOverlayController = (b: OverlayBindings): OverlayController => {
  let tooltipTimer: number | null = null;

  const iconButton = (
    label: string,
    Icon: BuiltinIcon,
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
    // Imperative overlay buttons only ever use built-in icons, rendered as
    // controlled DOM SVG from the shared path data.
    slot.append(createIconSvg(Icon));
    node.append(slot);
    if (action) node.addEventListener("click", action);
    node.addEventListener("mouseenter", () => showTooltip(node));
    node.addEventListener("mouseleave", hideTooltip);
    node.addEventListener("focus", () => showTooltip(node));
    node.addEventListener("blur", hideTooltip);
    return node;
  };

  const submitButton = (
    label: string,
    Icon: BuiltinIcon
  ): HTMLButtonElement => {
    const node = iconButton(label, Icon);
    node.type = "submit";
    node.className = "aa-button aa-icon-button aa-primary";
    return node;
  };

  const hideTooltip = () => {
    if (tooltipTimer !== null) b.cancelTimer(tooltipTimer);
    tooltipTimer = null;
    b.overlayMount().querySelector(".aa-tooltip")?.remove();
  };
  const positionTooltip = (trigger: HTMLElement) => {
    const tooltip = b.overlayMount().querySelector<HTMLElement>(".aa-tooltip");
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
    tooltipTimer = b.scheduleTimer(() => {
      tooltipTimer = null;
      const tooltip = document.createElement("div");
      tooltip.className = "aa-tooltip";
      tooltip.role = "tooltip";
      tooltip.textContent =
        trigger.getAttribute("data-tooltip") ?? trigger.getAttribute("aria-label") ?? "";
      b.overlayMount().append(tooltip);
      positionTooltip(trigger);
    }, 300);
  };

  const addOutline = (rect: AgentAnnotationsRect, region = false) => {
    const node = document.createElement("div");
    node.className = "aa-outline";
    if (region) node.dataset.region = "true";
    Object.assign(node.style, {
      left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    b.overlayMount().append(node);
  };

  const renderMarkers = () => {
    const resolved: Element[] = [];
    if (!b.markersVisible()) return resolved;
    b.task().annotations.forEach((annotation, index) => {
      if (annotation.status === "completed") return;
      if (annotation.pageContext.routeKey !== b.routeKey()) return;
      if (annotation.region) {
        addOutline({
          x: annotation.region.x - scrollX,
          y: annotation.region.y - scrollY,
          width: annotation.region.width,
          height: annotation.region.height,
        }, true);
      }
      const snapshot = b.markers.resolutionSnapshot(annotation);
      const targetInRoot = snapshot.anchor;
      resolved.push(...snapshot.resolvedTargets);
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
      const summary = snapshot.summary;
      const ariaLabel = `${b.localized("Annotation")} ${index + 1}: ${b.localized("edit")}`;
      marker.setAttribute("aria-label", ariaLabel);
      if (summary.total > 0) {
        marker.dataset.resolved = String(summary.resolved);
        marker.dataset.total = String(summary.total);
        const targets = b.localized("targets", { resolved: summary.resolved, total: summary.total });
        marker.dataset.tooltip = summary.resolved < summary.total
          ? `${ariaLabel} · ${targets} · ${b.localized(summary.reason ?? "unresolved")}`
          : `${ariaLabel} · ${targets}`;
      }
      marker.textContent = String(index + 1);
      marker.hidden = !anchor;
      if (anchor) Object.assign(marker.style, { left: `${anchor.x}px`, top: `${anchor.y}px` });
      marker.addEventListener("click", () => b.focusAnnotation(annotation.annotationId));
      marker.addEventListener("mouseenter", () => {
        b.markers.setMarkerHighlight(annotation.annotationId);
        showTooltip(marker);
      });
      marker.addEventListener("mouseleave", () => {
        b.markers.setMarkerHighlight(null);
        hideTooltip();
      });
      marker.addEventListener("focus", () => {
        b.markers.setMarkerHighlight(annotation.annotationId);
        showTooltip(marker);
      });
      marker.addEventListener("blur", () => {
        b.markers.setMarkerHighlight(null);
        hideTooltip();
      });
      b.overlayMount().append(marker);
    });
    return resolved;
  };

  const renderComposer = (previousDraft: string) => {
    const composer = b.composer();
    if (!composer) return;
    const surface = document.createElement("form");
    surface.className = "aa-composer";
    surface.setAttribute("aria-label", b.localized("Annotation composer"));
    const title = document.createElement("strong");
    title.textContent = composer.kind === "region"
      ? `${b.localized("Area")} (${composer.sampled} ${b.localized("sampled targets")})`
      : b.localized(composer.kind === "multi" ? "Multi annotation" : "Pick annotation");
    const textarea = document.createElement("textarea");
    textarea.className = "aa-textarea";
    textarea.setAttribute("aria-label", b.localized("Annotation comment"));
    textarea.placeholder = b.localized("Describe the requested change");
    textarea.value = previousDraft;
    const actions = document.createElement("div");
    actions.className = "aa-actions";
    const cancel = iconButton(b.localized("Cancel"), CloseIcon, b.cancelCapture);
    cancel.className = "aa-button aa-icon-button";
    const save = submitButton(b.localized("Save annotation"), SaveIcon);
    actions.append(cancel, save);
    surface.append(title, textarea, actions);
    surface.addEventListener("submit", async (event) => {
      event.preventDefault();
      const comment = textarea.value.trim();
      if (!comment) return textarea.focus();
      const submittedPageContext = b.pageContext();
      const submittedRouteKey = submittedPageContext.routeKey;
      save.disabled = true;
      try {
        const annotation = composer.kind === "region"
          ? await regionAnnotation(
              composer.rect,
              composer.elements,
              comment,
              submittedPageContext,
              b.host(),
              b.enrichers(),
              (message, details) => b.recordExtensionFailure(
                details?.extensionId ?? "unknown",
                details?.phase ?? "enrich",
                details?.contributionId,
                message
              )
            )
          : await elementAnnotation(
              composer.kind,
              composer.elements,
              comment,
              submittedPageContext,
              b.host(),
              b.enrichers(),
              (message, details) => b.recordExtensionFailure(
                details?.extensionId ?? "unknown",
                details?.phase ?? "enrich",
                details?.contributionId,
                message
              )
            );
        if (b.destroyed() || b.routeKey() !== submittedRouteKey) return;
        const persisted = await b.mutate([{ op: "add", annotation }]);
        if (b.destroyed()) return;
        // Copy the immutable data needed for background evidence, then close
        // the composer and show success immediately: the screenshot never
        // blocks the save and never rolls back the annotation.
        let evidenceInput: (ScreenshotEvidenceInput & { snapshot: PreparedViewportSnapshot }) | null = null;
        if (persisted && b.canWriteEvidence() && b.screenshotMode() === "auto" && b.routeKey() === submittedRouteKey) {
          const overlays = composer.kind === "region"
            ? [{ ...composer.rect }]
            : composer.elements.map((element) => ({ ...targetBounds(element) }));
          evidenceInput = b.prepareScreenshotEvidence({
            annotationId: annotation.annotationId,
            taskId: persisted.taskId,
            taskRevision: persisted.taskRevision,
            routeKey: submittedRouteKey,
            overlays,
          });
        }
        b.clearTransientSelection();
        b.render();
        b.emit();
        b.setStatus(b.localized("Annotation saved"));
        if (evidenceInput) b.scheduleScreenshotEvidence(evidenceInput);
      } catch (error) {
        save.disabled = false;
        b.setStatus(error instanceof Error ? error.message : b.localized("Save failed"));
      }
    });
    b.overlayMount().append(surface);
    positionComposer();
    b.scheduleFrame(() => textarea.focus());
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
    const surface = b.overlayMount().querySelector<HTMLElement>(".aa-composer");
    const composer = b.composer();
    if (!surface || !composer) return;
    const anchor = composer.kind === "region"
      ? composer.rect
      : composer.elements.at(-1)
        ? targetBounds(composer.elements.at(-1)!)
        : null;
    if (anchor) positionSurface(surface, anchor);
  }

  const positionEditor = () => {
    const surface = b.overlayMount().querySelector<HTMLElement>(".aa-editor");
    if (!surface || !b.editingId()) return;
    // Priority: the captured list-item rect, then the annotation marker,
    // then the Dock. The editor never silently floats at the top-left.
    if (b.editorAnchorRect()) {
      positionSurface(surface, b.editorAnchorRect()!);
      return;
    }
    const marker = Array.from(b.overlayMount().querySelectorAll<HTMLElement>(".aa-marker"))
      .find((node) => node.dataset.annotationId === b.editingId());
    if (marker && !marker.hidden) {
      const markerRect = marker.getBoundingClientRect();
      positionSurface(surface, {
        x: markerRect.x,
        y: markerRect.y,
        width: markerRect.width,
        height: markerRect.height,
      });
      return;
    }
    const dock = b.root().querySelector<HTMLElement>(".aa-dock");
    if (dock) {
      const dockRect = dock.getBoundingClientRect();
      positionSurface(surface, {
        x: dockRect.x,
        y: dockRect.top - 8,
        width: dockRect.width,
        height: 8,
      });
    }
  };

  const renderEditor = (previousDraft: string | null) => {
    const annotation = b.task().annotations.find((entry) => entry.annotationId === b.editingId());
    if (!annotation) return;
    const surface = document.createElement("form");
    surface.className = "aa-editor";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", b.localized("Annotation editor"));
    surface.dataset.annotationId = annotation.annotationId;
    const textarea = document.createElement("textarea");
    textarea.className = "aa-textarea";
    textarea.setAttribute("aria-label", b.localized("Annotation comment"));
    textarea.value = previousDraft ?? annotation.comment;
    const summary = b.markers.resolutionSnapshot(annotation).summary;
    const actions = document.createElement("div");
    actions.className = "aa-actions";
    const save = submitButton(b.localized("Save comment"), SaveIcon);
    if (b.screenshotMode() !== "off" && b.canWriteEvidence()) {
      const capture = iconButton(
        b.localized("Capture screenshot"),
        CaptureIcon,
        () => { b.captureEvidence(annotation.annotationId).catch(() => undefined); }
      );
      capture.className = "aa-button aa-icon-button";
      actions.append(save, capture);
    } else {
      actions.append(save);
    }
    const statusButton = iconButton(
      annotation.status === "open" ? b.localized("Complete") : b.localized("Reopen"),
      annotation.status === "open" ? CompleteIcon : ReopenIcon,
      async () => {
      await b.mutate([{ op: annotation.status === "open" ? "complete" : "reopen", annotationId: annotation.annotationId }]);
      }
    );
    statusButton.className = "aa-button aa-icon-button";
    const remove = iconButton(b.localized("Delete"), DeleteIcon, async () => {
      await b.mutate([{ op: "remove", annotationId: annotation.annotationId }]);
      if (b.destroyed()) return;
      b.closeEditor();
    });
    remove.className = "aa-button aa-icon-button aa-danger";
    const close = iconButton(b.localized("Close"), CloseIcon, b.closeEditor);
    close.className = "aa-button aa-icon-button";
    actions.append(statusButton, remove, close);
    if (summary.total > 0) {
      const targets = document.createElement("div");
      targets.className = "aa-muted aa-targets";
      targets.textContent = summary.resolved < summary.total
        ? `${b.localized("targets", { resolved: summary.resolved, total: summary.total })} · ${b.localized(summary.reason ?? "unresolved")}`
        : b.localized("targets", { resolved: summary.resolved, total: summary.total });
      surface.append(targets);
    }
    surface.append(textarea, actions);
    surface.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await b.mutate([{ op: "update", annotationId: annotation.annotationId, comment: textarea.value }]);
        if (b.destroyed()) return;
        b.closeEditor();
        b.setStatus(b.localized("Comment saved"));
      } catch (error) {
        if (b.destroyed()) return;
        save.disabled = false;
        b.setStatus(error instanceof Error ? error.message : b.localized("Save failed"));
      }
    });
    b.overlayMount().append(surface);
    positionEditor();
  };

  return {
    iconButton,
    submitButton,
    showTooltip,
    hideTooltip,
    positionTooltip,
    addOutline,
    renderMarkers,
    renderComposer,
    renderEditor,
    positionComposer,
    positionEditor,
  };
};
