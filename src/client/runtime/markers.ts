import {
  resolvePersistedTarget,
  resolveTargetResult,
  targetBounds,
  type TargetResolution,
} from "../inspection-engine.js";
import type {
  AgentAnnotation,
  AgentAnnotationsRect,
  AgentAnnotationsTask,
  HostIntegration,
} from "../../types/index.js";

export type MarkerTargetSummary = {
  resolved: number;
  total: number;
  reason: "unresolved" | "identity mismatch" | "identity unverifiable" | "iframe unsupported" | null;
};

export type MarkerResolutionSnapshot = {
  annotationId: string;
  resolutions: readonly TargetResolution[];
  resolvedTargets: readonly Element[];
  anchor: Element | null;
  anchorBounds: AgentAnnotationsRect | null;
  summary: MarkerTargetSummary;
};

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
  localized(value: string, params?: Record<string, string | number>): string;
  resolutionChanged(): void;
};

export type MarkerController = {
  resolutionSnapshot(annotation: AgentAnnotation): MarkerResolutionSnapshot;
  resetResolutionSnapshots(): void;
  setMarkerHighlight(id: string | null): void;
  renderMarkerHighlights(): void;
  stopMarkerTracking(): void;
  scheduleMarkerRefresh(): void;
  syncMarkerTracking(targets: Element[]): void;
  hasUnresolvedFrameTarget(): boolean;
  resetTrackedTargets(): void;
  hasTracking(): boolean;
};

