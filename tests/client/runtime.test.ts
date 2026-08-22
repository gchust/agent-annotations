import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, createElement } from "react";

const primitives = vi.hoisted(() => {
  const context = () => ({
    htmlPreview: "<button>Save</button>",
    stack: [],
    componentName: null,
    filePath: null,
    lineNumber: null,
    columnNumber: null,
    styles: "",
  });
  return {
    context,
    freeze: vi.fn(),
    getElementAtPoint: vi.fn((): Element | null => null),
    getElementBounds: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })),
    getElementContext: vi.fn<(element: Element) => unknown>(context),
    getElementsAtPoint: vi.fn((): Element[] => []),
    unfreeze: vi.fn(),
  };
});
const screenshot = vi.hoisted(() => ({
  prepareViewportSnapshot: vi.fn(),
  renderPreparedSnapshotPng: vi.fn(),
}));

vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(),
  freeze: primitives.freeze,
  getElementAtPoint: primitives.getElementAtPoint,
  getElementBounds: primitives.getElementBounds,
  getElementContext: primitives.getElementContext,
  getElementSelector: vi.fn(() => "button"),
  getElementsAtPoint: primitives.getElementsAtPoint,
  isElementGrabbable: vi.fn(() => true),
  unfreeze: primitives.unfreeze,
}));
vi.mock("../../src/client/screenshot.js", () => ({
  prepareViewportSnapshot: screenshot.prepareViewportSnapshot,
  renderPreparedSnapshotPng: screenshot.renderPreparedSnapshotPng,
}));

import { mountAgentAnnotations, RevisionConflictError } from "../../src/client/index.js";
import { createSafePageContext } from "../../src/client/runtime/annotated.js";
import { defineClientExtension } from "../../src/extension/index.js";
import { FileTaskStore } from "../../src/server/store.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";
import type {
  AgentAnnotationsDiagnosticsEntry,
  AgentAnnotationsTask,
  HostIntegration,
  StudioPublicApi,
  TaskTransport,
} from "../../src/types/index.js";
import { annotationFixture, targetFixture, taskFixture } from "../core/test-data.js";

afterEach(() => {
  document.getElementById("agent-annotations-root")?.remove();
  primitives.getElementAtPoint.mockReset();
  primitives.getElementAtPoint.mockReturnValue(null);
  primitives.getElementBounds.mockReset();
  primitives.getElementBounds.mockReturnValue({ x: 0, y: 0, width: 1, height: 1 });
  primitives.getElementContext.mockImplementation(primitives.context);
  primitives.getElementsAtPoint.mockReturnValue([]);
  screenshot.prepareViewportSnapshot.mockReset();
  screenshot.prepareViewportSnapshot.mockReturnValue(Object.freeze({
    svg: "<svg/>", width: 100, height: 100, scale: 1, overlays: Object.freeze([]), startedAt: 0,
  }));
  screenshot.renderPreparedSnapshotPng.mockReset();
  primitives.freeze.mockClear();
  primitives.unfreeze.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  history.replaceState({}, "", "/");
});

