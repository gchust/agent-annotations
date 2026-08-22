import type { AgentAnnotationsCaptureMode, AgentAnnotationsRect, AgentAnnotationsTask } from "../../types/index.js";
import type { GuardedHostIntegration } from "./host.js";

type ComposerState =
  | { kind: "element" | "multi"; elements: Element[] }
  | { kind: "region"; rect: AgentAnnotationsRect; sampled: number; elements: Element[] };

// Focused capture/editor-command bindings: all dynamic mount values are read
// and written through narrow getters/setters so the controller never touches
// mount-time TDZ or stale snapshots.
export type CaptureBindings = {
  markersVisible(): boolean;
  setMarkersVisibleValue(value: boolean): void;
  collapsed(): boolean;
  setCollapsedValue(value: boolean): void;
  captureMode(): AgentAnnotationsCaptureMode;
  setCaptureModeValue(value: AgentAnnotationsCaptureMode): void;
  selected(): Element[];
  setSelectedValue(value: Element[]): void;
  hover(): Element | null;
  setHoverValue(value: Element | null): void;
  composer(): ComposerState | null;
  setComposerValue(value: ComposerState | null): void;
  editingId(): string | null;
  setEditingIdValue(value: string | null): void;
  openPanel(): string | null;
  setOpenPanelValue(value: string | null): void;
  areaStart(): { x: number; y: number } | null;
  setAreaStartValue(value: { x: number; y: number } | null): void;
  areaRect(): AgentAnnotationsRect | null;
  setAreaRectValue(value: AgentAnnotationsRect | null): void;
  editorAnchorRect(): AgentAnnotationsRect | null;
  setEditorAnchorRectValue(value: AgentAnnotationsRect | null): void;
  task(): AgentAnnotationsTask;
  destroyed(): boolean;
  routeKey(): string;
  host(): GuardedHostIntegration | undefined;
  overlayMount(): HTMLElement;
  root(): HTMLElement;
  scheduleFrame(callback: () => void): number;
  render(): void;
  emit(): void;
  // Capture document binding: the controller owns the document map and the
  // iframe load binding; the mount provides the pointer/click listeners, the
  // app root, and the origin document resolution.
  captureListeners(): Array<[string, EventListener]>;
  appRoot(): Element | Document;
  captureDocumentOf(): Document;
  setStatus(message: string): void;
  localized(value: string | Readonly<Record<string, string>>, params?: Record<string, string | number>): string;
  setInspectionFrozen(frozen: boolean, targets?: Element[]): void;
  setMarkerHighlight(id: string | null): void;
};

export type CaptureController = {
  setMarkersVisible(visible: boolean): void;
  clearTransientSelection(): void;
  setCollapsed(next: boolean): void;
  toggleCollapsed(): void;
  cancelCapture(): void;
  startCapture(mode: Exclude<AgentAnnotationsCaptureMode, "idle">): void;
  closeEditor(): void;
  focusAnnotation(id: string): void;
  refreshCaptureDocuments(): void;
  clearCaptureDocuments(): void;
};

