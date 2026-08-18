import { createElement } from "react";
import {
  defineClientExtension,
  type PanelContribution,
  type StudioPublicApi,
} from "@gchust/agent-annotations/extension";

type DemoState = {
  setupCount: number;
  disposeCount: number;
  actionCount: number;
  studio?: StudioPublicApi;
};

declare global {
  interface Window {
    __demoExtension?: DemoState;
  }
}

const state = window.__demoExtension ??= {
  setupCount: 0,
  disposeCount: 0,
  actionCount: 0,
};
const Icon = () => createElement("span", { "aria-hidden": true }, "{}");
const DemoPanel: PanelContribution["render"] = ({ studio, close }) =>
  createElement(
    "div",
    null,
    createElement("p", null, `Setups: ${state.setupCount}`),
    createElement(
      "p",
      null,
      `Exporters: ${studio.getSnapshot().exporters.map(({ id }) => id).join(", ")}`
    ),
    createElement(
      "button",
      { type: "button", "data-demo-panel-close": "Close Demo", onClick: close },
      "Close Demo"
    )
  );

export default defineClientExtension({
  id: "demo.extension",
  apiVersion: 1,
  setup({ studio }) {
    state.setupCount += 1;
    state.studio = studio;
    return () => {
      state.disposeCount += 1;
      if (state.studio === studio) delete state.studio;
    };
  },
  toolbar: [
    {
      id: "demo-copy-json",
      group: "handoff",
      order: 20,
      label: "Copy JSON",
      icon: Icon,
      kind: "action",
      shortcut: {
        key: "J",
        code: "KeyJ",
        primary: true,
        alt: true,
        shift: false,
      },
      async execute({ studio }) {
        state.actionCount += 1;
        await studio.commands.exporters.copy("demo.extension:demo-json", "all");
      },
    },
    {
      id: "demo-panel-action",
      group: "view",
      order: 25,
      label: "Demo panel",
      icon: Icon,
      kind: "panel",
      panelId: "demo-panel",
    },
  ],
  panels: [{
    id: "demo-panel",
    title: "Demo Extension",
    render: DemoPanel,
  }],
  targetEnrichers: [{
    id: "target-context",
    enrich: ({ element }) => ({
      demoKind: element.getAttribute("data-demo-kind") ?? "unknown",
      kept: "visible",
      redactMe: "hidden",
    }),
  }],
  exporters: [{
    id: "demo-json",
    export: ({ task, annotations }) => JSON.stringify({
      format: "demo-json",
      annotations: annotations === "all"
        ? task.annotations
        : task.annotations.filter(({ status }) => status === "open"),
    }, null, 2),
  }],
  redactors: [{
    id: "demo-redactor",
    redact(data) {
      return Object.fromEntries(Object.entries(data).map(([id, value]) => {
        const result = { ...(value as Record<string, unknown>) };
        if (Array.isArray(result.targets)) {
          result.targets = result.targets.map((target) => {
            const clean = { ...(target as Record<string, unknown>) };
            delete clean.redactMe;
            return clean;
          });
        }
        delete result.redactMe;
        return [id, result];
      }));
    },
  }],
});
