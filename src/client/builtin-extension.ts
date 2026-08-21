import { createElement, useState } from "react";

import { defineClientExtension } from "../extension/index.js";
import type {
  AgentAnnotationsBuiltinActionId,
  AgentAnnotationsToolbarShortcut,
  PanelContribution,
  StudioPublicApi,
  ToolbarContribution,
} from "../types/index.js";
import {
  AnnotationsIcon,
  AreaIcon,
  CloseIcon,
  CollapseIcon,
  CopyIcon,
  HelpIcon,
  MarkersIcon,
  MultiIcon,
  PickIcon,
} from "./icons.js";

export type AgentAnnotationsBuiltinExtensionOptions = {
  actions?: Partial<Record<AgentAnnotationsBuiltinActionId, boolean>>;
  shortcuts?: Partial<
    Record<AgentAnnotationsBuiltinActionId, AgentAnnotationsToolbarShortcut | false>
  >;
};

const shortcut = (
  key: string,
  code: string,
  primary = true,
  alt = true,
  shift = false
) => ({ key, code, primary, alt, shift });
const toggleCollapsed = ({ collapsed }: { collapsed: boolean }) => collapsed;
const showCollapse = ({ collapsed }: { collapsed: boolean }) => !collapsed;
const translate = (
  studio: StudioPublicApi,
  value: string,
  params?: Record<string, string | number>
): string => {
  const text = studio.getSnapshot().messages[value] ?? value;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  );
};

const HelpPanel: PanelContribution["render"] = ({ studio, close }) =>
  createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        className: "aa-button aa-icon-button",
        "aria-label": translate(studio, "Close"),
        title: translate(studio, "Close"),
        onClick: close,
      },
      createElement(CloseIcon)
    ),
    createElement(
      "ul",
      { className: "aa-help-list" },
      ...studio.getSnapshot().shortcuts.map((entry) =>
        createElement(
          "li",
          { className: "aa-help-row", key: entry.id },
          createElement("span", null, entry.label),
          createElement("kbd", null, entry.formatted)
        )
      )
    )
  );

const AnnotationList: PanelContribution["render"] = ({ studio, close }) => {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const snapshot = studio.getSnapshot();
  const completedCount = snapshot.task.annotations
    .filter((annotation) => annotation.status === "completed").length;
  const summary = (annotationId: string) => studio.commands.annotations.targetSummary(annotationId);
  return createElement(
    "div",
    null,
    createElement(
      "div",
      { className: "aa-filter" },
      createElement(
        "button",
        {
          type: "button",
          className: "aa-button",
          "aria-pressed": filter === "open",
          onClick: () => setFilter("open"),
        },
        translate(studio, "Open")
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "aa-button",
          "aria-pressed": filter === "all",
          onClick: () => setFilter("all"),
        },
        translate(studio, "All")
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "aa-button aa-icon-button",
          "aria-label": translate(studio, "Close"),
          title: translate(studio, "Close"),
          onClick: close,
        },
        createElement(CloseIcon)
      )
    ),
    createElement(
      "ol",
      { className: "aa-list" },
      ...snapshot.task.annotations.flatMap((annotation, index) => {
        if (filter === "open" && annotation.status !== "open") return [];
        const resolved = summary(annotation.annotationId);
        const meta: string[] = [];
        if (annotation.pageContext.routeKey) {
          meta.push(`${translate(studio, "Route")} ${annotation.pageContext.routeKey}`);
        }
        meta.push(translate(studio, annotation.kind));
        if (resolved.total > 0) {
          meta.push(translate(studio, "targets", {
            resolved: resolved.resolved,
            total: resolved.total,
          }));
        }
        if ((annotation.evidence?.length ?? 0) > 0) {
          meta.push(translate(studio, "evidence", { count: annotation.evidence!.length }));
        }
        const reason = resolved.resolved < resolved.total && resolved.reason
          ? translate(studio, resolved.reason)
          : null;
        return [
          createElement(
            "li",
            {
              className: "aa-list-item",
              key: annotation.annotationId,
              "data-annotation-id": annotation.annotationId,
            },
            createElement(
              "button",
              {
                type: "button",
                className: "aa-button aa-list-open",
                "aria-label": `${translate(studio, "Edit annotation")} ${index + 1}`,
                onClick: () => studio.commands.markers.focus(annotation.annotationId),
                onFocus: () => studio.commands.markers.highlight(annotation.annotationId),
                onBlur: () => studio.commands.markers.highlight(null),
              },
              createElement(
                "span",
                { className: "aa-list-main" },
                createElement(
                  "span",
                  { className: "aa-list-title" },
                  createElement("b", null, `${index + 1}.`),
                  " ",
                  annotation.comment
                ),
                createElement(
                  "span",
                  { className: "aa-muted" },
                  meta.join(" · ")
                )
              )
            ),
            createElement(
              "span",
              {
                className: "aa-status-chip",
                "data-status": annotation.status,
              },
              translate(studio, annotation.status)
            ),
            reason
              ? createElement(
                  "span",
                  { className: "aa-muted aa-unresolved" },
                  translate(studio, reason)
                )
              : null
          ),
        ];
      })
    ),
    createElement(
      "div",
      { className: "aa-filter" },
      createElement(
        "button",
        {
          type: "button",
          className: "aa-button aa-danger",
          disabled: completedCount === 0,
          "aria-label": translate(studio, "Remove completed", { count: completedCount }),
          onClick: () => {
            const wording = completedCount === 1
              ? translate(studio, "Confirm remove completed one")
              : translate(studio, "Confirm remove completed", { count: completedCount });
            if (!window.confirm(wording)) return;
            studio.commands.annotations.removeCompleted();
          },
        },
        translate(studio, "Remove completed", { count: completedCount })
      )
    )
  );
};

