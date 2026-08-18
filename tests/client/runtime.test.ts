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

  it("does not render markers for completed annotations", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [{ ...taskFixture().annotations[0]!, status: "completed" }],
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
    let notify!: (routeKey: string) => void;
    const unsubscribe = vi.fn();
    const host: HostIntegration = {
      routeKey: () => "/host-a",
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
      notify("/host-b");
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
    const memory = new MemoryTaskTransport();
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
      expect(store.read()!.annotations[0]!.evidence ?? []).toHaveLength(0);
    } finally {
      mounted.unmount();
      target.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
