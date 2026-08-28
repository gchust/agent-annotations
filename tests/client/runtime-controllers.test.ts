/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTaskController } from "../../src/client/runtime/task.js";
import { createGuardedHostIntegration, createHostController } from "../../src/client/runtime/host.js";
import { createDiagnosticsController } from "../../src/client/runtime/diagnostics.js";
import { createMarkerController } from "../../src/client/runtime/markers.js";
import { createEvidenceController } from "../../src/client/runtime/evidence.js";
import { createCaptureController } from "../../src/client/runtime/capture.js";
import { createBrowserStatusController } from "../../src/client/runtime/browser-status.js";
import {
  browserSessionStorageKey,
  clearBrowserSessionState,
  restoreBrowserSessionState,
} from "../../src/client/runtime/browser-session.js";
import * as screenshot from "../../src/client/screenshot.js";
import { RevisionConflictError } from "../../src/core/index.js";
import type { AgentAnnotationsRect, StudioPublicSnapshot } from "../../src/types/index.js";
type StudioPublicShortcut = StudioPublicSnapshot["shortcuts"][number];
import { annotationFixture, targetFixture, taskFixture } from "../core/test-data.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";

afterEach(() => {
  try { sessionStorage.clear(); } catch {}
  vi.unstubAllGlobals();
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("runtime controllers (focused factory contracts)", () => {
  it("restores strict endpoint-scoped browser session state and replaces invalid values", () => {
    const first = restoreBrowserSessionState("/__agent-annotations");
    expect(first).toMatchObject({ runtimeId: expect.any(String), browserUpdateRevision: 0 });
    expect(restoreBrowserSessionState("/__agent-annotations")).toEqual(first);
    expect(restoreBrowserSessionState("/other-endpoint").runtimeId).not.toBe(first.runtimeId);

    const invalid = [
      "{broken",
      JSON.stringify({ runtimeId: "", browserUpdateRevision: 1 }),
      JSON.stringify({ runtimeId: "runtime-old", browserUpdateRevision: -1 }),
      JSON.stringify({ runtimeId: "runtime-old", browserUpdateRevision: 1.5 }),
      JSON.stringify({ runtimeId: "runtime-old", browserUpdateRevision: Number.MAX_SAFE_INTEGER + 1 }),
      JSON.stringify({ runtimeId: "runtime-old", browserUpdateRevision: 1, extra: true }),
    ];
    invalid.forEach((value, index) => {
      const endpoint = `/invalid-${index}`;
      const runtimeId = `runtime-${index}`;
      sessionStorage.setItem(browserSessionStorageKey(endpoint), value);
      expect(restoreBrowserSessionState(endpoint, runtimeId)).toEqual({
        runtimeId,
        browserUpdateRevision: 0,
      });
      expect(JSON.parse(sessionStorage.getItem(browserSessionStorageKey(endpoint))!)).toEqual({
        runtimeId,
        browserUpdateRevision: 0,
      });
    });
    expect(() => restoreBrowserSessionState("/invalid-id", "../escape")).toThrow(/runtimeId/);
    clearBrowserSessionState("/__agent-annotations");
    expect(sessionStorage.getItem(browserSessionStorageKey("/__agent-annotations"))).toBeNull();
  });

  it("keeps working when session storage reads, writes, and removals fail", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("disabled"); },
      removeItem: () => { throw new Error("disabled"); },
    });
    expect(restoreBrowserSessionState("/__agent-annotations", "runtime-fallback")).toEqual({
      runtimeId: "runtime-fallback",
      browserUpdateRevision: 0,
    });
    expect(() => clearBrowserSessionState("/__agent-annotations")).not.toThrow();
  });

  it("restores controller revisions across remounts without advancing for task-only updates", async () => {
    const endpoint = "/__agent-annotations";
    sessionStorage.setItem(browserSessionStorageKey(endpoint), JSON.stringify({
      runtimeId: "runtime-continuity",
      browserUpdateRevision: 7,
    }));
    const state = { task: taskFixture() };
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) =>
      String(input).endsWith("/revision")
        ? new Response(JSON.stringify({
            taskId: state.task.taskId,
            taskRevision: state.task.taskRevision,
            referencedSourceRevision: null,
            referencedSourceFiles: [],
          }), { status: 200 })
        : new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = () => createBrowserStatusController({
      config: { endpoint, token: "status-token" },
      task: () => state.task,
      setTaskValue: (task) => { state.task = task; },
      routeKey: () => "/settings",
      destroyed: () => false,
      annotationHealth: () => [],
      resetResolutionSnapshots: () => undefined,
      scheduleTimer: () => 0,
    });

    const first = controller();
    expect(first.runtimeId).toBe("runtime-continuity");
    expect(first.browserUpdateRevision()).toBe(7);
    first.setTask({ ...state.task, taskRevision: 1 });
    expect(first.browserUpdateRevision()).toBe(7);
    first.reportBrowserUpdate();
    expect(first.browserUpdateRevision()).toBe(8);
    expect(JSON.parse(sessionStorage.getItem(browserSessionStorageKey(endpoint))!))
      .toEqual({ runtimeId: "runtime-continuity", browserUpdateRevision: 8 });

    const remounted = controller();
    expect(remounted.runtimeId).toBe(first.runtimeId);
    expect(remounted.browserUpdateRevision()).toBe(8);
    remounted.reportBrowserUpdate();
    expect(remounted.browserUpdateRevision()).toBe(9);
    remounted.removeBrowserState();
    expect(sessionStorage.getItem(browserSessionStorageKey(endpoint))).toBeNull();
    await Promise.resolve();
  });

  it("keeps the Browser State v2 revision safe at its numeric ceiling", () => {
    const endpoint = "/__agent-annotations";
    sessionStorage.setItem(browserSessionStorageKey(endpoint), JSON.stringify({
      runtimeId: "runtime-ceiling",
      browserUpdateRevision: Number.MAX_SAFE_INTEGER,
    }));
    const task = taskFixture();
    const controller = createBrowserStatusController({
      config: { endpoint, token: "status-token" },
      task: () => task,
      setTaskValue: () => undefined,
      routeKey: () => "/",
      destroyed: () => false,
      annotationHealth: () => [],
      resetResolutionSnapshots: () => undefined,
      scheduleTimer: () => 0,
    });
    controller.reportBrowserUpdate();
    expect(controller.browserUpdateRevision()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("serializes heartbeats and replaces pending work with the latest snapshot", async () => {
    const endpoint = "/__agent-annotations";
    sessionStorage.setItem(browserSessionStorageKey(endpoint), JSON.stringify({
      runtimeId: "runtime-queue",
      browserUpdateRevision: 4,
    }));
    const state = { task: taskFixture(), routeKey: "/initial" };
    const heartbeats: Array<{
      body: Record<string, unknown>;
      response: ReturnType<typeof deferred<Response>>;
    }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (!String(input).endsWith("/heartbeat")) {
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      const response = deferred<Response>();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      heartbeats.push({
        body: JSON.parse(init!.body as string),
        response,
      });
      return response.promise.finally(() => { inFlight -= 1; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = createBrowserStatusController({
      config: { endpoint, token: "status-token" },
      task: () => state.task,
      setTaskValue: (task) => { state.task = task; },
      routeKey: () => state.routeKey,
      destroyed: () => false,
      annotationHealth: () => [],
      resetResolutionSnapshots: () => undefined,
      scheduleTimer: () => 0,
    });

    controller.reportBrowserUpdate();
    controller.setTask({ ...state.task, taskRevision: 1 });
    state.routeKey = "/intermediate";
    controller.sendHeartbeat();
    controller.reportBrowserUpdate();
    controller.setTask({ ...state.task, taskRevision: 2 });
    state.routeKey = "/latest";
    controller.sendHeartbeat();

    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]!.body.browserUpdateRevision).toBe(5);
    expect(inFlight).toBe(1);
    heartbeats[0]!.response.resolve(new Response(
      JSON.stringify({ error: "stale_browser_state" }),
      { status: 409 }
    ));
    await vi.waitFor(() => expect(heartbeats).toHaveLength(2));
    expect(heartbeats.map(({ body }) => body.browserUpdateRevision)).toEqual([5, 6]);
    expect(heartbeats[1]!.body).toMatchObject({
      routeKey: "/latest",
      taskRevision: 2,
      browserUpdateRevision: 6,
    });
    expect(maxInFlight).toBe(1);
    heartbeats[1]!.response.resolve(new Response("{}", { status: 200 }));
    await vi.waitFor(() => expect(inFlight).toBe(0));
    expect(heartbeats).toHaveLength(2);
  });

  it("drains the latest pending heartbeat after failure and drops work when stopped", async () => {
    const state = { task: taskFixture(), routeKey: "/initial", destroyed: false };
    const requests: Array<{
      body: Record<string, unknown>;
      response: ReturnType<typeof deferred<Response>>;
    }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      if (!String(input).endsWith("/heartbeat")) {
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      const response = deferred<Response>();
      requests.push({ body: JSON.parse(init!.body as string), response });
      return response.promise;
    }));
    const controller = createBrowserStatusController({
      config: { endpoint: "/__agent-annotations", token: "status-token", runtimeId: "runtime-failure" },
      task: () => state.task,
      setTaskValue: (task) => { state.task = task; },
      routeKey: () => state.routeKey,
      destroyed: () => state.destroyed,
      annotationHealth: () => [],
      resetResolutionSnapshots: () => undefined,
      scheduleTimer: () => 0,
    });

    controller.sendHeartbeat();
    state.routeKey = "/after-failure";
    controller.sendHeartbeat();
    requests[0]!.response.reject(new Error("offline"));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.body.routeKey).toBe("/after-failure");

    state.routeKey = "/must-not-send";
    controller.sendHeartbeat();
    controller.stopHeartbeats();
    state.destroyed = true;
    requests[1]!.response.resolve(new Response("{}", { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(2);
  });

  it("isolates every host callback and disposer with safe fallbacks", () => {
    const fault = (name: string) => () => { throw new Error(`${name} secret=hidden`); };
    let subscriptions = 0;
    const source = {
      locale: fault("locale"),
      theme: fault("theme"),
      brandColor: () => "red",
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
    expect(host.brandColor?.()).toBeUndefined();
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
      "locale", "theme", "brandColor", "appRoot", "pageContext", "routeKey", "identity",
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
      commit: () => undefined,
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
    const commit = vi.fn();
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
      commit,
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
      commit: emit,
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
      refreshChrome: vi.fn(),
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
      localized: (value) => value,
      resolutionChanged: vi.fn(),
    });
    controller.scheduleMarkerRefresh();
    controller.stopMarkerTracking();
    expect(cancelled.length).toBe(1);
  });

  it("caches one identity-safe resolution per target and checks every iframe target", () => {
    document.body.innerHTML = '<button id="main-target">Main</button><iframe id="secondary-frame"></iframe>';
    const identity = vi.fn((element: Element) => ({ id: element.id }));
    const task = taskFixture({ annotations: [annotationFixture({
      kind: "multi",
      targets: [
        targetFixture({
          selector: "#main-target",
          inspection: { ...targetFixture().inspection, attributes: { "host:id": "main-target" } },
        }),
        targetFixture({
          selector: "#secondary-frame >>iframe>> #late-target",
          inspection: { ...targetFixture().inspection, attributes: { "host:id": "late-target" } },
        }),
      ],
    })] });
    const controller = createMarkerController({
      task: () => task,
      routeKey: () => "/settings",
      markersVisible: () => true,
      appRoot: () => document,
      host: () => ({ identity }),
      overlayMount: () => document.createElement("div"),
      hostElement: () => document.createElement("div"),
      editingId: () => null,
      hasElementComposer: () => false,
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      isInAppRoot: () => true,
      positionComposer: vi.fn(),
      positionEditor: vi.fn(),
      localized: (value) => value,
      resolutionChanged: vi.fn(),
    });
    const annotation = task.annotations[0]!;
    expect(controller.resolutionSnapshot(annotation).summary).toMatchObject({ resolved: 1, total: 2 });
    expect(controller.resolutionSnapshot(annotation).anchor).toBe(document.getElementById("main-target"));
    expect(identity).toHaveBeenCalledTimes(1);
    expect(controller.hasUnresolvedFrameTarget()).toBe(true);
    expect(identity).toHaveBeenCalledTimes(1);
    document.body.innerHTML = "";
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
      commit: vi.fn(),
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

  it("evidence controller's deferred render is cancelled by the route guard", () => {
    const renderSpy = vi.spyOn(screenshot, "renderPreparedSnapshotPng").mockResolvedValue(null);
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
      setInspectionFrozen: vi.fn(),
      transport: () => ({
        writeEvidence: async (input) => { written.push(input); return taskFixture(); },
      }),
    });
    const input = {
      annotationId: "ann-1",
      taskId: "task-1",
      taskRevision: 0,
      routeKey: "/a",
      snapshot: {
        svg: "<svg/>", width: 1, height: 1, scale: 1, overlays: [], startedAt: 0,
      },
    };
    controller.scheduleScreenshotEvidence(input);
    // Route changes before the deferred capture runs: the pre-capture guard
    // must stop the flow before any screenshot capture or status update.
    route = "/elsewhere";
    timer!();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(setStatus).not.toHaveBeenCalled();
    renderSpy.mockRestore();
  });
});
