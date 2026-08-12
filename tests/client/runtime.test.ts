/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => ({
  getElementAtPoint: vi.fn((): Element | null => null),
}));

vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(),
  getElementAtPoint: primitives.getElementAtPoint,
  getElementBounds: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })),
  getElementContext: vi.fn(),
  getElementSelector: vi.fn(),
  getElementsAtPoint: vi.fn(() => []),
  isElementGrabbable: vi.fn(() => true),
}));

import { mountAgentFeedback } from "../../src/client/index.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";
import type { AgentFeedbackTask, TaskTransport } from "../../src/types/index.js";

afterEach(() => {
  document.getElementById("agent-feedback-root")?.remove();
  primitives.getElementAtPoint.mockReset();
  primitives.getElementAtPoint.mockReturnValue(null);
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
    document
      .getElementById("agent-feedback-root")!
      .shadowRoot!
      .querySelector<HTMLButtonElement>('[aria-label^="Annotations"]')!
      .dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      composed: true,
      key: "Escape",
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
});
