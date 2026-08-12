import { describe, expect, it } from "vitest";

import type { AgentFeedbackAnnotation } from "../../src/types/index.js";

import {
  AGENT_FEEDBACK_SHORTCUTS,
  agentFeedbackAnchorRect,
  agentFeedbackAnnotationDisplayNumber,
  countOpenAgentFeedbackAnnotations,
  createAgentFeedbackId,
  emptyAgentFeedbackSelection,
  formatAgentFeedbackShortcut,
  matchesAgentFeedbackShortcut,
  normalizeAgentFeedbackRegion,
  replaceAgentFeedbackSelection,
  resolveAgentFeedbackPlacement,
  selectAgentFeedbackAnnotations,
  toAgentFeedbackDocumentRegion,
  toggleAgentFeedbackSelection,
} from "../../src/core/index.js";

describe("plain-data selection, placement and shortcut definitions", () => {
  it("creates stable-shape IDs", () => {
    const first = createAgentFeedbackId();
    const second = createAgentFeedbackId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(second).not.toBe(first);
  });

  it("selects open annotations while preserving full-order display numbers", () => {
    const annotations = [
      { annotationId: "one", status: "completed" },
      { annotationId: "two", status: "open" },
    ] as AgentFeedbackAnnotation[];
    expect(selectAgentFeedbackAnnotations(annotations)).toEqual([
      annotations[1],
    ]);
    expect(countOpenAgentFeedbackAnnotations(annotations)).toBe(1);
    expect(agentFeedbackAnnotationDisplayNumber(annotations, "two")).toBe(2);
  });

  it("handles selection without live DOM values", () => {
    let state = emptyAgentFeedbackSelection<string>();
    state = replaceAgentFeedbackSelection("one");
    state = toggleAgentFeedbackSelection(state, "two");
    expect(state.targets).toEqual(["one", "two"]);
    expect(toggleAgentFeedbackSelection(state, "one").targets).toEqual(["two"]);
    expect(
      toAgentFeedbackDocumentRegion(
        normalizeAgentFeedbackRegion(
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
      resolveAgentFeedbackPlacement({
        trigger: agentFeedbackAnchorRect({ left: 90, top: 80, width: 10, height: 10 }),
        viewport: { width: 120, height: 100 },
        width: 80,
        maxHeight: 30,
        surfaceHeight: 20,
      })
    ).toEqual({ left: 20, top: 52, width: 80, maxHeight: 30 });
  });

  it("matches platform-aware plain keyboard input including macOS symbol fallback", () => {
    const pick = AGENT_FEEDBACK_SHORTCUTS.find((shortcut) => shortcut.id === "pick");
    expect(pick).toBeDefined();
    if (!pick) return;
    expect(formatAgentFeedbackShortcut(pick, "mac")).toBe("⌘⌥P");
    expect(formatAgentFeedbackShortcut(pick, "other")).toBe("Ctrl+Alt+P");
    expect(
      matchesAgentFeedbackShortcut(
        pick,
        { key: "π", code: "KeyP", metaKey: true, altKey: true },
        "mac"
      )
    ).toBe(true);
    expect(
      matchesAgentFeedbackShortcut(
        pick,
        { key: "p", ctrlKey: true, altKey: true, editable: true },
        "other"
      )
    ).toBe(false);
  });
});
