import { Component, createElement, useLayoutEffect, useRef, useSyncExternalStore, type ComponentType } from "react";

import type {
  AgentAnnotationsDiagnosticPhase,
  AgentAnnotationsIconProps,
  StudioPublicApi,
  StudioPublicSnapshot,
} from "../../types/index.js";
import type { ClientExtensionRegistry } from "../../extension/index.js";
import { safeErrorText } from "./annotated.js";
import { AnnotationsIcon, FallbackIcon, GripIcon } from "../icons.js";

export type RegisteredToolbarContribution = ReturnType<
  ClientExtensionRegistry["getToolbarContributions"]
>[number];

type IconBoundaryProps = {
  extensionId: string;
  contributionId: string;
  icon: ComponentType<AgentAnnotationsIconProps>;
  onError: (message: string) => void;
};

// A local error boundary around each toolbar icon: a faulty third-party icon
// renders the safe fallback in the existing single root and records
// phase=icon. The imperative built-in icon markup (iconButton) stays
// unchanged, and browser-only icons are rendered exactly once.
class IconBoundary extends Component<IconBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(safeErrorText(error));
  }

  render(): import("react").ReactNode {
    if (this.state.failed) return createElement(FallbackIcon, { className: "aa-icon" });
    return createElement(this.props.icon, { className: "aa-icon" });
  }
}

type PanelErrorBoundaryProps = {
  onError: (message: string) => void;
  fallbackText: string;
  children: import("react").ReactNode;
};
type PanelErrorBoundaryState = { failed: boolean };

class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PanelErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(safeErrorText(error));
  }

  render(): import("react").ReactNode {
    if (this.state.failed) {
      return createElement("p", { className: "aa-panel-error" }, this.props.fallbackText);
    }
    return this.props.children;
  }
}

export type ChromeBindings = {
  registry: ClientExtensionRegistry;
  localized(
    value: string | Readonly<Record<string, string>>,
    params?: Record<string, string | number>
  ): string;
  showTooltip(trigger: HTMLElement): void;
  hideTooltip(): void;
  positionPanel(): void;
  executeContribution(contribution: RegisteredToolbarContribution): void;
  setCollapsed(next: boolean): void;
  guardedPredicate<T>(
    extensionId: string,
    contributionId: string,
    phase: "visible" | "enabled" | "pressed",
    fallback: T,
    invoke: () => T
  ): T;
  recordExtensionFailure(
    extensionId: string,
    phase: AgentAnnotationsDiagnosticPhase,
    contributionId: string | undefined,
    error: unknown
  ): void;
  pendingActions: Set<string>;
  // Dynamic binding fields are read through narrow getters so the chrome
  // always sees the current value, never a mount-time snapshot.
  getCollapseAction(): string | null;
  getCollapseContribution(): RegisteredToolbarContribution | undefined;
  getShortcuts(): StudioPublicSnapshot["shortcuts"];
  getToolbar(): readonly RegisteredToolbarContribution[];
  getDockPosition(): { left: number; top: number } | null;
  takeFocusPanel(): boolean;
  studioRenders: number;
  hostElement: HTMLElement;
  api: StudioPublicApi | null;
  onGripPointerDown(event: import("react").PointerEvent<HTMLButtonElement>, dock: HTMLDivElement): void;
  onGripPointerMove(event: import("react").PointerEvent<HTMLButtonElement>, dock: HTMLDivElement | null): void;
  onGripPointerUp(): void;
  focusPanelControl(panel: HTMLElement): void;
  closePanel(id: string): void;
};

export const ToolbarButton = (props: {
    b: ChromeBindings;
    contribution: RegisteredToolbarContribution;
    label: string;
    shortcut?: StudioPublicSnapshot["shortcuts"][number];
    current: StudioPublicSnapshot;
  }): import("react").ReactNode => {
    const ref = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
      const node = ref.current!;
      const enter = () => b.showTooltip(node);
      const leave = () => b.hideTooltip();
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
    const { b, contribution, label, shortcut, current } = props;
    const pressed = b.guardedPredicate(
      contribution.extensionId,
      contribution.id,
      "pressed",
      undefined,
      () => contribution.isPressed?.(current)
    );
    const disabled = b.pendingActions.has(contribution.id)
      || b.guardedPredicate(contribution.extensionId, contribution.id, "enabled", true, () =>
        contribution.isEnabled?.(current) === false
      );
    return createElement("button", {
      ref,
      key: contribution.id,
      type: "button",
      className: "aa-action",
      disabled,
      "aria-label": `${label}${shortcut ? ` (${shortcut.formatted})` : ""}`,
      "data-action-id": contribution.id,
      ...(pressed !== undefined ? { "aria-pressed": String(pressed) } : {}),
      ...(contribution.kind === "panel"
        ? { "aria-expanded": String(current.openPanel === contribution.panelId) }
        : {}),
      ...(contribution.id === b.getCollapseAction() ? { "data-toggle": "true" } : {}),
      onClick: () => b.executeContribution(contribution),
    }, createElement(IconBoundary, {
      extensionId: contribution.extensionId,
      contributionId: contribution.id,
      icon: contribution.icon,
      onError: (message) => b.recordExtensionFailure(
        contribution.extensionId,
        "icon",
        contribution.id,
        message
      ),
    }));
  };

