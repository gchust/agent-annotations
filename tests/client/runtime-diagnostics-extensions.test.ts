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

describe("runtime-diagnostics-extensions", () => {


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
    await expect(pending).rejects.toMatchObject({ name: "TaskTransportProtocolError" });
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



  it("expands from the collapsed count when the list builtin is disabled", async () => {
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: true },
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
      mounted.api.commands.markers.hide();
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



  it("defers the background capture through the tracked timer so unmount cancels it", async () => {
    vi.useFakeTimers();
    const pageTarget = document.createElement("button");
    document.body.append(pageTarget);
    primitives.getElementAtPoint.mockReturnValue(pageTarget);
    screenshot.renderPreparedSnapshotPng.mockResolvedValue({ png: "fake-png", width: 100, height: 100, durationMs: 1, bestEffort: true });
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
    // Save 1: preparation is synchronous while rendering is deferred.
    await submitSave("Deferred save");
    expect(screenshot.prepareViewportSnapshot).toHaveBeenCalledTimes(1);
    expect(screenshot.renderPreparedSnapshotPng).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(screenshot.renderPreparedSnapshotPng).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeEvidence).toHaveBeenCalledTimes(1);
    // Save 2: unmount cancels the pending render, after preparation is complete.
    await submitSave("Cancelled capture");
    expect(screenshot.prepareViewportSnapshot).toHaveBeenCalledTimes(2);
    expect(screenshot.renderPreparedSnapshotPng).toHaveBeenCalledTimes(1);
    mounted.unmount();
    await vi.runOnlyPendingTimersAsync();
    expect(screenshot.renderPreparedSnapshotPng).toHaveBeenCalledTimes(1);
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
});
