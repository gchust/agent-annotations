import { resolvePersistedTarget, targetBounds, type TargetResolution } from "../inspection-engine.js";
import type { AgentAnnotation, AgentAnnotationsTask, HostIntegration } from "../../types/index.js";

// Focused marker-controller bindings: dynamic mount values are read through
// narrow getters so the controller always sees the current state.
export type MarkerBindings = {
  task(): AgentAnnotationsTask;
  routeKey(): string;
  markersVisible(): boolean;
  appRoot(): Element | Document;
  host(): HostIntegration | undefined;
  overlayMount(): HTMLElement;
  hostElement(): HTMLElement;
  editingId(): string | null;
  hasElementComposer(): boolean;
  scheduleFrame(callback: () => void): number;
  cancelFrame(frame: number): void;
  isInAppRoot(element: Element): boolean;
  positionComposer(): void;
  positionEditor(): void;
  resolveTargetInAppRoot(selector: string): Element | null;
};

export type MarkerController = {
  firstResolvedTarget(annotation: AgentAnnotation): Element | null;
  annotationTargetSummary(annotation: AgentAnnotation): {
    resolved: number;
    total: number;
    reason: "unresolved" | "identity mismatch" | "identity unverifiable" | "iframe unsupported" | null;
  };
  setMarkerHighlight(id: string | null): void;
  renderMarkerHighlights(): void;
  stopMarkerTracking(): void;
  scheduleMarkerRefresh(): void;
  syncMarkerTracking(targets: Element[]): void;
  watchMarkerFrames(scope: ParentNode, observeSetup: boolean): void;
  hasPersistedFrameTarget(): boolean;
  hasUnresolvedFrameTarget(): boolean;
  resetTrackedTargets(): void;
  hasTracking(): boolean;
};

