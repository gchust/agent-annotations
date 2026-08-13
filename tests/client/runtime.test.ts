/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

const primitives = vi.hoisted(() => ({
  freeze: vi.fn(),
  getElementAtPoint: vi.fn((): Element | null => null),
  unfreeze: vi.fn(),
}));

vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(),
  freeze: primitives.freeze,
  getElementAtPoint: primitives.getElementAtPoint,
  getElementBounds: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })),
  getElementContext: vi.fn(() => ({
    htmlPreview: "<button>Save</button>",
    stack: [],
    componentName: null,
    filePath: null,
    lineNumber: null,
    columnNumber: null,
    styles: "",
  })),
  getElementSelector: vi.fn(() => "button"),
  getElementsAtPoint: vi.fn(() => []),
  isElementGrabbable: vi.fn(() => true),
  unfreeze: primitives.unfreeze,
}));

import { mountAgentFeedback } from "../../src/client/index.js";
import { defineClientExtension } from "../../src/extension/index.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";
import type { AgentFeedbackTask, TaskTransport } from "../../src/types/index.js";
import { annotationFixture, targetFixture, taskFixture } from "../core/test-data.js";

afterEach(() => {
  document.getElementById("agent-feedback-root")?.remove();
  primitives.getElementAtPoint.mockReset();
  primitives.getElementAtPoint.mockReturnValue(null);
  primitives.freeze.mockClear();
  primitives.unfreeze.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("client runtime", () => {
  it("marks the shadow host ignored before mounting and cleans it up", async () => {
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    const host = document.getElementById("agent-feedback-root");
    expect(host?.hasAttribute("data-react-grab-ignore")).toBe(true);
    expect(host?.shadowRoot?.querySelector('[aria-label^="Pick"]')).not.toBeNull();

    mounted.unmount();
    mounted.unmount();
    expect(document.getElementById("agent-feedback-root")).toBeNull();
  });

  it("freezes capture symmetrically while leaving the ignored toolbar usable", async () => {
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-feedback-root")!.shadowRoot!;
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
    const empty = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    expect(Mutation).not.toHaveBeenCalled();
    expect(Resize).not.toHaveBeenCalled();
    empty.unmount();
    vi.unstubAllGlobals();
  });

  it("recovers an unresolved nested iframe marker after the outer document is populated", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
    const mounted = await mountAgentFeedback({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          targets: [targetFixture({
            selector: "#outer >>iframe>> #inner >>iframe>> #target",
          })],
        })],
      })),
    });
    try {
      const marker = document.getElementById("agent-feedback-root")!
        .shadowRoot!.querySelector<HTMLButtonElement>(".af-marker")!;
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
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    const listener = vi.fn();
    const unsubscribe = mounted.api.subscribe(listener);

    mounted.api.commands.capture.startPick();
    mounted.api.commands.markers.hide();
    mounted.api.commands.panels.open("help");

    expect(mounted.api.getSnapshot()).toMatchObject({
      captureMode: "pick",
      markersVisible: false,
      openPanel: "help",
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
    let publish!: (task: AgentFeedbackTask) => void;
    const unsubscribe = vi.fn();
    const transport: TaskTransport = {
      read: async () => task,
      mutate: async () => task,
      subscribe(listener) {
        publish = listener;
        return unsubscribe;
      },
    };
    const mounted = await mountAgentFeedback({ transport });
    publish({ ...task, taskRevision: 1 });
    await vi.runAllTimersAsync();
    expect(mounted.api.getSnapshot().task.taskRevision).toBe(1);
    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not render markers for completed annotations", async () => {
    const mounted = await mountAgentFeedback({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [{ ...taskFixture().annotations[0]!, status: "completed" }],
      })),
    });
    expect(document.getElementById("agent-feedback-root")!.shadowRoot!.querySelector(".af-marker"))
      .toBeNull();
    mounted.unmount();
  });

  it("does not inspect capture events from inside the ignored shadow host", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    mounted.api.commands.capture.startPick();

    const annotations = document
      .getElementById("agent-feedback-root")!
      .shadowRoot!
      .querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!;
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
    expect(mounted.api.getSnapshot().openPanel).toBe("list");
    expect(document.getElementById("agent-feedback-root")!.shadowRoot!.querySelector(".af-composer")).toBeNull();
    mounted.unmount();
    pageTarget.remove();
  });

  it("cancels scheduled work and ignores mutation completion after unmount", async () => {
    vi.useFakeTimers();
    const task = await new MemoryTaskTransport().read();
    let resolveMutation!: (task: AgentFeedbackTask) => void;
    const transport: TaskTransport = {
      read: async () => task,
      mutate: () => new Promise((resolve) => { resolveMutation = resolve; }),
    };
    const mounted = await mountAgentFeedback({ transport });
    const listener = vi.fn();
    mounted.api.subscribe(listener);
    const pick = document
      .getElementById("agent-feedback-root")!
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
    expect(document.getElementById("agent-feedback-root")).toBeNull();
  });

  it("captures bounded redacted console, window, and promise diagnostics", async () => {
    const originalConsoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const restoredConsoleError = console.error;
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });

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
        icon: () => null,
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
    const mounted = await mountAgentFeedback({
      transport: new MemoryTaskTransport(),
      extensions: [extension],
    });
    const shadow = document.getElementById("agent-feedback-root")!.shadowRoot!;
    const action = shadow.querySelector<HTMLButtonElement>('[aria-label^="Runtime action"]')!;
    expect(action.getAttribute("aria-label")).toContain("Ctrl+Alt+R");
    expect(mounted.api.getSnapshot().shortcuts.find(({ id }) => id === "runtime-action")?.formatted).toBe("Ctrl+Alt+R");
    mounted.api.commands.panels.open("help");
    expect(shadow.querySelector('[aria-label="Shortcut help"]')?.textContent).toContain("Ctrl+Alt+R");
    mounted.api.commands.panels.close("help");
    action.click();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "r", code: "KeyR", ctrlKey: true, altKey: true,
    }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenCalledOnce();
    expect(mounted.api.getSnapshot().exporters).toContainEqual({ id: "json", extensionId: "runtime-test" });
    expect(await mounted.api.commands.exporters.format()).toContain("# Agent Feedback Task");
    expect(await mounted.api.commands.exporters.format("json")).toContain('"schema":"agent-feedback.task.v1"');
    mounted.api.commands.panels.open("runtime-panel");
    vi.runAllTimers();
    expect(shadow.activeElement).toBe(shadow.querySelector(".af-panel button"));
    shadow.querySelector<HTMLButtonElement>(".af-panel button")!.click();
    expect(mounted.api.getSnapshot().openPanel).toBeNull();
    mounted.unmount();
    mounted.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps panels exclusive and returns focus to the opening action", async () => {
    vi.useFakeTimers();
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-feedback-root")!.shadowRoot!;
    const list = shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!;
    list.focus();
    list.click();
    vi.runAllTimers();
    expect(mounted.api.getSnapshot().openPanel).toBe("list");
    mounted.api.commands.panels.open("help");
    expect(mounted.api.getSnapshot().openPanel).toBe("help");
    expect(shadow.querySelectorAll(".af-panel")).toHaveLength(1);
    mounted.api.commands.panels.close("help");
    vi.runAllTimers();
    expect(shadow.activeElement).toBe(
      shadow.querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')
    );
    mounted.unmount();
  });

  it("preserves built-in toolbar state parity", async () => {
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    const shadow = document.getElementById("agent-feedback-root")!.shadowRoot!;
    const markers = shadow.querySelector<HTMLButtonElement>('[aria-label^="Markers"]')!;
    markers.click();
    expect(mounted.api.getSnapshot().markersVisible).toBe(false);
    expect(
      shadow
        .querySelector('[aria-label^="Markers"]')
        ?.getAttribute("aria-pressed")
    ).toBe("false");
    const collapse = shadow.querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!;
    collapse.click();
    expect(mounted.api.getSnapshot().collapsed).toBe(true);
    expect(shadow.querySelectorAll(".af-action:not([data-toggle=true])")).toHaveLength(7);
    expect(shadow.querySelector(".af-dock")?.getAttribute("data-collapsed")).toBe("true");
    shadow
      .querySelector<HTMLButtonElement>('[aria-label^="Collapse toolbar"]')!
      .click();
    expect(mounted.api.getSnapshot().collapsed).toBe(false);
    expect(shadow.querySelectorAll(".af-action").length).toBeGreaterThan(1);
    mounted.unmount();
  });

  it("namespaces enriched targets and redacts them before transport persistence", async () => {
    const pageTarget = document.createElement("button");
    pageTarget.textContent = "Save";
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    const transport = new MemoryTaskTransport();
    const mutate = vi.spyOn(transport, "mutate");
    const mounted = await mountAgentFeedback({
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
    const shadow = document.getElementById("agent-feedback-root")!.shadowRoot!;
    const textarea = shadow.querySelector<HTMLTextAreaElement>(".af-composer textarea")!;
    textarea.value = "Change it";
    shadow.querySelector<HTMLFormElement>(".af-composer")!.dispatchEvent(
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
    await expect(mountAgentFeedback({
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
    expect(document.getElementById("agent-feedback-root")).toBeNull();
  });
});