const baseToolbar: Record<
  AgentAnnotationsBuiltinActionId,
  ToolbarContribution
> = {
  pick: { id: "pick", group: "capture", order: 10, label: "Pick", icon: PickIcon, kind: "toggle", shortcut: shortcut("P", "KeyP"), isPressed: ({ captureMode }) => captureMode === "pick", execute: ({ studio }) => studio.commands.capture.startPick() },
  multi: { id: "multi", group: "capture", order: 20, label: "Multi", icon: MultiIcon, kind: "toggle", shortcut: shortcut("M", "KeyM"), isPressed: ({ captureMode }) => captureMode === "multi", execute: ({ studio }) => studio.commands.capture.startMulti() },
  area: { id: "area", group: "capture", order: 30, label: "Area", icon: AreaIcon, kind: "toggle", shortcut: shortcut("A", "KeyA"), isPressed: ({ captureMode }) => captureMode === "area", execute: ({ studio }) => studio.commands.capture.startArea() },
  copy: { id: "copy", group: "handoff", order: 10, label: "Copy", icon: CopyIcon, kind: "action", shortcut: shortcut("C", "KeyC"), execute: ({ studio }) => studio.commands.annotations.copyOpen() },
  markers: { id: "visibility", group: "view", order: 10, label: "Markers", icon: MarkersIcon, kind: "toggle", shortcut: shortcut("V", "KeyV"), isPressed: ({ markersVisible }) => markersVisible, execute: ({ studio }) => studio.getSnapshot().markersVisible ? studio.commands.markers.hide() : studio.commands.markers.show() },
  help: { id: "help", group: "view", order: 20, label: "Shortcut help", icon: HelpIcon, kind: "panel", shortcut: shortcut("/", "Slash", false, false, true), panelId: "help", isPressed: ({ openPanel }) => openPanel === "agent-annotations.builtin:help" },
  list: { id: "list", group: "view", order: 30, label: "Annotations", icon: AnnotationsIcon, kind: "panel", shortcut: shortcut("L", "KeyL"), panelId: "list", isPressed: ({ openPanel }) => openPanel === "agent-annotations.builtin:list" },
  collapse: { id: "toggle", group: "view", order: 40, label: "Collapse toolbar", icon: CollapseIcon, kind: "toggle", shortcut: shortcut("K", "KeyK"), isVisible: showCollapse, isPressed: toggleCollapsed, execute: ({ studio }) => studio.commands.toolbar.toggleCollapsed() },
};

// Configurable builtin extension factory: unconfigured actions stay enabled,
// a disabled action contributes neither toolbar entry nor shortcut, and
// shortcut overrides (or `false` to remove a shortcut) still go through the
// registry's conflict validation. `builtins: false` at mount simply skips
// this extension entirely.
export const createBuiltinClientExtension = (
  options: AgentAnnotationsBuiltinExtensionOptions = {}
): ReturnType<typeof defineClientExtension> => {
  const enabled = (id: AgentAnnotationsBuiltinActionId): boolean =>
    options.actions?.[id] !== false;
  const shortcutFor = (
    id: AgentAnnotationsBuiltinActionId,
    fallback: AgentAnnotationsToolbarShortcut | undefined
  ): AgentAnnotationsToolbarShortcut | undefined => {
    const override = options.shortcuts?.[id];
    if (override === false) return undefined;
    return override ?? fallback;
  };
  const toolbar: ToolbarContribution[] = [];
  const panels: PanelContribution[] = [];
  for (const id of [
    "pick", "multi", "area", "copy", "markers", "help", "list", "collapse",
  ] as const) {
    if (!enabled(id)) continue;
    const base = baseToolbar[id];
    const shortcut = shortcutFor(id, base.shortcut);
    toolbar.push({ ...base, shortcut });
  }
  if (enabled("list")) {
    panels.push({ id: "list", title: "Annotation list", render: AnnotationList });
  }
  if (enabled("help")) {
    panels.push({ id: "help", title: "Shortcut help", render: HelpPanel });
  }
  return defineClientExtension({
    id: "agent-annotations.builtin",
    apiVersion: 1,
    toolbar,
    panels,
  });
};