export const createMarkerController = (b: MarkerBindings): MarkerController => {
  let snapshots = new Map<string, MarkerResolutionSnapshot>();
  const previousSummaries = new Map<string, string>();

  const resolutionSnapshot = (annotation: AgentAnnotation): MarkerResolutionSnapshot => {
    const cached = snapshots.get(annotation.annotationId);
    if (cached) return cached;
    const targets = annotation.targets ?? [];
    const resolutions = targets.map((target) =>
      resolvePersistedTarget(target, { appRoot: b.appRoot(), host: b.host() })
    );
    const resolvedTargets = resolutions.flatMap((resolution) =>
      resolution.status === "resolved" && b.isInAppRoot(resolution.element) ? [resolution.element] : []
    );
    const firstUnresolved = resolutions.find((resolution) =>
      resolution.status !== "resolved" || !b.isInAppRoot(resolution.element)
    );
    const anchor = resolvedTargets[0] ?? null;
    // Completed annotations remain useful after a page change. When their
    // target no longer resolves, retain the capture-time viewport position
    // converted back through the capture scroll offset.
    const anchorBounds = anchor
      ? targetBounds(anchor)
      : annotation.status === "completed" && annotation.targets?.[0]
        ? {
            x: annotation.targets[0].bounds.x + annotation.pageContext.scroll.x - scrollX,
            y: annotation.targets[0].bounds.y + annotation.pageContext.scroll.y - scrollY,
            width: annotation.targets[0].bounds.width,
            height: annotation.targets[0].bounds.height,
          }
        : null;
    const reason = firstUnresolved && resolvedTargets.length < targets.length
      ? firstUnresolved.status === "identity_mismatch"
        ? "identity mismatch"
        : firstUnresolved.status === "identity_unverifiable"
          ? "identity unverifiable"
          : firstUnresolved.status === "unsupported"
            ? "iframe unsupported"
            : "unresolved"
      : null;
    const snapshot: MarkerResolutionSnapshot = {
      annotationId: annotation.annotationId,
      resolutions,
      resolvedTargets,
      anchor,
      anchorBounds,
      summary: { resolved: resolvedTargets.length, total: targets.length, reason },
    };
    snapshots.set(annotation.annotationId, snapshot);
    if (!previousSummaries.has(annotation.annotationId)) {
      previousSummaries.set(annotation.annotationId, JSON.stringify(snapshot.summary));
    }
    return snapshot;
  };
  const resetResolutionSnapshots = () => {
    snapshots = new Map();
    const current = new Set(b.task().annotations.map(({ annotationId }) => annotationId));
    for (const annotationId of previousSummaries.keys()) {
      if (!current.has(annotationId)) previousSummaries.delete(annotationId);
    }
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
    for (const element of resolutionSnapshot(annotation).resolvedTargets) {
      const rect = targetBounds(element);
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
  let markerRealmCleanups: Array<() => void> = [];
  let markerRealms = new WeakSet<Node>();
  let markerFrames = new WeakSet<Element>();
  let trackedMarkerTargets = new WeakSet<Element>();
  let trackedMarkerTargetList: Element[] = [];
  let markerFrame: number | null = null;
  let markerRefreshes = 0;
  const resetTrackedTargets = (): void => {
    trackedMarkerTargets = new WeakSet<Element>();
    trackedMarkerTargetList = [];
  };
  const stopMarkerTracking = () => {
    markerObserver?.disconnect();
    markerResizeObserver?.disconnect();
    for (const cleanup of markerRealmCleanups.splice(0)) cleanup();
    markerRealms = new WeakSet<Node>();
    markerFrames = new WeakSet<Element>();
    trackedMarkerTargets = new WeakSet<Element>();
    trackedMarkerTargetList = [];
    markerObserver = null;
    markerResizeObserver = null;
    if (markerFrame !== null) {
      b.cancelFrame(markerFrame);
      markerFrame = null;
    }
  };

  const updateSummaryText = (annotation: AgentAnnotation, snapshot: MarkerResolutionSnapshot) => {
    const marker = Array.from(b.overlayMount().querySelectorAll<HTMLElement>(".aa-marker"))
      .find((node) => node.dataset.annotationId === annotation.annotationId);
    if (marker && snapshot.summary.total > 0) {
      const { resolved, total, reason } = snapshot.summary;
      marker.dataset.resolved = String(resolved);
      marker.dataset.total = String(total);
      const label = marker.getAttribute("aria-label") ?? "";
      const targets = b.localized("targets", { resolved, total });
      marker.dataset.tooltip = resolved < total
        ? `${label} · ${targets} · ${b.localized(reason ?? "unresolved")}`
        : `${label} · ${targets}`;
      if (highlightedAnnotation === annotation.annotationId) {
        const tooltip = b.overlayMount().querySelector<HTMLElement>(".aa-tooltip");
        if (tooltip) tooltip.textContent = marker.dataset.tooltip;
      }
    }
    const editor = Array.from(b.overlayMount().querySelectorAll<HTMLElement>(".aa-editor"))
      .find((node) => node.dataset.annotationId === annotation.annotationId)
      ?.querySelector<HTMLElement>(".aa-targets");
    if (editor) {
      const { resolved, total, reason } = snapshot.summary;
      editor.textContent = resolved < total
        ? `${b.localized("targets", { resolved, total })} · ${b.localized(reason ?? "unresolved")}`
        : b.localized("targets", { resolved, total });
    }
  };

  const scheduleMarkerRefresh = () => {
    if (markerFrame !== null) return;
    markerFrame = b.scheduleFrame(() => {
      markerFrame = null;
      resetResolutionSnapshots();
      const resolved: Element[] = [];
      let summaryChanged = false;
      for (const annotation of b.task().annotations) {
        if (annotation.pageContext.routeKey !== b.routeKey()) continue;
        const marker = Array.from(b.overlayMount().querySelectorAll<HTMLElement>(".aa-marker"))
          .find((node) => node.dataset.annotationId === annotation.annotationId);
        if (!marker && annotation.annotationId !== b.editingId()) continue;
        const previousSummary = previousSummaries.get(annotation.annotationId);
        const snapshot = resolutionSnapshot(annotation);
        resolved.push(...snapshot.resolvedTargets);
        const rect = snapshot.anchorBounds;
        const anchor = annotation.region
          ? { x: annotation.region.x - scrollX + annotation.region.width - 14, y: annotation.region.y - scrollY + 4 }
          : rect
            ? { x: rect.x - 8, y: rect.y - 8 }
            : null;
        if (marker) {
          marker.hidden = !anchor;
          if (anchor) Object.assign(marker.style, { left: `${anchor.x}px`, top: `${anchor.y}px` });
        }
        updateSummaryText(annotation, snapshot);
        const summaryKey = JSON.stringify(snapshot.summary);
        if (previousSummary !== undefined && previousSummary !== summaryKey) {
          summaryChanged = true;
          previousSummaries.set(annotation.annotationId, summaryKey);
        }
      }
      renderMarkerHighlights();
      b.positionComposer();
      b.positionEditor();
      markerRefreshes += 1;
      b.hostElement().dataset.markerRefreshes = String(markerRefreshes);
      if (resolved.length !== trackedMarkerTargetList.length ||
          resolved.some((target) => !trackedMarkerTargets.has(target))) {
        syncMarkerTracking(resolved);
      } else if (needsRealmTracking()) {
        watchPersistedRealms(hasUnresolvedRealmTarget());
      }
      if (summaryChanged) b.resolutionChanged();
    });
  };

  const routeAnnotations = () => b.task().annotations.filter((annotation) =>
    annotation.pageContext.routeKey === b.routeKey()
  );
  const hasUnresolvedFrameTarget = (): boolean => routeAnnotations().some((annotation) => {
    const snapshot = resolutionSnapshot(annotation);
    return annotation.targets?.some((target, index) =>
      target.selector.includes(">>iframe>>") &&
      (snapshot.resolutions[index]?.status !== "resolved" ||
        !b.isInAppRoot(snapshot.resolutions[index].element))
    );
  });
  const hasUnresolvedRealmTarget = (): boolean => routeAnnotations().some((annotation) => {
    const snapshot = resolutionSnapshot(annotation);
    return annotation.targets?.some((target, index) =>
      (target.selector.includes(">>iframe>>") || target.selector.includes(">>>")) &&
      (snapshot.resolutions[index]?.status !== "resolved" ||
        !b.isInAppRoot(snapshot.resolutions[index].element))
    );
  });
  const needsRealmTracking = () => (b.markersVisible() || !!b.editingId()) &&
    routeAnnotations().some((annotation) => annotation.targets?.some(({ selector }) =>
      selector.includes(">>iframe>>") || selector.includes(">>>")
    ));

  const watchPersistedRealms = (observeSetup: boolean) => {
    const root = b.appRoot();
    for (const annotation of routeAnnotations()) {
      for (const target of annotation.targets ?? []) {
        const tokens = target.selector.split(/(>>>|>>iframe>>)/).map((value) => value.trim()).filter(Boolean);
        for (let index = 1; index < tokens.length; index += 2) {
          const boundary = tokens[index];
          const prefix = tokens.slice(0, index).join(" ");
          const result = resolveTargetResult(prefix, root);
          if (result.status !== "resolved") break;
          if (boundary === ">>iframe>>" && !markerFrames.has(result.element)) {
            markerFrames.add(result.element);
            const refresh = () => scheduleMarkerRefresh();
            result.element.addEventListener("load", refresh);
            markerRealmCleanups.push(() => result.element.removeEventListener("load", refresh));
          }
          let realm: Document | ShadowRoot | null = null;
          try {
            realm = boundary === ">>>"
              ? result.element.shadowRoot
              : (result.element as HTMLIFrameElement).contentDocument;
          } catch {
            // Cross-origin frames stay unsupported and are never observed.
          }
          if (!realm || markerRealms.has(realm)) continue;
          markerRealms.add(realm);
          if (observeSetup) {
            // Track mutations inside the exact persisted realm; no global DOM scan.
            const observer = new MutationObserver(scheduleMarkerRefresh);
            observer.observe(realm, { childList: true, subtree: true });
            markerRealmCleanups.push(() => observer.disconnect());
          }
        }
      }
    }
  };

  function syncMarkerTracking(targets: Element[]): void {
    stopMarkerTracking();
    const watchRealms = needsRealmTracking();
    trackedMarkerTargets = new WeakSet(targets);
    trackedMarkerTargetList = [...targets];
    const hasElementComposer = b.hasElementComposer();
    const watchMarkers = b.markersVisible() && routeAnnotations().length > 0;
    if (!watchMarkers && !b.editingId() && !hasElementComposer) return;
    if (watchRealms) watchPersistedRealms(hasUnresolvedRealmTarget());
    markerObserver = new MutationObserver(() => {
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
    resolutionSnapshot,
    resetResolutionSnapshots,
    setMarkerHighlight,
    renderMarkerHighlights,
    stopMarkerTracking,
    resetTrackedTargets,
    scheduleMarkerRefresh,
    syncMarkerTracking,
    hasTracking: () => markerObserver !== null,
    hasUnresolvedFrameTarget,
  };
};
