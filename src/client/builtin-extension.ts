import { createElement, useState } from "react";

import { defineClientExtension } from "../extension/index.js";
import type { PanelContribution, StudioPublicApi, ToolbarContribution } from "../types/index.js";
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

const shortcut = (
  key: string,
  code: string,
  primary = true,
  alt = true,
  shift = false
) => ({ key, code, primary, alt, shift });
const toggleCollapsed = ({ collapsed }: { collapsed: boolean }) => collapsed;
const showCollapse = ({ collapsed }: { collapsed: boolean }) => !collapsed;
const translate = (studio: StudioPublicApi, value: string): string =>
  studio.getSnapshot().messages[value] ?? value;

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
      ...studio.getSnapshot().task.annotations.flatMap((annotation, index) =>
        filter === "open" && annotation.status !== "open"
          ? []
          : [
              createElement(
                "li",
                { className: "aa-list-item", key: annotation.annotationId },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "aa-button",
                    "aria-label": `Edit annotation ${index + 1}`,
                    onClick: () =>
                      studio.commands.markers.focus(annotation.annotationId),
                  },
                  `${index + 1}. ${annotation.comment}`
                ),
                createElement(
                  "span",
                  { className: "aa-muted" },
                  translate(studio, annotation.status)
                )
              ),
            ]
      )
    )
  );
};

const toolbar: ToolbarContribution[] = [
  { id: "pick", group: "capture", order: 10, label: "Pick", icon: PickIcon, kind: "toggle", shortcut: shortcut("P", "KeyP"), isPressed: ({ captureMode }) => captureMode === "pick", execute: ({ studio }) => studio.commands.capture.startPick() },
  { id: "multi", group: "capture", order: 20, label: "Multi", icon: MultiIcon, kind: "toggle", shortcut: shortcut("M", "KeyM"), isPressed: ({ captureMode }) => captureMode === "multi", execute: ({ studio }) => studio.commands.capture.startMulti() },
  { id: "area", group: "capture", order: 30, label: "Area", icon: AreaIcon, kind: "toggle", shortcut: shortcut("A", "KeyA"), isPressed: ({ captureMode }) => captureMode === "area", execute: ({ studio }) => studio.commands.capture.startArea() },
  { id: "copy", group: "handoff", order: 10, label: "Copy", icon: CopyIcon, kind: "action", shortcut: shortcut("C", "KeyC"), execute: ({ studio }) => studio.commands.annotations.copyOpen() },
  { id: "visibility", group: "view", order: 10, label: "Markers", icon: MarkersIcon, kind: "toggle", shortcut: shortcut("V", "KeyV"), isPressed: ({ markersVisible }) => markersVisible, execute: ({ studio }) => studio.getSnapshot().markersVisible ? studio.commands.markers.hide() : studio.commands.markers.show() },
  { id: "list", group: "view", order: 20, label: "Annotations", icon: AnnotationsIcon, kind: "panel", shortcut: shortcut("L", "KeyL"), panelId: "list", isPressed: ({ openPanel }) => openPanel === "agent-annotations.builtin:list" },
  { id: "help", group: "view", order: 30, label: "Shortcut help", icon: HelpIcon, kind: "panel", shortcut: shortcut("/", "Slash", false, false, true), panelId: "help", isPressed: ({ openPanel }) => openPanel === "agent-annotations.builtin:help" },
  { id: "toggle", group: "view", order: 40, label: "Collapse toolbar", icon: CollapseIcon, kind: "toggle", shortcut: shortcut("K", "KeyK"), isVisible: showCollapse, isPressed: toggleCollapsed, execute: ({ studio }) => studio.commands.toolbar.toggleCollapsed() },
];

export const builtinClientExtension = defineClientExtension({
  id: "agent-annotations.builtin",
  apiVersion: 1,
  toolbar,
  panels: [
    { id: "list", title: "Annotation list", render: AnnotationList },
    { id: "help", title: "Shortcut help", render: HelpPanel },
  ],
});
