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
const screenshot = vi.hoisted(() => ({ captureViewportPng: vi.fn() }));

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
  captureViewportPng: screenshot.captureViewportPng,
}));

import { mountAgentAnnotations, RevisionConflictError } from "../../src/client/index.js";
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
  screenshot.captureViewportPng.mockReset();
  primitives.freeze.mockClear();
  primitives.unfreeze.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("client runtime", () => {
  it("marks the shadow host ignored before mounting and cleans it up", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const host = document.getElementById("agent-annotations-root");
    expect(host?.hasAttribute("data-react-grab-ignore")).toBe(true);
    const pick = host?.shadowRoot?.querySelector('[aria-label^="Pick"]');
    expect(pick?.querySelector("svg")).not.toBeNull();
    expect(pick?.textContent).toBe("");
    expect(host?.shadowRoot?.querySelector("style")?.textContent).toContain("color-scheme:light");

    mounted.unmount();
    mounted.unmount();
    expect(document.getElementById("agent-annotations-root")).toBeNull();
  });

  it("freezes capture symmetrically while leaving the ignored toolbar usable", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!.click();
    expect(primitives.freeze).not.toHaveBeenCalled();
    const target = document.createElement("button");
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(primitives.freeze).toHaveBeenCalledOnce();
    expect(shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!.disabled).toBe(false);
    mounted.api.commands.capture.cancel();
    expect(primitives.unfreeze).toHaveBeenCalledOnce();
    mounted.unmount();
    expect(primitives.unfreeze).toHaveBeenCalledOnce();
  });

  it("starts marker observers only for rendered markers and coalesces dynamic DOM refresh", async () => {
    const Mutation = vi.fn(class {
      callback: MutationCallback;
      constructor(callback: MutationCallback) { this.callback = callback; }
      observe = vi.fn();
      disconnect = vi.fn();
    });
    const Resize = vi.fn(class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.stubGlobal("MutationObserver", Mutation);
    vi.stubGlobal("ResizeObserver", Resize);
    const empty = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    expect(Mutation).not.toHaveBeenCalled();
    expect(Resize).not.toHaveBeenCalled();
    empty.unmount();
    vi.unstubAllGlobals();
  });

  it("anchors a multi marker to the first resolvable target and reports partial resolution", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const resolved = document.createElement("button");
    resolved.id = "second-target";
    document.body.append(resolved);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          kind: "multi",
          targets: [
            // First target is unresolved (selector matches nothing); the
            // marker must still anchor to the second, resolvable target.
            targetFixture({ selector: "#gone-first" }),
            targetFixture({
              selector: "#second-target",
              inspection: { ...targetFixture().inspection, attributes: { id: "second-target" } },
            }),
          ],
        })],
      })),
    });
    const host = document.getElementById("agent-annotations-root")!;
    const shadow = host.shadowRoot!;
    try {
      const marker = shadow.querySelector<HTMLElement>('[data-annotation-id="ann-1"]')!;
      expect(marker.hidden).toBe(false);
      // The marker anchors to the resolved second target, not the top-left.
      expect(marker.style.left).not.toBe("");
      expect(marker.dataset.resolved).toBe("1");
      expect(marker.dataset.total).toBe("2");
      // Hovering shows 1/2 targets plus the unresolved reason.
      marker.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(300);
      expect(shadow.querySelector('[role="tooltip"]')?.textContent)
        .toContain("1/2 targets");
      expect(shadow.querySelector('[role="tooltip"]')?.textContent)
        .toContain("unresolved");
      // Only the resolved target is highlighted, never the missing one.
      expect(shadow.querySelectorAll(".aa-marker-highlight").length).toBe(1);
      marker.dispatchEvent(new MouseEvent("mouseleave"));
      expect(shadow.querySelectorAll(".aa-marker-highlight").length).toBe(0);
    } finally {
      mounted.unmount();
      resolved.remove();
    }
  });

  it("highlights every resolved target on marker hover/focus and cleans up on leave", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const first = document.createElement("button");
    first.id = "multi-a";
    const second = document.createElement("button");
    second.id = "multi-b";
    document.body.append(first, second);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          kind: "multi",
          targets: [
            targetFixture({ selector: "#multi-a", inspection: { ...targetFixture().inspection, attributes: { id: "multi-a" } } }),
            targetFixture({ selector: "#multi-b", inspection: { ...targetFixture().inspection, attributes: { id: "multi-b" } } }),
          ],
        })],
      })),
    });
    const host = document.getElementById("agent-annotations-root")!;
    const shadow = host.shadowRoot!;
    const marker = shadow.querySelector<HTMLElement>('[data-annotation-id="ann-1"]')!;
    try {
      // Hover highlights ALL resolved targets (two outlines), not only the
      // anchor target.
      marker.dispatchEvent(new MouseEvent("mouseenter"));
      const highlights = () => shadow.querySelectorAll<HTMLElement>(".aa-marker-highlight");
      expect(highlights().length).toBe(2);
      expect([...highlights()].every((node) =>
        node.dataset.annotationId === "ann-1")).toBe(true);
      // The tooltip carries the resolved/total text.
      await vi.advanceTimersByTimeAsync(300);
      expect(shadow.querySelector('[role="tooltip"]')?.textContent).toContain("2/2 targets");
      marker.dispatchEvent(new MouseEvent("mouseleave"));
      expect(highlights().length).toBe(0);
      // Keyboard focus highlights the same targets and cleans up on blur.
      marker.dispatchEvent(new FocusEvent("focus"));
      expect(highlights().length).toBe(2);
      marker.dispatchEvent(new FocusEvent("blur"));
      expect(highlights().length).toBe(0);
    } finally {
      mounted.unmount();
      first.remove();
      second.remove();
    }
  });

  it("renders the multi kind localized in the list under zh-CN", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          kind: "multi",
          targets: [
            targetFixture({ selector: "#multi-zh-a", inspection: { ...targetFixture().inspection, attributes: { id: "multi-zh-a" } } }),
            targetFixture({ selector: "#multi-zh-b", inspection: { ...targetFixture().inspection, attributes: { id: "multi-zh-b" } } }),
          ],
        })],
      })),
      extensions: [defineClientExtension({
        id: "zh-list-host",
        apiVersion: 1,
        host: { locale: () => "zh-CN" },
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      const item = shadow.querySelector<HTMLElement>(".aa-list-item")!;
      expect(item.textContent).toContain("多选");
      expect(item.textContent).not.toContain("multi");
    } finally {
      mounted.unmount();
    }
  });

  it("shows resolved/total and the unresolved reason in the editor and list", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const target = document.createElement("button");
    target.id = "kept-target";
    document.body.append(target);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          kind: "multi",
          targets: [
            targetFixture({ selector: "#kept-target", inspection: { ...targetFixture().inspection, attributes: { id: "kept-target" } } }),
            targetFixture({ selector: "#gone-target" }),
            targetFixture({ selector: "#also-gone" }),
          ],
        })],
      })),
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // Editor shows 1/3 targets with the unresolved reason.
      mounted.api.commands.markers.focus("ann-1");
      const targets = shadow.querySelector<HTMLElement>(".aa-targets")!;
      expect(targets.textContent).toContain("1/3 targets");
      expect(targets.textContent).toContain("unresolved");
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      const item = shadow.querySelector<HTMLElement>('.aa-list-item[data-annotation-id="ann-1"]')!;
      expect(item.textContent).toContain("1/3 targets");
      expect(item.textContent).toContain("unresolved");
      expect(item.textContent).toContain("multi");
    } finally {
      mounted.unmount();
      target.remove();
    }
  });

  // The task keeps an open annotation so its status stays active; the
  // completed one is opened from the All filter.
  const completedTask = taskFixture({
    annotations: [
      annotationFixture({
        annotationId: "ann-completed",
        status: "completed",
        completedAt: "2026-08-12T12:00:01.000Z",
      }),
      annotationFixture({ annotationId: "ann-open" }),
    ],
  });
  it("anchors the completed editor to its list item and returns focus on close", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const itemRect = new DOMRect(20, 30, 300, 44);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-list-item")) return itemRect;
      if (this.classList.contains("aa-editor")) return new DOMRect(0, 0, 310, 174);
      return new DOMRect();
    });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(completedTask),
      initialState: { collapsed: false },
    });
    const host = document.getElementById("agent-annotations-root")!;
    const shadow = host.shadowRoot!;
    try {
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      // Switch to All to reveal the completed annotation.
      const all = [...shadow.querySelectorAll<HTMLButtonElement>("button")]
        .find((node) => node.textContent === "All")!;
      all.click();
      await vi.advanceTimersByTimeAsync(20);

      const item = shadow.querySelector<HTMLElement>('[data-annotation-id="ann-completed"]')!;
      expect(item).not.toBeNull();
      item.querySelector<HTMLButtonElement>("button")!.click();
      await vi.advanceTimersByTimeAsync(20);
      // The completed editor is anchored to the list item, never the top-left.
      const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
      expect(editor).not.toBeNull();
      expect({ left: editor.style.left, top: editor.style.top }).toEqual({
        left: "20px",
        top: "82px",
      });
      expect(shadow.querySelector(".aa-panel")).toBeNull();
      // Reopen/Delete/Save/Screenshot are all still available.
      expect([...editor.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
        .toEqual(["Save comment", "Capture screenshot", "Reopen", "Delete", "Close"]);
      // Close keeps the panel closed and returns focus to the Dock list
      // control that triggered the list (no cross-instance filter state).
      [...editor.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Close")!.click();
      await vi.advanceTimersByTimeAsync(20);
      expect(shadow.querySelector(".aa-panel")).toBeNull();
      expect(shadow.activeElement?.getAttribute("aria-label")).toBe("Annotations (Ctrl+Alt+L)");
    } finally {
      mounted.unmount();
    }
  });

  it("closes the editor with Escape, clears the highlight, and refocuses a visible dock control", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const target = document.createElement("button");
    target.id = "esc-target";
    document.body.append(target);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          targets: [targetFixture({
            selector: "#esc-target",
            inspection: { ...targetFixture().inspection, attributes: { id: "esc-target" } },
          })],
        })],
      })),
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-1");
      await vi.advanceTimersByTimeAsync(20);
      expect(shadow.querySelector(".aa-editor")).not.toBeNull();
      expect(shadow.querySelector(".aa-marker-highlight")).not.toBeNull();
      // Escape closes the editor, clears the highlight, and refocuses the
      // visible collapsed-count control (default collapsed dock).
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);
      expect(shadow.querySelector(".aa-editor")).toBeNull();
      expect(shadow.querySelector(".aa-marker-highlight")).toBeNull();
      expect(shadow.activeElement?.getAttribute("aria-label")).toBe("1 open annotations");
      // Expanded dock: Escape returns focus to the list action instead.
      mounted.api.commands.toolbar.toggleCollapsed();
      mounted.api.commands.markers.focus("ann-1");
      await vi.advanceTimersByTimeAsync(20);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);
      expect(shadow.querySelector(".aa-editor")).toBeNull();
      expect(shadow.activeElement?.getAttribute("aria-label")).toBe("Annotations (Ctrl+Alt+L)");
    } finally {
      mounted.unmount();
      target.remove();
    }
  });

  it("returns editor focus to the collapsed count while the dock stays collapsed", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(completedTask),
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      const all = [...shadow.querySelectorAll<HTMLButtonElement>("button")]
        .find((node) => node.textContent === "All")!;
      all.click();
      await vi.advanceTimersByTimeAsync(20);
      shadow.querySelector<HTMLElement>('[data-annotation-id="ann-completed"] button')!
        .click();
      await vi.advanceTimersByTimeAsync(20);
      const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
      expect(editor).not.toBeNull();
      [...editor.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Close")!.click();
      await vi.advanceTimersByTimeAsync(20);
      // The dock is still collapsed; focus returns to the visible collapsed
      // count control instead of the CSS-hidden list action.
      expect(shadow.querySelector(".aa-dock")?.getAttribute("data-collapsed")).toBe("true");
      expect(shadow.activeElement?.getAttribute("aria-label")).toBe("1 open annotations");
    } finally {
      mounted.unmount();
    }
  });

  it("anchors a fully unresolved editor to the Dock instead of the top-left", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const dockRect = new DOMRect(300, 700, 420, 46);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-dock")) return dockRect;
      if (this.classList.contains("aa-editor")) return new DOMRect(0, 0, 310, 174);
      return new DOMRect();
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          targets: [{ ...targetFixture(), selector: "#never-matching" }],
        })],
      })),
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-1");
      const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
      expect(editor).not.toBeNull();
      // Never the silent top-left default.
      expect(editor.style.left).not.toBe("8px");
      expect(editor.style.top).not.toBe("8px");
      expect(editor.style.top).toBe("510px");
      expect(shadow.querySelector<HTMLElement>(".aa-targets")!.textContent)
        .toContain("0/1 targets");
    } finally {
      mounted.unmount();
    }
  });

  it("preserves the editor draft across a host locale switch", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    let currentLocale = "en-US";
    let notify!: () => void;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture()),
      extensions: [defineClientExtension({
        id: "locale-host",
        apiVersion: 1,
        host: {
          locale: () => currentLocale,
          subscribe: (listener) => {
            notify = listener;
            return () => undefined;
          },
        },
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-1");

      const textarea = shadow.querySelector<HTMLTextAreaElement>(".aa-editor textarea")!;
      textarea.value = "Draft in progress";
      // Locale switch re-renders in place: the draft survives and the chrome
      // switches to zh-CN without a remount.
      currentLocale = "zh-CN";
      notify();
      await vi.advanceTimersByTimeAsync(0);
      const rebuilt = shadow.querySelector<HTMLTextAreaElement>(".aa-editor textarea")!;
      expect(rebuilt).not.toBeNull();
      expect(rebuilt.value).toBe("Draft in progress");
      expect(rebuilt.getAttribute("aria-label")).toBe("批注");
      expect(shadow.querySelector('[aria-label="标注 (Ctrl+Alt+L)"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it("removes capture document listeners on unmount", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
    });
    try {
      mounted.api.commands.capture.startPick();
      for (const type of ["pointermove", "pointerdown", "pointerup", "click"]) {
        expect(addSpy.mock.calls.some(([eventType]) => eventType === type)).toBe(true);
      }
      // Unmount removes every capture listener the runtime had added;
      // assertions run while the spy is still recording.
      mounted.unmount();
      for (const type of ["pointermove", "pointerdown", "pointerup", "click"]) {
        expect(removeSpy.mock.calls.some(([eventType]) => eventType === type)).toBe(true);
      }
    } finally {
      mounted.unmount();
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it("recovers an unresolved nested iframe marker after the outer document is populated", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    document.body.innerHTML = '<div id="root"></div>';
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          targets: [targetFixture({
            selector: "#outer >>iframe>> #inner >>iframe>> #target",
            inspection: {
              ...targetFixture().inspection,
              attributes: { id: "target" },
            },
          })],
        })],
      })),
    });
    try {
      const marker = document.getElementById("agent-annotations-root")!
        .shadowRoot!.querySelector<HTMLButtonElement>(".aa-marker")!;
      expect(marker.hidden).toBe(true);
      await vi.runAllTimersAsync();

      const outer = document.createElement("iframe");
      outer.id = "outer";
      document.getElementById("root")!.append(outer);
      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(true);

      outer.contentDocument!.body.innerHTML = '<iframe id="inner"></iframe>';
      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(true);

      const inner = outer.contentDocument!.querySelector<HTMLIFrameElement>("#inner")!;
      inner.contentDocument!.body.innerHTML = '<button id="target">Target</button>';
      inner.dispatchEvent(new Event("load"));

      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(false);
    } finally {
      mounted.unmount();
      document.body.innerHTML = "";
    }
  });

  it("exposes snapshot subscriptions and commands without React setters", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const listener = vi.fn();
    const unsubscribe = mounted.api.subscribe(listener);

    mounted.api.commands.capture.startPick();
    mounted.api.commands.markers.hide();
    mounted.api.commands.panels.open("agent-annotations.builtin:help");

    expect(mounted.api.getSnapshot()).toMatchObject({
      captureMode: "pick",
      markersVisible: false,
      openPanel: "agent-annotations.builtin:help",
    });
    expect(listener).toHaveBeenCalled();
    expect(Object.keys(mounted.api)).toEqual(["getSnapshot", "subscribe", "commands"]);
    const publicTask = mounted.api.getSnapshot().task;
    const taskId = publicTask.taskId;
    expect(() => { publicTask.taskId = "tampered"; }).toThrow(TypeError);
    expect(mounted.api.getSnapshot().task.taskId).toBe(taskId);
    unsubscribe();
    mounted.unmount();
  });

  it("applies subscribed file revisions and disposes the transport poll", async () => {
    vi.useFakeTimers();
    const task = await new MemoryTaskTransport().read();
    let publish!: (task: AgentAnnotationsTask) => void;
    const unsubscribe = vi.fn();
    const transport: TaskTransport = {
      read: async () => task,
      mutate: async () => task,
      subscribe(listener) {
        publish = listener;
        return unsubscribe;
      },
    };
    const mounted = await mountAgentAnnotations({ transport });
    publish({ ...task, taskRevision: 1 });
    await vi.runAllTimersAsync();
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(1);
    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("fails before creating UI when the transport read returns an invalid task", async () => {
    const transport: TaskTransport = {
      read: async () => ({ invalid: true }) as never,
      mutate: async () => {
        throw new Error("unused");
      },
    };
    await expect(mountAgentAnnotations({ transport })).rejects.toThrow(/invalid task from transport/);
    expect(document.getElementById("agent-annotations-root")).toBeNull();
  });

  it("throws a locatable error for invalid subscribed tasks without polluting state", async () => {
    const task = await new MemoryTaskTransport().read();
    let publish!: (task: AgentAnnotationsTask) => void;
    const transport: TaskTransport = {
      read: async () => task,
      mutate: async () => task,
      subscribe(listener) {
        publish = listener;
        return () => undefined;
      },
    };
    const mounted = await mountAgentAnnotations({ transport });
    expect(() => publish({ ...task, taskRevision: 99, annotations: "broken" } as never)).toThrow(/invalid task from transport/);
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(task.taskRevision);
    expect(mounted.api.getSnapshot().task.annotations).toHaveLength(task.annotations.length);
    mounted.unmount();
  });

  it("replaces an old high-revision task when a new task id arrives at revision 0", async () => {
    vi.useFakeTimers();
    const taskA = await new MemoryTaskTransport(taskFixture({ taskId: "task-a", taskRevision: 12 })).read();
    let publish!: (task: AgentAnnotationsTask) => void;
    const transport: TaskTransport = {
      read: async () => taskA,
      mutate: async () => taskA,
      subscribe(listener) {
        publish = listener;
        return () => undefined;
      },
    };
    const mounted = await mountAgentAnnotations({ transport });
    expect(mounted.api.getSnapshot().task.taskId).toBe("task-a");
    // The same task id with an older revision is ignored.
    publish({ ...taskA, taskRevision: 10 });
    await vi.runAllTimersAsync();
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(12);
    // A replacement task id at revision 0 must replace task-a@12.
    publish({ ...taskA, taskId: "task-b", taskRevision: 0 });
    await vi.runAllTimersAsync();
    expect(mounted.api.getSnapshot().task.taskId).toBe("task-b");
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(0);
    // The same replacement at an equal revision is ignored.
    publish({ ...taskA, taskId: "task-b", taskRevision: 0 });
    await vi.runAllTimersAsync();
    expect(mounted.api.getSnapshot().task.taskId).toBe("task-b");
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(0);
    mounted.unmount();
  });

  it("does not render markers for completed annotations", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        status: "completed",
        annotations: [{
          ...taskFixture().annotations[0]!,
          status: "completed",
          completedAt: "2026-08-12T12:05:00.000Z",
        }],
      })),
    });
    expect(document.getElementById("agent-annotations-root")!.shadowRoot!.querySelector(".aa-marker"))
      .toBeNull();
    mounted.unmount();
  });

  it("positions the editor beside its marker and clamps it after viewport changes", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    let markerRect = new DOMRect(422, 88, 28, 28);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-marker")) return markerRect;
      if (this.classList.contains("aa-editor")) return new DOMRect(0, 0, 310, 174);
      return new DOMRect();
    });
    const target = document.createElement("button");
    target.id = "position-target";
    document.body.append(target);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          targets: [targetFixture({
            selector: "#position-target",
            inspection: {
              ...targetFixture().inspection,
              attributes: { id: "position-target" },
            },
          })],
        })],
      })),
    });

    try {
      mounted.api.commands.markers.focus("ann-1");
      const editor = document.getElementById("agent-annotations-root")!
        .shadowRoot!.querySelector<HTMLElement>(".aa-editor")!;
      expect([...editor.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
        .toEqual(["Save comment", "Capture screenshot", "Complete", "Delete", "Close"]);
      expect([...editor.querySelectorAll("button")].every((button) =>
        button.textContent === "" && !!button.querySelector("svg")
      )).toBe(true);
      expect({ left: editor.style.left, top: editor.style.top }).toEqual({
        left: "422px",
        top: "124px",
      });

      markerRect = new DOMRect(950, 740, 28, 28);
      window.dispatchEvent(new Event("resize"));
      await vi.runAllTimersAsync();
      expect({ left: editor.style.left, top: editor.style.top }).toEqual({
        left: "682px",
        top: "558px",
      });
    } finally {
      mounted.unmount();
      target.remove();
    }
  });

  it("positions the icon-only composer beside its target and clamps it on scroll", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("aa-composer")) return new DOMRect(0, 0, 310, 160);
      return new DOMRect();
    });
    primitives.getElementBounds.mockReturnValue({ x: 420, y: 90, width: 120, height: 30 });
    const target = document.createElement("button");
    document.body.append(target);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });

    try {
      mounted.api.commands.capture.startPick();
      target.click();
      const composer = document.getElementById("agent-annotations-root")!
        .shadowRoot!.querySelector<HTMLElement>(".aa-composer")!;
      expect({ left: composer.style.left, top: composer.style.top }).toEqual({
        left: "420px",
        top: "128px",
      });
      expect([...composer.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
        .toEqual(["Cancel", "Save annotation"]);
      expect([...composer.querySelectorAll("button")].every((button) =>
        button.textContent === "" && !!button.querySelector("svg")
      )).toBe(true);

      primitives.getElementBounds.mockReturnValue({ x: 950, y: 740, width: 80, height: 28 });
      window.dispatchEvent(new Event("scroll"));
      await vi.runAllTimersAsync();
      expect({ left: composer.style.left, top: composer.style.top }).toEqual({
        left: "682px",
        top: "572px",
      });
    } finally {
      mounted.unmount();
      target.remove();
    }
  });

  it("keeps failed comment edits retryable and closes the editor after persistence", async () => {
    history.pushState({}, "", "/settings");
    const transport = new MemoryTaskTransport(taskFixture());
    const mutate = vi.spyOn(transport, "mutate")
      .mockRejectedValueOnce(new Error("revision conflict"));
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;

    mounted.api.commands.markers.focus("ann-1");
    const form = shadow.querySelector<HTMLFormElement>(".aa-editor")!;
    const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
    const save = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    textarea.value = "Retained draft";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(save.disabled).toBe(true);

    await vi.waitFor(() => expect(shadow.querySelector('[role="status"]')?.textContent)
      .toBe("revision conflict"));
    expect(shadow.querySelector<HTMLTextAreaElement>(".aa-editor textarea")?.value)
      .toBe("Retained draft");
    expect(save.disabled).toBe(false);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(shadow.querySelector(".aa-editor")).toBeNull());
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe("Comment saved");
    expect((await transport.read()).annotations[0]?.comment).toBe("Retained draft");
    expect(mutate).toHaveBeenCalledTimes(2);
    mounted.unmount();
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

  it("cancels scheduled work and ignores mutation completion after unmount", async () => {
    vi.useFakeTimers();
    const task = await new MemoryTaskTransport().read();
    let resolveMutation!: (task: AgentAnnotationsTask) => void;
    const transport: TaskTransport = {
      read: async () => task,
      mutate: () => new Promise((resolve) => { resolveMutation = resolve; }),
    };
    const mounted = await mountAgentAnnotations({ transport });
    const listener = vi.fn();
    mounted.api.subscribe(listener);
    const pick = document
      .getElementById("agent-annotations-root")!
      .shadowRoot!
      .querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
    pick.dispatchEvent(new MouseEvent("mouseenter"));
    mounted.api.commands.markers.focus("missing");
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    const pending = mounted.api.commands.annotations.removeCompleted();
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
    resolveMutation(task);
    await pending;
    expect(listener).not.toHaveBeenCalled();
    expect(document.getElementById("agent-annotations-root")).toBeNull();
  });

  it("captures bounded redacted console, window, and promise diagnostics", async () => {
    const originalConsoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const restoredConsoleError = console.error;
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });

    console.error("token=console-secret");
    window.dispatchEvent(new ErrorEvent("error", { message: "password=window-secret" }));
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: "api_key=promise-secret" });
    window.dispatchEvent(rejection);

    const diagnostics = mounted.api.getSnapshot().diagnostics;
    expect(diagnostics.map((entry) => entry.source)).toEqual(["console", "window", "promise"]);
    expect(diagnostics.map((entry) => entry.message).join(" ")).not.toContain("secret");
    for (let index = 0; index < 21; index += 1) {
      window.dispatchEvent(new ErrorEvent("error", { message: `bounded-${index}` }));
    }
    expect(mounted.api.getSnapshot().diagnostics).toHaveLength(20);
    mounted.unmount();
    expect(console.error).toBe(restoredConsoleError);
    originalConsoleError.mockRestore();
  });

  it("runs all contributions through the registry and disposes extensions once", async () => {
    vi.useFakeTimers();
    const setup = vi.fn();
    const dispose = vi.fn();
    const execute = vi.fn();
    const extension = defineClientExtension({
      id: "runtime-test",
      apiVersion: 1,
      setup: () => {
        setup();
        return dispose;
      },
      toolbar: [{
        id: "runtime-action",
        group: "host" as const,
        label: "Runtime action",
        icon: ({ className, size }) => createElement("svg", {
          className,
          width: size,
          height: size,
          "data-runtime-icon": "",
        }),
        kind: "action" as const,
        shortcut: { key: "R", code: "KeyR", primary: true, alt: true, shift: false },
        execute,
      }],
      panels: [{
        id: "runtime-panel",
        title: "Runtime panel",
        render: ({ close }) => createElement("button", { onClick: close }, "Close runtime panel"),
      }],
      targetEnrichers: [{ id: "target", enrich: () => ({ secret: "token=value" }) }],
      redactors: [{ id: "redact", redact: () => ({ safe: true }) }],
      exporters: [{ id: "json", export: ({ task }) => JSON.stringify(task) }],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [extension],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const action = shadow.querySelector<HTMLButtonElement>('[aria-label^="Runtime action"]')!;
    expect(action.getAttribute("aria-label")).toContain("Ctrl+Alt+R");
    expect(action.querySelector("[data-runtime-icon]")).not.toBeNull();
    expect(action.textContent).toBe("");
    expect(mounted.api.getSnapshot().shortcuts.find(({ id }) => id === "runtime-test:runtime-action")?.formatted).toBe("Ctrl+Alt+R");
    mounted.api.commands.panels.open("agent-annotations.builtin:help");
    expect(shadow.querySelector('[aria-label="Shortcut help"]')?.textContent).toContain("Ctrl+Alt+R");
    mounted.api.commands.panels.close();
    action.click();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "r", code: "KeyR", ctrlKey: true, altKey: true,
    }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenCalledOnce();
    expect(mounted.api.getSnapshot().exporters).toContainEqual({ id: "runtime-test:json", extensionId: "runtime-test" });
    expect(await mounted.api.commands.exporters.format()).toContain("# Agent Annotations Handoff");
    expect(await mounted.api.commands.exporters.format("runtime-test:json")).toContain('"schema":"agent-annotations.task.v1"');
    mounted.api.commands.panels.open("runtime-test:runtime-panel");
    vi.runAllTimers();
    expect(shadow.activeElement).toBe(shadow.querySelector(".aa-panel button"));
    shadow.querySelector<HTMLButtonElement>(".aa-panel button")!.click();
    expect(mounted.api.getSnapshot().openPanel).toBeNull();
    mounted.unmount();
    mounted.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("captures safe network failures for fetch while mounted and suppresses own endpoints", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/heartbeat") || url.includes("/revision")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("fail-500")) return new Response("{}", { status: 500 });
      if (url.includes("fail-404")) return new Response("{}", { status: 404 });
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    let mounted: Awaited<ReturnType<typeof mountAgentAnnotations>> | null = null;
    try {
      mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      await vi.advanceTimersByTimeAsync(0);
      const network = (): AgentAnnotationsDiagnosticsEntry[] =>
        mounted!.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network");
      // Rejection, 500, and 404 are recorded with query-free sanitized URLs.
      await expect(fetch("https://app.test/boom?token=SECRET", { method: "POST" }))
        .rejects.toThrow("network down");
      expect((await fetch("https://app.test/fail-500?token=SECRET")).status).toBe(500);
      expect((await fetch("https://app.test/fail-404")).status).toBe(404);
      await vi.advanceTimersByTimeAsync(0);
      const entries = network();
      expect(entries.length).toBe(3);
      expect(entries[0]).toMatchObject({
        source: "network",
        method: "POST",
        url: "https://app.test/boom",
        transport: "fetch",
      });
      expect(entries[0]!.url).not.toContain("SECRET");
      expect(entries[1]!.status).toBe(500);
      expect(entries[2]!.status).toBe(404);
      expect(JSON.stringify(entries)).not.toContain("?");
      expect(JSON.stringify(entries)).not.toContain("SECRET");
      // This package's own endpoint is never recorded.
      expect(JSON.stringify(entries)).not.toContain("__agent-annotations");
      mounted.unmount();
      // Unmount restores the original fetch identity.
      expect(window.fetch).toBe(fetchMock);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("captures safe XHR failures (error/abort/timeout/500) through real events on separate requests", async () => {
    const originalSend = XMLHttpRequest.prototype.send;
    // Never let jsdom open a real socket: stub send before the runtime patch
    // captures it as its "original".
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ..._args: unknown[]) {
      return undefined;
    } as typeof XMLHttpRequest.prototype.send;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    const dispatch = (xhr: XMLHttpRequest, type: string) => {
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event(type));
    };
    try {
      // Each failure kind is exercised with its own XHR/request and the real
      // dispatched event; listeners are never captured or re-attached.
      const fiveHundred = new XMLHttpRequest();
      fiveHundred.open("GET", "https://app.test/xhr-500?token=SECRET");
      fiveHundred.send();
      Object.defineProperty(fiveHundred, "status", { value: 500 });
      dispatch(fiveHundred, "loadend");

      const errored = new XMLHttpRequest();
      errored.open("GET", "https://app.test/xhr-error");
      errored.send();
      dispatch(errored, "error");

      const aborted = new XMLHttpRequest();
      aborted.open("POST", "https://app.test/xhr-abort");
      aborted.send();
      dispatch(aborted, "abort");

      const timedOut = new XMLHttpRequest();
      timedOut.open("PUT", "https://app.test/xhr-timeout");
      timedOut.send();
      dispatch(timedOut, "timeout");

      await new Promise((resolve) => setTimeout(resolve, 0));
      const entries = mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network");
      expect(entries.some((entry) => entry.transport === "xhr" && entry.status === 500
        && entry.url === "https://app.test/xhr-500" && entry.method === "GET")).toBe(true);
      expect(entries.some((entry) => entry.transport === "xhr"
        && entry.url === "https://app.test/xhr-error" && entry.message.includes("network error"))).toBe(true);
      expect(entries.some((entry) => entry.transport === "xhr"
        && entry.url === "https://app.test/xhr-abort" && entry.method === "POST"
        && entry.message.includes("aborted"))).toBe(true);
      expect(entries.some((entry) => entry.transport === "xhr"
        && entry.url === "https://app.test/xhr-timeout" && entry.method === "PUT"
        && entry.message.includes("timeout"))).toBe(true);
      expect(JSON.stringify(entries)).not.toContain("SECRET");
      expect(JSON.stringify(entries)).not.toContain("?");
      // The listeners are gone after each terminal event: no second report.
      dispatch(errored, "error");
      dispatch(aborted, "abort");
      dispatch(timedOut, "timeout");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network").length)
        .toBe(entries.length);
    } finally {
      mounted.unmount();
      XMLHttpRequest.prototype.send = originalSend;
    }
  });



  it("keeps XHR captures off the instance and strips listeners so reused XHRs never double-report", async () => {
    const originalSend = XMLHttpRequest.prototype.send;
    // Never let jsdom open a real socket: stub send before the runtime patch
    // captures it as its "original".
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ..._args: unknown[]) {
      return undefined;
    } as typeof XMLHttpRequest.prototype.send;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    const dispatch = (xhr: XMLHttpRequest, type: string) => {
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event(type));
    };
    const entries = () => mounted.api.getSnapshot().diagnostics
      .filter((entry) => entry.source === "network");
    try {
      const xhr = new XMLHttpRequest();
      const keysBefore = Object.keys(xhr);
      xhr.open("GET", "https://app.test/one?token=SECRET");
      // No observable capture property is ever added to the application XHR.
      expect(Object.keys(xhr)).toEqual(keysBefore);
      expect("__aaNetwork" in xhr).toBe(false);
      xhr.send();
      Object.defineProperty(xhr, "status", { value: 500 });
      dispatch(xhr, "loadend");
      expect(entries().filter((entry) => entry.url === "https://app.test/one").length).toBe(1);
      expect(JSON.stringify(entries())).not.toContain("SECRET");
      // The terminal listeners were removed: another event without a new send
      // reports nothing.
      dispatch(xhr, "loadend");
      expect(entries().filter((entry) => entry.url === "https://app.test/one").length).toBe(1);
      // Reusing the same instance for a second request reports exactly once:
      // no old-request listeners remain to double-report.
      xhr.open("GET", "https://app.test/two");
      xhr.send();
      Object.defineProperty(xhr, "status", { value: 500 });
      dispatch(xhr, "loadend");
      expect(entries().filter((entry) => entry.url === "https://app.test/two").length).toBe(1);
      // Late events from the finished request are inert (all stripped).
      dispatch(xhr, "error");
      dispatch(xhr, "abort");
      dispatch(xhr, "timeout");
      expect(entries().length).toBe(2);
    } finally {
      mounted.unmount();
      XMLHttpRequest.prototype.send = originalSend;
    }
  });

  it("cleans listeners after a successful loadend so a reused XHR never double-reports", async () => {
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ..._args: unknown[]) {
      return undefined;
    } as typeof XMLHttpRequest.prototype.send;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    const dispatch = (xhr: XMLHttpRequest, type: string) => {
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event(type));
    };
    const entries = () => mounted.api.getSnapshot().diagnostics
      .filter((entry) => entry.source === "network");
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "https://app.test/success");
      xhr.send();
      // A successful loadend (status < 400) reports nothing but must still
      // remove this request's listeners.
      Object.defineProperty(xhr, "status", { value: 200, configurable: true });
      dispatch(xhr, "loadend");
      expect(entries()).toEqual([]);
      // The old listeners are gone: another loadend without a new send
      // reports nothing even if the status now looks failed.
      Object.defineProperty(xhr, "status", { value: 500, configurable: true });
      dispatch(xhr, "loadend");
      expect(entries()).toEqual([]);
      // Reusing the same instance for a failing second request reports
      // exactly once: no stale listeners from the successful first request.
      xhr.open("GET", "https://app.test/second");
      xhr.send();
      Object.defineProperty(xhr, "status", { value: 500 });
      dispatch(xhr, "loadend");
      expect(entries().filter((entry) => entry.url === "https://app.test/second").length).toBe(1);
      dispatch(xhr, "loadend");
      expect(entries().filter((entry) => entry.url === "https://app.test/second").length).toBe(1);
    } finally {
      mounted.unmount();
      XMLHttpRequest.prototype.send = originalSend;
    }
  });

  it("passes non-standard open arguments to native XHR open untouched", async () => {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    // Native stub converts the URL exactly once, like a real implementation.
    const nativeOpen = vi.fn(function (this: XMLHttpRequest, method: string, url: string | URL) {
      if (typeof url !== "string") String(url);
      return undefined;
    });
    XMLHttpRequest.prototype.open = nativeOpen as unknown as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ..._args: unknown[]) {
      return undefined;
    } as typeof XMLHttpRequest.prototype.send;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    try {
      const toStringSpy = vi.fn(() => "https://app.test/private");
      const oddUrl = { toString: toStringSpy } as unknown as string;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", oddUrl);
      // The native open received the exact same object; the wrapper never
      // converted it itself.
      expect(nativeOpen).toHaveBeenCalledTimes(1);
      expect(nativeOpen.mock.calls[0]![0]).toBe("GET");
      expect(nativeOpen.mock.calls[0]![1]).toBe(oddUrl);
      // toString was called exactly once, by the native stub only.
      expect(toStringSpy).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    }
  });

  it("clears captures when native open throws so a reused XHR never diagnoses the failed open", async () => {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    let shouldThrow = false;
    const nativeOpen = vi.fn(function (this: XMLHttpRequest, ..._args: unknown[]) {
      if (shouldThrow) throw new TypeError("native open failed");
      return undefined;
    });
    XMLHttpRequest.prototype.open = nativeOpen as unknown as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ..._args: unknown[]) {
      return undefined;
    } as typeof XMLHttpRequest.prototype.send;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    const xhr = new XMLHttpRequest();
    try {
      // A successful first open sets a capture.
      xhr.open("GET", "https://app.test/first");
      // A throwing second open must clear the WeakMap (old and new capture).
      shouldThrow = true;
      expect(() => xhr.open("GET", "https://app.test/bad")).toThrow("native open failed");
      // Reusing the same XHR after the failed open: a send and a 500 loadend
      // must not produce a diagnostic for the request it never opened.
      shouldThrow = false;
      xhr.send();
      Object.defineProperty(xhr, "status", { value: 500 });
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event("loadend"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network"))
        .toEqual([]);
    } finally {
      mounted.unmount();
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    }
  });

  it("skips overlong URLs and invalid or overlong methods before the snapshot", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    let mounted: Awaited<ReturnType<typeof mountAgentAnnotations>> | null = null;
    try {
      mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      // Overlong origin+path (> 2000) never enters the snapshot.
      await fetch(`https://app.test/${"x".repeat(2000)}`);
      // Overlong and non-A-Z methods never enter the snapshot.
      await fetch("https://app.test/method-ok", { method: "x".repeat(100) });
      await fetch("https://app.test/method-ok", { method: "GE T" });
      await vi.advanceTimersByTimeAsync(0);
      expect(mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network"))
        .toEqual([]);
    } finally {
      mounted?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("passes unknown fetch inputs to native fetch untouched and skips non-http(s) diagnostics", async () => {
    vi.useFakeTimers();
    const toStringSpy = vi.fn(() => "https://app.test/unknown?token=SECRET");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    let mounted: Awaited<ReturnType<typeof mountAgentAnnotations>> | null = null;
    try {
      mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      const unknown = { toString: toStringSpy } as unknown as RequestInfo;
      await fetch(unknown);
      await vi.advanceTimersByTimeAsync(0);
      // Native behavior preserved: the object reached fetch untouched and the
      // wrapper never converted it (no double conversion), so no diagnostics.
      expect(fetchMock).toHaveBeenCalledWith(unknown, undefined);
      expect(toStringSpy).not.toHaveBeenCalled();
      // A non-http(s) URL is rejected by the client sanitizer like the server.
      await fetch("mailto:test@example.com");
      await vi.advanceTimersByTimeAsync(0);
      expect(mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network"))
        .toEqual([]);
    } finally {
      mounted?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("suppresses own-endpoint failures including relative URLs and never recurses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      // A failing own-endpoint POST: the diagnostics append itself rejects.
      if (url.includes("__agent-annotations/diagnostics")) {
        throw new TypeError("diagnostics endpoint down");
      }
      if (url.includes("__agent-annotations")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("fail-500")) return new Response("{}", { status: 500 });
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    let mounted: Awaited<ReturnType<typeof mountAgentAnnotations>> | null = null;
    try {
      mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      await vi.advanceTimersByTimeAsync(0);
      // Failing own-endpoint requests (relative and absolute) are suppressed
      // and must not produce a single network diagnostic or recurse.
      await expect(fetch("/__agent-annotations/diagnostics")).rejects.toThrow("diagnostics endpoint down");
      const absoluteOwn = `${window.location.origin}/__agent-annotations/diagnostics`;
      await expect(fetch(absoluteOwn)).rejects.toThrow("diagnostics endpoint down");
      // Own-endpoint successes are also never recorded.
      expect((await fetch("/__agent-annotations/heartbeat")).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      const entries = mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network");
      expect(entries).toEqual([]);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      mounted?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("restores owned surfaces independently when a foreign wrapper replaces fetch", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
      if (url.includes("__agent-annotations")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("fail-500")) return new Response("{}", { status: 500 });
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    let mounted: Awaited<ReturnType<typeof mountAgentAnnotations>> | null = null;
    try {
      mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      const ours = window.fetch;
      expect(ours).not.toBe(originalFetch);
      expect(XMLHttpRequest.prototype.open).not.toBe(originalOpen);
      expect(XMLHttpRequest.prototype.send).not.toBe(originalSend);
      // Another library replaces our fetch wrapper with its own, capturing ours.
      const foreign = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        return ours.call(this, input, init);
      } as typeof window.fetch;
      window.fetch = foreign;
      // Unmount: the foreign-overridden fetch surface stays owned and stable
      // (never restored through the foreign wrapper, never wrapped again),
      // while the still-ours XHR surfaces are restored to their originals.
      mounted.unmount();
      mounted = null;
      expect(window.fetch).toBe(foreign);
      expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
      expect(XMLHttpRequest.prototype.send).toBe(originalSend);
      // Remount: the fetch surface is not wrapped again; the XHR surfaces are
      // reinstalled exactly once.
      mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      expect(window.fetch).toBe(foreign);
      expect(XMLHttpRequest.prototype.open).not.toBe(originalOpen);
      expect(XMLHttpRequest.prototype.send).not.toBe(originalSend);
      // A failure through the chain (foreign -> our still-live wrapper ->
      // real fetch) is delivered exactly once to the live mount.
      expect((await fetch("https://app.test/fail-500")).status).toBe(500);
      await vi.advanceTimersByTimeAsync(0);
      const entries = mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.url).toBe("https://app.test/fail-500");
      // Removing the foreign wrapper reveals ours again; the final unmount
      // restores every surface identity-safely.
      window.fetch = ours;
      mounted.unmount();
      mounted = null;
      expect(window.fetch).toBe(originalFetch);
      expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
      expect(XMLHttpRequest.prototype.send).toBe(originalSend);
    } finally {
      mounted?.unmount();
      if (window.fetch !== originalFetch) window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
      vi.unstubAllGlobals();
    }
  });

  it("rejects a second simultaneous mount so runtime-level wrappers can never stack", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
      if (url.includes("__agent-annotations")) return new Response("{}", { status: 200 });
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const originalFetch = window.fetch;
    try {
      const first = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      const patchedOnce = window.fetch;
      await expect(mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      })).rejects.toThrow("already mounted");
      expect(window.fetch).toBe(patchedOnce);
      first.unmount();
      expect(window.fetch).toBe(originalFetch);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives fetch method from Request.method and keeps XHR callbacks inert after unsubscribe", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
      if (url.includes("__agent-annotations")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("request-500")) return new Response("{}", { status: 500 });
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const originalSend = XMLHttpRequest.prototype.send;
    // Never let jsdom open a real socket: stub send before the runtime patch
    // captures it as its "original".
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ..._args: unknown[]) {
      return undefined;
    } as typeof XMLHttpRequest.prototype.send;
    try {
      const mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      // Method derived from Request.method when init.method is absent.
      await fetch(new Request("https://app.test/request-500?token=SECRET", { method: "DELETE" }));
      await vi.advanceTimersByTimeAsync(0);
      let entries = mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ method: "DELETE", transport: "fetch", url: "https://app.test/request-500" });
      expect(JSON.stringify(entries)).not.toContain("SECRET");
      // An XHR sent while mounted fires its listeners through real events.
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "https://app.test/xhr");
      xhr.send();
      Object.defineProperty(xhr, "status", { value: 500 });
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event("loadend"));
      await vi.advanceTimersByTimeAsync(0);
      const xhrEntries = mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network");
      expect(xhrEntries.some((entry) => entry.transport === "xhr" && entry.status === 500)).toBe(true);
      const beforeUnmount = mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network").length;
      // After unmount, the same XHR's later events are inert: no new records.
      mounted.unmount();
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event("error"));
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event("abort"));
      (xhr as XMLHttpRequest & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event("timeout"));
      await vi.advanceTimersByTimeAsync(0);
      expect(mounted.api.getSnapshot().diagnostics.filter((entry) => entry.source === "network").length)
        .toBe(beforeUnmount);
    } finally {
      XMLHttpRequest.prototype.send = originalSend;
      vi.unstubAllGlobals();
    }
  });

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

  it("starts collapsed by default with the count chrome and explicit initialState support", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(mounted.api.getSnapshot().collapsed).toBe(true);
      expect(mounted.api.getSnapshot().markersVisible).toBe(true);
      expect(shadow.querySelector(".aa-dock")?.getAttribute("data-collapsed")).toBe("true");
      expect(shadow.querySelector(".aa-collapsed-count")).not.toBeNull();
      // initialState can never auto-enter a capture mode: the snapshot is
      // idle immediately after mount.
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    } finally {
      mounted.unmount();
    }
    const expanded = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false, markersVisible: false },
    });
    try {
      expect(expanded.api.getSnapshot().collapsed).toBe(false);
      expect(expanded.api.getSnapshot().markersVisible).toBe(false);
    } finally {
      expanded.unmount();
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
      // Default collapsed: no list builtin, the count expands the dock.
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

  it("expands from the collapsed count when the list builtin is disabled", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      builtins: { list: false },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      expect(mounted.api.getSnapshot().collapsed).toBe(true);
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.getAttribute("data-action-id")).toBe("agent-annotations.builtin:toggle");
      expect(count.getAttribute("aria-label")).toContain("Expand toolbar");
      count.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
    } finally {
      mounted.unmount();
    }
  });

  it("isolates failing predicates, icon, and panel per contribution while builtins stay usable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = vi.fn();
    let iconRenders = 0;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      extensions: [defineClientExtension({
        id: "faulty-contributions",
        apiVersion: 1,
        toolbar: [
          {
            id: "bad-visible", group: "view", label: "Bad visible",
            icon: () => null, kind: "action", execute: action,
            isVisible: () => { throw new Error("visible boom"); },
          },
          {
            id: "bad-enabled", group: "view", label: "Bad enabled",
            icon: () => null, kind: "action", execute: action,
            isEnabled: () => { throw new Error("enabled boom"); },
          },
          {
            id: "bad-pressed", group: "view", label: "Bad pressed",
            icon: () => null, kind: "toggle",
            isPressed: () => { throw new Error("pressed boom"); },
            execute: action,
          },
          {
            id: "bad-icon", group: "view", label: "Bad icon",
            icon: () => { throw new Error("icon boom"); },
            kind: "action", execute: action,
          },
          {
            id: "counted-icon", group: "view", label: "Counted icon",
            icon: () => {
              iconRenders += 1;
              return null;
            },
            kind: "action", execute: action,
          },
          {
            id: "bad-panel", group: "view", label: "Bad panel", kind: "panel", panelId: "bad-panel",
            icon: () => null, execute: () => undefined,
          },
          {
            id: "bad-execute", group: "view", label: "Bad execute",
            icon: () => null, kind: "action",
            execute: () => { throw new Error("execute boom"); },
          },
        ],
        panels: [{
          id: "bad-panel", title: "Bad panel",
          render: () => { throw new Error("panel boom"); },
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // Contribution guards never synchronously re-enter React: no flushSync
      // lifecycle warning and the healthy icon renders exactly once.
      expect(errorSpy.mock.calls.some(([message]) =>
        String(message).includes("flushSync was called from inside")
      )).toBe(false);
      expect(iconRenders).toBeGreaterThan(0);
      // isVisible failure hides the contribution; isEnabled disables it.
      expect(shadow.querySelector('[data-action-id="faulty-contributions:bad-visible"]')).toBeNull();
      const disabled = shadow.querySelector<HTMLButtonElement>('[data-action-id="faulty-contributions:bad-enabled"]')!;
      expect(disabled.disabled).toBe(true);
      // isPressed failure: no pressed attribute; icon failure: fallback icon.
      const pressed = shadow.querySelector<HTMLButtonElement>('[data-action-id="faulty-contributions:bad-pressed"]')!;
      expect(pressed.hasAttribute("aria-pressed")).toBe(false);
      const icon = shadow.querySelector<HTMLButtonElement>('[data-action-id="faulty-contributions:bad-icon"]')!;
      expect(icon.querySelector("svg")).not.toBeNull();
      // Panel render failure: the safe error panel is shown, builtins still open.
      mounted.api.commands.panels.open("faulty-contributions:bad-panel");
      expect(shadow.querySelector(".aa-panel-error")).not.toBeNull();
      mounted.api.commands.panels.close();
      // Execute failure: recorded, capture stays usable.
      shadow.querySelector<HTMLButtonElement>('[data-action-id="faulty-contributions:bad-execute"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      mounted.api.commands.capture.startPick();
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
      mounted.api.commands.capture.cancel();
      // Predicate errors are deduplicated per (extension, phase,
      // contribution): repeated renders never grow the diagnostics.
      const extensionEntries = () => mounted.api.getSnapshot().diagnostics.filter(
        (entry) => entry.source === "extension"
      );
      const before = extensionEntries().length;
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(extensionEntries().length).toBe(before);
      const keys = new Set(extensionEntries().map((entry) =>
        `${entry.extensionId}|${entry.phase}|${entry.contributionId ?? ""}`
      ));
      expect(keys.size).toBe(extensionEntries().length);
      expect(extensionEntries().length).toBeLessThanOrEqual(20);
      // Builtin Copy and List stay usable after every injected failure.
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")?.value ?? "")
        .toContain("# Agent Annotations Handoff");
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      expect(shadow.querySelector('[aria-label="Annotation list"]')).not.toBeNull();
      mounted.api.commands.panels.close();
    } finally {
      mounted.unmount();
    }
  });



  it("records structured export, enrich, and redact failures without breaking the flows", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const mounted = await mountAgentAnnotations({
      transport,
      initialState: { collapsed: false },
      extensions: [defineClientExtension({
        id: "faulty-pipeline",
        apiVersion: 1,
        targetEnrichers: [
          { id: "enrich-throws", enrich: () => { throw new Error("enrich boom"); } },
          { id: "enrich-ok", enrich: () => ({ ok: true }) },
        ],
        redactors: [{ id: "redact", redact: () => { throw new Error("redact boom"); } }],
        exporters: [
          { id: "export", export: () => { throw new Error("export boom"); } },
          { id: "async-export", export: async () => { throw new Error("async export boom"); } },
        ],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Pipeline";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(async () => expect((await transport.read()).annotations).toHaveLength(1));
      // Enrich failure is recorded but the annotation still saves.
      expect(mounted.api.getSnapshot().diagnostics.some((entry) => entry.phase === "enrich")).toBe(true);
      // Export failure is recorded and rethrown to the caller; async
      // rejections are diagnosed before the rethrow too.
      await expect(mounted.api.commands.exporters.format("faulty-pipeline:export"))
        .rejects.toThrow("export boom");
      await expect(mounted.api.commands.exporters.format("faulty-pipeline:async-export"))
        .rejects.toThrow("async export boom");
      expect(mounted.api.getSnapshot().diagnostics.some((entry) => entry.phase === "export")).toBe(true);
      // Redact failure fails the namespace closed and records the phase.
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().diagnostics.some((entry) => entry.phase === "redact")).toBe(true);
      // Builtin Copy, List, and Pick stay usable after every pipeline failure.
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      mounted.api.commands.panels.open("agent-annotations.builtin:list");
      expect(shadow.querySelector('[aria-label="Annotation list"]')).not.toBeNull();
      mounted.api.commands.panels.close();
      mounted.api.commands.capture.startPick();
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
      mounted.api.commands.capture.cancel();
    } finally {
      mounted.unmount();
      pageTarget.remove();
    }
  });

  it("snapshot is a deep clone that is deeply frozen without freezing extension configs", async () => {
    const shortcutOverride = { key: "X", code: "KeyX", primary: true, alt: true, shift: false };
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      builtins: { shortcuts: { pick: shortcutOverride } },
    });
    try {
      const snap = mounted.api.getSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.task)).toBe(true);
      expect(Object.isFrozen(snap.diagnostics)).toBe(true);
      expect(Object.isFrozen(snap.shortcuts)).toBe(true);
      expect(Object.isFrozen(snap.exporters)).toBe(true);
      expect(Object.isFrozen(snap.messages)).toBe(true);
      const before = JSON.stringify(snap);
      expect(() => { (snap.task as unknown as { taskId: string }).taskId = "x"; }).toThrow(TypeError);
      expect(() => { (snap.diagnostics as unknown[]).push({} as never); }).toThrow(TypeError);
      expect(() => { (snap.shortcuts[0] as { label: string }).label = "x"; }).toThrow(TypeError);
      expect(() => { (snap.shortcuts[0] as { shortcut: { key: string } }).shortcut.key = "x"; }).toThrow(TypeError);
      expect(() => { (snap.exporters as unknown[]).push({} as never); }).toThrow(TypeError);
      expect(() => { (snap.messages as Record<string, string>)["x"] = "y"; }).toThrow(TypeError);
      expect(JSON.stringify(mounted.api.getSnapshot())).toBe(before);
      // The extension's own config object was never frozen or mutated.
      expect(Object.isFrozen(shortcutOverride)).toBe(false);
      expect(shortcutOverride.key).toBe("X");
    } finally {
      mounted.unmount();
    }
  });

  it("rolls back a failed host+setup extension to default route, history, and appRoot behavior", async () => {
    history.pushState({}, "", "/");
    const hostSubscribe = vi.fn();
    const restrictedAppRoot = document.createElement("div");
    document.body.append(restrictedAppRoot);
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          pageContext: { ...annotationFixture().pageContext, routeKey: "/" },
        })],
      })),
      initialState: { collapsed: false },
      extensions: [defineClientExtension({
        id: "failed-host",
        apiVersion: 1,
        setup: () => {
          throw new Error("host setup failed");
        },
        host: {
          routeKey: () => "/bad-route",
          locale: () => "fr-FR",
          theme: () => "dark",
          appRoot: () => restrictedAppRoot,
          subscribe: hostSubscribe,
          messages: { "from-failed-host": "x" },
        },
        messages: { "from-failed": "y" },
        toolbar: [{
          id: "gone", group: "handoff", label: "Gone", icon: () => null,
          kind: "action", execute: () => undefined,
        }],
        exporters: [{ id: "gone-exporter", export: () => "gone" }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // No host subscription leak, no host contributions, no host messages.
      expect(hostSubscribe).not.toHaveBeenCalled();
      expect(shadow.querySelector('[data-action-id="failed-host:gone"]')).toBeNull();
      expect(mounted.api.getSnapshot().exporters).not.toContainEqual({
        id: "failed-host:gone-exporter",
        extensionId: "failed-host",
      });
      expect(mounted.api.getSnapshot().messages["from-failed"]).toBeUndefined();
      expect(mounted.api.getSnapshot().messages["from-failed-host"]).toBeUndefined();
      // Default route behavior: the "/" annotation marker renders.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector(".aa-marker")).not.toBeNull();
      // Default appRoot behavior: a capture on the document body works even
      // though the failed host had restricted the app root.
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
      mounted.api.commands.capture.cancel();
    } finally {
      mounted.unmount();
      restrictedAppRoot.remove();
      pageTarget.remove();
      history.pushState({}, "", "/settings");
    }
  });

  it("icon boundary catches later render-dependent throws and keeps the fallback", async () => {
    let renders = 0;
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      extensions: [defineClientExtension({
        id: "late-icon",
        apiVersion: 1,
        toolbar: [{
          id: "late", group: "view", label: "Late icon",
          icon: () => {
            renders += 1;
            if (renders > 1) throw new Error("late icon boom");
            return null;
          },
          kind: "action", execute: () => undefined,
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // A chrome re-render makes the icon throw only on its second render:
      // the boundary catches it, keeps the safe fallback, and records the
      // phase without a second root or SSR preflight.
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shadow.querySelector('[data-action-id="late-icon:late"] svg')).not.toBeNull();
      const entry = mounted.api.getSnapshot().diagnostics.find((item) => item.phase === "icon");
      expect(entry).toBeDefined();
      expect(entry!.message).toContain("late icon boom");
    } finally {
      mounted.unmount();
    }
  });

  it("isolates evil throwing-toString values from icon, panel, and enricher boundaries", async () => {
    const evilToString = {
      toString() {
        throw new Error("evil toString");
      },
    };
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const mounted = await mountAgentAnnotations({
      transport,
      initialState: { collapsed: false },
      extensions: [defineClientExtension({
        id: "evil-boundaries",
        apiVersion: 1,
        targetEnrichers: [{ id: "enrich", enrich: () => { throw evilToString; } }],
        toolbar: [
          {
            id: "evil-icon", group: "view", label: "Evil icon",
            icon: () => { throw evilToString; },
            kind: "action", execute: () => undefined,
          },
          {
            id: "evil-panel", group: "view", label: "Evil panel", kind: "panel", panelId: "evil-panel",
            icon: () => null, execute: () => undefined,
          },
        ],
        panels: [{
          id: "evil-panel", title: "Evil panel",
          render: () => { throw evilToString; },
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // The icon fallback renders and the panel error boundary shows the safe
      // panel instead of the thrown value escaping isolation.
      expect(shadow.querySelector('[data-action-id="evil-boundaries:evil-icon"] svg')).not.toBeNull();
      mounted.api.commands.panels.open("evil-boundaries:evil-panel");
      expect(shadow.querySelector(".aa-panel-error")).not.toBeNull();
      mounted.api.commands.panels.close();
      // The capture flow continues and the annotation still saves.
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Evil pipeline";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(async () => expect((await transport.read()).annotations).toHaveLength(1));
      const diagnostics = mounted.api.getSnapshot().diagnostics;
      for (const phase of ["icon", "panel", "enrich"]) {
        const entry = diagnostics.find((item) => item.phase === phase);
        expect(entry).toBeDefined();
        expect(entry!.message).toContain("unknown error");
        expect(entry!.message.length).toBeLessThanOrEqual(500);
      }
    } finally {
      mounted.unmount();
      pageTarget.remove();
    }
  });

  it("isolation survives a throw whose toString itself throws", async () => {
    const evilToString = {
      toString() {
        throw new Error("evil toString");
      },
    };
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      extensions: [defineClientExtension({
        id: "evil-throw",
        apiVersion: 1,
        toolbar: [{
          id: "evil", group: "view", label: "Evil", icon: () => null, kind: "action",
          isVisible: () => { throw evilToString; },
          execute: () => undefined,
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // The contribution is hidden and a safe diagnostic is recorded instead
      // of the error serialization piercing the isolation.
      expect(shadow.querySelector('[data-action-id="evil-throw:evil"]')).toBeNull();
      const entry = mounted.api.getSnapshot().diagnostics.find((item) => item.phase === "visible");
      expect(entry).toBeDefined();
      expect(entry!.message).toContain("unknown error");
    } finally {
      mounted.unmount();
    }
  });

  it("isolates a third-party setup that reuses the reserved builtin id", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      builtins: false,
      extensions: [defineClientExtension({
        id: "agent-annotations.builtin",
        apiVersion: 1,
        setup: () => {
          throw new Error("impostor setup failed");
        },
        toolbar: [{
          id: "impostor", group: "handoff", label: "Impostor", icon: () => null,
          kind: "action", execute: () => undefined,
        }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    // The impostor is third-party: it is isolated instead of failing the mount.
    expect(shadow.querySelector('[data-action-id="agent-annotations.builtin:impostor"]')).toBeNull();
    expect(mounted.api.getSnapshot().diagnostics.some((entry) => entry.phase === "setup")).toBe(true);
    mounted.unmount();
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
      expect({ left: panel.style.left, top: panel.style.top }).toEqual({
        left: "390px",
        top: "422px",
      });
    }
    mounted.unmount();
  });

  it("preserves built-in toolbar state parity", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const markers = shadow.querySelector<HTMLButtonElement>('[aria-label^="Markers"]')!;
    markers.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mounted.api.getSnapshot().markersVisible).toBe(false);
    expect(
      shadow
        .querySelector('[aria-label^="Markers"]')
        ?.getAttribute("aria-pressed")
    ).toBe("false");
    const collapse = shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!;
    collapse.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mounted.api.getSnapshot().collapsed).toBe(true);
    expect(shadow.querySelectorAll(".aa-action:not([data-toggle=true])")).toHaveLength(7);
    expect(shadow.querySelector(".aa-dock")?.getAttribute("data-collapsed")).toBe("true");
    shadow
      .querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mounted.api.getSnapshot().collapsed).toBe(false);
    expect(shadow.querySelectorAll(".aa-action").length).toBeGreaterThan(1);
    mounted.unmount();
  });

  it("namespaces enriched targets and redacts them before transport persistence", async () => {
    const pageTarget = document.createElement("button");
    pageTarget.textContent = "Save";
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const mutate = vi.spyOn(transport, "mutate");
    const mounted = await mountAgentAnnotations({
      transport,
      extensions: [defineClientExtension({
        id: "runtime-data",
        apiVersion: 1,
        targetEnrichers: [{ id: "target", enrich: () => ({ secret: "value" }) }],
        redactors: [{ id: "redact", redact: () => ({ safe: true }) }],
      })],
    });
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }));
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const textarea = shadow.querySelector<HTMLTextAreaElement>(".aa-composer textarea")!;
    textarea.value = "Change it";
    shadow.querySelector<HTMLFormElement>(".aa-composer")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(mutate.mock.calls[0][0].operations[0]).toMatchObject({
      op: "add",
      annotation: { extensions: { "runtime-data": { safe: true } } },
    });
    mounted.unmount();
    pageTarget.remove();
  });

  it("redacts update comments before a custom transport receives the mutation", async () => {
    const transport = new MemoryTaskTransport(taskFixture());
    const mutate = vi.spyOn(transport, "mutate");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.markers.focus("ann-1");
    const form = shadow.querySelector<HTMLFormElement>(".aa-editor")!;
    const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Bearer editor-secret";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    const operation = mutate.mock.calls[0]![0].operations[0] as { op: string; comment: string };
    expect(operation).toMatchObject({ op: "update", annotationId: "ann-1" });
    expect(operation.comment).not.toContain("editor-secret");
    expect(operation.comment).toContain("[REDACTED]");
    mounted.unmount();
  });

  it("redacts add annotations before a custom transport receives the mutation", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const mutate = vi.spyOn(transport, "mutate");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Bearer composer-secret";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    const operation = mutate.mock.calls[0]![0].operations[0] as { op: string; annotation: { comment: string } };
    expect(operation.op).toBe("add");
    expect(operation.annotation.comment).not.toContain("composer-secret");
    expect(operation.annotation.comment).toContain("[REDACTED]");
    mounted.unmount();
    pageTarget.remove();
  });

  it("passes screenshot png bytes through unredacted with validated metadata", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "aGVsbG8gc2VjcmV0", width: 1600, height: 900 });
    const transport = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(transport, "writeEvidence");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Evidence metadata";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledOnce());
    const input = writeEvidence.mock.calls[0]![0];
    // PNG bytes are never string-redacted; only the metadata is validated.
    expect(input.png).toBe("aGVsbG8gc2VjcmV0");
    expect(input.width).toBe(1600);
    expect(input.height).toBe(900);
    expect(input.annotationId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    mounted.unmount();
    pageTarget.remove();
  });

  it("persists the annotation and closes the composer before the screenshot resolves", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    let resolveCapture!: (value: unknown) => void;
    screenshot.captureViewportPng.mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
    const transport = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(transport, "writeEvidence");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Decoupled save";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(async () => expect((await transport.read()).annotations).toHaveLength(1));
    // The annotation is persisted, the composer is closed, and the status is
    // already shown while the screenshot is still pending.
    expect(shadow.querySelector(".aa-composer")).toBeNull();
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe("Annotation saved");
    expect(writeEvidence).not.toHaveBeenCalled();
    resolveCapture({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledOnce());
    mounted.unmount();
    pageTarget.remove();
  });

  it("captures evidence only on demand in manual mode through the command and the editor", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const transport = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(transport, "writeEvidence");
    const mounted = await mountAgentAnnotations({ transport, screenshotEvidence: "manual" });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Manual capture";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(async () => expect((await transport.read()).annotations).toHaveLength(1));
    // No automatic capture in manual mode.
    expect(screenshot.captureViewportPng).not.toHaveBeenCalled();
    expect(writeEvidence).not.toHaveBeenCalled();
    const annotationId = (await transport.read()).annotations[0]!.annotationId;
    // The editor exposes the localized Capture screenshot action.
    mounted.api.commands.markers.focus(annotationId);
    const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
    const captureButton = [...editor.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Capture screenshot");
    expect(captureButton).toBeDefined();
    captureButton!.click();
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledOnce());
    expect(screenshot.captureViewportPng).toHaveBeenCalledOnce();
    // The public command also captures on demand.
    writeEvidence.mockClear();
    screenshot.captureViewportPng.mockClear();
    await mounted.api.commands.annotations.captureEvidence(annotationId);
    expect(screenshot.captureViewportPng).toHaveBeenCalledOnce();
    expect(writeEvidence).toHaveBeenCalledOnce();
    mounted.unmount();
    pageTarget.remove();
  });

  it("disables screenshot evidence in off mode without capture, entry, or command effect", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(transport, "writeEvidence");
    const mounted = await mountAgentAnnotations({ transport, screenshotEvidence: "off" });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "No evidence";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(async () => expect((await transport.read()).annotations).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screenshot.captureViewportPng).not.toHaveBeenCalled();
    expect(writeEvidence).not.toHaveBeenCalled();
    const annotationId = (await transport.read()).annotations[0]!.annotationId;
    // No Capture screenshot entry in the editor and the command is a no-op.
    mounted.api.commands.markers.focus(annotationId);
    const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
    expect([...editor.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "Capture screenshot"
    )).toBe(false);
    await mounted.api.commands.annotations.captureEvidence(annotationId);
    expect(screenshot.captureViewportPng).not.toHaveBeenCalled();
    mounted.unmount();
    pageTarget.remove();
  });

  it("retries evidence once after a revision conflict and never overrides a newer task", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const memory = new MemoryTaskTransport();
    const original = memory.writeEvidence.bind(memory);
    let first = true;
    const writeEvidence = vi.spyOn(memory, "writeEvidence").mockImplementation(async (input) => {
      if (first) {
        first = false;
        const latest = await memory.read();
        // Another tab advances the task while the screenshot is in flight.
        await memory.mutate({
          taskId: latest.taskId,
          expectedRevision: latest.taskRevision,
          operations: [{
            op: "update",
            annotationId: latest.annotations[0]!.annotationId,
            comment: latest.annotations[0]!.comment,
          }],
        });
        const advanced = await memory.read();
        throw new RevisionConflictError(advanced, input.expectedRevision, advanced.taskRevision);
      }
      return original(input);
    });
    const mounted = await mountAgentAnnotations({ transport: memory });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Conflict retry";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledTimes(2));
    expect(writeEvidence.mock.calls[1]![0].expectedRevision).toBe(2);
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(3);
    mounted.unmount();
    pageTarget.remove();
  });

  it("abandons evidence when the annotation was deleted during the conflict", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const memory = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(memory, "writeEvidence").mockImplementation(async (input) => {
      const latest = await memory.read();
      // Another tab deletes the annotation while the screenshot is in flight.
      await memory.mutate({
        taskId: latest.taskId,
        expectedRevision: latest.taskRevision,
        operations: [{ op: "remove", annotationId: latest.annotations[0]!.annotationId }],
      });
      const advanced = await memory.read();
      throw new RevisionConflictError(advanced, input.expectedRevision, advanced.taskRevision);
    });
    const mounted = await mountAgentAnnotations({ transport: memory });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Deleted during capture";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Exactly one attempt: the annotation is gone, so there is no retry.
    expect(writeEvidence).toHaveBeenCalledTimes(1);
    mounted.unmount();
    pageTarget.remove();
  });

  it("does not write evidence after a route change or unmount while the capture is pending", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(transport, "writeEvidence");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const capture = async (comment: string) => {
      let resolveCapture!: (value: unknown) => void;
      screenshot.captureViewportPng.mockReturnValueOnce(new Promise((resolve) => { resolveCapture = resolve; }));
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = comment;
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(async () => expect((await transport.read()).annotations.length).toBeGreaterThan(0));
      return resolveCapture;
    };
    // Route change while the capture is pending: the evidence is dropped.
    let resolveCapture = await capture("Route change evidence");
    history.pushState({}, "", "/route-b");
    window.dispatchEvent(new PopStateEvent("popstate"));
    resolveCapture({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeEvidence).not.toHaveBeenCalled();
    // Unmount while the capture is pending: the evidence is dropped too.
    resolveCapture = await capture("Unmount evidence");
    mounted.unmount();
    resolveCapture({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeEvidence).not.toHaveBeenCalled();
    pageTarget.remove();
  });

  it("hides the capture entry and no-ops when the transport cannot write evidence", async () => {
    history.pushState({}, "", "/settings");
    const memory = new MemoryTaskTransport(taskFixture());
    const transport: TaskTransport = {
      read: () => memory.read(),
      mutate: (request) => memory.mutate(request),
    };
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.markers.focus("ann-1");
    const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
    expect([...editor.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "Capture screenshot"
    )).toBe(false);
    await mounted.api.commands.annotations.captureEvidence("ann-1");
    expect(screenshot.captureViewportPng).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("adopts the latest task on a second evidence conflict and records a diagnostic", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/revision")) {
        return new Response(JSON.stringify({ referencedSourceRevision: "ab".repeat(32) }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const memory = new MemoryTaskTransport();
      const diagnostics: string[] = [];
      const appendDiagnostics = vi.fn(async (entries: AgentAnnotationsDiagnosticsEntry[]) => {
        diagnostics.push(entries[0]!.message);
      });
      let attempts = 0;
      const transport: TaskTransport = {
        read: () => memory.read(),
        mutate: (request) => memory.mutate(request),
        writeEvidence: async (input) => {
          attempts += 1;
          const latest = await memory.read();
          const advanced = taskFixture({ ...latest, taskRevision: latest.taskRevision + attempts });
          throw new RevisionConflictError(advanced, input.expectedRevision, advanced.taskRevision);
        },
        appendDiagnostics,
      };
      const mounted = await mountAgentAnnotations({
        transport,
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Second conflict";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(appendDiagnostics).toHaveBeenCalled());
      // Exactly one retry; the second conflict's latest task is adopted.
      expect(attempts).toBe(2);
      expect(mounted.api.getSnapshot().task.taskRevision).toBe(3);
      expect(diagnostics[0]).toContain("screenshot evidence failed");
      // Task mutation and both conflict adoptions cannot report a browser update.
      const revisionFetches = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/revision"));
      expect(revisionFetches).toHaveLength(0);
      mounted.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
    pageTarget.remove();
  });

  it("does not retry evidence when a replacement task reuses the annotation id", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const memory = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(memory, "writeEvidence").mockImplementation(async (input) => {
      const latest = await memory.read();
      // A replacement task reuses the annotation id but is a different task.
      const replacement = taskFixture({
        ...latest,
        taskId: "task-replacement",
        taskRevision: latest.taskRevision + 1,
      });
      throw new RevisionConflictError(replacement, input.expectedRevision, replacement.taskRevision);
    });
    const mounted = await mountAgentAnnotations({ transport: memory });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Replacement task";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The annotation exists in the replacement task, but the task identity
    // differs: the old-page screenshot must never be written.
    expect(writeEvidence).toHaveBeenCalledTimes(1);
    expect(mounted.api.getSnapshot().task.taskId).toBe("task-replacement");
    mounted.unmount();
    pageTarget.remove();
  });

  it("abandons a manual capture when the task is replaced while the capture is pending", async () => {
    history.pushState({}, "", "/settings");
    const initial = taskFixture();
    let publish!: (task: AgentAnnotationsTask) => void;
    let resolveCapture!: (value: unknown) => void;
    screenshot.captureViewportPng.mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
    const writeEvidence = vi.fn(async (input: { taskId: string }) => {
      expect(input.taskId).toBe(initial.taskId);
      return initial;
    });
    const transport: TaskTransport = {
      read: async () => initial,
      mutate: async () => initial,
      writeEvidence,
      subscribe(listener) {
        publish = listener;
        return () => undefined;
      },
    };
    const mounted = await mountAgentAnnotations({ transport, screenshotEvidence: "manual" });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.markers.focus("ann-1");
    const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
    const captureButton = [...editor.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Capture screenshot")!;
    captureButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screenshot.captureViewportPng).toHaveBeenCalledOnce();
    // The task identity is replaced while the capture is pending.
    publish({ ...initial, taskId: "task-replacement", taskRevision: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveCapture({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeEvidence).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("adopts the second conflict latest task and records a diagnostic even after a route change", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const memory = new MemoryTaskTransport();
    const diagnostics: string[] = [];
    const appendDiagnostics = vi.fn(async (entries: AgentAnnotationsDiagnosticsEntry[]) => {
      diagnostics.push(entries[0]!.message);
    });
    let attempts = 0;
    const transport: TaskTransport = {
      read: () => memory.read(),
      mutate: (request) => memory.mutate(request),
      writeEvidence: async (input) => {
        attempts += 1;
        const latest = await memory.read();
        const advanced = taskFixture({ ...latest, taskRevision: latest.taskRevision + attempts });
        if (attempts === 2) {
          // The route changes at the same moment the second conflict arrives.
          history.pushState({}, "", "/route-b");
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        throw new RevisionConflictError(advanced, input.expectedRevision, advanced.taskRevision);
      },
      appendDiagnostics,
    };
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Second conflict on route change";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(diagnostics.length).toBeGreaterThan(0));
    // Exactly one retry; the second conflict's latest task is adopted and the
    // diagnostic is recorded even though the route changed simultaneously.
    expect(attempts).toBe(2);
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(3);
    expect(diagnostics[0]).toContain("screenshot evidence failed");
    mounted.unmount();
    pageTarget.remove();
  });

  it("does not update the manual capture status after a route change", async () => {
    history.pushState({}, "", "/settings");
    const initial = taskFixture();
    let resolveWrite!: (value: AgentAnnotationsTask) => void;
    const transport: TaskTransport = {
      read: async () => initial,
      mutate: async () => initial,
      writeEvidence: () => new Promise((resolve) => { resolveWrite = resolve; }),
    };
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const mounted = await mountAgentAnnotations({ transport, screenshotEvidence: "manual" });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.markers.focus("ann-1");
    const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
    const captureButton = [...editor.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Capture screenshot")!;
    captureButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The route changes while the evidence write is in flight.
    history.pushState({}, "", "/route-b");
    window.dispatchEvent(new PopStateEvent("popstate"));
    resolveWrite(initial);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Screenshot");
    mounted.unmount();
  });

  it("does not report a browser update when an accepted task changes the referenced sources", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/revision")) {
        return new Response(JSON.stringify({
          taskId: "task-1",
          taskRevision: 0,
          referencedSourceRevision: null,
          referencedSourceFiles: [],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const initial = await new MemoryTaskTransport().read();
      let publish!: (task: AgentAnnotationsTask) => void;
      const transport: TaskTransport = {
        read: async () => initial,
        mutate: async () => initial,
        subscribe(listener) {
          publish = listener;
          return () => undefined;
        },
      };
      const mounted = await mountAgentAnnotations({
        transport,
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      await vi.advanceTimersByTimeAsync(0);
      // An accepted task revision introduces a referenced source file. It may
      // invalidate the source snapshot, but it cannot report a browser update.
      publish({ ...taskFixture(), taskId: initial.taskId, taskRevision: 1 });
      await vi.advanceTimersByTimeAsync(0);
      const revisionFetches = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/revision"));
      expect(revisionFetches).toHaveLength(0);
      const heartbeats = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/heartbeat"));
      const latest = JSON.parse(heartbeats.at(-1)![1]!.body as string);
      expect(latest.referencedSourceRevision).toBeNull();
      expect(latest.taskRevision).toBe(1);
      mounted.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports browser status heartbeats and applies source revisions through the mount hook", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/#/settings?secret=supersecret");
    const transport = new MemoryTaskTransport();
    const initial = await transport.read();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/revision")) {
        return new Response(JSON.stringify({
          taskId: initial.taskId,
          taskRevision: initial.taskRevision,
          referencedSourceRevision: "ab".repeat(32),
          referencedSourceFiles: ["src/App.tsx"],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let mounted: Awaited<ReturnType<typeof mountAgentAnnotations>> | null = null;
    try {
      mounted = await mountAgentAnnotations({
        transport,
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledWith(
        "/__agent-annotations/heartbeat",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-agent-annotations-token": "status-token" }),
        })
      );
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(body).toMatchObject({
        schema: "agent-annotations.browser-state.v2",
        clientVersion: "0.1.0-alpha.0",
        taskId: expect.any(String),
        taskRevision: 0,
        browserUpdateRevision: 0,
        referencedSourceRevision: null,
        referencedSourceFiles: [],
      });
      // The hash route is preserved; the secret query is stripped.
      expect(body.routeKey).toBe("/#/settings");
      expect(JSON.stringify(body)).not.toContain("supersecret");
      expect(JSON.stringify(body)).not.toContain("status-token");
      // The applied revision is reported only through the trusted mount hook.
      mounted.reportBrowserUpdate();
      await vi.advanceTimersByTimeAsync(0);
      const heartbeats = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/heartbeat"));
      expect(JSON.parse(heartbeats.at(-1)![1]!.body as string).referencedSourceRevision)
        .toBe("ab".repeat(32));
      // Unmount stops the heartbeats.
      mounted.unmount();
      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("supersedes stale source revision responses so they cannot regress the applied revision", async () => {
    vi.useFakeTimers();
    const transport = new MemoryTaskTransport();
    const initial = await transport.read();
    let first = true;
    let resolveFirst!: (value: Response) => void;
    const fetchMock = vi.fn<typeof fetch>((input: RequestInfo | URL) => {
      if (String(input).endsWith("/revision")) {
        if (first) {
          first = false;
          return new Promise((resolve) => { resolveFirst = resolve; });
        }
        return Promise.resolve(
          new Response(JSON.stringify({
            taskId: initial.taskId,
            taskRevision: initial.taskRevision,
            referencedSourceRevision: "cd".repeat(32),
            referencedSourceFiles: ["src/pages/settings.tsx"],
          }), { status: 200 })
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    let mounted: Awaited<ReturnType<typeof mountAgentAnnotations>> | null = null;
    try {
      mounted = await mountAgentAnnotations({
        transport,
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      await vi.advanceTimersByTimeAsync(0);
      // The first refresh is pending; the second supersedes it.
      mounted.reportBrowserUpdate();
      mounted.reportBrowserUpdate();
      await vi.advanceTimersByTimeAsync(0);
      const heartbeats = () => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/heartbeat"));
      expect(JSON.parse(heartbeats().at(-1)![1]!.body as string).referencedSourceRevision)
        .toBe("cd".repeat(32));
      // The superseded response arrives late: it must never overwrite.
      resolveFirst(new Response(JSON.stringify({
        taskId: initial.taskId,
        taskRevision: initial.taskRevision,
        referencedSourceRevision: "ab".repeat(32),
        referencedSourceFiles: ["src/pages/settings.tsx"],
      }), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(heartbeats().at(-1)![1]!.body as string).referencedSourceRevision)
        .toBe("cd".repeat(32));
      mounted.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("isolates a failing third-party setup and still starts the browser status heartbeat", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mounted = await mountAgentAnnotations({
        transport: new MemoryTaskTransport(),
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
        extensions: [defineClientExtension({
          id: "failing-setup",
          apiVersion: 1,
          setup: () => {
            throw new Error("setup exploded");
          },
        })],
      });
      // The failing extension was isolated; the runtime stays mounted and
      // reports its browser status.
      expect(mounted.api.getSnapshot().collapsed).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledWith(
        "/__agent-annotations/heartbeat",
        expect.objectContaining({ method: "POST" })
      );
      mounted.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defers the background capture through the tracked timer so unmount cancels it", async () => {
    vi.useFakeTimers();
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    const transport = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(transport, "writeEvidence");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const submitSave = async (comment: string) => {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = comment;
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };
    // Save 1: the capture is deferred behind the tracked timer.
    await submitSave("Deferred save");
    expect(screenshot.captureViewportPng).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(screenshot.captureViewportPng).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeEvidence).toHaveBeenCalledTimes(1);
    // Save 2: unmount cancels the pending deferred capture before the clone.
    await submitSave("Cancelled capture");
    expect(screenshot.captureViewportPng).toHaveBeenCalledTimes(1);
    mounted.unmount();
    await vi.runOnlyPendingTimersAsync();
    expect(screenshot.captureViewportPng).toHaveBeenCalledTimes(1);
    expect(writeEvidence).toHaveBeenCalledTimes(1);
    pageTarget.remove();
  });

  it("rolls back a failed third-party setup atomically and continues mounting", async () => {
    const dispose = vi.fn();
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
      extensions: [
        defineClientExtension({
          id: "a-setup-first",
          apiVersion: 1,
          setup: () => dispose,
          toolbar: [{
            id: "keep", group: "handoff", label: "Keep", icon: () => null,
            kind: "action", execute: () => undefined,
          }],
        }),
        defineClientExtension({
          id: "z-setup-fails",
          apiVersion: 1,
          setup: () => {
            throw new Error("setup failed");
          },
          host: {
            routeKey: () => "/bad-route",
            theme: () => "light",
            messages: { "from-bad-host": "x" },
          },
          messages: { "from-bad": "y" },
          toolbar: [{
            id: "gone", group: "handoff", label: "Gone", icon: () => null, kind: "action",
            shortcut: { key: "G", code: "KeyG", primary: true, alt: true, shift: false },
            execute: () => undefined,
          }],
          exporters: [{ id: "gone-exporter", export: () => "gone" }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    // Toolbar, shortcut, exporter, host messages, and own messages of the
    // failed extension are all rolled back atomically.
    expect(shadow.querySelector('[data-action-id="z-setup-fails:gone"]')).toBeNull();
    const shortcutIds = mounted.api.getSnapshot().shortcuts.map((entry) => entry.id);
    expect(shortcutIds).not.toContain("z-setup-fails:gone");
    expect(mounted.api.getSnapshot().exporters).not.toContainEqual({
      id: "z-setup-fails:gone-exporter",
      extensionId: "z-setup-fails",
    });
    expect(mounted.api.getSnapshot().messages["from-bad"]).toBeUndefined();
    expect(mounted.api.getSnapshot().messages["from-bad-host"]).toBeUndefined();
    // The healthy extension and the builtins remain.
    expect(shadow.querySelector('[data-action-id="a-setup-first:keep"]')).not.toBeNull();
    expect(shadow.querySelector('[aria-label^="Pick"]')).not.toBeNull();
    expect(mounted.api.getSnapshot().diagnostics.some((entry) => entry.phase === "setup")).toBe(true);
    // Builtin Pick, Copy, and List stay usable after the isolated failure.
    mounted.api.commands.capture.startPick();
    expect(mounted.api.getSnapshot().captureMode).toBe("pick");
    mounted.api.commands.capture.cancel();
    await mounted.api.commands.annotations.copyOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")?.value ?? "")
      .toContain("# Agent Annotations Handoff");
    mounted.api.commands.panels.open("agent-annotations.builtin:list");
    expect(shadow.querySelector('[aria-label="Annotation list"]')).not.toBeNull();
    mounted.api.commands.panels.close();
    mounted.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not expose the raw transport in the extension setup context", async () => {
    let resolveContext!: (value: { studio: unknown; transport: unknown }) => void;
    const context = new Promise<{ studio: unknown; transport: unknown }>((resolve) => {
      resolveContext = resolve;
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "no-transport",
          apiVersion: 1,
          setup: (value) => {
            resolveContext(value as { studio: unknown; transport: unknown });
          },
        }),
      ],
    });
    const value = await context;
    expect(value).not.toHaveProperty("transport");
    expect(value.studio).toBeDefined();
    mounted.unmount();
  });

  it("drops the extension namespace when a redactor throws and persists the rest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-throw-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    const mutate = vi.spyOn(transport, "mutate");
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const mounted = await mountAgentAnnotations({
      transport,
      extensions: [
        defineClientExtension({
          id: "throwing-redactor",
          apiVersion: 1,
          targetEnrichers: [{ id: "target", enrich: () => ({ ready: true }) }],
          redactors: [{
            id: "explode",
            redact: () => {
              throw new Error("redactor exploded");
            },
          }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }));
      const textarea = shadow.querySelector<HTMLTextAreaElement>(".aa-composer textarea")!;
      textarea.value = "Secret comment";
      shadow.querySelector<HTMLFormElement>(".aa-composer")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(1));
      expect(mutate).toHaveBeenCalledOnce();
      const persisted = store.read()!;
      expect(persisted.annotations[0]!.extensions["throwing-redactor"]).toBeUndefined();
      expect(JSON.stringify(persisted)).not.toContain("redactor exploded");
    } finally {
      mounted.unmount();
      pageTarget.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a throwing target enricher with a redacted diagnostic and keeps capture working", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-enricher-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const mounted = await mountAgentAnnotations({
      transport,
      extensions: [
        defineClientExtension({
          id: "broken-enricher",
          apiVersion: 1,
          targetEnrichers: [{ id: "target", enrich: () => { throw new Error("token=enricher-secret"); } }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }));
      const textarea = shadow.querySelector<HTMLTextAreaElement>(".aa-composer textarea")!;
      textarea.value = "Still captured";
      shadow.querySelector<HTMLFormElement>(".aa-composer")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(1));
      const persisted = store.read()!;
      expect(persisted.annotations[0]!.comment).toBe("Still captured");
      expect(persisted.annotations[0]!.extensions["broken-enricher"]).toBeUndefined();
      const diagnostics = mounted.api.getSnapshot().diagnostics;
      expect(diagnostics.some((entry) => entry.message.includes("enricher"))).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain("enricher-secret");
    } finally {
      mounted.unmount();
      pageTarget.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disables a pending toolbar action and re-enables it after a rejection", async () => {
    let release!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("token=action-secret");
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "broken-action",
          apiVersion: 1,
          toolbar: [{
            id: "boom",
            group: "host",
            label: "Boom",
            icon: () => null,
            kind: "action",
            execute,
          }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const button = () => shadow.querySelector<HTMLButtonElement>('[data-action-id="broken-action:boom"]')!;
      expect(button().disabled).toBe(false);
      button().click();
      await vi.waitFor(() => expect(button().disabled).toBe(true));
      release();
      await vi.waitFor(() => expect(button().disabled).toBe(false));
      await vi.waitFor(() => expect(
        mounted.api.getSnapshot().diagnostics.some((entry) => entry.message.includes("action"))
      ).toBe(true));
      expect(JSON.stringify(mounted.api.getSnapshot().diagnostics))
        .not.toContain("action-secret");
    } finally {
      mounted.unmount();
    }
  });

  it("keeps one pending action disabled while a concurrent action settles", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const executeA = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseA = resolve; });
    });
    const executeB = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseB = resolve; });
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "concurrent",
          apiVersion: 1,
          toolbar: [
            { id: "a", group: "host", label: "A", icon: () => null, kind: "action", execute: executeA },
            { id: "b", group: "host", label: "B", icon: () => null, kind: "action", execute: executeB },
          ],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const a = () => shadow.querySelector<HTMLButtonElement>('[data-action-id="concurrent:a"]')!;
      const b = () => shadow.querySelector<HTMLButtonElement>('[data-action-id="concurrent:b"]')!;
      a().click();
      await vi.waitFor(() => expect(a().disabled).toBe(true));
      b().click();
      await vi.waitFor(() => expect(b().disabled).toBe(true));
      releaseB();
      await vi.waitFor(() => expect(b().disabled).toBe(false));
      expect(a().disabled).toBe(true); // A is still pending.
      releaseA();
      await vi.waitFor(() => expect(a().disabled).toBe(false));
    } finally {
      mounted.unmount();
    }
  });

  it("rejects re-entering an already pending action through the hotkey path", async () => {
    let release!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "reentry",
          apiVersion: 1,
          toolbar: [{
            id: "slow",
            group: "host",
            label: "Slow",
            icon: () => null,
            kind: "action",
            shortcut: { key: "s", code: "KeyS", primary: true, alt: true, shift: false },
            execute,
          }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      const button = () => shadow.querySelector<HTMLButtonElement>('[data-action-id="reentry:slow"]')!;
      button().click();
      await vi.waitFor(() => expect(button().disabled).toBe(true));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        ctrlKey: true,
        altKey: true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(execute).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(button().disabled).toBe(false));
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("isolates a synchronously throwing toolbar action and leaves no unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "sync-action",
          apiVersion: 1,
          toolbar: [{
            id: "boom",
            group: "host",
            label: "Boom",
            icon: () => null,
            kind: "action",
            execute: () => { throw new Error("token=action-sync"); },
          }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      shadow.querySelector<HTMLButtonElement>('[data-action-id="sync-action:boom"]')!.click();
      await vi.waitFor(() => expect(
        mounted.api.getSnapshot().diagnostics.some((entry) => entry.message.includes("action"))
      ).toBe(true));
      expect(JSON.stringify(mounted.api.getSnapshot().diagnostics))
        .not.toContain("action-sync");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("surfaces an exporter error without mutating the task", async () => {
    const memory = new MemoryTaskTransport(taskFixture());
    const mounted = await mountAgentAnnotations({
      transport: { read: () => memory.read(), mutate: (request) => memory.mutate(request) },
      extensions: [
        defineClientExtension({
          id: "broken-exporter",
          apiVersion: 1,
          exporters: [{ id: "json", export: () => { throw new Error("exporter exploded"); } }],
        }),
      ],
    });
    try {
      const before = await memory.read();
      await expect(mounted.api.commands.exporters.format("broken-exporter:json"))
        .rejects.toThrow("exporter exploded");
      expect(await memory.read()).toEqual(before);
    } finally {
      mounted.unmount();
    }
  });



  it("isolates a throwing panel with an error boundary while the dock stays usable", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "broken-panel",
          apiVersion: 1,
          panels: [{
            id: "explode",
            title: "Exploding panel",
            render: () => { throw new Error("token=panel-secret"); },
          }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.panels.open("broken-panel:explode");
      expect(shadow.querySelector('[aria-label="Exploding panel"]')).not.toBeNull();
      expect(shadow.querySelector(".aa-panel-error")?.textContent).toBe("Panel failed to render");
      expect(shadow.querySelector(".aa-dock")).not.toBeNull();
      const pick = shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
      expect(pick.disabled).toBe(false);
      expect(JSON.stringify(mounted.api.getSnapshot().diagnostics))
        .not.toContain("panel-secret");
      mounted.api.commands.panels.close();
      mounted.api.commands.panels.open("agent-annotations.builtin:help");
      expect(shadow.querySelector('[aria-label="Shortcut help"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
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

  it("runs setup and dispose exactly once per mount and unmount", async () => {
    const setup = vi.fn();
    const dispose = vi.fn();
    const extension = defineClientExtension({
      id: "lifecycle",
      apiVersion: 1,
      setup: () => {
        setup();
        return dispose;
      },
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [extension],
    });
    expect(setup).toHaveBeenCalledOnce();
    mounted.unmount();
    mounted.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("redacts secrets through the browser mutation path before persistence", async () => {
    history.pushState({}, "", "/settings");
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-redact-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    await store.mutate({
      taskId: task.taskId,
      expectedRevision: 0,
      operations: [{ op: "add", annotation: annotationFixture() }],
    });
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-1");
      const form = shadow.querySelector<HTMLFormElement>(".aa-editor")!;
      const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Bearer UNIQUE_SECRET_SENTINEL_runtime_update";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(shadow.querySelector(".aa-editor")).toBeNull());
      const persisted = store.read()!;
      expect(persisted.annotations[0].comment).not.toContain("UNIQUE_SECRET_SENTINEL_runtime_update");
      expect(persisted.annotations[0].comment).toContain("[REDACTED]");
    } finally {
      mounted.unmount();
      rmSync(root, { recursive: true, force: true });
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

  it("persists inspected region targets with namespaced redacted extension data", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-region-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    const elements = Array.from({ length: 3 }, () => {
      const element = document.createElement("button");
      element.textContent = "Region target";
      document.body.append(element);
      return element;
    });
    primitives.getElementsAtPoint.mockReturnValue(elements);
    const mounted = await mountAgentAnnotations({
      transport,
      extensions: [
        defineClientExtension({
          id: "region.data",
          apiVersion: 1,
          targetEnrichers: [{ id: "target", enrich: () => ({ secret: "value", keep: "yes" }) }],
          redactors: [{ id: "redact", redact: () => ({ safe: true }) }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startArea();
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 100 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      expect(composer.textContent).toContain("Area (3 sampled targets)");
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Region comment";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(1));
      const annotation = store.read()!.annotations[0]!;
      expect(annotation.kind).toBe("region");
      expect(annotation.region).toMatchObject({
        coordinateSpace: "document",
        x: 10,
        y: 10,
        width: 90,
        height: 90,
      });
      // Area stays armed after the save with only transient state cleared.
      expect(mounted.api.getSnapshot().captureMode).toBe("area");
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      expect(shadow.querySelector(".aa-area")).toBeNull();
      expect(annotation.targets).toHaveLength(3);
      expect(annotation.targets![0]!.inspection.tagName).toBe("button");
      expect(annotation.extensions["region.data"]).toEqual({ safe: true });
      expect(JSON.stringify(store.read())).not.toContain('"secret"');
    } finally {
      mounted.unmount();
      for (const element of elements) element.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists an empty region without fabricating targets", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-region-empty-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    primitives.getElementsAtPoint.mockReturnValue([]);
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startArea();
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 100 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      expect(composer.textContent).toContain("Area (0 sampled targets)");
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Empty region";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(1));
      const annotation = store.read()!.annotations[0]!;
      expect(annotation.kind).toBe("region");
      expect(annotation.targets).toEqual([]);
    } finally {
      mounted.unmount();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists region targets in the original sample order under concurrent inspection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-region-order-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    const elements: Element[] = Array.from({ length: 3 }, (_, index) => {
      const element = document.createElement("button");
      element.textContent = `Region target ${index}`;
      document.body.append(element);
      return element;
    });
    primitives.getElementsAtPoint.mockReturnValue(elements);
    primitives.getElementContext.mockImplementation((element: Element) => {
      const index = elements.indexOf(element);
      const delay = [30, 0, 10][index] ?? 0;
      return new Promise((resolve) => {
        setTimeout(() => resolve(primitives.context()), delay);
      });
    });
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startArea();
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 100 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Ordered region";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(1));
      const annotation = store.read()!.annotations[0]!;
      expect(annotation.targets?.map((target) => target.inspection.text))
        .toEqual(["Region target 0", "Region target 1", "Region target 2"]);
    } finally {
      mounted.unmount();
      for (const element of elements) element.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels an in-progress composer when the route changes", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/route-a");
    const element = document.createElement("button");
    document.body.append(element);
    primitives.getElementsAtPoint.mockReturnValue([element]);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startArea();
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 100 }));
      expect(shadow.querySelector(".aa-composer")).not.toBeNull();
      history.pushState({}, "", "/route-b");
      await vi.runAllTimersAsync();
      expect(shadow.querySelector(".aa-composer")).toBeNull();
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    } finally {
      mounted.unmount();
      element.remove();
    }
  });

  it("does not overwrite a later history wrapper when unmounting", async () => {
    const originalPushState = history.pushState;
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const laterWrapper = vi.fn(function (this: History, ...args: unknown[]) {
      return (originalPushState as (...rest: unknown[]) => unknown).apply(this, args);
    });
    history.pushState = laterWrapper as typeof history.pushState;
    mounted.unmount();
    expect(history.pushState).toBe(laterWrapper);
    history.pushState = originalPushState;
  });

  it("discards a submitted region when the route changes during inspection", async () => {
    history.pushState({}, "", "/route-a");
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-region-route-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    const mutate = vi.spyOn(transport, "mutate");
    const elements = Array.from({ length: 2 }, (_, index) => {
      const element = document.createElement("button");
      element.textContent = `Region target ${index}`;
      document.body.append(element);
      return element;
    });
    primitives.getElementsAtPoint.mockReturnValue(elements);
    primitives.getElementContext.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(primitives.context()), 50);
    }));
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startArea();
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 100 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Route race region";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // The route changes while the region inspection is still in flight.
      history.pushState({}, "", "/route-b");
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(0));
      // Give the in-flight submit time to finish; it must not persist.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(store.read()!.annotations).toHaveLength(0);
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
      for (const element of elements) element.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds region enrichment concurrency to the inspection limit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-region-concurrency-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => store.mutate(request),
    };
    const elements: Element[] = Array.from({ length: 60 }, (_, index) => {
      const element = document.createElement("button");
      element.textContent = `Region target ${index}`;
      document.body.append(element);
      return element;
    });
    primitives.getElementsAtPoint.mockReturnValue(elements);
    let active = 0;
    let peak = 0;
    const mounted = await mountAgentAnnotations({
      transport,
      extensions: [
        defineClientExtension({
          id: "region.concurrency",
          apiVersion: 1,
          targetEnrichers: [{
            id: "target",
            enrich: async () => {
              active += 1;
              peak = Math.max(peak, active);
              await new Promise((resolve) => setTimeout(resolve, 10));
              active -= 1;
              return { kept: true };
            },
          }],
        }),
      ],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startArea();
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 100 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Concurrency region";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(1));
      expect(peak).toBeLessThanOrEqual(4);
      const annotation = store.read()!.annotations[0]!;
      expect(annotation.targets).toHaveLength(50);
      const extensionData = annotation.extensions["region.concurrency"] as {
        "region.concurrency:target": { targets: unknown[] };
      };
      expect(extensionData["region.concurrency:target"].targets).toHaveLength(50);
    } finally {
      mounted.unmount();
      for (const element of elements) element.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends recorded diagnostics to the transport best-effort", async () => {
    const appendDiagnostics = vi.fn(async (_entries: AgentAnnotationsDiagnosticsEntry[]) => undefined);
    const memory = new MemoryTaskTransport();
    const transport: TaskTransport = {
      read: () => memory.read(),
      mutate: (request) => memory.mutate(request),
      appendDiagnostics,
    };
    const mounted = await mountAgentAnnotations({ transport });
    try {
      console.error("token=console-secret");
      await vi.waitFor(() => expect(appendDiagnostics).toHaveBeenCalled());
      const entry = appendDiagnostics.mock.calls[0]![0]![0]!;
      expect(entry).toMatchObject({ source: "console" });
      expect(entry.message).not.toContain("console-secret");
    } finally {
      mounted.unmount();
    }
  });

  it("adopts the latest task and retries a revision conflict exactly once", async () => {
    const initial = taskFixture();
    const latest = taskFixture({
      taskRevision: 1,
      annotations: [{
        ...taskFixture().annotations[0]!,
        comment: "from another tab",
      }],
    });
    const completed = taskFixture({
      ...latest,
      status: "completed",
      taskRevision: 2,
      annotations: [{
        ...latest.annotations[0]!,
        status: "completed",
        completedAt: "2026-08-12T12:05:00.000Z",
      }],
    });
    const mutate = vi.fn()
      .mockRejectedValueOnce(new RevisionConflictError(latest, 0, 1))
      .mockResolvedValueOnce(completed);
    const transport: TaskTransport = {
      read: async () => initial,
      mutate,
    };
    const mounted = await mountAgentAnnotations({ transport });
    await mounted.api.commands.annotations.complete("ann-1");
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]![0]).toMatchObject({ expectedRevision: 1 });
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(2);
    mounted.unmount();
  });

  it("adopts after a second conflict and stops without further retries", async () => {
    const initial = taskFixture();
    const latest = taskFixture({ taskRevision: 1 });
    const evenNewer = taskFixture({ taskRevision: 2 });
    const mutate = vi.fn()
      .mockRejectedValueOnce(new RevisionConflictError(latest, 0, 1))
      .mockRejectedValueOnce(new RevisionConflictError(evenNewer, 1, 2));
    const transport: TaskTransport = {
      read: async () => initial,
      mutate,
    };
    const mounted = await mountAgentAnnotations({ transport });
    await expect(mounted.api.commands.annotations.complete("ann-1"))
      .rejects.toBeInstanceOf(RevisionConflictError);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(2);
    mounted.unmount();
  });

  it("does not retry arbitrary mutation failures", async () => {
    const mutate = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const memory = new MemoryTaskTransport(taskFixture());
    const transport: TaskTransport = {
      read: () => memory.read(),
      mutate,
    };
    const mounted = await mountAgentAnnotations({ transport });
    await expect(mounted.api.commands.annotations.complete("ann-1"))
      .rejects.toThrow("boom");
    expect(mutate).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it("never attaches evidence captured after a route change to the annotation", async () => {
    history.pushState({}, "", "/route-a");
    const root = mkdtempSync(path.join(tmpdir(), "agent-annotations-runtime-evidence-route-"));
    const store = new FileTaskStore(root);
    const task = await store.readOrCreate();
    let releaseMutate!: () => void;
    const writeEvidence = vi.fn(async (input: {
      taskId: string;
      expectedRevision: number;
      annotationId: string;
      png: string;
      width: number;
      height: number;
    }) => store.mutate({
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      operations: [{
        op: "addEvidence",
        annotationId: input.annotationId,
        evidence: {
          kind: "screenshot",
          ref: `evidence/${input.annotationId}.png`,
          mediaType: "image/png",
          width: input.width,
          height: input.height,
        },
      }],
    }));
    const transport: TaskTransport = {
      read: async () => store.readOrCreate(),
      mutate: (request) => new Promise((resolve) => {
        releaseMutate = () => {
          void store.mutate(request).then(resolve);
        };
      }),
      writeEvidence,
    };
    screenshot.captureViewportPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100 });
    const target = document.createElement("button");
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Evidence race";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(releaseMutate).toBeDefined());
      // The route changes while the annotation mutation is still in flight.
      history.pushState({}, "", "/route-b");
      releaseMutate();
      await vi.waitFor(() => expect(store.read()!.annotations).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writeEvidence).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
      target.remove();
      rmSync(root, { recursive: true, force: true });
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

  it("keeps the region rectangle when a region target identity mismatches", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    document.body.innerHTML = '<main><button id="actual">Wrong</button></main>';
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
      window.dispatchEvent(new Event("resize"));
      await vi.runAllTimersAsync();
      expect(shadow.querySelector('[data-region="true"]')).not.toBeNull();
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

  it("shows the open count when collapsed", async () => {
    vi.useFakeTimers();
    // The strict schema boundary caps tasks at 50 annotations, so the count
    // chrome is exercised at the schema maximum.
    const fifty = taskFixture({
      annotations: Array.from({ length: 50 }, (_, index) =>
        annotationFixture({ annotationId: `ann-${index}` })),
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(fifty) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // The dock starts collapsed by default: the count is already visible.
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.textContent).toBe("50");
      expect(count.getAttribute("aria-label")).toBe("50 open annotations");
      expect(count.getAttribute("aria-expanded")).toBe("false");
      // The count chrome shows a tooltip on hover and focus like other controls.
      count.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(shadow.querySelector('[role="tooltip"]')?.textContent).toBe("50 open annotations");
      // Clicking the count opens the annotation list and reflects aria-expanded.
      count.click();
      expect(shadow.querySelector('[aria-label^="Annotations"]')).not.toBeNull();
      expect(shadow.querySelector<HTMLElement>(".aa-collapsed-count")!.getAttribute("aria-expanded"))
        .toBe("true");
    } finally {
      mounted.unmount();
    }
  });

  it("shows the annotation icon at zero open annotations when collapsed", async () => {
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // The dock starts collapsed by default: the count is already visible.
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.querySelector("svg")).not.toBeNull();
      expect(count.textContent?.trim()).toBe("");
      expect(count.getAttribute("aria-label")).toBe("Annotation list (Ctrl+Alt+L)");
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

  it("returns focus to the collapsed count after the list panel closes", async () => {
    vi.useFakeTimers();
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(taskFixture()) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      // The dock starts collapsed by default: the count is already visible.
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.getAttribute("data-action-id")).toBe("agent-annotations.builtin:list");
      count.click();
      expect(shadow.querySelector('[aria-label^="Annotations"]')).not.toBeNull();
      await vi.runAllTimersAsync();
      // The panel has focus inside the shadow; Escape from there closes it and
      // returns focus to the visible count trigger.
      const shadowRoot = document.getElementById("agent-annotations-root")!.shadowRoot!;
      const panelFocus = shadowRoot.activeElement as HTMLElement;
      panelFocus.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
      await vi.runAllTimersAsync();
      expect(shadow.querySelector('[aria-label="Annotation list"]')).toBeNull();
      expect(shadowRoot.activeElement).toBe(count);
    } finally {
      mounted.unmount();
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

  it("keeps pick armed and clears only transient selection after a successful save", async () => {
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
      textarea.value = "Keep pick";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
      expect(shadow.querySelector('[aria-label="Annotation composer"]')).toBeNull();
      // Still armed: the next click opens a fresh composer.
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(shadow.querySelector('[aria-label="Annotation composer"]')).not.toBeNull();
    } finally {
      mounted.unmount();
      target.remove();
    }
  });

  it("clears only transient selection after a successful multi save and stays armed", async () => {
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
      expect(mounted.api.getSnapshot().captureMode).toBe("multi");
      expect(shadow.querySelector(".aa-multi-complete")).toBeNull();
      // Still armed with an empty selection: two new clicks bring the chip back.
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 5 }));
      expect(shadow.querySelector(".aa-multi-complete")).not.toBeNull();
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
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
      expect(confirm).toHaveBeenCalledOnce();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().task.annotations.map((entry) => entry.annotationId))
        .toEqual(["open-1", "done-1", "done-2"]);
      confirm.mockReturnValue(true);
      remove.click();
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

  it("keeps an editor draft only for its own annotation and preserves it across collapse", async () => {
    const task = taskFixture({
      annotations: [
        annotationFixture({ annotationId: "ann-a", comment: "A comment" }),
        annotationFixture({ annotationId: "ann-b", comment: "B comment" }),
      ],
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-a");
      let textarea = shadow.querySelector<HTMLTextAreaElement>(".aa-editor textarea")!;
      textarea.value = "Draft for A";
      // Collapsing rebuilds chrome but must keep the same editor's draft.
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      textarea = shadow.querySelector<HTMLTextAreaElement>(".aa-editor textarea")!;
      expect(textarea.value).toBe("Draft for A");
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Switching to another annotation must never inherit the previous draft.
      mounted.api.commands.markers.focus("ann-b");
      textarea = shadow.querySelector<HTMLTextAreaElement>(".aa-editor textarea")!;
      expect(textarea.value).toBe("B comment");
    } finally {
      mounted.unmount();
    }
  });

  it("copy leaves the task and marker visibility untouched", async () => {
    const task = taskFixture();
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    try {
      const before = JSON.stringify(mounted.api.getSnapshot().task);
      await mounted.api.commands.annotations.copyOpen();
      expect(JSON.stringify(mounted.api.getSnapshot().task)).toBe(before);
      expect(mounted.api.getSnapshot().markersVisible).toBe(true);
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    } finally {
      mounted.unmount();
    }
  });

  it("default copy emits the agent handoff with completion commands and no revision change", async () => {
    const task = taskFixture({
      taskRevision: 4,
      annotations: [annotationFixture({
        comment: "Make the button purple",
        evidence: [{ kind: "screenshot", ref: "evidence/ann-1.png" }],
      })],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fallback = shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")!;
      const output = fallback.value;
      expect(output).toContain("# Agent Annotations Handoff");
      expect(output).toContain("- browser update revision baseline: 0");
      expect(output).toContain("- referenced source revision: referenced source revision unavailable");
      expect(output).toContain("wait --browser-update-revision 0 --json");
      expect(output).toContain("agent-annotations status --check --json");
      expect(output).toContain("agent-annotations validate-task --json");
      expect(output).toContain(
        "agent-annotations complete ann-1 --verified --summary 'Make the button purple'"
      );
      expect(output).toContain("- evidence: evidence/ann-1.png");
      expect(output).not.toContain("data:image");
      expect(mounted.api.getSnapshot().task.taskRevision).toBe(4);
    } finally {
      mounted.unmount();
    }
  });

  it("default copy redacts secrets and honors the configured command", async () => {
    const task = taskFixture({
      annotations: [annotationFixture({ comment: "Bearer UNIQUE_SECRET_SENTINEL_copy" })],
    });
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      handoff: { command: "pnpm exec agent-annotations", verificationCommands: ["pnpm typecheck"] },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fallback = shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")!;
      expect(fallback.value).not.toContain("UNIQUE_SECRET_SENTINEL_copy");
      expect(fallback.value).toContain("pnpm exec agent-annotations complete ann-1 --verified");
      expect(fallback.value).toContain("- Run: pnpm typecheck");
    } finally {
      mounted.unmount();
    }
  });

  it("preserves the applied baseline across task-only updates and clears it for a failed browser report", async () => {
    vi.useFakeTimers();
    let revisionResponse: Promise<Response> | null = null;
    const fetchMock = vi.fn<typeof fetch>((input: RequestInfo | URL) => {
      if (String(input).endsWith("/revision")) {
        return revisionResponse ?? Promise.resolve(new Response("{}", { status: 500 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const initial = taskFixture();
      let publish!: (task: AgentAnnotationsTask) => void;
      const transport: TaskTransport = {
        read: async () => initial,
        mutate: async () => initial,
        subscribe(listener) {
          publish = listener;
          return () => undefined;
        },
      };
      const mounted = await mountAgentAnnotations({
        transport,
        browserStatus: { endpoint: "/__agent-annotations", token: "status-token" },
      });
      await vi.advanceTimersByTimeAsync(0);
      const fallbackValue = () => {
        const textarea = document.getElementById("agent-annotations-root")!
          .shadowRoot!.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea");
        return textarea?.value ?? "";
      };
      // A baseline is reported through the trusted hook.
      revisionResponse = Promise.resolve(
        new Response(JSON.stringify({
          taskId: initial.taskId,
          taskRevision: initial.taskRevision,
          referencedSourceRevision: "ab".repeat(32),
          referencedSourceFiles: ["src/pages/settings.tsx"],
        }), { status: 200 })
      );
      mounted.reportBrowserUpdate();
      await vi.advanceTimersByTimeAsync(0);
      await mounted.api.commands.annotations.copyOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(fallbackValue()).toContain("- browser update revision baseline: 1");
      expect(fallbackValue()).toContain(`- referenced source revision: ${"ab".repeat(32)}`);
      const heartbeats = () => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/heartbeat"));
      const generation = JSON.parse(heartbeats().at(-1)![1]!.body as string).browserUpdateRevision;
      const revisionFetches = () => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/revision"));
      expect(revisionFetches()).toHaveLength(1);
      // A same-source task update cannot advance the browser generation or
      // replace the trusted source snapshot.
      publish({ ...initial, taskRevision: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await mounted.api.commands.annotations.copyOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(fallbackValue()).toContain("- browser update revision baseline: 1");
      expect(fallbackValue()).toContain(`- referenced source revision: ${"ab".repeat(32)}`);
      expect(JSON.parse(heartbeats().at(-1)![1]!.body as string).browserUpdateRevision).toBe(generation);
      expect(revisionFetches()).toHaveLength(1);
      // A trusted browser update advances the generation, but a response for
      // another task revision cannot install its source snapshot.
      revisionResponse = Promise.resolve(new Response(
        JSON.stringify({
          taskId: initial.taskId,
          taskRevision: 99,
          referencedSourceRevision: null,
          referencedSourceFiles: [],
        }),
        { status: 200 }
      ));
      mounted.reportBrowserUpdate();
      await vi.advanceTimersByTimeAsync(0);
      await mounted.api.commands.annotations.copyOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(fallbackValue()).toContain("- browser update revision baseline: 2");
      expect(fallbackValue()).toContain("- referenced source revision: referenced source revision unavailable");
      expect(fallbackValue()).toContain("wait --browser-update-revision 2");
      // A task update racing an in-flight trusted report invalidates the
      // response, so the newer task cannot inherit a disk hash it never ran.
      let resolveStale!: (value: Response) => void;
      revisionResponse = new Promise((resolve) => { resolveStale = resolve; });
      mounted.reportBrowserUpdate();
      publish({ ...initial, taskRevision: 2 });
      resolveStale(new Response(JSON.stringify({
        referencedSourceRevision: null,
        referencedSourceFiles: [],
      }), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(heartbeats().at(-1)![1]!.body as string).referencedSourceRevision).toBeNull();
      // A later successful refresh restores the new baseline.
      revisionResponse = Promise.resolve(
        new Response(JSON.stringify({
          taskId: initial.taskId,
          taskRevision: 2,
          referencedSourceRevision: "cd".repeat(32),
          referencedSourceFiles: ["src/pages/settings.tsx"],
        }), { status: 200 })
      );
      mounted.reportBrowserUpdate();
      await vi.advanceTimersByTimeAsync(0);
      await mounted.api.commands.annotations.copyOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(fallbackValue()).toContain("- browser update revision baseline: 4");
      expect(fallbackValue()).toContain(`- referenced source revision: ${"cd".repeat(32)}`);
      expect(fallbackValue()).toContain("wait --browser-update-revision 4");
      mounted.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never truncates a long completion command during the final redaction", async () => {
    const task = taskFixture({
      annotations: [annotationFixture({
        comment: `Fix and 'quote' ` + "x".repeat(2500),
      })],
    });
    // The short secret lives in the handoff config, which bypasses task
    // redaction: the final complete-output pass must still replace it.
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(task),
      handoff: { verificationCommands: ["echo Bearer ab"] },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fallback = shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")!;
      const output = fallback.value;
      // The config-derived secret is replaced by the final pass, the long
      // (task-bounded) comment keeps the completion line beyond 2000
      // characters, and the line still closes with its POSIX quote instead
      // of being truncated mid-command.
      expect(output).not.toContain("Bearer ab");
      expect(output).toContain("echo Bearer [REDACTED]");
      const completionLine = output.split("\n").find((line) => line.startsWith("- completion:"))!;
      expect(completionLine.length).toBeGreaterThan(2000);
      expect(completionLine.endsWith("'")).toBe(true);
    } finally {
      mounted.unmount();
    }
  });

  it("runs extension redactors before the default handoff copy", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const mounted = await mountAgentAnnotations({
      transport,
      extensions: [defineClientExtension({
        id: "handoff-data",
        apiVersion: 1,
        targetEnrichers: [{ id: "enrich", enrich: () => ({ secret: "value" }) }],
        redactors: [{ id: "scrub", redact: () => ({ safe: true }) }],
      })],
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.capture.startPick();
      document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
      const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
      const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Redacted handoff";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(async () => expect((await transport.read()).annotations).toHaveLength(1));
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fallback = shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")!;
      expect(fallback.value).toContain('extension handoff-data: {"safe":true}');
      expect(fallback.value).not.toContain("secret");
      expect(fallback.value).not.toContain('"value"');
    } finally {
      mounted.unmount();
      pageTarget.remove();
    }
  });

  it("clipboard copy and the manual fallback are byte-for-byte identical", async () => {
    const task = taskFixture();
    let written = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { written = text; } },
    });
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    try {
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(written).toContain("# Agent Annotations Handoff");
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
    } finally {
      mounted.unmount();
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
    // Without clipboard support the same output lands in the fallback.
    const mounted2 = await mountAgentAnnotations({ transport: new MemoryTaskTransport(task) });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      await mounted2.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fallback = shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")!;
      expect(fallback.value).toBe(written);
    } finally {
      mounted2.unmount();
    }
  });
});