export const createCaptureController = (b: CaptureBindings): CaptureController => {
  const captureDocuments = new Map<Document, () => void>();
  const bindDocument = (captureDocument: Document): void => {
    if (captureDocuments.has(captureDocument)) return;
    for (const [type, listener] of b.captureListeners()) {
      captureDocument.addEventListener(type, listener, true);
    }
    const cleanup = () => {
      for (const [type, listener] of b.captureListeners()) {
        captureDocument.removeEventListener(type, listener, true);
      }
    };
    captureDocuments.set(captureDocument, cleanup);
    const frameScope: ParentNode = captureDocument === b.captureDocumentOf() ? b.appRoot() : captureDocument;
    for (const frame of frameScope.querySelectorAll("iframe")) {
      const refresh = () => {
        try {
          if (frame.contentDocument) bindDocument(frame.contentDocument);
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
        if (frame.contentDocument) bindDocument(frame.contentDocument);
      } catch {
        // Cross-origin frames are explicitly unsupported and remain unresolved.
      }
    }
  };
  const refreshCaptureDocuments = (): void => {
    clearCaptureDocuments();
    bindDocument(b.captureDocumentOf());
  };
  const clearCaptureDocuments = (): void => {
    for (const cleanup of captureDocuments.values()) cleanup();
    captureDocuments.clear();
  };

  const setMarkersVisible = (visible: boolean) => {
    b.setMarkersVisibleValue(visible);
    b.render();
    b.emit();
  };
  const setCollapsed = (next: boolean) => {
    if (b.collapsed() === next) return;
    b.setCollapsedValue(next);
    if (next && b.captureMode() !== "idle") {
      // Collapsing cancels invisible capture interception while an open
      // composer/editor draft is deliberately preserved: refreshOverlays
      // carries live drafts into the rebuilt surfaces, so a full render both
      // clears the transient overlays (hover/area/multi chip) and keeps text.
      clearCaptureDocuments();
      b.setInspectionFrozen(false);
      b.setCaptureModeValue("idle");
      b.setSelectedValue([]);
      b.setHoverValue(null);
      b.setAreaStartValue(null);
      b.setAreaRectValue(null);
    }
    b.render();
    b.emit();
  };
  const toggleCollapsed = () => setCollapsed(!b.collapsed());

  const clearTransientSelection = () => {
    b.setInspectionFrozen(false);
    b.setSelectedValue([]);
    b.setHoverValue(null);
    b.setAreaStartValue(null);
    b.setAreaRectValue(null);
    b.setComposerValue(null);
  };
  const cancelCapture = () => {
    clearCaptureDocuments();
    b.setCaptureModeValue("idle");
    clearTransientSelection();
    b.render();
    b.emit();
  };
  const startCapture = (mode: Exclude<AgentAnnotationsCaptureMode, "idle">) => {
    b.setCaptureModeValue(mode);
    b.setSelectedValue([]);
    b.setComposerValue(null);
    b.setEditingIdValue(null);
    b.setOpenPanelValue(null);
    refreshCaptureDocuments();
    b.render();
    b.emit();
  };

  // Editor anchoring: a trigger list item rect (captured before the panel
  // closes), else the marker, else the Dock; the editor never silently floats
  // at the top-left. Focus returns to a visible Dock control on close.
  const closeEditor = () => {
    b.setEditingIdValue(null);
    b.setMarkerHighlight(null);
    b.setEditorAnchorRectValue(null);
    b.render();
    // The panel stays closed; focus returns to a Dock control that is
    // actually visible in the current collapse state: the collapsed count
    // when collapsed, the list action when expanded, the grip as fallback.
    const collapsedCount = b.root().querySelector<HTMLElement>(".aa-collapsed-count");
    const listAction = b.root().querySelector<HTMLElement>(
      '[data-action-id="agent-annotations.builtin:list"]'
    );
    const grip = b.root().querySelector<HTMLElement>(".aa-grip");
    const visibleControl = b.collapsed()
      ? collapsedCount
      : listAction ?? collapsedCount ?? grip;
    visibleControl?.focus();
  };
  const focusAnnotation = (id: string) => {
    if (b.destroyed()) return;
    const annotation = b.task().annotations.find((entry) => entry.annotationId === id);
    if (!annotation) return;
    if (annotation.pageContext.routeKey !== b.routeKey()) {
      if (b.host()?.navigate) {
        b.setStatus(b.localized(
          b.host()!.navigateRoute(annotation.pageContext.routeKey)
            ? "Navigating to annotation route"
            : "Annotation is on another route"
        ));
      } else {
        b.setStatus(b.localized("Annotation is on another route"));
      }
      return;
    }
    // Capture the triggering list item rect BEFORE the panel closes so the
    // editor anchors to it; otherwise fall back to the marker or the Dock.
    b.setEditorAnchorRectValue(null);
    if (b.openPanel()) {
      const panel = b.root().querySelector<HTMLElement>(".aa-panel");
      const item = panel?.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`);
      if (item) {
        const rect = item.getBoundingClientRect();
        b.setEditorAnchorRectValue({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }
    b.setEditingIdValue(id);
    b.setMarkerHighlight(id);
    b.setOpenPanelValue(null);
    b.render();
    b.scheduleFrame(() => b.overlayMount().querySelector<HTMLElement>(".aa-editor textarea")?.focus());
  };

  return {
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
  };
};
