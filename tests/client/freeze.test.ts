/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => ({ freeze: vi.fn(), unfreeze: vi.fn() }));
vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(), freeze: primitives.freeze, unfreeze: primitives.unfreeze,
  getElementAtPoint: vi.fn(), getElementBounds: vi.fn(), getElementContext: vi.fn(),
  getElementSelector: vi.fn(), getElementsAtPoint: vi.fn(), isElementGrabbable: vi.fn(),
}));

import { disposeInspectionEngine, setInspectionFrozen } from "../../src/client/inspection-engine.js";

describe("React Grab freeze lifecycle", () => {
  afterEach(() => { disposeInspectionEngine(); primitives.freeze.mockClear(); primitives.unfreeze.mockClear(); });

  it("freezes and unfreezes once per symmetric transition", () => {
    setInspectionFrozen(true);
    setInspectionFrozen(true);
    setInspectionFrozen(false);
    setInspectionFrozen(false);
    expect(primitives.freeze).toHaveBeenCalledTimes(1);
    expect(primitives.unfreeze).toHaveBeenCalledTimes(1);
  });
});