export const CollapsedCount = (props: {
    b: ChromeBindings;
    openCount: number;
    current: StudioPublicSnapshot;
  }): import("react").ReactNode => {
    const ref = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
      const node = ref.current!;
      const enter = () => b.showTooltip(node);
      const leave = () => b.hideTooltip();
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
    const { b, openCount, current } = props;
    const listOpen = current.openPanel === "agent-annotations.builtin:list";
    const listPanel = b.registry.getPanels().find((panel) => panel.id === "agent-annotations.builtin:list");
    const listContribution = b.getToolbar().find((entry) => entry.id === "agent-annotations.builtin:list");
    const collapseContributionId = b.getToolbar().find((entry) => entry.id === "agent-annotations.builtin:toggle")?.id;
    const listShortcut = b.getShortcuts().find((entry) => entry.id === "agent-annotations.builtin:list");
    const listLabel = listPanel ? b.localized(listPanel.title) : b.localized("Annotation list");
    const zeroLabel = listShortcut ? `${listLabel} (${listShortcut.formatted})` : listLabel;
    const hasList = listContribution !== undefined;
    const countLabel = openCount === 0
      ? zeroLabel
      : b.localized("openAnnotations", { count: openCount });
    const expandLabel = b.localized("Expand toolbar");
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
          b.executeContribution(listContribution);
        } else {
          // No list panel registered (list disabled or builtins:false): the
          // visible collapsed control expands the toolbar instead.
          b.setCollapsed(false);
        }
      },
    }, openCount === 0
      ? createElement(AnnotationsIcon, { className: "aa-icon" })
      : createElement("span", { className: "aa-count-badge" }, openCount > 99 ? "99+" : String(openCount)));
  };

export const StudioChrome = (props: {
    b: ChromeBindings;
    uiSubscribe: (listener: () => void) => () => void;
    uiGetSnapshot: () => StudioPublicSnapshot;
  }): import("react").ReactNode => {
    const { b, uiSubscribe, uiGetSnapshot } = props;
    b.studioRenders += 1;
    b.hostElement.dataset.studioRenders = String(b.studioRenders);
    const current = useSyncExternalStore(uiSubscribe, uiGetSnapshot);
    const openCount = current.task.annotations.filter((entry) => entry.status === "open").length;
    const dockRef = useRef<HTMLDivElement | null>(null);
    const gripRef = useRef<HTMLButtonElement | null>(null);
    const panelRef = useRef<HTMLElement | null>(null);
    const panelContribution = b.registry.getPanels().find(({ id }) => id === current.openPanel);
    const collapseEntry = b.getCollapseContribution();
    const collapseChrome = collapseEntry
      ? [
          createElement("div", { key: "aa-divider", className: "aa-divider", role: "separator" }),
          createElement(ToolbarButton, {
            key: collapseEntry.id,
            b,
            contribution: collapseEntry,
            label: b.localized(collapseEntry.label),
            shortcut: b.getShortcuts().find(({ id }) => id === collapseEntry.id),
            current,
          }),
        ]
      : [];

    useLayoutEffect(() => {
      const grip = gripRef.current!;
      const enter = () => b.showTooltip(grip);
      const leave = () => b.hideTooltip();
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
      b.positionPanel();
      if (b.takeFocusPanel() && panelRef.current) {
        b.focusPanelControl(panelRef.current);
      }
    });

    return createElement("div", { className: "aa-chrome" },
      createElement("div", {
        ref: dockRef,
        className: "aa-dock",
        "data-collapsed": String(current.collapsed),
        style: b.getDockPosition()
          ? { left: `${b.getDockPosition()!.left}px`, top: `${b.getDockPosition()!.top}px`, bottom: "auto" }
          : undefined,
      },
        createElement("button", {
          ref: gripRef,
          type: "button",
          className: "aa-grip",
          "aria-label": b.localized("Drag toolbar"),
          onPointerDown: (event: import("react").PointerEvent<HTMLButtonElement>) => {
            b.onGripPointerDown(event, dockRef.current!);
          },
          onPointerMove: (event: import("react").PointerEvent<HTMLButtonElement>) => {
            b.onGripPointerMove(event, dockRef.current);
          },
          onPointerUp: () => b.onGripPointerUp(),
        }, createElement(GripIcon, { className: "aa-icon" })),
        ...(current.collapsed
          ? [createElement(CollapsedCount, { key: "collapsed-count", b, openCount, current })]
          : []),
        ...b.getToolbar().flatMap((contribution) => {
          if (contribution.id === b.getCollapseAction()) return [];
          const label = b.localized(contribution.label);
          const shortcut = b.getShortcuts().find(({ id }) => id === contribution.id);
          if (b.guardedPredicate(contribution.extensionId, contribution.id, "visible", true, () =>
            contribution.isVisible?.(current) === false
          )) {
            return [];
          }
          return [createElement(ToolbarButton, {
            key: contribution.id,
            b,
            contribution,
            label,
            shortcut,
            current,
          })];
        }),
        ...collapseChrome
      ),
      panelContribution
        ? createElement("section", {
            key: panelContribution.id,
            ref: panelRef,
            className: "aa-panel",
            role: "dialog",
            "aria-modal": "false",
            tabIndex: -1,
            "aria-label": b.localized(panelContribution.title),
          },
            createElement("h2", null, b.localized(panelContribution.title)),
            createElement("div", null,
              createElement(PanelErrorBoundary, {
                onError: (message) => b.recordExtensionFailure(
                  panelContribution.extensionId,
                  "panel",
                  panelContribution.id,
                  message
                ),
                fallbackText: b.localized("Panel failed to render"),
                children: createElement(panelContribution.render, {
                  studio: b.api!,
                  close: () => b.closePanel(panelContribution.id),
                }),
              })
            )
          )
        : null
    );
  };
