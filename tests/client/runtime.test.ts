/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(),
  getElementAtPoint: vi.fn(() => null),
  getElementBounds: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })),
  getElementContext: vi.fn(),
  getElementSelector: vi.fn(),
  getElementsAtPoint: vi.fn(() => []),
  isElementGrabbable: vi.fn(() => true),
}));

import { mountAgentFeedback } from "../../src/client/index.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";

afterEach(() => document.getElementById("agent-feedback-root")?.remove());

describe("client runtime", () => {
  it("marks the shadow host ignored before mounting and cleans it up", async () => {
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    const host = document.getElementById("agent-feedback-root");
    expect(host?.hasAttribute("data-react-grab-ignore")).toBe(true);
    expect(host?.shadowRoot?.querySelector('[aria-label^="Pick"]')).not.toBeNull();

    mounted.unmount();
    mounted.unmount();
    expect(document.getElementById("agent-feedback-root")).toBeNull();
  });

  it("exposes snapshot subscriptions and commands without React setters", async () => {
    const mounted = await mountAgentFeedback({ transport: new MemoryTaskTransport() });
    const listener = vi.fn();
    const unsubscribe = mounted.api.subscribe(listener);

    mounted.api.commands.capture.startPick();
    mounted.api.commands.markers.hide();
    mounted.api.commands.panels.open("help");

    expect(mounted.api.getSnapshot()).toMatchObject({
      captureMode: "pick",
      markersVisible: false,
      openPanel: "help",
    });
    expect(listener).toHaveBeenCalled();
    expect(Object.keys(mounted.api)).toEqual(["getSnapshot", "subscribe", "commands"]);
    unsubscribe();
    mounted.unmount();
  });
});
