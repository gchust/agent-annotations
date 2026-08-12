/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => ({
  elementsAtPoint: vi.fn<(...args: unknown[]) => Element[]>(() => []),
}));

vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(),
  getElementAtPoint: vi.fn(),
  getElementBounds: vi.fn((element: Element) => ({
    x: Number(element.getAttribute("data-x") ?? 1), y: 2, width: 30, height: 20,
  })),
  getElementContext: vi.fn(async () => ({
    htmlPreview: "<button>Save</button>", stack: [], componentName: "SaveButton",
    filePath: "/src/App.tsx", lineNumber: 12, columnNumber: 4, styles: "color: red;",
  })),
  getElementSelector: vi.fn(() => "#save"),
  getElementsAtPoint: primitives.elementsAtPoint,
  isElementGrabbable: vi.fn(() => true),
}));

import { inspectTarget, sampleRegionTargets } from "../../src/client/inspection-engine.js";

describe("React Grab inspection boundary", () => {
  it("normalizes one generic target without host vocabulary", async () => {
    document.body.innerHTML = '<button id="save" aria-label="Save">Save</button>';
    const target = await inspectTarget(document.querySelector("button")!);
    expect(target).toMatchObject({
      selector: "#save",
      inspection: {
        role: "button",
        accessibleName: "Save",
        source: { filePath: "/src/App.tsx", lineNumber: 12, columnNumber: 5 },
      },
    });
  });

  it("uses bounded point stacks for Area and never scans the DOM", () => {
    const one = document.createElement("button");
    const two = document.createElement("a");
    primitives.elementsAtPoint.mockReturnValue([one, one, two]);
    const scan = vi.spyOn(document, "querySelectorAll");
    expect(sampleRegionTargets({ x: 0, y: 0, width: 300, height: 240 })).toEqual([one, two]);
    expect(primitives.elementsAtPoint.mock.calls.length).toBeLessThanOrEqual(69);
    expect(scan).not.toHaveBeenCalledWith("*");
    scan.mockRestore();
  });
});
