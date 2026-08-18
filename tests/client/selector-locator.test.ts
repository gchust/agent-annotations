/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { resolveTargetResult } from "../../src/client/inspection-engine.js";

describe("cross-realm selector recovery", () => {
  it("resolves nested iframe and iframe/open-shadow selectors", () => {
    document.body.innerHTML = '<iframe id="outer"></iframe>';
    const outer = document.querySelector<HTMLIFrameElement>("#outer")!;
    outer.contentDocument!.body.innerHTML = '<iframe id="inner"></iframe><div id="host"></div>';
    const inner = outer.contentDocument!.querySelector<HTMLIFrameElement>("#inner")!;
    inner.contentDocument!.body.innerHTML = '<button id="nested">Nested</button>';
    const host = outer.contentDocument!.querySelector("#host")!;
    host.attachShadow({ mode: "open" }).innerHTML = '<button id="shadow-target">Shadow</button>';

    expect(resolveTargetResult("#outer >>iframe>> #inner >>iframe>> #nested")).toMatchObject({
      status: "resolved",
      element: inner.contentDocument!.querySelector("#nested"),
    });
    expect(resolveTargetResult("#outer >>iframe>> #host >>> #shadow-target")).toMatchObject({
      status: "resolved",
      element: host.shadowRoot!.querySelector("#shadow-target"),
    });
  });

  it("treats an Element root and its descendant matching the same first segment as ambiguous", () => {
    const root = document.createElement("div");
    root.id = "shared-segment";
    const descendant = document.createElement("span");
    descendant.id = "shared-segment";
    root.append(descendant);
    expect(resolveTargetResult("#shared-segment", root)).toMatchObject({
      status: "ambiguous",
      reason: "ambiguous segment: #shared-segment",
    });
  });

  it("reports a cross-origin/unavailable boundary without throwing", () => {
    const frame = document.createElement("iframe");
    frame.id = "blocked";
    Object.defineProperty(frame, "contentDocument", { get: () => { throw new DOMException("blocked", "SecurityError"); } });
    document.body.append(frame);
    expect(resolveTargetResult("#blocked >>iframe>> #target")).toEqual({
      status: "unsupported",
      reason: "cross-origin iframe",
    });
  });
});
