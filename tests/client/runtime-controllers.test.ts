/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTaskController } from "../../src/client/runtime/task.js";
import { createGuardedHostIntegration, createHostController } from "../../src/client/runtime/host.js";
import { createDiagnosticsController } from "../../src/client/runtime/diagnostics.js";
import { createMarkerController } from "../../src/client/runtime/markers.js";
import { createEvidenceController } from "../../src/client/runtime/evidence.js";
import { createCaptureController } from "../../src/client/runtime/capture.js";
import * as screenshot from "../../src/client/screenshot.js";
import { RevisionConflictError } from "../../src/core/index.js";
import type { AgentAnnotationsRect, StudioPublicSnapshot } from "../../src/types/index.js";
type StudioPublicShortcut = StudioPublicSnapshot["shortcuts"][number];
import { taskFixture } from "../core/test-data.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime controllers (focused factory contracts)", () => {
  it("isolates every host callback and disposer with safe fallbacks", () => {
    const fault = (name: string) => () => { throw new Error(`${name} secret=hidden`); };
    let subscriptions = 0;
    const source = {
      locale: fault("locale"),
      theme: fault("theme"),
      appRoot: fault("appRoot"),
      pageContext: fault("pageContext"),
      routeKey: fault("routeKey"),
      navigate: fault("navigate"),
      identity: fault("identity"),
      subscribe: () => {
        subscriptions += 1;
        if (subscriptions === 1) throw new Error("subscribe secret=hidden");
        return fault("subscribe.dispose");
      },
    };
    Object.defineProperty(source, "messages", { get: fault("messages") });
    const failures: string[] = [];
    const host = createGuardedHostIntegration("faulty.host", source, (method) => failures.push(method));
    expect(host.locale?.()).toBe(document.documentElement.lang || "en-US");
    expect(host.theme?.()).toBe("light");
    expect(host.appRoot?.()).toBe(document.body);
    expect(host.pageContext?.()).toEqual({});
    expect(host.routeKey?.()).toBeUndefined();
    expect(host.identity?.(document.body)).toEqual({});
    expect(host.messages).toEqual({});
    expect(host.navigateRoute("/next")).toBe(false);
    expect(host.subscribeChanges(() => undefined)).toBeNull();
    const dispose = host.subscribeChanges(() => undefined);
    expect(dispose).toBeTypeOf("function");
    expect(() => dispose?.()).not.toThrow();
    expect(failures).toEqual([
      "locale", "theme", "appRoot", "pageContext", "routeKey", "identity",
      "messages", "navigate", "subscribe", "subscribe.dispose",
    ]);
  });

  it("handles update, complete, reopen, and addEvidence without a browser update binding", async () => {
    const state = { task: taskFixture() };
    const transport = new MemoryTaskTransport(state.task);
    const controller = createTaskController({
      task: () => state.task,
      setTask: (next) => { state.task = next; },
      transport: () => transport,
      guardedRedactors: () => [],
      render: () => undefined,
      emit: () => undefined,
      destroyed: () => false,
    });
    await controller.mutate([{ op: "update", annotationId: "ann-1", comment: "Updated" }]);
    await controller.mutate([{ op: "complete", annotationId: "ann-1" }]);
    await controller.mutate([{ op: "reopen", annotationId: "ann-1" }]);
    await controller.mutate([{
      op: "addEvidence",
      annotationId: "ann-1",
      evidence: { kind: "screenshot", ref: "memory:1", mediaType: "image/png", width: 1, height: 1, capturedAt: "2026-08-12T12:00:00.000Z" },
    }]);
    expect(state.task.taskRevision).toBe(4);
  });

  it("task controller adopts a conflict task and retries exactly once", async () => {
    const state = { task: taskFixture() };
    const render = vi.fn();
    const emit = vi.fn();
    let attempts = 0;
    const expectedRevisions: number[] = [];
    const transport = {
      mutate: async (request: { expectedRevision: number }) => {
        attempts += 1;
        expectedRevisions.push(request.expectedRevision);
        if (attempts === 1) {
          // The transport moved on behind the runtime; a typed conflict with
          // the latest task is thrown, then the retry must succeed.
          const latest = { ...state.task, taskRevision: 1 };
          throw new RevisionConflictError(latest, 1, request.expectedRevision);
        }
        return { ...state.task, taskRevision: 1, annotations: [] };
      },
    };
    const controller = createTaskController({
      task: () => state.task,
      setTask: (next) => { state.task = next; },
      transport: () => transport,
      guardedRedactors: () => [],
      render,
      emit,
      destroyed: () => false,
    });
    await controller.mutate([{ op: "complete", annotationId: "ann-1" }]);
    expect(attempts).toBe(2);
    // The first attempt used the original revision, the retry the adopted one.
    expect(expectedRevisions).toEqual([0, 1]);
    expect(state.task.taskRevision).toBe(1);
  });

  it("host controller disposes the system theme listener and clears route capture state", async () => {
    const removals = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: removals,
    })));
    const state: {
      theme: "light" | "dark" | "system";
      locale: string;
      messages: Record<string, string>;
      appRoot: Element | Document;
      routeKey: string;
      shortcuts: readonly StudioPublicShortcut[];
      captureMode: "idle" | "pick" | "multi" | "area";
      selected: Element[];
      hover: Element | null;
      areaStart: { x: number; y: number } | null;
      areaRect: AgentAnnotationsRect | null;
      composer: null | { kind: "element" | "multi"; elements: Element[] } | { kind: "region"; rect: AgentAnnotationsRect; sampled: number; elements: Element[] };
      editingId: string | null;
      editorAnchorRect: AgentAnnotationsRect | null;
      destroyed: boolean;
    } = {
      theme: "system",
      locale: "en-US",
      messages: {},
      appRoot: document.body,
      routeKey: "/a",
      shortcuts: [] as readonly StudioPublicShortcut[],
      captureMode: "pick",
      selected: [],
      hover: null,
      areaStart: null,
      areaRect: null,
      composer: null as never,
      editingId: null,
      editorAnchorRect: null,
      destroyed: false,
    };
    const render = vi.fn();
    const emit = vi.fn();
    const resetTracked = vi.fn();
    const clearCapture = vi.fn();
    const refreshCapture = vi.fn();
    const controller = createHostController({
      host: () => ({ theme: () => state.theme, locale: () => state.locale }),
      hostTheme: () => state.theme,
      setHostTheme: (value) => { state.theme = value; },
      hostLocale: () => state.locale,
      setHostLocale: (value) => { state.locale = value; },
      messages: () => state.messages,
      setMessages: (value) => { state.messages = value; },
      appRoot: () => state.appRoot,
      setAppRoot: (value) => { state.appRoot = value; },
      routeKey: () => state.routeKey,
      setRouteKey: (value) => { state.routeKey = value; },
      pageContext: () => ({
        url: "https://example.test",
        routeKey: state.routeKey,
        title: "Example",
        viewport: { width: 100, height: 100 },
        scroll: { x: 0, y: 0 },
      }),
      shortcuts: () => state.shortcuts,
      setShortcuts: (value) => { state.shortcuts = value; },
      captureMode: () => state.captureMode,
      setCaptureMode: (value) => { state.captureMode = value; },
      selected: () => state.selected,
      setSelected: (value) => { state.selected = value; },
      hover: () => state.hover,
      setHover: (value) => { state.hover = value; },
      areaStart: () => state.areaStart,
      setAreaStart: (value) => { state.areaStart = value; },
      areaRect: () => state.areaRect,
      setAreaRect: (value) => { state.areaRect = value; },
      composer: () => state.composer,
      setComposer: (value) => { state.composer = value; },
      editingId: () => state.editingId,
      setEditingId: (value) => { state.editingId = value; },
      editorAnchorRect: () => state.editorAnchorRect,
      setEditorAnchorRect: (value) => { state.editorAnchorRect = value; },
      registry: () => ({ getExtensionMessages: () => ({}) }) as never,
      hostElement: () => document.createElement("div"),
      root: () => document.createElement("div"),
      destroyed: () => state.destroyed,
      buildShortcuts: () => state.shortcuts,
      setMarkerHighlight: vi.fn(),
      resetTrackedTargets: resetTracked,
      setInspectionFrozen: vi.fn(),
      clearCaptureDocuments: clearCapture,
      refreshCaptureDocuments: refreshCapture,
      scheduleMarkerRefresh: vi.fn(),
      scheduleFrame: vi.fn(() => 0),
      render,
      emit,
    });
    controller.applyHostChange();
    expect(removals).not.toHaveBeenCalled();
    controller.disposeSystemTheme();
    expect(removals).toHaveBeenCalled();
    // A route change stops capture and clears the capture document bindings
    // (no re-bind on the old route); appRoot changes refresh instead.
    controller.applyRouteKey("/b");
    expect(state.routeKey).toBe("/b");
    expect(state.captureMode).toBe("idle");
    expect(clearCapture).toHaveBeenCalled();
    expect(refreshCapture).not.toHaveBeenCalled();
  });

  it("diagnostics controller installs and removes console and network patches", () => {
    const originalConsoleError = console.error;
    const originalFetch = window.fetch;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = createDiagnosticsController({
      registry: { getRedactors: () => [] } as never,
      transport: () => ({}),
      scheduleFrame: vi.fn(() => 0),
      emit: vi.fn(),
      browserStatus: () => null,
      destroyed: () => false,
    });
    const restoreConsole = controller.installConsoleLogging();
    const restoreNetwork = controller.installNetworkDiagnostics();
    expect(console.error).not.toBe(originalConsoleError);
    expect(window.fetch).not.toBe(originalFetch);
    restoreConsole();
    restoreNetwork();
    expect(console.error).toBe(originalConsoleError);
    expect(window.fetch).toBe(fetchMock);
    vi.unstubAllGlobals();
    expect(window.fetch).toBe(originalFetch);
  });

  it("marker controller cancels its scheduled refresh frame via the binding", () => {
    const cancelled: number[] = [];
    const task = taskFixture();
    const controller = createMarkerController({
      task: () => task,
      routeKey: () => "/settings",
      markersVisible: () => true,
      appRoot: () => document,
      host: () => undefined,
      overlayMount: () => document.createElement("div"),
      hostElement: () => document.createElement("div"),
      editingId: () => null,
      hasElementComposer: () => false,
      scheduleFrame: (cb) => {
        // Run the refresh inline so a frame is actually scheduled.
        window.requestAnimationFrame(cb);
        return 1;
      },
      cancelFrame: (frame) => { cancelled.push(frame); },
      isInAppRoot: () => true,
      positionComposer: vi.fn(),
      positionEditor: vi.fn(),
      resolveTargetInAppRoot: () => null,
    });
    controller.scheduleMarkerRefresh();
    controller.stopMarkerTracking();
    expect(cancelled.length).toBe(1);
  });

  it("capture controller binds the app-root document and nested iframes, and clears them", () => {
    const frameDoc: {
      added: string[]; removed: string[];
      addEventListener(type: string, listener?: EventListener): void;
      removeEventListener(type: string): void;
      querySelectorAll(): Element[];
    } = {
      added: [], removed: [],
      addEventListener: (type) => { frameDoc.added.push(type); },
      removeEventListener: (type) => { frameDoc.removed.push(type); },
      querySelectorAll: () => [],
    };
    const frame: {
      contentDocument: typeof frameDoc;
      removed: string[];
      addEventListener(type: string, cb: () => void): void;
      removeEventListener(type: string): void;
    } = {
      contentDocument: frameDoc,
      removed: [],
      addEventListener: (_type: string, cb: () => void) => cb(),
      removeEventListener: (type: string) => { frame.removed.push(type); },
    };
    const appRoot = { querySelectorAll: () => [frame] };
    const listeners: Array<[string, EventListener]> = [
      ["pointermove", () => undefined], ["pointerdown", () => undefined],
      ["pointerup", () => undefined], ["click", () => undefined],
    ];
    const documentSpy: {
      added: string[];
      removed: string[];
      addEventListener: (type: string) => void;
      removeEventListener: (type: string) => void;
      querySelectorAll(): Element[];
    } = {
      added: [], removed: [],
      addEventListener: (type: string) => { documentSpy.added.push(type); },
      removeEventListener: (type: string) => { documentSpy.removed.push(type); },
      querySelectorAll: () => [],
    };
    const controller = createCaptureController({
      markersVisible: () => true,
      setMarkersVisibleValue: () => undefined,
      collapsed: () => false,
      setCollapsedValue: () => undefined,
      captureMode: () => "idle",
      setCaptureModeValue: () => undefined,
      selected: () => [],
      setSelectedValue: () => undefined,
      hover: () => null,
      setHoverValue: () => undefined,
      composer: () => null,
      setComposerValue: () => undefined,
      editingId: () => null,
      setEditingIdValue: () => undefined,
      openPanel: () => null,
      setOpenPanelValue: () => undefined,
      areaStart: () => null,
      setAreaStartValue: () => undefined,
      areaRect: () => null,
      setAreaRectValue: () => undefined,
      editorAnchorRect: () => null,
      setEditorAnchorRectValue: () => undefined,
      task: () => taskFixture(),
      destroyed: () => false,
      routeKey: () => "/",
      host: () => undefined,
      overlayMount: () => document.createElement("div"),
      root: () => document.createElement("div"),
      scheduleFrame: vi.fn(() => 0),
      render: vi.fn(),
      emit: vi.fn(),
      captureListeners: () => listeners,
      appRoot: () => appRoot as unknown as Element,
      captureDocumentOf: () => documentSpy as unknown as Document,
      setStatus: vi.fn(),
      localized: vi.fn(),
      setInspectionFrozen: vi.fn(),
      setMarkerHighlight: vi.fn(),
    });
    controller.refreshCaptureDocuments();
    // The app-root document and the nested iframe document both received the
    // four capture listeners (the iframe was bound through its load hook).
    expect(documentSpy.added).toEqual(["pointermove", "pointerdown", "pointerup", "click"]);
    expect(frameDoc.added).toEqual(["pointermove", "pointerdown", "pointerup", "click"]);
    controller.clearCaptureDocuments();
    expect(documentSpy.removed).toEqual(["pointermove", "pointerdown", "pointerup", "click"]);
    expect(frameDoc.removed).toEqual(["pointermove", "pointerdown", "pointerup", "click"]);
    expect(frame.removed).toContain("load");
  });

  it("evidence controller's deferred screenshot is cancelled by the pre-capture route guard", () => {
    const captureSpy = vi.spyOn(screenshot, "captureViewportPng").mockResolvedValue(null);
    let route = "/a";
    let destroyed = false;
    let timer: (() => void) | null = null;
    const written: unknown[] = [];
    const setStatus = vi.fn();
    const controller = createEvidenceController({
      task: () => taskFixture(),
      routeKey: () => route,
      destroyed: () => destroyed,
      screenshotMode: () => "auto",
      canWriteEvidence: () => true,
      adoptTask: vi.fn(),
      record: vi.fn(),
      setStatus,
      localized: (value) => (typeof value === "string" ? value : value["en-US"] ?? ""),
      scheduleTimer: (callback) => { timer = callback; return 0; },
      appRoot: () => document,
      host: () => undefined,
      isInAppRoot: () => true,
      transport: () => ({
        writeEvidence: async (input) => { written.push(input); return taskFixture(); },
      }),
    });
    const input = {
      annotationId: "ann-1",
      taskId: "task-1",
      taskRevision: 0,
      routeKey: "/a",
      overlays: [],
    };
    controller.scheduleScreenshotEvidence(input);
    // Route changes before the deferred capture runs: the pre-capture guard
    // must stop the flow before any screenshot capture or status update.
    route = "/elsewhere";
    timer!();
    expect(captureSpy).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(setStatus).not.toHaveBeenCalled();
    captureSpy.mockRestore();
  });
});
