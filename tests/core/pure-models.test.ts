import { describe, expect, it, vi } from "vitest";

import type { AgentAnnotation } from "../../src/types/index.js";

import {
  AGENT_ANNOTATIONS_SHORTCUTS,
  agentAnnotationsAnchorRect,
  agentAnnotationsAnnotationDisplayNumber,
  countOpenAgentAnnotations,
  createAgentAnnotationsId,
  emptyAgentAnnotationsSelection,
  formatAgentAnnotationsShortcut,
  matchesAgentAnnotationsShortcut,
  normalizeAgentAnnotationsRegion,
  replaceAgentAnnotationsSelection,
  resolveAgentAnnotationsPlacement,
  selectAgentAnnotations,
  toAgentAnnotationsDocumentRegion,
  toggleAgentAnnotationsSelection,
} from "../../src/core/index.js";

describe("plain-data selection, placement and shortcut definitions", () => {
  it("creates stable-shape IDs", () => {
    const first = createAgentAnnotationsId();
    const second = createAgentAnnotationsId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(second).not.toBe(first);
  });

  it("creates secure IDs when randomUUID is unavailable on LAN HTTP", () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.set(Array.from({ length: 16 }, (_, index) => index));
        return bytes;
      },
    });
    try {
      expect(createAgentAnnotationsId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("selects open annotations while preserving full-order display numbers", () => {
    const annotations = [
      { annotationId: "one", status: "completed" },
      { annotationId: "two", status: "open" },
    ] as AgentAnnotation[];
    expect(selectAgentAnnotations(annotations)).toEqual([
      annotations[1],
    ]);
    expect(countOpenAgentAnnotations(annotations)).toBe(1);
    expect(agentAnnotationsAnnotationDisplayNumber(annotations, "two")).toBe(2);
  });

  it("handles selection without live DOM values", () => {
    let state = emptyAgentAnnotationsSelection<string>();
    state = replaceAgentAnnotationsSelection("one");
    state = toggleAgentAnnotationsSelection(state, "two");
    expect(state.targets).toEqual(["one", "two"]);
    expect(toggleAgentAnnotationsSelection(state, "one").targets).toEqual(["two"]);
    expect(
      toAgentAnnotationsDocumentRegion(
        normalizeAgentAnnotationsRegion(
          { x: -2, y: 5, width: 200, height: 50 },
          { width: 100, height: 40 }
        ),
        { x: 10, y: 20 }
      )
    ).toEqual({
      coordinateSpace: "document",
      x: 10,
      y: 25,
      width: 100,
      height: 35,
    });
  });

  it("places a surface with pure rect math", () => {
    expect(
      resolveAgentAnnotationsPlacement({
        trigger: agentAnnotationsAnchorRect({ left: 90, top: 80, width: 10, height: 10 }),
        viewport: { width: 120, height: 100 },
        width: 80,
        maxHeight: 30,
        surfaceHeight: 20,
      })
    ).toEqual({ left: 20, top: 52, width: 80, maxHeight: 30 });
  });

  it("matches platform-aware plain keyboard input including macOS symbol fallback", () => {
    const pick = AGENT_ANNOTATIONS_SHORTCUTS.find((shortcut) => shortcut.id === "pick");
    expect(pick).toBeDefined();
    if (!pick) return;
    expect(formatAgentAnnotationsShortcut(pick, "mac")).toBe("⌘⌥P");
    expect(formatAgentAnnotationsShortcut(pick, "other")).toBe("Ctrl+Alt+P");
    expect(
      matchesAgentAnnotationsShortcut(
        pick,
        { key: "π", code: "KeyP", metaKey: true, altKey: true },
        "mac"
      )
    ).toBe(true);
    expect(
      matchesAgentAnnotationsShortcut(
        pick,
        { key: "p", ctrlKey: true, altKey: true, editable: true },
        "other"
      )
    ).toBe(false);
  });
});
