/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => ({ elementsAtPoint: vi.fn<(...args: unknown[]) => Element[]>(() => []) }));
vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(), freeze: vi.fn(), unfreeze: vi.fn(),
  getElementAtPoint: vi.fn(), getElementBounds: vi.fn(), getElementContext: vi.fn(),
  getElementSelector: vi.fn(), getElementsAtPoint: primitives.elementsAtPoint,
  isElementGrabbable: vi.fn(() => false),
}));

import {
  pruneRegionTargets,
  REGION_CANDIDATE_LIMIT,
  REGION_TARGET_LIMIT,
  sampleRegionTargets,
} from "../../src/client/inspection-engine.js";

describe("Region semantic pruning", () => {
  it("keeps semantic descendants after collecting wrapper-heavy candidates", () => {
    const candidates: Element[] = [];
    for (let index = 0; index < REGION_CANDIDATE_LIMIT / 2; index += 1) {
      const wrapper = document.createElement("div");
      const child = document.createElement("button");
      child.textContent = `Action ${index}`;
      wrapper.append(child);
      candidates.push(wrapper, child);
    }
    const started = performance.now();
    const result = pruneRegionTargets(candidates.slice(0, REGION_CANDIDATE_LIMIT)).slice(0, REGION_TARGET_LIMIT);
    console.log(`region-prune-200 durationMs=${(performance.now() - started).toFixed(3)}`);
    expect(result).toHaveLength(REGION_TARGET_LIMIT);
    expect(result.every((element) => element.tagName === "BUTTON")).toBe(true);
  });

  it("keeps a semantic region target even when React Grab does not consider it directly grabbable", () => {
    const button = document.createElement("button");
    button.textContent = "Save";
    document.body.append(button);
    primitives.elementsAtPoint.mockReturnValue([]);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(button);
    expect(sampleRegionTargets({ x: 0, y: 0, width: 20, height: 20 })).toEqual([button]);
  });
});
