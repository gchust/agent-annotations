/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => ({
  elementsAtPoint: vi.fn<(...args: unknown[]) => Element[]>(() => []),
  freeze: vi.fn(),
  unfreeze: vi.fn(),
}));

vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(),
  freeze: primitives.freeze,
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
  unfreeze: primitives.unfreeze,
}));

import {
  inspectTarget,
  pruneRegionTargets,
  resolveTargetResult,
  sampleRegionTargets,
  setInspectionFrozen,
} from "../../src/client/inspection-engine.js";

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

  it("prunes wrapper-heavy candidates after collection and keeps semantic targets", () => {
    const wrapper = document.createElement("div");
    let parent = wrapper;
    const candidates: Element[] = [wrapper];
    for (let index = 0; index < 80; index += 1) {
      const child = document.createElement("div");
      parent.append(child);
      parent = child;
      candidates.push(child);
    }
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Checkout");
    parent.append(button);
    candidates.push(button);
    document.body.append(wrapper);
    expect(pruneRegionTargets(candidates)[0]).toBe(button);
  });

  it("resolves nested iframe and open shadow boundaries", () => {
    const outer = document.createElement("iframe");
    outer.id = "outer";
    document.body.append(outer);
    const inner = outer.contentDocument!.createElement("iframe");
    inner.id = "inner";
    outer.contentDocument!.body.append(inner);
    const host = inner.contentDocument!.createElement("section");
    host.id = "host";
    inner.contentDocument!.body.append(host);
    const target = inner.contentDocument!.createElement("button");
    target.id = "target";
    host.attachShadow({ mode: "open" }).append(target);
    expect(resolveTargetResult("#outer >>iframe>> #inner >>iframe>> #host >>> #target"))
      .toEqual({ status: "resolved", element: target });
  });

  it("reports cross-origin boundaries as unsupported", () => {
    const frame = document.createElement("iframe");
    frame.id = "remote";
    Object.defineProperty(frame, "contentDocument", { get: () => { throw new DOMException("Blocked"); } });
    document.body.append(frame);
    expect(resolveTargetResult("#remote >>iframe>> #target")).toMatchObject({ status: "unsupported" });
  });

  it("uses symmetric React Grab freeze/unfreeze calls", () => {
    const element = document.createElement("main");
    setInspectionFrozen(true, [element]);
    setInspectionFrozen(true, [element]);
    setInspectionFrozen(false);
    expect(primitives.freeze).toHaveBeenCalledOnce();
    expect(primitives.freeze).toHaveBeenCalledWith([element]);
    expect(primitives.unfreeze).toHaveBeenCalledOnce();
  });
});
