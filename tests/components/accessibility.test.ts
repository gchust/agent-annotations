/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-grab/primitives", () => ({
  disposeBaselineStyles: vi.fn(), getElementAtPoint: vi.fn(() => null),
  getElementBounds: vi.fn(), getElementContext: vi.fn(), getElementSelector: vi.fn(),
  getElementsAtPoint: vi.fn(() => []), isElementGrabbable: vi.fn(() => true),
}));

import { mountAgentAnnotations } from "../../src/client/index.js";
import { MemoryTaskTransport } from "../../src/testing/index.js";

afterEach(() => document.getElementById("agent-annotations-root")?.remove());

describe("toolbar accessibility", () => {
  it("shares shortcut labels with buttons and Help and collapses accessibly", async () => {
    vi.useFakeTimers();
    const mounted = await mountAgentAnnotations({
      transport: new MemoryTaskTransport(),
      initialState: { collapsed: false },
    });
    const shadow = document.getElementById("agent-annotations-root")!.shadowRoot!;
    const pick = shadow.querySelector<HTMLButtonElement>('[aria-label^="Pick"]')!;
    expect(pick.getAttribute("aria-label")).toContain("Ctrl+Alt+P");
    pick.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(shadow.querySelector('[role="tooltip"]')?.textContent).toContain("Pick");

    mounted.api.commands.panels.open("agent-annotations.builtin:help");
    expect(shadow.querySelector('[aria-label="Shortcut help"]')?.textContent).toContain("Ctrl+Alt+P");
    expect(shadow.querySelector<HTMLButtonElement>('[data-action-id="agent-annotations.builtin:help"]')
      ?.getAttribute("aria-pressed")).toBe("true");
    const collapse = [...shadow.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label")?.startsWith("Collapse toolbar"))!;
    collapse.click();
    expect(shadow.querySelector(".aa-dock")?.getAttribute("data-collapsed")).toBe("true");
    expect([...shadow.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label")?.startsWith("Collapse toolbar"))?.getAttribute("aria-pressed")).toBe("true");

    mounted.unmount();
    vi.useRealTimers();
  });
});
