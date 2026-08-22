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

describe("runtime-evidence-status", () => {


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
    history.pushState({}, "", "/settings");
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
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "aGVsbG8gc2VjcmV0", width: 1600, height: 900 });
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
    screenshot.prepareViewportSnapshot.mockImplementationOnce(() => {
      expect(primitives.unfreeze).not.toHaveBeenCalled();
      return Object.freeze({ svg: "<svg/>", width: 100, height: 100, scale: 1, overlays: Object.freeze([]), startedAt: 0 });
    });
    screenshot.renderPreparedSnapshotPng.mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
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
    expect(screenshot.prepareViewportSnapshot).toHaveBeenCalledOnce();
    expect(primitives.unfreeze).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(screenshot.renderPreparedSnapshotPng).toHaveBeenCalledOnce());
    expect(writeEvidence).not.toHaveBeenCalled();
    resolveCapture({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledOnce());
    mounted.unmount();
    pageTarget.remove();
  });



  it("keeps a saved annotation when frozen snapshot preparation fails", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.prepareViewportSnapshot.mockReturnValueOnce(null);
    const transport = new MemoryTaskTransport();
    const writeEvidence = vi.spyOn(transport, "writeEvidence");
    const mounted = await mountAgentAnnotations({ transport });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    mounted.api.commands.capture.startPick();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const composer = shadow.querySelector<HTMLElement>(".aa-composer")!;
    composer.querySelector<HTMLTextAreaElement>("textarea")!.value = "Prepare failure";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(async () => expect((await transport.read()).annotations).toHaveLength(1));
    expect(shadow.querySelector(".aa-composer")).toBeNull();
    expect(shadow.querySelector('[role="status"]')?.textContent).toBe("Annotation saved");
    expect(mounted.api.getSnapshot().diagnostics.at(-1)?.message).toContain("snapshot preparation failed");
    expect(primitives.unfreeze).toHaveBeenCalledOnce();
    expect(screenshot.renderPreparedSnapshotPng).not.toHaveBeenCalled();
    expect(writeEvidence).not.toHaveBeenCalled();
    mounted.unmount();
    pageTarget.remove();
  });



  it("captures evidence only on demand in manual mode through the command and the editor", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
    expect(screenshot.prepareViewportSnapshot).not.toHaveBeenCalled();
    expect(screenshot.renderPreparedSnapshotPng).not.toHaveBeenCalled();
    expect(writeEvidence).not.toHaveBeenCalled();
    const annotationId = (await transport.read()).annotations[0]!.annotationId;
    // The editor exposes the localized Capture screenshot action.
    mounted.api.commands.markers.focus(annotationId);
    const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
    const captureButton = [...editor.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Capture screenshot");
    expect(captureButton).toBeDefined();
    primitives.freeze.mockClear();
    primitives.unfreeze.mockClear();
    screenshot.prepareViewportSnapshot.mockImplementationOnce(() => {
      expect(primitives.freeze).toHaveBeenCalledOnce();
      expect(primitives.unfreeze).not.toHaveBeenCalled();
      return Object.freeze({ svg: "<svg/>", width: 100, height: 100, scale: 1, overlays: Object.freeze([]), startedAt: 0 });
    });
    captureButton!.click();
    await vi.waitFor(() => expect(writeEvidence).toHaveBeenCalledOnce());
    expect(screenshot.prepareViewportSnapshot).toHaveBeenCalledOnce();
    expect(screenshot.renderPreparedSnapshotPng).toHaveBeenCalledOnce();
    expect(primitives.unfreeze).toHaveBeenCalledOnce();
    // The public command also captures on demand.
    writeEvidence.mockClear();
    screenshot.prepareViewportSnapshot.mockClear();
    screenshot.renderPreparedSnapshotPng.mockClear();
    await mounted.api.commands.annotations.captureEvidence(annotationId);
    expect(screenshot.prepareViewportSnapshot).toHaveBeenCalledOnce();
    expect(screenshot.renderPreparedSnapshotPng).toHaveBeenCalledOnce();
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
    expect(screenshot.prepareViewportSnapshot).not.toHaveBeenCalled();
    expect(screenshot.renderPreparedSnapshotPng).not.toHaveBeenCalled();
    expect(writeEvidence).not.toHaveBeenCalled();
    const annotationId = (await transport.read()).annotations[0]!.annotationId;
    // No Capture screenshot entry in the editor and the command is a no-op.
    mounted.api.commands.markers.focus(annotationId);
    const editor = shadow.querySelector<HTMLElement>(".aa-editor")!;
    expect([...editor.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "Capture screenshot"
    )).toBe(false);
    await mounted.api.commands.annotations.captureEvidence(annotationId);
    expect(screenshot.prepareViewportSnapshot).not.toHaveBeenCalled();
    expect(screenshot.renderPreparedSnapshotPng).not.toHaveBeenCalled();
    mounted.unmount();
    pageTarget.remove();
  });



  it("retries evidence once after a revision conflict and never overrides a newer task", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
      screenshot.renderPreparedSnapshotPng.mockReturnValueOnce(new Promise((resolve) => { resolveCapture = resolve; }));
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
    expect(screenshot.prepareViewportSnapshot).not.toHaveBeenCalled();
    expect(screenshot.renderPreparedSnapshotPng).not.toHaveBeenCalled();
    mounted.unmount();
  });



  it("adopts the latest task on a second evidence conflict and records a diagnostic", async () => {
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
    screenshot.renderPreparedSnapshotPng.mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
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
    expect(screenshot.prepareViewportSnapshot).toHaveBeenCalledOnce();
    expect(screenshot.renderPreparedSnapshotPng).toHaveBeenCalledOnce();
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
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
        annotationHealth: [],
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
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100 });
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



  it("keeps an editor draft only for its own annotation and preserves it across collapse", async () => {
    history.pushState({}, "", "/settings");
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
      expect(output).toContain("wait --browser-update-revision 0 --runtime ");
      expect(output).toMatch(/agent-annotations status --runtime [^ ]+ --annotation ann-1 --fail-on-diagnostics --diagnostics-since [^ ]+ --check --json/);
      expect(output).toContain("agent-annotations validate-task --json");
      expect(output).toContain(
        "agent-annotations complete ann-1 --verified --summary-file agent-annotations-summary-ann-1.txt"
      );
      expect(output).not.toContain("--summary 'Make the button purple'");
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



  it("keeps completion commands bounded and redacts handoff instructions", async () => {
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
      expect(output).not.toContain("Bearer ab");
      expect(output).toContain("echo Bearer [REDACTED]");
      const completionLine = output.split("\n").find((line) => line.startsWith("- completion:"))!;
      expect(completionLine).toBe("- completion: agent-annotations complete ann-1 --verified --summary-file agent-annotations-summary-ann-1.txt");
      expect(completionLine).not.toContain("quote");
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
      delete (navigator as { clipboard?: unknown }).clipboard;
      // Without clipboard support the same runtime output lands in the fallback.
      await mounted.api.commands.annotations.copyOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
      const fallback = shadow.querySelector<HTMLTextAreaElement>(".aa-copy-fallback textarea")!;
      expect(fallback.value.replaceAll(/2026-[^ ]+/g, "TIMESTAMP"))
        .toBe(written.replaceAll(/2026-[^ ]+/g, "TIMESTAMP"));
    } finally {
      mounted.unmount();
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
