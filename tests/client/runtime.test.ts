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

  it("recovers an unresolved nested iframe marker after the outer document is populated", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    document.body.innerHTML = '<div id="root"></div>';
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          targets: [targetFixture({
            selector: "#outer >>iframe>> #inner >>iframe>> #target",
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
    publicTask.taskId = "tampered";
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
          targets: [targetFixture({ selector: "#position-target" })],
        })],
      })),
    });

    try {
      mounted.api.commands.markers.focus("ann-1");
      const editor = document.getElementById("agent-annotations-root")!
        .shadowRoot!.querySelector<HTMLElement>(".aa-editor")!;
      expect([...editor.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
        .toEqual(["Save comment", "Complete", "Delete", "Close"]);
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
    expect(await mounted.api.commands.exporters.format()).toContain("# Agent Annotations Task");
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

  it("keeps panels exclusive and returns focus to the opening action", async () => {
    vi.useFakeTimers();
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
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
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
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

  it("cleans partial setup and leaves no mount when setup fails", async () => {
    const dispose = vi.fn();
    await expect(mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [
        defineClientExtension({
          id: "a-setup-first",
          apiVersion: 1,
          setup: () => dispose,
        }),
        defineClientExtension({
          id: "z-setup-fails",
          apiVersion: 1,
          setup: () => {
            throw new Error("setup failed");
          },
        }),
      ],
    })).rejects.toThrow("setup failed");
    expect(dispose).toHaveBeenCalledOnce();
    expect(document.getElementById("agent-annotations-root")).toBeNull();
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
          targets: [targetFixture({ selector: "#inside-root-target" })],
        }),
        annotationFixture({
          annotationId: "out-root",
          targets: [targetFixture({ selector: "#outside-root-target" })],
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
        targets: [targetFixture({ selector: "#duplicate-target" })],
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
        targets: [targetFixture({ selector: "#app-root-target" })],
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
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!.click();
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
      expect(shadow.querySelector('[aria-label="Annotation list"]')).not.toBeNull();
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
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!.click();
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
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
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
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!.click();
      const count = shadow.querySelector<HTMLElement>(".aa-collapsed-count")!;
      expect(count.getAttribute("data-action-id")).toBe("agent-annotations.builtin:list");
      count.click();
      expect(shadow.querySelector('[aria-label="Annotation list"]')).not.toBeNull();
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

  it("collapse cancels active capture interception but keeps an open draft and blocks capture hotkeys", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    primitives.getElementAtPoint.mockReturnValue(target);
    const mounted = await mountAgentAnnotations({ transport: new MemoryTaskTransport() });
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
      // Capture hotkeys are blocked while collapsed; collapse hotkey still works.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, altKey: true, bubbles: true }));
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mounted.api.getSnapshot().collapsed).toBe(false);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, altKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
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
});
