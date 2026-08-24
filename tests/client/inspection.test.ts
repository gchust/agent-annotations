/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => ({
  elementsAtPoint: vi.fn<(...args: unknown[]) => Element[]>(() => []),
  freeze: vi.fn(),
  selector: vi.fn<(element: Element) => string>(() => "#save"),
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
  getElementSelector: primitives.selector,
  getElementsAtPoint: primitives.elementsAtPoint,
  isElementGrabbable: vi.fn(() => true),
  unfreeze: primitives.unfreeze,
}));

import {
  inspectTarget,
  pruneRegionTargets,
  resolvePersistedTarget,
  resolveTargetResult,
  sampleRegionTargets,
  setInspectionFrozen,
} from "../../src/client/inspection-engine.js";
import { parseAgentAnnotationsTask } from "../../src/core/index.js";
import type { AgentAnnotationsTarget, HostIntegration } from "../../src/types/index.js";
import { annotationFixture, taskFixture } from "../core/test-data.js";

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

  it("repairs an upstream ancestor selector and restores its legacy target exactly", async () => {
    document.body.innerHTML = `
      <aside aria-label="About this application">
        <div><p>Keep authentication reliable.</p></div>
      </aside>`;
    const paragraph = document.querySelector("p")!;
    const ancestorSelector = '[aria-label="About this application"]';
    primitives.selector.mockReturnValueOnce(ancestorSelector);

    const target = await inspectTarget(paragraph);
    expect(target.selector).toBe(
      `${ancestorSelector} > div:nth-child(1) > p:nth-child(1)`
    );
    expect(resolveTargetResult(target.selector)).toEqual({
      status: "resolved",
      element: paragraph,
    });
    expect(resolvePersistedTarget(
      { ...target, selector: ancestorSelector },
      { appRoot: document.body }
    )).toEqual({ status: "resolved", element: paragraph });
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

describe("persisted target identity", () => {
  const hostIdentity = (element: Element): Record<string, string> => ({
    "data-card": element.getAttribute("data-card") ?? "",
  });
  const host: HostIntegration = { identity: hostIdentity };

  const persisted = (overrides: Partial<AgentAnnotationsTarget> = {}): AgentAnnotationsTarget => ({
    selector: "main > button",
    bounds: { x: 10, y: 20, width: 120, height: 32 },
    inspection: {
      tagName: "button",
      role: "button",
      accessibleName: "Save",
      text: "Save",
      componentName: null,
      source: null,
      sourceStack: [],
      htmlPreview: "",
      styleText: "",
      attributes: { id: "save", "host:data-card": "card-7" },
    },
    ...overrides,
  });

  it("captures host identity under the reserved host: prefix while keeping plain keys", async () => {
    document.body.innerHTML = '<button id="save" data-card="card-7">Save</button>';
    const target = await inspectTarget(document.querySelector("button")!, host);
    expect(target.inspection.attributes).toMatchObject({
      id: "save",
      role: "button",
      "aria-label": "Save",
      "host:data-card": "card-7",
    });
  });

  it("resolves a unique selector with matching id and host identity", () => {
    document.body.innerHTML = '<main><button id="save" data-card="card-7">Save</button></main>';
    const target = persisted();
    const result = resolvePersistedTarget(target, { appRoot: document, host });
    expect(result).toEqual({ status: "resolved", element: document.querySelector("button") });
  });

  it("rejects a unique selector whose id changed after a DOM reorder", () => {
    // The selector is unique but now points at a different business element.
    document.body.innerHTML = '<main><button id="a">A</button><button id="b">B</button></main>';
    const target = persisted({ selector: "main > button:nth-child(2)" });
    const result = resolvePersistedTarget(target, { appRoot: document, host });
    expect(result).toMatchObject({ status: "identity_mismatch", reason: "element id changed" });
  });

  it("rejects a unique selector whose host identity changed", () => {
    document.body.innerHTML = '<main><button id="save" data-card="card-8">Save</button></main>';
    const target = persisted({
      inspection: {
        ...persisted().inspection,
        attributes: { "host:data-card": "card-7" },
      },
    });
    const result = resolvePersistedTarget(target, { appRoot: document, host });
    expect(result).toMatchObject({ status: "identity_mismatch", reason: "host identity changed" });
  });

  it("rejects a selector whose tag name changed", () => {
    document.body.innerHTML = '<main><div id="save">Save</div></main>';
    const result = resolvePersistedTarget(
      persisted({ selector: "main > div" }),
      { appRoot: document, host }
    );
    expect(result).toMatchObject({ status: "identity_mismatch", reason: "element tag changed" });
  });

  it("resolves with host identity but no persisted id", () => {
    document.body.innerHTML = '<main><button data-card="card-7">Save</button></main>';
    const target = persisted({
      inspection: {
        ...persisted().inspection,
        attributes: { "host:data-card": "card-7" },
      },
    });
    const result = resolvePersistedTarget(target, { appRoot: document, host });
    expect(result).toEqual({ status: "resolved", element: document.querySelector("button") });
  });

  it("restores old tasks with exact weak identity when no strong evidence exists", () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    const target = persisted({
      inspection: {
        ...persisted().inspection,
        attributes: { role: "button", "aria-label": "Save" },
      },
    });
    expect(resolvePersistedTarget(target, { appRoot: document, host })).toMatchObject({
      status: "resolved",
    });
    // A changed accessible name is an exact mismatch, never fuzzy.
    document.body.innerHTML = '<main><button>Submit</button></main>';
    expect(resolvePersistedTarget(target, { appRoot: document, host })).toMatchObject({
      status: "identity_mismatch",
      reason: "accessible name changed",
    });
  });

  it("returns identity_unverifiable for old tasks without any identity evidence", () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    const target = persisted({
      inspection: {
        ...persisted().inspection,
        role: "",
        accessibleName: "",
        attributes: {},
      },
    });
    const result = resolvePersistedTarget(target, { appRoot: document, host });
    expect(result).toMatchObject({ status: "identity_unverifiable" });
  });

  it("keeps shadow-root and iframe recovery identity-aware", () => {
    document.body.innerHTML = '<main></main>';
    const hostNode = document.createElement("section");
    hostNode.id = "host";
    document.querySelector("main")!.append(hostNode);
    const targetNode = document.createElement("button");
    targetNode.id = "target";
    hostNode.attachShadow({ mode: "open" }).append(targetNode);
    const target = persisted({
      selector: "main > #host >>> #target",
      inspection: { ...persisted().inspection, attributes: { id: "target" } },
    });
    expect(resolvePersistedTarget(target, { appRoot: document, host })).toEqual({
      status: "resolved",
      element: targetNode,
    });
  });

  it("normalizes long host identity keys to fit the schema attribute limit", async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const target = await inspectTarget(document.querySelector("button")!, {
      identity: () => ({ ["k".repeat(100)]: "v" }),
    });
    const persistedKey = Object.keys(target.inspection.attributes)
      .find((key) => key.startsWith("host:"))!;
    expect(persistedKey).toBe(`host:${"k".repeat(95)}`);
    expect(persistedKey.length).toBeLessThanOrEqual(100);
    // The captured target must pass strict schema validation.
    const task = taskFixture({ annotations: [annotationFixture({ targets: [target] })] });
    expect(() => parseAgentAnnotationsTask(task)).not.toThrow();
  });

  it("round-trips host identity values that need normalization", async () => {
    document.body.innerHTML = '<button id="save" data-card="  card-7  ">Save</button>';
    const host: HostIntegration = {
      identity: (element) => ({ "data-card": element.getAttribute("data-card") ?? "" }),
    };
    const target = await inspectTarget(document.querySelector("button")!, host);
    expect(target.inspection.attributes["host:data-card"]).toBe("card-7");
    expect(resolvePersistedTarget(target, { appRoot: document, host })).toMatchObject({
      status: "resolved",
    });
    // Overlong values truncate identically on capture and restore.
    document.body.innerHTML =
      `<button id="save" data-card="${"x".repeat(600)}">Save</button>`;
    const longTarget = await inspectTarget(document.querySelector("button")!, host);
    expect(longTarget.inspection.attributes["host:data-card"]).toHaveLength(500);
    expect(resolvePersistedTarget(longTarget, { appRoot: document, host })).toMatchObject({
      status: "resolved",
    });
  });

  it("round-trips ids that need normalization", async () => {
    document.body.innerHTML = '<main><button id="  card-7  ">Save</button></main>';
    const target = await inspectTarget(document.querySelector("button")!);
    expect(target.inspection.attributes.id).toBe("card-7");
    expect(resolvePersistedTarget(
      { ...target, selector: "main > button" },
      { appRoot: document }
    )).toMatchObject({ status: "resolved" });
    // Overlong ids truncate identically on capture and restore.
    document.body.innerHTML =
      `<main><button id="${"y".repeat(600)}">Save</button></main>`;
    const longTarget = await inspectTarget(document.querySelector("button")!);
    expect(longTarget.inspection.attributes.id).toHaveLength(500);
    expect(resolvePersistedTarget(
      { ...longTarget, selector: "main > button" },
      { appRoot: document }
    )).toMatchObject({ status: "resolved" });
  });

  it("deterministically skips colliding normalized host identity keys", async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const host: HostIntegration = {
      identity: () => ({ "a b": "first", "a  b": "second" }),
    };
    const target = await inspectTarget(document.querySelector("button")!, host);
    // First normalized entry wins; the colliding entry is skipped.
    expect(target.inspection.attributes).toMatchObject({ "host:a b": "first" });
    expect(Object.keys(target.inspection.attributes)
      .filter((key) => key.startsWith("host:"))).toHaveLength(1);
    expect(resolvePersistedTarget(target, { appRoot: document, host })).toMatchObject({
      status: "resolved",
    });
  });

  it("skips host identity entries that normalize to empty", async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const target = await inspectTarget(document.querySelector("button")!, {
      identity: () => ({ "  ": "v", key: "  " }),
    });
    expect(Object.keys(target.inspection.attributes)
      .filter((key) => key.startsWith("host:"))).toHaveLength(0);
  });
});
