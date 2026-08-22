/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { CloseIcon, createIconSvg, DeleteIcon, SaveIcon } from "../../src/client/icons.js";

describe("built-in icon DOM factory", () => {
  it("builds the same controlled SVG from built-in components without react-dom/server", () => {
    const close = createIconSvg(CloseIcon);
    expect(close.tagName).toBe("svg");
    expect(close.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(close.getAttribute("aria-hidden")).toBe("true");
    expect(close.querySelectorAll("path").length).toBe(2);
    expect(close.querySelector("path")?.getAttribute("d")).toBe("M6 6l12 12");
    // No raw markup is injected: the SVG is assembled with createElementNS.
    expect(close.querySelectorAll("*").length).toBe(2);
    expect(close.children[0]?.tagName).toBe("path");
  });

  it("maps the registered path data per built-in component", () => {
    expect(createIconSvg(SaveIcon).querySelectorAll("path").length).toBe(1);
    expect(createIconSvg(DeleteIcon).querySelectorAll("path").length).toBe(5);
  });
});
