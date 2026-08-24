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

describe("runtime-markers-capture", () => {

  it("creates one query-free page context while preserving hash routing and safe host overrides", () => {
    history.pushState({}, "", "/callback?code=oauth-secret#/customers");
    expect(createSafePageContext()).toMatchObject({
      url: `${location.origin}/callback`,
      routeKey: "/callback#/customers",
    });
    expect(createSafePageContext({
      pageContext: () => ({
        url: "https://tenant.example.test/customers",
        routeKey: "/tenant/acme/customers",
        title: "Acme customers",
      }),
    })).toMatchObject({
      url: "https://tenant.example.test/customers",
      routeKey: "/tenant/acme/customers",
      title: "Acme customers",
    });
    for (const pageContext of [
      { url: "https://example.test/callback?code=secret" },
      { url: "https://user:pass@example.test/customers" },
      { url: "https://example.test/#/customers" },
      { routeKey: "/customers?tenant=secret" },
      { routeKey: "/customers\nadmin" },
      { title: "x".repeat(501) },
      { routeKey: "/customers", extra: "secret" },
    ]) {
      const report = vi.fn();
      expect(createSafePageContext({ pageContext: () => pageContext }, report)).toMatchObject({
        url: `${location.origin}/callback`,
        routeKey: "/callback#/customers",
      });
      expect(report).toHaveBeenCalledOnce();
    }
  });



  it("isolates an invalid host page context, records one diagnostic, and keeps Studio usable", async () => {
    history.pushState({}, "", "/safe?reset=secret#/customers");
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      extensions: [defineClientExtension({
        id: "unsafe-host",
        apiVersion: 1,
        host: {
          pageContext: () => { throw new Error("host leaked reset=secret"); },
        },
      })],
    });
    try {
      const failures = mounted.api.getSnapshot().diagnostics.filter(
        (entry) => entry.extensionId === "unsafe-host" && entry.phase === "pageContext"
      );
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures)).not.toContain("reset=secret");
      mounted.api.commands.capture.startPick();
      expect(mounted.api.getSnapshot().captureMode).toBe("pick");
      mounted.api.commands.capture.cancel();
      expect(createSafePageContext({ pageContext: () => ({ routeKey: "/customers?tenant=secret" }) }).routeKey)
        .toBe("/safe#/customers");
    } finally {
      mounted.unmount();
    }
  });



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
    first.dataset.x = "10";
    const second = document.createElement("button");
    second.id = "multi-b";
    second.dataset.x = "20";
    document.body.append(first, second);
    primitives.getElementBounds.mockImplementation(((element: Element) => ({
      x: Number((element as HTMLElement).dataset.x ?? 0), y: 5, width: 40, height: 20,
    })) as typeof primitives.getElementBounds);
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
      expect([...highlights()].map((node) => node.style.left)).toEqual(["10px", "20px"]);
      first.dataset.x = "30";
      second.dataset.x = "40";
      window.dispatchEvent(new Event("scroll"));
      await vi.runAllTimersAsync();
      expect([...highlights()].map((node) => node.style.left)).toEqual(["30px", "40px"]);
      first.dataset.x = "50";
      second.dataset.x = "60";
      window.dispatchEvent(new Event("resize"));
      await vi.runAllTimersAsync();
      expect([...highlights()].map((node) => node.style.left)).toEqual(["50px", "60px"]);
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
      initialState: { collapsed: true },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    try {
      mounted.api.commands.markers.focus("ann-1");
      await vi.advanceTimersByTimeAsync(20);
      expect(shadow.querySelector(".aa-editor")).not.toBeNull();
      expect(shadow.querySelector(".aa-marker-highlight")).not.toBeNull();
      // Escape closes the editor, clears the highlight, and refocuses the
      // visible collapsed-count control (explicit collapsed state).
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
      initialState: { collapsed: true },
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
    history.pushState({}, "", "/settings");
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



  it("recovers a secondary multi target after nested iframe population and updates one shared snapshot", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", "/settings");
    document.body.innerHTML = '<div id="root"><button id="main-target">Main</button></div>';
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(taskFixture({
        annotations: [annotationFixture({
          kind: "multi",
          targets: [
            targetFixture({
              selector: "#main-target",
              inspection: { ...targetFixture().inspection, attributes: { id: "main-target" } },
            }),
            targetFixture({
              selector: "#outer >>iframe>> #inner >>iframe>> #target",
              inspection: { ...targetFixture().inspection, attributes: { id: "target" } },
            }),
          ],
        })],
      })),
    });
    try {
      const marker = document.getElementById("agent-annotations-root")!
        .shadowRoot!.querySelector<HTMLButtonElement>(".aa-marker")!;
      expect(marker.hidden).toBe(false);
      expect(marker.dataset.resolved).toBe("1");
      expect(marker.dataset.total).toBe("2");
      marker.dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(300);
      const tooltip = () => document.getElementById("agent-annotations-root")!.shadowRoot!
        .querySelector<HTMLElement>("[role=tooltip]")!;
      expect(tooltip().textContent).toContain("1/2 targets");
      await vi.runAllTimersAsync();

      const outer = document.createElement("iframe");
      outer.id = "outer";
      document.getElementById("root")!.append(outer);
      await vi.runAllTimersAsync();
      expect(marker.dataset.resolved).toBe("1");

      outer.contentDocument!.body.innerHTML = '<iframe id="inner"></iframe>';
      await vi.runAllTimersAsync();
      expect(marker.dataset.resolved).toBe("1");

      const inner = outer.contentDocument!.querySelector<HTMLIFrameElement>("#inner")!;
      inner.contentDocument!.body.innerHTML = '<button id="target">Target</button>';
      inner.dispatchEvent(new Event("load"));

      await vi.runAllTimersAsync();
      expect(marker.hidden).toBe(false);
      expect(marker.dataset.resolved).toBe("2");
      expect(tooltip().textContent).toContain("2/2 targets");
      expect(document.getElementById("agent-annotations-root")!.shadowRoot!
        .querySelectorAll(".aa-marker-highlight")).toHaveLength(2);
    } finally {
      mounted.unmount();
      document.body.innerHTML = "";
    }
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
      expect(mounted.api.getSnapshot().captureMode).toBe("idle");
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
});