export const createMarkerController = (b: MarkerBindings): MarkerController => {
  // The marker's primary anchor is the FIRST RESOLVABLE target (contract):
  // an earlier unresolved target never hides a marker whose later target
  // still resolves in the app root.
  const firstResolvedTarget = (annotation: AgentAnnotation): Element | null => {
    for (const target of annotation.targets ?? []) {
      const resolution = resolvePersistedTarget(target, { appRoot: b.appRoot(), host: b.host() });
      if (resolution.status === "resolved" && b.isInAppRoot(resolution.element)) {
        return resolution.element;
      }
    }
    return null;
  };

  // Per-annotation resolution summary: resolved/total plus the first
  // unresolved reason key (a stable message key, never raw resolution text).
  const annotationTargetSummary = (
    annotation: AgentAnnotation
  ): {
    resolved: number;
    total: number;
    reason: "unresolved" | "identity mismatch" | "identity unverifiable" | "iframe unsupported" | null;
  } => {
    const targets = annotation.targets ?? [];
    let resolved = 0;
    let firstUnresolved: TargetResolution | null = null;
    for (const target of targets) {
      const resolution = resolvePersistedTarget(target, { appRoot: b.appRoot(), host: b.host() });
      if (resolution.status === "resolved" && b.isInAppRoot(resolution.element)) {
        resolved += 1;
      } else if (!firstUnresolved) {
        firstUnresolved = resolution;
      }
    }
    let reason: "unresolved" | "identity mismatch" | "identity unverifiable" | "iframe unsupported" | null = null;
    if (firstUnresolved && resolved < targets.length) {
      reason = firstUnresolved.status === "identity_mismatch"
        ? "identity mismatch"
        : firstUnresolved.status === "identity_unverifiable"
          ? "identity unverifiable"
          : firstUnresolved.status === "unsupported"
            ? "iframe unsupported"
            : "unresolved";
    }
    return { resolved, total: targets.length, reason };
  };

  // Temporary multi-target highlight: DOM-only updates, so high-frequency
  // marker hover/focus never rebuilds the React root or the Chrome.
  let highlightedAnnotation: string | null = null;
  const renderMarkerHighlights = () => {
    for (const node of b.overlayMount().querySelectorAll(".aa-marker-highlight")) node.remove();
    const id = highlightedAnnotation ?? b.editingId();
    if (!id) return;
    const annotation = b.task().annotations.find((entry) => entry.annotationId === id);
    if (!annotation) return;
    for (const target of annotation.targets ?? []) {
      const resolution = resolvePersistedTarget(target, { appRoot: b.appRoot(), host: b.host() });
      if (resolution.status !== "resolved" || !b.isInAppRoot(resolution.element)) continue;
      const rect = targetBounds(resolution.element);
      const node = document.createElement("div");
      node.className = "aa-marker-highlight";
      node.dataset.annotationId = annotation.annotationId;
      Object.assign(node.style, {
        left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      });
      b.overlayMount().append(node);
    }
  };
  function setMarkerHighlight(id: string | null): void {
    if (highlightedAnnotation === id) return;
    highlightedAnnotation = id;
    renderMarkerHighlights();
  }

  let markerObserver: MutationObserver | null = null;
  let markerResizeObserver: ResizeObserver | null = null;
  let markerFrameCleanups: Array<() => void> = [];
  let markerFrames = new WeakSet<Element>();
  let markerDocuments = new WeakSet<Document>();
  let trackedMarkerTargets = new WeakSet<Element>();
  let markerFrame: number | null = null;
  let markerRefreshes = 0;
  const resetTrackedTargets = (): void => {
    trackedMarkerTargets = new WeakSet<Element>();
  };
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
      b.cancelFrame(markerFrame);
      markerFrame = null;
    }
  };
  const scheduleMarkerRefresh = () => {
    if (markerFrame !== null) return;
    markerFrame = b.scheduleFrame(() => {
      markerFrame = null;
      const resolved: Element[] = [];
      for (const annotation of b.task().annotations) {
        if (annotation.pageContext.routeKey !== b.routeKey()) continue;
        const marker = Array.from(b.overlayMount().querySelectorAll<HTMLElement>(".aa-marker"))
          .find((node) => node.dataset.annotationId === annotation.annotationId);
        if (!marker) continue;
        const targetInRoot = firstResolvedTarget(annotation);
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
      b.positionComposer();
      b.positionEditor();
      markerRefreshes += 1;
      b.hostElement().dataset.markerRefreshes = String(markerRefreshes);
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
            b.scheduleFrame(scheduleMarkerRefresh);
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
  const hasPersistedFrameTarget = (): boolean => b.task().annotations.some((annotation) =>
    annotation.status === "open" &&
    annotation.pageContext.routeKey === b.routeKey() &&
    annotation.targets?.some(({ selector }) => selector.includes(">>iframe>>"))
  );
  const hasUnresolvedFrameTarget = (): boolean => b.task().annotations.some((annotation) => {
    const selector = annotation.status === "open" && annotation.pageContext.routeKey === b.routeKey()
      ? annotation.targets?.[0]?.selector
      : undefined;
    if (!selector?.includes(">>iframe>>")) return false;
    const target = b.resolveTargetInAppRoot(selector);
    return !target || !b.isInAppRoot(target);
  });
  function syncMarkerTracking(targets: Element[]): void {
    stopMarkerTracking();
    const watchFrames = b.markersVisible() && hasPersistedFrameTarget();
    trackedMarkerTargets = new WeakSet(targets);
    const hasElementComposer = b.hasElementComposer();
    if ((!b.markersVisible() || targets.length === 0) && !b.editingId() && !hasElementComposer && !watchFrames) return;
    if (watchFrames) watchMarkerFrames(b.appRoot() as ParentNode, hasUnresolvedFrameTarget());
    markerObserver = new MutationObserver(() => {
      if (watchFrames) watchMarkerFrames(b.appRoot() as ParentNode, hasUnresolvedFrameTarget());
      scheduleMarkerRefresh();
    });
    const mutationOptions = { childList: true, subtree: true };
    markerObserver.observe(b.appRoot() as ParentNode, mutationOptions);
    const observed = new Set<Node>([b.appRoot() as Node]);
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
  return {
    firstResolvedTarget,
    annotationTargetSummary,
    setMarkerHighlight,
    renderMarkerHighlights,
    stopMarkerTracking,
    resetTrackedTargets,
    scheduleMarkerRefresh,
    syncMarkerTracking,
    hasTracking: () => markerObserver !== null,
    watchMarkerFrames,
    hasPersistedFrameTarget,
    hasUnresolvedFrameTarget,
  };
};
