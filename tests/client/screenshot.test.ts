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
    expect(clone.querySelectorAll("[data-agent-annotations-media-placeholder]")).toHaveLength(3);
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

  it("strips form control values and editable text from the sanitized clone and SVG", () => {
    document.body.innerHTML = `
      <input id="text" value="SENTINEL_TEXT">
      <input id="password" type="password" value="SENTINEL_PASSWORD">
      <input id="checkbox" type="checkbox" checked>
      <textarea id="area">SENTINEL_AREA</textarea>
      <select id="select"><option value="a">A</option><option value="b" selected>B</option></select>
      <div id="editable" contenteditable="true">SENTINEL_EDITABLE</div>
    `;
    const clone = cloneScreenshotRoot(document.body);
    const serialized = new XMLSerializer().serializeToString(clone);
    expect(serialized).not.toContain("SENTINEL");
    expect(clone.querySelector("#text")?.getAttribute("value")).toBeNull();
    expect(clone.querySelector("#password")?.getAttribute("value")).toBeNull();
    expect(clone.querySelector("#checkbox")?.hasAttribute("checked")).toBe(false);
    expect(clone.querySelector("#area")?.textContent).toBe("");
    expect(clone.querySelector("#select option[selected]")).toBeNull();
    expect(clone.querySelector("#editable")?.textContent).toBe("");
    const text = clone.querySelector<HTMLInputElement>("#text")!;
    expect(text.defaultValue).toBe("");
    expect(text.value).toBe("");
    const checkbox = clone.querySelector<HTMLInputElement>("#checkbox")!;
    expect(checkbox.defaultChecked).toBe(false);
    expect(checkbox.checked).toBe(false);
    const area = clone.querySelector<HTMLTextAreaElement>("#area")!;
    expect(area.defaultValue).toBe("");
    const select = clone.querySelector<HTMLSelectElement>("#select")!;
    expect([...select.options].every((option) => option.defaultSelected === false)).toBe(true);
    const svg = buildScreenshotSvg(serialized, 800, 600, 800, 600, 0, 0);
    expect(svg).not.toContain("SENTINEL");
  });

  it("keeps a neutral password placeholder while clearing other live form state", () => {
    document.body.innerHTML = '<input id="password" type="password" value="SENTINEL_PASSWORD">';
    const clone = cloneScreenshotRoot(document.body);
    const input = clone.querySelector<HTMLInputElement>("#password")!;
    expect(input.value).toBe("••••••");
    expect(input.getAttribute("value")).toBeNull();
  });
});
