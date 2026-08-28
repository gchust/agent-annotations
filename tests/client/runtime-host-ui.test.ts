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

describe("runtime-host-ui", () => {


  it("never stacks network patches across mounts and honors diagnostics config gates", async () => {
    vi.useFakeTimers();
    const originalFetch = window.fetch;
    const first = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    const patched = window.fetch;
    expect(patched).not.toBe(originalFetch);
    first.unmount();
    expect(window.fetch).toBe(originalFetch);
    // A second mount patches again without stacking.
    const second = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    expect(window.fetch).not.toBe(originalFetch);
    second.unmount();
    expect(window.fetch).toBe(originalFetch);
    // diagnostics.network=false leaves fetch untouched; console=false gates console capture.
    const gated = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      diagnostics: { network: false, console: false },
    });
    expect(window.fetch).toBe(originalFetch);
    const originalConsoleError = console.error;
    expect(console.error).toBe(originalConsoleError);
    gated.unmount();
  });



  it("starts expanded by default with explicit initialState support", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
      expect(mounted.api.getSnapshot().markersVisible).toBe(true);
      expect(shadow.querySelector(".aa-dock")?.getAttribute("data-collapsed")).toBe("false");
      expect(shadow.querySelector(".aa-collapsed-count")).toBeNull();
      // initialState can never auto-enter a capture mode: the snapshot is
      // idle immediately after mount.
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    } finally {
      mounted.unmount();
    }
    const collapsed = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: true, markersVisible: false },
    });
    try {
      expect(collapsed.api.getSnapshot().collapsed).toBe(true);
      expect(collapsed.api.getSnapshot().markersVisible).toBe(false);
    } finally {
      collapsed.unmount();
    }
  });



  it("disabling a builtin removes its toolbar entry and shortcut", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      builtins: { help: false, pick: false },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(shadow.querySelector('[aria-label^="Pick"]')).toBeNull();
      expect(shadow.querySelector('[aria-label^="Shortcut help"]')).toBeNull();
      expect(shadow.querySelector('[aria-label^="Annotations"]')).not.toBeNull();
      const shortcuts = mounted.api.getSnapshot().shortcuts.map((entry) => entry.id);
      expect(shortcuts).not.toContain("agent-annotations.builtin:pick");
      expect(shortcuts).not.toContain("agent-annotations.builtin:help");
      // The disabled help panel is absent too: opening it is rejected.
      expect(() => mounted.api.commands.panels.open("agent-annotations.builtin:help"))
        .toThrow("Unknown panel ID: agent-annotations.builtin:help");
      expect(() => mounted.api.commands.panels.open("agent-annotations.builtin:list"))
        .not.toThrow();
    } finally {
      mounted.unmount();
    }
  });



  it("mounts with builtins:false and a custom extension, expanding from the collapsed count", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: true },
      builtins: false,
      extensions: [defineClientExtension({
        id: "only-third-party",
        apiVersion: 1,
        toolbar: [{
          id: "ping",
          group: "handoff",
          label: "Ping",
          icon: () => null,
          kind: "action",
          execute: () => undefined,
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(mounted.api.getSnapshot().collapsed).toBe(true);
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.getAttribute("data-action-id")).toBe("agent-annotations.builtin:expand");
      expect(count.getAttribute("aria-label")).toContain("Expand toolbar");
      count.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
      const ping = shadow.querySelector<HTMLButtonElement>('[data-action-id="only-third-party:ping"]');
      expect(ping).not.toBeNull();
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    } finally {
      mounted.unmount();
    }
  });



  it("applies builtin shortcut overrides and rejects conflicts", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      builtins: {
        shortcuts: {
          pick: { key: "X", code: "KeyX", primary: true, alt: true, shift: false },
        },
      },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const pick = shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
      expect(pick.getAttribute("aria-label")).toBe("Pick (Ctrl+Alt+X)");
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "x", code: "KeyX", ctrlKey: true, altKey: true, bubbles: true,
      }));
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
    } finally {
      mounted.unmount();
    }
    await expect(mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      builtins: {
        shortcuts: {
          pick: { key: "P", code: "KeyP", primary: true, alt: true, shift: false },
          multi: { key: "P", code: "KeyP", primary: true, alt: true, shift: false },
        },
      },
    })).rejects.toThrow(/Duplicate toolbar shortcut/);
  });



  it("shortcut false removes only the shortcut while keeping the toolbar action", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      builtins: { shortcuts: { pick: false } },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const pick = shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
      expect(pick.getAttribute("aria-label")).toBe("Pick");
      expect(pick.getAttribute("aria-label")).not.toContain("Ctrl+Alt");
      const shortcuts = mounted.api.getSnapshot().shortcuts.map((entry) => entry.id);
      expect(shortcuts).not.toContain("agent-annotations.builtin:pick");
      // The toolbar action itself still works.
      pick.click();
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
      mounted.api.commands.capture.cancel();
      // The removed shortcut no longer triggers anything.
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "p", code: "KeyP", ctrlKey: true, altKey: true, bubbles: true,
      }));
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    } finally {
      mounted.unmount();
    }
  });



  it("continues all cleanup when an extension dispose throws and persists the diagnostic", async () => {
    const memory = new MemoryTaskTransport();
    const appendDiagnostics = vi.fn(async (entries: AgentAnnotationsDiagnosticsEntry[]) => undefined);
    const transport: TaskTransport = {
      read: () => memory.read(),
      mutate: (request) => memory.mutate(request),
      appendDiagnostics,
    };
    const disposedFirst = vi.fn();
    const disposedSecond = vi.fn();
    const mounted = await mountAgentAnnotations({
      transport,
      extensions: [
        defineClientExtension({
          id: "dispose-throws",
          apiVersion: 1,
          setup: () => () => {
            disposedFirst();
            throw new Error("dispose boom");
          },
        }),
        defineClientExtension({
          id: "dispose-fine",
          apiVersion: 1,
          setup: () => disposedSecond,
        }),
      ],
    });
    const host = document.getElementById("agent-annotations-root")!;
    mounted.unmount();
    // Both disposers ran (cleanup continued past the throwing one), and the
    // structured dispose diagnostic reached the transport boundary even
    // though the runtime is destroyed.
    expect(disposedFirst).toHaveBeenCalledOnce();
    expect(disposedSecond).toHaveBeenCalledOnce();
    expect(appendDiagnostics).toHaveBeenCalled();
    const persisted = appendDiagnostics.mock.calls.flatMap(([entries]) => entries ?? []);
    expect(persisted.some((entry) => entry?.phase === "dispose" && entry?.extensionId === "dispose-throws")).toBe(true);
    expect(document.getElementById("agent-annotations-root")).toBeNull();
    expect(host.isConnected).toBe(false);
    // A second unmount is a no-op.
    mounted.unmount();
    expect(disposedFirst).toHaveBeenCalledOnce();
  });




  it("keeps panels exclusive and returns focus to the opening action", async () => {
    vi.useFakeTimers();
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const list = shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!;
    list.focus();
    list.click();
    vi.runAllTimers();
    expect(mounted.api.getSnapshot().openPanel).toBe("agent-annotations.builtin:list");
    mounted.api.commands.panels.open("agent-annotations.builtin:help");
    expect(mounted.api.getSnapshot().openPanel).toBe("agent-annotations.builtin:help");
    expect(shadow.querySelectorAll(".aa-panel")).toHaveLength(1);
    mounted.api.commands.panels.close();
    vi.runAllTimers();
    expect(shadow.activeElement).toBe(
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')
    );
    mounted.unmount();
  });



  it("keeps the drag tooltip and toolbar panels anchored to the dock", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("aa-dock") ? 420 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("aa-dock") ? 50 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-dock")) {
        return new DOMRect(Number.parseFloat(this.style.left) || 290, Number.parseFloat(this.style.top) || 730, 420, 50);
      }
      if (this.classList.contains("aa-grip")) {
        const dock = this.parentElement!.getBoundingClientRect();
        return new DOMRect(dock.left + 6, dock.top + 6, 34, 34);
      }
      if (this.classList.contains("aa-panel")) return new DOMRect(0, 0, 360, 200);
      return new DOMRect();
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const grip = shadow.querySelector<HTMLButtonElement>(".aa-grip")!;
    grip.setPointerCapture = vi.fn();

    grip.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect({
      left: shadow.querySelector<HTMLElement>(".aa-tooltip")?.style.left,
      top: shadow.querySelector<HTMLElement>(".aa-tooltip")?.style.top,
    }).toEqual({ left: "296px", top: "702px" });

    grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 300, clientY: 740 }));
    grip.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 400, clientY: 640 }));
    expect({
      left: shadow.querySelector<HTMLElement>(".aa-tooltip")?.style.left,
      top: shadow.querySelector<HTMLElement>(".aa-tooltip")?.style.top,
    }).toEqual({ left: "396px", top: "602px" });

    for (const label of ["Annotations", "Shortcut help"]) {
      shadow.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)!.click();
      const panel = shadow.querySelector<HTMLElement>(".aa-panel")!;
      expect({ left: panel.style.left, top: panel.style.top, bottom: panel.style.bottom }).toEqual({
        left: "390px",
        top: "auto",
        bottom: "178px",
      });
    }
    mounted.unmount();
  });

  it("keeps an above-dock panel visible when its local content grows", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-dock")) return new DOMRect(290, 730, 420, 50);
      if (this.classList.contains("aa-panel")) {
        const height = this.querySelectorAll(".aa-list-item").length > 0 ? 480 : 120;
        const bottom = this.style.bottom && this.style.bottom !== "auto"
          ? 800 - Number.parseFloat(this.style.bottom)
          : (Number.parseFloat(this.style.top) || 0) + height;
        return new DOMRect(Number.parseFloat(this.style.left) || 0, bottom - height, 360, height);
      }
      return new DOMRect();
    });
    const task = taskFixture({
      status: "completed",
      annotations: [
        annotationFixture({ annotationId: "done-1", status: "completed", completedAt: "2026-08-24T00:00:00.000Z" }),
        annotationFixture({ annotationId: "done-2", status: "completed", completedAt: "2026-08-24T00:01:00.000Z" }),
      ],
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      const panel = shadow.querySelector<HTMLElement>(".aa-panel")!;
      expect(panel.style.top).toBe("auto");
      shadow.querySelectorAll<HTMLButtonElement>(".aa-panel button")[1]!.click();
      const panelRect = panel.getBoundingClientRect();
      const dockRect = shadow.querySelector<HTMLElement>(".aa-dock")!.getBoundingClientRect();
      expect(panelRect.top).toBeGreaterThanOrEqual(0);
      expect(panelRect.bottom).toBeLessThanOrEqual(dockRect.top - 8);
    } finally {
      mounted.unmount();
    }
  });



  it("renders the chrome through one stable root and preserves panel draft state", async () => {
    let mounts = 0;
    let renders = 0;
    class DraftPanel extends Component<
      { studio: StudioPublicApi; close(): void },
      { count: number }
    > {
      state = { count: 0 };
      componentDidMount(): void {
        mounts += 1;
      }
      render() {
        renders += 1;
        return createElement(
          "div",
          null,
          createElement("textarea", { "data-draft": "", defaultValue: "draft" }),
          createElement("button", { type: "button", "data-bump": "", onClick: () => this.setState({ count: this.state.count + 1 }) }, `Count ${this.state.count}`)
        );
      }
    }
    const memory = new MemoryTaskTransport(taskFixture());
    const mounted = await mountAgentAnnotations({
      transport: memory,
      extensions: [defineClientExtension({
        id: "draft",
        apiVersion: 1,
        panels: [{ id: "draft", title: "Draft", render: DraftPanel }],
      })],
    });
    const host = document.getElementById("agent-annotations-root")!;
    const shadow = host.shadowRoot!;
    try {
      mounted.api.commands.panels.open("draft:draft");
      const textarea = shadow.querySelector<HTMLTextAreaElement>("textarea[data-draft]")!;
      textarea.value = "typed draft";
      // Task, marker, and viewport updates must not remount the panel.
      await mounted.api.commands.annotations.reopen("ann-1");
      window.dispatchEvent(new Event("resize"));
      mounted.api.commands.markers.hide();
      mounted.api.commands.markers.show();
      shadow.querySelector<HTMLButtonElement>("button[data-bump]")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector<HTMLTextAreaElement>("textarea[data-draft]")!.value)
        .toBe("typed draft");
      expect(shadow.querySelector<HTMLButtonElement>("button[data-bump]")!.textContent)
        .toBe("Count 1");
      expect(mounts).toBe(1);
      expect(renders).toBeGreaterThan(1); // reconciled, not remounted
    } finally {
      mounted.unmount();
    }
  });



  it("keeps one hover outline and a flat render counter across pointer movement and full renders", async () => {
    const targetA = document.createElement("button");
    const targetB = document.createElement("button");
    targetA.getBoundingClientRect = () => new DOMRect(10, 10, 20, 20);
    targetB.getBoundingClientRect = () => new DOMRect(100, 10, 20, 20);
    document.body.append(targetA, targetB);
    primitives.getElementAtPoint.mockImplementation(((x: number) => (x < 50 ? targetA : targetB)) as never);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(taskFixture()) });
    const host = document.getElementById("agent-annotations-root")!;
    const shadow = host.shadowRoot!;
    const move = (x: number) => document.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true,
      clientX: x,
      clientY: 5,
    }));
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
    try {
      mounted.api.commands.capture.startPick();
      const afterStart = Number(host.dataset.studioRenders);
      expect(afterStart).toBeGreaterThan(0);
      for (let index = 0; index < 50; index += 1) move(index);
      for (let index = 50; index < 100; index += 1) move(index);
      await flush();
      let outlines = shadow.querySelectorAll(".aa-outline");
      expect(outlines).toHaveLength(1);
      expect(outlines[0]!.getAttribute("style")).toContain("left: 100px"); // last event's target
      expect(Number(host.dataset.studioRenders)).toBe(afterStart); // pointer movement stays flat

      // A full render in between must not duplicate or stale the hover outline.
      mounted.api.commands.markers.hide();
      mounted.api.commands.markers.show();
      const afterFullRender = Number(host.dataset.studioRenders);
      expect(afterFullRender).toBeGreaterThan(afterStart);
      for (let index = 0; index < 50; index += 1) move(index);
      await flush();
      outlines = shadow.querySelectorAll(".aa-outline");
      expect(outlines).toHaveLength(1);
      expect(outlines[0]!.getAttribute("style")).toContain("left: 10px");
      expect(Number(host.dataset.studioRenders)).toBe(afterFullRender);

      // The area outline follows the same shared node tracking.
      mounted.api.commands.capture.startArea();
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
      await flush();
      mounted.api.commands.markers.hide();
      mounted.api.commands.markers.show();
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 120, clientY: 120 }));
      await flush();
      const areas = shadow.querySelectorAll(".aa-area");
      expect(areas).toHaveLength(1);
      expect(areas[0]!.getAttribute("style")).toContain("width: 110px");
    } finally {
      mounted.unmount();
      targetA.remove();
      targetB.remove();
    }
  });



  it("filters markers by the current route and refreshes on history navigation", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/route-a");
    const shared = document.createElement("button");
    shared.id = "shared";
    document.body.append(shared);
    const task = taskFixture({
      annotations: [
        annotationFixture({
          annotationId: "ann-a",
          pageContext: { ...annotationFixture().pageContext, routeKey: "/route-a" },
          targets: [targetFixture({ selector: "#shared" })],
        }),
        annotationFixture({
          annotationId: "ann-b",
          pageContext: { ...annotationFixture().pageContext, routeKey: "/route-b" },
          targets: [targetFixture({ selector: "#shared" })],
        }),
      ],
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(shadow.querySelector('[data-annotation-id="ann-a"]')).not.toBeNull();
      expect(shadow.querySelector('[data-annotation-id="ann-b"]')).toBeNull();
      history.pushState({}, "", "/route-b");
      await vi.runAllTimersAsync();
      expect(shadow.querySelector('[data-annotation-id="ann-b"]')).not.toBeNull();
      expect(shadow.querySelector('[data-annotation-id="ann-a"]')).toBeNull();
      history.pushState({}, "", "/route-a");
      await vi.runAllTimersAsync();
      expect(shadow.querySelector('[data-annotation-id="ann-a"]')).not.toBeNull();
      expect(shadow.querySelector('[data-annotation-id="ann-b"]')).toBeNull();
    } finally {
      mounted.unmount();
      shared.remove();
    }
  });



  it("refreshes markers through host route subscriptions and disposes them on unmount", async () => {
    vi.useFakeTimers();
    let currentRoute = "/host-a";
    let notify!: () => void;
    const unsubscribe = vi.fn();
    const host: HostIntegration = {
      routeKey: () => currentRoute,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    };
    const task = taskFixture({
      annotations: [annotationFixture({
        pageContext: { ...annotationFixture().pageContext, routeKey: "/host-a" },
      })],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      extensions: [defineClientExtension({ id: "route-host", apiVersion: 1, host })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(shadow.querySelector(".aa-marker")).not.toBeNull();
      currentRoute = "/host-b";
      notify();
      await vi.runAllTimersAsync();
      expect(shadow.querySelector(".aa-marker")).toBeNull();
    } finally {
      mounted.unmount();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });



  it("restores patched history methods and removes default route listeners on unmount", async () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    expect(history.pushState).not.toBe(originalPushState);
    expect(history.replaceState).not.toBe(originalReplaceState);
    mounted.unmount();
    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
  });



  it("navigates for cross-route focus when the host provides navigation", async () => {
    history.pushState({}, "", "/route-a");
    const navigate = vi.fn();
    const host: HostIntegration = {
      routeKey: () => location.pathname,
      navigate,
    };
    const task = taskFixture({
      annotations: [annotationFixture({
        pageContext: { ...annotationFixture().pageContext, routeKey: "/route-b" },
      })],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      extensions: [defineClientExtension({ id: "route-host", apiVersion: 1, host })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-1");
      expect(navigate).toHaveBeenCalledWith("/route-b");
      expect(shadow.querySelector(".aa-editor")).toBeNull();
    } finally {
      mounted.unmount();
    }
  });



  it("keeps cross-route focus unresolved without host navigation", async () => {
    history.pushState({}, "", "/route-a");
    const task = taskFixture({
      annotations: [annotationFixture({
        pageContext: { ...annotationFixture().pageContext, routeKey: "/route-b" },
      })],
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-1");
      expect(shadow.querySelector(".aa-editor")).toBeNull();
      expect(shadow.querySelector('[role="status"]')?.textContent)
        .toBe("Annotation is on another route");
    } finally {
      mounted.unmount();
    }
  });



  it("scopes capture hits to the explicit app root without guessing <main>", async () => {
    const app = document.createElement("div");
    app.id = "app";
    const main = document.createElement("main");
    const inside = document.createElement("button");
    inside.id = "inside-target";
    const outside = document.createElement("button");
    outside.id = "outside-target";
    app.append(inside);
    main.append(outside);
    document.body.append(app, main);
    primitives.getElementAtPoint.mockImplementation(((x: number) => (x < 500 ? inside : outside)) as never);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({
        id: "app-root-host",
        apiVersion: 1,
        host: { appRoot: () => app },
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 900, clientY: 10 }));
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
    } finally {
      mounted.unmount();
      app.remove();
      main.remove();
    }
  });



  it("updates route, locale, theme, and app root through one host subscription and disposes fully", async () => {
    vi.useFakeTimers();
    let currentRoute = "/host-a";
    let currentLocale = "fr";
    let currentTheme: "light" | "dark" | "system" = "light";
    let currentAppRoot = document.body;
    let notify!: () => void;
    const unsubscribe = vi.fn();
    const host: HostIntegration = {
      routeKey: () => currentRoute,
      locale: () => currentLocale,
      theme: () => currentTheme,
      appRoot: () => currentAppRoot,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    };
    const task = taskFixture({
      annotations: [annotationFixture({
        annotationId: "ann-a",
        pageContext: { ...annotationFixture().pageContext, routeKey: "/host-a" },
      })],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      extensions: [defineClientExtension({
        id: "unified-host",
        apiVersion: 1,
        host,
        toolbar: [{
          id: "greet",
          group: "host",
          order: 1,
          label: { fr: "Saluer", de: "Grüßen" },
          icon: () => null,
          kind: "action",
          execute: () => undefined,
        }],
      })],
    });
    const hostElement = document.getElementById("agent-annotations-root")!;
    const shadow = hostElement.shadowRoot!;
    const app = document.createElement("div");
    const inside = document.createElement("button");
    const outside = document.createElement("button");
    app.append(inside);
    document.body.append(app, outside);
    primitives.getElementAtPoint.mockImplementation(((x: number) => (x < 500 ? inside : outside)) as never);
    try {
      expect(shadow.querySelector('[data-annotation-id="ann-a"]')).not.toBeNull();
      expect(hostElement.dataset.theme).toBe("light");
      expect(shadow.querySelector('[data-action-id="unified-host:greet"]')
        ?.getAttribute("aria-label")).toBe("Saluer");
      currentRoute = "/host-b";
      currentLocale = "de";
      currentTheme = "dark";
      currentAppRoot = app;
      notify();
      await vi.runAllTimersAsync();
      expect(shadow.querySelector('[data-annotation-id="ann-a"]')).toBeNull();
      expect(hostElement.dataset.theme).toBe("dark");
      expect(shadow.querySelector('[data-action-id="unified-host:greet"]')
        ?.getAttribute("aria-label")).toBe("Grüßen");
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 900, clientY: 10 }));
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
    } finally {
      mounted.unmount();
      app.remove();
      outside.remove();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });



  it("updates toolbar, tooltip, help, and built-in list live from locale and message changes without remounting", async () => {
    vi.useFakeTimers();
    let currentLocale = "fr";
    let notify!: () => void;
    const unsubscribe = vi.fn();
    const host: HostIntegration = {
      locale: () => currentLocale,
      messages: {
        "Open": "Ouvrir",
        "All": "Tous",
        "Close": "Fermer",
        "open": "Ouverte",
        "completed": "Terminée",
      },
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    };
    let mounts = 0;
    class DraftListPanel extends Component<
      { studio: StudioPublicApi; close(): void },
      { count: number }
    > {
      state = { count: 0 };
      componentDidMount(): void {
        mounts += 1;
      }
      render() {
        return createElement("div", null,
          createElement("button", {
            type: "button",
            "data-draft-count": String(this.state.count),
            onClick: () => this.setState({ count: this.state.count + 1 }),
          }, "bump"));
      }
    }
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture()),
      extensions: [defineClientExtension({
        id: "l10n-host",
        apiVersion: 1,
        host,
        toolbar: [{
          id: "greet",
          group: "host",
          order: 1,
          label: { fr: "Saluer", de: "Grüßen" },
          icon: () => null,
          kind: "action",
          shortcut: { key: "G", code: "KeyG", primary: true, alt: true, shift: false },
          execute: () => undefined,
        }],
        panels: [{ id: "draft", title: { fr: "Brouillon", de: "Entwurf" }, render: DraftListPanel }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const greet = shadow.querySelector<HTMLButtonElement>('[data-action-id="l10n-host:greet"]')!;
    const hover = () => {
      greet.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
    };
    try {
      expect(greet.getAttribute("aria-label")).toBe("Saluer (Ctrl+Alt+G)");
      hover();
      expect(shadow.querySelector('[role="tooltip"]')?.textContent).toContain("Saluer");
      // Help rows carry the localized shortcut label.
      mounted.api.commands.panels.open("agent-annotations.builtin:help");
      expect([...shadow.querySelectorAll(".aa-help-row")]
        .some((row) => row.textContent?.includes("Saluer"))).toBe(true);
      // The built-in list localizes Open/All/Close/status.
      mounted.api.commands.panels.close("agent-annotations.builtin:help");
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      const listText = () => shadow.querySelector(".aa-panel")!.textContent ?? "";
      expect(listText()).toContain("Ouvrir");
      expect(listText()).toContain("Tous");
      expect(listText()).toContain("Ouverte");
      expect(shadow.querySelector('[aria-label="Fermer"]')).not.toBeNull();
      // Locale and message change while the list is open: everything updates live.
      currentLocale = "de";
      host.messages = {
        "Open": "Öffnen",
        "All": "Alle",
        "Close": "Schließen",
        "open": "Offen",
        "completed": "Abgeschlossen",
      };
      notify();
      await vi.runAllTimersAsync();
      expect(greet.getAttribute("aria-label")).toBe("Grüßen (Ctrl+Alt+G)");
      expect(listText()).toContain("Öffnen");
      expect(listText()).toContain("Alle");
      expect(listText()).toContain("Offen");
      expect(shadow.querySelector('[aria-label="Schließen"]')).not.toBeNull();
      hover();
      expect(shadow.querySelector('[role="tooltip"]')?.textContent).toContain("Grüßen");
      // A messages-only notification (locale unchanged) also refreshes the catalog.
      host.messages = { ...host.messages, "Open": "Öffnen (neu)" };
      notify();
      await vi.runAllTimersAsync();
      expect(listText()).toContain("Öffnen (neu)");
      // The draft panel survives every notification without a remount.
      mounted.api.commands.panels.close("agent-annotations.builtin:list");
      mounted.api.commands.panels.open("l10n-host:draft");
      expect(shadow.querySelector('[aria-label="Entwurf"]')).not.toBeNull();
      shadow.querySelector<HTMLButtonElement>("[data-draft-count]")!.click();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector("[data-draft-count]")!.getAttribute("data-draft-count")).toBe("1");
      currentLocale = "fr";
      host.messages = { "Open": "Ouvrir", "All": "Tous", "Close": "Fermer", "open": "Ouverte", "completed": "Terminée" };
      notify();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector("[data-draft-count]")!.getAttribute("data-draft-count")).toBe("1");
      expect(mounts).toBe(1);
    } finally {
      vi.useRealTimers();
      mounted.unmount();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });



  it("applies light, dark, and system themes with released media listeners", async () => {
    vi.useFakeTimers();
    const mediaListeners = new Set<() => void>();
    let systemDark = false;
    let mediaQuery = "";
    vi.stubGlobal("matchMedia", vi.fn((query: string) => {
      mediaQuery = query;
      return {
        matches: systemDark,
        media: query,
        addEventListener: (_type: string, listener: () => void) => {
          mediaListeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          mediaListeners.delete(listener);
        },
      };
    }));
    const luminance = (hex: string): number => {
      const channels = [0, 2, 4].map((offset) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const contrast = (a: string, b: string): number => {
      const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (lighter + 0.05) / (darker + 0.05);
    };
    let currentTheme: "light" | "dark" | "system" = "light";
    let notify!: () => void;
    const host: HostIntegration = {
      theme: () => currentTheme,
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({ id: "theme-host", apiVersion: 1, host })],
    });
    const hostElement = document.getElementById("agent-annotations-root")!;
    const styles = hostElement.shadowRoot!.querySelector("style")!.textContent;
    const darkStart = styles.indexOf(":host([data-theme=dark])");
    expect(darkStart).toBeGreaterThan(0);
    const lightBlock = styles.slice(0, darkStart);
    const darkBlock = styles.slice(darkStart);
    const accent = /--aa-accent:#([0-9a-f]{6})/.exec(lightBlock)?.[1] ?? "";
    expect(accent).toMatch(/^[0-9a-f]{6}$/);
    const tokens = (block: string): Array<[string, string]> => {
      const value = (name: string) => new RegExp(`${name}:#([0-9a-f]{6})`).exec(block)?.[1] ?? "";
      return [
        [value("--aa-text"), value("--aa-bg")],
        [value("--aa-muted"), value("--aa-bg")],
        [value("--aa-muted"), value("--aa-muted-bg")],
        [value("--aa-tooltip-text"), value("--aa-tooltip-bg")],
        [value("--aa-status-text"), value("--aa-status-bg")],
        ["ffffff", accent],
        [value("--aa-danger"), value("--aa-bg")],
        [value("--aa-danger"), value("--aa-danger-bg")],
      ];
    };
    for (const pairs of [tokens(lightBlock), tokens(darkBlock)]) {
      for (const [text, background] of pairs) {
        expect(text).toMatch(/^[0-9a-f]{6}$/);
        expect(background).toMatch(/^[0-9a-f]{6}$/);
        expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
    try {
      expect(hostElement.dataset.theme).toBe("light");
      expect(mediaListeners.size).toBe(0);
      currentTheme = "dark";
      notify();
      await vi.runAllTimersAsync();
      expect(hostElement.dataset.theme).toBe("dark");
      expect(mediaListeners.size).toBe(0);
      currentTheme = "system";
      notify();
      await vi.runAllTimersAsync();
      expect(mediaQuery).toBe("(prefers-color-scheme: dark)");
      expect(hostElement.dataset.theme).toBe("light");
      expect(mediaListeners.size).toBe(1);
      systemDark = true;
      for (const listener of [...mediaListeners]) listener();
      expect(hostElement.dataset.theme).toBe("dark");
      currentTheme = "light";
      notify();
      await vi.runAllTimersAsync();
      expect(hostElement.dataset.theme).toBe("light");
      expect(mediaListeners.size).toBe(0);
    } finally {
      mounted.unmount();
      vi.unstubAllGlobals();
    }
    expect(mediaListeners.size).toBe(0);
  });

  it("applies, updates, and clears the host brand color", async () => {
    let brandColor: string | undefined = "#1677FF";
    let notify!: () => void;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({
        id: "brand-host",
        apiVersion: 1,
        host: {
          brandColor: () => brandColor,
          subscribe: (listener) => {
            notify = listener;
            return () => undefined;
          },
        },
      })],
    });
    const style = document.getElementById("agent-annotations-root")!.style;
    expect(style.getPropertyValue("--aa-accent")).toBe("#1677ff");
    expect(style.getPropertyValue("--aa-accent-text")).toBe("#000000");

    brandColor = "#6d28d9";
    notify();
    expect(style.getPropertyValue("--aa-accent")).toBe("#6d28d9");
    expect(style.getPropertyValue("--aa-accent-hover")).toMatch(/^#[\da-f]{6}$/);
    expect(style.getPropertyValue("--aa-accent-text")).toBe("#ffffff");

    brandColor = undefined;
    notify();
    expect(style.getPropertyValue("--aa-accent")).toBe("");
    expect(style.getPropertyValue("--aa-accent-hover")).toBe("");
    expect(style.getPropertyValue("--aa-accent-text")).toBe("");
    expect(style.getPropertyValue("--aa-accent-label")).toBe("");
    mounted.unmount();
  });



  it("preserves capture mode, open panel, and drafts across theme and locale changes", async () => {
    let currentLocale = "fr";
    let currentTheme: "light" | "dark" = "light";
    let notify!: () => void;
    const host: HostIntegration = {
      locale: () => currentLocale,
      theme: () => currentTheme,
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    let mounts = 0;
    class DraftPanel extends Component<
      { studio: StudioPublicApi; close(): void },
      { count: number }
    > {
      state = { count: 0 };
      componentDidMount(): void {
        mounts += 1;
      }
      render() {
        return createElement("button", {
          type: "button",
          "data-draft-count": String(this.state.count),
          onClick: () => this.setState({ count: this.state.count + 1 }),
        }, "draft");
      }
    }
    const target = document.createElement("button");
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({
        id: "state-host",
        apiVersion: 1,
        host,
        panels: [{ id: "draft", title: "Draft", render: DraftPanel }],
      })],
    });
    const hostElement = document.getElementById("agent-annotations-root")!;
    const shadow = hostElement.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      mounted.api.commands.panels.open("state-host:draft");
      shadow.querySelector<HTMLButtonElement>("[data-draft-count]")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector("[data-draft-count]")!.getAttribute("data-draft-count")).toBe("1");
      currentTheme = "dark";
      currentLocale = "de";
      notify();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hostElement.dataset.theme).toBe("dark");
      expect(shadow.querySelector("[data-draft-count]")!.getAttribute("data-draft-count")).toBe("1");
      expect(mounts).toBe(1);
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
    } finally {
      mounted.unmount();
      target.remove();
    }
  });



  it("handles a host notification delivered synchronously during subscribe registration", async () => {
    let currentLocale = "de";
    let notified = false;
    const host: HostIntegration = {
      locale: () => currentLocale,
      subscribe: (listener) => {
        listener();
        notified = true;
        return () => undefined;
      },
    };
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({
        id: "sync-host",
        apiVersion: 1,
        host,
        toolbar: [{
          id: "greet",
          group: "host",
          order: 1,
          label: { fr: "Saluer", de: "Grüßen" },
          icon: () => null,
          kind: "action",
          execute: () => undefined,
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(notified).toBe(true);
      expect(shadow.querySelector('[data-action-id="sync-host:greet"]')
        ?.getAttribute("aria-label")).toBe("Grüßen");
    } finally {
      mounted.unmount();
    }
  });



  it("defaults the app root to document.body without <main> or #root", async () => {
    const app = document.createElement("div");
    app.id = "app";
    const target = document.createElement("button");
    app.append(target);
    document.body.append(app);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
    } finally {
      mounted.unmount();
      app.remove();
    }
  });



  it("keeps markers for targets outside the app root hidden", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const app = document.createElement("div");
    const inside = document.createElement("button");
    inside.id = "inside-root-target";
    const outside = document.createElement("button");
    outside.id = "outside-root-target";
    app.append(inside);
    document.body.append(app, outside);
    const task = taskFixture({
      annotations: [
        annotationFixture({
          annotationId: "in-root",
          targets: [targetFixture({
            selector: "#inside-root-target",
            inspection: {
              ...targetFixture().inspection,
              attributes: { id: "inside-root-target" },
            },
          })],
        }),
        annotationFixture({
          annotationId: "out-root",
          targets: [targetFixture({
            selector: "#outside-root-target",
            inspection: {
              ...targetFixture().inspection,
              attributes: { id: "outside-root-target" },
            },
          })],
        }),
      ],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      extensions: [defineClientExtension({
        id: "marker-root-host",
        apiVersion: 1,
        host: { appRoot: () => app },
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      await vi.runAllTimersAsync();
      const insideMarker = shadow.querySelector<HTMLElement>('[data-annotation-id="in-root"]')!;
      const outsideMarker = shadow.querySelector<HTMLElement>('[data-annotation-id="out-root"]')!;
      expect(insideMarker.hidden).toBe(false);
      expect(outsideMarker.hidden).toBe(true);
    } finally {
      mounted.unmount();
      app.remove();
      outside.remove();
    }
  });



  it("resolves markers from the app root scope when the same selector exists outside it", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const app = document.createElement("div");
    const inside = document.createElement("button");
    inside.id = "duplicate-target";
    const outside = document.createElement("button");
    outside.id = "duplicate-target";
    app.append(inside);
    document.body.append(app, outside);
    const task = taskFixture({
      annotations: [annotationFixture({
        targets: [targetFixture({
          selector: "#duplicate-target",
          inspection: {
            ...targetFixture().inspection,
            attributes: { id: "duplicate-target" },
          },
        })],
      })],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      extensions: [defineClientExtension({
        id: "dup-root-host",
        apiVersion: 1,
        host: { appRoot: () => app },
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // The initial render resolves within the root, not the global document.
      const marker = shadow.querySelector<HTMLElement>(".aa-marker")!;
      expect(marker.hidden).toBe(false);
      expect(marker.style.left).not.toBe("");
      // The scheduled refresh path resolves within the root too.
      window.dispatchEvent(new Event("resize"));
      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(false);
      expect(marker.style.left).not.toBe("");
    } finally {
      mounted.unmount();
      app.remove();
      outside.remove();
    }
  });



  it("resolves the app root element itself as a target while keeping external duplicates isolated", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const app = document.createElement("div");
    app.id = "app-root-target";
    const external = document.createElement("div");
    external.id = "app-root-target";
    document.body.append(app, external);
    const task = taskFixture({
      annotations: [annotationFixture({
        targets: [targetFixture({
          selector: "#app-root-target",
          inspection: {
            ...targetFixture().inspection,
            tagName: "div",
            role: "",
            accessibleName: "",
            attributes: { id: "app-root-target" },
          },
        })],
      })],
    });
    primitives.getElementAtPoint.mockReturnValue(app);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      extensions: [defineClientExtension({
        id: "root-self-host",
        apiVersion: 1,
        host: { appRoot: () => app },
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // Capture accepts the app root element itself.
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
      mounted.api.commands.capture.cancel();
      // The persisted target resolves to the root itself, not the external duplicate.
      const marker = shadow.querySelector<HTMLElement>(".aa-marker")!;
      expect(marker.hidden).toBe(false);
      expect(marker.style.left).not.toBe("");
      // The scheduled refresh path keeps resolving the root itself.
      window.dispatchEvent(new Event("resize"));
      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(false);
      expect(marker.style.left).not.toBe("");
    } finally {
      mounted.unmount();
      app.remove();
      external.remove();
    }
  });



  it("hides the marker when the unique selector points at a different element identity", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    document.body.innerHTML = '<main><button id="actual">Wrong</button></main>';
    const task = taskFixture({
      annotations: [annotationFixture({
        targets: [targetFixture({
          selector: "main > button",
          inspection: {
            ...targetFixture().inspection,
            attributes: { id: "expected", role: "button", "aria-label": "Save" },
          },
        })],
      })],
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const marker = shadow.querySelector<HTMLElement>(".aa-marker")!;
      expect(marker.hidden).toBe(true);
      expect(marker.style.left).toBe("");
      window.dispatchEvent(new Event("resize"));
      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(true);
    } finally {
      mounted.unmount();
    }
  });

  it("keeps a completed marker at its saved bounds when its target changes", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    document.body.innerHTML = '<main><button id="actual" aria-label="Wrong">Wrong</button></main>';
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        status: "completed",
        annotations: [annotationFixture({
          status: "completed",
          completedAt: "2026-08-24T00:00:00.000Z",
          targets: [targetFixture({
            bounds: { x: 420, y: 260, width: 120, height: 32 },
            selector: "main > button",
            inspection: {
              ...targetFixture().inspection,
              attributes: { id: "expected", role: "button", "aria-label": "Save" },
            },
          })],
        })],
      })),
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const marker = shadow.querySelector<HTMLElement>(".aa-marker")!;
      expect(marker.hidden).toBe(false);
      expect({ left: marker.style.left, top: marker.style.top }).toEqual({
        left: "412px",
        top: "252px",
      });
    } finally {
      mounted.unmount();
    }
  });



  it("anchors a region marker to its rectangle instead of a sampled page container", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    document.body.innerHTML = '<main><button id="expected" aria-label="Save">Save</button></main>';
    primitives.getElementBounds.mockReturnValue({ x: 0, y: 0, width: 1000, height: 800 });
    const task = taskFixture({
      annotations: [annotationFixture({
        kind: "region",
        region: { coordinateSpace: "document", x: 40, y: 50, width: 300, height: 120 },
        targets: [targetFixture({
          selector: "main > button",
          inspection: {
            ...targetFixture().inspection,
            attributes: { id: "expected", role: "button", "aria-label": "Save" },
          },
        })],
      })],
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const outline = shadow.querySelector<HTMLElement>('[data-region="true"]');
      expect(outline).not.toBeNull();
      expect(outline?.style.left).toBe("40px");
      expect(outline?.style.top).toBe("50px");
      const marker = shadow.querySelector<HTMLElement>(".aa-marker")!;
      expect({ left: marker.style.left, top: marker.style.top }).toEqual({
        left: "326px",
        top: "54px",
      });
      window.dispatchEvent(new Event("resize"));
      await vi.runAllTimersAsync();
      expect(shadow.querySelector('[data-region="true"]')).not.toBeNull();
      expect({ left: marker.style.left, top: marker.style.top }).toEqual({
        left: "326px",
        top: "54px",
      });
    } finally {
      mounted.unmount();
    }
  });



  it("captures inside an iframe document app root", async () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    frame.id = "frame-app-root";
    document.body.append(frame);
    await vi.runAllTimersAsync();
    const frameDoc = frame.contentDocument!;
    expect(frameDoc).not.toBeNull();
    const frameTarget = frameDoc.createElement("button");
    frameTarget.id = "frame-target";
    frameDoc.body.append(frameTarget);
    primitives.getElementAtPoint.mockReturnValue(frameTarget);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({
        id: "frame-host",
        apiVersion: 1,
        host: { appRoot: () => frameDoc },
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      frameDoc.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
    } finally {
      mounted.unmount();
      frame.remove();
    }
  });



  it("rebinds capture listeners when the app root switches during active capture", async () => {
    const frame = document.createElement("iframe");
    frame.id = "frame-switch-root";
    document.body.append(frame);
    const frameDoc = frame.contentDocument!;
    const frameTarget = frameDoc.createElement("button");
    frameDoc.body.append(frameTarget);
    const bodyApp = document.createElement("div");
    const bodyTarget = document.createElement("button");
    bodyTarget.id = "body-switch-target";
    bodyApp.append(bodyTarget);
    document.body.append(bodyApp);
    let currentAppRoot: Element | Document = frameDoc;
    let notify!: () => void;
    const host: HostIntegration = {
      appRoot: () => currentAppRoot,
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    primitives.getElementAtPoint.mockImplementation(((x: number) => (x < 500 ? frameTarget : bodyTarget)) as never);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({ id: "switch-host", apiVersion: 1, host })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      currentAppRoot = bodyApp;
      notify();
      await new Promise((resolve) => setTimeout(resolve, 0));
      frameDoc.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 900, clientY: 5 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
    } finally {
      mounted.unmount();
      frame.remove();
      bodyApp.remove();
    }
  });


  it("renders features in the exact toolbar order with separate collapse chrome after a divider", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const labels = [...shadow.querySelectorAll<HTMLButtonElement>(".aa-dock .aa-action")]
        .map((node) => node.getAttribute("aria-label"));
      expect(labels).toEqual([
        "Pick (Ctrl+Alt+P)",
        "Multi (Ctrl+Alt+M)",
        "Area (Ctrl+Alt+A)",
        "Copy (Ctrl+Alt+C)",
        "Clear all annotations",
        "Markers (Ctrl+Alt+V)",
        "Shortcut help (Shift+/)",
        "Annotations (Ctrl+Alt+L)",
        "Collapse toolbar (Ctrl+Alt+K)",
      ]);
      const divider = shadow.querySelector<HTMLElement>(".aa-dock .aa-divider");
      expect(divider).not.toBeNull();
      const collapse = shadow.querySelector('[aria-label^="Collapse toolbar"]')!;
      const help = shadow.querySelector('[aria-label^="Shortcut help"]')!;
      const list = shadow.querySelector('[aria-label^="Annotations"]')!;
      expect(divider!.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      expect(divider!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      expect(divider!.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });



  it("keeps collapse as the last chrome after the divider even with later host contributions", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({
        id: "late-host",
        apiVersion: 1,
        toolbar: [{
          id: "late",
          group: "host",
          order: 1,
          label: "Late host action",
          icon: () => null,
          kind: "action",
          execute: () => undefined,
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const actions = [...shadow.querySelectorAll<HTMLButtonElement>(".aa-dock .aa-action")];
      expect(actions.at(-1)!.getAttribute("aria-label")).toContain("Collapse toolbar");
      const divider = shadow.querySelector<HTMLElement>(".aa-divider")!;
      expect(divider.nextElementSibling).toBe(actions.at(-1)!);
      const late = shadow.querySelector('[aria-label="Late host action"]')!;
      expect(divider.compareDocumentPosition(late) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });



  it("shows an annotation icon with an open-count badge when collapsed", async () => {
    vi.useFakeTimers();
    // The strict schema boundary caps tasks at 50 annotations, so the count
    // chrome is exercised at the schema maximum.
    const fifty = taskFixture({
      annotations: Array.from({ length: 50 }, (_, index) =>
        annotationFixture({ annotationId: `ann-${index}` })),
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(fifty),
      initialState: { collapsed: true },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.textContent).toBe("50");
      expect(count.querySelector("svg")).not.toBeNull();
      expect(count.getAttribute("aria-label")).toBe("Expand toolbar (50 open annotations)");
      expect(count.getAttribute("aria-expanded")).toBe("false");
      // The minimized control shows the same action and count on hover and focus.
      count.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(shadow.querySelector('[role="tooltip"]')?.textContent)
        .toBe("Expand toolbar (50 open annotations)");
      count.click();
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
      expect(shadow.querySelector(".aa-collapsed-count")).toBeNull();
      expect(shadow.activeElement).toBe(shadow.querySelector(".aa-grip"));
    } finally {
      mounted.unmount();
    }
  });



  it("shows the annotation icon at zero open annotations when collapsed", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: true },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.querySelector("svg")).not.toBeNull();
      expect(count.textContent?.trim()).toBe("");
      expect(count.getAttribute("aria-label")).toBe("Expand toolbar");
      expect(shadow.querySelectorAll(".aa-collapsed-count .aa-count-badge")).toHaveLength(0);
    } finally {
      mounted.unmount();
    }
  });



  it("persists the dock position per origin and project task and clamps it after reload and resize", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("aa-dock") ? 420 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("aa-dock") ? 50 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-dock")) {
        return new DOMRect(Number.parseFloat(this.style.left) || 290, Number.parseFloat(this.style.top) || 730, 420, 50);
      }
      if (this.classList.contains("aa-grip")) {
        const dock = this.parentElement!.getBoundingClientRect();
        return new DOMRect(dock.left + 6, dock.top + 6, 34, 34);
      }
      return new DOMRect();
    });
    const dragTo = async (grip: HTMLButtonElement) => {
      grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 300, clientY: 740 }));
      grip.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 400, clientY: 640 }));
      grip.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    };
    const sameTask = taskFixture();
    const first = await mountAgentAnnotations({ transport: new MemoryTaskTransport(sameTask) });
    let grip = document.getElementById("agent-annotations-root")!.shadowRoot!
      .querySelector<HTMLButtonElement>(".aa-grip")!;
    grip.setPointerCapture = vi.fn();
    await dragTo(grip);
    const key = "agent-annotations:dock-position:task-1";
    expect(localStorage.getItem(key)).toContain('"left":390');
    expect(localStorage.getItem("agent-annotations:dock-position")).toBeNull();
    first.unmount();
    // A fresh mount with the same task restores the saved position.
    const second = await mountAgentAnnotations({ transport: new MemoryTaskTransport(sameTask) });
    let shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    let dock = shadow.querySelector<HTMLElement>(".aa-dock")!;
    expect(dock.style.left).toBe("390px");
    expect(dock.style.top).toBe("630px");
    // A resize clamps the saved position back into the viewport.
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(400);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(40);
    window.dispatchEvent(new Event("resize"));
    expect(dock.style.left).toBe("0px");
    expect(dock.style.top).toBe("0px");
    second.unmount();
    // A different task does not inherit the position.
    const otherTask = taskFixture({ taskId: "task-other" });
    const third = await mountAgentAnnotations({ transport: new MemoryTaskTransport(otherTask) });
    shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    dock = shadow.querySelector<HTMLElement>(".aa-dock")!;
    expect(dock.style.left).toBe("");
    third.unmount();
    // A corrupted stored value is ignored instead of crashing.
    localStorage.setItem("agent-annotations:dock-position:task-1", "{not json");
    const fourth = await mountAgentAnnotations({ transport: new MemoryTaskTransport(sameTask) });
    shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    dock = shadow.querySelector<HTMLElement>(".aa-dock")!;
    expect(dock.style.left).toBe("");
    fourth.unmount();
    localStorage.removeItem("agent-annotations:dock-position:task-1");
  });



  it("shows the same tooltip on keyboard focus as on hover and clamps it onscreen", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(200);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(100);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const pick = shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
      pick.dispatchEvent(new FocusEvent("focus"));
      vi.advanceTimersByTime(300);
      const tooltip = shadow.querySelector<HTMLElement>('[role="tooltip"]')!;
      expect(tooltip.textContent).toBe("Pick (Ctrl+Alt+P)");
      expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(tooltip.style.left)).toBeLessThan(200);
      expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(0);
      pick.dispatchEvent(new FocusEvent("blur"));
      expect(shadow.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });



  it("collapsing through the API clears hover outlines while preserving an open draft", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture()),
      initialState: { collapsed: false },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shadow.querySelector(".aa-outline")).not.toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      const textarea = shadow.querySelector<HTMLTextAreaElement>("[aria-label='Annotation comment']")!;
      textarea.value = "kept draft";
      mounted.api.commands.toolbar.toggleCollapsed();
      expect(mounted.api.getSnapshot().collapsed).toBe(true);
      expect(shadow.querySelector(".aa-outline")).toBeNull();
      expect(shadow.querySelector(".aa-multi-complete")).toBeNull();
      expect(shadow.querySelector<HTMLTextAreaElement>("[aria-label='Annotation comment']")!.value)
        .toBe("kept draft");
    } finally {
      mounted.unmount();
      target.remove();
    }
  });



  it("dismisses a hover tooltip with Escape even when the page has focus", async () => {
    vi.useFakeTimers();
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const pick = shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
      pick.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(shadow.querySelector('[role="tooltip"]')).not.toBeNull();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(shadow.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });



  it("returns focus to the minimized icon after the list panel closes", async () => {
    vi.useFakeTimers();
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture()),
      initialState: { collapsed: true },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const minimized = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "l", code: "KeyL", ctrlKey: true, altKey: true, bubbles: true,
      }));
      expect(shadow.querySelector('[aria-label="Annotation list"]')).not.toBeNull();
      await vi.runAllTimersAsync();
      const panelFocus = shadow.activeElement as HTMLElement;
      panelFocus.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, composed: true,
      }));
      await vi.runAllTimersAsync();
      expect(shadow.querySelector('[aria-label="Annotation list"]')).toBeNull();
      expect(shadow.activeElement).toBe(minimized);
    } finally {
      mounted.unmount();
    }
  });



  it("drags the minimized icon without expanding, then expands it on click", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("aa-dock")
        ? (this.dataset.collapsed === "true" ? 40 : 420)
        : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("aa-dock") ? 40 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-dock")) {
        return new DOMRect(Number.parseFloat(this.style.left) || 940, Number.parseFloat(this.style.top) || 740, 40, 40);
      }
      return new DOMRect();
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture()),
      initialState: { collapsed: true },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      count.setPointerCapture = vi.fn();
      count.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true, button: 0, clientX: 960, clientY: 760,
      }));
      count.dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true, buttons: 1, clientX: 800, clientY: 600,
      }));
      count.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
      count.click();
      expect(mounted.api.getSnapshot().collapsed).toBe(true);
      const dock = shadow.querySelector<HTMLElement>(".aa-dock")!;
      expect({ left: dock.style.left, right: dock.style.right, top: dock.style.top })
        .toEqual({ left: "780px", right: "auto", top: "580px" });
      expect(localStorage.getItem("agent-annotations:dock-position:task-1"))
        .toContain('"left":780');
      count.click();
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
      expect(shadow.activeElement).toBe(shadow.querySelector(".aa-grip"));
      expect(dock.style.left).toBe("580px");
      mounted.api.commands.toolbar.toggleCollapsed();
      expect(dock.style.left).toBe("780px");
    } finally {
      mounted.unmount();
      localStorage.removeItem("agent-annotations:dock-position:task-1");
    }
  });



  it("offers a visible multi completion action without a permanent toolbar contribution", async () => {
    const a = document.createElement("button");
    const b = document.createElement("button");
    document.body.append(a, b);
    primitives.getElementAtPoint.mockImplementation(((x: number) => (x < 50 ? a : b)) as never);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(shadow.querySelector(".aa-multi-complete")).toBeNull();
      mounted.api.commands.capture.startMulti();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 5 }));
      expect(shadow.querySelector(".aa-multi-complete")).toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 5 }));
      const chip = shadow.querySelector<HTMLButtonElement>(".aa-multi-complete")!;
      expect(chip.textContent).toContain("2");
      chip.click();
      expect(shadow.querySelector('[aria-label="Annotation composer"]')).not.toBeNull();
      expect([...shadow.querySelectorAll<HTMLButtonElement>(".aa-dock .aa-action")]
        .some((node) => node.textContent?.includes("Finish"))).toBe(false);
    } finally {
      mounted.unmount();
      a.remove();
      b.remove();
    }
  });



  it("clamps the multi completion chip when the viewport shrinks", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-dock")) return new DOMRect(290, 730, 420, 50);
      return new DOMRect();
    });
    const a = document.createElement("button");
    const b = document.createElement("button");
    document.body.append(a, b);
    primitives.getElementAtPoint.mockImplementation(((x: number) => (x < 50 ? a : b)) as never);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startMulti();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 5 }));
      const chip = shadow.querySelector<HTMLElement>(".aa-multi-complete")!;
      expect(chip.style.left).toBe("290px");
      expect(chip.style.top).toBe("722px");
      // A shrunk viewport clamps the chip back onscreen without losing it.
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(100);
      window.dispatchEvent(new Event("resize"));
      expect(chip.style.left).toBe("92px");
      expect(chip.style.top).toBe("722px");
      expect(shadow.querySelector(".aa-multi-complete")).not.toBeNull();
    } finally {
      mounted.unmount();
      a.remove();
      b.remove();
    }
  });



  it("returns pick capture to idle after a successful save", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      const composer = shadow.querySelector<HTMLElement>('[aria-label="Annotation composer"]')!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Single pick";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
      expect(shadow.querySelector('[aria-label="Annotation composer"]')).toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector('[aria-label="Annotation composer"]')).toBeNull();
    } finally {
      mounted.unmount();
      target.remove();
    }
  });



  it("returns multi capture to idle after a successful save", async () => {
    const a = document.createElement("button");
    const b = document.createElement("button");
    document.body.append(a, b);
    primitives.getElementAtPoint.mockImplementation(((x: number) => (x < 50 ? a : b)) as never);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startMulti();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 5 }));
      shadow.querySelector<HTMLButtonElement>(".aa-multi-complete")!.click();
      const composer = shadow.querySelector<HTMLElement>('[aria-label="Annotation composer"]')!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Multi save";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
      expect(shadow.querySelector(".aa-multi-complete")).toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 5 }));
      expect(shadow.querySelector(".aa-multi-complete")).toBeNull();
    } finally {
      mounted.unmount();
      a.remove();
      b.remove();
    }
  });



  it("collapse cancels active capture interception, keeps an open draft, and capture hotkeys auto-expand", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture()),
      initialState: { collapsed: false },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      const textarea = shadow.querySelector<HTMLTextAreaElement>("[aria-label='Annotation comment']")!;
      textarea.value = "typed draft";
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
      expect(shadow.querySelector<HTMLTextAreaElement>("[aria-label='Annotation comment']")!.value)
        .toBe("typed draft");
      // Closing the draft leaves the page non-intercepted.
      shadow.querySelector<HTMLButtonElement>('[aria-label="Cancel"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      // A capture hotkey while collapsed auto-expands the dock and starts
      // the capture mode; it is never a silent no-op.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, altKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
      // The collapse hotkey still toggles, and an expanded capture hotkey
      // starts the capture without changing the dock.
      mounted.api.commands.capture.cancel();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().collapsed).toBe(true);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, altKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
    } finally {
      mounted.unmount();
      target.remove();
    }
  });



  it("removes completed annotations from the list only after confirmation and keeps open ones", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const task = taskFixture({
      annotations: [
        annotationFixture({ annotationId: "open-1" }),
        annotationFixture({ annotationId: "done-1", status: "completed", completedAt: "2026-08-12T12:30:00.000Z" }),
        annotationFixture({ annotationId: "done-2", status: "completed", completedAt: "2026-08-12T13:00:00.000Z" }),
      ],
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      const remove = shadow.querySelector<HTMLButtonElement>('[aria-label^="Remove completed"]')!;
      expect(remove.getAttribute("aria-label")).toBe("Remove completed (2)");
      remove.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector(".aa-confirm")?.textContent)
        .toContain("Remove 2 completed annotations?");
      expect(confirm).not.toHaveBeenCalled();
      expect(mounted.api.getSnapshot().task.annotations.map((entry) => entry.annotationId))
        .toEqual(["open-1", "done-1", "done-2"]);
      shadow.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const remaining = mounted.api.getSnapshot().task.annotations;
      expect(remaining.map((entry) => entry.annotationId)).toEqual(["open-1"]);
      expect(remaining[0]!.status).toBe("open");
      const disabled = shadow.querySelector<HTMLButtonElement>('[aria-label^="Remove completed"]')!;
      expect(disabled.disabled).toBe(true);
      expect(disabled.getAttribute("aria-label")).toBe("Remove completed (0)");
    } finally {
      mounted.unmount();
    }
  });

  it("clears every annotation in one confirmed toolbar mutation", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const transport = new MemoryTaskTransport(taskFixture({
      annotations: [
        annotationFixture({ annotationId: "ann-1" }),
        annotationFixture({ annotationId: "ann-2" }),
      ],
    }));
    const mutate = vi.spyOn(transport, "mutate");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const clear = shadow.querySelector<HTMLButtonElement>('[aria-label="Clear all annotations"]')!;
      expect(clear.disabled).toBe(false);
      clear.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector('.aa-panel[aria-label="Clear all annotations"] h2')?.textContent)
        .toBe("Clear all annotations");
      expect(shadow.querySelector(".aa-confirm")?.textContent)
        .toContain("Clear all 2 annotations?");
      expect(confirm).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();

      shadow.querySelector<HTMLButtonElement>(".aa-confirm .aa-button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector('.aa-panel[aria-label="Clear all annotations"]')).toBeNull();
      expect(mutate).not.toHaveBeenCalled();

      shadow.querySelector<HTMLButtonElement>('[aria-label="Clear all annotations"]')!.click();
      shadow.querySelector<HTMLButtonElement>('[aria-label="Clear"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mutate).toHaveBeenCalledOnce();
      expect(mutate.mock.calls[0]![0].operations).toEqual([
        { op: "remove", annotationId: "ann-1" },
        { op: "remove", annotationId: "ann-2" },
      ]);
      expect(mounted.api.getSnapshot().task.annotations).toEqual([]);
      expect(shadow.querySelector<HTMLButtonElement>('[aria-label="Clear all annotations"]')!.disabled)
        .toBe(true);
    } finally {
      mounted.unmount();
    }
  });
});