describe("runtime", () => {


  it("recovers a target added dynamically to an existing open shadow root", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const host = document.createElement("div");
    host.id = "dynamic-shadow-host";
    const shadowRoot = host.attachShadow({ mode: "open" });
    document.body.append(host);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          targets: [targetFixture({
            selector: "#dynamic-shadow-host >>> #dynamic-shadow-target",
            inspection: {
              ...targetFixture().inspection,
              attributes: { id: "dynamic-shadow-target" },
            },
          })],
        })],
      })),
    });
    try {
      const marker = document.getElementById("agent-annotations-root")!
        .shadowRoot!.querySelector<HTMLButtonElement>(".aa-marker")!;
      expect(marker.hidden).toBe(true);
      const target = document.createElement("button");
      target.id = "dynamic-shadow-target";
      shadowRoot.append(target);
      await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(false);
      expect(marker.dataset.resolved).toBe("1");
    } finally {
      mounted.unmount();
      host.remove();
    }
  });



  it("does not inspect capture events from inside the ignored shadow host", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    mounted.api.commands.capture.startPick();

    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const annotations = shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!;
    annotations.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      composed: true,
      clientX: 10,
      clientY: 10,
    }));
    annotations.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      composed: true,
      key: "Enter",
    }));

    expect(primitives.getElementAtPoint).not.toHaveBeenCalled();
    expect(mounted.api.getSnapshot().captureMode).toBe("pick");
    expect(mounted.api.getSnapshot().openPanel).toBe("agent-annotations.builtin:list");
    expect(document.getElementById("agent-annotations-root")!.shadowRoot!.querySelector(".aa-composer")).toBeNull();
    shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!.click();
    shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!
      .dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        composed: true,
        key: "Escape",
      }));
    expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    mounted.unmount();
    pageTarget.remove();
  });



  it("keeps the panel error boundary across post-interaction render failures", async () => {
    let shouldThrow = false;
    class LatePanel extends Component<
      { studio: StudioPublicApi; close(): void },
      { count: number }
    > {
      state = { count: 0 };
      render() {
        if (shouldThrow) throw new Error("token=panel-late");
        return createElement(
          "button",
          { type: "button", onClick: () => { shouldThrow = true; this.setState({ count: 1 }); } },
          `Count ${this.state.count}`
        );
      }
    }
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "late-panel",
          apiVersion: 1,
          panels: [{ id: "late", title: "Late panel", render: LatePanel }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.panels.open("late-panel:late");
      const button = shadow.querySelector<HTMLButtonElement>(".aa-panel button")!;
      expect(button.textContent).toBe("Count 0");
      button.click();
      await vi.waitFor(() => expect(shadow.querySelector(".aa-panel-error")?.textContent)
        .toBe("Panel failed to render"));
      expect(shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!.disabled).toBe(false);
      expect(JSON.stringify(mounted.api.getSnapshot().diagnostics))
        .not.toContain("panel-late");
    } finally {
      mounted.unmount();
    }
  });



  it("commits public state once per mutation, route change, and toolbar action, never for pointer movement", async () => {
    const target = document.createElement("button");
    target.getBoundingClientRect = () => new DOMRect(10, 10, 20, 20);
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture()),
      initialState: { collapsed: false },
    });
    const host = document.getElementById("agent-annotations-root")!;
    const shadow = host.shadowRoot!;
    const commits = () => Number(host.dataset.publicCommits);
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
    try {
      let before = commits();
      await mounted.api.commands.annotations.complete("ann-1");
      expect(commits() - before).toBe(1);

      before = commits();
      history.pushState({}, "", "/commits");
      await flush();
      expect(commits() - before).toBe(1);

      before = commits();
      shadow.querySelector<HTMLButtonElement>('[data-action-id="agent-annotations.builtin:pick"]')!.click();
      await Promise.resolve();
      expect(commits() - before).toBe(1);

      before = commits();
      for (let index = 0; index < 100; index += 1) {
        document.dispatchEvent(new MouseEvent("pointermove", {
          bubbles: true,
          clientX: index,
          clientY: 5,
        }));
      }
      await flush();
      expect(commits() - before).toBe(0);
    } finally {
      mounted.unmount();
      target.remove();
    }
  });



  it("renders toolbar icons through the single root and cleans up on unmount", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const host = document.getElementById("agent-annotations-root")!;
    const shadow = host.shadowRoot!;
    try {
      const pick = shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
      expect(pick.querySelector("svg")).not.toBeNull();
      expect(host.dataset.studioRenders).toBeTruthy();
    } finally {
      mounted.unmount();
    }
    expect(shadow.querySelector("svg")).toBeNull();
    expect(host.dataset.studioRenders).toBeUndefined();
  });
});
