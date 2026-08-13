/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

import {
  buildScreenshotSvg,
  cloneScreenshotRoot,
  computeScreenshotScale,
  inlineScreenshotStyle,
} from "../../src/client/screenshot.js";

describe("best-effort screenshot evidence", () => {
  it("copies Card layout with valid kebab-case CSS properties", () => {
    const source = document.createElement("article");
    const clone = document.createElement("article");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (property: string) => ({
        "background-color": "rgb(10, 20, 30)", "font-family": "Inter", "font-size": "16px",
        "padding-top": "12px", "padding-right": "14px", "padding-bottom": "16px", "padding-left": "18px",
        "border-top-width": "1px", "border-top-style": "solid", "border-top-color": "rgb(1, 2, 3)",
      })[property] ?? "",
    } as CSSStyleDeclaration);

    inlineScreenshotStyle(source, clone);

    expect(clone.getAttribute("style")).toContain("background-color:rgb(10, 20, 30)");
    expect(clone.getAttribute("style")).toContain("font-family:Inter");
    expect(clone.getAttribute("style")).toContain("padding-left:18px");
    expect(clone.getAttribute("style")).toContain("border-top-width:1px");
    expect(clone.getAttribute("style")).not.toMatch(/[A-Z][A-Za-z]*:/);
  });

  it("keeps media placeholders and following clone styles aligned", () => {
    document.body.innerHTML = '<main><img src="secret.png"><canvas></canvas><iframe></iframe><p id="after">After</p></main>';
    const main = document.querySelector("main")!;
    for (const media of main.querySelectorAll("img,canvas,iframe")) {
      vi.spyOn(media, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40,
        toJSON: () => undefined,
      });
    }
    const clone = cloneScreenshotRoot(main);
    expect(clone.querySelectorAll("[data-agent-feedback-media-placeholder]")).toHaveLength(3);
    expect(clone.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(clone.querySelector("#after")?.textContent).toBe("After");
  });

  it("lays out a large viewport at native dimensions before scaling and applies scroll translation", () => {
    expect(computeScreenshotScale(1920, 1080)).toBeCloseTo(5 / 6);
    const svg = buildScreenshotSvg("<main />", 1920, 1080, 1600, 900, 30, 700);
    expect(svg).toContain('viewBox="0 0 1920 1080"');
    expect(svg).toContain("width:1920px;height:1080px");
    expect(svg).toContain("left:-30px;top:-700px");
  });
});
